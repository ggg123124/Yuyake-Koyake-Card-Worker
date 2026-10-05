import { describe, it, expect } from 'vitest';
import {
  pickWatermark,
  computeWindow,
  WINDOW_MS,
  MAX_WINDOW_MS,
  TAIL_WINDOW_MS,
  ACTIVE_SESSION_MS,
  WATERMARK_PIN_MAX_LAG_MS,
  type SessionWatermarkRow,
} from '../src/api/summarize';

// 纯函数单测：不连网、不碰 DB。
// 覆盖 pickWatermark 的五类场景 + computeWindow 的窗口边界（too-soon / 截断 / 收尾）
// + 「起点落到下一条素材」（2026-10-05 把上一轮的「锚点前移跳过积压」换成「沿素材逐窗追补」）。

// 把 epoch ms 格式化成 SQLite datetime('now') 文本（UTC，'YYYY-MM-DD HH:MM:SS'）
function utcSql(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

const NOW = Date.parse('2026-10-01T22:00:00Z'); // 固定「墙钟」，避免依赖真实时间

describe('pickWatermark：素材水位', () => {
  it('① 无素材 → watermark=null, pinned=false', () => {
    const r = pickWatermark(null, [], NOW);
    console.log('[watermark] ① 无素材 →', JSON.stringify(r));
    expect(r).toEqual({ watermark: null, pinned: false, lagMs: 0 });
  });

  it('② 无活跃会话（全 done + recording 收数超时）→ watermark=base, 不 pin', () => {
    const base = NOW - 120_000;
    const sessions: SessionWatermarkRow[] = [
      { status: 'done', maxAbsEndMs: base, lastRecvAt: utcSql(NOW - 500_000) },
      // recording 但最近一次到库在 200s 前（> ACTIVE_SESSION_MS=180s）→ 不算活跃
      { status: 'recording', maxAbsEndMs: NOW - 200_000, lastRecvAt: utcSql(NOW - 200_000) },
    ];
    const r = pickWatermark(base, sessions, NOW);
    console.log('[watermark] ② 无活跃会话 →', JSON.stringify(r), 'base=', base);
    expect(r.watermark).toBe(base);
    expect(r.pinned).toBe(false);
    expect(r.lagMs).toBe(120_000);
  });

  it('③ 活跃会话把水位往回 pin（pinned < base）→ watermark=min(base,pinned)=pinned', () => {
    const base = NOW - 60_000; // 房间整体水位（含一个已 done 的会话）
    const activeEnd = NOW - 90_000; // 仍在录的会话水位更靠后（更旧）→ 把窗口右端拉回，避免它的晚到素材被跳过
    const sessions: SessionWatermarkRow[] = [
      { status: 'done', maxAbsEndMs: base, lastRecvAt: utcSql(NOW - 60_000) },
      { status: 'recording', maxAbsEndMs: activeEnd, lastRecvAt: utcSql(NOW - 5_000) },
    ];
    const r = pickWatermark(base, sessions, NOW);
    console.log('[watermark] ③ 活跃 pin →', JSON.stringify(r), 'base=', base, 'activeEnd=', activeEnd);
    expect(r.watermark).toBe(activeEnd);
    expect(r.pinned).toBe(true);
    expect(r.lagMs).toBe(90_000);
  });

  it('④ 活跃会话水位落后墙钟 > 10min → 回退 base, pinned=false（lagMs 仍报 pinned 的落后量）', () => {
    const base = NOW - 60_000;
    const staleActive = NOW - 700_000; // 落后 700s > WATERMARK_PIN_MAX_LAG_MS(600s)
    const sessions: SessionWatermarkRow[] = [
      // 最近仍在到库（30s 前）→ 判为活跃，但其 abs 水位异常陈旧
      { status: 'recording', maxAbsEndMs: staleActive, lastRecvAt: utcSql(NOW - 30_000) },
    ];
    const r = pickWatermark(base, sessions, NOW);
    console.log('[watermark] ④ pin 超时回退 →', JSON.stringify(r), 'base=', base, 'staleActive=', staleActive);
    expect(r.watermark).toBe(base);
    expect(r.pinned).toBe(false);
    expect(r.lagMs).toBe(700_000);
  });

  // 本轮降读量改动：会话水位 SQL 加了 WHERE s.status='recording'，只返回录音中的会话。
  // 因此「全部会话已结束」时传进来的是空数组，必须仍等价于「无活跃会话」（不 pin，用 base 水位）。
  it('⑤ 只传 recording 行（全部已结束时为空数组）→ 等价于「无活跃会话」，行为与改动前一致', () => {
    const base = NOW - 60_000;
    const r = pickWatermark(base, [], NOW);
    console.log('[watermark] ⑤ 空会话数组 →', JSON.stringify(r), 'base=', base);
    expect(r).toEqual({ watermark: base, pinned: false, lagMs: 60_000 });
  });

  it('常量自检（防止误改阈值）', () => {
    expect(ACTIVE_SESSION_MS).toBe(180_000);
    expect(WATERMARK_PIN_MAX_LAG_MS).toBe(600_000);
    expect(MAX_WINDOW_MS).toBe(300_000);
    expect(TAIL_WINDOW_MS).toBe(15_000);
    expect(WINDOW_MS).toBe(120_000);
  });
});

describe('computeWindow：窗口边界', () => {
  it('span < WINDOW_MS（仍在录音）→ skip=too-soon', () => {
    const r = computeWindow({
      lastEndMs: NOW - 50_000,
      watermark: NOW,
      hasRecordingSession: true,
      nextMaterialStartMs: null,
    });
    console.log('[window] too-soon →', JSON.stringify(r), 'span=', r.endMs - r.startMs);
    expect(r.startMs).toBe(NOW - 50_000);
    expect(r.endMs).toBe(NOW);
    expect(r.endMs - r.startMs).toBe(50_000);
    expect(r.skip).toBe('too-soon');
    expect(r.gapSkippedMs).toBe(0);
  });

  // 落后 400s：超过 MAX_WINDOW_MS（300s）需要截断。起点仍在锚点上（下一条素材不晚于锚点），
  // 所以这一轮覆盖的是锚点之后那段连续素材，不会跨过任何东西。
  it('落后量 > MAX_WINDOW_MS → 截断到 MAX_WINDOW_MS，起点仍是锚点', () => {
    const r = computeWindow({
      lastEndMs: NOW - 400_000,
      watermark: NOW,
      hasRecordingSession: true,
      nextMaterialStartMs: null,
    });
    console.log('[window] 截断 →', JSON.stringify(r), 'span=', r.endMs - r.startMs);
    expect(r.startMs).toBe(NOW - 400_000);
    expect(r.endMs).toBe(NOW - 100_000);
    expect(r.endMs - r.startMs).toBe(MAX_WINDOW_MS);
    expect(r.skip).toBeNull();
    expect(r.gapSkippedMs).toBe(0);
  });

  it('首次摘要（lastEndMs=null）→ start = watermark - WINDOW_MS，正好一个窗口', () => {
    const r = computeWindow({
      lastEndMs: null,
      watermark: NOW,
      hasRecordingSession: true,
      nextMaterialStartMs: null,
    });
    console.log('[window] 首次 →', JSON.stringify(r), 'span=', r.endMs - r.startMs);
    expect(r.startMs).toBe(NOW - WINDOW_MS);
    expect(r.endMs).toBe(NOW);
    expect(r.endMs - r.startMs).toBe(WINDOW_MS);
    expect(r.skip).toBeNull();
    expect(r.gapSkippedMs).toBe(0);
  });

  it('全部 done 且 span ≥ TAIL_WINDOW_MS → 收口（不 skip），把停录后的末段素材收掉', () => {
    const r = computeWindow({
      lastEndMs: NOW - 20_000,
      watermark: NOW,
      hasRecordingSession: false,
      nextMaterialStartMs: null,
    });
    console.log('[window] 收尾收口 →', JSON.stringify(r), 'span=', r.endMs - r.startMs);
    expect(r.endMs - r.startMs).toBe(20_000);
    expect(r.skip).toBeNull();
    expect(r.gapSkippedMs).toBe(0);
  });

  it('全部 done 但 span < TAIL_WINDOW_MS → 仍 skip=too-soon', () => {
    const r = computeWindow({
      lastEndMs: NOW - 10_000,
      watermark: NOW,
      hasRecordingSession: false,
      nextMaterialStartMs: null,
    });
    console.log('[window] 收尾不足 →', JSON.stringify(r), 'span=', r.endMs - r.startMs);
    expect(r.skip).toBe('too-soon');
    expect(r.gapSkippedMs).toBe(0);
  });

  it('对照：同样 span=20s，录音中 skip、全 done 收口（体现 TAIL_WINDOW 例外）', () => {
    const recording = computeWindow({
      lastEndMs: NOW - 20_000,
      watermark: NOW,
      hasRecordingSession: true,
      nextMaterialStartMs: null,
    });
    const done = computeWindow({
      lastEndMs: NOW - 20_000,
      watermark: NOW,
      hasRecordingSession: false,
      nextMaterialStartMs: null,
    });
    console.log('[window] 对照 recording=', JSON.stringify(recording), 'done=', JSON.stringify(done));
    expect(recording.skip).toBe('too-soon');
    expect(done.skip).toBeNull();
  });

  // nextMaterialStartMs 是本轮新增入参：为 null 时必须与旧版完全一致（起点仍是锚点），
  // 否则「没有更晚素材」的常见路径会被这次改动带偏。
  it('nextMaterialStartMs=null → 起点仍是 lastEndMs、gapSkippedMs=0（与旧版行为一致）', () => {
    for (const lag of [0, 50_000, 400_000, 4 * 24 * 3600 * 1000]) {
      for (const rec of [true, false]) {
        const r = computeWindow({
          lastEndMs: NOW - lag,
          watermark: NOW,
          hasRecordingSession: rec,
          nextMaterialStartMs: null,
        });
        expect(r.startMs).toBe(NOW - lag);
        expect(r.gapSkippedMs).toBe(0);
        expect(r.endMs).toBe(Math.min(NOW, NOW - lag + MAX_WINDOW_MS));
      }
    }
  });
});

// C：摘要窗口死锁（线上真实事故，房间 SVS3C 4 天 0 摘要、1103 条语音段未进任何摘要）
// 根因：endMs = min(watermark, startMs + MAX_WINDOW_MS)，startMs = lastEndMs。
// 当 lastEndMs 落后 watermark 超过 MAX_WINDOW_MS 时，窗口永远只能是 [lastEnd, lastEnd+5min) 那段陈旧切片；
// 切片里没素材 ⇒ 判 not-enough-material ⇒ 摘要不落库 ⇒ lastEndMs 推不动 ⇒ 下一轮算出同一个窗口 ⇒ 死锁。
// 本轮修法：起点「落到锚点之后的第一条素材」上（nextMaterialStartMs），空档被跨过但素材一条不丢，
// 再由 maybeSummarize({catchUp:true}) 逐窗把积压补完。上一轮的「锚点前移」会把积压素材整段丢掉，已删除。
describe('computeWindow：起点落到下一条素材（死锁修法）', () => {
  const FOUR_DAYS = 4 * 24 * 3600 * 1000;

  it('事故场景：锚点落后 4 天 + 下一条素材在水位前 30s → 起点落到素材上，跨过空档但不跳素材', () => {
    const lastEnd = NOW - FOUR_DAYS;
    const nextMat = NOW - 30_000;
    // 旧行为下窗口只会是 [lastEnd, lastEnd+5min)，远在水位之前（正是那段 0 素材的死区间）
    expect(lastEnd + MAX_WINDOW_MS).toBeLessThan(NOW - WINDOW_MS);

    const r = computeWindow({
      lastEndMs: lastEnd,
      watermark: NOW,
      hasRecordingSession: false, // 4 天前的团早停了：全 done ⇒ minSpan = TAIL_WINDOW_MS
      nextMaterialStartMs: nextMat,
    });
    console.log('[window] 落到素材 →', JSON.stringify(r), 'gapSkippedMs=', r.gapSkippedMs);
    expect(r.startMs).toBe(nextMat); // 起点就是那条素材本身
    expect(r.endMs).toBe(NOW); // = watermark
    expect(r.skip).toBeNull(); // 关键：不再永久 too-soon / not-enough-material
    expect(r.gapSkippedMs).toBe(nextMat - lastEnd);
    // 素材没有被跳过：它落在窗口 [startMs, endMs) 内，一定会被这一轮的素材查询取到
    expect(nextMat).toBeGreaterThanOrEqual(r.startMs);
    expect(nextMat).toBeLessThan(r.endMs);
  });

  it('同样场景但仍有会话在录音 → span=30s < WINDOW_MS，仍按原语义 skip=too-soon（minSpan 未变）', () => {
    const lastEnd = NOW - FOUR_DAYS;
    const nextMat = NOW - 30_000;
    const r = computeWindow({
      lastEndMs: lastEnd,
      watermark: NOW,
      hasRecordingSession: true,
      nextMaterialStartMs: nextMat,
    });
    console.log('[window] 落到素材但录音中 →', JSON.stringify(r));
    expect(r.startMs).toBe(nextMat);
    expect(r.skip).toBe('too-soon');
    expect(r.gapSkippedMs).toBe(nextMat - lastEnd);
  });

  it('下一条素材不晚于锚点（与锚点尾部重叠）→ 起点不动、gapSkippedMs=0', () => {
    const r = computeWindow({
      lastEndMs: NOW - 400_000,
      watermark: NOW,
      hasRecordingSession: true,
      nextMaterialStartMs: NOW - 400_500, // 该段 abs_end_ms 越过锚点，但起点在锚点之前
    });
    console.log('[window] 重叠素材 →', JSON.stringify(r));
    expect(r.startMs).toBe(NOW - 400_000);
    expect(r.gapSkippedMs).toBe(0);
    expect(r.endMs).toBe(NOW - 100_000); // startMs + MAX_WINDOW_MS
    expect(r.skip).toBeNull();
  });

  it('下一条素材恰好贴在水位上 → span=0，too-soon（不是负长度窗口）', () => {
    const r = computeWindow({
      lastEndMs: NOW - FOUR_DAYS,
      watermark: NOW,
      hasRecordingSession: false,
      nextMaterialStartMs: NOW,
    });
    console.log('[window] 素材贴水位 →', JSON.stringify(r));
    expect(r.startMs).toBe(NOW);
    expect(r.endMs).toBe(NOW);
    expect(r.endMs - r.startMs).toBe(0);
    expect(r.skip).toBe('too-soon');
  });

  it('边界：nextMaterialStartMs 越过水位（不应发生）→ clamp 成零长窗口，绝不产出 endMs < startMs', () => {
    const r = computeWindow({
      lastEndMs: NOW - FOUR_DAYS,
      watermark: NOW,
      hasRecordingSession: false,
      nextMaterialStartMs: NOW + 60_000,
    });
    console.log('[window] 素材越过水位 →', JSON.stringify(r));
    expect(r.startMs).toBe(NOW + 60_000);
    expect(r.endMs).toBe(r.startMs);
    expect(r.endMs - r.startMs).toBeGreaterThanOrEqual(0);
    expect(r.skip).toBe('too-soon');
  });

  it('边界：锚点本身已越过水位 → 零长窗口 too-soon，gapSkippedMs=0', () => {
    const r = computeWindow({
      lastEndMs: NOW + 1_000,
      watermark: NOW,
      hasRecordingSession: true,
      nextMaterialStartMs: null,
    });
    console.log('[window] 锚点越过水位 →', JSON.stringify(r));
    expect(r.startMs).toBe(NOW + 1_000);
    expect(r.endMs).toBe(r.startMs);
    expect(r.skip).toBe('too-soon');
    expect(r.gapSkippedMs).toBe(0);
  });

  it('落到素材后锚点能持续推进：用上一轮 endMs + 下一批素材再算 → 逐窗滚动', () => {
    const first = computeWindow({
      lastEndMs: NOW - FOUR_DAYS,
      watermark: NOW,
      hasRecordingSession: false,
      nextMaterialStartMs: NOW - 600_000,
    });
    const next = computeWindow({
      lastEndMs: first.endMs,
      watermark: NOW,
      hasRecordingSession: false,
      nextMaterialStartMs: first.endMs, // 下一批素材正好接在上一窗口尾部
    });
    console.log('[window] 逐窗滚动 →', JSON.stringify(first), JSON.stringify(next));
    expect(first.startMs).toBe(NOW - 600_000);
    expect(first.endMs).toBe(NOW - 600_000 + MAX_WINDOW_MS);
    expect(next.startMs).toBe(first.endMs);
    expect(next.gapSkippedMs).toBe(0);
    expect(next.endMs).toBe(first.endMs + MAX_WINDOW_MS);
    expect(next.skip).toBeNull();
  });

  // ✅ 2026-10-06 已修：会话全部结束后，若锚点之后只剩「隔着一段空档的末段素材」，
  // 旧版无条件 gap-skip 会把起点推到那条素材上，窗口 span 只剩素材本身那几秒 < TAIL_WINDOW_MS ⇒ 恒 too-soon ⇒
  // 尾段永远补不上、锚点也不再前进（本地 E2E 房间 BKFCAP 实测：22 段补了 21 段，最后 1 段卡在 remainingMs=63000）。
  // 修法是把 gap-skip 变成条件性的：只有「不跳窗口就必被 MAX_WINDOW_MS 截断、够不到尾部素材」时才跳。
  // 锚点距水位 63s（< MAX_WINDOW_MS）时保持旧行为：起点 = lastEndMs，窗口 [锚点, 水位) 盖得住那条尾段素材。
  it('收尾场景：锚点距水位 63s + 空档 60s + 末段素材 3s（全 done）→ 不再 too-soon，起点仍是锚点', () => {
    const anchor = NOW - 63_000; // 上一条摘要的 end_ms（E2E 实测值）
    const tail = NOW - 3_000; // 尾段长 3s，abs_end_ms 恰好就是水位
    const r = computeWindow({
      lastEndMs: anchor,
      watermark: NOW,
      hasRecordingSession: false,
      nextMaterialStartMs: tail,
    });
    console.log('[window] 收尾场景（修后）→', JSON.stringify(r));
    expect(r.startMs).toBe(anchor); // = lastEndMs：不再被推到素材上
    expect(r.gapSkippedMs).toBe(0);
    expect(r.endMs).toBe(NOW); // = watermark（span 63s < MAX_WINDOW_MS，不截断）
    expect(r.endMs - r.startMs).toBe(63_000);
    expect(r.skip).toBeNull(); // 关键：不再恒 too-soon
    // 尾段素材落在窗口 [startMs, endMs) 内 ⇒ 这一轮的素材查询一定取得到它
    expect(tail).toBeGreaterThanOrEqual(r.startMs);
    expect(tail).toBeLessThan(r.endMs);
  });
});

// 本轮（2026-10-06）把 gap-skip 改成条件性：只有 watermark - startMs > MAX_WINDOW_MS（不跳就必被截断）才跳。
// 三条必须钉住的行为：① 收尾残留场景不再 too-soon；② 4 天积压仍必须跳（不能因为这次改动复活死锁）；
// ③ 边界用 > 而不是 >=（恰好等于 MAX_WINDOW_MS 时不跳，因为此时窗口刚好够、不会被截断）。
describe('computeWindow：条件性 gap-skip（只在「不跳就会被截断」时才跳）', () => {
  const FOUR_DAYS = 4 * 24 * 3600 * 1000;

  it('① 残留场景（锚点距水位 63s、空档 60s、末段素材 3s、全 done）→ 不跳、不 too-soon', () => {
    const anchor = NOW - 63_000;
    const r = computeWindow({
      lastEndMs: anchor,
      watermark: NOW,
      hasRecordingSession: false,
      nextMaterialStartMs: NOW - 3_000, // 空档 60s：锚点之后第一条素材贴着水位
    });
    console.log('[gap-skip] ① 残留场景 →', JSON.stringify(r));
    expect(NOW - anchor).toBeLessThanOrEqual(MAX_WINDOW_MS); // 前提：不跳也不会被截断
    expect(r.startMs).toBe(anchor);
    expect(r.gapSkippedMs).toBe(0);
    expect(r.skip).toBeNull();
  });

  it('② 4 天积压（watermark - 锚点 远大于 MAX_WINDOW_MS）→ 仍 gap-skip，起点落到素材上', () => {
    const anchor = NOW - FOUR_DAYS;
    const nextMat = NOW - 90_000;
    const r = computeWindow({
      lastEndMs: anchor,
      watermark: NOW,
      hasRecordingSession: false,
      nextMaterialStartMs: nextMat,
    });
    console.log('[gap-skip] ② 4 天积压 →', JSON.stringify(r));
    expect(NOW - anchor).toBeGreaterThan(MAX_WINDOW_MS); // 前提：不跳必被截断
    expect(r.gapSkippedMs).toBeGreaterThan(0);
    expect(r.gapSkippedMs).toBe(nextMat - anchor);
    expect(r.startMs).toBe(nextMat); // 起点落到素材上，死锁不会复活
    expect(r.skip).toBeNull();
  });

  it('③ 边界：watermark - startMs 恰好 = MAX_WINDOW_MS → 不跳（用 > 而不是 >=）', () => {
    const anchor = NOW - MAX_WINDOW_MS;
    const nextMat = NOW - 3_000;
    const r = computeWindow({
      lastEndMs: anchor,
      watermark: NOW,
      hasRecordingSession: false,
      nextMaterialStartMs: nextMat,
    });
    console.log('[gap-skip] ③ 恰好等于 MAX_WINDOW_MS →', JSON.stringify(r));
    expect(NOW - anchor).toBe(MAX_WINDOW_MS);
    expect(r.startMs).toBe(anchor);
    expect(r.gapSkippedMs).toBe(0);
    expect(r.endMs).toBe(NOW); // 窗口刚好够，不会被截断
    expect(r.skip).toBeNull();
    expect(nextMat).toBeGreaterThanOrEqual(r.startMs);
    expect(nextMat).toBeLessThan(r.endMs); // 尾段素材仍被这一轮盖住
  });

  // ⚠️ 如实记录的残留边界（本轮按简报给定规则实现，未擅自扩大条件）：
  // 锚点比水位落后「刚好超过 MAX_WINDOW_MS」、而锚点之后只剩一条贴水位的短素材时，
  // 条件 watermark - startMs > MAX_WINDOW_MS 成立 ⇒ 仍会 gap-skip ⇒ span 只剩素材那几秒 < TAIL_WINDOW_MS ⇒ too-soon。
  // 值得注意：此时「不跳」其实也不会丢素材 —— 截断后的窗口 [锚点, 锚点+MAX_WINDOW_MS) 已经盖住了它。
  // 更严格的条件是 nextMaterialStartMs > startMs + MAX_WINDOW_MS（素材落在截断窗口之外才跳），
  // 但那超出本轮简报给定的规则，故未改，只把实际行为钉在这里并写进报告。
  it('③ 对照：再晚 1ms（> MAX_WINDOW_MS）就会跳 ⇒ 孤立短尾段仍 too-soon（残留边界）', () => {
    const anchor = NOW - MAX_WINDOW_MS - 1;
    const nextMat = NOW - 3_000;
    const r = computeWindow({
      lastEndMs: anchor,
      watermark: NOW,
      hasRecordingSession: false,
      nextMaterialStartMs: nextMat,
    });
    console.log('[gap-skip] ③ 对照 MAX_WINDOW_MS+1ms →', JSON.stringify(r));
    expect(r.startMs).toBe(nextMat); // 证明边界确实是 >（等于时不跳、多 1ms 就跳）
    expect(r.gapSkippedMs).toBe(nextMat - anchor);
    expect(r.endMs).toBe(NOW);
    expect(r.endMs - r.startMs).toBe(3_000);
    expect(r.skip).toBe('too-soon');
  });

  it('锚点在 MAX_WINDOW_MS 之内但下一条素材不晚于锚点 → 本来就不该跳（与旧版一致）', () => {
    const anchor = NOW - 63_000;
    const r = computeWindow({
      lastEndMs: anchor,
      watermark: NOW,
      hasRecordingSession: false,
      nextMaterialStartMs: anchor - 500, // 与锚点尾部重叠的那条段
    });
    console.log('[gap-skip] 重叠素材 + 锚点很近 →', JSON.stringify(r));
    expect(r.startMs).toBe(anchor);
    expect(r.gapSkippedMs).toBe(0);
    expect(r.skip).toBeNull();
  });
});

// 模拟调用方那条查询：SELECT MIN(abs_start_ms) WHERE abs_end_ms > 锚点（段长 SEG_LEN_MS）
const SEG_LEN_MS = 3_000;
function nextMaterialOf(starts: number[], anchor: number): number | null {
  return starts.find((t) => t + SEG_LEN_MS > anchor) ?? null;
}

describe('computeWindow：积压逐窗追补（死锁不可能复现）', () => {
  const FOUR_DAYS = 4 * 24 * 3600 * 1000;

  it('密集积压 4 天：每轮窗口严格前进直到覆盖水位，且 1152 条素材一条不落', () => {
    const STEP = 60_000;
    const starts: number[] = [];
    for (let t = NOW - FOUR_DAYS; t <= NOW - 30_000; t += STEP) starts.push(t);

    let anchor = NOW - FOUR_DAYS - 300_000; // 上一条摘要停在这里（比第一条素材还早 5 分钟）
    const covered = starts.map(() => false);
    let rounds = 0; // 只数「真的推进了的窗口」
    while (rounds < 5_000) {
      const nm = nextMaterialOf(starts, anchor);
      if (nm === null) break;
      const w = computeWindow({
        lastEndMs: anchor,
        watermark: NOW,
        hasRecordingSession: false,
        nextMaterialStartMs: nm,
      });
      if (w.skip) break;
      // 死锁的两个必要条件都被堵死：窗口非空、右端严格越过锚点
      expect(w.endMs).toBeGreaterThan(w.startMs);
      expect(w.endMs).toBeGreaterThan(anchor);
      expect(w.endMs - w.startMs).toBeLessThanOrEqual(MAX_WINDOW_MS);
      starts.forEach((t, i) => {
        if (t >= w.startMs && t < w.endMs) covered[i] = true;
      });
      rounds++;
      anchor = w.endMs;
      if (anchor >= NOW) break;
    }
    console.log('[window] 密集积压 rounds=', rounds, 'anchor=', anchor, 'NOW=', NOW);
    expect(anchor).toBeGreaterThanOrEqual(NOW);
    expect(covered.every(Boolean)).toBe(true);
    // 第 1 轮跨过起点前那 5 分钟空档并吃满一个窗口，之后每轮都吃满 MAX_WINDOW_MS：
    // 1 + (FOUR_DAYS - MAX_WINDOW_MS) / MAX_WINDOW_MS = 1152 轮（没退化成「一条素材一轮」）
    expect(rounds).toBe(1 + (FOUR_DAYS - MAX_WINDOW_MS) / MAX_WINDOW_MS);
  });

  it('稀疏积压（素材成团、团之间约 1 天空档）→ 空档被跨过，每团素材仍被覆盖', () => {
    const bursts = [NOW - 3 * 86_400_000, NOW - 2 * 86_400_000, NOW - 90_000];
    const starts: number[] = [];
    for (const b of bursts) for (let k = 0; k < 4; k++) starts.push(b + k * 8_000);
    starts.sort((a, b) => a - b);

    let anchor = NOW - FOUR_DAYS;
    const covered = starts.map(() => false);
    const gaps: number[] = [];
    let rounds = 0; // 只数「真的推进了的窗口」
    while (rounds < 100) {
      const nm = nextMaterialOf(starts, anchor);
      if (nm === null) break;
      const w = computeWindow({
        lastEndMs: anchor,
        watermark: NOW,
        hasRecordingSession: false,
        nextMaterialStartMs: nm,
      });
      if (w.skip) break;
      gaps.push(w.gapSkippedMs);
      starts.forEach((t, i) => {
        if (t >= w.startMs && t < w.endMs) covered[i] = true;
      });
      rounds++;
      anchor = w.endMs;
    }
    console.log(
      '[window] 稀疏积压 rounds=',
      rounds,
      'gaps(s)=',
      gaps.map((g) => Math.round(g / 1000)),
      'anchor=',
      anchor
    );
    expect(rounds).toBe(3); // 三团素材 ⇒ 三个窗口，团间空档不占窗口
    expect(covered.every(Boolean)).toBe(true);
    expect(gaps[0]).toBe(86_400_000); // 第一轮跨过整整一天的空档（空档内无素材，跨过 ≠ 丢素材）
    expect(gaps[1]).toBe(86_400_000 - MAX_WINDOW_MS);
    expect(anchor).toBe(NOW); // 最后一团贴着水位，窗口右端收到水位上
  });
});
