-- 迁移：语音转写记录（P0）
-- 日期：2026-09-22
-- 说明：每场团每个玩家各自录制自己的麦克风，转写后上传带时间戳的文本段，
--      服务器按校准时间戳合并成对话时间线，房间归档时并入快照。

-- 1. 会话表：一次「开始记录 → 停止记录」为一个 session
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
  device_label TEXT
);

CREATE INDEX IF NOT EXISTS idx_ts_sessions_room ON transcript_sessions(room_id);
CREATE INDEX IF NOT EXISTS idx_ts_sessions_user ON transcript_sessions(user_id);

-- 2. 文本段表：转写结果，带「校准后的绝对时间戳」（毫秒），便于跨人合并
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

-- 3. 房间词表（供 Whisper initial_prompt 使用；GM 可编辑，为空时用角色名+内置术语）
CREATE TABLE IF NOT EXISTS transcript_glossary (
  room_id TEXT PRIMARY KEY,
  extra_terms TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
