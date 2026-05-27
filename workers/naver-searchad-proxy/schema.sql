-- 분석기 웹앱 D1 스키마 (기획서 8장)
-- 마이그레이션: users 테이블 (승인제) + search_history 테이블 (검색 이력)

CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  google_sub      TEXT NOT NULL UNIQUE,           -- 구글 OAuth 고유 ID
  email           TEXT NOT NULL,
  name            TEXT,
  picture         TEXT,
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | approved | suspended
  plan            TEXT NOT NULL DEFAULT 'free',    -- free | pro
  plan_expires_at TEXT,                            -- ISO8601, null=무기한
  approved_at     TEXT,
  created_at      TEXT NOT NULL,
  last_login_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

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
