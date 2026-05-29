-- 리뷰가 "어떤 수집 경로로 처음 적재됐는지" 기록 (신규 표시용)
-- 'cron'(자동 증분)으로 들어온 것만 화면에서 '신규(녹색)'로 구분하기 위함.
-- backfill/manual로 들어온 것은 신규 아님. 기존 적재분은 NULL(소급 불가, 신규 아님 취급).
ALTER TABLE place_reviews ADD COLUMN first_source TEXT;
