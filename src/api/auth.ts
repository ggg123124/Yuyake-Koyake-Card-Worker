import { Hono } from 'hono';
import { hashPassword, verifyPassword, generateToken } from '../utils/auth';
import { authMiddleware } from '../middleware/auth';
import { Bindings, Variables } from '../types';

const route = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// POST /register
route.post('/register', async (c) => {
  const body = await c.req.json<{
    username?: string;
    password?: string;
    displayName?: string;
  }>();

  const { username, password, displayName } = body;

  // 验证参数
  if (!username || typeof username !== 'string') {
    return c.json({ error: '用户名不能为空' }, 400);
  }
  if (!password || typeof password !== 'string') {
    return c.json({ error: '密码不能为空' }, 400);
  }

  // 验证用户名长度
  if (username.length < 3 || username.length > 20) {
    return c.json({ error: '用户名长度必须在 3-20 字符之间' }, 400);
  }

  // 验证密码长度
  if (password.length < 6 || password.length > 50) {
    return c.json({ error: '密码长度必须在 6-50 字符之间' }, 400);
  }

  const db = c.env.DB;

  // 检查用户名唯一性
  const existing = await db
    .prepare('SELECT id FROM users WHERE username = ?')
    .bind(username)
    .first();

  if (existing) {
    return c.json({ error: '用户名已被注册' }, 409);
  }

  // 生成 UUID 和密码哈希
  const userId = crypto.randomUUID();
  const passwordHash = await hashPassword(password);
  const finalDisplayName = displayName?.trim() || username;

  // 插入用户
  await db
    .prepare(
      'INSERT INTO users (id, username, password_hash, display_name) VALUES (?, ?, ?, ?)'
    )
    .bind(userId, username, passwordHash, finalDisplayName)
    .run();

  // 生成 token
  const token = await generateToken(
    { userId, username },
    c.env.JWT_SECRET
  );

  return c.json(
    {
      token,
      user: {
        id: userId,
        username,
        displayName: finalDisplayName,
      },
    },
    201
  );
});

// POST /login
route.post('/login', async (c) => {
  const body = await c.req.json<{
    username?: string;
    password?: string;
  }>();

  const { username, password } = body;

  if (!username || typeof username !== 'string') {
    return c.json({ error: '用户名不能为空' }, 400);
  }
  if (!password || typeof password !== 'string') {
    return c.json({ error: '密码不能为空' }, 400);
  }

  const db = c.env.DB;

  // 查询用户
  const user = await db
    .prepare(
      'SELECT id, username, password_hash, display_name FROM users WHERE username = ?'
    )
    .bind(username)
    .first<{
      id: string;
      username: string;
      password_hash: string;
      display_name: string;
    }>();

  if (!user) {
    return c.json({ error: '用户名或密码错误' }, 401);
  }

  // 验证密码
  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    return c.json({ error: '用户名或密码错误' }, 401);
  }

  // 生成 token
  const token = await generateToken(
    { userId: user.id, username: user.username },
    c.env.JWT_SECRET
  );

  return c.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
    },
  });
});

// GET /me
route.get('/me', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;

  const user = await db
    .prepare(
      'SELECT id, username, display_name FROM users WHERE id = ?'
    )
    .bind(userId)
    .first<{
      id: string;
      username: string;
      display_name: string;
    }>();

  if (!user) {
    return c.json({ error: '用户不存在' }, 404);
  }

  return c.json({
    id: user.id,
    username: user.username,
    displayName: user.display_name,
  });
});

export default route;
