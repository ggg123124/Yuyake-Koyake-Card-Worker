import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth';
import { Bindings, Variables } from '../types';
import { maybeSummarize } from './summarize';

const route = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// 内置术语表（《夕妖晚谣》常用词），与房间角色名、GM 补充词一起作为 Whisper 的 initial_prompt
const TERMS =
  '涉世、变化、野性、童真、心意点、梦点、奇迹点、回忆、牵绊、判定、必要值、化形、真身、小镇、神社、鸟居、狐狸、狸、猫、犬、兔、鸟、鼠、登场、退场';

const MODEL = '@cf/openai/whisper-large-v3-turbo';
const MAX_CHUNK_BYTES = 25 * 1024 * 1024;

async function buildPrompt(db: D1Database, roomId: string): Promise<string> {
  const members = await db
    .prepare(
      `SELECT c.name AS name FROM room_members rm
       LEFT JOIN characters c ON c.id = rm.character_id
       WHERE rm.room_id = ?`
    )
    .bind(roomId)
    .all<{ name: string | null }>();
  const names = (members.results || []).map((r) => r.name).filter((n): n is string => !!n);

  const gl = await db
    .prepare('SELECT extra_terms FROM transcript_glossary WHERE room_id = ?')
    .bind(roomId)
    .first<{ extra_terms: string }>();

  const parts = ['以下是《夕妖晚谣》TRPG 跑团的中文对话，请用简体中文转写。'];
  if (names.length) parts.push(`参与角色名：${names.join('、')}。`);
  parts.push(`术语：${TERMS}。`);
  if (gl?.extra_terms && gl.extra_terms.trim()) parts.push(`本场补充词：${gl.extra_terms.trim()}。`);
  return parts.join('');
}

// 转写完成后通知 RoomDO 广播给房间内所有人（实时对话流）
async function notifyTranscriptUpdate(
  env: Bindings,
  roomId: string,
  speaker: string | null,
  segments: Array<{ startMs: number; endMs: number; text: string }>
) {
  try {
    const doId = env.ROOM_DO.idFromName(roomId);
    const stub = env.ROOM_DO.get(doId);
    await stub.fetch(
      new Request(`http://internal/rooms/${roomId}/broadcast-transcript`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Room-Id': roomId },
        body: JSON.stringify({ speaker, segments }),
      })
    );
  } catch (e) {
    // 广播失败不能影响转写结果落库：留痕但不报错
    console.warn(
      `[transcript] broadcast-failed room=${roomId} err=${e instanceof Error ? e.message : String(e)}`
    );
  }
}

// Whisper 在静音/噪声段会吐出训练语料里的字幕套话（经典幻觉），
// 这类内容会污染跑团记录，直接丢弃——但必须留痕，不静默处理。
const HALLUCINATION_PATTERNS: RegExp[] = [
  /请不吝?点赞/,
  /点赞|订阅|转发|打赏|投币/,
  /字幕/,
  /由.{0,8}(提供|制作|翻译)/,
  /谢谢观看|感谢观看|观看本视频|下次见/,
  /amara\.org|subtitles?\s*by|transcri(pt|bed)\s*by/i,
  /www\.|https?:\/\//i,
  /明镜|点点|MING\s*PAO/i,
];

function isHallucination(raw: string): boolean {
  const t = raw.trim().replace(/^[\s,，。、.!！?？…-]+|[\s,，。、.!！?？…-]+$/g, '');
  if (t.length < 2) return true; // 空串或纯标点
  if (HALLUCINATION_PATTERNS.some((re) => re.test(t))) return true; // 字幕套话
  const chars = t.replace(/\s/g, '');
  if (chars.length >= 6 && new Set(chars).size <= 3) return true; // 单字复读（啊啊啊啊）
  if (chars.length >= 6 && /^(.{2,4})\1{2,}$/.test(chars)) return true; // 短语整体复读
  return false;
}

async function findMember(db: D1Database, roomId: string, userId: string) {
  return db
    .prepare(
      `SELECT rm.character_id, c.name AS character_name
       FROM room_members rm LEFT JOIN characters c ON c.id = rm.character_id
       WHERE rm.room_id = ? AND rm.user_id = ?`
    )
    .bind(roomId, userId)
    .first<{ character_id: string | null; character_name: string | null }>();
}

// ---- 开团：建 session + 对时 + 下发词表 ----
route.post('/:code/transcript/session', authMiddleware, async (c) => {
  const code = c.req.param('code');
  const userId = c.get('userId');
  const db = c.env.DB;

  const room = await db.prepare('SELECT id FROM rooms WHERE id = ?').bind(code).first();
  if (!room) return c.json({ error: '房间不存在' }, 404);

  const member = await findMember(db, code, userId);
  if (!member) return c.json({ error: '你不在该房间中' }, 403);

  const body = (await c.req.json().catch(() => ({}))) as { clientTs?: number; deviceLabel?: string };
  const serverTs = Date.now();
  const offsetMs = typeof body.clientTs === 'number' ? serverTs - body.clientTs : 0;

  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO transcript_sessions
        (id, room_id, user_id, character_id, character_name, client_offset_ms, device_label, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'recording')`
    )
    .bind(
      id,
      code,
      userId,
      member.character_id ?? null,
      member.character_name ?? null,
      offsetMs,
      body.deviceLabel ?? null
    )
    .run();

  const prompt = await buildPrompt(db, code);
  console.info(`[transcript] session-start room=${code} user=${userId} offset=${offsetMs}ms`);
  return c.json({ sessionId: id, serverTs, offsetMs, prompt, model: MODEL });
});

// ---- 上传一片音频 → Workers AI 转写 → 落库 ----
route.post('/:code/transcript/chunk', authMiddleware, async (c) => {
  const code = c.req.param('code');
  const userId = c.get('userId');
  const db = c.env.DB;

  const sessionId = c.req.query('sessionId');
  const chunkSeq = Number(c.req.query('chunkSeq') ?? NaN);
  const startMs = Number(c.req.query('startMs') ?? NaN);
  if (!sessionId || !Number.isFinite(chunkSeq) || !Number.isFinite(startMs) || chunkSeq < 0 || startMs < 0) {
    return c.json({ error: '参数无效' }, 400);
  }

  // 先校验成员身份：否则非成员会因 session 查不到而得到 404，
  // 与其他接口的 403 语义不一致（安全上不越权，但对外行为不统一、可被用于探测）
  const member = await findMember(db, code, userId);
  if (!member) return c.json({ error: '你不在该房间中' }, 403);

  const sess = await db
    .prepare(
      `SELECT id, character_id, character_name, client_offset_ms, started_at
       FROM transcript_sessions WHERE id = ? AND room_id = ? AND user_id = ?`
    )
    .bind(sessionId, code, userId)
    .first<{
      id: string;
      character_id: string | null;
      character_name: string | null;
      client_offset_ms: number;
      started_at: string;
    }>();
  if (!sess) return c.json({ error: '会话不存在' }, 404);

  const buf = await c.req.arrayBuffer();
  if (!buf.byteLength) return c.json({ error: '音频为空' }, 400);
  if (buf.byteLength > MAX_CHUNK_BYTES) return c.json({ error: '音频片过大（上限 25MB）' }, 413);

  const prompt = await buildPrompt(db, code);
  const t0 = Date.now();
  let ai: any;
  try {
    ai = await c.env.AI.run(MODEL, {
      // 官方 binding 期望 audio 为 object，body 传二进制流
      audio: { body: new Response(buf).body, contentType: c.req.header('content-type') || 'audio/wav' },
      language: 'zh',
      task: 'transcribe',
      initial_prompt: prompt,
      vad_filter: true,
    } as any);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[transcript] ai-failed room=${code} session=${sessionId} chunk=${chunkSeq} err=${msg}`);
    return c.json({ error: '转写服务暂时不可用，请稍后重试' }, 502);
  }
  const aiMs = Date.now() - t0;

  const segments: Array<{ start?: number; end?: number; text?: string }> = Array.isArray(ai?.segments)
    ? ai.segments
    : [];
  const fallbackText = typeof ai?.text === 'string' ? ai.text : '';

  // 该客户端的绝对时间基准：会话创建时的服务器时间 + 该客户端时钟偏移
  const baseMs = Date.parse(sess.started_at.replace(' ', 'T') + 'Z') + (sess.client_offset_ms || 0);

  // 幂等：同一片重传时先清旧记录
  await db
    .prepare('DELETE FROM transcript_segments WHERE session_id = ? AND chunk_seq = ?')
    .bind(sessionId, chunkSeq)
    .run();

  const stmts: D1PreparedStatement[] = [];
  const outSegments: Array<{ startMs: number; endMs: number; text: string }> = [];
  const dropped: string[] = [];

  const insertSql = `INSERT OR REPLACE INTO transcript_segments
      (id, session_id, room_id, user_id, character_id, character_name, chunk_seq, seg_index,
       start_ms, end_ms, abs_start_ms, abs_end_ms, text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  if (segments.length) {
    segments.forEach((seg, i) => {
      const text = (seg.text || '').trim();
      if (!text) return;
      if (isHallucination(text)) {
        dropped.push(text);
        return;
      }
      const s = Math.max(0, Math.round((seg.start ?? 0) * 1000));
      const e = Math.max(s, Math.round((seg.end ?? seg.start ?? 0) * 1000));
      stmts.push(
        db
          .prepare(insertSql)
          .bind(
            `${sessionId}-${chunkSeq}-${i}`,
            sessionId,
            code,
            userId,
            sess.character_id ?? null,
            sess.character_name ?? null,
            chunkSeq,
            i,
            startMs + s,
            startMs + e,
            baseMs + startMs + s,
            baseMs + startMs + e,
            text
          )
      );
      outSegments.push({ startMs: startMs + s, endMs: startMs + e, text });
    });
  } else if (fallbackText.trim() && !isHallucination(fallbackText.trim())) {
    const text = fallbackText.trim();
    stmts.push(
      db
        .prepare(insertSql)
        .bind(
          `${sessionId}-${chunkSeq}-0`,
          sessionId,
          code,
          userId,
          sess.character_id ?? null,
          sess.character_name ?? null,
          chunkSeq,
          0,
          startMs,
          startMs,
          baseMs + startMs,
          baseMs + startMs,
          text
        )
    );
    outSegments.push({ startMs, endMs: startMs, text });
  } else {
    // 转写成功但这一片没有有效语音：仍然记录一次尝试，避免前端重复补传
    console.info(`[transcript] chunk-empty room=${code} seq=${chunkSeq}`);
  }

  stmts.push(
    db
      .prepare(
        `UPDATE transcript_sessions
           SET chunk_count = chunk_count + 1,
               segment_count = segment_count + ?
         WHERE id = ?`
      )
      .bind(outSegments.length, sessionId)
  );

  if (dropped.length) {
    console.info(
      `[transcript] 丢弃疑似幻觉 room=${code} seq=${chunkSeq} n=${dropped.length} 样例=${dropped.join(' | ').slice(0, 120)}`
    );
  }

  if (stmts.length) await db.batch(stmts);

  // 实时推送：把这一片的转写结果广播给房间内所有人
  if (outSegments.length) {
    await notifyTranscriptUpdate(c.env, code, sess.character_name ?? null, outSegments);

    // 每约 2 分钟把「语音 + 游戏操作」汇总成一条事件摘要。
    // 用 waitUntil 不阻塞上传响应；失败只留痕，不影响已入库的转写结果。
    const p = maybeSummarize(c.env, code).catch((e) =>
      console.warn(
        `[summary] trigger-failed room=${code} err=${e instanceof Error ? e.message : String(e)}`
      )
    );
    try {
      c.executionCtx.waitUntil(p);
    } catch {
      // 无 executionCtx（如部分测试环境）时不等待，摘要会在下次触发时生成
    }
  }

  console.info(
    `[transcript] chunk room=${code} seq=${chunkSeq} bytes=${buf.byteLength} ai=${aiMs}ms segs=${outSegments.length}`
  );
  return c.json({ ok: true, chunkSeq, aiMs, bytes: buf.byteLength, segments: outSegments, rawText: fallbackText });
});

// ---- 停止记录 ----
route.post('/:code/transcript/session/:sessionId/stop', authMiddleware, async (c) => {
  const code = c.req.param('code');
  const sessionId = c.req.param('sessionId');
  const userId = c.get('userId');
  const db = c.env.DB;

  // 同 chunk：非成员先给 403，避免 404/403 语义不一致
  const member = await findMember(db, code, userId);
  if (!member) return c.json({ error: '你不在该房间中' }, 403);

  const r = await db
    .prepare(
      `UPDATE transcript_sessions SET status = 'done', ended_at = datetime('now')
       WHERE id = ? AND room_id = ? AND user_id = ?`
    )
    .bind(sessionId, code, userId)
    .run();
  if (!(r.meta?.changes ?? 0)) return c.json({ error: '会话不存在' }, 404);
  console.info(`[transcript] session-stop room=${code} session=${sessionId}`);
  return c.json({ ok: true });
});

// ---- 读取合并后的对话时间线 ----
route.get('/:code/transcript', authMiddleware, async (c) => {
  const code = c.req.param('code');
  const userId = c.get('userId');
  const db = c.env.DB;

  const member = await findMember(db, code, userId);
  if (!member) return c.json({ error: '你不在该房间中' }, 403);

  const rows = await db
    .prepare(
      `SELECT seg.id, seg.character_name, seg.abs_start_ms, seg.abs_end_ms, seg.text
       FROM transcript_segments seg
       WHERE seg.room_id = ?
       ORDER BY seg.abs_start_ms ASC, seg.seg_index ASC`
    )
    .bind(code)
    .all<{ id: string; character_name: string | null; abs_start_ms: number; abs_end_ms: number; text: string }>();

  const segments = (rows.results || []).map((r) => ({
    id: r.id,
    speaker: r.character_name || '(未知)',
    startMs: r.abs_start_ms,
    endMs: r.abs_end_ms,
    text: r.text,
  }));

  const sessions = await db
    .prepare(
      `SELECT id, character_name, user_id, started_at, ended_at, status, chunk_count, segment_count
       FROM transcript_sessions WHERE room_id = ? ORDER BY started_at ASC`
    )
    .bind(code)
    .all();

  return c.json({ segments, sessions: sessions.results || [] });
});

// ---- 事件摘要（每约 2 分钟由 LLM 汇总「语音 + 游戏操作」，替代逐句字幕展示） ----
route.get('/:code/summaries', authMiddleware, async (c) => {
  const code = c.req.param('code');
  const userId = c.get('userId');
  const db = c.env.DB;

  const member = await findMember(db, code, userId);
  if (!member) return c.json({ error: '你不在该房间中' }, 403);

  const rows = await db
    .prepare(
      `SELECT id, start_ms, end_ms, summary, source_segments, source_logs, created_at
       FROM room_summaries WHERE room_id = ? ORDER BY start_ms ASC LIMIT 500`
    )
    .bind(code)
    .all<{
      id: string;
      start_ms: number;
      end_ms: number;
      summary: string;
      source_segments: number;
      source_logs: number;
      created_at: string;
    }>();

  return c.json({
    summaries: (rows.results || []).map((r) => ({
      id: r.id,
      startMs: r.start_ms,
      endMs: r.end_ms,
      summary: r.summary,
      sourceSegments: r.source_segments,
      sourceLogs: r.source_logs,
      createdAt: r.created_at,
    })),
  });
});

// ---- 手动催一次摘要（GM 用；也便于验证链路） ----
route.post('/:code/summaries/run', authMiddleware, async (c) => {
  const code = c.req.param('code');
  const userId = c.get('userId');
  const db = c.env.DB;

  const member = await findMember(db, code, userId);
  if (!member) return c.json({ error: '你不在该房间中' }, 403);

  const result = await maybeSummarize(c.env, code);
  console.info(
    `[summary] manual room=${code} user=${userId} result=${JSON.stringify(result).slice(0, 180)}`
  );
  return c.json(result);
});

// ---- 房间词表（成员可读，GM 可写） ----
route.get('/:code/transcript/glossary', authMiddleware, async (c) => {
  const code = c.req.param('code');
  const db = c.env.DB;
  const member = await findMember(db, code, c.get('userId'));
  if (!member) return c.json({ error: '你不在该房间中' }, 403);

  const gl = await db
    .prepare('SELECT extra_terms FROM transcript_glossary WHERE room_id = ?')
    .bind(code)
    .first<{ extra_terms: string }>();

  return c.json({ extraTerms: gl?.extra_terms || '', prompt: await buildPrompt(db, code) });
});

route.put('/:code/transcript/glossary', authMiddleware, async (c) => {
  const code = c.req.param('code');
  const userId = c.get('userId');
  const db = c.env.DB;

  const gm = await db
    .prepare(`SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ? AND role = 'gm'`)
    .bind(code, userId)
    .first();
  if (!gm) return c.json({ error: '只有 GM 可以维护词表' }, 403);

  const body = (await c.req.json().catch(() => ({}))) as { extraTerms?: string };
  const extra = typeof body.extraTerms === 'string' ? body.extraTerms.slice(0, 500) : '';

  await db
    .prepare(
      `INSERT INTO transcript_glossary (room_id, extra_terms, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(room_id) DO UPDATE SET extra_terms = excluded.extra_terms, updated_at = datetime('now')`
    )
    .bind(code, extra)
    .run();

  console.info(`[transcript] glossary-update room=${code} len=${extra.length}`);
  return c.json({ ok: true, extraTerms: extra });
});

export default route;
