-- blind_test: 블라인드 자연스러움 평가(1~5 Likert)
-- 별도 평가 페이지(접근코드+닉네임)로 다수 평가자가 평가를 축적.
-- 출처(real/gen)는 서버 전용 — 평가자에겐 불투명 ID만 노출(블라인드 무결성).
-- 진짜 후기 vs 생성물의 점수 분포를 사람 기준으로 비교. 단일 합불 아님("구분불가=좋음" 단정 금지, 정도 측정).
-- 2026-06-07

-- 평가 대상 풀(공유): admin이 진짜+생성을 섞어 구성
CREATE TABLE blind_test_items (
  id         TEXT PRIMARY KEY,        -- 불투명 ID (평가자 노출, 출처 추론 불가)
  pool       TEXT NOT NULL,           -- 풀(배치) 식별자
  source     TEXT NOT NULL,           -- 'real' | 'gen' (서버 전용, 평가자 미노출)
  ref_id     TEXT NOT NULL,           -- place_reviews.id 또는 place_generated_samples.id
  body       TEXT NOT NULL,           -- 출제 시점 본문 스냅샷(보여준 그대로 기록)
  created_at TEXT NOT NULL,           -- ISO 8601
  active     INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_bti_pool ON blind_test_items(pool, active);

-- 평가: 한 아이템에 여러 평가자(닉네임)가 1~5점
CREATE TABLE blind_test_ratings (
  id          TEXT PRIMARY KEY,
  item_id     TEXT NOT NULL,          -- blind_test_items.id
  rater_label TEXT NOT NULL,          -- 평가자 닉네임
  rating      INTEGER NOT NULL,       -- 1~5
  note        TEXT,                   -- 선택 메모
  created_at  TEXT NOT NULL           -- ISO 8601
);
CREATE INDEX idx_btr_item  ON blind_test_ratings(item_id);
CREATE INDEX idx_btr_rater ON blind_test_ratings(rater_label);
-- 같은 평가자가 같은 아이템을 중복 평가하지 못하게(기본 dedup)
CREATE UNIQUE INDEX uq_btr_item_rater ON blind_test_ratings(item_id, rater_label);
