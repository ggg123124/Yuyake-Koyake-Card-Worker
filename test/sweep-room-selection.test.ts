import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { MAX_WINDOW_MS } from '../src/api/summarize';

// sweep 选房两条 SQL 的真实执行验证（不是字符串比对）。
// 语句从 src/index.ts 原文里提取（marker 之间），跑在用 schema.sql 建出来的真 SQLite 库上：
// D1 本身就是 SQLite，同一份 SQL 文本 + 同一套索引，选房结果与查询计划都能在本地实测出来。
//
// 覆盖：
//   ① 三类房间的选房结果：活跃房 / 积压未追平房 / 关掉开关的房（外加已追平、无素材两类不该选中的）
//   ② 同一房间同时命中两类来源时去重成一个（不重复追补）
//   ③ EXPLAIN QUERY PLAN：两条查询都不出现对 transcript_segments / room_summaries 的 SCAN
//   ④ 积压阈值引用 MAX_WINDOW_MS，不硬编码毫秒数

const INDEX_TS = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8');
const SCHEMA_SQL = readFileSync(fileURLToPath(new URL('../schema.sql', import.meta.url)), 'utf8');

// 从 /* SWEEP_SQL_START */ ... /* SWEEP_SQL_END */ 之间取出语句模板原文。
// 语句里唯一的插值是 ${MAX_WINDOW_MS}，替换成真实常量值后就是 D1 会执行的 SQL。
function extractSweepSql(name: string): string {
  const region = /\/\* SWEEP_SQL_START \*\/([\s\S]*?)\/\* SWEEP_SQL_END \*\//.exec(INDEX_TS);
  expect(region, 'src/index.ts 里找不到 SWEEP_SQL marker').toBeTruthy();
  const raw = new RegExp('export const ' + name + ' =\\s*`([\\s\\S]*?)`;').exec(region![1]);
  expect(raw, `src/index.ts 里找不到 export const ${name}`).toBeTruthy();
  return raw![1].replace(/\$\{MAX_WINDOW_MS\}/g, String(MAX_WINDOW_MS));
}

const ACTIVE_SQL = extractSweepSql('SWEEP_ACTIVE_ROOMS_SQL');
const BACKLOG_SQL = extractSweepSql('SWEEP_BACKLOG_ROOMS_SQL');

const WATERMARK = 1_000_000; // 锚点基准（ms）；各房间的素材水位在它上面按落后量铺开
const LAG_27MIN = 27 * 60_000; // 线上 SVS3C 那批永远补不上的素材：锚点落后水位 27 分钟

interface Seg {
  room: string;
  absEndMs: number;
  createdAtSql: string; // 用 'now' 的相对表达式，让「近 10 分钟」跟着真实墙钟走
}

// 夹具房间：
//   ACTIVE      近 1 分钟有素材、锚点已追平水位        → 只该被 ① 选中
//   BACKLOG     素材停在 1 小时前（跑团结束）、落后 27 分钟 → 只该被 ② 选中（线上缺陷形态）
//   BOTH        近 1 分钟有素材、同时落后 27 分钟        → ①② 都命中，去重后只追补一次
//   OFF         开关关闭，形态和 BOTH 一样              → 两类都不该选中
//   CAUGHT_UP   开关开启、素材久远、落后正好 = 阈值      → 不该选中（比较是严格大于）
//   NO_MATERIAL 开关开启、一条素材都没有                → 不该选中（MAX 为 NULL）
function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA_SQL);
  const rooms: Array<[string, number]> = [
    ['ACTIVE', 1],
    ['BACKLOG', 1],
    ['BOTH', 1],
    ['OFF', 0],
    ['CAUGHT_UP', 1],
    ['NO_MATERIAL', 1],
  ];
  for (const [id, enabled] of rooms) {
    db.prepare('INSERT INTO rooms (id, name, summary_enabled) VALUES (?, ?, ?)').run(id, id, enabled);
  }

  const segs: Seg[] = [
    { room: 'ACTIVE', absEndMs: WATERMARK, createdAtSql: "datetime('now','-1 minutes')" },
    { room: 'BACKLOG', absEndMs: WATERMARK + LAG_27MIN, createdAtSql: "datetime('now','-60 minutes')" },
    { room: 'BOTH', absEndMs: WATERMARK + LAG_27MIN, createdAtSql: "datetime('now','-1 minutes')" },
    { room: 'OFF', absEndMs: WATERMARK + LAG_27MIN, createdAtSql: "datetime('now','-1 minutes')" },
    { room: 'CAUGHT_UP', absEndMs: WATERMARK + MAX_WINDOW_MS, createdAtSql: "datetime('now','-60 minutes')" },
  ];
  segs.forEach((s, i) => {
    // created_at 必须是 SQLite 求值出来的墙钟时间，所以把表达式内联进语句（值只有本文件里两个固定字面量）；
    // 用 ? 绑定会把 "datetime('now','-60 minutes')" 当字符串原样存进列，活跃判定就变成文本比较，测试结果不可信。
    db.prepare(
      `INSERT INTO transcript_segments
       (id, session_id, room_id, user_id, chunk_seq, seg_index, start_ms, end_ms,
        abs_start_ms, abs_end_ms, text, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${s.createdAtSql})`
    ).run(
      `seg${i}`, `ss${i}`, s.room, 'u1', i, i, 0, 1000,
      s.absEndMs - 1000, s.absEndMs, '台词'
    );
  });

  // 每个有素材的房间一条已有摘要，end_ms = 锚点 WATERMARK（NO_MATERIAL 没有摘要）
  for (const room of ['ACTIVE', 'BACKLOG', 'BOTH', 'OFF', 'CAUGHT_UP']) {
    db.prepare(
      `INSERT INTO room_summaries (id, room_id, start_ms, end_ms, summary, model)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(`sum-${room}`, room, WATERMARK - MAX_WINDOW_MS, WATERMARK, '摘要', 'm');
  }
  return db;
}

function selectAll(db: DatabaseSync, sql: string): string[] {
  return (db.prepare(sql).all() as Array<{ room_id: string }>).map((r) => r.room_id).sort();
}

function queryPlan(db: DatabaseSync, sql: string): string[] {
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map(
    (r) => String(r.detail)
  );
}

describe('sweep 选房 SQL（真 SQLite 上实测）', () => {
  it('① 活跃房：只选中近 10 分钟有素材入库且开关开启的房间', () => {
    const db = freshDb();
    const stored = db
      .prepare('SELECT created_at FROM transcript_segments WHERE room_id = ?')
      .get('BACKLOG') as { created_at: string };
    expect(stored.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const rows = selectAll(db, ACTIVE_SQL);
    console.log('[sweep-sql] ① 活跃房 →', JSON.stringify(rows));
    expect(rows).toEqual(['ACTIVE', 'BOTH']);
  });

  it('② 积压未追平房：锚点落后素材水位 > MAX_WINDOW_MS 的开关开启房间被选中', () => {
    const rows = selectAll(freshDb(), BACKLOG_SQL);
    console.log('[sweep-sql] ② 积压房 →', JSON.stringify(rows));
    expect(rows).toEqual(['BACKLOG', 'BOTH']);
  });

  it('三类房间各选不选中：活跃 ✅ / 积压未追平 ✅ / 关掉开关 ❌', () => {
    const db = freshDb();
    const merged = [...new Set([...selectAll(db, ACTIVE_SQL), ...selectAll(db, BACKLOG_SQL)])].sort();
    console.log('[sweep-sql] 去重后 →', JSON.stringify(merged));
    expect(merged).toEqual(['ACTIVE', 'BACKLOG', 'BOTH']); // 活跃 / 积压都进来
    expect(merged).not.toContain('OFF'); // 开关关闭：两类来源都挡掉，不烧 AI
    expect(merged).not.toContain('CAUGHT_UP'); // 落后正好等于阈值 = 已追平
    expect(merged).not.toContain('NO_MATERIAL'); // 无素材：MAX 为 NULL，不参与比较
  });

  it('同一房间同时命中两类来源时，去重后只处理一次', () => {
    const db = freshDb();
    const active = selectAll(db, ACTIVE_SQL);
    const backlog = selectAll(db, BACKLOG_SQL);
    expect(active).toContain('BOTH');
    expect(backlog).toContain('BOTH');
    const merged = [...new Set([...active, ...backlog])];
    expect(merged.filter((id) => id === 'BOTH')).toHaveLength(1);
  });

  it('两条查询都不出现对 transcript_segments / room_summaries 的 SCAN', () => {
    const db = freshDb();
    const bigTables = new Set(['transcript_segments', 'room_summaries', 'ts', 't', 's']);
    const cases: Array<[string, string, RegExp[]]> = [
      ['①活跃', ACTIVE_SQL, [/INDEX idx_ts_segments_created/]],
      ['②积压', BACKLOG_SQL, [/INDEX idx_ts_segments_room_end/, /INDEX uniq_summary_window/]],
    ];
    for (const [label, sql, mustUse] of cases) {
      const plan = queryPlan(db, sql);
      console.log(`[sweep-sql] EXPLAIN QUERY PLAN ${label}:\n  ${plan.join('\n  ')}`);
      for (const line of plan) {
        const scan = /^SCAN\s+(\S+)/.exec(line);
        if (scan) {
          expect(bigTables.has(scan[1]), `${label} 计划里出现大表全表扫描：${line}`).toBe(false);
        }
      }
      // rooms 只有几十行，SCAN r 可接受；但两张大表必须走索引
      const joined = plan.join('\n');
      for (const re of mustUse) expect(joined, `${label} 计划没走预期索引：${joined}`).toMatch(re);
    }
  });

  it('积压阈值引用 MAX_WINDOW_MS，不硬编码毫秒数', () => {
    const region = /\/\* SWEEP_SQL_START \*\/([\s\S]*?)\/\* SWEEP_SQL_END \*\//.exec(INDEX_TS)![1];
    expect(region).toContain('${MAX_WINDOW_MS}');
    expect(region).not.toMatch(/\b300_?000\b/);
    expect(BACKLOG_SQL).toContain(`+ ${MAX_WINDOW_MS}`);
  });

  it('空库（无房间无素材）时两条查询都返回 0 行且不报错', () => {
    const empty = new DatabaseSync(':memory:');
    empty.exec(SCHEMA_SQL);
    expect(selectAll(empty, ACTIVE_SQL)).toEqual([]);
    expect(selectAll(empty, BACKLOG_SQL)).toEqual([]);
  });

  it('房间销毁后残留素材不会被 ② 反复选中（选房以 rooms 表为准）', () => {
    const db = freshDb();
    db.prepare('DELETE FROM rooms WHERE id = ?').run('BACKLOG');
    const rows = selectAll(db, BACKLOG_SQL);
    console.log('[sweep-sql] 删掉 BACKLOG 房间后 →', JSON.stringify(rows));
    expect(rows).not.toContain('BACKLOG');
  });

  it('积压没追平的判定跟着 MAX_WINDOW_MS 走：落后量刚跨过阈值就入选', () => {
    const db = freshDb();
    // CAUGHT_UP 落后量 = 阈值（不入选）；再往前提 1ms 就应入选
    db.prepare('UPDATE transcript_segments SET abs_end_ms = ? WHERE room_id = ?')
      .run(WATERMARK + MAX_WINDOW_MS + 1, 'CAUGHT_UP');
    const rows = selectAll(db, BACKLOG_SQL);
    console.log('[sweep-sql] CAUGHT_UP 落后 = 阈值+1ms →', JSON.stringify(rows));
    expect(rows).toContain('CAUGHT_UP');
  });
});
