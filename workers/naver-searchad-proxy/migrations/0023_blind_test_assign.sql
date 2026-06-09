-- 0023: 블라인드 테스트 풀 메타 + 닉네임별 배정 테이블

CREATE TABLE IF NOT EXISTS blind_test_pools (
  pool             TEXT    PRIMARY KEY,
  per_rater_real   INTEGER NOT NULL,
  per_rater_gen    INTEGER NOT NULL,
  created_at       TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS blind_test_assignments (
  pool       TEXT NOT NULL,
  nickname   TEXT NOT NULL,
  item_ids   TEXT NOT NULL,      -- JSON 배열 (배정된 blind_test_items.id)
  created_at TEXT NOT NULL,
  PRIMARY KEY (pool, nickname)
);

CREATE INDEX IF NOT EXISTS idx_bta_pool ON blind_test_assignments(pool);
