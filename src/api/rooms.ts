import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth';
import { verifyToken } from '../utils/auth';
import { Bindings, Variables } from '../types';

const route = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// 辅助函数：校验当前用户是否是房间成员
async function isRoomMember(db: D1Database, roomId: string, userId: string): Promise<boolean> {
  const member = await db
    .prepare('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?')
    .bind(roomId, userId)
    .first();
  return !!member;
}

// POST / - 创建房间
route.post('/', authMiddleware, async (c) => {
  const body = await c.req.json<{ id?: string; name?: string }>();
  const { id, name } = body;
  const userId = c.get('userId');

  if (!id || typeof id !== 'string') {
    return c.json({ error: '房间代码不能为空' }, 400);
  }

  const db = c.env.DB;

  // 检查房间代码是否已存在
  const existing = await db
    .prepare('SELECT id FROM rooms WHERE id = ?')
    .bind(id)
    .first();
  if (existing) {
    return c.json({ error: '房间代码已存在' }, 409);
  }

  await db
    .prepare('INSERT INTO rooms (id, name, gm_user_id, phase) VALUES (?, ?, ?, ?)')
    .bind(id, name || null, userId, 'scene')
    .run();

  return c.json(
    {
      id,
      name: name || null,
      gmUserId: userId,
      phase: 'scene',
    },
    201
  );
});

// POST /:code/join - 加入房间
route.post('/:code/join', authMiddleware, async (c) => {
  const roomId = c.req.param('code');
  const body = await c.req.json<{ characterId?: string }>();
  const { characterId } = body;
  const userId = c.get('userId');

  if (!characterId || typeof characterId !== 'string') {
    return c.json({ error: '角色卡ID不能为空' }, 400);
  }

  const db = c.env.DB;

  // 校验角色卡属于当前用户
  const character = await db
    .prepare('SELECT id, user_id FROM characters WHERE id = ?')
    .bind(characterId)
    .first<{ id: string; user_id: string }>();

  if (!character) {
    return c.json({ error: '角色卡不存在' }, 404);
  }
  if (character.user_id !== userId) {
    return c.json({ error: '无权使用该角色卡' }, 403);
  }

  // 检查房间是否存在
  const room = await db
    .prepare('SELECT id, gm_user_id FROM rooms WHERE id = ?')
    .bind(roomId)
    .first<{ id: string; gm_user_id: string }>();
  if (!room) {
    return c.json({ error: '房间不存在' }, 404);
  }

  // 检查是否已在房间中（重新加入时视为成功）
  const existingMember = await db
    .prepare('SELECT character_id, role FROM room_members WHERE room_id = ? AND character_id = ?')
    .bind(roomId, characterId)
    .first<{ character_id: string; role: string }>();
  if (existingMember) {
    return c.json({
      roomId,
      characterId,
      role: existingMember.role,
    });
  }

  // 确定角色：如果创建者加入，role = 'gm'，否则 'player'
  const role = room.gm_user_id === userId ? 'gm' : 'player';

  await db
    .prepare('INSERT INTO room_members (room_id, character_id, user_id, role) VALUES (?, ?, ?, ?)')
    .bind(roomId, characterId, userId, role)
    .run();

  return c.json({
    roomId,
    characterId,
    role,
  });
});

// GET /:code - 获取房间信息（初始加载用）
route.get('/:code', authMiddleware, async (c) => {
  const roomId = c.req.param('code');
  const db = c.env.DB;
  const userId = c.get('userId');

  const room = await db
    .prepare('SELECT id, name, gm_user_id, phase, created_at FROM rooms WHERE id = ?')
    .bind(roomId)
    .first<{
      id: string;
      name: string | null;
      gm_user_id: string;
      phase: string;
      created_at: string;
    }>();

  if (!room) {
    return c.json({ error: '房间不存在' }, 404);
  }

  // 校验当前用户是否是房间成员或 GM
  const member = await isRoomMember(db, roomId, userId);
  const isGm = room.gm_user_id === userId;
  if (!member && !isGm) {
    return c.json({ error: '只有房间成员可以查看房间信息' }, 403);
  }

  // 获取成员列表
  const members = await db
    .prepare(
      `
      SELECT rm.character_id, rm.user_id, rm.role, rm.joined_at,
             c.id as char_id, c.name, c.true_form, c.human_appearance, c.true_appearance, c.attr_henge, c.attr_animal, c.attr_adult, c.attr_child,
             c.dream_points, c.wonder_points, c.feeling_points, c.weaknesses, c.abilities, c.extra_abilities
      FROM room_members rm
      JOIN characters c ON rm.character_id = c.id
      WHERE rm.room_id = ?
      `
    )
    .bind(roomId)
    .all<{
      character_id: string;
      user_id: string;
      role: string;
      joined_at: string;
      char_id: string;
      name: string;
      true_form: string;
      human_appearance: string | null;
      true_appearance: string | null;
      attr_henge: number;
      attr_animal: number;
      attr_adult: number;
      attr_child: number;
      dream_points: number;
      wonder_points: number;
      feeling_points: number;
      weaknesses: string | null;
      abilities: string | null;
      extra_abilities: string | null;
    }>();

  return c.json({
    id: room.id,
    name: room.name,
    gmUserId: room.gm_user_id,
    phase: room.phase,
    createdAt: room.created_at,
    members: (members.results || []).map((m) => ({
      characterId: m.character_id,
      userId: m.user_id,
      role: m.role,
      joinedAt: m.joined_at,
      character: {
        id: m.char_id,
        name: m.name,
        trueForm: m.true_form,
        humanAppearance: m.human_appearance,
        trueAppearance: m.true_appearance,
        attrHenge: m.attr_henge,
        attrAnimal: m.attr_animal,
        attrAdult: m.attr_adult,
        attrChild: m.attr_child,
        dreamPoints: m.dream_points,
        wonderPoints: m.wonder_points,
        feelingPoints: m.feeling_points,
        weaknesses: m.weaknesses,
        abilities: m.abilities,
        extraAbilities: m.extra_abilities,
      },
    })),
  });
});

// GET /:code/ws - WebSocket 升级（实时通信）
route.get('/:code/ws', async (c) => {
  const roomId = c.req.param('code');

  // 从 query param 获取 token（WebSocket 不支持自定义 header）
  const url = new URL(c.req.url);
  const token = url.searchParams.get('token');
  const characterId = url.searchParams.get('characterId');

  if (!token || !characterId) {
    return c.json({ error: '缺少 token 或 characterId 参数' }, 401);
  }

  // 验证 JWT
  const payload = await verifyToken(token, c.env.JWT_SECRET);
  if (!payload) {
    return c.json({ error: '认证令牌无效或已过期' }, 401);
  }

  // 验证房间成员身份
  const db = c.env.DB;
  const member = await db
    .prepare('SELECT character_id FROM room_members WHERE room_id = ? AND character_id = ?')
    .bind(roomId, characterId)
    .first();
  if (!member) {
    // 也检查是否是 GM
    const room = await db
      .prepare('SELECT gm_user_id FROM rooms WHERE id = ?')
      .bind(roomId)
      .first<{ gm_user_id: string }>();
    if (!room || room.gm_user_id !== payload.userId) {
      return c.json({ error: '只有房间成员可以连接' }, 403);
    }
  }

  // 检查 WebSocket 升级头
  const upgradeHeader = c.req.header('Upgrade');
  if (!upgradeHeader || upgradeHeader !== 'websocket') {
    return c.json({ error: '期望 WebSocket 升级请求' }, 426);
  }

  // 获取对应的 Durable Object
  const id = c.env.ROOM_DO.idFromName(roomId);
  const stub = c.env.ROOM_DO.get(id);

  // 将认证信息通过 header 传递给 DO
  const newRequest = new Request(c.req.raw, {
    headers: new Headers({
      ...Object.fromEntries(c.req.raw.headers.entries()),
      'X-User-Id': payload.userId,
      'X-Character-Id': characterId,
      'X-Room-Id': roomId,
    }),
  });

  return stub.fetch(newRequest);
});

// POST /:code/leave - 离开房间
route.post('/:code/leave', authMiddleware, async (c) => {
  const roomId = c.req.param('code');
  const body = await c.req.json<{ characterId?: string }>();
  const { characterId } = body;
  const userId = c.get('userId');

  if (!characterId || typeof characterId !== 'string') {
    return c.json({ error: '角色卡ID不能为空' }, 400);
  }

  const db = c.env.DB;

  // 校验角色卡属于当前用户
  const character = await db
    .prepare('SELECT user_id FROM characters WHERE id = ?')
    .bind(characterId)
    .first<{ user_id: string }>();
  if (!character) {
    return c.json({ error: '角色卡不存在' }, 404);
  }
  if (character.user_id !== userId) {
    return c.json({ error: '无权操作该角色卡' }, 403);
  }

  // 检查是否在房间中
  const member = await db
    .prepare('SELECT character_id, role FROM room_members WHERE room_id = ? AND character_id = ?')
    .bind(roomId, characterId)
    .first<{ character_id: string; role: string }>();
  if (!member) {
    return c.json({ error: '该角色不在此房间中' }, 404);
  }

  // 如果是 GM，检查是否是最后一个 GM
  if (member.role === 'gm') {
    const gmCount = await db
      .prepare('SELECT COUNT(*) as cnt FROM room_members WHERE room_id = ? AND role = ?')
      .bind(roomId, 'gm')
      .first<{ cnt: number }>();
    if (gmCount && gmCount.cnt <= 1) {
      return c.json({ error: '房间至少需要保留一个GM，无法离开' }, 400);
    }
  }

  await db
    .prepare('DELETE FROM room_members WHERE room_id = ? AND character_id = ?')
    .bind(roomId, characterId)
    .run();

  return c.json({ success: true });
});

// GET /:code/resource-logs - 获取房间资源日志
route.get('/:code/resource-logs', authMiddleware, async (c) => {
  const roomId = c.req.param('code');
  const userId = c.get('userId');
  const db = c.env.DB;

  // 校验房间存在
  const room = await db
    .prepare('SELECT id, gm_user_id FROM rooms WHERE id = ?')
    .bind(roomId)
    .first<{ id: string; gm_user_id: string }>();
  if (!room) {
    return c.json({ error: '房间不存在' }, 404);
  }

  // 校验当前用户是否是房间成员或 GM
  const member = await isRoomMember(db, roomId, userId);
  const isGm = room.gm_user_id === userId;
  if (!member && !isGm) {
    return c.json({ error: '只有房间成员可以查看资源日志' }, 403);
  }

  // 查询资源日志，关联角色名称，按时间倒序
  let logs: {
    id: number;
    character_name: string;
    resource_type: string;
    change_amount: number;
    reason: string | null;
    created_at: string;
  }[] = [];

  try {
    const result = await db
      .prepare(
        `
        SELECT rl.id, c.name as character_name, rl.resource_type, rl.change_amount, rl.reason, rl.created_at
        FROM resource_logs rl
        JOIN characters c ON rl.character_id = c.id
        WHERE rl.room_code = ?
        ORDER BY rl.created_at DESC
        `
      )
      .bind(roomId)
      .all<{
        id: number;
        character_name: string;
        resource_type: string;
        change_amount: number;
        reason: string | null;
        created_at: string;
      }>();
    logs = result.results || [];
  } catch (e) {
    console.error('查询 resource_logs 失败:', e);
  }

  return c.json({
    logs: logs.map((l) => ({
      id: l.id,
      character_name: l.character_name,
      resource_type: l.resource_type,
      change_amount: l.change_amount,
      reason: l.reason,
      created_at: l.created_at,
    })),
  });
});

export default route;
