// content/search-highlighter.js
// SBS 기능 ③: 네이버 검색 결과 중 블로그 항목 녹색 강조
// 적용: search.naver.com/search.naver

(function () {
  "use strict";

  const STORAGE_KEY      = "searchHighlighter";
  const STYLE_KEY        = "searchHighlighterStyle";
  const STYLE_ID         = "sbs-highlighter-style";
  const HIGHLIGHTED_ATTR = "data-sbs-highlighted";

  // 블로그로 판정할 호스트 목록
  const BLOG_HOSTS = ["blog.naver.com", "m.blog.naver.com"];

  // 링크 검사 시 시스템 도메인은 건너뜀
  const SYSTEM_DOMAINS = new Set([
    "search.naver.com",
    "keep.naver.com",
    "ader.naver.com",
    "kup.naver.com",
    "help.naver.com",
    "datalab.tools",
    "app.datalab.tools",
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
  let style            = "both";
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
   * → leaf-level 카드만 반환
   */
  function findAllCards() {
    const cards = new Set();
    for (const sel of CARD_SELECTORS) {
      document.querySelectorAll(sel).forEach(el => cards.add(el));
    }
    // 다른 카드가 조상인 경우 제거 — leaf-level만 유지
    return Array.from(cards).filter(card => {
      let p = card.parentElement;
      while (p && p !== document.body) {
        if (cards.has(p)) return false;
        p = p.parentElement;
      }
      return true;
    });
  }

  // 스타일 값에 따라 CSS 문자열 생성
  function buildCssForStyle(s) {
    const bar  = `box-shadow: inset 4px 0 0 0 #2db400 !important;`;
    const tint = `background-color: rgba(45, 180, 0, 0.05) !important;`;
    let inner  = "";
    if (s === "bar")       inner = bar;
    else if (s === "tint") inner = tint;
    else                   inner = `${bar} ${tint}`; // both

    return `
      [${HIGHLIGHTED_ATTR}='1'] {
        ${inner}
        border-radius: 4px !important;
        transition: box-shadow 0.15s ease, background-color 0.15s ease;
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
    el.textContent = buildCssForStyle(style);
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

  // 초기 상태 로드 (기본값 true, style 기본값 "both")
  chrome.storage.sync.get([STORAGE_KEY, STYLE_KEY]).then((stored) => {
    enabled = stored[STORAGE_KEY] ?? true;
    style   = stored[STYLE_KEY]   ?? "both";
    if (enabled) init();
  });

  // popup 토글 및 스타일 변경 실시간 반응
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;

    // 스타일 변경: style 태그 텍스트만 교체 (DOM 재생성 없음)
    if (STYLE_KEY in changes) {
      const next = changes[STYLE_KEY].newValue ?? "both";
      if (next !== style) {
        style = next;
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
