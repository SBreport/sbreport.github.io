/**
 * measure-r31-matched.mjs
 * R3.1 place-matched 비교 측정 (지점 교란 제거)
 *
 * NEW_광명  = 광명 place_row_id AND created_at > 컷오프  (새 프롬프트, 20건)
 * OLD_광명  = 광명 place_row_id AND created_at <= 컷오프 (옛 프롬프트, 같은 지점) ★핵심
 * OLD_전체  = created_at <= 컷오프 전량 (참고용)
 *
 * 실행:
 *   cd workers/naver-searchad-proxy
 *   node tools/measure-r31-matched.mjs
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROFILE_PATH = join(__dirname, '..', 'src', 'naturalness-profile.json');
const SCORE_PATH   = join(__dirname, '..', 'src', 'naturalness-score.js');
const DATA_DIR     = join(__dirname, '_data');

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const CUT = '2026-06-07T10:49:18.300Z';

// ──────────────────────────────────────────────
// D1 조회 유틸
// ──────────────────────────────────────────────
function fetchD1(sql, label) {
  const cacheFile = join(DATA_DIR, `r31m_${label}.json`);
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
    raw = e.stdout || '';
  }

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
  if (values.length === 0) return { n: 0, mean: NaN, median: NaN, min: NaN, p10: NaN };
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

function meanHits(scored) {
  if (scored.length === 0) return NaN;
  return scored.reduce((s, r) => s + r.slop_hit_count, 0) / scored.length;
}

// ──────────────────────────────────────────────
// 채점
// ──────────────────────────────────────────────
function scoreRows(rows, scoreNaturalness, profile) {
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

// ──────────────────────────────────────────────
// 타겟 slop 출현율
// ──────────────────────────────────────────────
const TARGET_SLOPS = ['피부 상태', '부위별로', '시술 전에', '짚어주셔서', '얘기해주셔서'];

function slopRate(scored, ngram) {
  const hits = scored.filter(s => s.slop_hits.some(h => h.ngram === ngram)).length;
  return hits / Math.max(1, scored.length);
}

// ──────────────────────────────────────────────
// 포맷 유틸
// ──────────────────────────────────────────────
const SEP = '='.repeat(72);
const sep = '-'.repeat(72);

function f(v, d = 2) {
  if (isNaN(v)) return 'N/A'.padStart(8);
  return v.toFixed(d).padStart(8);
}

// ──────────────────────────────────────────────
// 메인
// ──────────────────────────────────────────────
console.log('R3.1 place-matched 자연스러움 측정 (광명점 지점 교란 제거)');
console.log(SEP);

// 프로파일·채점기 로드
const profile = JSON.parse(readFileSync(PROFILE_PATH, 'utf8'));
const { scoreNaturalness } = await import(pathToFileURL(SCORE_PATH).href);

// ──────────────────────────────────────────────
// 1단계: 광명점 place_row_id 확인
// ──────────────────────────────────────────────
console.log('\n[1단계] 광명점 place_row_id 확인');

const placeIdRows = fetchD1(
  `SELECT DISTINCT place_row_id FROM place_generated_samples WHERE created_at > '${CUT}'`,
  'new_place_ids'
);

if (placeIdRows.length === 0) {
  throw new Error('NEW 배치에서 place_row_id를 찾을 수 없음. 컷오프 이후 데이터가 없거나 place_row_id 컬럼이 없을 수 있음.');
}

const placeIds = placeIdRows.map(r => r.place_row_id);
console.log(`  NEW 배치 distinct place_row_id: ${JSON.stringify(placeIds)}`);

// place_row_id가 여러 개면 경고 (광명점만 있어야 함)
if (placeIds.length > 1) {
  console.warn(`  ⚠ place_row_id가 ${placeIds.length}개입니다. 광명점 하나만 예상했습니다.`);
}

// 이름 확인 (UUID 문자열이므로 따옴표로 감싸기)
const placeNameRows = fetchD1(
  `SELECT id, name FROM review_places WHERE id IN (${placeIds.map(id => `'${id}'`).join(',')})`,
  'place_names'
);

console.log('  지점 이름 확인:');
for (const p of placeNameRows) {
  const isKwangmyung = p.name.includes('광명');
  console.log(`    id=${p.id}  name="${p.name}"  ${isKwangmyung ? '✓ 광명 확인' : '⚠ 광명 미포함'}`);
}

// 광명 place_row_id 결정 (여러 개면 첫 번째 사용, 경고)
const gwangmyungId = placeIds[0];
const gwangmyungName = placeNameRows.find(p => p.id === gwangmyungId)?.name ?? '(이름 조회 실패)';

console.log(`\n  → 광명점 place_row_id = ${gwangmyungId}  ("${gwangmyungName}")`);

// ──────────────────────────────────────────────
// 2단계: 세 그룹 D1에서 가져오기
// ──────────────────────────────────────────────
console.log('\n[2단계] D1에서 세 그룹 데이터 로드');

const newGwangRows = fetchD1(
  `SELECT body, created_at, place_row_id FROM place_generated_samples WHERE place_row_id = '${gwangmyungId}' AND created_at > '${CUT}' ORDER BY created_at ASC`,
  'new_gwang'
);

const oldGwangRows = fetchD1(
  `SELECT body, created_at, place_row_id FROM place_generated_samples WHERE place_row_id = '${gwangmyungId}' AND created_at <= '${CUT}' ORDER BY created_at ASC`,
  'old_gwang'
);

const oldAllRows = fetchD1(
  `SELECT body, created_at FROM place_generated_samples WHERE created_at <= '${CUT}' ORDER BY created_at ASC`,
  'old_all'
);

console.log(`\n  NEW_광명  : ${newGwangRows.length}건`);
console.log(`  OLD_광명  : ${oldGwangRows.length}건`);
console.log(`  OLD_전체  : ${oldAllRows.length}건`);

// ──────────────────────────────────────────────
// 3단계: 채점
// ──────────────────────────────────────────────
console.log('\n[3단계] 채점 중...');

const newGwangScored = scoreRows(newGwangRows, scoreNaturalness, profile);
const oldGwangScored = scoreRows(oldGwangRows, scoreNaturalness, profile);
const oldAllScored   = scoreRows(oldAllRows,   scoreNaturalness, profile);

console.log(`  채점 완료: NEW_광명=${newGwangScored.length}, OLD_광명=${oldGwangScored.length}, OLD_전체=${oldAllScored.length}`);

// ──────────────────────────────────────────────
// 출력
// ──────────────────────────────────────────────
console.log(`\n\n${SEP}`);
console.log(' R3.1 place-matched 측정 결과');
console.log(`  광명점 place_row_id = ${gwangmyungId}  ("${gwangmyungName}")`);
console.log(SEP);

// ── [1] 분포표 ──────────────────────────
console.log(`\n[1] naturalness 분포 비교`);
console.log(sep);

const newGwangNat = newGwangScored.map(s => s.naturalness);
const oldGwangNat = oldGwangScored.map(s => s.naturalness);
const oldAllNat   = oldAllScored.map(s => s.naturalness);

const stNG = stats(newGwangNat);
const stOG = stats(oldGwangNat);
const stOA = stats(oldAllNat);

const mhNG = meanHits(newGwangScored);
const mhOG = meanHits(oldGwangScored);
const mhOA = meanHits(oldAllScored);

const colW = 14;
console.log(
  '지표'.padEnd(18) +
  `NEW_광명(n=${stNG.n})`.padStart(colW) +
  '  |  ' +
  `OLD_광명(n=${stOG.n})`.padStart(colW) +
  '  Δ(NEW-OLD광명)' +
  '  |  ' +
  `OLD_전체(n=${stOA.n})`.padStart(colW)
);
console.log(sep);

const distRows = [
  ['mean',           stNG.mean,    stOG.mean,    stOA.mean],
  ['median(p50)',    stNG.median,  stOG.median,  stOA.median],
  ['min',            stNG.min,     stOG.min,     stOA.min],
  ['p10',            stNG.p10,     stOG.p10,     stOA.p10],
  ['mean_slop_hits', mhNG,         mhOG,         mhOA],
];

for (const [label, nv, ov, av] of distRows) {
  const delta = nv - ov;
  const arrow = delta > 0.005 ? '↑' : delta < -0.005 ? '↓' : '=';
  console.log(
    label.padEnd(18) +
    f(nv).padStart(colW) +
    '  |  ' +
    f(ov).padStart(colW) +
    `  ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} ${arrow}` +
    '  |  ' +
    f(av).padStart(colW)
  );
}

// ── [2] 타겟 slop 5종 출현율 ──────────────────────────
console.log(`\n[2] 타겟 slop 5종 출현율 (NEW_광명 vs OLD_광명)`);
console.log(sep);
console.log(
  'slop n-gram'.padEnd(20) +
  `NEW_광명(n=${stNG.n})`.padStart(colW) +
  '  |  ' +
  `OLD_광명(n=${stOG.n})`.padStart(colW) +
  '  |  Δ(NEW-OLD광명)'
);
console.log(sep);

for (const ngram of TARGET_SLOPS) {
  const nr = slopRate(newGwangScored, ngram);
  const or = slopRate(oldGwangScored, ngram);
  const delta = nr - or;
  const arrow = delta > 0.01 ? '↑ (악화)' : delta < -0.01 ? '↓ (개선)' : '= (유지)';
  console.log(
    ngram.padEnd(20) +
    `${(nr * 100).toFixed(1)}%`.padStart(colW) +
    '  |  ' +
    `${(or * 100).toFixed(1)}%`.padStart(colW) +
    `  |  ${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)}pp ${arrow}`
  );
}

// ── [3] NEW_광명 20건 본문 전문 ──────────────────────────
console.log(`\n${SEP}`);
console.log(` [3] NEW_광명 20건 본문 전문 (번호 + naturalness + 본문)`);
console.log(SEP);

newGwangScored.forEach((s, i) => {
  console.log(`\n--- #${i + 1}  naturalness=${s.naturalness.toFixed(2)}  slop_hits=${s.slop_hit_count}개 ---`);
  if (s.slop_hit_count > 0) {
    const top3 = s.slop_hits.slice(0, 3).map(h => `"${h.ngram}"(z${h.z.toFixed(1)})`).join(', ');
    console.log(`    slop: ${top3}`);
  }
  console.log(s.body);
});

// ── [4] OLD_광명 무작위(결정적) 6건 ──────────────────────────
console.log(`\n${SEP}`);
console.log(` [4] OLD_광명 대조용 6건 본문 (결정적 선택: 인덱스 균등 분포)`);
console.log(SEP);

// 결정적 6건: 총 n건에서 균등 간격으로 선택 (seed 없이 인덱스 기반)
const oldGwangN = oldGwangScored.length;
const sampleIndices = oldGwangN <= 6
  ? oldGwangScored.map((_, i) => i)
  : [0, 1, 2, 3, 4, 5].map(k => Math.floor(k * (oldGwangN - 1) / 5));

const oldGwangSample = sampleIndices.map(idx => oldGwangScored[idx]);

oldGwangSample.forEach((s, i) => {
  const origIdx = sampleIndices[i];
  console.log(`\n--- OLD_광명 #${origIdx + 1}/${oldGwangN}  naturalness=${s.naturalness.toFixed(2)}  slop_hits=${s.slop_hit_count}개 ---`);
  if (s.slop_hit_count > 0) {
    const top3 = s.slop_hits.slice(0, 3).map(h => `"${h.ngram}"(z${h.z.toFixed(1)})`).join(', ');
    console.log(`    slop: ${top3}`);
  }
  console.log(s.body);
});

// ── [5] 한 줄 판정 ──────────────────────────
console.log(`\n${SEP}`);
console.log(` [5] 판정 (NEW_광명 vs OLD_광명 기준)`);
console.log(SEP);

const natDelta  = stNG.mean - stOG.mean;
const hitDelta  = mhNG - mhOG;
const natUp     = natDelta > 0.5;
const natDown   = natDelta < -0.5;
const slopDown  = hitDelta < -0.1;

const improvedSlops = TARGET_SLOPS.filter(
  ng => slopRate(newGwangScored, ng) < slopRate(oldGwangScored, ng) - 0.01
).length;

let verdict;
if (natUp && slopDown) {
  verdict = `YES — 같은 지점 기준 R3.1로 naturalness 상승(+${natDelta.toFixed(2)}점)하고 slop hits 평균 감소(${mhOG.toFixed(2)}→${mhNG.toFixed(2)}). 진료설명 slop ${improvedSlops}/5종 개선.`;
} else if (natUp) {
  verdict = `PARTIAL — naturalness 상승(+${natDelta.toFixed(2)}점)했으나 slop hits 평균 유사(OLD_광명=${mhOG.toFixed(2)}, NEW_광명=${mhNG.toFixed(2)}). 진료설명 slop ${improvedSlops}/5종 개선.`;
} else if (natDown) {
  verdict = `NO — naturalness 하락(${natDelta.toFixed(2)}점). R3.1 효과 미확인.`;
} else {
  verdict = `NEUTRAL — naturalness 변화 미미(Δ${natDelta.toFixed(2)}점). 진료설명 slop ${improvedSlops}/5종 개선.`;
}

console.log(`\n  ${verdict}`);
console.log(`\n  mean_slop_hits: OLD_광명=${mhOG.toFixed(2)} → NEW_광명=${mhNG.toFixed(2)} (Δ${hitDelta.toFixed(2)})`);
console.log(`  naturalness:    OLD_광명 mean=${stOG.mean.toFixed(2)}, median=${stOG.median.toFixed(2)}`);
console.log(`                  NEW_광명 mean=${stNG.mean.toFixed(2)}, median=${stNG.median.toFixed(2)}`);
console.log(`\n  (참고) OLD_전체 mean=${stOA.mean.toFixed(2)}, median=${stOA.median.toFixed(2)}, mean_slop_hits=${mhOA.toFixed(2)}`);

console.log(`\n${SEP}`);
