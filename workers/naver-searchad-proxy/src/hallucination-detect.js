/**
 * hallucination-detect.js
 * 생성 리뷰 환각(hallucination) 탐지 — 순수 함수, 외부 의존성 없음, ESM
 *
 * 한계(surface regex 방식):
 *  - 철자를 약간 바꾼 금액 표현("오만원", "오만 원")은 미탐지
 *  - 시술명·메뉴명 환각은 탐지 범위 외 (별도 과제)
 *  - 문맥 없이 표면 패턴만 보므로 오탐 가능 (예: 리뷰 속 인용·비교)
 *  - allowedStaffNames가 빈 배열이면 name flag가 더 많이 발생할 수 있음
 */

// ── 패턴 정의 ────────────────────────────────────────────────────────────────

// 1. 가격: 숫자 + 원/만원/천원
const PRICE_RE = /\d[\d,]*\s*(원|만원|천원)/g;

// 2. 임상 수치: 숫자 + 시술 단위 (일상 방문횟수 "1회/3회" 오탐 방지로 회·회차 제외)
const QUANTITY_RE = /\d+\s*(샷|cc|ml|바이알|mg)/g;

// 3. 이름 + 역할 호칭
// (?<![가-힣]) : 앞 글자가 한글이 아닌 경우만 (단어 경계 보호)
// 이름은 공백 없이 바로 붙어야 하므로 \s* 대신 직접 연결
// "갔다가 원장님"처럼 공백으로 분리된 경우: 앞 단어가 이름이 아닌 수식어임
// → 공백을 허용하되 앞 글자 한글 차단(m.index 검사)으로 보완
const STAFF_NAME_RE = /([가-힣]{2,3})\s*(원장님|실장님|선생님|쌤|대표님|상담실장)/g;

// 역할어·지시어 — namePart 자체가 역할 또는 지시어이면 generic 호칭으로 무시
const ROLE_WORDS = new Set([
  '의사', '여의사', '남의사', '간호사', '관리사', '피부', '데스크', '코디', '코디네이터', '인포',
  '총괄', '대표', '부원장', '원장', '실장', '선생', '지점', '병원', '타병원', '의원',
  '상담', '담당', '직원', '분들', '여자', '여성', '남자', '남성',
  '우리', '그분', '메인', '모든', '모두', '다른', '전체', '여기', '이곳',
  '특히', '특히나', '그리고', '또한', '바로', '정말', '진짜', '항상', '매번',
]);

// 동사·접속어 어미 — namePart가 이 어미로 끝나면 동사/접속어 오탐
// "이랑", "들어서", "오늘은" 등 접속어/부사도 포함
const BAD_SUFFIX_RE = /(하시고|하셔서|하신|했던|하고|해서|한|하게|하며|하여|시고|셔서|히고|시는|주시는|으시는|시구|으시구|하시구|는데|어요|아요|에요|예요|으며|으신|으셔|셨|셔서|시던|주신|주셨|다는|라서|다고|길래|는지|군요|네요|더라|더라구|았|었|였|해서|했던|이랑|에서|으로|부터|까지|이나|이고|이며|은데|는데|이서|에게|으로서|이지|이라|라고|이란|이라서|들어서|요즘|오늘은|처음엔|이제는|에도|으로도|이로)$/;

// 형용사 어근 — namePart에 이 어근이 포함되면 형용사 오탐
const BAD_ADJECTIVE_RE = /친절|꼼꼼|깔끔|세심|자세|정확|상냥|편안|능숙|훌륭|깨끗/;

// 역할어 포함 오탐 — "음대표", "데의사", "총관리" 등 역할어가 포함된 2~3자 복합어
const BAD_ROLE_CONTAINS_RE = /대표|원장|실장|선생|간호|관리|총괄|부원|지점|병원|상담|담당|직원|코디|데스크|의사/;

// 추가 지시어·형용사·조사 namePart 오탐 차단
const EXTRA_BAD_NAMES = new Set([
  '같은', '같이', '같아', '같고', '같습', '같네',
  '무엇', '뭐든', '모든', '어떤', '이런', '저런', '그런',
  '보다', '부터', '까지', '에서', '으로', '이랑', '하고',
  '엇보', '것보', '처음', '이번', '저번', '다음', '요즘',
]);

// ── 메인 탐지 함수 ────────────────────────────────────────────────────────────

/**
 * 생성 리뷰 본문에서 환각 신호를 탐지한다.
 *
 * @param {string} body - 생성된 리뷰 본문
 * @param {string[]} allowedStaffNames - 그 지점 팩트풀의 담당자명 엔티티 배열
 *   예: ['이민희원장님', '민희원장님']
 *   allowedStaffNames 중 어느 하나에 body 내 캡처된 이름이 포함되면 허용된 이름으로 간주.
 * @returns {{ flags: Array<{type: string, text: string, reason: string}>, risk: 'none'|'low'|'high' }}
 */
export function detectHallucination(body, allowedStaffNames = []) {
  if (!body || typeof body !== 'string') {
    return { flags: [], risk: 'none' };
  }

  const flags = [];

  // ── 규칙 1: price ────────────────────────────────────────────────────────
  {
    PRICE_RE.lastIndex = 0;
    let m;
    while ((m = PRICE_RE.exec(body)) !== null) {
      flags.push({ type: 'price', text: m[0], reason: '팩트풀에 가격 없음 — 구체 금액은 환각 의심' });
    }
  }

  // ── 규칙 2: quantity ─────────────────────────────────────────────────────
  {
    QUANTITY_RE.lastIndex = 0;
    let m;
    while ((m = QUANTITY_RE.exec(body)) !== null) {
      // 팩트풀 텍스트(allowedStaffNames)에 해당 토큰 전체가 있으면 제외
      // (allowedStaffNames는 이름 엔티티이므로 임상 수치와 겹치는 일은 거의 없지만 스펙대로 구현)
      const token = m[0];
      const inFactPool = allowedStaffNames.some(n => n.includes(token));
      if (!inFactPool) {
        flags.push({ type: 'quantity', text: token, reason: '임상 수치 — 팩트풀에 없는 구체 수량' });
      }
    }
  }

  // ── 규칙 3: name ─────────────────────────────────────────────────────────
  {
    STAFF_NAME_RE.lastIndex = 0;
    let m;
    while ((m = STAFF_NAME_RE.exec(body)) !== null) {
      const namePart = m[1];

      // 앞 글자가 한글인 경우: 단어 경계 없음 → "도최윤실장님"처럼 앞 단어에 붙은 오탐 제거
      // m.index > 0 이고 바로 앞 문자가 한글이면 이름이 아닌 합성어로 간주
      if (m.index > 0 && /[가-힣]/.test(body[m.index - 1])) continue;

      // namePart와 역할어 사이에 공백이 있으면 수식어 오탐
      // 예: "갔다가 원장님" → m[2] 앞 공백 존재 → 수식어
      // m[0]에서 namePart 이후를 보면: m[0] = namePart + (공백?) + 역할어
      const hasSpaceBetween = m[0].length > (namePart.length + m[2].length);
      if (hasSpaceBetween) continue;

      // generic 호칭 필터: 역할어/지시어이면 무시
      if (ROLE_WORDS.has(namePart)) continue;
      // 추가 지시어·형용사 오탐 제거
      if (EXTRA_BAD_NAMES.has(namePart)) continue;
      // 동사·접속어 어미 오탐 제거
      if (BAD_SUFFIX_RE.test(namePart)) continue;
      // 형용사 어근 오탐 제거
      if (BAD_ADJECTIVE_RE.test(namePart)) continue;
      // 역할어 포함 복합어 오탐 제거 ("음대표", "데의사" 등)
      if (BAD_ROLE_CONTAINS_RE.test(namePart)) continue;

      // 진짜 이름처럼 보이는 경우 — allowedStaffNames 확인
      const fullMatch = m[0].replace(/\s+/g, ''); // 공백 제거 정규화
      // allowedStaffNames 중 하나에 namePart 또는 fullMatch가 포함되면 허용
      const isAllowed = allowedStaffNames.some(
        allowed => allowed.includes(namePart) || allowed.includes(fullMatch)
      );
      if (!isAllowed) {
        flags.push({
          type: 'name',
          text: m[0],
          reason: `풀에 없는 담당자 이름: "${namePart}" (허용 목록: ${allowedStaffNames.length > 0 ? allowedStaffNames.join(', ') : '없음'})`,
        });
      }
    }
  }

  // ── risk 종합 ─────────────────────────────────────────────────────────────
  const hasName  = flags.some(f => f.type === 'name');
  const hasPrice = flags.some(f => f.type === 'price');
  const hasQty   = flags.some(f => f.type === 'quantity');

  let risk = 'none';
  if (hasName || hasPrice) risk = 'high';
  else if (hasQty) risk = 'low';

  return { flags, risk };
}
