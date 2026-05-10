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
  created_at TEXT DEFAULT (datetime('now')),
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
