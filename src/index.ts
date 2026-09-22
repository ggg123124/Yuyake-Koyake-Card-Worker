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

export { RoomDurableObject };

export default {
  fetch: app.fetch.bind(app),
  scheduled: (event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) => {
    ctx.waitUntil(handleScheduled(env));
  },
};
