import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

// 回归测试：证明 transcript.html 的时间基准既不随时间被压缩、也对「音频线程丢回调」免疫。
//
// 做法（蓝本：.wrangler/diag/vad-drift-probe.js）：把本页真实 <script> 抽出来，用 node:vm + DOM 桩跑起来，
// 喂合成音频（语音 + 长静音），比较「客户端记的片段起点」与「真实经过时间」。
// 全程不连网、不读生产库：fetch 永挂起，上传队列只积不排，便于观察 startMs。
//
// ★ 本轮关键：按浏览器真实行为喂帧——createScriptProcessor(4096,1,1) 每个回调给 4096 样本，
//   而一帧是 320 样本，4096 % 320 = 256。旧 processAudio 每回调只处理 floor(4096/320)*320 = 3840 样本，
//   剩下 256 样本（16ms）从不进 VAD/不计数/不上传 ⇒ 时间线被压到 3840/4096 = 0.938。
//   旧测试每次只喂 320 样本，正好整除，所以看不到这个 bug；本轮改成喂 4096 才能暴露它。
//
// 修复前负控实测（旧 consumedSamples 基准 + 无残帧缓冲 + 无音频时钟，用本文件的 4096 喂帧）：
//   A. 说 4s/停 8s   → 压缩比 0.938（残帧丢弃叠加旧基准），末句滞后数十秒
//   B. 说 2s/停 58s  → 同上
//   C. 说 26s/停 40s → 同上
//   · 时钟抖动免疫用例：丢一个回调（时钟多走 2s）时旧代码时间线停滞，两实例末句 startMs 差 ≈ 0（应 ≈ 2000ms）
//   · 句尾裁切用例：旧代码 silenceRun 先被重置为 0，裁切判断永假，末片把 700ms 尾静音全带上（≈3020ms）
// 即下面所有断言在旧代码下必然失败，在修复后通过。

const HERE = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = resolve(HERE, '../src/public/transcript.html');

const RATE = 16000;
const FRAME_MS = 20;
const BROWSER_BUF = 4096; // = ScriptProcessor 缓冲大小，与页面 createScriptProcessor(4096,1,1) 一致

interface Chunk { startMs: number; durMs: number; reason: string; pcmLen: number }
interface State {
  capturedSamples: number;
  sessionOriginSamples: number;
  ctxTime: number | null;
  ctxOriginSec: number;
  pendingLen: number;
  chunks: Chunk[];
  sampleRate: number;
  vad: { silenceMs: number; minSpeechMs: number; maxChunkMs: number; preRollMs: number; tailSilenceMs: number; gain: number; floorAbs: number };
}
interface Probe {
  processAudio(buf: Float32Array, rate: number): void;
  setSession(): void;
  advanceClock(sec: number): void;
  queueLen(): number;
  state(): State;
}

function loadPage(): Probe {
  const html = readFileSync(HTML_PATH, 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('未找到 <script> 块');

  const mkEl = (): any => ({
    textContent: '',
    innerHTML: '',
    disabled: false,
    scrollTop: 0,
    scrollHeight: 0,
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() { return false; } },
    appendChild() {},
    querySelector() { return mkEl(); },
  });

  const sandbox: any = {
    console,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    URLSearchParams: class { get(k: string) { return k === 'room' ? 'TEST' : null; } },
    location: { search: '?room=TEST', protocol: 'http:', host: 'local' },
    localStorage: { getItem: () => 'tok', setItem() {}, removeItem() {} },
    navigator: { mediaDevices: {} },
    document: { getElementById: () => mkEl(), createElement: () => mkEl(), addEventListener() {} },
    window: { addEventListener() {} },
    WebSocket: class { readyState = 3; close() {} },
    fetch: () => new Promise(() => {}), // 永挂起：上传队列只积不排
    Blob: class { constructor(_p?: any, _o?: any) {} },
    Float32Array,
    ArrayBuffer,
    DataView,
  };
  sandbox.globalThis = sandbox;

  // 追加探针：与被测脚本同处一个词法作用域，可直接读/写它的 let/const/function。
  // 对旧代码（没有 ctxOriginSec/pendingSamples 等绑定）用 try/catch 兜住，保证负控运行时不崩。
  const code =
    m[1] +
    `
globalThis.__probe = {
  processAudio,
  // 模拟 start() 建会话成功：提供可控假音频时钟（AudioContext），并把各基准对齐到锚点 currentTime=0。
  setSession() {
    sessionId = 'TEST-SESSION';
    try { audioCtx = { currentTime: 0, sampleRate: (typeof sampleRate !== 'undefined' ? sampleRate : 16000) }; } catch (e) {}
    try { ctxOriginSec = 0; } catch (e) {}
    try { sessionOriginSamples = (typeof capturedSamples !== 'undefined') ? capturedSamples : 0; } catch (e) {}
    try { pendingSamples = new Float32Array(0); } catch (e) {}
    try { lastDriftWarnSec = 0; } catch (e) {}
  },
  // 单独推进音频时钟而不喂音频：模拟「音频线程丢了一个回调」（时钟照走，样本没来）。
  advanceClock(sec) { try { audioCtx.currentTime += sec; } catch (e) {} },
  queueLen() { return queue.length; },
  state() {
    return {
      capturedSamples: (typeof capturedSamples !== 'undefined') ? capturedSamples : 0,
      sessionOriginSamples: (typeof sessionOriginSamples !== 'undefined') ? sessionOriginSamples : 0,
      ctxTime: (typeof audioCtx !== 'undefined' && audioCtx) ? audioCtx.currentTime : null,
      ctxOriginSec: (typeof ctxOriginSec !== 'undefined') ? ctxOriginSec : 0,
      pendingLen: (typeof pendingSamples !== 'undefined') ? pendingSamples.length : 0,
      chunks: queue.map((q) => ({ startMs: q.startMs, durMs: q.durMs, reason: q.reason, pcmLen: q.pcm ? q.pcm.length : 0 })),
      sampleRate,
      vad: { ...VAD },
    };
  },
};
`;
  createContext(sandbox);
  runInContext(code, sandbox, { filename: 'transcript.html' });
  return sandbox.__probe as Probe;
}

interface Metrics {
  realMs: number;
  timelineMs: number;
  ratio: number;
  chunkCount: number;
  lastStartMs: number;
  lastDurMs: number;
  lastClaimedEndMs: number;
  lastCutRealMs: number;
  lastEndDriftMs: number;
  lastReason: string;
  pendingLen: number;
}

// 逐「浏览器回调」喂合成音频：每次给 processAudio 传 BROWSER_BUF(4096) 样本，并同步推进假音频时钟。
// pattern 每项是 [秒, 振幅]（振幅决定过不过门限）；跑满 targetSec 秒。
function runScenario(pattern: Array<[number, number]>, targetSec: number): Metrics {
  const p = loadPage();
  p.setSession();
  const base = p.state();
  const baseCaptured = base.capturedSamples;
  const baseChunks = base.chunks.length;

  let fedSamples = 0;
  let prevQueueLen = p.queueLen();
  let lastCutFedSamples = 0;

  const feed = (sec: number, amp: number) => {
    const total = Math.round(sec * RATE);
    let done = 0;
    while (done < total) {
      const n = Math.min(BROWSER_BUF, total - done); // 真实回调缓冲：4096（末尾可能不足一缓冲）
      const buf = new Float32Array(n);
      for (let i = 0; i < n; i++) buf[i] = amp * Math.sin((fedSamples + i) / 7); // 非零 RMS
      p.advanceClock(n / RATE);   // 音频硬件时钟随采集推进：本缓冲末样本落在 currentTime
      p.processAudio(buf, RATE);
      done += n;
      fedSamples += n;
      const len = p.queueLen();
      if (len > prevQueueLen) {
        prevQueueLen = len;
        lastCutFedSamples = fedSamples; // 该句被切出（进队）那一刻的真实采集样本数
      }
    }
  };

  let elapsed = 0;
  while (elapsed < targetSec) {
    for (const [secs, amp] of pattern) {
      if (elapsed >= targetSec) break;
      const s = Math.min(secs, targetSec - elapsed);
      feed(s, amp);
      elapsed += s;
    }
  }

  const st = p.state();
  const realMs = (fedSamples / RATE) * 1000;
  // 时间线推进用 capturedSamples（诊断量）：修复后每个样本都计数 ⇒ ≈ 真实；旧代码每回调丢 256 样本 ⇒ 0.938。
  const timelineMs = ((st.capturedSamples - baseCaptured) / RATE) * 1000;
  const newChunks = st.chunks.slice(baseChunks);
  const last = newChunks[newChunks.length - 1];
  const lastCutRealMs = (lastCutFedSamples / RATE) * 1000;
  return {
    realMs,
    timelineMs,
    ratio: timelineMs / realMs,
    chunkCount: newChunks.length,
    lastStartMs: last.startMs,
    lastDurMs: last.durMs,
    lastClaimedEndMs: last.startMs + last.durMs,
    lastCutRealMs,
    lastEndDriftMs: last.startMs + last.durMs - lastCutRealMs,
    lastReason: last.reason,
    pendingLen: st.pendingLen,
  };
}

function howLong(ms: number): string {
  const sign = ms < 0 ? '-' : '';
  const a = Math.abs(ms);
  return `${sign}${Math.floor(a / 60000)}分${String(Math.round((a % 60000) / 1000)).padStart(2, '0')}秒`;
}

const SCENARIOS: Array<[string, Array<[number, number]>]> = [
  ['A. GM 型（说 4s / 停 8s）', [[4, 0.05], [8, 0.001]]],
  ['B. 沉默听众型（说 2s / 停 58s）', [[2, 0.05], [58, 0.001]]],
  ['C. 穿插长独白（说 26s / 停 40s）', [[26, 0.05], [40, 0.001]]],
];

describe('transcript.html 时间基准：按浏览器真实 4096 缓冲喂帧不压缩', () => {
  for (const [label, pattern] of SCENARIOS) {
    it(`${label}：跑 5 分钟，时间线推进 ≥ 0.999 且末句时间偏差 < 1000ms`, () => {
      const m = runScenario(pattern, 300);
      // 打印真实数值，供报告引用
      console.log(
        `[timeline] ${label}\n` +
          `  切出句数=${m.chunkCount} 末句切分原因=${m.lastReason} 末尾残帧=${m.pendingLen}样本\n` +
          `  时间线推进=${howLong(m.timelineMs)}（${Math.round(m.timelineMs)}ms） 真实经过=${howLong(m.realMs)}（${Math.round(m.realMs)}ms） 压缩比=${m.ratio.toFixed(4)}\n` +
          `  末句 startMs=${Math.round(m.lastStartMs)} durMs=${Math.round(m.lastDurMs)} → claimedEnd=${Math.round(m.lastClaimedEndMs)}\n` +
          `  末句被切出的真实时刻=${Math.round(m.lastCutRealMs)} → 偏差=${Math.round(m.lastEndDriftMs)}ms`
      );

      expect(m.chunkCount).toBeGreaterThan(0);
      // ① 时间线推进 / 真实时间 ≥ 0.999（旧代码按 4096 喂帧只有 0.938：每回调丢 256/4096 样本）
      expect(m.ratio).toBeGreaterThanOrEqual(0.999);
      // ② 末句 (startMs+durMs) 与「该句被切出时的真实经过时间」差 < 1000ms
      expect(Math.abs(m.lastEndDriftMs)).toBeLessThan(1000);
      // ③ 每个样本都被处理：末尾残帧必然 < 一帧（320 样本），不会积累
      expect(m.pendingLen).toBeLessThan(Math.round((FRAME_MS / 1000) * RATE));
    });
  }
});

// 时钟抖动免疫：喂同样多的音频，唯一区别是中途音频时钟多走 2s（模拟丢了一个回调）。
// 修复后时间线以 audioCtx.currentTime 为准 ⇒ 末句 startMs 跟着跳 ~2s；旧代码用样本计数 ⇒ 停滞（差 ≈ 0）。
function runJitterLastStartMs(jumpSec: number): number {
  const p = loadPage();
  p.setSession();
  let fedSamples = 0;
  const feed = (sec: number, amp: number) => {
    const total = Math.round(sec * RATE);
    let done = 0;
    while (done < total) {
      const n = Math.min(BROWSER_BUF, total - done);
      const buf = new Float32Array(n);
      for (let i = 0; i < n; i++) buf[i] = amp * Math.sin((fedSamples + i) / 7);
      p.advanceClock(n / RATE);
      p.processAudio(buf, RATE);
      done += n;
      fedSamples += n;
    }
  };
  // 第一句（jump 之前）
  feed(0.5, 0.001);   // 先喂点静音填 preRoll
  feed(3, 0.05);      // 说 3s
  feed(1.5, 0.001);   // 停 1.5s → 切出第一片
  // 模拟丢回调：音频时钟额外前进 jumpSec，但不喂任何音频
  if (jumpSec > 0) p.advanceClock(jumpSec);
  // 第二句（jump 之后）
  feed(0.5, 0.001);
  feed(3, 0.05);
  feed(1.5, 0.001);   // 切出第二片
  const st = p.state();
  const last = st.chunks[st.chunks.length - 1];
  return last.startMs;
}

describe('transcript.html 时间基准对「丢回调」免疫（跟随音频时钟）', () => {
  it('中途音频时钟多走 2s（丢一个回调）时，末句 startMs 跟着跳 ~2000ms 而非停滞', () => {
    const noJump = runJitterLastStartMs(0);
    const withJump = runJitterLastStartMs(2);
    const delta = withJump - noJump;
    console.log(
      `[jitter] 无跳变末句 startMs=${Math.round(noJump)}ms 时钟+2s 末句 startMs=${Math.round(withJump)}ms → 差=${Math.round(delta)}ms`
    );
    // 两实例喂入音频完全相同，唯一区别是音频时钟多走 2s。
    // 时间线以音频时钟为准 ⇒ 差 ≈ 2000ms；旧代码用样本计数（时钟被忽略）⇒ 差 ≈ 0（断言失败）。
    expect(delta).toBeGreaterThan(1500);
    expect(delta).toBeLessThan(2500);
  });
});

// 句尾裁切生效：切出的最后一片音频长度 ≤ preRoll + 语音 + tailSilenceMs + 一帧，
// 且严格小于「把整段 silenceMs(700ms) 尾静音都带上」的长度（旧死代码会全带上）。
describe('transcript.html 句尾静音裁切确实生效（不再是死代码）', () => {
  it('末片音频长度 ≈ preRoll + 语音 + tailSilenceMs，而非带上整段 700ms 尾静音', () => {
    const p = loadPage();
    p.setSession();
    const st0 = p.state();
    const vad = st0.vad;
    const frameLen = Math.round((FRAME_MS / 1000) * RATE);
    let fedSamples = 0;
    const feed = (sec: number, amp: number) => {
      const total = Math.round(sec * RATE);
      let done = 0;
      while (done < total) {
        const n = Math.min(BROWSER_BUF, total - done);
        const buf = new Float32Array(n);
        for (let i = 0; i < n; i++) buf[i] = amp * Math.sin((fedSamples + i) / 7);
        p.advanceClock(n / RATE);
        p.processAudio(buf, RATE);
        done += n;
        fedSamples += n;
      }
    };
    const speechSec = 2;
    // 喂两句：第一片会被 pumpQueue 移出队列（fetch 永挂起、卡在上传中），
    // 第二片留在队列里可观测——两句形状相同，检查最后一片即可。
    const oneUtterance = () => {
      feed(0.5, 0.001);      // 前导静音，填 preRoll
      feed(speechSec, 0.05); // 说 2s（> minSpeechMs，不会被当噪声丢）
      feed(1.5, 0.001);      // 停 1.5s（> silenceMs=700ms）→ 切出且触发句尾裁切
    };
    oneUtterance();
    oneUtterance();

    const st = p.state();
    expect(st.chunks.length).toBe(1);
    const durMs = st.chunks[st.chunks.length - 1].durMs;
    const speechMs = speechSec * 1000;
    // 上传音频 = preRoll + 语音 + 保留的句尾静音（≤ tailSilenceMs + 一帧，含切帧取整余量）
    const upperBound = vad.preRollMs + speechMs + vad.tailSilenceMs + 2 * FRAME_MS;
    // 旧死代码会把整段 silenceMs 尾静音都带上 ⇒ 明显更长
    const untrimmedLowerBound = vad.preRollMs + speechMs + vad.silenceMs - FRAME_MS;
    console.log(
      `[tailtrim] 末片 durMs=${Math.round(durMs)}ms 上界(preRoll+语音+tailSilence+2帧)=${Math.round(upperBound)}ms ` +
        `未裁切下界(preRoll+语音+silence-1帧)=${Math.round(untrimmedLowerBound)}ms（一帧=${frameLen / RATE * 1000}ms）`
    );
    expect(durMs).toBeLessThanOrEqual(upperBound);
    expect(durMs).toBeLessThan(untrimmedLowerBound);
  });
});
