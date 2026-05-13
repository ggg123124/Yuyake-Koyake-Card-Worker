import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth';
import { Bindings, Variables } from '../types';

const route = new Hono<{ Bindings: Bindings; Variables: Variables }>();

route.use('*', authMiddleware);

// 辅助函数：检查用户是否有权编辑某角色的背包（角色拥有者 或 同房间GM）
async function checkInventoryPermission(db: D1Database, characterId: string, userId: string): Promise<boolean> {
  // 检查是否是角色拥有者
  const character = await db
    .prepare('SELECT user_id FROM characters WHERE id = ?')
    .bind(characterId)
    .first<{ user_id: string }>();

  if (!character) return false;
  if (character.user_id === userId) return true;

  // 检查是否是同房间的 GM（rooms.gm_user_id）
  const gmRoom = await db
    .prepare(`
      SELECT r.id FROM rooms r
      JOIN room_members rm ON r.id = rm.room_id
      WHERE rm.character_id = ? AND r.gm_user_id = ?
      LIMIT 1
    `)
    .bind(characterId, userId)
    .first();

  if (gmRoom) return true;

  // 检查 room_members 中是否有 GM 角色
  const gmMember = await db
    .prepare(`
      SELECT 1 FROM room_members rm1
      JOIN room_members rm2 ON rm1.room_id = rm2.room_id
      WHERE rm2.character_id = ? AND rm1.user_id = ? AND rm1.role = 'gm'
      LIMIT 1
    `)
    .bind(characterId, userId)
    .first();

  return !!gmMember;
}

// 辅助函数：检查用户是否可以查看某角色的背包（拥有者、同房间GM、同房间成员）
async function canViewInventory(db: D1Database, characterId: string, userId: string): Promise<boolean> {
  // 拥有者可以查看
  const character = await db
    .prepare('SELECT user_id FROM characters WHERE id = ?')
    .bind(characterId)
    .first<{ user_id: string }>();

  if (!character) return false;
  if (character.user_id === userId) return true;

  // 同房间的成员可以查看
  const sameRoom = await db
    .prepare(`
      SELECT 1 FROM room_members rm1
      JOIN room_members rm2 ON rm1.room_id = rm2.room_id
      JOIN characters c ON rm1.character_id = c.id
      WHERE c.user_id = ? AND rm2.character_id = ?
      LIMIT 1
    `)
    .bind(userId, characterId)
    .first();

  return !!sameRoom;
}

// 辅助函数：通知 RoomDO 广播房间更新
async function notifyRoomUpdate(env: Bindings, db: D1Database, characterId: string) {
  try {
    const roomMember = await db
      .prepare('SELECT room_id FROM room_members WHERE character_id = ? LIMIT 1')
      .bind(characterId)
      .first<{ room_id: string }>();

    if (roomMember) {
      const doId = env.ROOM_DO.idFromName(roomMember.room_id);
      const stub = env.ROOM_DO.get(doId);
      await stub.fetch(new Request(`http://internal/rooms/${roomMember.room_id}/broadcast`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Room-Id': roomMember.room_id },
        body: JSON.stringify({ type: 'inventory-changed', characterId }),
      }));
    }
  } catch (e) {
    console.error('通知 RoomDO 广播失败:', e);
  }
}

// 格式化物品行
function formatItem(row: {
  id: string;
  character_id: string;
  name: string;
  description: string | null;
  sort_order: number;
  created_at: string;
}) {
  return {
    id: row.id,
    characterId: row.character_id,
    name: row.name,
    description: row.description || '',
    sortOrder: row.sort_order,
    createdAt: row.created_at,
  };
}

// GET /:characterId - 获取角色背包物品列表
route.get('/:characterId', async (c) => {
  const characterId = c.req.param('characterId');
  const userId = c.get('userId');
  const db = c.env.DB;

  // 校验角色存在
  const character = await db
    .prepare('SELECT id FROM characters WHERE id = ?')
    .bind(characterId)
    .first();

  if (!character) {
    return c.json({ error: '角色卡不存在' }, 404);
  }

  // 校验查看权限
  const canView = await canViewInventory(db, characterId, userId);
  if (!canView) {
    return c.json({ error: '无权查看该角色的背包' }, 403);
  }

  const { results } = await db
    .prepare('SELECT * FROM inventory_items WHERE character_id = ? ORDER BY sort_order ASC, created_at ASC')
    .bind(characterId)
    .all<{
      id: string;
      character_id: string;
      name: string;
      description: string | null;
      sort_order: number;
      created_at: string;
    }>();

  return c.json(results.map(formatItem));
});

// POST /:characterId - 添加背包物品
route.post('/:characterId', async (c) => {
  const characterId = c.req.param('characterId');
  const userId = c.get('userId');
  const db = c.env.DB;
  const body = await c.req.json<{ name?: string; description?: string }>();

  if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
    return c.json({ error: '物品名称不能为空' }, 400);
  }

  // 校验编辑权限
  const hasPermission = await checkInventoryPermission(db, characterId, userId);
  if (!hasPermission) {
    return c.json({ error: '无权编辑该角色的背包' }, 403);
  }

  const id = crypto.randomUUID();
  await db
    .prepare('INSERT INTO inventory_items (id, character_id, name, description) VALUES (?, ?, ?, ?)')
    .bind(id, characterId, body.name.trim(), body.description?.trim() || '')
    .run();

  // 通知房间更新
  await notifyRoomUpdate(c.env, db, characterId);

  return c.json({
    id,
    characterId,
    name: body.name.trim(),
    description: body.description?.trim() || '',
  }, 201);
});

// PUT /:characterId/:itemId - 更新背包物品
route.put('/:characterId/:itemId', async (c) => {
  const characterId = c.req.param('characterId');
  const itemId = c.req.param('itemId');
  const userId = c.get('userId');
  const db = c.env.DB;
  const body = await c.req.json<{ name?: string; description?: string }>();

  // 校验编辑权限
  const hasPermission = await checkInventoryPermission(db, characterId, userId);
  if (!hasPermission) {
    return c.json({ error: '无权编辑该角色的背包' }, 403);
  }

  // 校验物品存在且属于该角色
  const existing = await db
    .prepare('SELECT id FROM inventory_items WHERE id = ? AND character_id = ?')
    .bind(itemId, characterId)
    .first();

  if (!existing) {
    return c.json({ error: '物品不存在' }, 404);
  }

  const fields: string[] = [];
  const values: unknown[] = [];

  if (body.name !== undefined) {
    const trimmed = body.name.trim();
    if (!trimmed) {
      return c.json({ error: '物品名称不能为空' }, 400);
    }
    fields.push('name = ?');
    values.push(trimmed);
  }
  if (body.description !== undefined) {
    fields.push('description = ?');
    values.push(body.description.trim());
  }

  if (fields.length === 0) {
    return c.json({ error: '未提供任何更新字段' }, 400);
  }

  values.push(itemId);
  await db
    .prepare(`UPDATE inventory_items SET ${fields.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();

  // 通知房间更新
  await notifyRoomUpdate(c.env, db, characterId);

  const item = await db
    .prepare('SELECT * FROM inventory_items WHERE id = ?')
    .bind(itemId)
    .first<{
      id: string;
      character_id: string;
      name: string;
      description: string | null;
      sort_order: number;
      created_at: string;
    }>();

  return c.json(formatItem(item!));
});

// DELETE /:characterId/:itemId - 删除背包物品
route.delete('/:characterId/:itemId', async (c) => {
  const characterId = c.req.param('characterId');
  const itemId = c.req.param('itemId');
  const userId = c.get('userId');
  const db = c.env.DB;

  // 校验编辑权限
  const hasPermission = await checkInventoryPermission(db, characterId, userId);
  if (!hasPermission) {
    return c.json({ error: '无权编辑该角色的背包' }, 403);
  }

  // 校验物品存在且属于该角色
  const existing = await db
    .prepare('SELECT id FROM inventory_items WHERE id = ? AND character_id = ?')
    .bind(itemId, characterId)
    .first();

  if (!existing) {
    return c.json({ error: '物品不存在' }, 404);
  }

  await db.prepare('DELETE FROM inventory_items WHERE id = ?').bind(itemId).run();

  // 通知房间更新
  await notifyRoomUpdate(c.env, db, characterId);

  return c.json({ success: true });
});

// PUT /:characterId/reorder - 重新排序背包物品
route.put('/:characterId/reorder', async (c) => {
  const characterId = c.req.param('characterId');
  const userId = c.get('userId');
  const db = c.env.DB;
  const body = await c.req.json<{ itemIds?: string[] }>();

  if (!body.itemIds || !Array.isArray(body.itemIds) || body.itemIds.length === 0) {
    return c.json({ error: '请提供物品ID列表' }, 400);
  }

  // 校验编辑权限
  const hasPermission = await checkInventoryPermission(db, characterId, userId);
  if (!hasPermission) {
    return c.json({ error: '无权编辑该角色的背包' }, 403);
  }

  for (let i = 0; i < body.itemIds.length; i++) {
    await db
      .prepare('UPDATE inventory_items SET sort_order = ? WHERE id = ? AND character_id = ?')
      .bind(i, body.itemIds[i], characterId)
      .run();
  }

  // 通知房间更新
  await notifyRoomUpdate(c.env, db, characterId);

  return c.json({ success: true });
});

export default route;
