-- place_generated_samples: status 컬럼 추가
-- Phase 4-3: 생성 예시 평가 라벨(active/kept/archived) 관리
-- 2026-06-01 추가

ALTER TABLE place_generated_samples ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
