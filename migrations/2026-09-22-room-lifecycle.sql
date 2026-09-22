-- 迁移：房间生命周期（活跃时间 + 归档）
-- 日期：2026-09-22

-- 1. rooms 增加 last_active_at 列
ALTER TABLE rooms ADD COLUMN last_active_at TEXT;

-- 2. 回填已有房间：用 created_at 作为初始 last_active_at
UPDATE rooms SET last_active_at = COALESCE(last_active_at, created_at);

-- 3. 房间归档表
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
  snapshot TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_room_archives_room ON room_archives(room_id);
CREATE INDEX IF NOT EXISTS idx_room_archives_archived_at ON room_archives(archived_at DESC);

-- 4. 房间归档查看权限表
CREATE TABLE IF NOT EXISTS room_archive_viewers (
  archive_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  character_name TEXT,
  role TEXT,
  PRIMARY KEY (archive_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_archive_viewers_user ON room_archive_viewers(user_id);
