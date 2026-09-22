-- 迁移：归档增加对话记录条数（room_archives.transcript_count）
-- 日期：2026-09-22
-- 背景：实时语音转写（transcript_segments）的内容要并入房间归档快照，
--       列表页需要展示「对话条数」，故在 room_archives 上加计数列。
--
-- ⚠️ 执行前必须先预检：SQLite 的 ALTER TABLE ADD COLUMN 不幂等，重复执行会报错。
--    SELECT (SELECT COUNT(*) FROM pragma_table_info('room_archives')
--            WHERE name='transcript_count') AS has_col;   -- 必须为 0 才执行
--
-- 执行后回读校验（NULL 计数必须为 0）：
--    SELECT (SELECT COUNT(*) FROM pragma_table_info('room_archives')
--            WHERE name='transcript_count') AS has_col,
--           (SELECT COUNT(*) FROM room_archives WHERE transcript_count IS NULL) AS null_cnt;
--
-- 已执行记录：2026-09-22 于生产库 xiyao-wanyao-db 执行完毕
--   has_col 0→1，null_cnt=0，3 条既有归档数据无损（默认 0）。

ALTER TABLE room_archives ADD COLUMN transcript_count INTEGER NOT NULL DEFAULT 0;
