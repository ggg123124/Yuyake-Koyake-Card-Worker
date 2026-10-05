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
// + 锚点前移（2026-10-01 房间 SVS3C「4 天 0 摘要」死锁的修法）。

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
    const r = computeWindow({ lastEndMs: NOW - 50_000, watermark: NOW, hasRecordingSession: true });
    console.log('[window] too-soon →', JSON.stringify(r), 'span=', r.endMs - r.startMs);
    expect(r.startMs).toBe(NOW - 50_000);
    expect(r.endMs).toBe(NOW);
    expect(r.endMs - r.startMs).toBe(50_000);
    expect(r.skip).toBe('too-soon');
    expect(r.jumped).toBe(false);
    expect(r.skippedMs).toBe(0);
  });

  // 落后 400s：超过 MAX_WINDOW_MS（300s）需要截断，但未达到前移阈值 MAX_WINDOW_MS + WINDOW_MS = 420s。
  // ⚠️ 本用例原先写的是落后 500s —— 那正好落进本轮修掉的死锁区间（>420s 时锚点必须前移），
  //    它断言的「startMs 永远停在 500s 前」就是事故行为本身，故改为 400s 以保留纯粹的「截断」语义。
  it('MAX_WINDOW_MS < 落后量 ≤ 前移阈值 → 截断到 MAX_WINDOW_MS，不前移', () => {
    const r = computeWindow({ lastEndMs: NOW - 400_000, watermark: NOW, hasRecordingSession: true });
    console.log('[window] 截断 →', JSON.stringify(r), 'span=', r.endMs - r.startMs);
    expect(r.startMs).toBe(NOW - 400_000);
    expect(r.endMs).toBe(NOW - 100_000);
    expect(r.endMs - r.startMs).toBe(MAX_WINDOW_MS);
    expect(r.skip).toBeNull();
    expect(r.jumped).toBe(false);
    expect(r.skippedMs).toBe(0);
  });

  it('首次摘要（lastEndMs=null）→ start = watermark - WINDOW_MS，正好一个窗口', () => {
    const r = computeWindow({ lastEndMs: null, watermark: NOW, hasRecordingSession: true });
    console.log('[window] 首次 →', JSON.stringify(r), 'span=', r.endMs - r.startMs);
    expect(r.startMs).toBe(NOW - WINDOW_MS);
    expect(r.endMs).toBe(NOW);
    expect(r.endMs - r.startMs).toBe(WINDOW_MS);
    expect(r.skip).toBeNull();
    expect(r.jumped).toBe(false);
  });

  it('全部 done 且 span ≥ TAIL_WINDOW_MS → 收口（不 skip），把停录后的末段素材收掉', () => {
    const r = computeWindow({ lastEndMs: NOW - 20_000, watermark: NOW, hasRecordingSession: false });
    console.log('[window] 收尾收口 →', JSON.stringify(r), 'span=', r.endMs - r.startMs);
    expect(r.endMs - r.startMs).toBe(20_000);
    expect(r.skip).toBeNull();
    expect(r.jumped).toBe(false);
  });

  it('全部 done 但 span < TAIL_WINDOW_MS → 仍 skip=too-soon', () => {
    const r = computeWindow({ lastEndMs: NOW - 10_000, watermark: NOW, hasRecordingSession: false });
    console.log('[window] 收尾不足 →', JSON.stringify(r), 'span=', r.endMs - r.startMs);
    expect(r.skip).toBe('too-soon');
    expect(r.jumped).toBe(false);
  });

  it('对照：同样 span=20s，录音中 skip、全 done 收口（体现 TAIL_WINDOW 例外）', () => {
    const recording = computeWindow({ lastEndMs: NOW - 20_000, watermark: NOW, hasRecordingSession: true });
    const done = computeWindow({ lastEndMs: NOW - 20_000, watermark: NOW, hasRecordingSession: false });
    console.log('[window] 对照 recording=', JSON.stringify(recording), 'done=', JSON.stringify(done));
    expect(recording.skip).toBe('too-soon');
    expect(done.skip).toBeNull();
  });
});

// C：摘要窗口死锁（线上真实事故，房间 SVS3C 4 天 0 摘要、1103 条语音段未进任何摘要）
// 根因：endMs = min(watermark, startMs + MAX_WINDOW_MS)，startMs = lastEndMs。
// 当 lastEndMs 落后 watermark 超过 MAX_WINDOW_MS 时，窗口永远只能是 [lastEnd, lastEnd+5min) 那段陈旧切片；
// 切片里没素材 ⇒ 判 not-enough-material ⇒ 摘要不落库 ⇒ lastEndMs 推不动 ⇒ 下一轮算出同一个窗口 ⇒ 死锁。
describe('computeWindow：锚点前移（死锁修法）', () => {
  const FOUR_DAYS = 4 * 24 * 3600 * 1000;
  const JUMP_THRESHOLD = MAX_WINDOW_MS + WINDOW_MS; // 落后超过这个量才前移

  it('事故复现：锚点落后 4 天 + 陈旧切片无素材 → 前移到 watermark-5min，窗口盖住最近素材且不再 skip', () => {
    const lastEnd = NOW - FOUR_DAYS;
    // 旧行为下窗口只会是 [lastEnd, lastEnd+5min)，远在水位之前（正是那段 0 素材的死区间）
    expect(lastEnd + MAX_WINDOW_MS).toBeLessThan(NOW - WINDOW_MS);

    const r = computeWindow({ lastEndMs: lastEnd, watermark: NOW, hasRecordingSession: true });
    console.log('[window] 锚点前移 →', JSON.stringify(r), 'skippedMs=', r.skippedMs);
    expect(r.jumped).toBe(true);
    expect(r.startMs).toBe(NOW - MAX_WINDOW_MS); // 窗口右端贴着水位，必定覆盖最近到库的素材
    expect(r.endMs).toBe(NOW);
    expect(r.endMs - r.startMs).toBe(MAX_WINDOW_MS);
    expect(r.skip).toBeNull(); // 关键：不再永久 too-soon / not-enough-material
    expect(r.skippedMs).toBe(NOW - MAX_WINDOW_MS - lastEnd);
  });

  it('前移后锚点能持续推进：用上一轮的 endMs 再算一次 → 不再前移，正常按窗口滚动', () => {
    const first = computeWindow({ lastEndMs: NOW - FOUR_DAYS, watermark: NOW, hasRecordingSession: true });
    const next = computeWindow({
      lastEndMs: first.endMs,
      watermark: NOW + WINDOW_MS,
      hasRecordingSession: true,
    });
    console.log('[window] 前移后继续 →', JSON.stringify(first), JSON.stringify(next));
    expect(first.jumped).toBe(true);
    expect(next.jumped).toBe(false);
    expect(next.startMs).toBe(first.endMs);
    expect(next.endMs).toBe(NOW + WINDOW_MS);
    expect(next.skip).toBeNull();
  });

  it('边界：落后恰好 MAX_WINDOW_MS + WINDOW_MS（420s）→ 不前移，保持原截断语义', () => {
    const r = computeWindow({ lastEndMs: NOW - JUMP_THRESHOLD, watermark: NOW, hasRecordingSession: true });
    console.log('[window] 前移边界（不前移）→', JSON.stringify(r));
    expect(r.jumped).toBe(false);
    expect(r.skippedMs).toBe(0);
    expect(r.startMs).toBe(NOW - JUMP_THRESHOLD);
    expect(r.endMs).toBe(NOW - WINDOW_MS); // startMs + MAX_WINDOW_MS
    expect(r.skip).toBeNull();
  });

  it('边界 +1ms：落后 420_001ms → 前移，skippedMs 恰好是被放弃的那 120_001ms', () => {
    const lag = JUMP_THRESHOLD + 1;
    const r = computeWindow({ lastEndMs: NOW - lag, watermark: NOW, hasRecordingSession: true });
    console.log('[window] 前移边界（前移）→', JSON.stringify(r));
    expect(r.jumped).toBe(true);
    expect(r.startMs).toBe(NOW - MAX_WINDOW_MS);
    expect(r.skippedMs).toBe(NOW - MAX_WINDOW_MS - (NOW - lag));
    expect(r.skip).toBeNull();
  });

  it('全部 done（无 recording 会话）时同样前移，避免停录后残留的死锁锚点', () => {
    const r = computeWindow({ lastEndMs: NOW - FOUR_DAYS, watermark: NOW, hasRecordingSession: false });
    console.log('[window] done 也前移 →', JSON.stringify(r));
    expect(r.jumped).toBe(true);
    expect(r.startMs).toBe(NOW - MAX_WINDOW_MS);
    expect(r.endMs).toBe(NOW);
    expect(r.skip).toBeNull();
  });

  it('前移后的 span 恒为 MAX_WINDOW_MS，不会因 minSpan 判成 too-soon（死锁不可能复现）', () => {
    for (const lag of [JUMP_THRESHOLD + 1, 600_000, 3600_000, FOUR_DAYS, 30 * FOUR_DAYS]) {
      for (const rec of [true, false]) {
        const r = computeWindow({ lastEndMs: NOW - lag, watermark: NOW, hasRecordingSession: rec });
        expect(r.jumped).toBe(true);
        expect(r.endMs - r.startMs).toBe(MAX_WINDOW_MS);
        expect(r.skip).toBeNull();
      }
    }
  });
});
