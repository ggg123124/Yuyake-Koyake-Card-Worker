import { MiddlewareHandler } from 'hono';
import { verifyToken } from '../utils/auth';
import { Bindings, Variables } from '../types';

/**
 * JWT 认证中间件
 * 从 Authorization header 提取 Bearer token
 * 验证后将 userId 和 username 注入 context 变量
 */
export const authMiddleware: MiddlewareHandler<{
  Bindings: Bindings;
  Variables: Variables;
}> = async (c, next) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: '未提供认证令牌' }, 401);
  }

  const token = authHeader.slice(7);
  const secret = c.env.JWT_SECRET;

  const payload = await verifyToken(token, secret);
  if (!payload) {
    return c.json({ error: '认证令牌无效或已过期' }, 401);
  }

  c.set('userId', payload.userId);
  c.set('username', payload.username);

  await next();
};
