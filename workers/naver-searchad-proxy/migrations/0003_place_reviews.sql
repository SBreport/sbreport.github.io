-- 플레이스 리뷰 수집 — Phase 1 스키마
-- 설계: _세션/프로젝트/플레이스-리뷰-수집-Phase1설계.md §4 / 플레이스-리뷰-수집.md §5
-- getVisitorReviews 실측 필드 기준. 별점 컬럼 없음(2021 폐지), votedKeywords 개별 리뷰엔 비어 미도입.

-- 등록 플레이스
CREATE TABLE IF NOT EXISTS review_places (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  place_id          TEXT NOT NULL,
  business_type     TEXT,
  place_url         TEXT,
  name              TEXT,
  total_reviews     INTEGER,
  created_at        TEXT NOT NULL,
  last_collected_at TEXT,
  last_page         INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id),
  UNIQUE (user_id, place_id)
);

-- 개별 방문자 리뷰
CREATE TABLE IF NOT EXISTS place_reviews (
  id                TEXT PRIMARY KEY,
  place_row_id      TEXT NOT NULL,
  naver_review_id   TEXT NOT NULL,
  author_nick       TEXT,
  body              TEXT,
  has_photo         INTEGER DEFAULT 0,
  owner_reply       TEXT,
  visited_at        TEXT,
  review_created_at TEXT,
  collected_at      TEXT NOT NULL,
  FOREIGN KEY (place_row_id) REFERENCES review_places(id),
  UNIQUE (place_row_id, naver_review_id)
);

CREATE INDEX IF NOT EXISTS idx_review_places_user ON review_places(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_place_reviews_place ON place_reviews(place_row_id, review_created_at DESC);
