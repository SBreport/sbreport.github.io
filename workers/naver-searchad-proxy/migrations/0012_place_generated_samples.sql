-- place_generated_samples: 업체 정보 기반 리뷰 예시 생성 (연구용·관리자 전용)
-- Phase 4-3: 실제 리뷰 fact pool 기반 GPT 합성 샘플 저장
-- 2026-06-01 추가

CREATE TABLE IF NOT EXISTS place_generated_samples (
  id            TEXT PRIMARY KEY,
  place_row_id  TEXT NOT NULL,
  body          TEXT NOT NULL,
  style_length  TEXT,   -- short | medium | long
  style_tone    TEXT,   -- friendly | polite | emotional | plain
  style_focus   TEXT,   -- taste | service | mood | price | revisit
  model         TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_generated_samples_place ON place_generated_samples(place_row_id, created_at);
