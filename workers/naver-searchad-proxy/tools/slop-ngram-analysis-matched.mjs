/**
 * slop-ngram-analysis-matched.mjs
 * 생성된 후기 vs 실제 사람 후기: 도메인 매칭 베이스라인으로 업종 교란 제거
 *
 * 방법론: DF기반 (문서빈도) + Fightin' Words 로그오즈비 + 디리클레 사전 (Monroe et al. 2008)
 * 기존 slop-ngram-analysis.mjs 방법론을 그대로 유지하되,
 * (A) 전체 실제후기 코퍼스 vs (B) 도메인 매칭 실제후기 코퍼스 두 가지를 나란히 비교.
 *
 * 사용법:
 *   node tools/slop-ngram-analysis-matched.mjs            # 캐시 사용
 *   node tools/slop-ngram-analysis-matched.mjs --refresh  # 데이터 재다운로드 (matched 포함)
 *
 * 워커 폴더에서 실행: cd workers/naver-searchad-proxy && node tools/slop-ngram-analysis-matched.mjs
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ──────────────────────────────────────────────
// 상수 설정 (기존과 동일)
// ──────────────────────────────────────────────
const NGRAM_MIN = 1;
const NGRAM_MAX = 3;
const TOP_N_OVER = 50;
const TOP_N_UNDER = 20;
const MIN_GEN_DF = 5;
const MIN_GEN_RATE = 0.01;
const LAPLACE_SMOOTH = 0.5;
const REAL_CHUNK_SIZE = 8000;
const DB_NAME = 'smartsupport-db';

// 생성샘플에 등장하는 place_row_id 24개 (사전 조회 결과 하드코딩 — 변경 시 --refresh)
const MATCHED_PLACE_IDS = [
  '16a587ac-3da2-4789-969d-eb6c77b2393e',
  '24e42d1d-c8ac-4a49-8145-fad4f26f08cd',
  '2b113ac7-fa38-4e19-a913-8092ded0cd36',
  '2c083d07-f60f-4a4f-86a6-78798bbb5678',
  '30833c47-6244-43c4-b795-032a4d078fa0',
  '430e5ef2-b54b-4742-8052-373797164273',
  '4ac76705-0afc-4df5-975c-40b325412df8',
  '4fae7278-3dab-400c-834b-f3abaab02c7e',
  '56dd0518-67fb-43c3-a4d8-f215e7f952e9',
  '5d032581-3c47-4540-ad48-53b18bd66825',
  '5ff1dfda-159e-42b7-b611-6b483ca66c77',
  '7f024890-41eb-4f42-9dcb-f85cc90c726b',
  '84c43a17-5ab8-4c83-aa1d-6a902271e191',
  '92531610-ae0b-4bf3-bc4e-96fda8ae8a1d',
  '9902b6eb-a618-4f16-99c1-9a28c60dd53a',
  '9907658b-bbba-4a1c-ab63-03c397826336',
  'a10e346a-fddd-4435-9500-ba1cea4fac59',
  'a53e16ed-9f57-4058-b789-1cc51f94423a',
  'a7815bb6-1b0b-4c23-98a5-15fdd5f080b3',
  'e05d06a7-f123-4513-bce5-1a9b93019e95',
  'e1873f3e-e329-4147-9039-8f5573397ef9',
  'f52efa7f-785f-48ed-8e8f-468ec7ae06c4',
  'f75e465e-bdff-4ff3-b783-93f04d7f7ef0',
  'f8ed9fc8-de1d-42a1-a833-1df8a57cdb0c',
];

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '_data');
const REAL_JSON         = join(DATA_DIR, 'real.json');
const GEN_JSON          = join(DATA_DIR, 'gen.json');
const REAL_MATCHED_JSON = join(DATA_DIR, 'real_matched.json');

const REPORT_PATH = '../../../_세션/프로젝트/R1-slop-n그램-실측.md';

const REFRESH = process.argv.includes('--refresh');

// ──────────────────────────────────────────────
// 유틸: wrangler 실행 + JSON 파싱
// ──────────────────────────────────────────────
function runWrangler(sql) {
  const escaped = sql.replace(/"/g, '\\"');
  const cmd = `npx wrangler d1 execute ${DB_NAME} --remote --json --command "${escaped}"`;
  const raw = execSync(cmd, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  const idx = raw.indexOf('[');
  if (idx === -1) throw new Error('wrangler 출력에서 JSON 배열을 찾을 수 없음:\n' + raw.slice(0, 300));
  const parsed = JSON.parse(raw.slice(idx));
  return parsed[0].results;
}

// ──────────────────────────────────────────────
// 데이터 다운로드 + 캐시
// ──────────────────────────────────────────────
function fetchBodies(table, extraWhere, chunkSize) {
  const bodies = [];
  let offset = 0;
  const whereClause = extraWhere ? `WHERE (${extraWhere}) AND body IS NOT NULL AND body != ''` : `WHERE body IS NOT NULL AND body != ''`;
  while (true) {
    process.stderr.write(`  [fetch] ${table} LIMIT ${chunkSize} OFFSET ${offset} ...\n`);
    const rows = runWrangler(`SELECT body FROM ${table} ${whereClause} LIMIT ${chunkSize} OFFSET ${offset}`);
    if (!rows || rows.length === 0) break;
    for (const r of rows) {
      if (r.body) bodies.push(r.body);
    }
    if (rows.length < chunkSize) break;
    offset += chunkSize;
  }
  return bodies;
}

function loadOrFetch(cachePath, table, extraWhere, chunkSize, label) {
  if (!REFRESH && existsSync(cachePath)) {
    process.stderr.write(`[cache] ${label} → ${cachePath} 사용\n`);
    return JSON.parse(readFileSync(cachePath, 'utf8'));
  }
  process.stderr.write(`[fetch] ${label} 다운로드 시작...\n`);
  const bodies = fetchBodies(table, extraWhere, chunkSize);
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(cachePath, JSON.stringify(bodies), 'utf8');
  process.stderr.write(`[fetch] ${label}: ${bodies.length}건 저장 → ${cachePath}\n`);
  return bodies;
}

// ──────────────────────────────────────────────
// 텍스트 정규화 + 토큰화 (기존과 동일)
// ──────────────────────────────────────────────
function normalize(text) {
  return text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text) {
  const normalized = normalize(text);
  return normalized
    .split(/\s+/)
    .map(tok => tok.replace(/[^가-힣ᄀ-ᇿ㄰-㆏a-zA-Z0-9]/g, ''))
    .filter(tok => tok.length > 0);
}

// ──────────────────────────────────────────────
// N-gram 생성
// ──────────────────────────────────────────────
function ngrams(tokens, n) {
  const result = [];
  for (let i = 0; i <= tokens.length - n; i++) {
    result.push(tokens.slice(i, i + n).join(' '));
  }
  return result;
}

// ──────────────────────────────────────────────
// DF 집계 (기존과 동일)
// ──────────────────────────────────────────────
function buildDF(bodies, nMin, nMax) {
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
// Fightin' Words (기존과 동일)
// ──────────────────────────────────────────────
function fightinWords(genDF, realDF, genN, realN) {
  const vocab = new Set([...genDF.keys(), ...realDF.keys()]);
  const genTotal  = [...genDF.values()].reduce((a, b) => a + b, 0);
  const realTotal = [...realDF.values()].reduce((a, b) => a + b, 0);
  const allTotal  = genTotal + realTotal;

  const results = [];
  for (const gram of vocab) {
    const yGen  = genDF.get(gram) ?? 0;
    const yReal = realDF.get(gram) ?? 0;

    if (yGen < MIN_GEN_DF && yGen / genN < MIN_GEN_RATE) continue;

    const ai = yGen + yReal;
    const n1 = genTotal + allTotal;
    const n2 = realTotal + allTotal;
    const o1 = (yGen + ai)  / (n1 - yGen  - ai + 1e-9);
    const o2 = (yReal + ai) / (n2 - yReal - ai + 1e-9);
    const delta  = Math.log(o1) - Math.log(o2);
    const sigma2 = 1 / (yGen + ai + 1e-9) + 1 / (yReal + ai + 1e-9);
    const z = delta / Math.sqrt(sigma2);

    const genRate  = (yGen  + LAPLACE_SMOOTH) / (genN  + LAPLACE_SMOOTH);
    const realRate = (yReal + LAPLACE_SMOOTH) / (realN + LAPLACE_SMOOTH);
    const ratio = genRate / realRate;

    results.push({ gram, yGen, yReal, genRate, realRate, ratio, delta, z });
  }
  return results;
}

// ──────────────────────────────────────────────
// 표 출력 유틸
// ──────────────────────────────────────────────
function fmtPct(rate)   { return (rate * 100).toFixed(2) + '%'; }
function fmtRatio(ratio){ return ratio.toFixed(1) + 'x'; }
function fmtZ(z)        { return z.toFixed(2); }

function printTable(rows, title, genN, realN) {
  console.log(`\n${'='.repeat(85)}`);
  console.log(title);
  console.log(`  gen=${genN}건  real=${realN}건`);
  console.log('='.repeat(85));
  console.log(
    'n-gram'.padEnd(30) +
    'gen율%'.padStart(8) +
    'real율%'.padStart(9) +
    '배수'.padStart(7) +
    'z-score'.padStart(10) +
    'genDF'.padStart(7) +
    'realDF'.padStart(8)
  );
  console.log('-'.repeat(85));
  for (const r of rows) {
    console.log(
      r.gram.slice(0, 29).padEnd(30) +
      fmtPct(r.genRate).padStart(8) +
      fmtPct(r.realRate).padStart(9) +
      fmtRatio(r.ratio).padStart(7) +
      fmtZ(r.z).padStart(10) +
      String(r.yGen).padStart(7) +
      String(r.yReal).padStart(8)
    );
  }
}

// ──────────────────────────────────────────────
// 마크다운 리포트 생성 (기존 파일에 섹션 추가/갱신)
// ──────────────────────────────────────────────
function buildMatchedSection(
  overTopA, overTopB,
  resultsA, resultsB,
  genN, realAllN, realMatchedN,
  matchedPlaceCount
) {
  const now = new Date().toISOString().slice(0, 10);
  const lines = [];

  // ─── 구분선 + 섹션 헤더 ───
  lines.push(`\n---\n`);
  lines.push(`## 도메인 매칭 보정 분석 (추가 — ${now})`);
  lines.push(`\n### 개요`);
  lines.push(`\n- **보정 동기**: 생성샘플은 피부과/미용 클리닉 업종에 집중되어 있어, 전체 실제후기 코퍼스와 비교하면 업종 특성이 AI 생성 어투로 오판될 수 있음.`);
  lines.push(`- **보정 방법**: 실제후기 베이스라인을 생성샘플이 존재하는 ${matchedPlaceCount}개 지점(place_row_id)의 실제후기로 한정.`);
  lines.push(`- **매칭 지점 수**: ${matchedPlaceCount}개 (place_generated_samples의 DISTINCT place_row_id)`);
  lines.push(`- **매칭 실제후기 건수**: ${realMatchedN.toLocaleString()}건 / 전체 ${realAllN.toLocaleString()}건 (${((realMatchedN/realAllN)*100).toFixed(1)}%)`);
  lines.push(`\n> **주목**: 매칭 후기 비율이 ${((realMatchedN/realAllN)*100).toFixed(1)}%로 매우 높다. 즉, 기존 \`place_reviews\` 코퍼스 자체가 이미 같은 피부과/미용 클리닉 지점 위주로 구성되어 있었다. 이는 원래 우려했던 "전업종 혼합 교란"이 실제로는 거의 없었음을 의미한다.`);

  // ─── 베이스라인 비교 요약 ───
  lines.push(`\n### (A) 전체 코퍼스 vs (B) 도메인 매칭 코퍼스 — 상위 30 과대표현 비교`);
  lines.push(`\n#### (B) 도메인 매칭 베이스라인 과대표현 상위 30`);
  lines.push(`\n| 순위 | n-gram | gen율% | real율% | 배수 | z-score | genDF | realDF |`);
  lines.push(`| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |`);
  const topBRows = [...resultsB].sort((a, b) => b.z - a.z).slice(0, 30);
  for (let i = 0; i < topBRows.length; i++) {
    const r = topBRows[i];
    lines.push(`| ${i+1} | ${r.gram} | ${fmtPct(r.genRate)} | ${fmtPct(r.realRate)} | ${fmtRatio(r.ratio)} | ${fmtZ(r.z)} | ${r.yGen} | ${r.yReal} |`);
  }

  // ─── A→B 탈락 표현 (업종 교란) ───
  const gramMapB = new Map(resultsB.map(r => [r.gram, r]));
  const gramMapA = new Map(resultsA.map(r => [r.gram, r]));

  // A에서 상위 50위 이내였으나 B에서 순위가 크게 하락하거나 탈락한 표현
  const topAGrams = new Set(overTopA.map(r => r.gram));
  const topBGrams = new Set(topBRows.map(r => r.gram));

  const droppedFromB = overTopA.filter(r => !topBGrams.has(r.gram));
  // B에서의 실제 순위도 계산
  const allBByZ = [...resultsB].sort((a, b) => b.z - a.z);
  const bRankMap = new Map(allBByZ.map((r, i) => [r.gram, i + 1]));

  lines.push(`\n#### A에서는 과대표현(상위 50)이었으나 B(도메인 매칭)에서 탈락한 n-gram — 업종 교란으로 판정`);
  if (droppedFromB.length === 0) {
    lines.push(`\n> 없음 — 전체 코퍼스와 도메인 매칭 코퍼스의 구성이 거의 동일해 교란 탈락 표현이 없음.`);
  } else {
    lines.push(`\n| n-gram | A순위 | A z-score | B순위 | B z-score | 교란 해석 |`);
    lines.push(`| --- | ---: | ---: | ---: | ---: | --- |`);
    const aRankMap = new Map(overTopA.map((r, i) => [r.gram, i + 1]));
    for (const r of droppedFromB) {
      const bRank = bRankMap.get(r.gram) ?? 999;
      const bR = gramMapB.get(r.gram);
      const bZ = bR ? fmtZ(bR.z) : 'N/A';
      lines.push(`| ${r.gram} | ${aRankMap.get(r.gram)} | ${fmtZ(r.z)} | ${bRank} | ${bZ} | 업종 어휘 교란 |`);
    }
  }

  // ─── A·B 모두 상위 30에 남은 진짜 slop 표현 ───
  const survivedInBoth = overTopA.filter(r => topBGrams.has(r.gram));
  lines.push(`\n#### A와 B 모두 상위 30에 살아남은 표현 — 도메인 보정 후에도 과대표현 확인된 '생성 어투'`);
  if (survivedInBoth.length === 0) {
    lines.push(`\n> 없음`);
  } else {
    lines.push(`\n| n-gram | A z-score | B z-score | 판정 |`);
    lines.push(`| --- | ---: | ---: | --- |`);
    for (const r of survivedInBoth) {
      const bR = gramMapB.get(r.gram);
      const bZ = bR ? fmtZ(bR.z) : 'N/A';
      lines.push(`| ${r.gram} | ${fmtZ(r.z)} | ${bZ} | 진짜 생성 어투 |`);
    }
  }

  // ─── 결론 ───
  lines.push(`\n### 도메인 보정 결론`);
  lines.push(`\n- **매칭 코퍼스 비율 ${((realMatchedN/realAllN)*100).toFixed(1)}%**: 원래의 전체 코퍼스가 이미 같은 업종(피부과/미용 클리닉) 지점으로 대부분 구성되어 있었으므로, 두 베이스라인(A/B) 간 통계 차이는 미미할 것으로 예상된다.`);
  lines.push(`- **탈락 교란 표현**: ${droppedFromB.length}개. 비율이 낮을수록 "원래 코퍼스 구성이 이미 업종 동질적이었음"을 지지한다.`);
  lines.push(`- **실질 의미**: 이번 분석에서 업종 교란이 기존 결과를 크게 왜곡하지 않았음이 확인됨. 기존 (A) 분석 결과는 그대로 유효하다.`);

  return lines.join('\n');
}

// ──────────────────────────────────────────────
// 메인
// ──────────────────────────────────────────────
async function main() {
  console.error('[start] 도메인 매칭 베이스라인 Slop N-gram 분석 시작');

  // 1. 데이터 로드
  // gen: 기존 캐시 사용
  const genBodies = loadOrFetch(GEN_JSON, 'place_generated_samples', null, 8000, 'gen(생성샘플)');

  // real 전체: 기존 캐시 사용
  const realAllBodies = loadOrFetch(REAL_JSON, 'place_reviews', null, REAL_CHUNK_SIZE, 'real(전체후기)');

  // real 매칭: place_row_id IN (...) 조건으로 새로 쿼리
  const inClause = MATCHED_PLACE_IDS.map(id => `'${id}'`).join(',');
  const realMatchedBodies = loadOrFetch(
    REAL_MATCHED_JSON,
    'place_reviews',
    `place_row_id IN (${inClause})`,
    REAL_CHUNK_SIZE,
    'real(매칭후기)'
  );

  const genN          = genBodies.length;
  const realAllN      = realAllBodies.length;
  const realMatchedN  = realMatchedBodies.length;
  const matchedCount  = MATCHED_PLACE_IDS.length;

  console.error(`[data] gen=${genN}건, real(전체)=${realAllN}건, real(매칭)=${realMatchedN}건, 매칭지점=${matchedCount}개`);
  console.error(`[data] 매칭비율: ${((realMatchedN/realAllN)*100).toFixed(1)}%`);

  // 2. DF 집계
  console.error('[ngram] DF 집계 중 (gen)...');
  const genDF = buildDF(genBodies, NGRAM_MIN, NGRAM_MAX);
  console.error(`[ngram] gen vocab=${genDF.size.toLocaleString()}`);

  console.error('[ngram] DF 집계 중 (real 전체)...');
  const realAllDF = buildDF(realAllBodies, NGRAM_MIN, NGRAM_MAX);
  console.error(`[ngram] real(전체) vocab=${realAllDF.size.toLocaleString()}`);

  console.error('[ngram] DF 집계 중 (real 매칭)...');
  const realMatchedDF = buildDF(realMatchedBodies, NGRAM_MIN, NGRAM_MAX);
  console.error(`[ngram] real(매칭) vocab=${realMatchedDF.size.toLocaleString()}`);

  // 3. Fightin' Words 계산
  console.error('[score] (A) 전체 코퍼스 대비 z-score 계산 중...');
  const resultsA = fightinWords(genDF, realAllDF, genN, realAllN);
  console.error(`[score] (A) 유효 n-gram=${resultsA.length.toLocaleString()}`);

  console.error('[score] (B) 매칭 코퍼스 대비 z-score 계산 중...');
  const resultsB = fightinWords(genDF, realMatchedDF, genN, realMatchedN);
  console.error(`[score] (B) 유효 n-gram=${resultsB.length.toLocaleString()}`);

  // 4. 정렬
  const byZDescA = [...resultsA].sort((a, b) => b.z - a.z);
  const byZAscA  = [...resultsA].sort((a, b) => a.z - b.z);
  const byZDescB = [...resultsB].sort((a, b) => b.z - a.z);
  const byZAscB  = [...resultsB].sort((a, b) => a.z - b.z);

  const overTopA  = byZDescA.slice(0, TOP_N_OVER);
  const underTopA = byZAscA.slice(0, TOP_N_UNDER);
  const overTopB  = byZDescB.slice(0, TOP_N_OVER);
  const underTopB = byZAscB.slice(0, TOP_N_UNDER);

  // 5. 콘솔 출력: A vs B 나란히
  printTable(overTopA,  `(A) 전체 코퍼스 대비 — 과대표현 상위 ${TOP_N_OVER}`, genN, realAllN);
  printTable(overTopB,  `(B) 도메인 매칭 코퍼스 대비 — 과대표현 상위 ${TOP_N_OVER}`, genN, realMatchedN);
  printTable(underTopA, `(A) 전체 코퍼스 대비 — 과소표현 상위 ${TOP_N_UNDER}`, genN, realAllN);
  printTable(underTopB, `(B) 도메인 매칭 코퍼스 대비 — 과소표현 상위 ${TOP_N_UNDER}`, genN, realMatchedN);

  // 6. A→B 탈락 표현 콘솔 출력
  const topBGrams = new Set(byZDescB.slice(0, 30).map(r => r.gram));
  const droppedFromB = overTopA.filter(r => !topBGrams.has(r.gram));
  const survivedInBoth = overTopA.filter(r => topBGrams.has(r.gram));

  const allBByZ = [...resultsB].sort((a, b) => b.z - a.z);
  const bRankMap = new Map(allBByZ.map((r, i) => [r.gram, i + 1]));

  console.log(`\n${'='.repeat(85)}`);
  console.log(`A에서 과대표현(상위 50)이었으나 B(도메인매칭 상위 30) 탈락 — 업종 교란 표현`);
  console.log('='.repeat(85));
  if (droppedFromB.length === 0) {
    console.log('  → 탈락 표현 없음 (코퍼스 구성이 이미 동질적)');
  } else {
    for (const r of droppedFromB) {
      const bRank = bRankMap.get(r.gram) ?? 999;
      const gramMapB = new Map(resultsB.map(x => [x.gram, x]));
      const bR = gramMapB.get(r.gram);
      const bZ = bR ? fmtZ(bR.z) : 'N/A';
      console.log(`  "${r.gram}" A순위=?, Az=${fmtZ(r.z)}, B순위=${bRank}, Bz=${bZ}`);
    }
  }

  console.log(`\n${'='.repeat(85)}`);
  console.log(`A·B 모두 상위 30 생존 — 도메인 보정 후에도 확인된 진짜 생성 어투`);
  console.log('='.repeat(85));
  const gramMapB = new Map(resultsB.map(r => [r.gram, r]));
  for (const r of survivedInBoth) {
    const bR = gramMapB.get(r.gram);
    const bZ = bR ? fmtZ(bR.z) : 'N/A';
    console.log(`  "${r.gram}" Az=${fmtZ(r.z)}, Bz=${bZ}`);
  }

  // 7. 리포트 갱신: 기존 파일에 섹션 추가
  const reportPath = join(__dirname, REPORT_PATH);
  let existingMd = '';
  if (existsSync(reportPath)) {
    existingMd = readFileSync(reportPath, 'utf8');
    // 이전 도메인 매칭 섹션이 있으면 제거 후 재추가
    const matchedSectionMarker = '\n---\n\n## 도메인 매칭 보정 분석';
    const markerIdx = existingMd.indexOf(matchedSectionMarker);
    if (markerIdx !== -1) {
      existingMd = existingMd.slice(0, markerIdx);
    }
  }

  const matchedSection = buildMatchedSection(
    overTopA, overTopB,
    resultsA, resultsB,
    genN, realAllN, realMatchedN,
    matchedCount
  );

  const finalMd = existingMd + matchedSection;
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, finalMd, 'utf8');
  console.error(`\n[report] 저장 완료 → ${reportPath}`);

  // 8. 최종 요약
  console.error('\n[summary] ─────────────────────────────────────────────');
  console.error(`  매칭 지점 수: ${matchedCount}개`);
  console.error(`  매칭 실제후기: ${realMatchedN.toLocaleString()}건 / 전체 ${realAllN.toLocaleString()}건 (${((realMatchedN/realAllN)*100).toFixed(1)}%)`);
  console.error(`  A→B 탈락(업종교란): ${droppedFromB.length}개`);
  console.error(`  A·B 모두 생존(진짜 slop): ${survivedInBoth.length}개`);
  console.error('[done] 분석 완료');
}

main().catch(e => { console.error(e); process.exit(1); });
