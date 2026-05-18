// content/search-highlighter.js
// SBS 기능 ③: 네이버 검색 결과 중 블로그 항목 강조
// 적용: search.naver.com/search.naver

(function () {
  "use strict";

  const STORAGE_KEY      = "searchHighlighter";
  const COLOR_KEY        = "searchHighlighterColor";
  const STYLE_ID         = "sbs-highlighter-style";
  const HIGHLIGHTED_ATTR = "data-sbs-highlighted";

  const COLOR_PRESETS = {
    green:  "rgba(45, 180, 0, 0.10)",
    yellow: "rgba(255, 215, 0, 0.16)",
    blue:   "rgba(74, 138, 244, 0.10)",
  };

  // 블로그로 판정할 호스트 목록
  // in.naver.com: 네이버 인플루언서 콘텐츠 (사용자 인식상 블로그와 동일)
  const BLOG_HOSTS = ["blog.naver.com", "m.blog.naver.com", "in.naver.com"];

  // 링크 검사 시 시스템 도메인은 건너뜀
  const SYSTEM_DOMAINS = new Set([
    "search.naver.com",
    "keep.naver.com",
    "ader.naver.com",
    "kup.naver.com",
    "help.naver.com",
  ]);

  // 카드 단위 셀렉터 (Phase 2 검증 완료)
  const CARD_SELECTORS = [
    "[data-meta-area]",                    // 통합검색 카드 (가장 일반적)
    ".fds-web-doc-root",                   // 신형 통합검색 카드
    ".fds-ugc-block-mod",                  // UGC (구형)
    "[data-template-id='ugcItem']",        // UGC 아이템
    "[data-template-id='ugcItemDesk']",    // UGC 아이템 (데스크톱)
  ];

  // 프로필/출처 영역 셀렉터 — 도메인 텍스트 감지용
  const PROFILE_SELECTORS = [
    "[data-sds-comp='Profile']",
    "[class*='profile']",
    "[class*='source']",
    "[class*='header']",
  ];

  let enabled          = false;
  let color            = "blue";
  let observer         = null;
  let observerThrottle = null;

  // SVG 등 className이 문자열이 아닌 경우 안전 처리
  function safeClass(el) {
    if (!el) return "";
    if (typeof el.className === "string") return el.className;
    if (el.className && typeof el.className.baseVal === "string") {
      return el.className.baseVal;
    }
    return "";
  }

  /**
   * 카드가 블로그 카드인지 3단계로 판정
   *
   * 1단계: 프로필/출처 영역에 외부 도메인 텍스트가 있으면 → 웹사이트, 강조 X
   * 2단계: 카드 텍스트에 "네이버 지식iN" 포함 → 지식인, 강조 X
   * 3단계: 카드 내 첫 본문 링크 도메인이 blog.naver.com 계열 → 블로그, 강조 O
   */
  function isBlogCard(card) {
    // 0단계: 비디오/클립 영역(vdB_)은 콘텐츠 유형이 영상이라 블로그 강조 대상 아님
    // (in.naver.com이 BLOG_HOSTS에 포함되어 클립 카드가 잘못 매칭되는 케이스 회피)
    const parentArea = card.closest("[data-meta-area]")?.getAttribute("data-meta-area") || "";
    if (parentArea.startsWith("vdB_")) return false;

    // 1단계: 프로필 영역에 도메인 텍스트 → 외부 웹사이트
    for (const sel of PROFILE_SELECTORS) {
      const pe = card.querySelector(sel);
      if (!pe) continue;
      const t = pe.textContent || "";
      if (/(?:blog|cafe|kin)\.naver\.com|[a-z0-9-]+\.(?:com|co\.kr|kr|net|org)\b/i.test(t)) {
        return false;
      }
      break; // 첫 번째로 매칭된 프로필 영역만 검사
    }

    // 2단계: 지식iN 텍스트 포함 → 지식인 카드
    if (/네이버\s*지식iN|지식iN/.test(card.textContent || "")) return false;

    // 3단계: 첫 본문 링크의 호스트로 최종 판정
    const links = card.querySelectorAll("a[href]");
    for (const a of links) {
      let url;
      try { url = new URL(a.href); } catch { continue; }
      if (SYSTEM_DOMAINS.has(url.hostname)) continue;
      if (!/^https?:$/.test(url.protocol)) continue;
      // 첫 유효 링크의 호스트가 블로그면 강조, 아니면 강조 안 함
      return BLOG_HOSTS.includes(url.hostname);
    }

    return false;
  }

  /**
   * 페이지 전체에서 카드 요소를 수집하고, 중첩(부모-자식 관계) 카드를 제거
   * → 가장 작은 단위(leaf-level) 카드만 반환
   *
   * 통합영역([data-meta-area="ugB_..."])과 그 안의 개별 카드([data-template-id="ugcItem"])가
   * 둘 다 매칭될 때, 큰 영역이 강조되면 그 안 모든 카드(카페 포함)가 같이 강조되는 문제 발생.
   * → 자신 안에 다른 카드가 있으면 자기는 컨테이너이므로 제거.
   */
  function findAllCards() {
    const cards = new Set();
    for (const sel of CARD_SELECTORS) {
      document.querySelectorAll(sel).forEach(el => cards.add(el));
    }
    const cardArr = Array.from(cards);
    return cardArr.filter(card => {
      // 자신 안에 다른 카드 있으면 자기는 컨테이너 = 제거 (작은 단위 우선)
      for (const other of cardArr) {
        if (other !== card && card.contains(other)) return false;
      }
      return true;
    });
  }

  // 색상 값에 따라 CSS 문자열 생성 (::after 오버레이 방식)
  function buildCssForColor(c) {
    const bg = COLOR_PRESETS[c] || COLOR_PRESETS.green;
    return `
      [${HIGHLIGHTED_ATTR}='1'] {
        position: relative !important;
      }
      [${HIGHLIGHTED_ATTR}='1']::after {
        content: '';
        position: absolute;
        inset: 0;
        background: ${bg};
        border-radius: 4px;
        pointer-events: none;
        z-index: 99;
        transition: background 0.15s ease;
      }
    `;
  }

  // 강조 CSS 주입 (이미 있으면 텍스트만 교체)
  function injectStyle() {
    let el = document.getElementById(STYLE_ID);
    if (!el) {
      el = document.createElement("style");
      el.id = STYLE_ID;
      document.head.appendChild(el);
    }
    el.textContent = buildCssForColor(color);
  }

  // 강조 CSS 제거
  function removeStyle() {
    const el = document.getElementById(STYLE_ID);
    if (el) el.remove();
  }

  // 전체 카드 순회하여 강조 적용/해제
  function applyHighlights() {
    const cards = findAllCards();
    for (const card of cards) {
      if (isBlogCard(card)) {
        card.setAttribute(HIGHLIGHTED_ATTR, "1");
      } else if (card.hasAttribute(HIGHLIGHTED_ATTR)) {
        card.removeAttribute(HIGHLIGHTED_ATTR);
      }
    }
  }

  // 모든 강조 속성 제거
  function removeAllHighlights() {
    document.querySelectorAll(`[${HIGHLIGHTED_ATTR}='1']`).forEach(el => {
      el.removeAttribute(HIGHLIGHTED_ATTR);
    });
  }

  // MutationObserver 시작 — 300ms throttle로 무한스크롤 대응
  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(() => {
      if (observerThrottle) return;
      observerThrottle = setTimeout(() => {
        observerThrottle = null;
        applyHighlights();
      }, 300);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // MutationObserver 정지
  function stopObserver() {
    if (!observer) return;
    if (observerThrottle) {
      clearTimeout(observerThrottle);
      observerThrottle = null;
    }
    observer.disconnect();
    observer = null;
  }

  // 적용 대상 페이지 확인
  function isSearchPage() {
    return (
      location.hostname === "search.naver.com" &&
      location.pathname === "/search.naver"
    );
  }

  // 활성화: 스타일 주입 → 강조 적용 → 관찰 시작
  function init() {
    if (!isSearchPage()) return;
    injectStyle();
    applyHighlights();
    startObserver();
  }

  // 비활성화: 관찰 중지 → 강조 제거 → 스타일 제거
  function teardown() {
    stopObserver();
    removeAllHighlights();
    removeStyle();
  }

  // 초기 상태 로드 (기본값 true, color 기본값 "blue")
  chrome.storage.sync.get([STORAGE_KEY, COLOR_KEY]).then((stored) => {
    enabled = stored[STORAGE_KEY] ?? true;
    color   = stored[COLOR_KEY]   ?? "blue";
    if (enabled) init();
  });

  // popup 토글 및 색상 변경 실시간 반응
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;

    // 색상 변경: style 태그 텍스트만 교체 (DOM 재생성 없음)
    if (COLOR_KEY in changes) {
      const next = changes[COLOR_KEY].newValue ?? "blue";
      if (next !== color) {
        color = next;
        if (enabled) injectStyle();
      }
    }

    // 토글 변경
    if (STORAGE_KEY in changes) {
      const next = changes[STORAGE_KEY].newValue;
      if (next === enabled) return;
      enabled = next;
      if (enabled) init();
      else teardown();
    }
  });
})();
