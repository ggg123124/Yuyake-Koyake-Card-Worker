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
// 覆盖 pickWatermark 的四类场景 + computeWindow 的窗口边界（too-soon / 截断 / 收尾）。

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
  });

  it('span > MAX_WINDOW_MS → 截断到 MAX_WINDOW_MS（事故里出现过 75 分钟超长窗口）', () => {
    const r = computeWindow({ lastEndMs: NOW - 500_000, watermark: NOW, hasRecordingSession: true });
    console.log('[window] 截断 →', JSON.stringify(r), 'span=', r.endMs - r.startMs);
    expect(r.startMs).toBe(NOW - 500_000);
    expect(r.endMs).toBe(NOW - 200_000);
    expect(r.endMs - r.startMs).toBe(MAX_WINDOW_MS);
    expect(r.skip).toBeNull();
  });

  it('首次摘要（lastEndMs=null）→ start = watermark - WINDOW_MS，正好一个窗口', () => {
    const r = computeWindow({ lastEndMs: null, watermark: NOW, hasRecordingSession: true });
    console.log('[window] 首次 →', JSON.stringify(r), 'span=', r.endMs - r.startMs);
    expect(r.startMs).toBe(NOW - WINDOW_MS);
    expect(r.endMs).toBe(NOW);
    expect(r.endMs - r.startMs).toBe(WINDOW_MS);
    expect(r.skip).toBeNull();
  });

  it('全部 done 且 span ≥ TAIL_WINDOW_MS → 收口（不 skip），把停录后的末段素材收掉', () => {
    const r = computeWindow({ lastEndMs: NOW - 20_000, watermark: NOW, hasRecordingSession: false });
    console.log('[window] 收尾收口 →', JSON.stringify(r), 'span=', r.endMs - r.startMs);
    expect(r.endMs - r.startMs).toBe(20_000);
    expect(r.skip).toBeNull();
  });

  it('全部 done 但 span < TAIL_WINDOW_MS → 仍 skip=too-soon', () => {
    const r = computeWindow({ lastEndMs: NOW - 10_000, watermark: NOW, hasRecordingSession: false });
    console.log('[window] 收尾不足 →', JSON.stringify(r), 'span=', r.endMs - r.startMs);
    expect(r.skip).toBe('too-soon');
  });

  it('对照：同样 span=20s，录音中 skip、全 done 收口（体现 TAIL_WINDOW 例外）', () => {
    const recording = computeWindow({ lastEndMs: NOW - 20_000, watermark: NOW, hasRecordingSession: true });
    const done = computeWindow({ lastEndMs: NOW - 20_000, watermark: NOW, hasRecordingSession: false });
    console.log('[window] 对照 recording=', JSON.stringify(recording), 'done=', JSON.stringify(done));
    expect(recording.skip).toBe('too-soon');
    expect(done.skip).toBeNull();
  });
});
