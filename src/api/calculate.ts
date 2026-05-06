import { Hono, Context } from 'hono';
import { authMiddleware } from '../middleware/auth';
import { Bindings, Variables } from '../types';
import { calculatePoints, calculateDreamCost } from '../utils/calculator';

const route = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// POST /:roomId/:characterId - 计算奇妙和思念
route.post('/:roomId/:characterId', authMiddleware, async (c) => {
  const roomId = c.req.param('roomId');
  const characterId = c.req.param('characterId');
  const userId = c.get('userId');
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

  // 校验角色在房间中
  const member = await db
    .prepare('SELECT character_id FROM room_members WHERE room_id = ? AND character_id = ?')
    .bind(roomId, characterId)
    .first();
  if (!member) {
    return c.json({ error: '该角色不在此房间中' }, 404);
  }

  const result = await calculatePoints(db, roomId, characterId);

  return c.json({
    roomId,
    characterId,
    wonderPoints: result.wonderPoints,
    feelingPoints: result.feelingPoints,
    details: result.details,
  });
});

// 升级牵绊 handler（导出供 index.ts 在 /api/bonds/upgrade 挂载）
export async function handleBondUpgrade(
  c: Context<{ Bindings: Bindings; Variables: Variables }>
) {
  const body = await c.req.json<{ bondId?: string; targetLevel?: number }>();
  const { bondId, targetLevel } = body;
  const userId = c.get('userId');
  const db = c.env.DB;

  if (!bondId || typeof bondId !== 'string') {
    return c.json({ error: '牵绊ID不能为空' }, 400);
  }
  if (
    typeof targetLevel !== 'number' ||
    targetLevel < 1 ||
    targetLevel > 5 ||
    !Number.isInteger(targetLevel)
  ) {
    return c.json({ error: '目标等级必须是1-5的整数' }, 400);
  }

  // 查询牵绊信息（同时获取发起方信息和目标角色弱点）
  const bond = await db
    .prepare(
      `
      SELECT b.id, b.room_id, b.from_character_id, b.bond_level, b.to_character_name, b.to_character_id,
             fc.user_id, fc.dream_points,
             tc.weaknesses as to_weaknesses,
             fc.weaknesses as from_weaknesses
      FROM bonds b
      JOIN characters fc ON b.from_character_id = fc.id
      LEFT JOIN characters tc ON b.to_character_id = tc.id
      WHERE b.id = ?
      `
    )
    .bind(bondId)
    .first<{
      id: string;
      room_id: string;
      from_character_id: string;
      bond_level: number;
      to_character_name: string;
      to_character_id: string | null;
      user_id: string;
      dream_points: number;
      to_weaknesses: string | null;
      from_weaknesses: string | null;
    }>();

  if (!bond) {
    return c.json({ error: '牵绊不存在' }, 404);
  }

  // 校验权限：牵绊的 from_character 属于当前用户
  if (bond.user_id !== userId) {
    return c.json({ error: '无权升级该牵绊' }, 403);
  }

  if (targetLevel <= bond.bond_level) {
    return c.json({ error: '目标等级必须高于当前等级' }, 400);
  }

  // 解析目标角色的弱点为对象数组（NPC无弱点）
  const toWeaknesses = bond.to_weaknesses
    ? JSON.parse(bond.to_weaknesses as string) as Array<{ name: string; description?: string } | string>
    : [];
  // 解析发起方角色的弱点
  const fromWeaknesses = bond.from_weaknesses
    ? JSON.parse(bond.from_weaknesses as string) as Array<{ name: string; description?: string } | string>
    : [];
  const costResult = calculateDreamCost(
    bond.bond_level,
    targetLevel,
    toWeaknesses,
    bond.dream_points,
    fromWeaknesses
  );

  if (!costResult.canAfford) {
    return c.json(
      {
        error: '梦点不足',
        required: costResult.totalCost,
        available: bond.dream_points,
      },
      400
    );
  }

  // 扣除梦点并更新牵绊等级
  await db
    .prepare(
      `
      UPDATE characters
      SET dream_points = dream_points - ?, updated_at = datetime('now')
      WHERE id = ?
      `
    )
    .bind(costResult.totalCost, bond.from_character_id)
    .run();

  await db
    .prepare("UPDATE bonds SET bond_level = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(targetLevel, bondId)
    .run();

  // 获取更新后的梦点数
  const updatedCharacter = await db
    .prepare('SELECT dream_points FROM characters WHERE id = ?')
    .bind(bond.from_character_id)
    .first<{ dream_points: number }>();

  return c.json({
    bondId,
    targetLevel,
    previousLevel: bond.bond_level,
    cost: costResult.totalCost,
    remainingDreamPoints: updatedCharacter?.dream_points,
  });
}

export default route;
