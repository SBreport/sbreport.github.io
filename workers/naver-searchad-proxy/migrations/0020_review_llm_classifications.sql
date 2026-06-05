-- review_llm_classifications: LLM judge 판별 결과 레이어
-- Phase 4-2 Step A2: codebook 기반 LLM 판별기 → 사람 라벨 219건 대비 잠정 일치율 측정용
-- 주의: 다중평가(IAA) 전이라 결과는 *잠정(단일 평가자 대비)* — "검증됨" 주장 금지
-- 2026-06-05

CREATE TABLE review_llm_classifications (
  review_id  TEXT NOT NULL,   -- place_reviews.id
  model      TEXT NOT NULL,   -- 판별에 사용된 모델 (예: 'gpt-5.4-mini')
  llm_label  TEXT NOT NULL,   -- 'genuine' | 'ad' | 'ai' | 'unsure'
  reason     TEXT,            -- 판별 근거 한 줄
  created_at TEXT NOT NULL,   -- ISO 8601
  PRIMARY KEY (review_id, model)
);
CREATE INDEX idx_rlc_model ON review_llm_classifications(model);
