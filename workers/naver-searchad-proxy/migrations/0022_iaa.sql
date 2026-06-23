-- iaa: 다중 평가자 IAA(평가자 간 일치도, κ) 라벨링
-- place_review_labels는 review_id당 1라벨(ON CONFLICT 덮어쓰기)이라 다중평가 불가 → 별도 테이블로 분리(primary 라벨·A2 미간섭).
-- 공유 세트를 여러 평가자가 독립적으로 4분류 → Fleiss/Cohen κ로 라벨 신뢰도(재현성) 측정.
-- A2의 "LLM 37% 일치"가 낮은 건지 사람 한계치 근처인지 판가름하는 분모.
-- 2026-06-08

-- 공유 라벨 세트(스냅샷): 관리자가 층화표본으로 구성
CREATE TABLE iaa_items (
  id         TEXT PRIMARY KEY,   -- 불투명 ID
  set_id     TEXT NOT NULL,      -- 세트(배치) 식별자
  review_id  TEXT NOT NULL,      -- place_reviews.id
  body       TEXT NOT NULL,      -- 출제 시점 본문 스냅샷
  created_at TEXT NOT NULL       -- ISO 8601
);
CREATE INDEX idx_iaa_items_set ON iaa_items(set_id);

-- 평가자별 라벨: 한 리뷰를 여러 평가자(닉네임)가 독립 분류
CREATE TABLE iaa_labels (
  id         TEXT PRIMARY KEY,
  set_id     TEXT NOT NULL,
  review_id  TEXT NOT NULL,
  annotator  TEXT NOT NULL,      -- 평가자 닉네임
  label      TEXT NOT NULL,      -- 'genuine' | 'ad' | 'ai' | 'unsure'
  note       TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_iaa_labels_set ON iaa_labels(set_id);
-- 같은 평가자가 같은 리뷰를 중복 라벨하지 못하게(기본 dedup)
CREATE UNIQUE INDEX uq_iaa_label ON iaa_labels(set_id, review_id, annotator);
