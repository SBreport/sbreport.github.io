/**
 * verify-factpool.mjs
 * before/after 검증: extractFactPool staffEntities 추출 결과 비교
 *
 * 실행:
 *   cd workers/naver-searchad-proxy
 *   node tools/verify-factpool.mjs
 */

import { execSync } from 'child_process';

// ──────────────────────────────────────────────
// 추출 규칙 (index.js 와 동기화)
// ──────────────────────────────────────────────

// === BEFORE (기존 규칙) ===
function extractBefore(bodyRows) {
  const GENERIC_FILLER = new Set([
    '친절','깔끔','청결','만족','추천','최고','정성','꼼꼼','편안','훌륭','완벽','탁월','감동',
    '좋아요','좋았','좋습니다','좋네요','굿','좋아','좋은','좋고','좋게',
    '상담','원장','원장님','직원','선생님','실장님','선생','담당','담당자',
    '시설','분위기','가격','효과','깨끗','방문','예약','진료','병원','의원',
    '여기','이곳','시술','관리','받았','받고','받아','받은','관리받','받았어요',
    '서비스','이용','가봤','다녀','다녀왔','왔어요','갔어요','했어요','했습니다',
    '강추','극추','마음에','마음에들','만족스','만족했','재방문','또왔','또방문',
    '추천합니다','추천해요','강력추천','항상','계속','앞으로','다음에','또올게요',
    '처음','오늘','저번','지난','이번에',
  ]);
  const STOPWORDS = new Set([
    '너무','정말','진짜','그리고','하지만','에서','으로','합니다','했어요','같아요','있어요',
    '너무너무','조금','약간','매우','아주','그냥','근데','그래서','이런','저런','여기','거기',
  ]);
  const STAFF_TITLE_RE = /([가-힣]{1,4})\s*(실장님|원장님|선생님|쌤|대표님|상담실장)/g;
  const BAD_STAFF_NAMES = new Set([
    '친절한','꼼꼼한','깔끔한','편안한','세심한','자세한','정확한','상냥한','능숙한','깨끗한','시원한','훌륭한',
    '친절하신','꼼꼼하신','깔끔하신','세심하신','자세하신','친절했던','꼼꼼했던',
  ]);
  const BAD_STAFF_SUFFIX_RE = /(하시고|하셔서|하신|했던|하고|해서|한|하게|하며|하여|시고|셔서|히고)$/;
  const BAD_STAFF_ADJECTIVE_RE = /친절|꼼꼼|깔끔|세심|자세|정확|상냥|편안|능숙|훌륭|깨끗/;

  const staffEntityFreq = new Map();
  for (const row of bodyRows) {
    if (!row.body) continue;
    let m;
    STAFF_TITLE_RE.lastIndex = 0;
    while ((m = STAFF_TITLE_RE.exec(row.body)) !== null) {
      const namePart = m[1];
      if (BAD_STAFF_NAMES.has(namePart) || GENERIC_FILLER.has(namePart) || STOPWORDS.has(namePart)) continue;
      if (BAD_STAFF_SUFFIX_RE.test(namePart)) continue;
      if (BAD_STAFF_ADJECTIVE_RE.test(namePart)) continue;
      const entity = m[0].replace(/\s+/g, '');
      staffEntityFreq.set(entity, (staffEntityFreq.get(entity) ?? 0) + 1);
    }
  }
  return Array.from(staffEntityFreq.entries()).sort((a, b) => b[1] - a[1]);
}

// === AFTER (수정된 규칙) ===
function extractAfter(bodyRows) {
  const STAFF_NAME_MIN_FREQ = 2;
  const GENERIC_FILLER = new Set([
    '친절','깔끔','청결','만족','추천','최고','정성','꼼꼼','편안','훌륭','완벽','탁월','감동',
    '좋아요','좋았','좋습니다','좋네요','굿','좋아','좋은','좋고','좋게',
    '상담','원장','원장님','직원','선생님','실장님','선생','담당','담당자',
    '시설','분위기','가격','효과','깨끗','방문','예약','진료','병원','의원',
    '여기','이곳','시술','관리','받았','받고','받아','받은','관리받','받았어요',
    '서비스','이용','가봤','다녀','다녀왔','왔어요','갔어요','했어요','했습니다',
    '강추','극추','마음에','마음에들','만족스','만족했','재방문','또왔','또방문',
    '추천합니다','추천해요','강력추천','항상','계속','앞으로','다음에','또올게요',
    '처음','오늘','저번','지난','이번에',
  ]);
  const STOPWORDS = new Set([
    '너무','정말','진짜','그리고','하지만','에서','으로','합니다','했어요','같아요','있어요',
    '너무너무','조금','약간','매우','아주','그냥','근데','그래서','이런','저런','여기','거기',
  ]);
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
    // 강조 부사·접속어 (이름 아님)
    '특히','특히나','그리고','또한','바로','정말','진짜','항상','매번',
  ]);
  const BAD_STAFF_SUFFIX_RE = /(하시고|하셔서|하신|했던|하고|해서|한|하게|하며|하여|시고|셔서|히고|시는|주시는|으시는|시구|으시구|하시구|는데|어요|아요|에요|예요|으며|으신|으셔|셨|셔서|시던|주신|주셨|다는|라서|다고|길래|는지|군요|네요|더라|더라구|았|었|였|해서|했던)$/;
  const BAD_STAFF_ADJECTIVE_RE = /친절|꼼꼼|깔끔|세심|자세|정확|상냥|편안|능숙|훌륭|깨끗/;

  const staffEntityFreq = new Map();
  for (const row of bodyRows) {
    if (!row.body) continue;
    let m;
    STAFF_TITLE_RE.lastIndex = 0;
    while ((m = STAFF_TITLE_RE.exec(row.body)) !== null) {
      const namePart = m[1];
      if (BAD_STAFF_NAMES.has(namePart) || GENERIC_FILLER.has(namePart) || STOPWORDS.has(namePart)) continue;
      if (STAFF_DESCRIPTOR.has(namePart)) continue;
      if (BAD_STAFF_SUFFIX_RE.test(namePart)) continue;
      if (BAD_STAFF_ADJECTIVE_RE.test(namePart)) continue;
      if (namePart.length < 2 || namePart.length > 3) continue;
      const entity = m[0].replace(/\s+/g, '');
      staffEntityFreq.set(entity, (staffEntityFreq.get(entity) ?? 0) + 1);
    }
  }
  // freq >= STAFF_NAME_MIN_FREQ 만 채택
  return Array.from(staffEntityFreq.entries())
    .filter(([, freq]) => freq >= STAFF_NAME_MIN_FREQ)
    .sort((a, b) => b[1] - a[1]);
}

// ──────────────────────────────────────────────
// D1 조회 헬퍼
// ──────────────────────────────────────────────
function queryD1(sql) {
  const raw = execSync(
    `npx wrangler d1 execute smartsupport-db --remote --json --command "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }
  );
  // 배너 제거: 첫 '[' ~ 마지막 ']' 파싱
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('D1 응답 파싱 실패:\n' + raw.slice(0, 300));
  const parsed = JSON.parse(raw.slice(start, end + 1));
  return parsed[0]?.results ?? [];
}

// ──────────────────────────────────────────────
// 검증 실행
// ──────────────────────────────────────────────
const GWANGMYEONG_ID = '84c43a17-5ab8-4c83-aa1d-6a902271e191';

console.log('=== 광명점 리뷰 조회 중 (최대 1000건)... ===');
const gwangRows = queryD1(
  `SELECT body FROM place_reviews WHERE place_row_id='${GWANGMYEONG_ID}' AND body IS NOT NULL AND body!='' ORDER BY collected_at DESC LIMIT 1000`
);
console.log(`  광명점 리뷰 수: ${gwangRows.length}건`);

// 다른 지점 찾기 (광명점 제외, 리뷰 ≥ 50건)
console.log('\n=== 다른 지점 조회 중... ===');
const otherPlaces = queryD1(
  `SELECT place_row_id, COUNT(*) as cnt FROM place_reviews WHERE place_row_id != '${GWANGMYEONG_ID}' AND body IS NOT NULL AND body!='' GROUP BY place_row_id ORDER BY cnt DESC LIMIT 1`
);
let otherName = '(없음)';
let otherRows = [];
if (otherPlaces.length > 0) {
  const otherId = otherPlaces[0].place_row_id;
  const cnt = otherPlaces[0].cnt;
  // 지점명 조회
  const nameRows = queryD1(`SELECT rp.name FROM review_places rp WHERE rp.id='${otherId}' LIMIT 1`);
  otherName = nameRows[0]?.name ?? otherId;
  console.log(`  선택된 다른 지점: ${otherName} (${cnt}건)`);
  otherRows = queryD1(
    `SELECT body FROM place_reviews WHERE place_row_id='${otherId}' AND body IS NOT NULL AND body!='' ORDER BY collected_at DESC LIMIT 1000`
  );
  console.log(`  리뷰 조회: ${otherRows.length}건`);
}

// ──────────────────────────────────────────────
// 결과 출력
// ──────────────────────────────────────────────
function printResult(label, entries) {
  console.log(`\n[${label}]`);
  if (entries.length === 0) {
    console.log('  통과 항목 없음 (0개)');
    return;
  }
  entries.slice(0, 20).forEach(([entity, freq], i) => {
    console.log(`  ${i + 1}. ${entity} (${freq}회)`);
  });
  if (entries.length > 20) console.log(`  ... 외 ${entries.length - 20}개`);
}

console.log('\n\n══════════════════════════════════════════════');
console.log('  광명점 BEFORE (기존 규칙) — 상위 20개');
console.log('══════════════════════════════════════════════');
const gwangBefore = extractBefore(gwangRows);
printResult('BEFORE', gwangBefore);

console.log('\n══════════════════════════════════════════════');
console.log('  광명점 AFTER  (수정 규칙) — 상위 20개');
console.log('══════════════════════════════════════════════');
const gwangAfter = extractAfter(gwangRows);
printResult('AFTER', gwangAfter);

console.log(`\n  BEFORE 총 ${gwangBefore.length}개 → AFTER 총 ${gwangAfter.length}개`);

if (otherRows.length > 0) {
  console.log('\n\n══════════════════════════════════════════════');
  console.log(`  ${otherName} AFTER (수정 규칙) — 상위 20개`);
  console.log('══════════════════════════════════════════════');
  const otherAfter = extractAfter(otherRows);
  printResult('AFTER', otherAfter);
  console.log(`\n  총 통과 이름: ${otherAfter.length}개`);
}

console.log('\n=== 검증 완료 ===');
