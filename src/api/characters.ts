import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth';
import { Bindings, Variables } from '../types';
import { clampInt, strLen } from '../utils/validate';

const route = new Hono<{ Bindings: Bindings; Variables: Variables }>();

route.use('*', authMiddleware);

// 辅助函数：将 JSON 字符串字段解析为对象
function parseCharacter(row: Record<string, unknown>) {
  return {
    ...row,
    abilities: row.abilities ? JSON.parse(row.abilities as string) : null,
    weaknesses: row.weaknesses ? JSON.parse(row.weaknesses as string) : null,
    extraAbilities: row.extra_abilities ? JSON.parse(row.extra_abilities as string) : null,
  };
}

// POST / - 创建角色卡
route.post('/', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json<{
    name?: string;
    trueForm?: string;
    humanAge?: number;
    gender?: string;
    humanAppearance?: string;
    trueAppearance?: string;
    attrHenge?: number;
    attrAnimal?: number;
    attrAdult?: number;
    attrChild?: number;
    abilities?: unknown;
    weaknesses?: unknown;
    extraAbilities?: unknown;
    dreamPoints?: number;
    wonderPoints?: number;
    feelingPoints?: number;
    memories?: number;
  }>();

  if (!body.name || typeof body.name !== 'string') {
    return c.json({ error: '角色名不能为空' }, 400);
  }
  if (!body.trueForm || typeof body.trueForm !== 'string') {
    return c.json({ error: '真身不能为空' }, 400);
  }

  if (!strLen(body.name, 50)) return c.json({ error: '角色名不能超过 50 字符' }, 400);
  if (!strLen(body.trueForm, 20)) return c.json({ error: '真身不能超过 20 字符' }, 400);
  if (!strLen(body.humanAppearance, 2000)) return c.json({ error: '人类外貌描述不能超过 2000 字符' }, 400);
  if (!strLen(body.trueAppearance, 2000)) return c.json({ error: '真身外貌描述不能超过 2000 字符' }, 400);
  if (!strLen(body.gender, 10)) return c.json({ error: '性别不能超过 10 字符' }, 400);
  if (body.abilities !== undefined && JSON.stringify(body.abilities).length > 8000) return c.json({ error: '能力列表过长' }, 400);
  if (body.weaknesses !== undefined && JSON.stringify(body.weaknesses).length > 8000) return c.json({ error: '弱点列表过长' }, 400);
  if (body.extraAbilities !== undefined && JSON.stringify(body.extraAbilities).length > 8000) return c.json({ error: '额外能力列表过长' }, 400);

  const attrHenge = clampInt(body.attrHenge, { min: 0, max: 4, def: 1 });
  const attrAnimal = clampInt(body.attrAnimal, { min: 0, max: 4, def: 1 });
  const attrAdult = clampInt(body.attrAdult, { min: 0, max: 4, def: 0 });
  const attrChild = clampInt(body.attrChild, { min: 0, max: 4, def: 1 });
  const dreamPoints = clampInt(body.dreamPoints, { min: 0, max: 9999, def: 0 });
  const wonderPoints = clampInt(body.wonderPoints, { min: 0, max: 9999, def: 0 });
  const feelingPoints = clampInt(body.feelingPoints, { min: 0, max: 9999, def: 0 });
  const memories = clampInt(body.memories, { min: 0, max: 9999, def: 0 });
  const humanAge = body.humanAge !== undefined ? clampInt(body.humanAge, { min: 0, max: 9999, def: 0 }) : null;

  const id = crypto.randomUUID();
  const db = c.env.DB;

  await db
    .prepare(
      `INSERT INTO characters (
        id, name, true_form, human_age, gender, human_appearance, true_appearance,
        attr_henge, attr_animal, attr_adult, attr_child,
        abilities, weaknesses, extra_abilities,
        dream_points, wonder_points, feeling_points, memories,
        user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      body.name,
      body.trueForm,
      humanAge,
      body.gender ?? null,
      body.humanAppearance ?? null,
      body.trueAppearance ?? null,
      attrHenge,
      attrAnimal,
      attrAdult,
      attrChild,
      body.abilities ? JSON.stringify(body.abilities) : null,
      body.weaknesses ? JSON.stringify(body.weaknesses) : null,
      body.extraAbilities ? JSON.stringify(body.extraAbilities) : null,
      dreamPoints,
      wonderPoints,
      feelingPoints,
      memories,
      userId
    )
    .run();

  const row = await db
    .prepare('SELECT * FROM characters WHERE id = ?')
    .bind(id)
    .first<Record<string, unknown>>();

  return c.json(parseCharacter(row!), 201);
});

// GET / - 获取当前用户的所有角色卡
route.get('/', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;

  const { results } = await db
    .prepare('SELECT * FROM characters WHERE user_id = ? ORDER BY created_at DESC')
    .bind(userId)
    .all<Record<string, unknown>>();

  return c.json(results.map(parseCharacter));
});

// GET /:id - 获取单个角色卡
route.get('/:id', async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;

  const row = await db
    .prepare('SELECT * FROM characters WHERE id = ?')
    .bind(id)
    .first<Record<string, unknown>>();

  if (!row) {
    return c.json({ error: '角色卡不存在' }, 404);
  }

  return c.json(parseCharacter(row));
});

// PUT /:id - 更新角色卡
route.put('/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const db = c.env.DB;

  const existing = await db
    .prepare('SELECT user_id FROM characters WHERE id = ?')
    .bind(id)
    .first<{ user_id: string }>();

  if (!existing) {
    return c.json({ error: '角色卡不存在' }, 404);
  }

  if (existing.user_id !== userId) {
    return c.json({ error: '无权更新此角色卡' }, 403);
  }

  const body = await c.req.json<{
    name?: string;
    trueForm?: string;
    humanAge?: number;
    gender?: string;
    humanAppearance?: string;
    trueAppearance?: string;
    attrHenge?: number;
    attrAnimal?: number;
    attrAdult?: number;
    attrChild?: number;
    abilities?: unknown;
    weaknesses?: unknown;
    extraAbilities?: unknown;
    dreamPoints?: number;
    wonderPoints?: number;
    feelingPoints?: number;
    memories?: number;
  }>();

  if (body.name !== undefined && !strLen(body.name, 50)) return c.json({ error: '角色名不能超过 50 字符' }, 400);
  if (body.trueForm !== undefined && !strLen(body.trueForm, 20)) return c.json({ error: '真身不能超过 20 字符' }, 400);
  if (body.humanAppearance !== undefined && !strLen(body.humanAppearance, 2000)) return c.json({ error: '人类外貌描述不能超过 2000 字符' }, 400);
  if (body.trueAppearance !== undefined && !strLen(body.trueAppearance, 2000)) return c.json({ error: '真身外貌描述不能超过 2000 字符' }, 400);
  if (body.gender !== undefined && !strLen(body.gender, 10)) return c.json({ error: '性别不能超过 10 字符' }, 400);
  if (body.abilities !== undefined && JSON.stringify(body.abilities).length > 8000) return c.json({ error: '能力列表过长' }, 400);
  if (body.weaknesses !== undefined && JSON.stringify(body.weaknesses).length > 8000) return c.json({ error: '弱点列表过长' }, 400);
  if (body.extraAbilities !== undefined && JSON.stringify(body.extraAbilities).length > 8000) return c.json({ error: '额外能力列表过长' }, 400);

  const fields: string[] = [];
  const values: unknown[] = [];

  if (body.name !== undefined) {
    fields.push('name = ?');
    values.push(body.name);
  }
  if (body.trueForm !== undefined) {
    fields.push('true_form = ?');
    values.push(body.trueForm);
  }
  if (body.humanAge !== undefined) {
    fields.push('human_age = ?');
    values.push(clampInt(body.humanAge, { min: 0, max: 9999, def: 0 }));
  }
  if (body.gender !== undefined) {
    fields.push('gender = ?');
    values.push(body.gender);
  }
  if (body.humanAppearance !== undefined) {
    fields.push('human_appearance = ?');
    values.push(body.humanAppearance);
  }
  if (body.trueAppearance !== undefined) {
    fields.push('true_appearance = ?');
    values.push(body.trueAppearance);
  }
  if (body.attrHenge !== undefined) {
    fields.push('attr_henge = ?');
    values.push(clampInt(body.attrHenge, { min: 0, max: 4, def: 1 }));
  }
  if (body.attrAnimal !== undefined) {
    fields.push('attr_animal = ?');
    values.push(clampInt(body.attrAnimal, { min: 0, max: 4, def: 1 }));
  }
  if (body.attrAdult !== undefined) {
    fields.push('attr_adult = ?');
    values.push(clampInt(body.attrAdult, { min: 0, max: 4, def: 0 }));
  }
  if (body.attrChild !== undefined) {
    fields.push('attr_child = ?');
    values.push(clampInt(body.attrChild, { min: 0, max: 4, def: 1 }));
  }
  if (body.abilities !== undefined) {
    fields.push('abilities = ?');
    values.push(JSON.stringify(body.abilities));
  }
  if (body.weaknesses !== undefined) {
    fields.push('weaknesses = ?');
    values.push(JSON.stringify(body.weaknesses));
  }
  if (body.extraAbilities !== undefined) {
    fields.push('extra_abilities = ?');
    values.push(JSON.stringify(body.extraAbilities));
  }
  if (body.dreamPoints !== undefined) {
    fields.push('dream_points = ?');
    values.push(clampInt(body.dreamPoints, { min: 0, max: 9999, def: 0 }));
  }
  if (body.wonderPoints !== undefined) {
    fields.push('wonder_points = ?');
    values.push(clampInt(body.wonderPoints, { min: 0, max: 9999, def: 0 }));
  }
  if (body.feelingPoints !== undefined) {
    fields.push('feeling_points = ?');
    values.push(clampInt(body.feelingPoints, { min: 0, max: 9999, def: 0 }));
  }
  if (body.memories !== undefined) {
    fields.push('memories = ?');
    values.push(clampInt(body.memories, { min: 0, max: 9999, def: 0 }));
  }

  if (fields.length === 0) {
    return c.json({ error: '未提供任何更新字段' }, 400);
  }

  fields.push('updated_at = datetime(\'now\')');
  values.push(id);

  await db
    .prepare(`UPDATE characters SET ${fields.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();

  const row = await db
    .prepare('SELECT * FROM characters WHERE id = ?')
    .bind(id)
    .first<Record<string, unknown>>();

  return c.json(parseCharacter(row!));
});

// DELETE /:id - 删除角色卡
route.delete('/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const db = c.env.DB;

  const existing = await db
    .prepare('SELECT user_id FROM characters WHERE id = ?')
    .bind(id)
    .first<{ user_id: string }>();

  if (!existing) {
    return c.json({ error: '角色卡不存在' }, 404);
  }

  if (existing.user_id !== userId) {
    return c.json({ error: '无权删除此角色卡' }, 403);
  }

  await db.prepare('DELETE FROM characters WHERE id = ?').bind(id).run();

  return c.json({ success: true });
});

export default route;
