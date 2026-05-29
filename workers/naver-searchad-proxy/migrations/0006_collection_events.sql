-- 플레이스 리뷰 수집 이벤트 로그 (자동 Cron + 수동 트리거 공통)
-- 매 수집 시 "언제, 어떻게, 몇 건" 한 줄 기록 → 사용자가 화면에서 수집 이력 확인.
-- snapshot(총량 추이)과 다름: 이건 "이번 수집에서 신규 N건" 이벤트 단위.

CREATE TABLE IF NOT EXISTS place_collection_events (
  id            TEXT PRIMARY KEY,
  place_row_id  TEXT NOT NULL,          -- review_places.id
  source        TEXT NOT NULL,          -- 'cron' | 'manual'
  inserted      INTEGER DEFAULT 0,      -- 이번 수집 신규 적재 건수
  skipped       INTEGER DEFAULT 0,      -- 중복 스킵 건수
  pages_fetched INTEGER DEFAULT 0,      -- 가져온 페이지 수
  total_server  INTEGER,                -- 그 시점 서버 기준 총 리뷰수 (null 가능)
  blocked       INTEGER DEFAULT 0,      -- 차단/오류 발생 1, 정상 0
  error         TEXT,                   -- 오류 메시지 (없으면 null)
  collected_at  TEXT NOT NULL,          -- 수집 시각 (ISO8601)
  FOREIGN KEY (place_row_id) REFERENCES review_places(id)
);

CREATE INDEX IF NOT EXISTS idx_collection_events_place
  ON place_collection_events(place_row_id, collected_at DESC);
