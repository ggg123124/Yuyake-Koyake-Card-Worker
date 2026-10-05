import { Hono } from 'hono';
import { cors } from 'hono/cors';

import authRoute from './api/auth';
import charactersRoute from './api/characters';
import roomsRoute from './api/rooms';
import bondsRoute from './api/bonds';
import calculateRoute from './api/calculate';
import inventoryRoute from './api/inventory';
import archivesRoute from './api/archives';
import transcriptRoute from './api/transcript';
import { Bindings } from './types';
import { RoomDurableObject } from './room-do';
import { archiveAndDeleteRoom } from './api/archives';
import { MAX_WINDOW_MS, maybeSummarize } from './api/summarize';

const app = new Hono<{ Bindings: Bindings }>();

app.onError((err, c) => {
  if (
    err instanceof SyntaxError ||
    /JSON|Unexpected token/i.test(err.message)
  ) {
    return c.json({ error: '请求体不是合法的 JSON' }, 400);
  }
  console.error('[error] %s %s', c.req.method, c.req.path, err);
  return c.json({ error: '服务器内部错误' }, 500);
});

app.use('*', cors());

// API 路由
app.route('/api/auth', authRoute);
app.route('/api/characters', charactersRoute);
app.route('/api/rooms', transcriptRoute);
app.route('/api/rooms', roomsRoute);
app.route('/api/bonds', bondsRoute);
app.route('/api/archives', archivesRoute);

app.get('/api/health', (c) => c.json({ status: 'ok' }));
app.route('/api/calculate', calculateRoute);
app.route('/api/inventory', inventoryRoute);

async function handleScheduled(env: Bindings): Promise<void> {
  const db = env.DB;

  const stale = await db
    .prepare(
      `SELECT r.id FROM rooms r
       WHERE COALESCE(r.last_active_at, r.created_at) < datetime('now','-30 days')
         AND NOT EXISTS (SELECT 1 FROM room_members WHERE room_id = r.id)`
    )
    .all<{ id: string }>();

  const rooms = stale.results || [];

  for (const room of rooms) {
    try {
      const result = await archiveAndDeleteRoom(db, room.id, {
        archivedBy: null,
        reason: 'auto_inactive',
      });
      if (result) {
        console.log(`[cleanup] archived room=${room.id}`);
      } else {
        console.info(`[cleanup] skip room=${room.id} reason=already-removed`);
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.warn(`[cleanup] failed room=${room.id} err=${errMsg}`);
    }
  }
}

// 每分钟兜底：为最近有转写活动的房间生成摘要。
// 为什么不只靠请求内的 waitUntil：实测转写上传响应返回后，后台任务存在被回收而丢失的情况
// （同一房间、同样素材，一次成功一次没生成）。定时任务不依赖任何浏览器或前台请求的生命周期。

// —— sweep 选房 SQL ——
// 这两条语句被 test/sweep-room-selection.test.ts 从本文件原文提取，拿到用 schema.sql 建的真实
// SQLite 库上跑（选房结果 + EXPLAIN QUERY PLAN 都是实测断言）。marker 之间只放这两条语句。
/* SWEEP_SQL_START */
// ① 活跃房：近 10 分钟有转写素材入库。
//
// 选房条件按「素材到达时间」而非 abs_start_ms：abs_start_ms 曾是客户端压缩过的时间基准，
// 会漏掉仍活跃的房间（线上实测开团期间 scanned 反复为 0）。created_at 是素材真正入库的墙钟时间，不受该 bug 影响。
// 不能改成按 rooms.last_active_at 选房：那会漏掉「只在录音、没别的动作」的房间。
//
// INDEXED BY 是必须的，不是装饰：光建了 idx_ts_segments_created 不够，实测（本地库 EXPLAIN QUERY PLAN）
// SQLite 仍会选 `SCAN ts USING INDEX idx_ts_segments_room_end` —— 因为那条索引按 room_id 有序，
// 能让 DISTINCT 白拿一次免排序，代价是把整张 transcript_segments 扫一遍（线上 2468 行/次）。
// 加 INDEXED BY 后计划变成 `SEARCH ts USING INDEX idx_ts_segments_created (created_at>?)`，
// 只读近 10 分钟那一段。索引若被删，SQLite 会在 prepare 阶段直接报 no such index（响亮失败，不静默降级）。
//
// JOIN rooms：房间销毁后其转写原始数据仍留在库中（内容已进归档快照），
// 若不限定房间仍存在，sweep 会对着已销毁房间反复生成摘要。
// r.summary_enabled = 1：摘要开关关掉的房间根本不进循环（否则每 2 分钟白烧一整轮水位/素材查询）。
export const SWEEP_ACTIVE_ROOMS_SQL = `SELECT DISTINCT ts.room_id AS room_id
 FROM transcript_segments AS ts INDEXED BY idx_ts_segments_created
 JOIN rooms r ON r.id = ts.room_id
 WHERE ts.created_at >= datetime('now','-10 minutes')
   AND r.summary_enabled = 1 LIMIT 50`;

// ② 积压未追平房：开关开启，且摘要锚点（已有摘要的最大 end_ms）落后素材水位（最大 abs_end_ms）
// 超过 MAX_WINDOW_MS —— 单条摘要最长就覆盖一个窗口，落后超过它意味着「还有素材没被任何窗口盖住」。
//
// 为什么光有 ① 不够（线上实测）：房间 SVS3C 追补跑到一半（锚点 15:49、水位 16:16）后跑团结束，
// 不再有素材入库 ⇒ created_at 条件再也命中不了它，房间从候选里消失，最后约 27 分钟素材永远补不上
// （除非该房下次有人录音才被重新选中）。① 只看「素材在流」，② 看「账还没结清」。
//
// 成本：rooms 只有几十行（SCAN rooms 可接受）；两个相关子查询都必须走索引，实测计划是
// `SEARCH t USING COVERING INDEX idx_ts_segments_room_end (room_id=?)` 与
// `SEARCH s USING INDEX uniq_summary_window (room_id=?)`，不存在对两张大表的 SCAN。
// 无素材的房间 MAX 为 NULL，NULL > x 恒不成立 ⇒ 不会被选中（与 ① 一致：没素材就不该摘要）。
export const SWEEP_BACKLOG_ROOMS_SQL = `SELECT r.id AS room_id
 FROM rooms r
 WHERE r.summary_enabled = 1
   AND (SELECT MAX(t.abs_end_ms) FROM transcript_segments t WHERE t.room_id = r.id) >
       COALESCE((SELECT MAX(s.end_ms) FROM room_summaries s WHERE s.room_id = r.id), 0) + ${MAX_WINDOW_MS}
 LIMIT 50`;
/* SWEEP_SQL_END */

async function sweepSummaries(env: Bindings) {
  const sinceNote = "ts.created_at >= datetime('now','-10 minutes') AND r.summary_enabled = 1";
  const backlogNote = `anchor + ${MAX_WINDOW_MS} < watermark (summary_enabled=1)`;

  const activeRows = await env.DB.prepare(SWEEP_ACTIVE_ROOMS_SQL).all<{ room_id: string }>();
  const backlogRows = await env.DB.prepare(SWEEP_BACKLOG_ROOMS_SQL).all<{ room_id: string }>();

  // 去重：一个房间可以同时「正在录」又「有积压」，两类来源都命中它时只追补一遍
  // （追补是 catchUp 多窗推进，跑两次等于同一批素材白烧一次 AI 花费）。
  const activeIds = (activeRows.results || []).map((r) => r.room_id);
  const backlogIds = (backlogRows.results || []).map((r) => r.room_id);
  const roomIds = [...new Set([...activeIds, ...backlogIds])];

  // 每次执行都写心跳：wrangler tail 不展示 scheduled 事件，只有写进库才能确认
  // 「cron 到底有没有被触发」这个关键事实（本项目禁用无从核查的静默路径）。
  try {
    await env.DB.prepare('INSERT INTO cron_heartbeat (job, scanned, note) VALUES (?, ?, ?)')
      .bind(
        'sweep-summaries',
        roomIds.length,
        `active=${activeIds.length}(${sinceNote}) backlog=${backlogIds.length}(${backlogNote})`
      )
      .run();
  } catch (e) {
    console.warn(`[summary] heartbeat-failed err=${e instanceof Error ? e.message : String(e)}`);
  }
  console.info(
    `[summary] sweep 活跃房 ${activeIds.length} 个 / 积压未追平房 ${backlogIds.length} 个（去重后 ${roomIds.length} 个）`
  );
  if (!roomIds.length) return;

  for (const roomId of roomIds) {
    try {
      // catchUp：cron 是积压补录的驱动源（每 2 分钟一轮），一次调用沿素材连续推进多个窗口，
      // 否则锚点落后几天时要跑上百轮才补得完。前端催 / 手动 run 仍是单窗口，不走这里。
      const res = await maybeSummarize(env, roomId, { catchUp: true });
      // 判定按 windows 而非 skipped：追补一轮里常见「前几个窗口落库、最后一个窗口 skip」，
      // 此时 skipped 有值但确实补出了摘要，用旧判定会整条静默。
      // 每窗的 segs/logs/latency 已由 summarizeOneWindow 打过，这里只报本轮汇总。
      if (res.windows) {
        console.info(
          `[summary] sweep room=${roomId} windows=${res.windows} remainingMs=${res.remainingMs}`
        );
      }
      if (!res.ok) {
        console.warn(`[summary] sweep-failed room=${roomId} err=${res.error}`);
      }
    } catch (e) {
      console.warn(
        `[summary] sweep-error room=${roomId} err=${e instanceof Error ? e.message : String(e)}`
      );
    }
  }
}

export { RoomDurableObject };

export default {
  fetch: app.fetch.bind(app),
  scheduled: (event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) => {
    // 每天 20:00 UTC：清理超期且无成员的房间（先归档再删除）
    if (event.cron === '0 20 * * *') {
      ctx.waitUntil(handleScheduled(env));
      return;
    }
    // 其余（每 2 分钟，带步长写法，与摘要窗口一致）：兜底补摘要
    ctx.waitUntil(sweepSummaries(env));
  },
};
