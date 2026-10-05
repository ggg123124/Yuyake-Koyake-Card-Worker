import { Bindings } from '../types';

// 按时间窗把「语音转写 + 游戏操作」汇总成一条人可读的事件摘要。
//
// 模型选型为实测所得（数据来自真实跑团素材，neurons 为官方计费单位，$0.011/1000）：
//   mistral-small-3.1-24b  128K ctx  17.5 neurons  2213ms  ← 选用：输出含资源数值，非 reasoning，稳定
//   llama-4-scout-17b      131K ctx  11.9 neurons  1690ms  更便宜更快，但偏简略
//   llama-3.2-3b            80K ctx   5.0 neurons  1631ms  最便宜，但两次实测结果差异很大（不稳定）
//   llama-3.2-1b            60K ctx   2.0 neurons  1770ms  不可用：会把判定和资源张冠李戴
//   llama-3.3-70b           24K ctx  31.8 neurons  3495ms  质量最好但最贵，且上下文最小（原选）
//   qwen3-30b-a3b /
//   gemma-4-26b-a4b         —— 属 reasoning 模型，思考会吃满 token 致 response 为空，一律排除
//
// 成本参考：一场 2 小时团约 60 次汇总 ≈ 1050 neurons ≈ ¥0.08，
// 远低于每日 10,000 neurons 的免费额度，故不为省钱牺牲质量。

const MODEL = '@cf/mistralai/mistral-small-3.1-24b-instruct';
export const WINDOW_MS = 120_000; // 约 2 分钟一个窗口
const MIN_SEGMENTS = 2; // 素材太少不值得调模型
const MAX_SEGMENTS = 300;
const MAX_LOGS = 80;
export const MAX_PROMPT_CHARS = 8000;
export const PREV_SUMMARY_COUNT = 3;
export const PREV_SUMMARY_MAX_CHARS = 600;
export const PREV_SUMMARY_LOOKBACK_MS = 600_000;

// —— 摘要窗口锚定「素材水位」相关常量 ——
// 2026-10-01 事故根因：窗口右端曾用墙钟 Date.now()，素材（语音段）晚到落在「已过去的窗口」里，
// 之后窗口起点又前移 ⇒ 这些素材永远不会被任何摘要覆盖（线上每条摘要 source_segments=0，只剩资源流水）。
export const ACTIVE_SESSION_MS = 180_000; // 会话最近 3 分钟内有素材到库才算「仍在录」
export const WATERMARK_PIN_MAX_LAG_MS = 600_000; // 水位落后墙钟超过 10 分钟就不再 pin（要 WARN 留痕）
export const MAX_WINDOW_MS = 300_000; // 单条摘要最长覆盖 5 分钟（本次事故出现过 75 分钟的超长窗口）
export const TAIL_WINDOW_MS = 15_000; // 全部会话已结束时，允许用一小段收尾窗口把最后素材收掉

export interface SessionWatermarkRow {
  status: string;
  maxAbsEndMs: number | null;
  lastRecvAt: string | null; // datetime('now') 文本（UTC）
}

// 返回本房间的「素材水位」（ms）：窗口右端不再用墙钟，而用「已经到库的素材水位」。
// 没有任何素材返回 null。
export function pickWatermark(
  segMaxAbsEndMs: number | null,
  sessions: SessionWatermarkRow[],
  nowMs: number
): { watermark: number | null; pinned: boolean; lagMs: number } {
  const base = segMaxAbsEndMs;
  if (base == null) return { watermark: null, pinned: false, lagMs: 0 };

  // 活跃会话：status='recording' 且最近 ACTIVE_SESSION_MS 内有素材到库且有 abs_end_ms。
  const active = sessions.filter((s) => {
    if (s.status !== 'recording' || s.maxAbsEndMs == null || !s.lastRecvAt) return false;
    // lastRecvAt 是 SQLite datetime('now') 文本（UTC），按 replace(' ','T')+'Z' 解析
    const recvMs = Date.parse(s.lastRecvAt.replace(' ', 'T') + 'Z');
    if (!Number.isFinite(recvMs)) return false;
    return nowMs - recvMs <= ACTIVE_SESSION_MS;
  });

  if (active.length === 0) {
    return { watermark: base, pinned: false, lagMs: nowMs - base };
  }

  // 活跃会话把水位往回 pin 到「最慢的活跃会话」，避免它的晚到素材被跳过
  const pinned = Math.min(...active.map((s) => s.maxAbsEndMs as number));
  const lagMs = nowMs - pinned;
  if (lagMs <= WATERMARK_PIN_MAX_LAG_MS) {
    return { watermark: Math.min(base, pinned), pinned: true, lagMs };
  }
  // pin 落后墙钟超过上限：某个「活跃」会话的水位异常陈旧，不再 pin，保持 base 并 WARN 留痕（禁静默降级）
  console.warn(
    `[summary] watermark-pin-stale room水位拖后腿 pinned=${pinned} base=${base} 落后墙钟=${Math.round(
      lagMs / 1000
    )}s（>${WATERMARK_PIN_MAX_LAG_MS / 1000}s），回退到素材水位 base`
  );
  return { watermark: base, pinned: false, lagMs };
}

export interface WindowInput {
  lastEndMs: number | null; // 上一条摘要的 end_ms
  watermark: number; // 素材水位（pickWatermark 结果，非 null）
  hasRecordingSession: boolean; // 房间里是否仍有 status='recording' 的会话
}
export interface WindowResult {
  startMs: number;
  endMs: number;
  skip: 'too-soon' | null;
  // 锚点前移留痕：true = startMs 被从 lastEndMs 强行推到 watermark 附近，中间那段时间不再被任何摘要覆盖
  jumped: boolean;
  skippedMs: number;
}

// 纯函数：由「上一条摘要 end_ms + 素材水位」算出本条摘要窗口，便于单测。
export function computeWindow(inp: WindowInput): WindowResult {
  const { lastEndMs, watermark, hasRecordingSession } = inp;
  let startMs = lastEndMs ?? Math.max(0, watermark - WINDOW_MS);

  // 锚点前移（2026-10-01 房间 SVS3C「4 天 0 摘要」死锁的修法）：
  // 下面 endMs = min(watermark, startMs + MAX_WINDOW_MS)，所以一旦锚点落后到
  // startMs + MAX_WINDOW_MS < watermark - WINDOW_MS（即落后超过 MAX_WINDOW_MS + WINDOW_MS = 7 分钟），
  // 窗口就永远只能是 [lastEnd, lastEnd + 5min) 这段「陈旧切片」：切片里没素材 ⇒ 生成不了摘要 ⇒
  // 锚点永远推不动 ⇒ 之后所有素材都进不了摘要（实测该房 1103 条语音段全部漏掉）。
  // 故把 startMs 前移到 watermark - MAX_WINDOW_MS：窗口必定盖住最近的素材，且 span 恰为 MAX_WINDOW_MS
  // （≥ WINDOW_MS），不会再判 too-soon。代价是跳过的那段时间不再被覆盖 —— 属可观测的取舍，
  // 由 maybeSummarize 拿 jumped/skippedMs 去 WARN（本函数是纯函数，禁止在这里打日志）。
  let jumped = false;
  let skippedMs = 0;
  if (startMs + MAX_WINDOW_MS < watermark - WINDOW_MS) {
    const jumpedTo = watermark - MAX_WINDOW_MS;
    skippedMs = jumpedTo - startMs;
    startMs = jumpedTo;
    jumped = true;
  }

  // 单条摘要最长覆盖 MAX_WINDOW_MS（事故里出现过 75 分钟超长窗口 → 模型只能空泛复读前情提要）
  const endMs = Math.min(watermark, startMs + MAX_WINDOW_MS);
  const span = endMs - startMs;
  // 仍在录音：窗口不足 WINDOW_MS 就等下一轮（too-soon）；
  // 全部 done：允许用 TAIL_WINDOW_MS 的收尾窗口把最后素材收掉，否则停录后的末段会被永久留在库外。
  const minSpan = hasRecordingSession ? WINDOW_MS : TAIL_WINDOW_MS;
  if (span < minSpan) return { startMs, endMs, skip: 'too-soon', jumped, skippedMs };
  return { startMs, endMs, skip: null, jumped, skippedMs };
}

const RES_LABEL: Record<string, string> = { dream: '梦点', feeling: '心意点', wonder: '奇迹点' };

export interface PrevSummary {
  startMs: number;
  endMs: number;
  summary: string;
}

export interface SummaryPromptInput {
  secs: number;
  playerNames: string[];
  logs: Array<{ character_name: string | null; resource_type: string; change_amount: number; reason: string | null }>;
  segs: Array<{ character_name: string | null; text: string }>;
  prev: PrevSummary[];
  windowStartMs: number;
}

// 把前情摘要格式化为 prompt 中的一段文本块。
// prev 必须按时间正序（旧 → 新）。返回空串表示无前情。
// 字数控制从最新往最旧累加：总长超上限就停，但最新那条永远保留。
export function formatPrevBlock(prev: PrevSummary[], windowStartMs: number): string {
  if (prev.length === 0) return '';

  const lines: string[] = [];
  let totalLen = 0;
  // 从最新向最旧遍历，便于按累积字数截断
  for (let i = prev.length - 1; i >= 0; i--) {
    const p = prev[i];
    const gapSec = Math.round((windowStartMs - p.endMs) / 1000);
    const label =
      gapSec <= 5 ? '紧邻上一时段' : gapSec < 90 ? `约 ${gapSec} 秒前` : `约 ${Math.round(gapSec / 60)} 分钟前`;
    const line = `- （${label}）${p.summary}`;
    // 最新那条永远保留，即使它自己就超限
    if (i < prev.length - 1 && totalLen + line.length > PREV_SUMMARY_MAX_CHARS) break;
    lines.push(line);
    totalLen += line.length;
  }
  // 输出恢复为时间正序（旧 → 新）
  lines.reverse();
  return lines.join('\n');
}

// 纯函数：根据素材和前情拼装完整 prompt。不碰 DB / AI，便于单测。
export function buildSummaryPrompt(input: SummaryPromptInput): string {
  const { secs, playerNames, logs, segs, prev, windowStartMs } = input;

  const logBlock = logs.length
    ? logs
        .map(
          (l) =>
            `- ${l.character_name || '?'} ${RES_LABEL[l.resource_type] || l.resource_type} ${
              l.change_amount > 0 ? '+' : ''
            }${l.change_amount}${l.reason ? `（${l.reason}）` : ''}`
        )
        .join('\n')
    : '（无）';
  const segBlock = segs.map((s) => `- [${s.character_name || '未知'}] ${s.text}`).join('\n');
  const prevBlock = formatPrevBlock(prev, windowStartMs);

  const parts: string[] = [
    `下面是《夕妖晚谣》TRPG 跑团最近约 ${secs} 秒的语音转写和游戏操作记录。`,
    `请用 2-3 句简体中文总结这段时间发生了什么。重点写：剧情推进、判定的成败、资源变化、牵绊或阶段变化。`,
    `只写记录里出现的事实，不要编造，不要评价好坏。如果内容太少，就写「这段时间没有实质进展」。`,
    playerNames.length ? `参与玩家的角色名：${playerNames.join('、')}（提到这些名字时指的是玩家角色本人）。` : '',
    prevBlock ? `下面的「前情提要」是更早时段的摘要，只用来理解本时段对话里的指代和因果：不要复述前情内容，也不要把前情当成这段时间发生的事。` : '',
    prevBlock ? `【前情提要】\n${prevBlock}` : '',
    '',
    '【游戏操作】',
    logBlock,
    '',
    '【语音记录】',
    segBlock,
  ];

  return parts
    .filter((l) => l !== '')
    .join('\n')
    .slice(0, MAX_PROMPT_CHARS);
}

export interface SummarizeResult {
  ok: boolean;
  skipped?: string;
  summaryId?: string;
  summary?: string;
  segments?: number;
  logs?: number;
  latencyMs?: number;
  error?: string;
}

// 模型偶尔会带  thinking 或代码块包裹，清掉再入库
function cleanSummary(raw: string): string {
  return raw
    .replace(/<\/?think>/gi, '')
    .replace(/```[a-z]*/gi, '')
    .replace(/^\s*(摘要|总结)\s*[:：]\s*/, '')
    .trim();
}

async function notifySummary(
  env: Bindings,
  roomId: string,
  payload: { id: string; startMs: number; endMs: number; summary: string }
) {
  try {
    const stub = env.ROOM_DO.get(env.ROOM_DO.idFromName(roomId));
    await stub.fetch(
      new Request(`http://internal/rooms/${roomId}/broadcast-summary`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Room-Id': roomId },
        body: JSON.stringify(payload),
      })
    );
  } catch (e) {
    // 广播失败不能影响摘要已入库：留痕但不抛
    console.warn(
      `[summary] broadcast-failed room=${roomId} err=${e instanceof Error ? e.message : String(e)}`
    );
  }
}

/**
 * 尝试为房间生成一条事件摘要。
 * 幂等设计：窗口起点取「上一条摘要的 end_ms」，并发触发时会算出同一个 start_ms，
 * 由 room_summaries(room_id, start_ms) 唯一索引挡掉重复（INSERT OR IGNORE + changes 判定）。
 */
export async function maybeSummarize(env: Bindings, roomId: string): Promise<SummarizeResult> {
  const db = env.DB;
  const now = Date.now();

  // 门控必须是第一件事：下面两条水位查询跑在 skip 判定之前，即使一条摘要都不生成也要烧掉数千行读量，
  // 所以开关关着时连它们都不能执行。这里只花 1 行（rooms 主键读）。
  // 房间不存在时 gate 为 null，同样按「未开启」短路 —— 但日志如实区分，不静默当成关。
  const gate = await db
    .prepare('SELECT summary_enabled FROM rooms WHERE id = ?')
    .bind(roomId)
    .first<{ summary_enabled: number | null }>();
  if (gate?.summary_enabled !== 1) {
    console.info(
      `[summary] skip room=${roomId} reason=disabled summary_enabled=${
        gate ? gate.summary_enabled : '房间不存在'
      }（GM 可在房间面板开启；本次未做水位/素材查询、未调 AI）`
    );
    return { ok: true, skipped: 'disabled' };
  }

  const last = await db
    .prepare('SELECT end_ms FROM room_summaries WHERE room_id = ? ORDER BY end_ms DESC LIMIT 1')
    .bind(roomId)
    .first<{ end_ms: number }>();
  const lastEndMs = last?.end_ms ?? null;

  // 素材水位（房间维度）：已入库语音段的最大 abs_end_ms。
  // SQL 不变，靠新索引 idx_ts_segments_room_end (room_id, abs_end_ms) 让 SQLite 直接取索引末端，
  // 不再把该房全部段落读一遍（实测旧计划 1886 行）。
  const segMax = await db
    .prepare('SELECT MAX(abs_end_ms) AS mx FROM transcript_segments WHERE room_id = ?')
    .bind(roomId)
    .first<{ mx: number | null }>();
  const segMaxAbsEndMs = segMax?.mx ?? null;

  // 素材水位（会话维度）+ 最近到库时间：recv 用 MAX(created_at)（datetime('now') 文本，UTC）
  // 两处降读量改动，语义与旧的 LEFT JOIN + GROUP BY 版本等价：
  //   ① WHERE 加 s.status='recording'：pickWatermark 内部只使用 status==='recording' 的会话
  //      （其它状态在函数里被 filter 掉），已结束的会话往往是多数，不参与扫描即省掉它们的段落。
  //   ② 相关子查询替代 JOIN + GROUP BY：新索引 (session_id, abs_end_ms) / (session_id, created_at)
  //      让每个 MAX 直接取索引末端（实测旧 JOIN 单次烧 3811 行）。无段落的会话子查询返回 NULL，
  //      与 LEFT JOIN 的行为一致。
  const sessRes = await db
    .prepare(
      `SELECT s.id AS id, s.status AS status,
              (SELECT MAX(abs_end_ms) FROM transcript_segments seg WHERE seg.session_id = s.id) AS mx,
              (SELECT MAX(created_at)  FROM transcript_segments seg WHERE seg.session_id = s.id) AS recv
       FROM transcript_sessions s
       WHERE s.room_id = ? AND s.status = 'recording'`
    )
    .bind(roomId)
    .all<{ id: string; status: string; mx: number | null; recv: string | null }>();
  const sessRows = sessRes.results || [];
  // 等价性：SQL 已把结果限定为 recording 会话，故「结果非空」⇔「存在 recording 行」，
  // 与旧的 sessRows.some(r => r.status === 'recording') 同义（且省掉遍历）。
  const hasRecordingSession = sessRows.length > 0;

  const { watermark, pinned, lagMs } = pickWatermark(
    segMaxAbsEndMs,
    sessRows.map((r) => ({ status: r.status, maxAbsEndMs: r.mx, lastRecvAt: r.recv })),
    now
  );
  if (watermark === null) {
    // 没有任何素材：沿用 not-enough-material 跳过（留痕，不静默）
    console.info(
      `[summary] skip room=${roomId} reason=not-enough-material 无素材水位 segMax=${segMaxAbsEndMs} recordingSessions=${sessRows.length}`
    );
    return { ok: true, skipped: 'not-enough-material' };
  }

  const win = computeWindow({ lastEndMs, watermark, hasRecordingSession });
  if (win.jumped) {
    // 锚点前移必须留痕（禁静默）：被跳过的那段时间不会再被任何摘要覆盖
    console.warn(
      `[summary] anchor-jump room=${roomId} 摘要锚点严重落后已前移 lastEndMs=${lastEndMs} watermark=${watermark} ` +
        `新起点=${win.startMs} 跳过=${Math.round(win.skippedMs / 1000)}s（约 ${(win.skippedMs / 60000).toFixed(1)} 分钟素材不再有摘要覆盖）`
    );
  }
  if (win.skip) {
    const span = win.endMs - win.startMs;
    console.info(
      `[summary] skip room=${roomId} reason=${win.skip} span=${span}ms 需≥${
        hasRecordingSession ? WINDOW_MS : TAIL_WINDOW_MS
      }ms watermark=${watermark} pinned=${pinned} 水位落后墙钟=${lagMs}ms`
    );
    return { ok: true, skipped: win.skip };
  }

  const startMs = win.startMs;
  const endMs = win.endMs;

  // ① 窗口内的语音转写 —— 严格 [startMs, endMs)。
  // 不再留旧的 +30s 右容差：窗口右端已改为「素材水位」，水位保证窗口内的素材都已到库；
  // 若仍留容差，边界处的素材会被相邻两条摘要重复计入。
  const segRes = await db
    .prepare(
      `SELECT character_name, abs_start_ms, text FROM transcript_segments
       WHERE room_id = ? AND abs_start_ms >= ? AND abs_start_ms < ?
       ORDER BY abs_start_ms ASC LIMIT ?`
    )
    .bind(roomId, startMs, endMs, MAX_SEGMENTS)
    .all<{ character_name: string | null; abs_start_ms: number; text: string }>();
  const segs = segRes.results || [];

  // ② 窗口内的游戏操作（resource_logs 存的是 character_id，JOIN 出名字）—— 同样严格 [startMs, endMs)
  const logRes = await db
    .prepare(
      `SELECT c.name AS character_name, rl.resource_type, rl.change_amount, rl.reason
       FROM resource_logs rl LEFT JOIN characters c ON c.id = rl.character_id
       WHERE rl.room_code = ?
         AND rl.created_at >= datetime(?, 'unixepoch')
         AND rl.created_at <  datetime(?, 'unixepoch')
       ORDER BY rl.id ASC LIMIT ?`
    )
    .bind(roomId, Math.floor(startMs / 1000), Math.floor(endMs / 1000), MAX_LOGS)
    .all<{ character_name: string | null; resource_type: string; change_amount: number; reason: string | null }>();
  const logs = logRes.results || [];

  if (segs.length < MIN_SEGMENTS && logs.length === 0) {
    console.info(
      `[summary] skip room=${roomId} reason=not-enough-material segs=${segs.length} logs=${logs.length}`
    );
    return { ok: true, skipped: 'not-enough-material' };
  }

  // ③ 玩家角色名单 —— 明确告诉模型「这些是玩家角色」，避免把角色名当成 NPC
  const memRes = await db
    .prepare(
      `SELECT c.name AS name FROM room_members rm
       LEFT JOIN characters c ON c.id = rm.character_id
       WHERE rm.room_id = ?`
    )
    .bind(roomId)
    .all<{ name: string | null }>();
  const playerNames = (memRes.results || []).map((r) => r.name).filter((n): n is string => !!n);

  const secs = Math.round((endMs - startMs) / 1000);

  // ④ 前情提要：取最近几条摘要作为上下文，帮助模型理解跨窗口的指代和因果
  const prevRes = await db
    .prepare(
      `SELECT start_ms, end_ms, summary FROM room_summaries
       WHERE room_id = ? AND end_ms >= ?
       ORDER BY start_ms DESC LIMIT ?`
    )
    .bind(roomId, startMs - PREV_SUMMARY_LOOKBACK_MS, PREV_SUMMARY_COUNT)
    .all<{ start_ms: number; end_ms: number; summary: string }>();
  // 查询结果是 DESC，反转为时间正序（旧 → 新）
  const prev: PrevSummary[] = (prevRes.results || [])
    .map((r) => ({ startMs: r.start_ms, endMs: r.end_ms, summary: r.summary }))
    .reverse();
  console.debug(`[summary] prev-count room=${roomId} n=${prev.length}`);

  const prompt = buildSummaryPrompt({ secs, playerNames, logs, segs, prev, windowStartMs: startMs });

  const t0 = Date.now();
  let out: unknown;
  try {
    out = await env.AI.run(MODEL, {
      messages: [
        {
          role: 'system',
          content: '你是《夕妖晚谣》TRPG 跑团的记录员，用简体中文写简洁准确的事件摘要，只陈述事实。',
        },
        { role: 'user', content: prompt },
      ],
      max_tokens: 400,
      temperature: 0.3,
    } as never);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[summary] ai-failed room=${roomId} err=${msg}`);
    return { ok: false, error: msg };
  }
  const latencyMs = Date.now() - t0;

  const o = (out ?? {}) as {
    response?: unknown;
    usage?: unknown;
    choices?: Array<{ message?: { content?: string } }>;
  };
  // 输出格式因模型而异：多数是 {response}，部分走 OpenAI 兼容的 {choices[0].message.content}
  const raw = o.response ?? o.choices?.[0]?.message?.content ?? '';
  const summary = cleanSummary(String(raw));
  if (!summary) {
    console.warn(`[summary] empty-summary room=${roomId} latency=${latencyMs}ms`);
    return { ok: false, error: 'empty-summary' };
  }

  // 并发防护：waitUntil 自动触发与手动触发可能同时执行，两者都读到「还没有上一条」
  // 时会各自算出 now-120s 的首次窗口（起点差几毫秒，唯一索引 (room_id,start_ms) 挡不住），
  // 结果生成两条覆盖同一时段的摘要（实测 ZTMNSOC 出现窗口相差 2 秒的两条）。
  // 故落库前复查：若已存在 end_ms 晚于本窗口起点的摘要，说明窗口已被抢先占用，放弃。
  const id = crypto.randomUUID();
  // 原子化并发防护：把「检查窗口是否已被占用」和「写入」合并进同一条 SQL。
  // 此前是 SELECT 复查 + INSERT 两步，两个并发请求会同时读到「无占用」而双双写入（TOCTOU）。
  // 该缺陷真实发生过：4 会话并发上传的房间 ZTPKP8C 产生了重叠窗口（全库扫描查得）。
  // D1 的单条语句是原子的，故用 INSERT ... SELECT ... WHERE NOT EXISTS 一步完成；
  // 同时保留 OR IGNORE 兜底唯一索引 (room_id, start_ms) 的冲突。
  const ins = await db
    .prepare(
      `INSERT OR IGNORE INTO room_summaries
         (id, room_id, start_ms, end_ms, summary, model, source_segments, source_logs, token_usage, latency_ms)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM room_summaries WHERE room_id = ? AND end_ms > ?
        )`
    )
    .bind(
      id,
      roomId,
      startMs,
      endMs,
      summary,
      MODEL,
      segs.length,
      logs.length,
      JSON.stringify(o.usage ?? null),
      latencyMs,
      roomId,
      startMs
    )
    .run();

  // changes=0 = 窗口已被并发请求占用（或撞上唯一索引）
  if (!ins.meta?.changes) {
    console.info(`[summary] 跳过：窗口已被并发请求占用 room=${roomId} startMs=${startMs}`);
    return { ok: true, skipped: 'concurrent-window' as const };
  }

  console.info(
    `[summary] ok room=${roomId} segs=${segs.length} logs=${logs.length} latency=${latencyMs}ms chars=${summary.length}`
  );

  await notifySummary(env, roomId, { id, startMs, endMs, summary });

  return { ok: true, summaryId: id, summary, segments: segs.length, logs: logs.length, latencyMs };
}
