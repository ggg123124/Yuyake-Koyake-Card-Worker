import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth';
import { Bindings, Variables } from '../types';

const route = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// 辅助函数：校验当前用户是否是房间 GM
async function checkGM(db: D1Database, roomId: string, userId: string): Promise<boolean> {
  const room = await db
    .prepare('SELECT gm_user_id FROM rooms WHERE id = ?')
    .bind(roomId)
    .first<{ gm_user_id: string }>();
  return room !== null && room.gm_user_id === userId;
}

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

  // 检查是否已在房间中
  const existingMember = await db
    .prepare('SELECT character_id FROM room_members WHERE room_id = ? AND character_id = ?')
    .bind(roomId, characterId)
    .first();
  if (existingMember) {
    return c.json({ error: '该角色已在房间中' }, 409);
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

// GET /:code - 获取房间信息
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
             c.id as char_id, c.name, c.true_form, c.attr_henge, c.attr_animal, c.attr_adult, c.attr_child
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
      attr_henge: number;
      attr_animal: number;
      attr_adult: number;
      attr_child: number;
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
        attrHenge: m.attr_henge,
        attrAnimal: m.attr_animal,
        attrAdult: m.attr_adult,
        attrChild: m.attr_child,
      },
    })),
  });
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
    .prepare('SELECT character_id FROM room_members WHERE room_id = ? AND character_id = ?')
    .bind(roomId, characterId)
    .first();
  if (!member) {
    return c.json({ error: '该角色不在此房间中' }, 404);
  }

  await db
    .prepare('DELETE FROM room_members WHERE room_id = ? AND character_id = ?')
    .bind(roomId, characterId)
    .run();

  return c.json({ success: true });
});

// GET /:code/poll - 轮询房间变更
route.get('/:code/poll', authMiddleware, async (c) => {
  const roomId = c.req.param('code');
  const since = c.req.query('since');
  const userId = c.get('userId');

  if (!since) {
    return c.json({ error: '缺少 since 参数' }, 400);
  }

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
    return c.json({ error: '只有房间成员可以查看房间信息' }, 403);
  }

  const bonds = await db
    .prepare('SELECT * FROM bonds WHERE room_id = ? AND updated_at > ?')
    .bind(roomId, since)
    .all();

  return c.json({
    roomId,
    since,
    bonds: bonds.results || [],
  });
});

// POST /:code/give-dream - GM 发放梦点数
route.post('/:code/give-dream', authMiddleware, async (c) => {
  const roomId = c.req.param('code');
  const body = await c.req.json<{ characterId?: string; amount?: number }>();
  const { characterId, amount } = body;
  const userId = c.get('userId');

  if (!characterId || typeof characterId !== 'string') {
    return c.json({ error: '角色卡ID不能为空' }, 400);
  }
  if (typeof amount !== 'number' || amount <= 0 || !Number.isInteger(amount)) {
    return c.json({ error: '梦点数必须是正整数' }, 400);
  }

  const db = c.env.DB;

  // 校验房间成员身份
  const isMember = await isRoomMember(db, roomId, userId);
  if (!isMember) {
    return c.json({ error: '只有房间成员可以执行此操作' }, 403);
  }

  // 校验 GM
  const isGM = await checkGM(db, roomId, userId);
  if (!isGM) {
    return c.json({ error: '只有 GM 可以发放梦点' }, 403);
  }

  // 检查角色是否在房间中
  const targetMember = await db
    .prepare('SELECT character_id FROM room_members WHERE room_id = ? AND character_id = ?')
    .bind(roomId, characterId)
    .first();
  if (!targetMember) {
    return c.json({ error: '该角色不在此房间中' }, 404);
  }

  // 更新梦点数
  await db
    .prepare(
      "UPDATE characters SET dream_points = dream_points + ?, updated_at = datetime('now') WHERE id = ?"
    )
    .bind(amount, characterId)
    .run();

  // 获取更新后的梦点数
  const updated = await db
    .prepare('SELECT dream_points FROM characters WHERE id = ?')
    .bind(characterId)
    .first<{ dream_points: number }>();

  return c.json({
    characterId,
    added: amount,
    dreamPoints: updated?.dream_points,
  });
});

// POST /:code/set-phase - GM 设置场景阶段
route.post('/:code/set-phase', authMiddleware, async (c) => {
  const roomId = c.req.param('code');
  const body = await c.req.json<{ phase?: string }>();
  const { phase } = body;
  const userId = c.get('userId');

  if (!phase || !['scene', 'intermission', 'ending'].includes(phase)) {
    return c.json({ error: '阶段必须是 scene、intermission 或 ending' }, 400);
  }

  const db = c.env.DB;

  // 校验房间成员身份
  const isMember = await isRoomMember(db, roomId, userId);
  if (!isMember) {
    return c.json({ error: '只有房间成员可以执行此操作' }, 403);
  }

  const isGM = await checkGM(db, roomId, userId);
  if (!isGM) {
    return c.json({ error: '只有 GM 可以设置场景阶段' }, 403);
  }

  await db.prepare('UPDATE rooms SET phase = ? WHERE id = ?').bind(phase, roomId).run();

  return c.json({
    roomId,
    phase,
  });
});

// PUT /:code/role - GM 调整成员角色
route.put('/:code/role', authMiddleware, async (c) => {
  const roomId = c.req.param('code');
  const body = await c.req.json<{ characterId?: string; role?: string }>();
  const { characterId, role } = body;
  const userId = c.get('userId');

  if (!characterId || typeof characterId !== 'string') {
    return c.json({ error: '角色卡ID不能为空' }, 400);
  }
  if (!role || (role !== 'gm' && role !== 'player')) {
    return c.json({ error: '角色必须是 gm 或 player' }, 400);
  }

  const db = c.env.DB;

  // 校验房间成员身份
  const isMember = await isRoomMember(db, roomId, userId);
  if (!isMember) {
    return c.json({ error: '只有房间成员可以执行此操作' }, 403);
  }

  const isGM = await checkGM(db, roomId, userId);
  if (!isGM) {
    return c.json({ error: '只有 GM 可以调整成员角色' }, 403);
  }

  // 检查成员是否在房间中
  const targetMember = await db
    .prepare('SELECT character_id FROM room_members WHERE room_id = ? AND character_id = ?')
    .bind(roomId, characterId)
    .first();
  if (!targetMember) {
    return c.json({ error: '该角色不在此房间中' }, 404);
  }

  await db
    .prepare('UPDATE room_members SET role = ? WHERE room_id = ? AND character_id = ?')
    .bind(role, roomId, characterId)
    .run();

  return c.json({
    roomId,
    characterId,
    role,
  });
});

export default route;
