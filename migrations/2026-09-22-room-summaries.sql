-- 迁移：跑团事件摘要（每约 2 分钟由 LLM 汇总一次）
-- 日期：2026-09-22
-- 背景：语音转写逐句文本信息密度低，改为按时间窗汇总成「事件摘要」：
--       把窗口内的语音转写 + 游戏操作（发梦点/扣心意点/阶段推进等）一起喂给
--       Workers AI 的 LLM，产出一条人可读的事件记录。
--
-- ⚠️ 执行前预检（CREATE TABLE IF NOT EXISTS 本身幂等，此步用于确认现状）：
--    SELECT (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='room_summaries') AS has_table;
--
-- 执行后回读校验：
--    SELECT (SELECT COUNT(*) FROM pragma_table_info('room_summaries')) AS n_cols,
--           (SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_summaries_room') AS has_idx;

CREATE TABLE IF NOT EXISTS room_summaries (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  -- 覆盖的绝对时间窗（毫秒时间戳，与 transcript_segments.abs_start_ms 同一基准，天然跨人合并）
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  summary TEXT NOT NULL,
  model TEXT NOT NULL,
  source_segments INTEGER NOT NULL DEFAULT 0,
  source_logs INTEGER NOT NULL DEFAULT 0,
  token_usage TEXT,
  latency_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 并发防护：并发触发时会算出同一个窗口起点，唯一索引挡掉重复摘要
CREATE UNIQUE INDEX IF NOT EXISTS uniq_summary_window ON room_summaries(room_id, start_ms);
