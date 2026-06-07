/**
 * slop-ngram-analysis.mjs
 * 생성된 후기 vs 실제 사람 후기: 표현 과대표현 N-gram 분석
 *
 * 방법론: DF기반 (문서빈도) + Fightin' Words 로그오즈비 + 디리클레 사전 (Monroe et al. 2008)
 *
 * 사용법:
 *   node tools/slop-ngram-analysis.mjs            # 캐시 사용
 *   node tools/slop-ngram-analysis.mjs --refresh  # 데이터 재다운로드
 *
 * 워커 폴더에서 실행: cd workers/naver-searchad-proxy && node tools/slop-ngram-analysis.mjs
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ──────────────────────────────────────────────
// 상수 설정
// ──────────────────────────────────────────────
const NGRAM_MIN = 1;            // n-gram 최소 n
const NGRAM_MAX = 3;            // n-gram 최대 n
const TOP_N_OVER = 50;          // 과대표현 상위 출력 개수
const TOP_N_UNDER = 20;         // 과소표현 상위 출력 개수
const MIN_GEN_DF = 5;           // 생성 코퍼스에서 최소 문서빈도 (또는 아래 비율 이상)
const MIN_GEN_RATE = 0.01;      // 생성 코퍼스에서 최소 출현율 (1%)
const LAPLACE_SMOOTH = 0.5;     // 라플라스 스무딩 값
const REAL_CHUNK_SIZE = 8000;   // D1 청크당 real 후기 행수
const REPORT_PATH = '../../../_세션/프로젝트/R1-slop-n그램-실측.md';
const DB_NAME = 'smartsupport-db';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '_data');
const REAL_JSON = join(DATA_DIR, 'real.json');
const GEN_JSON  = join(DATA_DIR, 'gen.json');

const REFRESH = process.argv.includes('--refresh');

// ──────────────────────────────────────────────
// 유틸: wrangler 실행 + JSON 파싱
// ──────────────────────────────────────────────
function runWrangler(sql) {
  const escaped = sql.replace(/"/g, '\\"');
  const cmd = `npx wrangler d1 execute ${DB_NAME} --remote --json --command "${escaped}"`;
  const raw = execSync(cmd, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  // wrangler 출력에 배너 텍스트가 앞에 붙음. '[' 이후로 잘라 파싱.
  const idx = raw.indexOf('[');
  if (idx === -1) throw new Error('wrangler 출력에서 JSON 배열을 찾을 수 없음:\n' + raw.slice(0, 300));
  const parsed = JSON.parse(raw.slice(idx));
  return parsed[0].results;
}

// ──────────────────────────────────────────────
// 데이터 다운로드 + 캐시
// ──────────────────────────────────────────────
function fetchBodies(table, chunkSize, totalEstimate) {
  const bodies = [];
  let offset = 0;
  while (true) {
    process.stderr.write(`  [fetch] ${table} LIMIT ${chunkSize} OFFSET ${offset} ...\n`);
    const rows = runWrangler(`SELECT body FROM ${table} WHERE body IS NOT NULL AND body != '' LIMIT ${chunkSize} OFFSET ${offset}`);
    if (!rows || rows.length === 0) break;
    for (const r of rows) {
      if (r.body) bodies.push(r.body);
    }
    if (rows.length < chunkSize) break;
    offset += chunkSize;
  }
  return bodies;
}

function loadOrFetch(cachePath, table, chunkSize, totalEstimate) {
  if (!REFRESH && existsSync(cachePath)) {
    process.stderr.write(`[cache] ${cachePath} 사용\n`);
    return JSON.parse(readFileSync(cachePath, 'utf8'));
  }
  process.stderr.write(`[fetch] ${table} 다운로드 시작...\n`);
  const bodies = fetchBodies(table, chunkSize, totalEstimate);
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(cachePath, JSON.stringify(bodies), 'utf8');
  process.stderr.write(`[fetch] ${table}: ${bodies.length}건 저장 → ${cachePath}\n`);
  return bodies;
}

// ──────────────────────────────────────────────
// 텍스트 정규화
// ──────────────────────────────────────────────
function normalize(text) {
  return text
    .replace(/https?:\/\/\S+/g, '')   // URL 제거
    .replace(/\s+/g, ' ')             // 연속 공백 → 1칸
    .trim();
}

// ──────────────────────────────────────────────
// 토큰화 (한글+영숫자만)
// ──────────────────────────────────────────────
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
// DF 집계 (문서빈도: 같은 n-gram이 한 문서에 여러번 나와도 1회)
// ──────────────────────────────────────────────
function buildDF(bodies, nMin, nMax) {
  const df = new Map(); // ngram → 문서 등장 횟수
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
// Monroe, Colaresi & Quinn (2008)
// y_i^(l): corpus l에서 term i의 count (DF count 사용)
// alpha_i: prior = (y_i^1 + y_i^2) / sum
// z_i = delta_i / sigma_i
// delta_i = log-odds difference
// ──────────────────────────────────────────────
function fightinWords(genDF, realDF, genN, realN) {
  // 전체 vocab 수집
  const vocab = new Set([...genDF.keys(), ...realDF.keys()]);

  // 총 DF 합 (prior 계산용)
  const genTotal = [...genDF.values()].reduce((a, b) => a + b, 0);
  const realTotal = [...realDF.values()].reduce((a, b) => a + b, 0);
  const allTotal = genTotal + realTotal;

  const results = [];
  for (const gram of vocab) {
    const yGen  = genDF.get(gram) ?? 0;
    const yReal = realDF.get(gram) ?? 0;

    // 필터: gen DF가 너무 낮은 건 제외
    if (yGen < MIN_GEN_DF && yGen / genN < MIN_GEN_RATE) continue;

    // prior (디리클레 사전): 합산 빈도 기반
    const alpha = (yGen + yReal) / allTotal * allTotal; // = yGen + yReal (raw)
    // 실제 Fightin' Words에서 alpha_i = prior strength * (freq in combined)
    // 여기서는 alpha_i = yGen + yReal 로 사용 (combined count 그 자체)
    const ai = yGen + yReal;

    // 로그오즈비 delta
    // log( (yGen + ai) / (genTotal + allTotal - yGen - ai) )
    // - log( (yReal + ai) / (realTotal + allTotal - yReal - ai) )
    const n1 = genTotal + allTotal;
    const n2 = realTotal + allTotal;
    const o1 = (yGen + ai) / (n1 - yGen - ai + 1e-9);
    const o2 = (yReal + ai) / (n2 - yReal - ai + 1e-9);
    const delta = Math.log(o1) - Math.log(o2);

    // 분산 sigma^2 근사
    const sigma2 = 1/(yGen + ai + 1e-9) + 1/(yReal + ai + 1e-9);
    const z = delta / Math.sqrt(sigma2);

    // 단순 비율 (라플라스 스무딩)
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
function fmtPct(rate) {
  return (rate * 100).toFixed(2) + '%';
}
function fmtRatio(ratio) {
  return ratio.toFixed(1) + 'x';
}
function fmtZ(z) {
  return z.toFixed(2);
}

function printTable(rows, title, genN, realN) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(title);
  console.log('='.repeat(80));
  console.log(
    'n-gram'.padEnd(30) +
    'gen율%'.padStart(8) +
    'real율%'.padStart(9) +
    '배수'.padStart(7) +
    'z-score'.padStart(10) +
    'genDF'.padStart(7) +
    'realDF'.padStart(8)
  );
  console.log('-'.repeat(80));
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
// 마크다운 리포트 생성
// ──────────────────────────────────────────────
function buildMarkdown(overTop, underTop, allResults, genN, realN, targetGrams) {
  const now = new Date().toISOString().slice(0, 10);
  const lines = [];

  lines.push(`# R1 생성물 vs 실제 후기 Slop N-gram 과대표현 실측`);
  lines.push(`\n> 분석일: ${now}`);
  lines.push(`\n## 분석 개요`);
  lines.push(`\n- **데이터**: 실제 사람 후기 \`place_reviews\` ${realN.toLocaleString()}건, 생성 샘플 \`place_generated_samples\` ${genN.toLocaleString()}건 (Cloudflare D1 \`smartsupport-db\`)`);
  lines.push(`- **방법론**: N-gram(n=1~3), 문서빈도(DF) 기반 — 한 리뷰에서 같은 표현이 여러 번 나와도 1회 카운트. 과대표현 점수는 Fightin' Words 로그오즈비 + 정보적 디리클레 사전 z-score (Monroe et al. 2008) 사용.`);
  lines.push(`- **필터**: 생성 코퍼스 DF ≥ ${MIN_GEN_DF} 또는 출현율 ≥ ${(MIN_GEN_RATE*100).toFixed(0)}%.`);

  lines.push(`\n## 생성물 과대표현 상위 ${TOP_N_OVER} (z-score 내림차순)`);
  lines.push(`\n| n-gram | gen율% | real율% | 배수 | z-score | gen건 | real건 |`);
  lines.push(`| --- | ---: | ---: | ---: | ---: | ---: | ---: |`);
  for (const r of overTop) {
    lines.push(`| ${r.gram} | ${fmtPct(r.genRate)} | ${fmtPct(r.realRate)} | ${fmtRatio(r.ratio)} | ${fmtZ(r.z)} | ${r.yGen} | ${r.yReal} |`);
  }

  lines.push(`\n## 과소표현 상위 ${TOP_N_UNDER} — 실제 후기엔 흔한데 생성물이 덜 씀 (z-score 오름차순)`);
  lines.push(`\n| n-gram | gen율% | real율% | 배수 | z-score | gen건 | real건 |`);
  lines.push(`| --- | ---: | ---: | ---: | ---: | ---: | ---: |`);
  for (const r of underTop) {
    lines.push(`| ${r.gram} | ${fmtPct(r.genRate)} | ${fmtPct(r.realRate)} | ${fmtRatio(r.ratio)} | ${fmtZ(r.z)} | ${r.yGen} | ${r.yReal} |`);
  }

  lines.push(`\n## 특별 검증: 사용자 의심 표현`);
  lines.push(`\n아래 표현들이 실제로 과대표현인지 데이터로 검증:`);
  lines.push(`\n| 검색어 | 일치 n-gram | gen율% | real율% | 배수 | z-score |`);
  lines.push(`| --- | --- | ---: | ---: | ---: | ---: |`);
  const gramMap = new Map(allResults.map(r => [r.gram, r]));
  for (const target of targetGrams) {
    // 완전 일치 + 부분 포함 모두 검색
    const exact = gramMap.get(target);
    const partial = allResults
      .filter(r => r.gram.includes(target) && r.gram !== target)
      .sort((a, b) => b.z - a.z)
      .slice(0, 3);

    if (exact) {
      lines.push(`| **${target}** | ${exact.gram} | ${fmtPct(exact.genRate)} | ${fmtPct(exact.realRate)} | ${fmtRatio(exact.ratio)} | ${fmtZ(exact.z)} |`);
    } else {
      lines.push(`| **${target}** | (DF 필터 미달 또는 미등장) | — | — | — | — |`);
    }
    for (const r of partial) {
      lines.push(`| ↳ 포함 | ${r.gram} | ${fmtPct(r.genRate)} | ${fmtPct(r.realRate)} | ${fmtRatio(r.ratio)} | ${fmtZ(r.z)} |`);
    }
  }

  lines.push(`\n## 해석 주의`);
  lines.push(`\n이 분석은 표면적 n-gram 빈도 통계이며 의미·맥락·어조의 적절성을 판단하지 못한다. z-score가 높다고 해서 해당 표현이 반드시 부자연스럽거나 AI slop인 것은 아니며, 생성물의 장르 특성(특정 업종 집중)이 통계를 왜곡할 수 있다.`);

  return lines.join('\n');
}

// ──────────────────────────────────────────────
// 메인
// ──────────────────────────────────────────────
async function main() {
  console.error('[start] 생성물 vs 실제 후기 Slop N-gram 분석 시작');

  // 1. 데이터 로드
  const realBodies = loadOrFetch(REAL_JSON, 'place_reviews', REAL_CHUNK_SIZE, 33728);
  const genBodies  = loadOrFetch(GEN_JSON,  'place_generated_samples', 8000, 608);

  const realN = realBodies.length;
  const genN  = genBodies.length;
  console.error(`[data] real=${realN}건, gen=${genN}건`);

  // 2. DF 집계
  console.error('[ngram] DF 집계 중 (real)...');
  const realDF = buildDF(realBodies, NGRAM_MIN, NGRAM_MAX);
  console.error(`[ngram] real vocab=${realDF.size.toLocaleString()}`);

  console.error('[ngram] DF 집계 중 (gen)...');
  const genDF = buildDF(genBodies, NGRAM_MIN, NGRAM_MAX);
  console.error(`[ngram] gen vocab=${genDF.size.toLocaleString()}`);

  // 3. 과대표현 점수 계산 (Fightin' Words)
  console.error('[score] 로그오즈비 z-score 계산 중...');
  const allResults = fightinWords(genDF, realDF, genN, realN);
  console.error(`[score] 유효 n-gram=${allResults.length.toLocaleString()}`);

  // 4. 정렬
  const byZDesc = [...allResults].sort((a, b) => b.z - a.z);
  const byZAsc  = [...allResults].sort((a, b) => a.z - b.z);

  const overTop  = byZDesc.slice(0, TOP_N_OVER);
  const underTop = byZAsc.slice(0, TOP_N_UNDER);

  // 5. 콘솔 출력
  printTable(overTop,  `생성물 과대표현 상위 ${TOP_N_OVER} (z 내림차순)`, genN, realN);
  printTable(underTop, `실제 후기에 흔하고 생성물에 드문 상위 ${TOP_N_UNDER} (z 오름차순)`, genN, realN);

  // 6. 특별 검증 표현
  const targetGrams = ['가성비', '그냥 지나치기 어렵', '지나치기 어렵더라', '지나치기', '그냥'];
  const gramMap = new Map(allResults.map(r => [r.gram, r]));

  console.log('\n' + '='.repeat(80));
  console.log('특별 검증: 사용자 의심 표현');
  console.log('='.repeat(80));
  for (const target of ['가성비', '그냥 지나치기 어렵', '지나치기 어렵더라']) {
    const exact = gramMap.get(target);
    const partial = allResults
      .filter(r => r.gram.includes(target.split(' ')[0]) && r.gram !== target)
      .sort((a, b) => b.z - a.z)
      .slice(0, 5);

    console.log(`\n[${target}]`);
    if (exact) {
      console.log(`  정확히 일치: gen=${fmtPct(exact.genRate)} real=${fmtPct(exact.realRate)} 배수=${fmtRatio(exact.ratio)} z=${fmtZ(exact.z)} genDF=${exact.yGen} realDF=${exact.yReal}`);
    } else {
      console.log(`  → DF 필터 미달 또는 미등장 (genDF 미만이거나 0건)`);
      // 필터 없이 raw 확인
      const rawGen  = genDF.get(target) ?? 0;
      const rawReal = realDF.get(target) ?? 0;
      console.log(`  raw genDF=${rawGen} rawRealDF=${rawReal}`);
    }
    if (partial.length > 0) {
      console.log(`  포함 표현 상위:`);
      for (const r of partial) {
        console.log(`    "${r.gram}" gen=${fmtPct(r.genRate)} real=${fmtPct(r.realRate)} z=${fmtZ(r.z)}`);
      }
    }
  }

  // 7. 마크다운 리포트 저장
  const reportPath = join(__dirname, REPORT_PATH);
  const md = buildMarkdown(overTop, underTop, allResults, genN, realN,
    ['가성비', '그냥 지나치기 어렵', '지나치기 어렵더라', '지나치기', '그냥']);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, md, 'utf8');
  console.error(`\n[report] 저장 완료 → ${reportPath}`);
  console.error('[done] 분석 완료');
}

main().catch(e => { console.error(e); process.exit(1); });
