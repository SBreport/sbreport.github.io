-- llm_usage: LLM 호출 토큰·비용 추적 (연구용)
-- Phase 4: OpenAI usage(prompt_tokens, completion_tokens) → cost_usd 저장
-- 2026-06-01 추가

CREATE TABLE IF NOT EXISTS llm_usage (
  id                TEXT PRIMARY KEY,
  place_row_id      TEXT,
  kind              TEXT,    -- 'report' | 'samples'
  provider          TEXT,    -- 'openai'
  model             TEXT,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  cost_usd          REAL,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_llm_usage_place ON llm_usage(place_row_id, created_at);
