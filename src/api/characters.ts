import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth';
import { Bindings, Variables } from '../types';

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
      body.humanAge ?? null,
      body.gender ?? null,
      body.humanAppearance ?? null,
      body.trueAppearance ?? null,
      body.attrHenge ?? 1,
      body.attrAnimal ?? 1,
      body.attrAdult ?? 0,
      body.attrChild ?? 1,
      body.abilities ? JSON.stringify(body.abilities) : null,
      body.weaknesses ? JSON.stringify(body.weaknesses) : null,
      body.extraAbilities ? JSON.stringify(body.extraAbilities) : null,
      body.dreamPoints ?? 0,
      body.wonderPoints ?? 0,
      body.feelingPoints ?? 0,
      body.memories ?? 0,
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
    values.push(body.humanAge);
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
    values.push(body.attrHenge);
  }
  if (body.attrAnimal !== undefined) {
    fields.push('attr_animal = ?');
    values.push(body.attrAnimal);
  }
  if (body.attrAdult !== undefined) {
    fields.push('attr_adult = ?');
    values.push(body.attrAdult);
  }
  if (body.attrChild !== undefined) {
    fields.push('attr_child = ?');
    values.push(body.attrChild);
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
    values.push(body.dreamPoints);
  }
  if (body.wonderPoints !== undefined) {
    fields.push('wonder_points = ?');
    values.push(body.wonderPoints);
  }
  if (body.feelingPoints !== undefined) {
    fields.push('feeling_points = ?');
    values.push(body.feelingPoints);
  }
  if (body.memories !== undefined) {
    fields.push('memories = ?');
    values.push(body.memories);
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
