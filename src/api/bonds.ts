import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth';
import { Bindings, Variables } from '../types';
import { handleBondUpgrade } from '../api/calculate';

const route = new Hono<{ Bindings: Bindings; Variables: Variables }>();

route.use('*', authMiddleware);

// 辅助函数：通知 RoomDO 广播牵绊更新
async function notifyBondsUpdate(env: Bindings, roomId: string) {
  try {
    const doId = env.ROOM_DO.idFromName(roomId);
    const stub = env.ROOM_DO.get(doId);
    await stub.fetch(new Request(`http://internal/rooms/${roomId}/broadcast-bonds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Room-Id': roomId },
      body: JSON.stringify({}),
    }));
  } catch (e) {
    console.error('通知 RoomDO 广播失败:', e);
  }
}

// 辅助函数：将 snake_case 行转换为 camelCase 响应
function formatBond(row: Record<string, unknown>) {
  return {
    id: row.id,
    roomId: row.room_id,
    fromCharacterId: row.from_character_id,
    fromCharacterName: row.from_character_name,
    toCharacterName: row.to_character_name,
    toCharacterId: row.to_character_id,
    bondType: row.bond_type,
    bondLevel: row.bond_level,
    isIntense: row.is_intense,
    sortOrder: row.sort_order ?? 0,
    updatedAt: row.updated_at,
  };
}

// POST / - 创建或更新牵绊
route.post('/', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json<{
    roomId?: string;
    fromCharacterId?: string;
    toCharacterName?: string;
    toCharacterId?: string;
    bondType?: string;
    bondLevel?: number;
    isIntense?: boolean;
  }>();

  if (!body.roomId || typeof body.roomId !== 'string') {
    return c.json({ error: '房间ID不能为空' }, 400);
  }
  if (!body.fromCharacterId || typeof body.fromCharacterId !== 'string') {
    return c.json({ error: '来源角色ID不能为空' }, 400);
  }
  if (!body.toCharacterName || typeof body.toCharacterName !== 'string') {
    return c.json({ error: '目标角色名不能为空' }, 400);
  }
  if (!body.bondType || typeof body.bondType !== 'string') {
    return c.json({ error: '牵绊类型不能为空' }, 400);
  }

  const db = c.env.DB;

  // 校验 fromCharacterId 属于当前用户
  const character = await db
    .prepare('SELECT user_id FROM characters WHERE id = ?')
    .bind(body.fromCharacterId)
    .first<{ user_id: string }>();

  if (!character) {
    return c.json({ error: '来源角色不存在' }, 404);
  }
  if (character.user_id !== userId) {
    return c.json({ error: '无权操作该角色的牵绊' }, 403);
  }

  const bondLevel = body.bondLevel ?? 1;
  const isIntense = body.isIntense ? 1 : 0;

  // 检查是否已存在相同 from+room+toName 的牵绊
  const existing = await db
    .prepare(
      'SELECT id FROM bonds WHERE from_character_id = ? AND room_id = ? AND to_character_name = ?'
    )
    .bind(body.fromCharacterId, body.roomId, body.toCharacterName)
    .first<{ id: string }>();

  if (existing) {
    // 更新现有牵绊
    await db
      .prepare(
        `UPDATE bonds SET
          to_character_id = ?,
          bond_type = ?,
          bond_level = ?,
          is_intense = ?,
          updated_at = datetime('now')
        WHERE id = ?`
      )
      .bind(
        body.toCharacterId ?? null,
        body.bondType,
        bondLevel,
        isIntense,
        existing.id
      )
      .run();

    const row = await db
      .prepare('SELECT * FROM bonds WHERE id = ?')
      .bind(existing.id)
      .first<Record<string, unknown>>();

    // 通知 DO 广播
    await notifyBondsUpdate(c.env, body.roomId);

    return c.json(formatBond(row!));
  }

  // 创建新牵绊
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO bonds (
        id, room_id, from_character_id, from_character_name, to_character_name, to_character_id,
        bond_type, bond_level, is_intense, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    )
    .bind(
      id,
      body.roomId,
      body.fromCharacterId,
      null,
      body.toCharacterName,
      body.toCharacterId ?? null,
      body.bondType,
      bondLevel,
      isIntense
    )
    .run();

  const row = await db
    .prepare('SELECT * FROM bonds WHERE id = ?')
    .bind(id)
    .first<Record<string, unknown>>();

  // 通知 DO 广播
  await notifyBondsUpdate(c.env, body.roomId);

  return c.json(formatBond(row!), 201);
});

// GET / - 获取角色的出方向牵绊
route.get('/', async (c) => {
  const roomId = c.req.query('room_id');
  const characterId = c.req.query('character_id');

  if (!roomId) {
    return c.json({ error: '缺少 room_id 参数' }, 400);
  }
  if (!characterId) {
    return c.json({ error: '缺少 character_id 参数' }, 400);
  }

  const db = c.env.DB;

  const { results } = await db
    .prepare(
      'SELECT * FROM bonds WHERE room_id = ? AND from_character_id = ? ORDER BY sort_order ASC, updated_at DESC'
    )
    .bind(roomId, characterId)
    .all<Record<string, unknown>>();

  return c.json(results.map(formatBond));
});

// GET /incoming - 获取他人对该角色的牵绊
route.get('/incoming', async (c) => {
  const roomId = c.req.query('room_id');
  const characterId = c.req.query('character_id');

  if (!roomId) {
    return c.json({ error: '缺少 room_id 参数' }, 400);
  }
  if (!characterId) {
    return c.json({ error: '缺少 character_id 参数' }, 400);
  }

  const db = c.env.DB;

  const { results } = await db
    .prepare(
      'SELECT * FROM bonds WHERE room_id = ? AND to_character_id = ? ORDER BY sort_order ASC, updated_at DESC'
    )
    .bind(roomId, characterId)
    .all<Record<string, unknown>>();

  return c.json(results.map(formatBond));
});

// POST /incoming - 添加他人对我的牵绊（支持NPC）
route.post('/incoming', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json<{
    roomId?: string;
    toCharacterId?: string;
    fromCharacterId?: string;
    fromCharacterName?: string;
    bondType?: string;
    bondLevel?: number;
    isIntense?: boolean;
  }>();

  if (!body.roomId || typeof body.roomId !== 'string') {
    return c.json({ error: '房间ID不能为空' }, 400);
  }
  if (!body.toCharacterId || typeof body.toCharacterId !== 'string') {
    return c.json({ error: '目标角色ID不能为空' }, 400);
  }
  if (!body.bondType || typeof body.bondType !== 'string') {
    return c.json({ error: '牵绊类型不能为空' }, 400);
  }

  const db = c.env.DB;

  // 校验 toCharacterId 属于当前用户
  const toCharacter = await db
    .prepare('SELECT user_id, name FROM characters WHERE id = ?')
    .bind(body.toCharacterId)
    .first<{ user_id: string; name: string }>();

  if (!toCharacter) {
    return c.json({ error: '目标角色不存在' }, 404);
  }
  if (toCharacter.user_id !== userId) {
    return c.json({ error: '无权操作该角色的牵绊' }, 403);
  }

  // 获取来源角色名
  let fromName = body.fromCharacterName || '';
  if (body.fromCharacterId) {
    const fromChar = await db
      .prepare('SELECT name FROM characters WHERE id = ?')
      .bind(body.fromCharacterId)
      .first<{ name: string }>();
    if (fromChar) fromName = fromChar.name;
  }
  if (!fromName) {
    return c.json({ error: '来源角色名不能为空' }, 400);
  }

  const bondLevel = body.bondLevel ?? 1;
  const isIntense = body.isIntense ? 1 : 0;

  // 检查是否已存在相同 from+room+to 的牵绊
  const existing = await db
    .prepare(
      'SELECT id FROM bonds WHERE room_id = ? AND from_character_id = ? AND to_character_id = ?'
    )
    .bind(body.roomId, body.fromCharacterId ?? null, body.toCharacterId)
    .first<{ id: string }>();

  if (!existing && body.fromCharacterId) {
    // 也检查 from_character_name 匹配的情况（NPC可能没有ID）
    const existingByName = await db
      .prepare(
        'SELECT id FROM bonds WHERE room_id = ? AND from_character_name = ? AND to_character_id = ?'
      )
      .bind(body.roomId, fromName, body.toCharacterId)
      .first<{ id: string }>();

    if (existingByName) {
      // 更新
      await db
        .prepare(
          `UPDATE bonds SET
            from_character_id = ?,
            bond_type = ?,
            bond_level = ?,
            is_intense = ?,
            updated_at = datetime('now')
          WHERE id = ?`
        )
        .bind(body.fromCharacterId, body.bondType, bondLevel, isIntense, existingByName.id)
        .run();

      const row = await db
        .prepare('SELECT * FROM bonds WHERE id = ?')
        .bind(existingByName.id)
        .first<Record<string, unknown>>();

      // 通知 DO 广播
      await notifyBondsUpdate(c.env, body.roomId);

      return c.json(formatBond(row!));
    }
  }

  if (existing) {
    // 更新现有牵绊
    await db
      .prepare(
        `UPDATE bonds SET
          from_character_name = ?,
          bond_type = ?,
          bond_level = ?,
          is_intense = ?,
          updated_at = datetime('now')
        WHERE id = ?`
      )
      .bind(fromName, body.bondType, bondLevel, isIntense, existing.id)
      .run();

    const row = await db
      .prepare('SELECT * FROM bonds WHERE id = ?')
      .bind(existing.id)
      .first<Record<string, unknown>>();

    // 通知 DO 广播
    await notifyBondsUpdate(c.env, body.roomId);

    return c.json(formatBond(row!));
  }

  // 创建新牵绊
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO bonds (
        id, room_id, from_character_id, from_character_name, to_character_name, to_character_id,
        bond_type, bond_level, is_intense, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    )
    .bind(
      id,
      body.roomId,
      body.fromCharacterId ?? null,
      fromName,
      toCharacter.name,
      body.toCharacterId,
      body.bondType,
      bondLevel,
      isIntense
    )
    .run();

  const row = await db
    .prepare('SELECT * FROM bonds WHERE id = ?')
    .bind(id)
    .first<Record<string, unknown>>();

  // 通知 DO 广播
  await notifyBondsUpdate(c.env, body.roomId);

  return c.json(formatBond(row!), 201);
});

// PUT /reorder - 批量更新牵绊排序
route.put('/reorder', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json<{ bondIds: string[] }>();

  if (!body.bondIds || !Array.isArray(body.bondIds) || body.bondIds.length === 0) {
    return c.json({ error: '请提供牵绊ID列表' }, 400);
  }

  const db = c.env.DB;

  // 校验所有牵绊都属于当前用户
  for (let i = 0; i < body.bondIds.length; i++) {
    const bondId = body.bondIds[i];
    const bond = await db
      .prepare('SELECT from_character_id, to_character_id FROM bonds WHERE id = ?')
      .bind(bondId)
      .first<{ from_character_id: string | null; to_character_id: string | null }>();

    if (!bond) {
      return c.json({ error: `牵绊 ${bondId} 不存在` }, 404);
    }

    let authorized = false;
    if (bond.from_character_id) {
      const fromChar = await db
        .prepare('SELECT user_id FROM characters WHERE id = ?')
        .bind(bond.from_character_id)
        .first<{ user_id: string }>();
      if (fromChar && fromChar.user_id === userId) authorized = true;
    }
    if (!authorized && !bond.from_character_id && bond.to_character_id) {
      const toChar = await db
        .prepare('SELECT user_id FROM characters WHERE id = ?')
        .bind(bond.to_character_id)
        .first<{ user_id: string }>();
      if (toChar && toChar.user_id === userId) authorized = true;
    }
    if (!authorized) {
      return c.json({ error: '无权排序此牵绊' }, 403);
    }

    await db
      .prepare('UPDATE bonds SET sort_order = ? WHERE id = ?')
      .bind(i, bondId)
      .run();
  }

  // 获取第一个牵绊的 roomId 用于广播
  const firstBond = await db
    .prepare('SELECT room_id FROM bonds WHERE id = ?')
    .bind(body.bondIds[0])
    .first<{ room_id: string }>();

  if (firstBond) {
    await notifyBondsUpdate(c.env, firstBond.room_id);
  }

  return c.json({ success: true });
});

// POST /upgrade - 升级牵绊
route.post('/upgrade', handleBondUpgrade);

// PUT /:id - 更新牵绊
route.put('/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const body = await c.req.json<{
    bondType?: string;
    bondLevel?: number;
    toCharacterName?: string;
    toCharacterId?: string | null;
    fromCharacterName?: string;
  }>();

  const db = c.env.DB;

  const bond = await db
    .prepare('SELECT * FROM bonds WHERE id = ?')
    .bind(id)
    .first<Record<string, unknown>>();

  if (!bond) {
    return c.json({ error: '牵绊不存在' }, 404);
  }

  // 检查权限：出站牵绊（from属于当前用户）或入站NPC牵绊（from为null且to属于当前用户）
  let authorized = false;
  const fromCharId = bond.from_character_id as string | null;
  const toCharId = bond.to_character_id as string | null;

  if (fromCharId) {
    const fromChar = await db
      .prepare('SELECT user_id FROM characters WHERE id = ?')
      .bind(fromCharId)
      .first<{ user_id: string }>();
    if (fromChar && fromChar.user_id === userId) authorized = true;
  }

  if (!authorized && !fromCharId && toCharId) {
    const toChar = await db
      .prepare('SELECT user_id FROM characters WHERE id = ?')
      .bind(toCharId)
      .first<{ user_id: string }>();
    if (toChar && toChar.user_id === userId) authorized = true;
  }

  if (!authorized) {
    return c.json({ error: '无权编辑此牵绊' }, 403);
  }

  const updates: string[] = [];
  const params: unknown[] = [];

  if (body.bondType !== undefined) {
    updates.push('bond_type = ?');
    params.push(body.bondType);
  }
  if (body.bondLevel !== undefined) {
    updates.push('bond_level = ?');
    params.push(body.bondLevel);
  }
  if (body.toCharacterName !== undefined) {
    updates.push('to_character_name = ?');
    params.push(body.toCharacterName);
  }
  if (body.toCharacterId !== undefined) {
    updates.push('to_character_id = ?');
    params.push(body.toCharacterId);
  }
  if (body.fromCharacterName !== undefined) {
    updates.push('from_character_name = ?');
    params.push(body.fromCharacterName);
  }

  if (updates.length === 0) {
    return c.json({ error: '没有需要更新的字段' }, 400);
  }

  updates.push("updated_at = datetime('now')");
  params.push(id);

  await db
    .prepare(`UPDATE bonds SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...params)
    .run();

  const row = await db
    .prepare('SELECT * FROM bonds WHERE id = ?')
    .bind(id)
    .first<Record<string, unknown>>();

  // 通知 DO 广播
  const roomId = bond.room_id as string;
  await notifyBondsUpdate(c.env, roomId);

  return c.json(formatBond(row!));
});

// DELETE /:id - 删除牵绊
route.delete('/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const db = c.env.DB;

  const bond = await db
    .prepare('SELECT from_character_id, to_character_id, room_id FROM bonds WHERE id = ?')
    .bind(id)
    .first<{ from_character_id: string | null; to_character_id: string | null; room_id: string }>();

  if (!bond) {
    return c.json({ error: '牵绊不存在' }, 404);
  }

  // 检查权限：来源角色或目标角色属于当前用户均可删除
  let authorized = false;

  if (bond.from_character_id) {
    const fromChar = await db
      .prepare('SELECT user_id FROM characters WHERE id = ?')
      .bind(bond.from_character_id)
      .first<{ user_id: string }>();
    if (fromChar && fromChar.user_id === userId) authorized = true;
  }

  if (!authorized && bond.to_character_id) {
    const toChar = await db
      .prepare('SELECT user_id FROM characters WHERE id = ?')
      .bind(bond.to_character_id)
      .first<{ user_id: string }>();
    if (toChar && toChar.user_id === userId) authorized = true;
  }

  if (!authorized) {
    return c.json({ error: '无权删除此牵绊' }, 403);
  }

  await db.prepare('DELETE FROM bonds WHERE id = ?').bind(id).run();

  // 通知 DO 广播
  if (bond.room_id) await notifyBondsUpdate(c.env, bond.room_id);

  return c.json({ success: true });
});

export default route;
