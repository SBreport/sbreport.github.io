/**
 * build-naturalness-profile.mjs
 * 참조 프로파일 생성기 — 자연스러움 자동 채점기의 기반
 *
 * real/gen 코퍼스를 읽어 도메인 프로파일 JSON을 산출한다.
 * 출력: workers/naver-searchad-proxy/src/naturalness-profile.json
 *
 * 사용법:
 *   node tools/build-naturalness-profile.mjs            # 캐시 사용
 *   node tools/build-naturalness-profile.mjs --refresh  # 데이터 재다운로드
 *
 * 워커 폴더에서 실행:
 *   cd workers/naver-searchad-proxy && node tools/build-naturalness-profile.mjs
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname as pathDirname } from 'path';
import { fileURLToPath } from 'url';

import { buildDF, fightinWords, tokenize, mean, sd, percentile } from './lib/ngram.mjs';

const __dirname = pathDirname(fileURLToPath(import.meta.url));

// ──────────────────────────────────────────────
// 설정
// ──────────────────────────────────────────────
const DOMAIN        = 'dermatology-network';
const DB_NAME       = 'smartsupport-db';
const CHUNK_SIZE    = 8000;
const SLOP_TOP_N    = 150;          // slop_lexicon 상위 개수
const REAL_NGRAM_TOP = 3000;        // real_ngram_rates 보존 상위 빈도 수

const DATA_DIR    = join(__dirname, '_data');
const REAL_JSON   = join(DATA_DIR, 'real.json');
const GEN_JSON    = join(DATA_DIR, 'gen.json');
const SRC_DIR     = join(__dirname, '..', 'src');
const OUTPUT_PATH = join(SRC_DIR, 'naturalness-profile.json');

const REFRESH = process.argv.includes('--refresh');

// ──────────────────────────────────────────────
// 이모지 / 기호 감지 (실측 폴백값은 아래 FALLBACK에 기재)
// ──────────────────────────────────────────────
// 실측 기준: 메모리에 기록된 실측값 (그림이모지 ~5%, 물결 ~20%, ㅋㅎ ~11%, ^^ ~7%)
// 코드에서 직접 측정한 값이 FALLBACK보다 우선한다.
const FALLBACK_SURFACE = {
  emoji_pictograph_rate: 0.05,
  tilde_rate: 0.20,
  kkhh_rate: 0.11,
  caret_smile_rate: 0.07,
};

/** 그림 이모지 존재 여부 (U+1F000 이상 유니코드 이모지) */
function hasPictographEmoji(text) {
  // \p{Emoji_Presentation} 는 Node 10+에서 지원
  // 간단히: U+1F000 이상 범위로 감지 (순수 텍스트 기호 제외)
  return /[\u{1F300}-\u{1FFFF}]/u.test(text);
}

/** 물결(~) 포함 여부 */
function hasTilde(text) {
  return /~/.test(text);
}

/** ㅋ 또는 ㅎ 2회 이상 반복 포함 여부 */
function hasKkHh(text) {
  return /ㅋ{2,}|ㅎ{2,}/.test(text);
}

/** ^^ 또는 ^^; 등 포함 여부 */
function hasCaretSmile(text) {
  return /\^\^/.test(text);
}

// ──────────────────────────────────────────────
// wrangler 실행
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

function fetchBodies(table, extraWhere) {
  const bodies = [];
  let offset = 0;
  const whereClause = extraWhere
    ? `WHERE (${extraWhere}) AND body IS NOT NULL AND body != ''`
    : `WHERE body IS NOT NULL AND body != ''`;
  while (true) {
    process.stderr.write(`  [fetch] ${table} LIMIT ${CHUNK_SIZE} OFFSET ${offset} ...\n`);
    const rows = runWrangler(`SELECT body FROM ${table} ${whereClause} LIMIT ${CHUNK_SIZE} OFFSET ${offset}`);
    if (!rows || rows.length === 0) break;
    for (const r of rows) if (r.body) bodies.push(r.body);
    if (rows.length < CHUNK_SIZE) break;
    offset += CHUNK_SIZE;
  }
  return bodies;
}

function loadOrFetch(cachePath, table, extraWhere, label) {
  if (!REFRESH && existsSync(cachePath)) {
    process.stderr.write(`[cache] ${label} → ${cachePath}\n`);
    return JSON.parse(readFileSync(cachePath, 'utf8'));
  }
  process.stderr.write(`[fetch] ${label} 다운로드 중...\n`);
  const bodies = fetchBodies(table, extraWhere);
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(cachePath, JSON.stringify(bodies), 'utf8');
  process.stderr.write(`[fetch] ${label}: ${bodies.length}건 저장\n`);
  return bodies;
}

// ──────────────────────────────────────────────
// 문장 수 측정
// ──────────────────────────────────────────────
function countSentences(text) {
  // 종결 부호(.!?), 줄바꿈을 기준으로 분할. 빈 청크 제거.
  const chunks = text.split(/[.!?\n]+/).map(s => s.trim()).filter(s => s.length > 0);
  return Math.max(1, chunks.length);
}

// ──────────────────────────────────────────────
// 메인
// ──────────────────────────────────────────────
async function main() {
  process.stderr.write('[start] 자연스러움 프로파일 생성 시작\n');

  // 1. 데이터 로드
  const realBodies = loadOrFetch(REAL_JSON, 'place_reviews', null, 'real(실제후기)');
  const genBodies  = loadOrFetch(GEN_JSON,  'place_generated_samples', null, 'gen(생성샘플)');

  const realN = realBodies.length;
  const genN  = genBodies.length;
  process.stderr.write(`[data] real=${realN}건, gen=${genN}건\n`);

  // 2. Surface 측정 (real 코퍼스 기반)
  process.stderr.write('[surface] real 코퍼스 표면 통계 측정 중...\n');
  const charLens = [];
  const sentCounts = [];
  let emojiCount  = 0;
  let tildeCount  = 0;
  let kkhhCount   = 0;
  let caretCount  = 0;

  for (const body of realBodies) {
    charLens.push(body.length);
    sentCounts.push(countSentences(body));
    if (hasPictographEmoji(body)) emojiCount++;
    if (hasTilde(body))           tildeCount++;
    if (hasKkHh(body))            kkhhCount++;
    if (hasCaretSmile(body))      caretCount++;
  }

  const surface = {
    char_len: {
      mean: parseFloat(mean(charLens).toFixed(2)),
      sd:   parseFloat(sd(charLens).toFixed(2)),
      p10:  parseFloat(percentile(charLens, 10).toFixed(2)),
      p90:  parseFloat(percentile(charLens, 90).toFixed(2)),
    },
    sentence_count: {
      mean: parseFloat(mean(sentCounts).toFixed(2)),
      sd:   parseFloat(sd(sentCounts).toFixed(2)),
    },
    // 비율: 해당 신호를 포함한 리뷰 / 전체 리뷰
    emoji_pictograph_rate: parseFloat((emojiCount / realN).toFixed(4)),
    tilde_rate:            parseFloat((tildeCount / realN).toFixed(4)),
    kkhh_rate:             parseFloat((kkhhCount  / realN).toFixed(4)),
    caret_smile_rate:      parseFloat((caretCount / realN).toFixed(4)),
  };

  // 실측값 로그 (FALLBACK과 비교용)
  process.stderr.write(`[surface] char_len mean=${surface.char_len.mean}, sd=${surface.char_len.sd}\n`);
  process.stderr.write(`[surface] sentence_count mean=${surface.sentence_count.mean}, sd=${surface.sentence_count.sd}\n`);
  process.stderr.write(`[surface] emoji=${(surface.emoji_pictograph_rate*100).toFixed(1)}% (fallback: ${(FALLBACK_SURFACE.emoji_pictograph_rate*100).toFixed(0)}%)\n`);
  process.stderr.write(`[surface] tilde=${(surface.tilde_rate*100).toFixed(1)}% (fallback: ${(FALLBACK_SURFACE.tilde_rate*100).toFixed(0)}%)\n`);
  process.stderr.write(`[surface] kkhh=${(surface.kkhh_rate*100).toFixed(1)}% (fallback: ${(FALLBACK_SURFACE.kkhh_rate*100).toFixed(0)}%)\n`);
  process.stderr.write(`[surface] caret=${(surface.caret_smile_rate*100).toFixed(1)}% (fallback: ${(FALLBACK_SURFACE.caret_smile_rate*100).toFixed(0)}%)\n`);

  // 3. DF 집계
  process.stderr.write('[ngram] DF 집계 중 (real)...\n');
  const realDF = buildDF(realBodies);
  process.stderr.write(`[ngram] real vocab=${realDF.size.toLocaleString()}\n`);

  process.stderr.write('[ngram] DF 집계 중 (gen)...\n');
  const genDF = buildDF(genBodies);
  process.stderr.write(`[ngram] gen vocab=${genDF.size.toLocaleString()}\n`);

  // 4. Fightin' Words (gen에 과대표현 방향)
  process.stderr.write('[score] Fightin\' Words z-score 계산 중...\n');
  const allResults = fightinWords(genDF, realDF, genN, realN);
  process.stderr.write(`[score] 유효 n-gram=${allResults.length.toLocaleString()}\n`);

  // 5. slop_lexicon: gen 과대표현(z 내림차순) 상위 SLOP_TOP_N
  const slopLexicon = [...allResults]
    .sort((a, b) => b.z - a.z)
    .slice(0, SLOP_TOP_N)
    .map(r => ({
      ngram:     r.gram,
      n:         r.gram.split(' ').length,
      z:         parseFloat(r.z.toFixed(4)),
      gen_rate:  parseFloat(r.genRate.toFixed(4)),
      real_rate: parseFloat(r.realRate.toFixed(4)),
    }));

  process.stderr.write(`[slop] slop_lexicon 상위 ${slopLexicon.length}개 선정\n`);
  process.stderr.write('[slop] 상위 10:\n');
  for (const e of slopLexicon.slice(0, 10)) {
    process.stderr.write(`  z=${e.z.toFixed(2)} "${e.ngram}" gen=${(e.gen_rate*100).toFixed(1)}% real=${(e.real_rate*100).toFixed(1)}%\n`);
  }

  // 6. real_ngram_rates: 채점 시 참조할 real DF율 맵
  //    용량 절감: 상위 빈도 REAL_NGRAM_TOP개 + slop_lexicon에 등장한 n-gram
  const slopGrams = new Set(slopLexicon.map(e => e.ngram));
  const realByDF = [...realDF.entries()].sort((a, b) => b[1] - a[1]);

  const realNgramRates = {};
  let kept = 0;
  for (const [gram, df] of realByDF) {
    if (kept < REAL_NGRAM_TOP || slopGrams.has(gram)) {
      realNgramRates[gram] = parseFloat((df / realN).toFixed(6));
      kept++;
    }
  }
  // slop n-gram 중 아직 미포함인 것 추가
  for (const gram of slopGrams) {
    if (!(gram in realNgramRates)) {
      const df = realDF.get(gram) ?? 0;
      realNgramRates[gram] = parseFloat((df / realN).toFixed(6));
    }
  }
  process.stderr.write(`[real_rates] real_ngram_rates 항목 수: ${Object.keys(realNgramRates).length}\n`);

  // 7. 프로파일 조립
  const profile = {
    meta: {
      domain:           DOMAIN,
      corpus_size_real: realN,
      corpus_size_gen:  genN,
      computed_at:      new Date().toISOString(),
      method:           'DF log-odds-dirichlet, word ngram 1-3',
    },
    slop_lexicon:     slopLexicon,
    real_ngram_rates: realNgramRates,
    surface,
  };

  // 8. 저장
  mkdirSync(SRC_DIR, { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(profile, null, 2), 'utf8');
  process.stderr.write(`\n[done] 프로파일 저장 완료 → ${OUTPUT_PATH}\n`);
  process.stderr.write(`[done] slop_lexicon=${slopLexicon.length}건, real_ngram_rates=${Object.keys(realNgramRates).length}건\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
