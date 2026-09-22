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
import { maybeSummarize } from './api/summarize';

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
async function sweepSummaries(env: Bindings) {
  const since = Date.now() - 10 * 60 * 1000; // 最近 10 分钟内有转写的房间
  // JOIN rooms：房间销毁后其转写原始数据仍留在库中（内容已进归档快照），
  // 若不限定房间仍存在，sweep 会对着已销毁房间反复生成摘要。
  const rows = await env.DB.prepare(
    `SELECT DISTINCT ts.room_id AS room_id
     FROM transcript_segments ts
     JOIN rooms r ON r.id = ts.room_id
     WHERE ts.abs_start_ms >= ? LIMIT 50`
  )
    .bind(since)
    .all<{ room_id: string }>();

  const rooms = rows.results || [];
  // 每次执行都留痕：否则「cron 到底跑没跑」无从判断（本项目禁用静默路径）
  console.info(`[summary] sweep 扫描到 ${rooms.length} 个活跃房间（近 10 分钟有转写且仍存在）`);
  if (!rooms.length) return;

  for (const r of rooms) {
    try {
      const res = await maybeSummarize(env, r.room_id);
      if (res.ok && !res.skipped) {
        console.info(
          `[summary] sweep room=${r.room_id} segs=${res.segments} logs=${res.logs} latency=${res.latencyMs}ms`
        );
      } else if (!res.ok) {
        console.warn(`[summary] sweep-failed room=${r.room_id} err=${res.error}`);
      }
    } catch (e) {
      console.warn(
        `[summary] sweep-error room=${r.room_id} err=${e instanceof Error ? e.message : String(e)}`
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
    // 其余（每分钟）：兜底补摘要
    ctx.waitUntil(sweepSummaries(env));
  },
};
