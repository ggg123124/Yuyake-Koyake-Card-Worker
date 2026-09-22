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
const WINDOW_MS = 120_000; // 约 2 分钟一个窗口
const MIN_SEGMENTS = 2; // 素材太少不值得调模型
const MAX_SEGMENTS = 300;
const MAX_LOGS = 80;
const MAX_PROMPT_CHARS = 8000;

const RES_LABEL: Record<string, string> = { dream: '梦点', feeling: '心意点', wonder: '奇迹点' };

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

  const last = await db
    .prepare('SELECT end_ms FROM room_summaries WHERE room_id = ? ORDER BY end_ms DESC LIMIT 1')
    .bind(roomId)
    .first<{ end_ms: number }>();

  if (last && now - last.end_ms < WINDOW_MS) {
    console.debug(
      `[summary] skip room=${roomId} reason=too-soon 距上次 ${Math.round((now - last.end_ms) / 1000)}s`
    );
    return { ok: true, skipped: 'too-soon' };
  }

  const startMs = last?.end_ms ?? now - WINDOW_MS;
  const endMs = now;
  // 取素材时右边界留 30s 容差：上传有延迟，且客户端算出的片段起点可能贴近甚至略晚于 now
  // （实测复现：瞬间上传 21s 音频时，第 2 片起点落 now 之后被排除 → 误判素材不足而跳过）。
  // 注意入库的摘要仍记录真实的 endMs。
  const segEndMs = endMs + 30_000;

  // ① 窗口内的语音转写
  const segRes = await db
    .prepare(
      `SELECT character_name, abs_start_ms, text FROM transcript_segments
       WHERE room_id = ? AND abs_start_ms >= ? AND abs_start_ms < ?
       ORDER BY abs_start_ms ASC LIMIT ?`
    )
    .bind(roomId, startMs, segEndMs, MAX_SEGMENTS)
    .all<{ character_name: string | null; abs_start_ms: number; text: string }>();
  const segs = segRes.results || [];

  // ② 窗口内的游戏操作（resource_logs 存的是 character_id，JOIN 出名字）
  const logRes = await db
    .prepare(
      `SELECT c.name AS character_name, rl.resource_type, rl.change_amount, rl.reason
       FROM resource_logs rl LEFT JOIN characters c ON c.id = rl.character_id
       WHERE rl.room_code = ?
         AND rl.created_at >= datetime(?, 'unixepoch')
         AND rl.created_at <  datetime(?, 'unixepoch')
       ORDER BY rl.id ASC LIMIT ?`
    )
    .bind(roomId, Math.floor(startMs / 1000), Math.floor(segEndMs / 1000), MAX_LOGS)
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

  const prompt = [
    `下面是《夕妖晚谣》TRPG 跑团最近约 ${secs} 秒的语音转写和游戏操作记录。`,
    `请用 2-3 句简体中文总结这段时间发生了什么。重点写：剧情推进、判定的成败、资源变化、牵绊或阶段变化。`,
    `只写记录里出现的事实，不要编造，不要评价好坏。如果内容太少，就写「这段时间没有实质进展」。`,
    playerNames.length ? `参与玩家的角色名：${playerNames.join('、')}（提到这些名字时指的是玩家角色本人）。` : '',
    '',
    '【游戏操作】',
    logBlock,
    '',
    '【语音记录】',
    segBlock,
  ]
    .filter((l) => l !== '')
    .join('\n')
    .slice(0, MAX_PROMPT_CHARS);

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

  const id = crypto.randomUUID();
  const ins = await db
    .prepare(
      `INSERT OR IGNORE INTO room_summaries
         (id, room_id, start_ms, end_ms, summary, model, source_segments, source_logs, token_usage, latency_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      latencyMs
    )
    .run();

  // 被唯一索引挡下 = 另一路并发已经写了同一窗口
  if ((ins.meta?.changes ?? 0) === 0) {
    console.info(`[summary] skip room=${roomId} reason=window-taken start=${startMs}（并发已写入）`);
    return { ok: true, skipped: 'window-taken' };
  }

  console.info(
    `[summary] ok room=${roomId} segs=${segs.length} logs=${logs.length} latency=${latencyMs}ms chars=${summary.length}`
  );

  await notifySummary(env, roomId, { id, startMs, endMs, summary });

  return { ok: true, summaryId: id, summary, segments: segs.length, logs: logs.length, latencyMs };
}
