-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 角色卡表
CREATE TABLE IF NOT EXISTS characters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  true_form TEXT NOT NULL,
  human_age INTEGER,
  gender TEXT,
  human_appearance TEXT,
  true_appearance TEXT,
  attr_henge INTEGER DEFAULT 1,
  attr_animal INTEGER DEFAULT 1,
  attr_adult INTEGER DEFAULT 0,
  attr_child INTEGER DEFAULT 1,
  abilities TEXT,
  weaknesses TEXT,
  extra_abilities TEXT,
  dream_points INTEGER DEFAULT 0,
  wonder_points INTEGER DEFAULT 0,
  feeling_points INTEGER DEFAULT 0,
  memories INTEGER DEFAULT 0,
  user_id TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 游戏房间表
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  name TEXT,
  gm_user_id TEXT,
  phase TEXT DEFAULT 'scene',
  last_active_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  -- 事件摘要开关（GM 控制）：默认 0 = 关，摘要链路一律短路，不做水位/素材查询也不调 AI。
  -- 见 migrations/2026-10-05-summary-toggle.sql
  summary_enabled INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (gm_user_id) REFERENCES users(id)
);

-- 房间-角色关联表
CREATE TABLE IF NOT EXISTS room_members (
  room_id TEXT NOT NULL,
  character_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT DEFAULT 'player',
  joined_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (room_id, character_id),
  FOREIGN KEY (room_id) REFERENCES rooms(id),
  FOREIGN KEY (character_id) REFERENCES characters(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 牵绊表
CREATE TABLE IF NOT EXISTS bonds (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  from_character_id TEXT,
  from_character_name TEXT,
  to_character_name TEXT NOT NULL,
  to_character_id TEXT,
  bond_type TEXT NOT NULL,
  bond_level INTEGER DEFAULT 1,
  is_intense INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (room_id) REFERENCES rooms(id),
  FOREIGN KEY (from_character_id) REFERENCES characters(id)
);

-- 资源变动日志表
CREATE TABLE IF NOT EXISTS resource_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_code TEXT NOT NULL,
  character_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  change_amount INTEGER NOT NULL,
  reason TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 背包物品表
CREATE TABLE IF NOT EXISTS inventory_items (
  id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (character_id) REFERENCES characters(id)
);

-- 房间归档表
CREATE TABLE IF NOT EXISTS room_archives (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  room_name TEXT,
  phase TEXT,
  room_created_at TEXT,
  archived_at TEXT NOT NULL DEFAULT (datetime('now')),
  archived_by TEXT,
  archive_reason TEXT NOT NULL,
  member_count INTEGER NOT NULL DEFAULT 0,
  log_count INTEGER NOT NULL DEFAULT 0,
  -- 见 migrations/2026-09-22-archive-transcript-count.sql
  transcript_count INTEGER NOT NULL DEFAULT 0,
  snapshot TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_room_archives_room ON room_archives(room_id);
CREATE INDEX IF NOT EXISTS idx_room_archives_archived_at ON room_archives(archived_at DESC);

-- 房间归档查看权限表
CREATE TABLE IF NOT EXISTS room_archive_viewers (
  archive_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  character_name TEXT,
  role TEXT,
  PRIMARY KEY (archive_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_archive_viewers_user ON room_archive_viewers(user_id);

-- ============================================================
-- 以下表原先只存在于 migrations/，schema.sql 建出来的本地库缺表，
-- 导致「--file=schema.sql 建库」后跑不了转写/摘要链路，也建不了 transcript_segments 上的索引。
-- 这里按 migrations 里的最终形态补齐（含后续迁移新增的列），全部 IF NOT EXISTS：
-- 对已按 migrations 建好的库重复执行 schema.sql 是安全的空操作。
-- ============================================================

-- 语音转写会话（migrations/2026-09-22-transcript.sql + 2026-09-22-transcript-session-ms.sql）
CREATE TABLE IF NOT EXISTS transcript_sessions (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  character_id TEXT,
  character_name TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  client_offset_ms INTEGER NOT NULL DEFAULT 0,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  segment_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'recording',
  device_label TEXT,
  -- 会话起点的服务器毫秒时间戳（datetime('now') 只有秒级精度，会丢最多 999ms）
  started_at_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_ts_sessions_room ON transcript_sessions(room_id);
CREATE INDEX IF NOT EXISTS idx_ts_sessions_user ON transcript_sessions(user_id);

-- 语音转写文本段（migrations/2026-09-22-transcript.sql）
CREATE TABLE IF NOT EXISTS transcript_segments (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  character_id TEXT,
  character_name TEXT,
  chunk_seq INTEGER NOT NULL,
  seg_index INTEGER NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  abs_start_ms INTEGER NOT NULL,
  abs_end_ms INTEGER NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ts_segments_room ON transcript_segments(room_id, abs_start_ms);
CREATE INDEX IF NOT EXISTS idx_ts_segments_session ON transcript_segments(session_id, chunk_seq, seg_index);
-- 幂等：同一 session 的同一片同一段只存一份（重传不产生脏数据）
CREATE UNIQUE INDEX IF NOT EXISTS uniq_ts_segment ON transcript_segments(session_id, chunk_seq, seg_index);

-- 房间词表（Whisper initial_prompt 用，GM 可编辑）
CREATE TABLE IF NOT EXISTS transcript_glossary (
  room_id TEXT PRIMARY KEY,
  extra_terms TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 跑团事件摘要（migrations/2026-09-22-room-summaries.sql）
CREATE TABLE IF NOT EXISTS room_summaries (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
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

-- 定时任务心跳（migrations/2026-09-22-cron-heartbeat.sql）
CREATE TABLE IF NOT EXISTS cron_heartbeat (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job TEXT NOT NULL,
  scanned INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_heartbeat_job ON cron_heartbeat(job, at DESC);

-- ============================================================
-- 读量预算索引（migrations/2026-10-05-read-budget-indexes.sql，两处必须保持同步）
-- 线上 24h 读了 7,256,248 行（免费档 5,000,000/天），下列索引把实测的 SCAN 变成 SEARCH。
-- ============================================================

-- 房间维度取素材水位 MAX(abs_end_ms)：idx_ts_segments_room 是 (room_id, abs_start_ms)，用不上
CREATE INDEX IF NOT EXISTS idx_ts_segments_room_end      ON transcript_segments(room_id, abs_end_ms);
-- 会话维度水位：按 session_id 取 MAX(abs_end_ms) / MAX(created_at)
CREATE INDEX IF NOT EXISTS idx_ts_segments_session_end   ON transcript_segments(session_id, abs_end_ms);
CREATE INDEX IF NOT EXISTS idx_ts_segments_session_created ON transcript_segments(session_id, created_at);
-- cron 选活跃房：按素材入库墙钟时间做范围查
CREATE INDEX IF NOT EXISTS idx_ts_segments_created       ON transcript_segments(created_at);
-- 资源流水：摘要窗口取 (room_code, created_at) 区间，房间日志/归档按 room_code 取全部
CREATE INDEX IF NOT EXISTS idx_reslog_room_created       ON resource_logs(room_code, created_at);
-- 角色卡列表按 user_id 过滤
CREATE INDEX IF NOT EXISTS idx_characters_user           ON characters(user_id);
-- 大厅「我加入的房间」按 user_id 过滤
CREATE INDEX IF NOT EXISTS idx_room_members_user         ON room_members(user_id);
