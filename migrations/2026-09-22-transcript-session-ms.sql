-- 迁移：transcript_sessions 增加毫秒精度的会话起点（started_at_ms）
-- 日期：2026-09-22
-- 背景：DC-01 用例发现 abs_start_ms 偏差约 1.5 秒，超过 1 秒判定阈值。
--       根因：started_at 用 SQLite datetime('now')，只有秒级精度，截断即损失最多 999ms。
--       本列记录会话创建时的服务器毫秒时间戳，chunk 落库时的时间基准改用它。
--
-- ⚠️ 执行前必须预检（ALTER TABLE ADD COLUMN 不幂等）：
--    SELECT (SELECT COUNT(*) FROM pragma_table_info('transcript_sessions')
--            WHERE name='started_at_ms') AS has_col;   -- 必须为 0 才执行
--
-- 执行后回读校验（NULL 计数必须为 0）：
--    SELECT (SELECT COUNT(*) FROM pragma_table_info('transcript_sessions')
--            WHERE name='started_at_ms') AS has_col,
--           (SELECT COUNT(*) FROM transcript_sessions WHERE started_at_ms IS NULL) AS null_cnt;
--
-- 已执行记录：2026-09-22 于生产库 xiyao-wanyao-db 执行完毕
--   has_col 0→1，回填 25 行为 started_at 的秒级时间 ×1000（changes=25）。
--   注意：回填的存量会话仍有 ≤1s 误差（秒级时间无法还原毫秒），新会话不受影响。

ALTER TABLE transcript_sessions ADD COLUMN started_at_ms INTEGER;

UPDATE transcript_sessions
   SET started_at_ms = CAST(strftime('%s', started_at) AS INTEGER) * 1000
 WHERE started_at_ms IS NULL;
