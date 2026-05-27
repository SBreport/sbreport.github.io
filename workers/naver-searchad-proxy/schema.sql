-- 분석기 웹앱 D1 스키마 (기획서 8장)
-- 이번 마이그레이션: users 테이블만 (승인제용)
-- search_history는 다음 단계 (홈 "최근 분석" 구현 시)

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
