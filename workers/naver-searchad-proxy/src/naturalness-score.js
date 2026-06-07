/**
 * naturalness-score.js
 * 자연스러움 자동 채점기 — 순수 함수 모듈 (워커 import용)
 *
 * ──────────────────────────────────────────────
 * 한계 주의 (이 주석을 절대 제거하지 말 것)
 * ──────────────────────────────────────────────
 * 1. 이 채점기는 표면 통계(n-gram 빈도 + 길이/기호 분포)만 본다.
 *    의미·맥락·어조의 진정성은 판단할 수 없다.
 *
 * 2. 게임화(gaming) 위험: 점수를 높이려고 slop n-gram만 피하고
 *    구조나 어투를 그대로 유지하면 고득점이 가능하다.
 *    이 채점기 단독으로 생성품질을 보장하지 말 것.
 *
 * 3. 배치 단위 해석 권장: 개별 리뷰 점수보다 배치(50건 이상)의
 *    평균·분산을 보는 것이 더 의미 있다. 이모지·기호 신호(emoji_pictograph 등)는
 *    개별 리뷰에선 0/1 이진이라 노이즈가 크다.
 *
 * 4. 다양성 지표(distinct-n)와 사람 블라인드 테스트를 병행해야 한다.
 *    (참고: _세션/프로젝트/플레이스-리뷰-생성-워크플로-기획서.md)
 * ──────────────────────────────────────────────
 *
 * export: scoreNaturalness(body, profile) → ScoreResult
 *
 * @param {string} body       채점할 후기 본문
 * @param {object} profile    naturalness-profile.json 로드 결과
 * @returns {ScoreResult}
 */

// ──────────────────────────────────────────────
// 가중치 상수 (근거 주석 포함)
// ──────────────────────────────────────────────

/**
 * SLOP_WEIGHT: slop 페널티 가중치 (0~1 스케일 slop score → naturalness 차감)
 *
 * 근거: R1 분석에서 gen 평균 slop 히트율이 real보다 5~10배 높게 관찰됨.
 * slop score가 1.0에 도달하면 naturalness를 최대 60점까지 차감.
 * 60은 slop이 가장 강력한 단일 신호라 판단해 가중치를 높게 설정.
 */
const SLOP_WEIGHT = 60;

/**
 * CHAR_LEN_Z_WEIGHT: 글자 수 이탈 페널티 가중치 (z-score 1당 차감점)
 *
 * 근거: 글자 수 분포(mean 67, sd 65)가 매우 넓어(p10~p90 범위가 큼),
 * z |2| 이내는 정상 범위로 본다. z가 3이면 6점 차감 — 극단 이탈만 경고.
 */
const CHAR_LEN_Z_WEIGHT = 2;

/**
 * SENT_COUNT_Z_WEIGHT: 문장 수 이탈 페널티 가중치
 *
 * 근거: 문장 수도 분포가 넓고(mean 2.14, sd 1.87), 이탈 민감도를
 * 글자 수보다 낮게 설정(1점/z). 과도하게 긴 구조화 리뷰를 경고.
 */
const SENT_COUNT_Z_WEIGHT = 1;

/**
 * SURFACE_Z_CLAMP: 표면 z-score 페널티 최대 클램프값
 * z-score가 과도하게 커도 표면 페널티를 이 값으로 제한.
 */
const SURFACE_Z_CLAMP = 20;

// ──────────────────────────────────────────────
// 텍스트 처리 (워커 내 외부 의존성 없이 인라인)
// ──────────────────────────────────────────────

function normalize(text) {
  return text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text) {
  return normalize(text)
    .split(/\s+/)
    .map(tok => tok.replace(/[^가-힣ᄀ-ᇿ㄰-㆏a-zA-Z0-9]/g, ''))
    .filter(tok => tok.length > 0);
}

function buildNgrams(tokens, nMin, nMax) {
  // DF 기준: 문서 내 중복 제거 (채점도 동일 규칙)
  const seen = new Set();
  for (let n = nMin; n <= nMax; n++) {
    for (let i = 0; i <= tokens.length - n; i++) {
      seen.add(tokens.slice(i, i + n).join(' '));
    }
  }
  return seen;
}

function countSentences(text) {
  const chunks = text.split(/[.!?\n]+/).map(s => s.trim()).filter(s => s.length > 0);
  return Math.max(1, chunks.length);
}

function hasPictographEmoji(text) {
  return /[\u{1F300}-\u{1FFFF}]/u.test(text);
}

function hasTilde(text)      { return /~/.test(text); }
function hasKkHh(text)       { return /ㅋ{2,}|ㅎ{2,}/.test(text); }
function hasCaretSmile(text) { return /\^\^/.test(text); }

// ──────────────────────────────────────────────
// 핵심 채점 함수
// ──────────────────────────────────────────────

/**
 * scoreNaturalness
 * @param {string} body
 * @param {object} profile   naturalness-profile.json 내용
 * @returns {{
 *   slop: { score: number, hits: Array<{ngram:string, z:number}> },
 *   surface: {
 *     char_len: number, char_len_z: number,
 *     sentence_count: number, sentence_count_z: number,
 *     emoji_pictograph: boolean,
 *     tilde: boolean, kkhh: boolean, caret_smile: boolean,
 *     notes: string[]
 *   },
 *   naturalness: number
 * }}
 */
export function scoreNaturalness(body, profile) {
  if (!body || typeof body !== 'string') {
    return { slop: { score: 0, hits: [] }, surface: emptySurface(body), naturalness: 50 };
  }

  const { slop_lexicon, surface: surf } = profile;

  // ── 1. Slop 점수 ──────────────────────────
  const tokens = tokenize(body);
  const gramSet = buildNgrams(tokens, 1, 3);

  // slop_lexicon을 빠른 조회용 Map으로 변환 (프로파일은 한 번 로드되므로 호출마다 재구성 최소화)
  // 실제 운영 시 profile을 파싱할 때 한 번만 Map 변환하는 것이 좋지만,
  // 순수함수 제약 유지 + 외부 캐시 금지라 매 호출 허용 (150개라 성능 무시).
  const slopMap = new Map(slop_lexicon.map(e => [e.ngram, e]));

  const hits = [];
  for (const gram of gramSet) {
    const entry = slopMap.get(gram);
    if (entry) {
      hits.push({ ngram: gram, z: entry.z });
    }
  }
  hits.sort((a, b) => b.z - a.z);

  // slop score: 발견된 slop n-gram의 z를 합산, 길이(토큰 수)로 정규화 → [0, 1] 클램프
  // 정규화 분모: 토큰이 많을수록 slop 히트 가능성 높으므로 보정
  // 분모 기준: 평균 리뷰 토큰 수 ~15로 추정, 최소 1
  const tokenCount = Math.max(1, tokens.length);
  const rawSlopSum = hits.reduce((acc, h) => acc + h.z, 0);
  // 길이 정규화: 10 토큰 기준으로 z 합산을 나눔 (짧은 리뷰 불이익 방지)
  const normFactor = Math.max(1, tokenCount / 10);
  const slopScore  = Math.min(1, rawSlopSum / (normFactor * 30));
  // 분모 30: slop z가 평균 ~4, 10토큰 기준 7~8개 히트시 포화(=1.0)로 설계.
  // 실제 gen 리뷰의 평균 slop 히트 수가 3~5개, z합 ~15~20임을 감안.

  // ── 2. Surface 지표 ──────────────────────────
  const charLen      = body.length;
  const sentCount    = countSentences(body);
  const hasEmoji     = hasPictographEmoji(body);
  const hasTildeVal  = hasTilde(body);
  const hasKkHhVal   = hasKkHh(body);
  const hasCaretVal  = hasCaretSmile(body);

  // z-score (분포 대비 이탈 정도)
  const charLenZ   = surf.char_len.sd > 0
    ? (charLen - surf.char_len.mean) / surf.char_len.sd
    : 0;
  const sentCountZ = surf.sentence_count.sd > 0
    ? (sentCount - surf.sentence_count.mean) / surf.sentence_count.sd
    : 0;

  // 표면 노트 (이상 신호 메모)
  const notes = [];

  // 글자 수 이탈 (|z| > 2 이상만 경고)
  if (Math.abs(charLenZ) > 3)
    notes.push(`글자수 극단 이탈 (z=${charLenZ.toFixed(1)}, len=${charLen})`);
  else if (Math.abs(charLenZ) > 2)
    notes.push(`글자수 이탈 (z=${charLenZ.toFixed(1)}, len=${charLen})`);

  // 문장 수 이탈
  if (sentCountZ > 3)
    notes.push(`문장 수 과다 (z=${sentCountZ.toFixed(1)}, count=${sentCount})`);
  else if (sentCountZ > 2)
    notes.push(`문장 수 많음 (z=${sentCountZ.toFixed(1)}, count=${sentCount})`);

  // 구어체 기호 존재 여부 (있으면 사람 신호, 없으면 중립)
  if (hasTildeVal)  notes.push('물결(~) 사용 — 구어체 신호');
  if (hasKkHhVal)   notes.push('ㅋ/ㅎ 반복 — 구어체 신호');
  if (hasCaretVal)  notes.push('^^ 사용 — 구어체 신호');
  if (hasEmoji)     notes.push('그림이모지 포함 — 구어체 신호');

  // slop 히트 요약
  if (hits.length > 0)
    notes.push(`slop n-gram ${hits.length}개 감지: ${hits.slice(0, 3).map(h => `"${h.ngram}"(z${h.z.toFixed(1)})`).join(', ')}`);

  // ── 3. naturalness 종합점수 ──────────────────────────
  //
  // 공식:
  //   naturalness = 100
  //     - slop_penalty          (최대 -60점: SLOP_WEIGHT * slop_score)
  //     - char_len_z_penalty    (|z| * CHAR_LEN_Z_WEIGHT, 최대 SURFACE_Z_CLAMP 제한)
  //     - sent_count_z_penalty  (max(0, z) * SENT_COUNT_Z_WEIGHT, 짧으면 페널티 없음)
  //
  // 구어체 기호(tilde, kkhh, caret, emoji)는 개별 리뷰에서 0/1이라
  // 직접 점수 보정하지 않는다. 배치 집계(호출측)에서 비율로 해석 권장.
  //
  // 가중치 근거:
  //   slop 60 > char_len 2/z > sent_count 1/z
  //   slop이 가장 강한 판별 신호 (gen vs real 분리력 최고).
  //   길이/문장 이탈은 보조 신호로 경미하게 처리.

  const slopPenalty     = SLOP_WEIGHT * slopScore;
  const charLenPenalty  = Math.min(SURFACE_Z_CLAMP, Math.abs(charLenZ)) * CHAR_LEN_Z_WEIGHT;
  const sentCountPenalty= Math.min(SURFACE_Z_CLAMP, Math.max(0, sentCountZ)) * SENT_COUNT_Z_WEIGHT;

  const naturalness = Math.max(0, Math.min(100,
    100 - slopPenalty - charLenPenalty - sentCountPenalty
  ));

  return {
    slop: {
      score: parseFloat(slopScore.toFixed(4)),
      hits,
    },
    surface: {
      char_len:          charLen,
      char_len_z:        parseFloat(charLenZ.toFixed(3)),
      sentence_count:    sentCount,
      sentence_count_z:  parseFloat(sentCountZ.toFixed(3)),
      emoji_pictograph:  hasEmoji,
      tilde:             hasTildeVal,
      kkhh:              hasKkHhVal,
      caret_smile:       hasCaretVal,
      notes,
    },
    naturalness: parseFloat(naturalness.toFixed(2)),
  };
}

// ──────────────────────────────────────────────
// 내부 유틸
// ──────────────────────────────────────────────
function emptySurface(body) {
  return {
    char_len: body ? body.length : 0,
    char_len_z: 0,
    sentence_count: 0,
    sentence_count_z: 0,
    emoji_pictograph: false,
    tilde: false,
    kkhh: false,
    caret_smile: false,
    notes: ['빈 본문 또는 비문자열 입력'],
  };
}
