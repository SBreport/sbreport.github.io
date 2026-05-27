CREATE TABLE IF NOT EXISTS search_history (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  keyword       TEXT NOT NULL,
  pc_volume     INTEGER,
  mobile_volume INTEGER,
  competition   TEXT,
  sections_json TEXT,
  keyword_type  INTEGER,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_search_history_user ON search_history(user_id, created_at DESC);
