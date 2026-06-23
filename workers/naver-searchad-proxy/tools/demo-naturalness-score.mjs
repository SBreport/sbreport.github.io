/**
 * demo-naturalness-score.mjs
 * 자연스러움 채점기 자체 데모 (검수용)
 *
 * 프로파일을 로드하고 실제후기 5건 + 생성샘플 5건을 채점해 표로 출력.
 * 실제후기 평균 naturalness > 생성샘플 평균이면 지표가 말이 된다는 1차 신호.
 *
 * 워커 폴더에서 실행:
 *   cd workers/naver-searchad-proxy && node tools/demo-naturalness-score.mjs
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ──────────────────────────────────────────────
// scoreNaturalness는 ESM + 워커 환경을 위해 .js 확장자
// Windows에서 절대 경로 ESM import는 file:// URL로 변환 필요
// ──────────────────────────────────────────────
const PROFILE_PATH = join(__dirname, '..', 'src', 'naturalness-profile.json');
const SCORE_PATH   = join(__dirname, '..', 'src', 'naturalness-score.js');
const REAL_JSON    = join(__dirname, '_data', 'real.json');
const GEN_JSON     = join(__dirname, '_data', 'gen.json');

// profile은 JSON이라 readFileSync로 로드
const profile = JSON.parse(readFileSync(PROFILE_PATH, 'utf8'));

// scoreNaturalness는 ESM export — dynamic import (Windows file:// URL 변환)
const { scoreNaturalness } = await import(pathToFileURL(SCORE_PATH).href);

// 코퍼스 로드
const realBodies = JSON.parse(readFileSync(REAL_JSON, 'utf8'));
const genBodies  = JSON.parse(readFileSync(GEN_JSON,  'utf8'));

// ──────────────────────────────────────────────
// 샘플 선정: 길이 기반 대표성 + 다양성 확보
// (너무 짧거나 극단적인 길이는 제외, 중간 범위에서 랜덤성을 갖되 재현 가능하게 고정)
// ──────────────────────────────────────────────
function pickSamples(bodies, n, seed = 42) {
  // 재현 가능한 유사 랜덤 (단순 LCG)
  let rng = seed;
  const next = () => { rng = (rng * 1664525 + 1013904223) & 0xffffffff; return (rng >>> 0) / 0xffffffff; };

  // 길이 필터: 20자 ~ 300자 (너무 짧으면 slop 감지 어려움, 너무 길면 slop 과도 히트)
  const filtered = bodies.filter(b => b.length >= 20 && b.length <= 300);
  const shuffled = [...filtered].sort(() => next() - 0.5);
  return shuffled.slice(0, n);
}

const realSamples = pickSamples(realBodies, 5, 101);
const genSamples  = pickSamples(genBodies,  5, 202);

// ──────────────────────────────────────────────
// 채점 + 표 출력
// ──────────────────────────────────────────────
function truncate(text, maxLen = 40) {
  const single = text.replace(/\n/g, ' ');
  return single.length > maxLen ? single.slice(0, maxLen - 1) + '…' : single;
}

function printResultTable(samples, label) {
  console.log(`\n${'='.repeat(100)}`);
  console.log(`${label} (n=${samples.length})`);
  console.log('='.repeat(100));
  console.log(
    '본문(앞 40자)'.padEnd(42) +
    'naturalness'.padStart(13) +
    'slop score'.padStart(12) +
    'slop hits'.padStart(11) +
    '주요 slop'
  );
  console.log('-'.repeat(100));

  const scores = [];
  for (const body of samples) {
    const result = scoreNaturalness(body, profile);
    scores.push(result.naturalness);
    const mainSlop = result.slop.hits.slice(0, 2).map(h => `"${h.ngram}"(z${h.z.toFixed(1)})`).join(' ');
    console.log(
      truncate(body, 40).padEnd(42) +
      String(result.naturalness.toFixed(1)).padStart(13) +
      String(result.slop.score.toFixed(3)).padStart(12) +
      String(result.slop.hits.length).padStart(11) +
      '  ' + (mainSlop || '없음')
    );
  }

  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  console.log('-'.repeat(100));
  console.log(`  평균 naturalness: ${avg.toFixed(2)}`);
  return avg;
}

const realAvg = printResultTable(realSamples, '▶ 실제후기 5건');
const genAvg  = printResultTable(genSamples,  '▶ 생성샘플 5건');

// ──────────────────────────────────────────────
// 판정
// ──────────────────────────────────────────────
console.log(`\n${'='.repeat(100)}`);
console.log('■ 판정 요약');
console.log('='.repeat(100));
console.log(`  실제후기 평균 naturalness : ${realAvg.toFixed(2)}`);
console.log(`  생성샘플 평균 naturalness : ${genAvg.toFixed(2)}`);
console.log(`  차이 (real - gen)         : ${(realAvg - genAvg).toFixed(2)}`);

if (realAvg > genAvg) {
  console.log(`\n  ✓ [PASS] 실제>생성으로 분리됨. 지표 방향성 유효.`);
  if (realAvg - genAvg < 5) {
    console.log(`  △ 단, 분리 마진이 ${(realAvg - genAvg).toFixed(1)}점으로 좁음. 가중치 조정 또는 slop_lexicon 확장 검토 권장.`);
  }
} else {
  console.log(`\n  ✗ [FAIL] 실제≤생성. 지표 설계 재검토 필요.`);
  console.log(`    가능한 원인:`);
  console.log(`      1) slop_lexicon이 도메인 특화 어휘를 slop으로 과분류`);
  console.log(`      2) 샘플 선정 편향 (gen 샘플이 우연히 깨끗한 것으로 뽑힘)`);
  console.log(`      3) SLOP_WEIGHT 가중치 과소`);
}

console.log(`\n  참고: 이 결과는 각 5건 소표본. 전체 코퍼스 배치 채점 후 평균으로 재검증 권장.`);
console.log(`        distinct-n 다양성 지표·사람 블라인드 테스트와 병행 필요.`);
