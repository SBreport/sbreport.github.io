-- place_review_labels: 사람 검수 라벨 레이어
-- Phase 4-2 Step 3: human-in-the-loop 라벨링 → AI 탐지 정확도 측정 + 생성 재료 정제
-- 설계: _세션/프로젝트/플레이스-리뷰-수집-Phase4설계.md §8
-- 2026-06-02

CREATE TABLE place_review_labels (
  review_id    TEXT PRIMARY KEY,   -- place_reviews.id
  place_row_id TEXT NOT NULL,
  human_label  TEXT,               -- 'human' | 'ad' | 'unsure'
  human_note   TEXT,
  labeled_by   TEXT,
  labeled_at   TEXT
);
CREATE INDEX idx_prl_place ON place_review_labels(place_row_id);
