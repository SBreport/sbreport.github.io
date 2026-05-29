-- 플레이스 리뷰수 추이 스냅샷 (Phase 2)
-- 매 수집 시 review_places.total_reviews(서버 기준 총 리뷰수)를 시점별로 적재.
-- Phase 3 추이 그래프의 토대. 개별 리뷰가 아니라 "그 시점의 총량" 한 줄.

CREATE TABLE IF NOT EXISTS place_review_snapshots (
  id            TEXT PRIMARY KEY,
  place_row_id  TEXT NOT NULL,          -- review_places.id
  total_reviews INTEGER,                -- 그 시점 서버 기준 총 방문자 리뷰 수
  stored_count  INTEGER,               -- 그 시점 우리 DB에 쌓인 누적 리뷰 수(참고)
  captured_at   TEXT NOT NULL,          -- 스냅샷 시각 (ISO8601)
  FOREIGN KEY (place_row_id) REFERENCES review_places(id)
);

CREATE INDEX IF NOT EXISTS idx_snapshots_place
  ON place_review_snapshots(place_row_id, captured_at DESC);
