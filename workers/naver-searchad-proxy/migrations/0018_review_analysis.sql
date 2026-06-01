-- place_review_analysis: AI 리뷰 진단 캐시 테이블
-- Phase 4-2: 수집 리뷰의 AI·광고 의심도 추정 (생성 재료 정제 + 지점 AI% 진단)
-- 설계: _세션/프로젝트/플레이스-리뷰-수집-Phase4설계.md §8.4
-- 2026-06-01

CREATE TABLE place_review_analysis (
  review_id        TEXT PRIMARY KEY,    -- place_reviews.id, 1:1 캐시
  place_row_id     TEXT NOT NULL,       -- 지점별 집계용
  ai_suspect       INTEGER,             -- 0~100, 높을수록 AI/광고 의심 (규칙 저품질·GPT 생략분은 NULL)
  rule_low_quality INTEGER DEFAULT 0,   -- 1=빈/초단문/자모/특수문자 (AI 아님, 분모에서 별도 처리)
  heuristic_score  INTEGER,             -- 2단계 무료 점수 (triage 근거·디버깅)
  flags            TEXT,                -- JSON 배열 (사유 태그)
  sentiment        TEXT,                -- positive/neutral/negative
  reason           TEXT,                -- GPT 판단 근거 한 줄
  model            TEXT,                -- 'gpt-5.4-mini' 등 (재현성)
  analyzed_at      TEXT
);
CREATE INDEX idx_pra_place ON place_review_analysis(place_row_id);
