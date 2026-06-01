-- place_generated_samples: provider 컬럼 추가
-- 생성 시 사용한 LLM 공급자(openai 등)를 영구 저장
-- 2026-06-01 추가

ALTER TABLE place_generated_samples ADD COLUMN provider TEXT NOT NULL DEFAULT 'openai';
