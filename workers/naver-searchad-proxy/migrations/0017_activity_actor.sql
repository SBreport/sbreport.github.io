-- 연구원 활동 추적: 세 로그 테이블에 actor_user_id 컬럼 추가
-- 수동 수집/백필/생성 시 해당 사용자 ID 기록; Cron은 NULL

ALTER TABLE place_collection_events ADD COLUMN actor_user_id TEXT;
ALTER TABLE place_generated_samples ADD COLUMN actor_user_id TEXT;
ALTER TABLE llm_usage ADD COLUMN actor_user_id TEXT;
