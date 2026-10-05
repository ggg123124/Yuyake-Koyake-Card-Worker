-- 迁移：读量预算索引（D1 行读量热点治理）
-- 日期：2026-10-05
-- 背景：线上 24h 读了 7,256,248 行（免费档上限 5,000,000/天），均读 490 行/查询。
--       用 EXPLAIN QUERY PLAN + 真实参数实测出下列全表/全索引扫描，而表都很小
--       （transcript_segments 2385 行、resource_logs 427、room_members 76、characters 66、rooms 50），
--       每次 SCAN 都把整表读一遍，是读量的主要来源：
--
--         | 位置                                        | 查询                                        | 当前计划                             | 实测读行 |
--         |--------------------------------------------|---------------------------------------------|--------------------------------------|---------|
--         | src/index.ts sweepSummaries（每 2 分钟）     | ts.created_at >= datetime('now','-10 minutes') | SCAN ts USING INDEX idx_ts_segments_room | 2468 |
--         | src/api/summarize.ts maybeSummarize          | MAX(abs_end_ms) WHERE room_id=?              | 读该房全部段落                        | 1886  |
--         | src/api/summarize.ts maybeSummarize          | sessions LEFT JOIN segments GROUP BY s.id    | 逐会话读全部段落                      | 3811  |
--         | src/api/summarize.ts / rooms.ts / archives.ts | resource_logs WHERE room_code=? [AND created_at>=?] | SCAN rl                        | 427   |
--         | src/api/characters.ts                        | characters WHERE user_id=?                   | SCAN characters                       | 67    |
--         | src/api/rooms.ts GET /mine                   | room_members WHERE user_id=?                 | SCAN rm                               | 76    |
--
-- 幂等性：全部使用 CREATE INDEX IF NOT EXISTS，**对同一库重复执行为完全无副作用的空操作**
--         （索引已存在则跳过，不报错、不改数据），可安全重跑。
--
-- 执行后回读校验（7 条都应返回 1）：
--    SELECT (SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_ts_segments_room_end')        AS a,
--           (SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_ts_segments_session_end')     AS b,
--           (SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_ts_segments_session_created') AS c,
--           (SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_ts_segments_created')         AS d,
--           (SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_reslog_room_created')         AS e,
--           (SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_characters_user')             AS f,
--           (SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_room_members_user')           AS g;
--
-- 有效性校验：对上述查询逐条跑 EXPLAIN QUERY PLAN，必须看到 SEARCH ... USING INDEX，不能再出现 SCAN。
--
-- 已执行记录：2026-10-05 于本地库 .wrangler/e2e-brief 执行完毕（生产库由主控执行）

-- 房间维度取素材水位 MAX(abs_end_ms)：既有 idx_ts_segments_room 是 (room_id, abs_start_ms)，
-- 取 abs_end_ms 的 MAX 只能扫该房全部段落；改为覆盖 (room_id, abs_end_ms) 后 SQLite 直接取索引末端。
CREATE INDEX IF NOT EXISTS idx_ts_segments_room_end      ON transcript_segments(room_id, abs_end_ms);

-- 会话维度水位（相关子查询按 session_id 取 MAX）：既有 idx_ts_segments_session 是
-- (session_id, chunk_seq, seg_index)，用不上 abs_end_ms / created_at，故补两条覆盖索引。
CREATE INDEX IF NOT EXISTS idx_ts_segments_session_end   ON transcript_segments(session_id, abs_end_ms);
CREATE INDEX IF NOT EXISTS idx_ts_segments_session_created ON transcript_segments(session_id, created_at);

-- cron 选活跃房：按「素材真正入库的墙钟时间」做范围查（SCAN → SEARCH）。
CREATE INDEX IF NOT EXISTS idx_ts_segments_created       ON transcript_segments(created_at);

-- 资源流水：摘要窗口按 (room_code, created_at) 取区间，房间日志/归档按 room_code 取全部。
CREATE INDEX IF NOT EXISTS idx_reslog_room_created       ON resource_logs(room_code, created_at);

-- 角色卡列表按 user_id 过滤（SCAN characters → SEARCH）。
CREATE INDEX IF NOT EXISTS idx_characters_user           ON characters(user_id);

-- 大厅「我加入的房间」按 user_id 过滤（SCAN rm → SEARCH）。
CREATE INDEX IF NOT EXISTS idx_room_members_user         ON room_members(user_id);
