import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  disableSummaryForRoom,
  DISABLE_SUMMARY_SQL,
  type SummaryGateDb,
} from '../src/api/summarize';

// 「房间没人时自动关闭摘要开关」的 SQL 语义单测。
// 用 node:sqlite 跑真的 SQL（不是字符串比对）：D1 就是 SQLite，语句在两边语义一致，
// 因此 changes 的取值、以及「已经是 0 时不重复写库」这两件事都能被真实验证。
//
// 覆盖：① summary_enabled=1 → 0（changes=1）；② 已经=0 时不重复写（changes=0，触发器计数不增）；
// ③ 房间不存在（changes=0）；④ 两种 changes 都必须留一行日志（禁静默）；⑤ SQL 守卫条件不能被误删。

interface Harness {
  db: SummaryGateDb;
  enabled(roomId: string): number | null; // 读回 summary_enabled；房间不存在返回 null
  writeTriggerCount(): number; // rooms 表上真实发生的 UPDATE 次数
}

function makeHarness(): Harness {
  const raw = new DatabaseSync(':memory:');
  raw.exec(`
    CREATE TABLE rooms (id TEXT PRIMARY KEY, summary_enabled INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE rooms_writes (n INTEGER NOT NULL);
    INSERT INTO rooms_writes (n) VALUES (0);
    CREATE TRIGGER rooms_summary_upd AFTER UPDATE ON rooms BEGIN
      UPDATE rooms_writes SET n = n + 1;
    END;
  `);

  const db: SummaryGateDb = {
    prepare(sql: string) {
      const stmt = raw.prepare(sql);
      return {
        bind(...values: unknown[]) {
          return {
            run: async () => {
              const r = stmt.run(...(values as Array<string | number | null>));
              return { meta: { changes: Number(r.changes) } };
            },
          };
        },
      };
    },
  };

  return {
    db,
    enabled(roomId: string) {
      const row = raw.prepare('SELECT summary_enabled AS v FROM rooms WHERE id = ?').get(roomId) as
        | { v: number }
        | undefined;
      return row ? Number(row.v) : null;
    },
    writeTriggerCount() {
      const row = raw.prepare('SELECT n FROM rooms_writes').get() as { n: number };
      return Number(row.n);
    },
  };
}

let h: Harness;
let logs: string[];

beforeEach(() => {
  h = makeHarness();
  logs = [];
  vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('disableSummaryForRoom：按 roomId 关闭摘要开关', () => {
  it('① summary_enabled=1 → 0：changes=1，库里真的变成 0，日志一行', async () => {
    await h.db.prepare('INSERT INTO rooms (id, summary_enabled) VALUES (?, ?)').bind('GAPTEST', 1).run();
    expect(h.enabled('GAPTEST')).toBe(1);
    expect(h.writeTriggerCount()).toBe(0); // INSERT 不算 UPDATE

    const n = await disableSummaryForRoom(h.db, 'GAPTEST', 'idle-no-connections');
    expect(n).toBe(1);
    expect(h.enabled('GAPTEST')).toBe(0);
    expect(h.writeTriggerCount()).toBe(1);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('[summary] auto-disable room=GAPTEST reason=idle-no-connections changes=1');
  });

  it('② 已经=0 时不重复写：changes=0、值仍是 0、UPDATE 触发器不再计数，但日志照样有一行', async () => {
    await h.db.prepare('INSERT INTO rooms (id, summary_enabled) VALUES (?, ?)').bind('IDLE', 0).run();
    expect(h.writeTriggerCount()).toBe(0);

    const first = await disableSummaryForRoom(h.db, 'IDLE', 'idle-no-connections');
    expect(first).toBe(0);
    expect(h.writeTriggerCount()).toBe(0); // 守卫条件 summary_enabled = 1 让它一行都没写
    expect(h.enabled('IDLE')).toBe(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('changes=0'); // 禁静默：changes=0 也要有一行

    logs = [];
    const again = await disableSummaryForRoom(h.db, 'IDLE', 'no-members');
    expect(again).toBe(0);
    expect(h.writeTriggerCount()).toBe(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('[summary] auto-disable room=IDLE reason=no-members changes=0');
  });

  it('①→② 连打两次：第一次真关（changes=1），第二次不重复写（changes=0）', async () => {
    await h.db.prepare('INSERT INTO rooms (id, summary_enabled) VALUES (?, ?)').bind('TWICE', 1).run();

    expect(await disableSummaryForRoom(h.db, 'TWICE', 'idle-no-connections')).toBe(1);
    expect(await disableSummaryForRoom(h.db, 'TWICE', 'idle-no-connections')).toBe(0);
    expect(h.writeTriggerCount()).toBe(1); // 只有一次真实写库
    expect(h.enabled('TWICE')).toBe(0);
    expect(logs.map((l) => (l.includes('changes=1') ? 1 : 0))).toEqual([1, 0]);
  });

  it('③ 房间不存在：changes=0，仍留一行日志（不静默、不抛）', async () => {
    const n = await disableSummaryForRoom(h.db, 'NOSUCH', 'no-members');
    expect(n).toBe(0);
    expect(h.enabled('NOSUCH')).toBeNull();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('[summary] auto-disable room=NOSUCH reason=no-members changes=0');
  });

  it('只影响目标房间：别的房间的开关不被动', async () => {
    await h.db.prepare('INSERT INTO rooms (id, summary_enabled) VALUES (?, ?)').bind('A', 1).run();
    await h.db.prepare('INSERT INTO rooms (id, summary_enabled) VALUES (?, ?)').bind('B', 1).run();
    await disableSummaryForRoom(h.db, 'A', 'idle-no-connections');
    expect(h.enabled('A')).toBe(0);
    expect(h.enabled('B')).toBe(1);
  });

  it('⑤ SQL 守卫不能被误删：必须同时含「置 0」和「只动还开着的行」', () => {
    expect(DISABLE_SUMMARY_SQL).toBe(
      'UPDATE rooms SET summary_enabled = 0 WHERE id = ? AND summary_enabled = 1'
    );
    expect(DISABLE_SUMMARY_SQL).toMatch(/SET\s+summary_enabled\s*=\s*0/);
    expect(DISABLE_SUMMARY_SQL).toMatch(/AND\s+summary_enabled\s*=\s*1/);
  });
});
