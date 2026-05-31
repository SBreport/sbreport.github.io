-- 지점별 자동수집 on/off 제어 컬럼
-- DEFAULT 1: 기존·신규 지점 모두 기본 ON (비파괴적 추가)
ALTER TABLE review_places ADD COLUMN auto_collect INTEGER NOT NULL DEFAULT 1;
