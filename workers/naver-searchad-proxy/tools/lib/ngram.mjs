/**
 * tools/lib/ngram.mjs
 * 공용 텍스트 처리 + DF 집계 + Fightin' Words 로직
 *
 * 방법론: DF 기반 문서빈도 + 로그오즈비 + 정보적 디리클레 사전 z-score
 * (Monroe, Colaresi & Quinn, 2008)
 *
 * slop-ngram-analysis*.mjs와 build-naturalness-profile.mjs에서 공유.
 */

// ──────────────────────────────────────────────
// 상수 (호출자가 override 가능하도록 기본값 export)
// ──────────────────────────────────────────────
export const NGRAM_MIN = 1;
export const NGRAM_MAX = 3;
export const MIN_GEN_DF = 5;
export const MIN_GEN_RATE = 0.01;
export const LAPLACE_SMOOTH = 0.5;

// ──────────────────────────────────────────────
// 텍스트 정규화
// ──────────────────────────────────────────────
export function normalize(text) {
  return text
    .replace(/https?:\/\/\S+/g, '')  // URL 제거
    .replace(/\s+/g, ' ')            // 연속 공백 → 1칸
    .trim();
}

// ──────────────────────────────────────────────
// 토큰화 (한글·자모·영숫자만, 구두점·기호 제거)
// ──────────────────────────────────────────────
export function tokenize(text) {
  const normalized = normalize(text);
  return normalized
    .split(/\s+/)
    .map(tok => tok.replace(/[^가-힣ᄀ-ᇿ㄰-㆏a-zA-Z0-9]/g, ''))
    .filter(tok => tok.length > 0);
}

// ──────────────────────────────────────────────
// N-gram 생성
// ──────────────────────────────────────────────
export function ngrams(tokens, n) {
  const result = [];
  for (let i = 0; i <= tokens.length - n; i++) {
    result.push(tokens.slice(i, i + n).join(' '));
  }
  return result;
}

// ──────────────────────────────────────────────
// DF 집계 (문서빈도: 한 문서 내 중복 1회 카운트)
// ──────────────────────────────────────────────
export function buildDF(bodies, nMin = NGRAM_MIN, nMax = NGRAM_MAX) {
  const df = new Map();
  for (const body of bodies) {
    const tokens = tokenize(body);
    const seen = new Set();
    for (let n = nMin; n <= nMax; n++) {
      for (const gram of ngrams(tokens, n)) {
        seen.add(gram);
      }
    }
    for (const gram of seen) {
      df.set(gram, (df.get(gram) ?? 0) + 1);
    }
  }
  return df;
}

// ──────────────────────────────────────────────
// Fightin' Words: 로그오즈비 + 디리클레 사전 z-score
// ──────────────────────────────────────────────
export function fightinWords(genDF, realDF, genN, realN, opts = {}) {
  const minGenDf   = opts.minGenDf   ?? MIN_GEN_DF;
  const minGenRate = opts.minGenRate ?? MIN_GEN_RATE;
  const laplace    = opts.laplace    ?? LAPLACE_SMOOTH;

  const vocab = new Set([...genDF.keys(), ...realDF.keys()]);
  const genTotal  = [...genDF.values()].reduce((a, b) => a + b, 0);
  const realTotal = [...realDF.values()].reduce((a, b) => a + b, 0);
  const allTotal  = genTotal + realTotal;

  const results = [];
  for (const gram of vocab) {
    const yGen  = genDF.get(gram) ?? 0;
    const yReal = realDF.get(gram) ?? 0;

    if (yGen < minGenDf && yGen / genN < minGenRate) continue;

    const ai = yGen + yReal;
    const n1 = genTotal + allTotal;
    const n2 = realTotal + allTotal;
    const o1 = (yGen + ai)  / (n1 - yGen  - ai + 1e-9);
    const o2 = (yReal + ai) / (n2 - yReal - ai + 1e-9);
    const delta  = Math.log(o1) - Math.log(o2);
    const sigma2 = 1 / (yGen + ai + 1e-9) + 1 / (yReal + ai + 1e-9);
    const z = delta / Math.sqrt(sigma2);

    const genRate  = (yGen  + laplace) / (genN  + laplace);
    const realRate = (yReal + laplace) / (realN + laplace);
    const ratio = genRate / realRate;

    results.push({ gram, yGen, yReal, genRate, realRate, ratio, delta, z });
  }
  return results;
}

// ──────────────────────────────────────────────
// 통계 유틸
// ──────────────────────────────────────────────
export function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

export function sd(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1));
}

export function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor((p / 100) * (sorted.length - 1));
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}
