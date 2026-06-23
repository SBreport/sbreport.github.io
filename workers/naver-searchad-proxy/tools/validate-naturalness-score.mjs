/**
 * validate-naturalness-score.mjs
 * R2 자연스러움 채점기 대규모 분리력 검증
 *
 * - gen 전체 602건 + real 결정적 표본(step sampling, 최소 1500건 이상)을 채점
 * - 출력: 분포 통계, AUC(Mann-Whitney U), p10 임계 기준 검출률·오탐률, slop_hits 분포
 *
 * 실행:
 *   cd workers/naver-searchad-proxy && node tools/validate-naturalness-score.mjs
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PROFILE_PATH = join(__dirname, '..', 'src', 'naturalness-profile.json');
const SCORE_PATH   = join(__dirname, '..', 'src', 'naturalness-score.js');
const REAL_JSON    = join(__dirname, '_data', 'real.json');
const GEN_JSON     = join(__dirname, '_data', 'gen.json');

const profile = JSON.parse(readFileSync(PROFILE_PATH, 'utf8'));
const { scoreNaturalness } = await import(pathToFileURL(SCORE_PATH).href);

// ──────────────────────────────────────────────
// 데이터 로드
// ──────────────────────────────────────────────
const allReal = JSON.parse(readFileSync(REAL_JSON, 'utf8'));
const allGen  = JSON.parse(readFileSync(GEN_JSON, 'utf8'));

console.log(`전체 데이터: real=${allReal.length}건, gen=${allGen.length}건`);

// ──────────────────────────────────────────────
// real 표본 추출: step sampling (결정적, 재현 가능)
// 33586건에서 step=16으로 ~2100건 추출 (최소 1500건 권장 충족)
// ──────────────────────────────────────────────
const REAL_STEP = 16; // 33586 / 16 ≈ 2099건
const realSample = allReal.filter((_, i) => i % REAL_STEP === 0);

console.log(`real 표본(step=${REAL_STEP}): ${realSample.length}건`);
console.log(`gen 전체: ${allGen.length}건`);
console.log(`\n채점 중...`);

// ──────────────────────────────────────────────
// 채점
// ──────────────────────────────────────────────
function scoreAll(bodies) {
  return bodies.map(body => {
    const r = scoreNaturalness(body, profile);
    return {
      naturalness: r.naturalness,
      slop_hits: r.slop.hits.length,
    };
  });
}

const realScores = scoreAll(realSample);
const genScores  = scoreAll(allGen);

console.log(`채점 완료: real=${realScores.length}건, gen=${genScores.length}건`);

// ──────────────────────────────────────────────
// 통계 유틸
// ──────────────────────────────────────────────
function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((s, v) => s + v, 0) / n;
  const variance = sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const sd = Math.sqrt(variance);
  return {
    n,
    mean,
    sd,
    p10: percentile(sorted, 10),
    p25: percentile(sorted, 25),
    p50: percentile(sorted, 50),
    p75: percentile(sorted, 75),
    p90: percentile(sorted, 90),
    sorted,
  };
}

// ──────────────────────────────────────────────
// AUC (Mann-Whitney U / (n_real * n_gen))
// = P(real > gen) 무작위 pair에서 real naturalness > gen naturalness일 확률
//
// 효율적 계산: gen 각 점수에 대해 real sorted array에서 binary search로
// "real > gen_score" 카운트를 O(n log n)으로 처리
// ──────────────────────────────────────────────
function calcAUC(realSortedScores, genScores) {
  // realSortedScores: 오름차순 정렬된 real naturalness 값들
  // P(real > gen) = (gen 각 점수에 대해 real 중 그 점수보다 큰 수의 합) / (n_real * n_gen)
  const nReal = realSortedScores.length;
  const nGen  = genScores.length;

  let totalWins = 0; // real > gen 케이스 수
  let totalTies = 0; // real == gen (0.5점 처리)

  for (const g of genScores) {
    // binary search: realSortedScores에서 g보다 큰 원소 수
    let lo = 0, hi = nReal;
    // lo = g보다 엄격히 큰 첫 인덱스
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (realSortedScores[mid] > g) hi = mid;
      else lo = mid + 1;
    }
    const wins = nReal - lo;

    // 동점: g와 같은 원소 수
    let tlo = 0, thi = nReal;
    while (tlo < thi) {
      const mid = (tlo + thi) >> 1;
      if (realSortedScores[mid] < g) tlo = mid + 1;
      else thi = mid;
    }
    const firstEqual = tlo;
    // lo는 이미 '첫 번째로 g보다 큰' 인덱스인데,
    // [firstEqual, lo) 범위가 g와 같은 원소들
    const ties = lo - firstEqual;

    totalWins += wins;
    totalTies += ties;
  }

  // AUC = (wins + 0.5 * ties) / (n_real * n_gen)
  const auc = (totalWins + 0.5 * totalTies) / (nReal * nGen);
  return auc;
}

// ──────────────────────────────────────────────
// 계산
// ──────────────────────────────────────────────
const realNat = realScores.map(s => s.naturalness);
const genNat  = genScores.map(s => s.naturalness);
const realHits = realScores.map(s => s.slop_hits);
const genHits  = genScores.map(s => s.slop_hits);

const realSt  = stats(realNat);
const genSt   = stats(genNat);
const realHitSt = stats(realHits);
const genHitSt  = stats(genHits);

// AUC
const auc = calcAUC(realSt.sorted, genNat);

// p10 threshold: real 분포의 p10을 임계값으로 사용
const threshold = realSt.p10;

// gen 중 threshold 이하 비율 = slop 검출률
const genDetected = genNat.filter(v => v <= threshold).length;
const genDetectionRate = genDetected / genNat.length;

// real 중 threshold 이하 비율 = 오탐률
const realFalsePos = realNat.filter(v => v <= threshold).length;
const realFalsePosRate = realFalsePos / realNat.length;

// ──────────────────────────────────────────────
// 출력
// ──────────────────────────────────────────────
const W = 72;
const SEP = '='.repeat(W);
const sep = '-'.repeat(W);

function fmt(v, decimals = 2) {
  return v.toFixed(decimals).padStart(8);
}

console.log(`\n${SEP}`);
console.log(' R2 자연스러움 채점기 — 대규모 분리력 검증 결과');
console.log(SEP);

console.log(`\n[1] naturalness 분포`);
console.log(sep);
console.log(
  '지표'.padEnd(14) +
  'real'.padStart(10) +
  '(n=' + String(realSt.n) + ')' +
  '  |  ' +
  'gen'.padStart(8) +
  '(n=' + String(genSt.n) + ')'
);
console.log(sep);

const rows = [
  ['mean',   realSt.mean,  genSt.mean],
  ['sd',     realSt.sd,    genSt.sd],
  ['p10',    realSt.p10,   genSt.p10],
  ['p25',    realSt.p25,   genSt.p25],
  ['p50',    realSt.p50,   genSt.p50],
  ['p75',    realSt.p75,   genSt.p75],
  ['p90',    realSt.p90,   genSt.p90],
];

for (const [label, rv, gv] of rows) {
  const diff = rv - gv;
  const arrow = diff > 0 ? '↑' : diff < 0 ? '↓' : '=';
  console.log(
    label.padEnd(14) +
    fmt(rv) +
    ' '.repeat(12) +
    '  |  ' +
    fmt(gv) +
    '  (Δ=' + (diff >= 0 ? '+' : '') + diff.toFixed(2) + ' ' + arrow + ')'
  );
}

console.log(`\n[2] 분리력 지표`);
console.log(sep);

const medianDirection = realSt.p50 > genSt.p50 ? 'PASS (real > gen)' : 'FAIL (real <= gen)';
console.log(`  (a) 중앙값 방향 : real=${realSt.p50.toFixed(2)}, gen=${genSt.p50.toFixed(2)} → ${medianDirection}`);
console.log(`  (b) AUC         : ${auc.toFixed(4)}  (0.5=구분불가, 1.0=완벽분리)`);

let aucJudge;
if (auc >= 0.80) aucJudge = '우수 — 배치 자동채점 사용 가능';
else if (auc >= 0.65) aucJudge = '보통 — 단독 사용 시 주의, 보조 지표 병행 권장';
else aucJudge = '미흡 — 채점기 재설계 검토 필요';
console.log(`              → ${aucJudge}`);

console.log(`\n  (c) real p10 임계값 = ${threshold.toFixed(2)}`);
console.log(`      gen 검출률(slop 탐지) : ${(genDetectionRate * 100).toFixed(1)}%  (${genDetected}/${genNat.length}건)`);
console.log(`      real 오탐률           : ${(realFalsePosRate * 100).toFixed(1)}%  (${realFalsePos}/${realNat.length}건)`);

const precision = genDetected / (genDetected + realFalsePos);
console.log(`      precision(gen|detected): ${(precision * 100).toFixed(1)}%  — 임계 이하 문서 중 실제 gen 비율`);

console.log(`\n[3] slop_hits 수 분포`);
console.log(sep);
console.log(
  '지표'.padEnd(14) +
  'real'.padStart(10) +
  '        ' +
  '  |  ' +
  'gen'.padStart(8)
);
console.log(sep);

const hitRows = [
  ['mean',   realHitSt.mean,  genHitSt.mean],
  ['p50',    realHitSt.p50,   genHitSt.p50],
  ['p90',    realHitSt.p90,   genHitSt.p90],
];

for (const [label, rv, gv] of hitRows) {
  const diff = rv - gv;
  console.log(
    label.padEnd(14) +
    fmt(rv) +
    ' '.repeat(12) +
    '  |  ' +
    fmt(gv) +
    '  (Δ=' + (diff >= 0 ? '+' : '') + diff.toFixed(2) + ')'
  );
}

console.log(`\n  gen 평균 slop_hits : ${genHitSt.mean.toFixed(2)}개`);
console.log(`  real 평균 slop_hits: ${realHitSt.mean.toFixed(2)}개`);
console.log(`  gen/real 비율      : ${(genHitSt.mean / Math.max(0.01, realHitSt.mean)).toFixed(1)}x`);

console.log(`\n[4] 한계 주의`);
console.log(sep);
console.log(`  real 코퍼스에 광고(ad) 90건, AI생성 추정(ai) 24건이 혼입되어 있음.`);
console.log(`  이들은 원래 낮은 naturalness를 기대할 수 있으므로 real 분포의 하단을`);
console.log(`  끌어내려 AUC 상한을 이론적으로 깎는다. 즉 이 AUC는 '오염 포함' 기준이며,`);
console.log(`  순수 사람 리뷰만으로 재측정하면 AUC가 더 높게 나올 가능성이 있다.`);

console.log(`\n${SEP}`);
console.log(` 최종 판정: AUC=${auc.toFixed(4)} → ${aucJudge}`);
console.log(SEP);
