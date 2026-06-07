/**
 * measure-r31.mjs
 * R3.1 before/after 측정 스크립트
 *
 * NEW(after)  = created_at > '2026-06-07T10:49:18.300Z'  (방금 광명점 20건, 소넷)
 * OLD(before) = created_at <= '2026-06-07T10:49:18.300Z' (기존 602건)
 *
 * 실행:
 *   cd workers/naver-searchad-proxy
 *   node tools/measure-r31.mjs
 *
 * 결과:
 *   1. NEW vs OLD naturalness 분포 비교표 (mean/median/min/p10/mean_slop_hits)
 *   2. 타겟 slop 5종 출현율 NEW vs OLD 비교표
 *   3. NEW 배치 잔존 slop 상위 15
 *   4. NEW 20건 본문 전문 (번호 + naturalness + 본문)
 *   5. 한 줄 판정
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROFILE_PATH = join(__dirname, '..', 'src', 'naturalness-profile.json');
const SCORE_PATH   = join(__dirname, '..', 'src', 'naturalness-score.js');
const DATA_DIR     = join(__dirname, '_data');

// _data 폴더 확보
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const CUT = '2026-06-07T10:49:18.300Z';

// ──────────────────────────────────────────────
// D1 조회 유틸
// ──────────────────────────────────────────────
function fetchD1(sql, label) {
  const cacheFile = join(DATA_DIR, `r31_${label}.json`);
  if (existsSync(cacheFile)) {
    console.log(`  [캐시] ${label} 로드: ${cacheFile}`);
    return JSON.parse(readFileSync(cacheFile, 'utf8'));
  }

  console.log(`  [D1 조회] ${label} ...`);
  const cmd = `npx wrangler d1 execute smartsupport-db --remote --json --command "${sql.replace(/"/g, '\\"')}"`;
  let raw;
  try {
    raw = execSync(cmd, { cwd: join(__dirname, '..'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    // wrangler가 stderr에 배너를 출력해도 stdout에 JSON 있음
    raw = e.stdout || '';
  }

  // wrangler 배너(비JSON 줄) 제거 후 파싱
  // 결과 형식: [{results:[...], ...}] 또는 배너+JSON 혼합
  const jsonStart = raw.indexOf('[');
  if (jsonStart === -1) {
    throw new Error(`D1 응답에서 JSON 배열을 찾을 수 없음.\n원본:\n${raw.slice(0, 500)}`);
  }
  const jsonStr = raw.slice(jsonStart);
  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(`D1 JSON 파싱 실패: ${e.message}\n원본(앞500자):\n${jsonStr.slice(0, 500)}`);
  }

  // [{results: [...]}] 형태
  const rows = parsed[0]?.results ?? [];
  writeFileSync(cacheFile, JSON.stringify(rows, null, 2), 'utf8');
  console.log(`  → ${rows.length}건 캐시 저장: ${cacheFile}`);
  return rows;
}

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
  if (values.length === 0) return { n: 0, mean: NaN, median: NaN, min: NaN, p10: NaN, mean_slop_hits: NaN };
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((s, v) => s + v, 0) / n;
  return {
    n,
    mean,
    median: percentile(sorted, 50),
    min: sorted[0],
    p10: percentile(sorted, 10),
  };
}

// ──────────────────────────────────────────────
// 메인
// ──────────────────────────────────────────────
console.log('R3.1 before/after 자연스러움 측정');
console.log('='.repeat(72));

// 프로파일·채점기 로드
const profile = JSON.parse(readFileSync(PROFILE_PATH, 'utf8'));
const { scoreNaturalness } = await import(pathToFileURL(SCORE_PATH).href);

// D1 데이터 가져오기
console.log('\n[1단계] D1에서 데이터 로드');

const newRows = fetchD1(
  `SELECT body, created_at FROM place_generated_samples WHERE created_at > '${CUT}' ORDER BY created_at ASC`,
  'new'
);

const oldRows = fetchD1(
  `SELECT body, created_at FROM place_generated_samples WHERE created_at <= '${CUT}' ORDER BY created_at ASC`,
  'old'
);

console.log(`\n  NEW(after)  : ${newRows.length}건`);
console.log(`  OLD(before) : ${oldRows.length}건`);

// ──────────────────────────────────────────────
// 채점
// ──────────────────────────────────────────────
console.log('\n[2단계] 채점 중...');

function scoreRows(rows) {
  return rows.map(row => {
    const r = scoreNaturalness(row.body, profile);
    return {
      body: row.body,
      created_at: row.created_at,
      naturalness: r.naturalness,
      slop_score: r.slop.score,
      slop_hits: r.slop.hits,
      slop_hit_count: r.slop.hits.length,
    };
  });
}

const newScored = scoreRows(newRows);
const oldScored = scoreRows(oldRows);

console.log(`  채점 완료: NEW=${newScored.length}, OLD=${oldScored.length}`);

// ──────────────────────────────────────────────
// 분포 통계
// ──────────────────────────────────────────────
const newNat = newScored.map(s => s.naturalness);
const oldNat = oldScored.map(s => s.naturalness);
const newHits = newScored.map(s => s.slop_hit_count);
const oldHits = oldScored.map(s => s.slop_hit_count);

const newSt = stats(newNat);
const oldSt = stats(oldNat);
const newHitMean = newHits.reduce((s, v) => s + v, 0) / Math.max(1, newHits.length);
const oldHitMean = oldHits.reduce((s, v) => s + v, 0) / Math.max(1, oldHits.length);

// ──────────────────────────────────────────────
// 타겟 slop 5종 출현율 계산
// ──────────────────────────────────────────────
// "출현율" = 해당 slop n-gram이 hits에 포함된 샘플 비율
const TARGET_SLOPS = ['피부 상태', '부위별로', '시술 전에', '짚어주셔서', '얘기해주셔서'];

function slopRate(scored, ngram) {
  const hits = scored.filter(s => s.slop_hits.some(h => h.ngram === ngram)).length;
  return hits / Math.max(1, scored.length);
}

// ──────────────────────────────────────────────
// NEW 배치 slop n-gram 집계 (전체 빈도)
// ──────────────────────────────────────────────
const slopFreqMap = new Map();
for (const s of newScored) {
  for (const hit of s.slop_hits) {
    slopFreqMap.set(hit.ngram, (slopFreqMap.get(hit.ngram) ?? 0) + 1);
  }
}
const topSlops = [...slopFreqMap.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 15);

// ──────────────────────────────────────────────
// 출력
// ──────────────────────────────────────────────
const SEP = '='.repeat(72);
const sep = '-'.repeat(72);

function f(v, d = 2) {
  if (isNaN(v)) return 'N/A'.padStart(8);
  return v.toFixed(d).padStart(8);
}

console.log(`\n\n${SEP}`);
console.log(' R3.1 before/after 측정 결과');
console.log(SEP);

// (1) 분포표
console.log(`\n[1] naturalness 분포 비교`);
console.log(sep);
console.log(
  '지표'.padEnd(18) +
  'NEW(after)'.padStart(12) +
  `  (n=${newSt.n})` +
  '  |  ' +
  'OLD(before)'.padStart(12) +
  `  (n=${oldSt.n})` +
  '  |  Δ(NEW-OLD)'
);
console.log(sep);

const distRows = [
  ['mean',           newSt.mean,    oldSt.mean],
  ['median(p50)',    newSt.median,  oldSt.median],
  ['min',            newSt.min,     oldSt.min],
  ['p10',            newSt.p10,     oldSt.p10],
  ['mean_slop_hits', newHitMean,    oldHitMean],
];

for (const [label, nv, ov] of distRows) {
  const delta = nv - ov;
  const arrow = delta > 0.005 ? '↑' : delta < -0.005 ? '↓' : '=';
  console.log(
    label.padEnd(18) +
    f(nv) +
    ' '.repeat(8) +
    '  |  ' +
    f(ov) +
    ' '.repeat(8) +
    `  |  ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} ${arrow}`
  );
}

// (2) 타겟 slop 5종 출현율
console.log(`\n[2] 타겟 slop 5종 출현율 (NEW vs OLD)`);
console.log(sep);
console.log(
  'slop n-gram'.padEnd(20) +
  'NEW 출현율'.padStart(12) +
  '  |  ' +
  'OLD 출현율'.padStart(12) +
  '  |  Δ(NEW-OLD)'
);
console.log(sep);

for (const ngram of TARGET_SLOPS) {
  const nr = slopRate(newScored, ngram);
  const or = slopRate(oldScored, ngram);
  const delta = nr - or;
  const arrow = delta > 0.01 ? '↑ (악화)' : delta < -0.01 ? '↓ (개선)' : '= (유지)';
  console.log(
    ngram.padEnd(20) +
    `${(nr * 100).toFixed(1)}%`.padStart(12) +
    '  |  ' +
    `${(or * 100).toFixed(1)}%`.padStart(12) +
    `  |  ${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)}pp ${arrow}`
  );
}

// (3) NEW 배치 잔존 slop 상위 15
console.log(`\n[3] NEW 배치 잔존 slop n-gram 상위 15 (빈도 = 몇 건 샘플에서 등장)`);
console.log(sep);
console.log('순위  slop n-gram'.padEnd(30) + '빈도(건)'.padStart(10) + '  출현율');
console.log(sep);

topSlops.forEach(([ngram, cnt], i) => {
  const rate = cnt / newScored.length;
  console.log(
    `${String(i + 1).padStart(2)}.  ${ngram.padEnd(26)}` +
    `${String(cnt).padStart(8)}  ${(rate * 100).toFixed(1)}%`
  );
});

// (4) NEW 20건 본문 전문
console.log(`\n${'='.repeat(72)}`);
console.log(' [4] NEW 배치 20건 본문 전문');
console.log('='.repeat(72));

newScored.forEach((s, i) => {
  console.log(`\n--- #${i + 1}  naturalness=${s.naturalness.toFixed(2)}  slop_hits=${s.slop_hit_count}개 ---`);
  if (s.slop_hit_count > 0) {
    const top3 = s.slop_hits.slice(0, 3).map(h => `"${h.ngram}"(z${h.z.toFixed(1)})`).join(', ');
    console.log(`    slop: ${top3}`);
  }
  console.log(s.body);
});

// (5) 한 줄 판정
console.log(`\n${'='.repeat(72)}`);
console.log(' [5] 판정');
console.log('='.repeat(72));

const natUp   = newSt.mean > oldSt.mean + 0.5;
const natDown = newSt.mean < oldSt.mean - 0.5;
const slopDown = newHitMean < oldHitMean - 0.1;

// 타겟 slop 개선 여부: 5종 중 OLD 대비 출현율이 낮은 개수
const improvedSlops = TARGET_SLOPS.filter(ng => slopRate(newScored, ng) < slopRate(oldScored, ng) - 0.01).length;

let verdict;
if (natUp && slopDown) {
  verdict = `YES — R3.1로 naturalness 상승(+${(newSt.mean - oldSt.mean).toFixed(2)}점)하고 slop hits 평균 감소(${oldHitMean.toFixed(2)}→${newHitMean.toFixed(2)}). 진료설명 slop ${improvedSlops}/5종 개선.`;
} else if (natUp) {
  verdict = `PARTIAL — naturalness 상승(+${(newSt.mean - oldSt.mean).toFixed(2)}점)했으나 slop hits 평균 유사(OLD=${oldHitMean.toFixed(2)}, NEW=${newHitMean.toFixed(2)}). 진료설명 slop ${improvedSlops}/5종 개선.`;
} else if (natDown) {
  verdict = `NO — naturalness 하락(${(newSt.mean - oldSt.mean).toFixed(2)}점). R3.1 효과 미확인.`;
} else {
  verdict = `NEUTRAL — naturalness 변화 미미(Δ${(newSt.mean - oldSt.mean).toFixed(2)}점). 진료설명 slop ${improvedSlops}/5종 개선.`;
}

console.log(`\n  ${verdict}`);
console.log(`\n  mean_slop_hits: OLD=${oldHitMean.toFixed(2)} → NEW=${newHitMean.toFixed(2)} (Δ${(newHitMean - oldHitMean).toFixed(2)})`);
console.log(`  naturalness:    OLD mean=${oldSt.mean.toFixed(2)}, median=${oldSt.median.toFixed(2)}`);
console.log(`                  NEW mean=${newSt.mean.toFixed(2)}, median=${newSt.median.toFixed(2)}`);

console.log(`\n${'='.repeat(72)}`);
