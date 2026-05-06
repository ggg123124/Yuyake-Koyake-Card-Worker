import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth';
import { Bindings, Variables } from '../types';
import { handleBondUpgrade } from '../api/calculate';

const route = new Hono<{ Bindings: Bindings; Variables: Variables }>();

route.use('*', authMiddleware);

// 辅助函数：将 snake_case 行转换为 camelCase 响应
function formatBond(row: Record<string, unknown>) {
  return {
    id: row.id,
    roomId: row.room_id,
    fromCharacterId: row.from_character_id,
    toCharacterName: row.to_character_name,
    toCharacterId: row.to_character_id,
    bondType: row.bond_type,
    bondLevel: row.bond_level,
    isIntense: row.is_intense,
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

    return c.json(formatBond(row!));
  }

  // 创建新牵绊
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO bonds (
        id, room_id, from_character_id, to_character_name, to_character_id,
        bond_type, bond_level, is_intense, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    )
    .bind(
      id,
      body.roomId,
      body.fromCharacterId,
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
      'SELECT * FROM bonds WHERE room_id = ? AND from_character_id = ? ORDER BY updated_at DESC'
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
      'SELECT * FROM bonds WHERE room_id = ? AND to_character_id = ? ORDER BY updated_at DESC'
    )
    .bind(roomId, characterId)
    .all<Record<string, unknown>>();

  return c.json(results.map(formatBond));
});

// POST /upgrade - 升级牵绊
route.post('/upgrade', handleBondUpgrade);

// DELETE /:id - 删除牵绊
route.delete('/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const db = c.env.DB;

  const bond = await db
    .prepare('SELECT from_character_id FROM bonds WHERE id = ?')
    .bind(id)
    .first<{ from_character_id: string }>();

  if (!bond) {
    return c.json({ error: '牵绊不存在' }, 404);
  }

  const character = await db
    .prepare('SELECT user_id FROM characters WHERE id = ?')
    .bind(bond.from_character_id)
    .first<{ user_id: string }>();

  if (!character || character.user_id !== userId) {
    return c.json({ error: '无权删除此牵绊' }, 403);
  }

  await db.prepare('DELETE FROM bonds WHERE id = ?').bind(id).run();

  return c.json({ success: true });
});

export default route;
