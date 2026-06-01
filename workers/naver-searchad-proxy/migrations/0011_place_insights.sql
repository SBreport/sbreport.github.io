-- place_insights: 업체 피드백 리포트 캐시 테이블
-- Phase 4-1: 정량 지표(SQL) + 정성 인사이트(GPT gpt-4o-mini) 합산 report_json 저장
-- 2026-06-01 추가

CREATE TABLE IF NOT EXISTS place_insights (
  place_row_id  TEXT PRIMARY KEY REFERENCES review_places(id),
  report_json   TEXT,        -- 데이터 계약 JSON 문자열 (meta + quantitative + qualitative)
  sample_size   INTEGER,     -- 실제 사용된 표본 리뷰 수
  model         TEXT,        -- GPT 모델명 (gpt-4o-mini 등)
  generated_at  TEXT         -- ISO 생성 일시
);
