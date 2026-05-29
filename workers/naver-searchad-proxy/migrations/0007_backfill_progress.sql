-- 이어하기 백필 진행 상태 (review_places)
-- 전체 과거 리뷰를 청크 단위로 끝까지 수집하기 위한 커서·완료 플래그.
-- 증분(collectPlaceReviews)과 별개: 백필은 중복을 만나도 끝까지 거슬러 올라간다.
ALTER TABLE review_places ADD COLUMN backfill_cursor TEXT;    -- 다음 백필 시작 커서(after). NULL=처음부터
ALTER TABLE review_places ADD COLUMN backfill_done INTEGER DEFAULT 0;  -- 1=전체 백필 완료
ALTER TABLE review_places ADD COLUMN backfill_updated_at TEXT;  -- 마지막 백필 청크 시각
