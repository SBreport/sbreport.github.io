-- review_date: ISO YYYY-MM-DD 정렬·집계 전용 컬럼
-- review_created_at 원본(네이버 표시용 상대 날짜 문자열)은 유지하고,
-- 파싱된 ISO 날짜를 별도 컬럼에 저장한다.
-- 2026-05-31 추가 (정렬·월별집계 버그 수정)

ALTER TABLE place_reviews ADD COLUMN review_date TEXT; -- ISO YYYY-MM-DD (정렬·집계용)
