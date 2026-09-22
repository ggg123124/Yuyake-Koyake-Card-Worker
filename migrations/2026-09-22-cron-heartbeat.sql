-- 迁移：定时任务心跳（cron_heartbeat）
-- 日期：2026-09-22
-- 背景：wrangler tail 只展示 fetch 事件、不展示 scheduled 事件，
--       导致「每分钟的摘要兜底 cron 到底有没有被触发」无法核查。
--       让 sweep 每次执行写一行心跳，即可用查库代替看日志来确认。
--
-- 已执行记录：2026-09-22 于生产库 xiyao-wanyao-db 执行完毕（CREATE TABLE + 索引）

CREATE TABLE IF NOT EXISTS cron_heartbeat (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job TEXT NOT NULL,
  scanned INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_heartbeat_job ON cron_heartbeat(job, at DESC);
