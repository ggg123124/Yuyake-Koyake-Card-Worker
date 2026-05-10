import { Hono } from 'hono';
import { cors } from 'hono/cors';

import authRoute from './api/auth';
import charactersRoute from './api/characters';
import roomsRoute from './api/rooms';
import bondsRoute from './api/bonds';
import calculateRoute from './api/calculate';
import { Bindings } from './types';
import { RoomDurableObject } from './room-do';

const app = new Hono<{ Bindings: Bindings }>();

app.use('*', cors());

// API 路由
app.route('/api/auth', authRoute);
app.route('/api/characters', charactersRoute);
app.route('/api/rooms', roomsRoute);
app.route('/api/bonds', bondsRoute);

app.get('/api/health', (c) => c.json({ status: 'ok' }));
app.route('/api/calculate', calculateRoute);

export { RoomDurableObject };
export default app;
