/**
 * measure-hallucination.mjs
 * place_generated_samples 전체(약 602건)에 환각 탐지기를 돌려 현재 발생률을 측정.
 * 결과: flag률·type별·risk별 분포 + 실제 예시 각 5건 + 한 줄 판정.
 *
 * 실행:
 *   cd workers/naver-searchad-proxy
 *   node tools/measure-hallucination.mjs
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { detectHallucination } from '../src/hallucination-detect.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '_data');
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// ── D1 조회 유틸 ──────────────────────────────────────────────────────────────
function fetchD1(sql, label) {
  const cacheFile = join(DATA_DIR, `hallucination_${label}.json`);
  if (existsSync(cacheFile)) {
    console.log(`  [캐시] ${label} 로드: ${cacheFile}`);
    return JSON.parse(readFileSync(cacheFile, 'utf8'));
  }

  console.log(`  [D1 조회] ${label} ...`);
  const escaped = sql.replace(/"/g, '\\"');
  const cmd = `npx wrangler d1 execute smartsupport-db --remote --json --command "${escaped}"`;
  let raw;
  try {
    raw = execSync(cmd, { cwd: join(__dirname, '..'), encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  } catch (e) {
    raw = e.stdout || '';
  }

  const jsonStart = raw.indexOf('[');
  if (jsonStart === -1) {
    throw new Error(`D1 응답에서 JSON 배열을 찾을 수 없음.\n원본:\n${raw.slice(0, 500)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(jsonStart));
  } catch (e) {
    throw new Error(`D1 JSON 파싱 실패: ${e.message}\n원본(앞500자):\n${raw.slice(jsonStart, jsonStart + 500)}`);
  }

  const rows = parsed[0]?.results ?? [];
  writeFileSync(cacheFile, JSON.stringify(rows, null, 2), 'utf8');
  console.log(`  → ${rows.length}건 캐시 저장: ${cacheFile}`);
  return rows;
}

// ── 담당자명 추출 (index.js의 extractFactPool 담당자 규칙 복제) ──────────────
const STAFF_TITLE_RE = /([가-힣]{1,4})\s*(실장님|원장님|선생님|쌤|대표님|상담실장)/g;
const BAD_STAFF_NAMES = new Set([
  '친절한','꼼꼼한','깔끔한','편안한','세심한','자세한','정확한','상냥한','능숙한','깨끗한','시원한','훌륭한',
  '친절하신','꼼꼼하신','깔끔하신','세심하신','자세하신','친절했던','꼼꼼했던',
]);
const STAFF_DESCRIPTOR = new Set([
  '의사','여의사','남의사','간호사','관리사','피부','데스크','코디','코디네이터','인포',
  '총괄','대표','부원장','원장','실장','선생','지점','병원','타병원','의원',
  '상담','담당','직원','분들','여자','여성','남자','남성',
  '우리','그분','메인','모든','모두','다른','전체','여기','이곳',
  '특히','특히나','그리고','또한','바로','정말','진짜','항상','매번',
]);
const BAD_SUFFIX_RE = /(하시고|하셔서|하신|했던|하고|해서|한|하게|하며|하여|시고|셔서|히고|시는|주시는|으시는|시구|으시구|하시구|는데|어요|아요|에요|예요|으며|으신|으셔|셨|셔서|시던|주신|주셨|다는|라서|다고|길래|는지|군요|네요|더라|더라구|았|었|였|해서|했던)$/;
const BAD_ADJ_RE = /친절|꼼꼼|깔끔|세심|자세|정확|상냥|편안|능숙|훌륭|깨끗/;
const GENERIC_FILLER = new Set([
  '친절','깔끔','청결','만족','추천','최고','정성','꼼꼼','편안','훌륭','완벽','탁월','감동',
  '좋아요','좋았','좋습니다','좋네요','굿','좋아','좋은','좋고','좋게',
  '상담','원장','원장님','직원','선생님','실장님','선생','담당','담당자',
]);
const STOPWORDS = new Set([
  '너무','정말','진짜','그리고','하지만','에서','으로','합니다','했어요','같아요','있어요',
]);
const STAFF_NAME_MIN_FREQ = 2;

/**
 * 리뷰 본문 배열에서 담당자명 엔티티(freq>=2) 배열 반환
 */
function extractAllowedStaffNames(bodies) {
  const staffEntityFreq = new Map();
  for (const body of bodies) {
    if (!body) continue;
    STAFF_TITLE_RE.lastIndex = 0;
    let m;
    while ((m = STAFF_TITLE_RE.exec(body)) !== null) {
      const namePart = m[1];
      if (BAD_STAFF_NAMES.has(namePart)) continue;
      if (GENERIC_FILLER.has(namePart)) continue;
      if (STOPWORDS.has(namePart)) continue;
      if (STAFF_DESCRIPTOR.has(namePart)) continue;
      if (BAD_SUFFIX_RE.test(namePart)) continue;
      if (BAD_ADJ_RE.test(namePart)) continue;
      if (namePart.length < 2 || namePart.length > 3) continue;
      const entity = m[0].replace(/\s+/g, '');
      staffEntityFreq.set(entity, (staffEntityFreq.get(entity) ?? 0) + 1);
    }
  }
  return Array.from(staffEntityFreq.entries())
    .filter(([, freq]) => freq >= STAFF_NAME_MIN_FREQ)
    .map(([name]) => name);
}

// ── 텍스트 요약: 앞 120자 ────────────────────────────────────────────────────
function snippet(text, maxLen = 120) {
  if (!text) return '';
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length <= maxLen ? s : s.slice(0, maxLen) + '…';
}

// ── 메인 ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n=== 환각 탐지기 측정 스크립트 ===\n');

  // 1. 생성 샘플 전체 조회 (body + place_row_id)
  console.log('[1] place_generated_samples 조회...');
  const samples = fetchD1(
    'SELECT id, body, place_row_id FROM place_generated_samples ORDER BY place_row_id, id',
    'samples'
  );
  console.log(`  → 총 ${samples.length}건\n`);

  if (samples.length === 0) {
    console.log('샘플이 없습니다. 종료.');
    return;
  }

  // 2. 지점별 실제 리뷰 조회 (담당자명 팩트풀 계산용)
  // LIMIT 1000 / 지점 — DB에 리뷰가 많아 전체를 한 번에 가져오면 너무 큼
  // 지점 목록 먼저 추출
  const placeIds = [...new Set(samples.map(s => s.place_row_id).filter(Boolean))];
  console.log(`[2] 지점 수: ${placeIds.length}개 — 각 리뷰 최대 1000건 조회...`);

  // 지점별 allowedStaffNames 맵 (캐시)
  const staffNamesMap = new Map(); // place_row_id -> string[]

  // 리뷰 전체를 한 번에 가져오기 (place_row_id IN 절)
  // 건수가 많을 수 있으므로 D1 캐시 활용
  const reviewRows = fetchD1(
    'SELECT place_row_id, body FROM place_reviews WHERE body IS NOT NULL AND body != \'\' ORDER BY place_row_id, collected_at DESC LIMIT 50000',
    'reviews_for_staff'
  );
  console.log(`  → 리뷰 ${reviewRows.length}건 로드\n`);

  // 지점별 그룹핑
  const reviewsByPlace = new Map();
  for (const row of reviewRows) {
    if (!reviewsByPlace.has(row.place_row_id)) reviewsByPlace.set(row.place_row_id, []);
    reviewsByPlace.get(row.place_row_id).push(row.body);
  }

  // 지점별 allowedStaffNames 계산
  for (const pid of placeIds) {
    const bodies = reviewsByPlace.get(pid) ?? [];
    staffNamesMap.set(pid, extractAllowedStaffNames(bodies));
  }

  // 3. 탐지 실행
  console.log('[3] 환각 탐지 실행...');
  const results = [];
  for (const sample of samples) {
    const allowedNames = staffNamesMap.get(sample.place_row_id) ?? [];
    const det = detectHallucination(sample.body ?? '', allowedNames);
    results.push({ ...sample, ...det, allowedNames });
  }

  // 4. 집계
  const total = results.length;
  const flagged = results.filter(r => r.flags.length > 0);
  const byType = { price: [], quantity: [], name: [] };
  const byRisk = { high: 0, low: 0, none: 0 };

  for (const r of results) {
    byRisk[r.risk]++;
    for (const f of r.flags) {
      if (byType[f.type]) byType[f.type].push({ sample: r, flag: f });
    }
  }

  // 5. 출력
  console.log('\n====================================================');
  console.log('  환각 탐지 측정 결과');
  console.log('====================================================\n');

  console.log(`총 샘플: ${total}건`);
  console.log(`flag 있는 샘플: ${flagged.length}건 (${pct(flagged.length, total)})`);
  console.log('');

  console.log('[ type별 건수 (flag 발생 건, 중복 포함) ]');
  console.log(`  price    : ${byType.price.length}건 (샘플의 ${pct(byType.price.length, total)})`);
  console.log(`  quantity : ${byType.quantity.length}건 (샘플의 ${pct(byType.quantity.length, total)})`);
  console.log(`  name     : ${byType.name.length}건 (샘플의 ${pct(byType.name.length, total)})`);
  console.log('');

  console.log('[ risk별 분포 ]');
  console.log(`  high : ${byRisk.high}건 (${pct(byRisk.high, total)})`);
  console.log(`  low  : ${byRisk.low}건 (${pct(byRisk.low, total)})`);
  console.log(`  none : ${byRisk.none}건 (${pct(byRisk.none, total)})`);
  console.log('');

  // 6. type별 예시 각 5건
  for (const type of ['price', 'quantity', 'name']) {
    const hits = byType[type];
    console.log(`----------------------------------------------------`);
    console.log(`  [${type.toUpperCase()} 예시 — 최대 5건]`);
    console.log(`----------------------------------------------------`);
    if (hits.length === 0) {
      console.log('  (없음)');
    } else {
      hits.slice(0, 5).forEach((h, i) => {
        console.log(`  ${i + 1}. 걸린 텍스트: "${h.flag.text}"`);
        console.log(`     이유: ${h.flag.reason}`);
        console.log(`     본문: ${snippet(h.sample.body)}`);
        console.log(`     place_row_id: ${h.sample.place_row_id} | allowedNames: [${h.sample.allowedNames.join(', ')}]`);
        console.log('');
      });
    }
  }

  // 7. 한 줄 판정
  console.log('====================================================');
  const highPct = (byRisk.high / total * 100).toFixed(1);
  const flagPct = (flagged.length / total * 100).toFixed(1);

  let verdict;
  if (byRisk.high / total >= 0.10) {
    verdict = `high-risk 샘플이 ${highPct}%로 높음 — name/price 환각 게이트가 시급함. 생성 파이프라인 배선 전에 가드레일 강화 필요.`;
  } else if (byRisk.high / total >= 0.03) {
    verdict = `high-risk 샘플이 ${highPct}% — 환각이 산발적으로 존재. 게이트 도입을 권장하나 급박하지 않음.`;
  } else if (flagged.length / total >= 0.05) {
    verdict = `high-risk는 낮지만 quantity 포함 flag 비율이 ${flagPct}% — low-risk(임상수치) 패턴 위주. 게이트 우선순위 낮음.`;
  } else {
    verdict = `환각 flag 비율이 ${flagPct}%로 낮음 — 현재 생성물에서 환각이 드묾. 게이트는 예방 목적으로 도입.`;
  }

  console.log(`  판정: ${verdict}`);
  console.log('====================================================\n');
}

function pct(n, total) {
  if (total === 0) return '0.0%';
  return `${(n / total * 100).toFixed(1)}%`;
}

main().catch(e => { console.error(e); process.exit(1); });
