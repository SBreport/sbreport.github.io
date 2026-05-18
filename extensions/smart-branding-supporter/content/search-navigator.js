// content/search-navigator.js
// SBS 기능 ②: 검색 결과 좌측 섹션 네비게이터
// 적용: search.naver.com/search.naver (PC 통합검색)

(function () {
  "use strict";

  // ─── 상수 ────────────────────────────────────────────────────────────────────

  const STORAGE_KEY     = "searchNavigator";
  const POSITION_KEY    = "searchNavigatorPosition";
  const BLOG_COUNT_KEY  = "blogCount";
  const NAV_ID          = "sbs-nav";
  const STYLE_ID        = "sbs-nav-style";
  // 분석기 사이트 URL — 베타 종료 페이지(sbsupport.netlify.app/)와는 별개 경로
  // 정식 사이트 출시 시 이 한 줄만 교체
  const SITE_URL        = "https://sbsupport.netlify.app/analyzer/";

  // 검색창·탭 아래 첫 콘텐츠가 보이는 위치 (휴리스틱 오프셋)
  const TOP_OFFSET = 100;

  // 섹션 ID → 라벨 / UGC 여부 / 광고 여부 매핑
  // 키: areaId의 접두사. startsWith()로 매칭.
  // isAd: true면 광고 배지 + 회색 톤 (isUgc보다 우선)
  // isUgc: true면 녹색 톤
  //
  // 중요: 매칭 시 키를 length DESC로 정렬해 긴 접두사 우선 매칭.
  const SECTION_MAP = {
    // 신규 네이버 ID 체계 (현행 — 6글자 접두사)
    "pwl_":   { label: "파워링크",       isUgc: false, isAd: true  },
    "urB_":   { label: "통합검색",         isUgc: false, isAd: false, isMixed: true },
    "ugB_":   { label: null, isMixed: true, isUgc: false, isAd: false },
    "nmb_":   { label: "플레이스",       isUgc: false, isAd: false },
    "kwX_":   { label: "함께 많이 찾는", isUgc: false, isAd: false },
    "nws_":   { label: null,             isUgc: false, isAd: false }, // 뉴스 신형
    "vdB_":   { label: null,             isUgc: false, isAd: false }, // 비디오/네이버 클립 (vdB_cpC 등)
    "web_":   { label: "관련 사이트",    isUgc: false, isAd: false }, // 일반 웹사이트 결과 (web_gen 등 — 모두닥/하이닥 같은 외부 사이트, 헤더 없어서 명시 라벨)

    // 옛 짧은 코드 (다른 검색어에서 나올 수 있음)
    "blg":    { label: "블로그",         isUgc: true,  isAd: false },
    "caf":    { label: "카페",           isUgc: true,  isAd: false },
    "kin":    { label: "지식iN",         isUgc: true,  isAd: false },
    "influ":  { label: "인플루언서",     isUgc: true,  isAd: false },
    "news":   { label: "뉴스",           isUgc: false, isAd: false },
    "img":    { label: "이미지",         isUgc: false, isAd: false },
    "vid":    { label: "동영상",         isUgc: false, isAd: false },
    "shp":    { label: "쇼핑",           isUgc: false, isAd: false },
    "shop":   { label: "쇼핑",           isUgc: false, isAd: false },
    "plac":   { label: "플레이스",       isUgc: false, isAd: false },
    "brd":    { label: "브랜드콘텐츠",   isUgc: false, isAd: true  },
    "smart":  { label: "스마트블록",     isUgc: false, isAd: false },
    "pwl":    { label: "파워링크",       isUgc: false, isAd: true  },
  };

  // data-meta-area도 nx_cr_area_info에도 없는 특수 영역 — 별도 셀렉터로 인식
  // 향후 다른 특수 영역(쇼핑, 지도 변종 등) 발견 시 이 배열에 추가
  const SPECIAL_SECTIONS = [
    {
      selector: "#place-app-root",
      label: "플레이스",
      areaId: "__place_app_root",
    },
  ];

  /**
   * 영역이 사실상 보이는지 체크. 네이버는 검색어에 따라 영역을 등록만 하고
   * 콘텐츠는 안 채우는 경우가 있어 (height:0) 박스에 잘못 표시됨.
   * @param {Element} el
   * @returns {boolean}
   */
  function isElementVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    return true;
  }

  // SECTION_MAP 키를 길이 내림차순으로 정렬한 배열 — 긴 접두사 우선 매칭
  const SECTION_MAP_KEYS_SORTED = Object.keys(SECTION_MAP).sort(
    (a, b) => b.length - a.length
  );

  // ─── 상태 ────────────────────────────────────────────────────────────────────

  let state = {
    enabled:          false,
    position:         "auto", // searchNavigatorPosition 값
    sections:         [],   // { areaId, element, label, isUgc, isAd }
    closed:           false, // 사용자가 × 눌러서 닫았는지
    activeAreaId:     null,
    scrollRafId:      null,
    pollIntervalId:   null,
    mutationObserver: null,
    mutationThrottle: null,
    lastQuery:        "",
    lastSignature:    "",   // sections 시그니처 — 불필요한 재생성 skip용
    scrollHandler:    null, // 제거 시 참조 필요
  };

  // ─── CSS ─────────────────────────────────────────────────────────────────────

  function getCss() {
    return `
#sbs-nav {
  position: fixed;
  /* left/top/right/bottom/transform 모두 JS가 설정 */
  z-index: 9999;
  background: #fff;
  border: 1px solid #e5e5e5;
  border-radius: 8px;
  padding: 10px 0 10px 0;
  box-shadow: 0 2px 8px rgba(0,0,0,0.12);
  width: 200px;
  min-width: 200px;
  font-family: 'Pretendard', system-ui, -apple-system, sans-serif;
  font-size: 12px;
  line-height: 1.4;
  box-sizing: border-box;
}

.sbs-nav-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 2px 12px 8px 12px;
  border-bottom: 1px solid #ececec;
  margin-bottom: 4px;
}

.sbs-nav-title {
  font-size: 12px;
  font-weight: 700;
  color: #222;
  letter-spacing: -0.005em;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.sbs-nav-title::before {
  content: "";
  display: inline-block;
  width: 6px;
  height: 6px;
  background: #03c75a;
  border-radius: 50%;
  flex-shrink: 0;
}

.sbs-nav-close {
  background: none;
  border: none;
  cursor: pointer;
  padding: 0 4px;
  font-size: 16px;
  color: #aaa;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 3px;
  transition: color 0.15s, background 0.15s;
}
.sbs-nav-close:hover {
  color: #555;
  background: #f0f0f0;
}

.sbs-nav-list {
  list-style: none;
  margin: 0;
  padding: 4px 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.sbs-nav-item {
  border-radius: 4px;
  padding: 6px 10px;
  transition: background 0.12s;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.sbs-nav-item button {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  min-width: 0;
  text-align: left;
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;
  font-size: 12px;
  font-family: inherit;
  border-radius: 0;
  box-sizing: border-box;
}

/* 광고 항목 기본 색 */
.sbs-nav-item.sbs-nav-item--ad button {
  color: #888;
}

/* UGC 항목 기본 색 */
.sbs-nav-item.sbs-nav-item--ugc button {
  color: #2db400;
}

/* 일반 항목 기본 색 */
.sbs-nav-item button {
  color: #555;
}

/* hover (비활성 항목만) */
.sbs-nav-item:not(.sbs-nav-item--active):hover {
  background: #f5f5f5;
}

/* 활성 항목: li 전체 배경 녹색 + 흰 글자 */
.sbs-nav-item.sbs-nav-item--active {
  background: #03c75a;
}
.sbs-nav-item.sbs-nav-item--active button {
  color: #fff;
  font-weight: 600;
}
.sbs-nav-item.sbs-nav-item--active .sbs-nav-dot {
  color: #fff;
}
.sbs-nav-item.sbs-nav-item--active .sbs-nav-badge {
  background: rgba(255, 255, 255, 0.25);
  color: #fff;
}
/* 활성 항목 안의 배지: 흰 배경 + 색 글자로 반전 (녹색 위 녹색 회피) */
.sbs-nav-item.sbs-nav-item--active .sbs-nav-comp-blog { background: #fff; color: #2db400; }
.sbs-nav-item.sbs-nav-item--active .sbs-nav-comp-cafe { background: #fff; color: #f97224; }
.sbs-nav-item.sbs-nav-item--active .sbs-nav-comp-kin  { background: #fff; color: #4a8af4; }
.sbs-nav-item.sbs-nav-item--active .sbs-nav-comp-ad   { background: #fff; color: #6c757d; }
.sbs-nav-item.sbs-nav-item--active .sbs-nav-comp-web  { background: #fff; color: #555; }

/* 활성 항목 안의 +N more 표시도 흰색 */
.sbs-nav-item.sbs-nav-item--active .sbs-nav-comp-more { color: #fff; }

.sbs-nav-dot {
  font-size: 8px;
  line-height: 1;
  flex-shrink: 0;
}

.sbs-nav-label {
  display: block;
  white-space: normal;
  overflow: visible;
  text-overflow: clip;
  word-break: keep-all;
  line-height: 1.3;
  flex: 1;
  min-width: 0;
}

/* 광고 배지 */
.sbs-nav-badge {
  display: inline-block;
  font-size: 9px;
  background: #ddd;
  color: #666;
  padding: 1px 4px;
  border-radius: 3px;
  margin-left: 2px;
  vertical-align: middle;
  flex-shrink: 0;
  line-height: 1.4;
}

/* 박스 footer — 메인 사이트 CTA + 슬로건 */
.sbs-nav-footer {
  margin-top: 6px;
  padding: 12px 12px 10px;
  border-top: 1px solid #ececec;
  background: #f8faff;
  cursor: pointer;
  text-align: center;
  transition: background 0.15s;
}
.sbs-nav-footer:hover {
  background: #ebf4ff;
}
.sbs-nav-footer-cta {
  font-size: 12.5px;
  font-weight: 700;
  color: #1684F2;
  letter-spacing: -0.005em;
}
.sbs-nav-footer-slogan {
  font-size: 10.5px;
  color: #888;
  margin-top: 3px;
  letter-spacing: -0.005em;
}

/* 신스블 내부 카드 구성 인디케이터 */
.sbs-nav-composition {
  display: flex;
  gap: 3px;
  flex-wrap: wrap;
  /* margin/padding 없음 — .sbs-nav-item의 gap이 라벨과 간격 처리 */
}
.sbs-nav-comp {
  display: inline-flex;
  width: 16px;
  height: 16px;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 700;
  color: #fff;
  border-radius: 3px;
  flex-shrink: 0;
}
.sbs-nav-comp-blog { background: #2db400; }
.sbs-nav-comp-cafe { background: #f97224; }
.sbs-nav-comp-kin  { background: #4a8af4; }
.sbs-nav-comp-ad   { background: #6c757d; }
.sbs-nav-comp-web  { background: #b0b0b0; }
.sbs-nav-comp-more {
  display: inline-flex;
  height: 16px;
  align-items: center;
  font-size: 10px;
  font-weight: 600;
  color: #888;
  padding: 0 3px;
}

/* 토글 OFF 시 숨김 클래스 */
#sbs-nav.sbs-nav-hide-related .sbs-nav-section-volume-related { display: none !important; }
#sbs-nav.sbs-nav-hide-blog-count .sbs-nav-blog-count { display: none !important; }
    `.trim();
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const el = document.createElement("style");
    el.id = STYLE_ID;
    el.textContent = getCss();
    document.head.appendChild(el);
  }

  function removeStyle() {
    const el = document.getElementById(STYLE_ID);
    if (el) el.remove();
  }

  // ─── 섹션 데이터 파싱 ─────────────────────────────────────────────────────────

  /**
   * script 태그에서 nx_cr_area_info 전역 변수를 정규식으로 추출.
   * content script는 page context와 격리되어 있어 window 접근이 불가하므로
   * HTML 소스에서 직접 파싱하는 방식을 사용.
   * @returns {Array|null}
   */
  function parseAreaInfo() {
    const scripts = document.querySelectorAll("script");
    for (const s of scripts) {
      const text = s.textContent;
      if (!text || !text.includes("nx_cr_area_info")) continue;
      // 배열 리터럴 전체를 캡처: [ ... ] 내부에 중첩 객체 포함
      const m = text.match(/nx_cr_area_info\s*=\s*(\[[\s\S]*?\])\s*;/);
      if (m) {
        try {
          return JSON.parse(m[1]);
        } catch (e) {
          // JSON 파싱 실패 시 다음 script 탐색 계속
        }
      }
    }
    return null;
  }

  // ─── 섹션 DOM 요소 탐색 ───────────────────────────────────────────────────────

  /**
   * areaId로 페이지 상의 실제 섹션 DOM 요소를 찾는다.
   * 특수 케이스 → 일반 data 속성 → id 폴백 순으로 시도.
   * @param {string} areaId  nx_cr_area_info의 n 필드값
   * @returns {Element|null}
   */
  function findSectionElement(areaId) {
    // 1. 특수 케이스
    if (areaId === "pwl" || areaId.startsWith("pwl_")) {
      const el = document.querySelector("[id^='pcPowerLink'] .ad_section")
                 ?? document.querySelector("[id^='pcPowerLink']");
      if (el) return el;
    }
    if (areaId === "shp" || areaId.startsWith("shp_")) {
      const el = document.querySelector("#shp_dig_root")
                 ?? document.querySelector("[data-slog-container^='shp_dig']");
      if (el) return el;
    }
    if (areaId === "brd" || areaId.startsWith("brd_")) {
      const el = document.querySelector(".brand_search.section")
                 ?? document.querySelector(".brand_search");
      if (el) return el;
    }

    // 1순위: data-slog-container 정확 매칭 (외부 wrapper)
    let el = document.querySelector(`[data-slog-container="${areaId}"]`);
    if (el) return el;

    // 2순위: data-slog-container 접두사 매칭
    el = document.querySelector(`[data-slog-container^="${areaId}"]`);
    if (el) return el;

    // 3순위: data-meta-area — 다수 매칭이면 공통 부모 반환
    const matches = document.querySelectorAll(`[data-meta-area="${areaId}"]`);
    if (matches.length > 1) {
      let common = matches[0].parentElement;
      while (common) {
        let containsAll = true;
        for (let i = 1; i < matches.length; i++) {
          if (!common.contains(matches[i])) { containsAll = false; break; }
        }
        if (containsAll) return common;
        common = common.parentElement;
      }
      return matches[0];
    }
    if (matches.length === 1) return matches[0];

    // 4순위: data-meta-area 접두사
    el = document.querySelector(`[data-meta-area^="${areaId}"]`);
    if (el) return el;

    // 5순위: data-laim-exp-id
    el = document.querySelector(`[data-laim-exp-id="${areaId}"]`);
    if (el) return el;
    el = document.querySelector(`[data-laim-exp-id^="${areaId}"]`);
    if (el) return el;

    // 6순위: id 기반 폴백
    el = document.getElementById(`${areaId}_root`);
    if (el) return el;
    el = document.querySelector(`[id^="${areaId}"]`);
    if (el) return el;

    return null;
  }

  /**
   * areaId에 해당하는 SECTION_MAP 항목을 반환.
   * 키를 length DESC로 정렬한 배열(SECTION_MAP_KEYS_SORTED)로 startsWith() 매칭해
   * 긴 접두사가 먼저 매칭되도록 보장한다.
   * @param {string} areaId
   * @returns {{ label: string, isUgc: boolean, isAd: boolean }|null}
   */
  function getSectionMeta(areaId) {
    if (!areaId) return null;
    const key = SECTION_MAP_KEYS_SORTED.find((k) => areaId.startsWith(k));
    return key ? SECTION_MAP[key] : null;
  }

  // ─── 라벨 추출 — heading 우선 전략 ──────────────────────────────────────────

  /**
   * 섹션 컨테이너 DOM에서 헤딩 텍스트를 추출한다.
   * 우선순위: h2 > h3 > .api_title > .title > .mod_title
   *
   * 헤딩 안의 부가 텍스트(예: "내 업체 등록" 앵커 등)를 배제하기 위해
   * 첫 번째 직접 텍스트 노드 또는 첫 자식 요소의 텍스트만 사용한다.
   * 추출된 텍스트가 30자를 초과하거나 비어있으면 null 반환.
   *
   * @param {Element} container
   * @returns {string|null}
   */
  function extractHeading(container) {
    // 좁은 셀렉터부터 시도 — 신형 SDS 컴포넌트, 구형 api 박스, 광범위 h2/h3 순
    const selectorGroups = [
      ".sds-comps-header h2, .sds-comps-header h3",
      // 신형 SDS 컴포넌트(sdsFeedSearchHeader 등)는 h2 대신 span.sds-comps-text-type-headline*에 라벨이 들어감
      ".sds-comps-header [class*='sds-comps-text-type-headline']",
      ".api_subject_bx h2, .api_subject_bx h3",
      ".api_title, .title, .mod_title",
      "h2, h3",
    ];
    const seen = new Set();
    const candidates = [];
    for (const sel of selectorGroups) {
      for (const el of container.querySelectorAll(sel)) {
        if (!seen.has(el)) { seen.add(el); candidates.push(el); }
      }
    }
    for (const h of candidates) {
      let text = "";

      // 첫 번째 직접 텍스트 노드 우선
      for (const node of h.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          text = node.textContent.trim();
          if (text) break;
        }
      }

      // 직접 텍스트 노드가 없으면 첫 자식 요소의 텍스트
      if (!text && h.firstElementChild) {
        text = h.firstElementChild.textContent.trim();
      }

      // 최후 폴백: 전체 텍스트의 첫 줄
      if (!text) {
        text = h.textContent.split("\n")[0].trim();
      }

      if (text && text.length > 0 && text.length <= 30) {
        return text;
      }
    }
    return null;
  }

  /**
   * 섹션의 표시 라벨을 결정한다.
   * 1. 섹션 요소의 헤딩 텍스트 (extractHeading)
   * 2. SECTION_MAP 매칭 라벨
   * 3. areaId 그대로
   *
   * @param {Element} element   섹션 DOM 요소
   * @param {string}  mapLabel  SECTION_MAP에서 찾은 라벨 (또는 null)
   * @param {string}  areaId    폴백용 원본 ID
   * @returns {string}
   */
  function resolveLabel(element, mapLabel, areaId) {
    const heading = extractHeading(element);
    if (heading) return heading;
    if (mapLabel) return mapLabel;
    return areaId;
  }

  // ─── 중복 라벨 넘버링 ─────────────────────────────────────────────────────────

  /**
   * 같은 라벨이 2개 이상인 경우 "라벨 1", "라벨 2" 식으로 번호를 붙인다.
   * 1개뿐인 라벨은 그대로 유지.
   * @param {Array} sections
   * @returns {Array}
   */
  function applyDuplicateNumbering(sections) {
    const counts = {};
    sections.forEach((s) => {
      counts[s.label] = (counts[s.label] || 0) + 1;
    });
    const seen = {};
    return sections.map((s) => {
      if (counts[s.label] > 1) {
        seen[s.label] = (seen[s.label] || 0) + 1;
        // 숫자 대신 알파벳(A/B/C…)으로 — "통합검색 1 (10건"의 1과 10이 시각적으로 붙어 헷갈리는 문제 회피
        // 26개 초과 시 숫자 폴백
        const n = seen[s.label];
        const suffix = n <= 26 ? String.fromCharCode(64 + n) : n.toString();
        return { ...s, label: `${s.label} ${suffix}` };
      }
      return s;
    });
  }

  // ─── 신스블 내부 카드 분석 ───────────────────────────────────────────────────

  // 네이버 시스템 기능 링크 도메인 — analyzeMixedBlock에서 카드 후보에서 제외
  const SYSTEM_DOMAINS = new Set([
    "search.naver.com",
    "keep.naver.com",
    // ader.naver.com 은 광고 카드 분류를 위해 제외 (CARD_TYPE_RULES "ad" 항목으로 매칭)
    "kup.naver.com",
    "help.naver.com",
  ]);

  const CARD_TYPE_RULES = [
    { type: "블로그",   key: "blog", color: "#2db400", hosts: ["blog.naver.com", "m.blog.naver.com", "in.naver.com"] },
    { type: "카페",     key: "cafe", color: "#f97224", hosts: ["cafe.naver.com", "m.cafe.naver.com"] },
    { type: "지식인",   key: "kin",  color: "#4a8af4", hosts: ["kin.naver.com", "m.kin.naver.com"] },
    { type: "광고",     key: "ad",   color: "#6c757d", hosts: ["ader.naver.com"] },
    { type: "웹사이트", key: "web",  color: "#b0b0b0", hosts: [] }, // 폴백
  ];

  const WEB_TYPE = CARD_TYPE_RULES.find(r => r.key === "web");
  const KIN_TYPE = CARD_TYPE_RULES.find(r => r.key === "kin");

  const CARD_SELECTORS = [
    ".fds-web-doc-root",               // 신형 통합검색 카드 (개별 카드 단위)
    ".fds-ugc-block-mod",              // UGC 카드 (구형)
    "[data-template-id='ugcItem']",    // UGC (신형 모바일/PC 공용)
    "[data-template-id='ugcItemDesk']", // UGC (신형 PC 데스크탑)
    "._fe_view_power_content",          // 건강·의학 인기글 등 ugB_ 섹션 카드
  ];

  /**
   * SVG의 className은 SVGAnimatedString이라 .includes() 호출 시 터짐. 안전 처리.
   * @param {Element} el
   * @returns {string}
   */
  function safeClass(el) {
    if (!el) return "";
    if (typeof el.className === "string") return el.className;
    if (el.className && typeof el.className.baseVal === "string") return el.className.baseVal;
    return "";
  }

  /**
   * 카드 요소를 받아 해당하는 CARD_TYPE_RULES 항목을 반환.
   * 1순위: 프로필 영역 텍스트에 "네이버 지식iN" → 지식인, 도메인 노출 → 웹사이트
   * 2순위: 카드 전체 텍스트에 "네이버 지식iN" 표식 → 지식인
   * 3순위: 카드 내부 첫 본문 링크의 도메인 매칭
   * @param {Element} card
   * @returns {{ type: string, key: string, color: string }|null}
   */
  function determineCardType(card) {
    // 1순위: 프로필 영역에 도메인 노출 여부 검사
    const profileSelectors = [
      "[data-sds-comp='Profile']",
      "[class*='profile']",
      "[class*='source']",
      "[class*='header']",
    ];
    for (const sel of profileSelectors) {
      const pe = card.querySelector(sel);
      if (!pe) continue;
      const t = pe.textContent || "";
      // "네이버 지식iN"이 먼저 — 지식인 우선
      if (/네이버\s*지식iN/.test(t)) return KIN_TYPE;
      // 도메인 노출 패턴: blog.naver.com, cafe.naver.com, kin.naver.com, 또는 외부 도메인
      if (/(?:blog|cafe|kin)\.naver\.com|[a-z0-9-]+\.(?:com|co\.kr|kr|net|org)\b/i.test(t)) {
        return WEB_TYPE;
      }
      break; // 첫 프로필 영역만 검사
    }

    // 2순위: 카드 전체 텍스트에 "네이버 지식iN" 표식
    const cardText = card.textContent || "";
    if (/네이버\s*지식iN|지식iN/.test(cardText)) return KIN_TYPE;

    // 3순위: 카드 내부 첫 본문 링크의 도메인 매칭
    const links = card.querySelectorAll("a[href]");
    for (const a of links) {
      let url;
      try { url = new URL(a.href); } catch { continue; }
      if (SYSTEM_DOMAINS.has(url.hostname)) continue;
      if (!/^https?:$/.test(url.protocol)) continue;

      // 도메인 매칭
      for (const rule of CARD_TYPE_RULES) {
        if (rule.hosts.some(h => url.hostname === h)) return rule;
      }
      // 외부 도메인
      return WEB_TYPE;
    }

    return null; // 식별 실패
  }

  /**
   * isMixed 섹션(통합검색) 컨테이너 안의 카드를 분석해 타입 배열을 반환.
   * 1순위: data-meta-area="${areaId}" 반복 패턴 (urB_coR 등 동일 areaId가 카드별로 반복)
   * 2순위: 네이버 SERP의 명시적 카드 클래스(fds-web-doc-root, fds-ugc-block-mod 등) 폴백
   * @param {Element} container
   * @param {string}  [areaId]  섹션 areaId (data-meta-area 반복 패턴 탐지에 사용)
   * @returns {Array<{ type: string, key: string, color: string }>}
   */
  function analyzeMixedBlock(container, areaId) {
    // 1순위: data-meta-area="${areaId}"가 카드별로 반복되는 패턴
    if (areaId) {
      const innerCards = Array.from(container.querySelectorAll(`[data-meta-area="${areaId}"]`));
      // container 자신이 data-meta-area를 가진 경우 제외
      const filtered = innerCards.filter(card => card !== container);
      if (filtered.length > 0) {
        // querySelectorAll 결과는 이미 문서 순서
        const cards = [];
        for (const card of filtered) {
          const type = determineCardType(card);
          if (type) cards.push(type);
        }
        return cards;
      }
    }

    // 2순위: 기존 fds-*/ugcItem 셀렉터 폴백
    const cardSet = new Set();
    for (const sel of CARD_SELECTORS) {
      container.querySelectorAll(sel).forEach(el => cardSet.add(el));
    }

    // 중첩 카드 제거: 다른 카드가 조상이면 skip
    const cardArr = Array.from(cardSet);
    const topLevel = cardArr.filter(card => {
      let p = card.parentElement;
      while (p && p !== container && p !== document.body) {
        if (cardSet.has(p)) return false; // 부모가 카드면 자기는 nested → skip
        p = p.parentElement;
      }
      return true;
    });

    // 문서 순서로 정렬
    topLevel.sort((a, b) => {
      const pos = a.compareDocumentPosition(b);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });

    // 각 카드 타입 결정
    const cards = [];
    for (const card of topLevel) {
      const type = determineCardType(card);
      if (type) cards.push(type);
    }
    return cards; // [{type, key, color}, ...]
  }

  /**
   * 파워링크 섹션 컨테이너에서 광고 카드 개수를 반환.
   * 폴백 셀렉터 순으로 시도해 0보다 큰 첫 결과를 반환.
   * @param {Element} container
   * @returns {number}
   */
  function countAdCards(container) {
    const sels = [
      ".lst_type > li",
      ".ad_section > li",
      "ul.lst_type > li",
    ];
    for (const sel of sels) {
      const n = container.querySelectorAll(sel).length;
      if (n > 0) return n;
    }
    return 0;
  }

  /**
   * composition 배열을 받아 미니 인디케이터 HTML 문자열을 반환.
   * 최대 5개까지 표시하고, 초과분은 "+N" 표기.
   * @param {Array|null} composition
   * @returns {string}
   */
  function buildCompositionHtml(composition) {
    if (!composition || composition.length === 0) return "";
    const MAX = 5;
    const visible = composition.slice(0, MAX);
    const overflow = composition.length - MAX;

    const items = visible.map(c =>
      `<span class="sbs-nav-comp sbs-nav-comp-${escapeHtml(c.key)}" title="${escapeHtml(c.type)}">${escapeHtml(c.type.charAt(0))}</span>`
    ).join("");

    const more = overflow > 0
      ? `<span class="sbs-nav-comp-more" title="추가 ${overflow}개">+${overflow}</span>`
      : "";

    return `<div class="sbs-nav-composition">${items}${more}</div>`;
  }

  // ─── 섹션 시그니처 ───────────────────────────────────────────────────────────

  /**
   * sections 배열을 문자열 시그니처로 변환.
   * 본질적으로 같은 목록이면 동일 문자열이 된다 → 불필요한 renderNav 스킵에 사용.
   * @param {Array} sections
   * @returns {string}
   */
  function signatureOf(sections) {
    return sections.map(s =>
      `${s.areaId}|${s.label}|${s.count ?? "-"}|${(s.composition || []).map(c => c.key).join(",")}`
    ).join("||");
  }

  // ─── DOM 생성 / 렌더 ──────────────────────────────────────────────────────────

  /** HTML 특수문자 이스케이프 */
  function escapeHtml(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /**
   * sections 배열을 받아 #sbs-nav aside 요소를 생성해 반환.
   * @param {Array} sections
   * @returns {HTMLElement}
   */
  function buildNavDom(sections) {
    const aside = document.createElement("aside");
    aside.id = NAV_ID;
    aside.setAttribute("role", "navigation");
    aside.setAttribute("aria-label", "검색 섹션 네비게이터");

    // 헤더
    const header = document.createElement("header");
    header.className = "sbs-nav-header";

    const title = document.createElement("span");
    title.className = "sbs-nav-title";
    title.textContent = "스마트브랜딩 서포터";

    const closeBtn = document.createElement("button");
    closeBtn.className = "sbs-nav-close";
    closeBtn.setAttribute("aria-label", "닫기");
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", onCloseClick);

    header.appendChild(title);
    header.appendChild(closeBtn);
    aside.appendChild(header);

    // 리스트
    const ul = document.createElement("ul");
    ul.className = "sbs-nav-list";

    for (const sec of sections) {
      const li = document.createElement("li");

      // 클래스: 광고 > UGC > 일반 순 우선
      let itemClass = "sbs-nav-item";
      if (sec.isAd)       itemClass += " sbs-nav-item--ad";
      else if (sec.isUgc) itemClass += " sbs-nav-item--ugc";
      li.className = itemClass;
      li.dataset.areaId = sec.areaId;

      const btn = document.createElement("button");
      btn.setAttribute("type", "button");

      // 점 아이콘
      const dot = document.createElement("span");
      dot.className = "sbs-nav-dot";
      dot.textContent = "○";
      dot.setAttribute("aria-hidden", "true");

      // 라벨 (N건 접미사 포함)
      const labelSpan = document.createElement("span");
      labelSpan.className = "sbs-nav-label";
      if (sec.isMixed && sec.composition && sec.count != null && sec.count > 0) {
        const blogCount = sec.composition.filter(c => c.key === "blog").length;
        const blogSpanHtml = blogCount > 0
          ? `<span class="sbs-nav-blog-count">, 블 ${blogCount}</span>`
          : "";
        const plainText = `${sec.label} (${sec.count}건${blogCount > 0 ? `, 블 ${blogCount}` : ""})`;
        labelSpan.title = plainText;
        labelSpan.innerHTML = `${escapeHtml(sec.label)} (${sec.count}건${blogSpanHtml})`;
      } else {
        const countSuffix = sec.count != null && sec.count > 0 ? ` (${sec.count}건)` : "";
        const labelText = `${sec.label}${countSuffix}`;
        labelSpan.title = labelText;
        labelSpan.textContent = labelText;
      }

      btn.appendChild(dot);

      // 광고 배지 — labelSpan 앞에 두어 라벨 읽기 전에 광고 여부를 먼저 인지 (긴 라벨에서도 즉시 식별)
      if (sec.isAd) {
        const badge = document.createElement("span");
        badge.className = "sbs-nav-badge";
        badge.textContent = "AD";
        badge.setAttribute("aria-label", "광고");
        btn.appendChild(badge);
      }

      btn.appendChild(labelSpan);

      // 클릭 → 해당 섹션으로 부드러운 스크롤 (상단 70px 여유)
      btn.addEventListener("click", () => {
        const rect = sec.element.getBoundingClientRect();
        const targetY = window.scrollY + rect.top - 70;
        window.scrollTo({ top: targetY, behavior: "smooth" });
      });

      li.appendChild(btn);

      // 신스블(isMixed)이면 카드 구성 인디케이터 추가
      if (sec.isMixed) {
        const compHtml = buildCompositionHtml(sec.composition);
        if (compHtml) {
          const compWrapper = document.createElement("div");
          compWrapper.innerHTML = compHtml;
          // innerHTML로 만든 div 자체가 아니라 내부 .sbs-nav-composition 을 붙임
          const compEl = compWrapper.firstElementChild;
          if (compEl) li.appendChild(compEl);
        }
      }

      ul.appendChild(li);
    }

    aside.appendChild(ul);

    // 박스 footer — 메인 사이트로 안내 CTA + 슬로건
    const footer = document.createElement("div");
    footer.className = "sbs-nav-footer";
    footer.innerHTML = `
      <div class="sbs-nav-footer-cta">키워드 전문 분석하기 →</div>
      <div class="sbs-nav-footer-slogan">병원 마케팅은 스마트 브랜딩</div>
    `;
    footer.addEventListener("click", () => {
      const params = new URLSearchParams(location.search);
      const keyword = params.get("query") || params.get("q") || "";
      const url = keyword
        ? `${SITE_URL}?q=${encodeURIComponent(keyword.replace(/\s+/g, ""))}`
        : SITE_URL;
      window.open(url, "_blank", "noopener,noreferrer");
    });
    aside.appendChild(footer);

    return aside;
  }

  /**
   * state.sections로 네비게이터 패널을 생성 또는 갱신.
   * 이미 존재하면 제거 후 재생성.
   */
  function renderNav() {
    const existing = document.getElementById(NAV_ID);
    if (existing) existing.remove();

    if (state.sections.length === 0) return;

    const nav = buildNavDom(state.sections);
    document.body.appendChild(nav);
    nav.dispatchEvent(new CustomEvent('sbs-nav-rendered', { bubbles: true, detail: { panel: nav } }));

    // DOM 생성 직후 위치 설정
    applyNavPosition();

    // 렌더 후 활성 상태 강제 재계산 (early return 회피)
    state.activeAreaId = null;
    updateActive();

    // blogCount 토글 상태 즉시 반영
    chrome.storage.sync.get(BLOG_COUNT_KEY).then((stored) => {
      applyBlogCountClass(stored[BLOG_COUNT_KEY] ?? true);
    });
  }

  // ─── 네비게이터 위치 계산 ─────────────────────────────────────────────────────

  const NAV_WIDTH = 200;
  const NAV_GAP   = 16; // 콘텐츠 경계와 네비게이터 사이 간격

  /**
   * 검색 결과 콘텐츠 영역의 DOMRect를 반환.
   * 앵커 우선순위: .api_subject_bx → #main_pack → .content_wrap
   * 너비가 0이면(숨겨진 요소) 건너뜀.
   * @returns {DOMRect|null}
   */
  function getContentRect() {
    const anchors = [".api_subject_bx", "#main_pack", ".content_wrap"];
    for (const sel of anchors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width > 0) return rect;
    }
    return null;
  }

  /**
   * 콘텐츠 영역의 left 좌표만 반환 (auto 모드 updateNavPosition용).
   * @returns {number|null}
   */
  function getContentLeft() {
    const rect = getContentRect();
    return rect ? rect.left : null;
  }

  /**
   * position 문자열("left-top" 등)을 받아 콘텐츠 영역 기준으로
   * 네비게이터에 적용할 CSS 속성 객체를 동적으로 계산해 반환.
   *
   * 가로:
   *   left-* → 콘텐츠 left 경계 - NAV_WIDTH - GAP (콘텐츠 왼쪽 바깥)
   *   right-* → window.innerWidth - 콘텐츠 right - NAV_WIDTH - GAP (right CSS 값)
   *   콘텐츠 못 찾으면 16px 폴백.
   *
   * 세로:
   *   -top    → top: TOP_OFFSET px
   *   -middle → top: 50% + translateY(-50%)
   *   -bottom → bottom: 16px
   *
   * @param {string} pos  "left-top" | "left-middle" | "left-bottom" |
   *                      "right-top" | "right-middle" | "right-bottom"
   * @returns {Object}  nav.style에 assign할 CSS 속성 객체
   */
  function computePositionStyles(pos) {
    const rect = getContentRect();
    const styles = {};

    // 가로
    if (pos.startsWith("left-")) {
      if (rect) {
        styles.left = `${Math.max(10, rect.left - NAV_WIDTH - NAV_GAP)}px`;
      } else {
        styles.left = "16px";
      }
    } else if (pos.startsWith("right-")) {
      if (rect) {
        const desired = window.innerWidth - rect.right - NAV_WIDTH - NAV_GAP;
        styles.right = `${Math.max(10, desired)}px`;
      } else {
        styles.right = "16px";
      }
    }

    // 세로
    if (pos.endsWith("-top")) {
      styles.top = `${TOP_OFFSET}px`;
      // transform은 applyNavPosition reset에서 이미 none
    } else if (pos.endsWith("-middle")) {
      styles.top = "50%";
      styles.transform = "translateY(-50%)";
    } else if (pos.endsWith("-bottom")) {
      // 긴 사이드바 모드: top + bottom 동시 지정해 세로로 확장
      styles.top = "100px";
      styles.bottom = "16px";
      styles.transform = "none"; // CSS의 translateY(-50%) 차단
    }

    return styles;
  }

  /**
   * 콘텐츠 영역 좌측 기준으로 네비게이터의 left 위치를 동적으로 설정.
   * 공간이 부족하면(desired < 10) 숨김.
   */
  function updateNavPosition() {
    const nav = document.getElementById(NAV_ID);
    if (!nav) return;
    const contentLeft = getContentLeft();
    if (contentLeft === null) return;
    const desired = contentLeft - NAV_WIDTH - NAV_GAP;
    if (desired < 10) {
      nav.style.display = "none";
      return;
    }
    nav.style.display = "";
    nav.style.left = `${desired}px`;
  }

  /**
   * state.position 값에 따라 네비게이터 위치를 적용.
   * "auto"이면 콘텐츠 좌측 동적 계산(기존 updateNavPosition).
   * 나머지 6개 고정 모드는 computePositionStyles()로 콘텐츠 영역 기준 동적 계산.
   */
  function applyNavPosition() {
    const nav = document.getElementById(NAV_ID);
    if (!nav) return;

    // 모든 위치/변환 속성 명시적 리셋
    nav.style.left      = "auto";
    nav.style.right     = "auto";
    nav.style.top       = "auto";
    nav.style.bottom    = "auto";
    nav.style.transform = "none";
    nav.style.display   = "";

    if (state.position === "auto") {
      nav.style.top       = "50%";
      nav.style.transform = "translateY(-50%)";
      updateNavPosition();
      return;
    }

    const styles = computePositionStyles(state.position);
    Object.assign(nav.style, styles);
  }

  /** 네비게이터 DOM 제거 */
  function destroyNav() {
    const el = document.getElementById(NAV_ID);
    if (el) el.remove();
  }

  // ─── 스크롤스파이 ─────────────────────────────────────────────────────────────

  /**
   * 현재 스크롤 위치를 기준으로 viewport 상단 1/3 라인 이하에 있는
   * 섹션 중 가장 위에 있는 항목을 활성으로 표시.
   */
  function updateActive() {
    const nav = document.getElementById(NAV_ID);
    if (!nav) return;

    const threshold = window.innerHeight / 3;
    let newActiveId = null;

    // 뷰포트 상단 1/3 기준: 가장 아래에서 threshold를 넘은 섹션 선택
    for (const sec of state.sections) {
      const rect = sec.element.getBoundingClientRect();
      if (rect.top <= threshold) {
        newActiveId = sec.areaId;
      }
    }

    if (newActiveId === state.activeAreaId) return;
    state.activeAreaId = newActiveId;

    // 모든 항목 비활성화 후 해당 항목만 활성화
    const items = nav.querySelectorAll(".sbs-nav-item");
    for (const li of items) {
      const isActive = li.dataset.areaId === newActiveId;
      li.classList.toggle("sbs-nav-item--active", isActive);
      const dot = li.querySelector(".sbs-nav-dot");
      if (dot) dot.textContent = isActive ? "●" : "○";
    }
  }

  function onScroll() {
    if (state.scrollRafId) return;
    state.scrollRafId = requestAnimationFrame(() => {
      state.scrollRafId = null;
      updateActive();
    });
  }

  function attachScrollSpy() {
    state.scrollHandler = onScroll;
    window.addEventListener("scroll", state.scrollHandler, { passive: true });
  }

  function detachScrollSpy() {
    if (state.scrollHandler) {
      window.removeEventListener("scroll", state.scrollHandler);
      state.scrollHandler = null;
    }
    if (state.scrollRafId) {
      cancelAnimationFrame(state.scrollRafId);
      state.scrollRafId = null;
    }
  }

  // ─── MutationObserver (무한스크롤 / 동적 DOM 대응) ───────────────────────────

  function setupMutationObserver() {
    teardownMutationObserver();

    const target = document.getElementById("main_pack") ?? document.body;

    state.mutationObserver = new MutationObserver(() => {
      // 500ms throttle: 짧은 시간에 여러 DOM 변경이 몰려도 한 번만 재로드
      if (state.mutationThrottle) return;
      state.mutationThrottle = setTimeout(() => {
        state.mutationThrottle = null;
        if (state.enabled && !state.closed) {
          loadSections();
        }
      }, 500);
    });

    state.mutationObserver.observe(target, { childList: true, subtree: true });
  }

  function teardownMutationObserver() {
    if (state.mutationObserver) {
      state.mutationObserver.disconnect();
      state.mutationObserver = null;
    }
    if (state.mutationThrottle) {
      clearTimeout(state.mutationThrottle);
      state.mutationThrottle = null;
    }
  }

  // ─── URL query 변경 감지 (검색어 변경 대응) ───────────────────────────────────

  function setupQueryPoll() {
    teardownQueryPoll();
    state.lastQuery = location.search;

    // popstate 이벤트 (브라우저 뒤로/앞으로)
    window.addEventListener("popstate", onQueryChange);

    // 1초 폴링: SPA 방식의 URL 변경도 감지
    state.pollIntervalId = setInterval(() => {
      if (location.search !== state.lastQuery) {
        onQueryChange();
      }
    }, 1000);
  }

  function teardownQueryPoll() {
    window.removeEventListener("popstate", onQueryChange);
    if (state.pollIntervalId) {
      clearInterval(state.pollIntervalId);
      state.pollIntervalId = null;
    }
  }

  function onQueryChange() {
    if (location.search === state.lastQuery) return;
    state.lastQuery = location.search;
    if (state.enabled && !state.closed) {
      // 페이지 내용이 교체될 시간을 잠깐 기다린 후 재로드
      setTimeout(() => loadSections(), 600);
    }
  }

  // ─── 섹션 로드 ───────────────────────────────────────────────────────────────

  /**
   * SPECIAL_SECTIONS 셀렉터로 매칭되는 특수 영역을 mapped 배열에 추가.
   * 이미 등록된 element와 중복인 경우 skip.
   * @param {Array} mapped
   * @returns {Array}
   */
  function appendSpecialSections(mapped) {
    for (const spec of SPECIAL_SECTIONS) {
      const el = document.querySelector(spec.selector);
      if (!el) continue;
      // 빈 영역 skip: height:0 등 실제 콘텐츠 없는 경우 제외
      if (!isElementVisible(el)) continue;
      // 중복 방지: 이미 mapped에 같은 element가 들어 있으면 skip
      if (mapped.some((s) => s.element === el)) continue;
      mapped.push({
        areaId:      spec.areaId,
        element:     el,
        label:       spec.label,
        isUgc:       false,
        isAd:        false,
        isMixed:     false,
        composition: null,
        count:       null,
      });
    }
    return mapped;
  }

  /**
   * nx_cr_area_info 파싱 → SECTION_MAP 필터 → DOM 요소 탐색 →
   * heading 우선 라벨 결정 → 중복 넘버링 → 렌더.
   * 파싱 실패 시 최대 retry회 재시도 (500ms 간격).
   * @param {number} retry  남은 재시도 횟수
   */
  function loadSections(retry = 5) {
    const raw = parseAreaInfo();

    if (!raw) {
      if (retry > 0) {
        setTimeout(() => loadSections(retry - 1), 500);
      } else {
        // 최종 폴백: DOM에서 data-meta-area 직접 스캔
        loadSectionsFallback();
      }
      return;
    }

    const mapped = raw
      .map((s) => {
        const meta = getSectionMeta(s.n);
        if (!meta) {
          // 자동 적응: SECTION_MAP에 없지만 블/카/지 카드가 있는 영역은 자동 등록
          const element = findSectionElement(s.n);
          if (!element) return null;
          // 빈 영역 skip: height:0 등 실제 콘텐츠 없는 경우 제외
          if (!isElementVisible(element)) return null;
          const composition = analyzeMixedBlock(element, s.n);
          if (!composition || composition.length === 0) return null;
          const meaningful = composition.filter(
            (c) => c.key === "blog" || c.key === "cafe" || c.key === "kin"
          );
          if (meaningful.length === 0) return null;
          const label = resolveLabel(element, null, s.n);
          return {
            areaId: s.n,
            element,
            label,
            isUgc: false,
            isAd: false,
            isMixed: true,
            composition,
            count: composition.length,
          };
        }
        const element = findSectionElement(s.n);
        if (!element) return null;
        // 빈 영역 skip: height:0 등 실제 콘텐츠 없는 경우 제외
        if (!isElementVisible(element)) return null;
        const label = resolveLabel(element, meta.label, s.n);

        // 통합검색(isMixed)이면 내부 카드 분석
        const isMixed = meta.isMixed === true;
        const composition = isMixed ? analyzeMixedBlock(element, s.n) : null;

        // 표시용 카운트: 통합검색 → 카드 수, 파워링크 → 광고 카드 수, 그 외 → null
        const matchKey = SECTION_MAP_KEYS_SORTED.find((k) => s.n.startsWith(k));
        let count = null;
        if (isMixed) {
          count = composition ? composition.length : 0;
        } else if (matchKey === "pwl_" || matchKey === "pwl") {
          count = countAdCards(element);
        }

        return {
          areaId: s.n,
          element,
          label,
          isUgc:       meta.isUgc,
          isAd:        meta.isAd,
          isMixed,
          composition, // null 또는 [{type, key, color}, ...]
          count,       // null 또는 숫자
        };
      })
      .filter(Boolean);

    appendSpecialSections(mapped);
    mapped.sort((a, b) => {
      const aTop = a.element.getBoundingClientRect().top;
      const bTop = b.element.getBoundingClientRect().top;
      return aTop - bTop;
    });

    // 중복 라벨 넘버링 적용 후 시그니처 비교 — 변화가 있을 때만 재생성
    const newSig = signatureOf(mapped);
    const numbered = applyDuplicateNumbering(mapped);

    if (state.lastSignature !== newSig) {
      state.lastSignature = newSig;
      state.sections = numbered;
      renderNav();
    }
    // 시그니처 변화와 무관하게 항상 스크롤 위치 반영
    updateActive();
  }

  /**
   * nx_cr_area_info를 끝내 못 찾았을 때의 폴백.
   * DOM의 data-meta-area 속성을 직접 스캔해 섹션 목록을 구성.
   */
  function loadSectionsFallback() {
    const candidates = document.querySelectorAll("[data-meta-area]");
    const seen = new Set();

    const mapped = [];

    for (const el of candidates) {
      const areaId = el.getAttribute("data-meta-area");
      if (!areaId || seen.has(areaId)) continue;
      seen.add(areaId);
      const meta = getSectionMeta(areaId);
      if (!meta) {
        // 자동 적응: SECTION_MAP에 없지만 블/카/지 카드가 있는 영역은 자동 등록
        // 빈 영역 skip: height:0 등 실제 콘텐츠 없는 경우 제외
        if (!isElementVisible(el)) continue;
        const composition = analyzeMixedBlock(el, areaId);
        if (!composition || composition.length === 0) continue;
        const meaningful = composition.filter(
          (c) => c.key === "blog" || c.key === "cafe" || c.key === "kin"
        );
        if (meaningful.length === 0) continue;
        const label = resolveLabel(el, null, areaId);
        mapped.push({
          areaId,
          element: el,
          label,
          isUgc: false,
          isAd: false,
          isMixed: true,
          composition,
          count: composition.length,
        });
        continue;
      }
      // 빈 영역 skip: height:0 등 실제 콘텐츠 없는 경우 제외
      if (!isElementVisible(el)) continue;
      const label = resolveLabel(el, meta.label, areaId);

      // 통합검색(isMixed)이면 내부 카드 분석
      const isMixed = meta.isMixed === true;
      const composition = isMixed ? analyzeMixedBlock(el, areaId) : null;

      // 표시용 카운트: 통합검색 → 카드 수, 파워링크 → 광고 카드 수, 그 외 → null
      const matchKey = SECTION_MAP_KEYS_SORTED.find((k) => areaId.startsWith(k));
      let count = null;
      if (isMixed) {
        count = composition ? composition.length : 0;
      } else if (matchKey === "pwl_" || matchKey === "pwl") {
        count = countAdCards(el);
      }

      mapped.push({
        areaId,
        element:     el,
        label,
        isUgc:       meta.isUgc,
        isAd:        meta.isAd,
        isMixed,
        composition, // null 또는 [{type, key, color}, ...]
        count,       // null 또는 숫자
      });
    }

    appendSpecialSections(mapped);
    mapped.sort((a, b) => {
      const aTop = a.element.getBoundingClientRect().top;
      const bTop = b.element.getBoundingClientRect().top;
      return aTop - bTop;
    });

    // 중복 라벨 넘버링 적용 후 시그니처 비교 — 변화가 있을 때만 재생성
    const newSig = signatureOf(mapped);
    const numbered = applyDuplicateNumbering(mapped);

    if (state.lastSignature !== newSig) {
      state.lastSignature = newSig;
      state.sections = numbered;
      renderNav();
    }
    // 시그니처 변화와 무관하게 항상 스크롤 위치 반영
    updateActive();
  }

  // ─── 초기화 / 해제 ───────────────────────────────────────────────────────────

  function isSearchPage() {
    return (
      location.hostname === "search.naver.com" &&
      location.pathname === "/search.naver"
    );
  }

  function onCloseClick() {
    state.closed = true;
    teardown();
  }

  /** 전체 기능 초기화 */
  function init() {
    if (window.innerWidth < 1200) return; // 좁은 화면에서는 비활성
    if (state.closed) return;             // 사용자가 닫은 상태면 재초기화 안 함
    if (!isSearchPage()) return;

    injectStyle();
    loadSections();
    attachScrollSpy();
    setupMutationObserver();
    setupQueryPoll();
  }

  /** 전체 기능 해제 — 모든 리스너·observer·interval 제거 */
  function teardown() {
    destroyNav();
    detachScrollSpy();
    teardownMutationObserver();
    teardownQueryPoll();
    removeStyle();
    state.sections      = [];
    state.activeAreaId  = null;
    state.lastSignature = "";
  }

  // ─── 블로그 카운트 표시 클래스 헬퍼 ────────────────────────────────────────────

  function applyBlogCountClass(enabled) {
    const nav = document.getElementById(NAV_ID);
    if (!nav) return;
    nav.classList.toggle("sbs-nav-hide-blog-count", !enabled);
  }

  // ─── storage 토글 연동 ────────────────────────────────────────────────────────

  // 페이지 로드 시 저장된 설정 읽기 (기본값 true / left-top)
  chrome.storage.sync.get([STORAGE_KEY, POSITION_KEY, BLOG_COUNT_KEY]).then(async (stored) => {
    state.enabled = stored[STORAGE_KEY] ?? true;
    let pos = stored[POSITION_KEY] ?? "left-top";
    // 기존 "auto" 저장값을 "left-top"으로 자동 마이그레이션
    if (pos === "auto") {
      pos = "left-top";
      await chrome.storage.sync.set({ [POSITION_KEY]: "left-top" });
    }
    state.position = pos;
    if (state.enabled) init();
    // blogCount 초기 클래스 적용 (init 이후 nav가 생성됐을 수 있으나
    // renderNav 호출 시에도 적용되므로 여기선 예비 적용)
    const blogCountEnabled = stored[BLOG_COUNT_KEY] ?? true;
    applyBlogCountClass(blogCountEnabled);
  });

  // 팝업에서 토글/위치 변경 시 실시간 반응
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;

    // 위치 변경: 페이지 새로고침 없이 즉시 반영
    if (POSITION_KEY in changes) {
      const next = changes[POSITION_KEY].newValue ?? "left-top";
      if (next !== state.position) {
        state.position = next;
        if (state.enabled) applyNavPosition();
      }
    }

    // 블로그 카운트 표시 토글
    if (BLOG_COUNT_KEY in changes) {
      applyBlogCountClass(changes[BLOG_COUNT_KEY].newValue ?? true);
    }

    // 토글 ON/OFF
    if (STORAGE_KEY in changes) {
      const next = changes[STORAGE_KEY].newValue;
      if (next === state.enabled) return;
      state.enabled = next;

      if (state.enabled) {
        state.closed = false;  // 토글 ON 시 닫힘 상태 초기화
        init();
      } else {
        teardown();
      }
    }
  });

  // 창 크기 변경 감지: 좁아지면 숨기고, 넓어지면 재표시 + 위치 재계산
  // 1200px 미만 자동 숨김은 모든 위치 모드에 동일하게 적용
  window.addEventListener("resize", () => {
    if (!state.enabled) return;
    if (window.innerWidth < 1200) {
      // 좁아졌을 때: DOM만 제거 (closed는 건드리지 않음)
      destroyNav();
    } else if (!document.getElementById(NAV_ID) && !state.closed) {
      init();
    } else {
      // 창 너비 변경 시 위치 재계산 (auto 모드면 콘텐츠 기준, 고정 모드는 no-op에 가까움)
      applyNavPosition();
    }
  });
})();
