import { D1Database } from '@cloudflare/workers-types';

interface PointResult {
  wonderPoints: number;
  feelingPoints: number;
  details: {
    wonderBonds: Array<{
      bondId: string;
      toCharacterId: string | null;
      toCharacterName: string;
      level: number;
    }>;
    feelingBonds: Array<{
      bondId: string;
      fromCharacterId: string;
      level: number;
    }>;
    intenseBonus: number;
  };
}

const LEVEL_COST: Record<number, number> = {
  1: 5,
  2: 5,
  3: 5,
  4: 8,
  5: 12,
};

/**
 * 计算奇妙（奇迹点）和思念（心意点）
 * @param db D1 数据库实例
 * @param roomId 房间 ID
 * @param characterId 角色卡 ID
 */
export async function calculatePoints(
  db: D1Database,
  roomId: string,
  characterId: string
): Promise<PointResult> {
  // 奇妙 = 出方向牵绊等级之和
  const wonderResult = await db
    .prepare(
      `
      SELECT id, to_character_id, to_character_name, bond_level
      FROM bonds
      WHERE room_id = ? AND from_character_id = ?
      `
    )
    .bind(roomId, characterId)
    .all<{
      id: string;
      to_character_id: string | null;
      to_character_name: string;
      bond_level: number;
    }>();

  const wonderBonds = (wonderResult.results || []).map((r) => ({
    bondId: r.id,
    toCharacterId: r.to_character_id,
    toCharacterName: r.to_character_name,
    level: r.bond_level,
  }));

  const wonderBase = wonderBonds.reduce((sum, b) => sum + b.level, 0);

  // 思念 = 入方向牵绊等级之和
  const feelingResult = await db
    .prepare(
      `
      SELECT id, from_character_id, bond_level
      FROM bonds
      WHERE room_id = ? AND to_character_id = ?
      `
    )
    .bind(roomId, characterId)
    .all<{
      id: string;
      from_character_id: string;
      bond_level: number;
    }>();

  const feelingBonds = (feelingResult.results || []).map((r) => ({
    bondId: r.id,
    fromCharacterId: r.from_character_id,
    level: r.bond_level,
  }));

  const feelingBase = feelingBonds.reduce((sum, b) => sum + b.level, 0);

  // 强烈牵绊加成
  let intenseBonus = 0;
  for (const bond of wonderBonds) {
    if (bond.level === 5 && bond.toCharacterId) {
      // 检查对方是否有回向的5级牵绊
      const reciprocal = await db
        .prepare(
          `
          SELECT id FROM bonds
          WHERE room_id = ? AND from_character_id = ? AND to_character_id = ? AND bond_level = 5
          `
        )
        .bind(roomId, bond.toCharacterId, characterId)
        .first();
      if (reciprocal) {
        intenseBonus += 10;
      }
    }
  }

  const wonderPoints = wonderBase + intenseBonus;
  const feelingPoints = feelingBase + intenseBonus;

  // 同时更新角色卡的 wonder_points 和 feeling_points
  await db
    .prepare(
      `
      UPDATE characters
      SET wonder_points = ?, feeling_points = ?, updated_at = datetime('now')
      WHERE id = ?
      `
    )
    .bind(wonderPoints, feelingPoints, characterId)
    .run();

  return {
    wonderPoints,
    feelingPoints,
    details: {
      wonderBonds,
      feelingBonds,
      intenseBonus,
    },
  };
}

// 弱点类型：可以是纯字符串或包含 name 属性的对象
type Weakness = { name: string; description?: string } | string;

function getWeaknessModifier(weaknesses: Weakness[]): number {
  let modifier = 0;
  for (const w of weaknesses) {
    const name = typeof w === 'string' ? w : w?.name;
    if (typeof name === 'string' && (name.includes('装腔作势') || name.includes('囂俳'))) {
      modifier += 2;
    }
  }
  return modifier;
}

function getAbilityDiscount(fromWeaknesses: Weakness[]): number {
  for (const w of fromWeaknesses) {
    const name = typeof w === 'string' ? w : w?.name;
    if (typeof name === 'string' && (name.includes('寂寞难耐') || name.includes('寂しがり屋'))) {
      return -1;
    }
  }
  return 0;
}

interface DreamCostResult {
  baseCost: number;
  modifier: number;
  abilityDiscount: number;
  totalCost: number;
  canAfford: boolean;
}

/**
 * 计算牵绊升级消耗的梦点数
 * @param currentLevel 当前牵绊等级
 * @param targetLevel 目标牵绊等级
 * @param weaknesses 目标角色弱点数组
 * @param availableDreamPoints 可用梦点数（可选，用于判断 canAfford）
 * @param fromWeaknesses 发起方角色弱点数组（可选，用于检查「人见人爱」减免）
 */
export function calculateDreamCost(
  currentLevel: number,
  targetLevel: number,
  weaknesses: Weakness[],
  availableDreamPoints?: number,
  fromWeaknesses?: Weakness[]
): DreamCostResult {
  if (targetLevel <= currentLevel) {
    return {
      baseCost: 0,
      modifier: 0,
      abilityDiscount: 0,
      totalCost: 0,
      canAfford: true,
    };
  }

  let baseCost = 0;
  for (let lv = currentLevel + 1; lv <= targetLevel; lv++) {
    baseCost += LEVEL_COST[lv] || 0;
  }

  const modifier = getWeaknessModifier(weaknesses);
  const abilityDiscount = fromWeaknesses ? getAbilityDiscount(fromWeaknesses) : 0;
  const totalCost = Math.max(0, baseCost + modifier + abilityDiscount);

  return {
    baseCost,
    modifier,
    abilityDiscount,
    totalCost,
    canAfford: availableDreamPoints !== undefined ? availableDreamPoints >= totalCost : false,
  };
}
