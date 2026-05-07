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
             c.id as char_id, c.name, c.true_form, c.attr_henge, c.attr_animal, c.attr_adult, c.attr_child,
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

  // 插入资源日志（容错：表不存在时不影响主流程）
  try {
    await db.prepare('INSERT INTO resource_logs (room_code, character_id, resource_type, change_amount, reason) VALUES (?, ?, ?, ?, ?)')
      .bind(roomId, characterId, 'dream', amount, 'GM赠送').run();
  } catch (e) {
    console.error('写入 resource_logs 失败:', e);
  }

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

// POST /:code/give-dream-player - 玩家赠送梦点（发起方不扣除，目标方直接增加）
route.post('/:code/give-dream-player', authMiddleware, async (c) => {
  const roomId = c.req.param('code');
  const body = await c.req.json<{ fromCharacterId?: string; toCharacterId?: string; amount?: number }>();
  const { fromCharacterId, toCharacterId, amount } = body;
  const userId = c.get('userId');

  if (!fromCharacterId || typeof fromCharacterId !== 'string') {
    return c.json({ error: '发起方角色卡ID不能为空' }, 400);
  }
  if (!toCharacterId || typeof toCharacterId !== 'string') {
    return c.json({ error: '目标角色卡ID不能为空' }, 400);
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

  // 校验发起方角色属于当前用户
  const fromCharacter = await db
    .prepare('SELECT user_id, name FROM characters WHERE id = ?')
    .bind(fromCharacterId)
    .first<{ user_id: string; name: string }>();
  if (!fromCharacter) {
    return c.json({ error: '发起方角色卡不存在' }, 404);
  }
  if (fromCharacter.user_id !== userId) {
    return c.json({ error: '无权操作该角色卡' }, 403);
  }

  // 验证发起方和目标角色都在该房间中
  const fromMember = await db
    .prepare('SELECT character_id FROM room_members WHERE room_id = ? AND character_id = ?')
    .bind(roomId, fromCharacterId)
    .first();
  if (!fromMember) {
    return c.json({ error: '发起方角色不在此房间中' }, 404);
  }

  const toMember = await db
    .prepare('SELECT character_id FROM room_members WHERE room_id = ? AND character_id = ?')
    .bind(roomId, toCharacterId)
    .first();
  if (!toMember) {
    return c.json({ error: '目标角色不在此房间中' }, 404);
  }

  // 更新目标方梦点数（发起方不扣除）
  await db
    .prepare(
      "UPDATE characters SET dream_points = dream_points + ?, updated_at = datetime('now') WHERE id = ?"
    )
    .bind(amount, toCharacterId)
    .run();

  // 插入资源日志（容错：表不存在时不影响主流程）
  try {
    await db.prepare('INSERT INTO resource_logs (room_code, character_id, resource_type, change_amount, reason) VALUES (?, ?, ?, ?, ?)')
      .bind(roomId, toCharacterId, 'dream', amount, `${fromCharacter.name} 赠送`).run();
  } catch (e) {
    console.error('写入 resource_logs 失败:', e);
  }

  // 获取更新后的梦点数
  const toUpdated = await db
    .prepare('SELECT dream_points FROM characters WHERE id = ?')
    .bind(toCharacterId)
    .first<{ dream_points: number }>();

  return c.json({
    toCharacterId,
    added: amount,
    dreamPoints: toUpdated?.dream_points,
  });
});

// POST /:code/deduct-wonder - GM 扣除奇迹点
route.post('/:code/deduct-wonder', authMiddleware, async (c) => {
  const roomId = c.req.param('code');
  const body = await c.req.json<{ characterId?: string; amount?: number }>();
  const { characterId, amount } = body;
  const userId = c.get('userId');

  if (!characterId || typeof characterId !== 'string') {
    return c.json({ error: '角色卡ID不能为空' }, 400);
  }
  if (typeof amount !== 'number' || amount <= 0 || !Number.isInteger(amount)) {
    return c.json({ error: '扣除数量必须是正整数' }, 400);
  }

  const db = c.env.DB;

  // 校验房间成员身份
  const isMember = await isRoomMember(db, roomId, userId);
  if (!isMember) {
    return c.json({ error: '只有房间成员可以执行此操作' }, 403);
  }

  // 校验权限：GM可以扣除任何角色，玩家只能扣除自己的角色
  const isGM = await checkGM(db, roomId, userId);
  if (!isGM) {
    const character = await db
      .prepare('SELECT user_id FROM characters WHERE id = ?')
      .bind(characterId)
      .first<{ user_id: string }>();
    if (!character || character.user_id !== userId) {
      return c.json({ error: '只能扣除自己角色的奇迹点' }, 403);
    }
  }

  // 检查角色是否在房间中
  const targetMember = await db
    .prepare('SELECT character_id FROM room_members WHERE room_id = ? AND character_id = ?')
    .bind(roomId, characterId)
    .first();
  if (!targetMember) {
    return c.json({ error: '该角色不在此房间中' }, 404);
  }

  // 检查当前奇迹点是否足够
  const targetChar = await db
    .prepare('SELECT wonder_points FROM characters WHERE id = ?')
    .bind(characterId)
    .first<{ wonder_points: number }>();
  if (!targetChar || targetChar.wonder_points < amount) {
    return c.json({ error: '奇迹点不足，当前: ' + (targetChar?.wonder_points ?? 0) }, 400);
  }

  // 扣除奇迹点
  await db
    .prepare(
      "UPDATE characters SET wonder_points = wonder_points - ?, updated_at = datetime('now') WHERE id = ?"
    )
    .bind(amount, characterId)
    .run();

  // 插入资源日志（容错：表不存在时不影响主流程）
  try {
    await db.prepare('INSERT INTO resource_logs (room_code, character_id, resource_type, change_amount, reason) VALUES (?, ?, ?, ?, ?)')
      .bind(roomId, characterId, 'wonder', -amount, '消耗奇迹点').run();
  } catch (e) {
    console.error('写入 resource_logs 失败:', e);
  }

  // 获取更新后的奇迹点数
  const updated = await db
    .prepare('SELECT wonder_points FROM characters WHERE id = ?')
    .bind(characterId)
    .first<{ wonder_points: number }>();

  return c.json({
    success: true,
    newPoints: updated?.wonder_points,
  });
});

// POST /:code/deduct-feeling - GM 扣除心意点
route.post('/:code/deduct-feeling', authMiddleware, async (c) => {
  const roomId = c.req.param('code');
  const body = await c.req.json<{ characterId?: string; amount?: number }>();
  const { characterId, amount } = body;
  const userId = c.get('userId');

  if (!characterId || typeof characterId !== 'string') {
    return c.json({ error: '角色卡ID不能为空' }, 400);
  }
  if (typeof amount !== 'number' || amount <= 0 || !Number.isInteger(amount)) {
    return c.json({ error: '扣除数量必须是正整数' }, 400);
  }

  const db = c.env.DB;

  // 校验房间成员身份
  const isMember = await isRoomMember(db, roomId, userId);
  if (!isMember) {
    return c.json({ error: '只有房间成员可以执行此操作' }, 403);
  }

  // 校验权限：GM可以扣除任何角色，玩家只能扣除自己的角色
  const isGM = await checkGM(db, roomId, userId);
  if (!isGM) {
    const character = await db
      .prepare('SELECT user_id FROM characters WHERE id = ?')
      .bind(characterId)
      .first<{ user_id: string }>();
    if (!character || character.user_id !== userId) {
      return c.json({ error: '只能扣除自己角色的心意点' }, 403);
    }
  }

  // 检查角色是否在房间中
  const targetMember = await db
    .prepare('SELECT character_id FROM room_members WHERE room_id = ? AND character_id = ?')
    .bind(roomId, characterId)
    .first();
  if (!targetMember) {
    return c.json({ error: '该角色不在此房间中' }, 404);
  }

  // 检查当前心意点是否足够
  const targetChar = await db
    .prepare('SELECT feeling_points FROM characters WHERE id = ?')
    .bind(characterId)
    .first<{ feeling_points: number }>();
  if (!targetChar || targetChar.feeling_points < amount) {
    return c.json({ error: '心意点不足，当前: ' + (targetChar?.feeling_points ?? 0) }, 400);
  }

  // 扣除心意点
  await db
    .prepare(
      "UPDATE characters SET feeling_points = feeling_points - ?, updated_at = datetime('now') WHERE id = ?"
    )
    .bind(amount, characterId)
    .run();

  // 插入资源日志（容错：表不存在时不影响主流程）
  try {
    await db.prepare('INSERT INTO resource_logs (room_code, character_id, resource_type, change_amount, reason) VALUES (?, ?, ?, ?, ?)')
      .bind(roomId, characterId, 'feeling', -amount, '消耗心意点').run();
  } catch (e) {
    console.error('写入 resource_logs 失败:', e);
  }

  // 获取更新后的心意点数
  const updated = await db
    .prepare('SELECT feeling_points FROM characters WHERE id = ?')
    .bind(characterId)
    .first<{ feeling_points: number }>();

  return c.json({
    success: true,
    newPoints: updated?.feeling_points,
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
  // 容错：resource_logs 表可能尚未创建，此时返回空数组
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
    // resource_logs 表不存在时，返回空日志
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

// POST /:code/update-resource - 玩家手动修改角色资源
route.post('/:code/update-resource', authMiddleware, async (c) => {
  const roomId = c.req.param('code');
  const body = await c.req.json<{ characterId?: string; resourceType?: string; newValue?: number }>();
  const { characterId, resourceType, newValue } = body;
  const userId = c.get('userId');

  if (!characterId || typeof characterId !== 'string') {
    return c.json({ error: '角色卡ID不能为空' }, 400);
  }
  if (!resourceType || !['dream', 'feeling', 'wonder'].includes(resourceType)) {
    return c.json({ error: '资源类型必须是 dream、feeling 或 wonder' }, 400);
  }
  if (typeof newValue !== 'number' || !Number.isInteger(newValue) || newValue < 0) {
    return c.json({ error: '新值必须是非负整数' }, 400);
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

  // 检查角色是否在房间中
  const targetMember = await db
    .prepare('SELECT character_id FROM room_members WHERE room_id = ? AND character_id = ?')
    .bind(roomId, characterId)
    .first();
  if (!targetMember) {
    return c.json({ error: '该角色不在此房间中' }, 404);
  }

  // 校验权限：角色属于当前用户，或当前用户是GM
  const isGM = await checkGM(db, roomId, userId);
  if (!isGM) {
    const character = await db
      .prepare('SELECT user_id FROM characters WHERE id = ?')
      .bind(characterId)
      .first<{ user_id: string }>();
    if (!character || character.user_id !== userId) {
      return c.json({ error: '只能修改自己角色的资源' }, 403);
    }
  }

  // 获取当前资源值
  const columnMap: Record<string, string> = {
    dream: 'dream_points',
    feeling: 'feeling_points',
    wonder: 'wonder_points',
  };
  const column = columnMap[resourceType];

  const current = await db
    .prepare(`SELECT ${column} as current_value FROM characters WHERE id = ?`)
    .bind(characterId)
    .first<{ current_value: number }>();

  if (!current) {
    return c.json({ error: '角色卡不存在' }, 404);
  }

  const changeAmount = newValue - current.current_value;

  // 更新资源值
  await db
    .prepare(`UPDATE characters SET ${column} = ?, updated_at = datetime('now') WHERE id = ?`)
    .bind(newValue, characterId)
    .run();

  // 插入资源日志（容错：表不存在时不影响主流程）
  try {
    await db
      .prepare('INSERT INTO resource_logs (room_code, character_id, resource_type, change_amount, reason) VALUES (?, ?, ?, ?, ?)')
      .bind(roomId, characterId, resourceType, changeAmount, '手动修改')
      .run();
  } catch (e) {
    console.error('写入 resource_logs 失败:', e);
  }

  return c.json({
    characterId,
    resourceType,
    previousValue: current.current_value,
    newValue,
    changeAmount,
  });
});

export default route;
