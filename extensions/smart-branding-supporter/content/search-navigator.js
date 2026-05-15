// content/search-navigator.js
// SBS 기능 ②: 검색 결과 좌측 섹션 네비게이터
// 적용: search.naver.com/search.naver (PC 통합검색)

(function () {
  "use strict";

  // ─── 상수 ────────────────────────────────────────────────────────────────────

  const STORAGE_KEY = "searchNavigator";
  const NAV_ID      = "sbs-nav";
  const STYLE_ID    = "sbs-nav-style";

  // 섹션 ID → 라벨 / UGC 여부 매핑
  // n 필드가 아래 키로 startsWith()하면 매칭
  const SECTION_MAP = {
    pwl:   { label: "파워링크",   isUgc: false },
    brd:   { label: "브랜드",     isUgc: false },
    blg:   { label: "블로그",     isUgc: true  },
    caf:   { label: "카페",       isUgc: true  },
    kin:   { label: "지식iN",     isUgc: true  },
    influ: { label: "인플루언서", isUgc: true  },
    news:  { label: "뉴스",       isUgc: false },
    img:   { label: "이미지",     isUgc: false },
    vid:   { label: "동영상",     isUgc: false },
    shp:   { label: "쇼핑",       isUgc: false },
    shop:  { label: "쇼핑",       isUgc: false },
    plac:  { label: "플레이스",   isUgc: false },
    smart: { label: "스마트블록", isUgc: false },
  };

  // ─── 상태 ────────────────────────────────────────────────────────────────────

  let state = {
    enabled:          false,
    sections:         [],   // { areaId, element, label, isUgc }
    closed:           false, // 사용자가 ✕ 눌러서 닫았는지
    activeAreaId:     null,
    scrollRafId:      null,
    pollIntervalId:   null,
    mutationObserver: null,
    mutationThrottle: null,
    lastQuery:        "",
    scrollHandler:    null, // 제거 시 참조 필요
  };

  // ─── CSS ─────────────────────────────────────────────────────────────────────

  function getCss() {
    return `
#sbs-nav {
  position: fixed;
  left: 16px;
  top: 50%;
  transform: translateY(-50%);
  z-index: 9999;
  background: #fff;
  border: 1px solid #e5e5e5;
  border-radius: 8px;
  padding: 10px 0 10px 0;
  box-shadow: 0 2px 8px rgba(0,0,0,0.12);
  width: 140px;
  font-family: 'Pretendard', system-ui, -apple-system, sans-serif;
  font-size: 12px;
  line-height: 1.4;
  box-sizing: border-box;
}

.sbs-nav-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 10px 6px 10px;
  border-bottom: 1px solid #f0f0f0;
  margin-bottom: 4px;
}

.sbs-nav-title {
  font-size: 11px;
  font-weight: 600;
  color: #888;
  letter-spacing: 0.03em;
  text-transform: uppercase;
}

.sbs-nav-close {
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;
  font-size: 14px;
  color: #bbb;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
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
  padding: 0;
}

.sbs-nav-item button {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  cursor: pointer;
  padding: 6px 10px;
  font-size: 12px;
  font-family: inherit;
  border-radius: 0;
  transition: background 0.12s;
  box-sizing: border-box;
}

/* UGC 항목 기본 색 */
.sbs-nav-item.sbs-nav-item--ugc button {
  color: #2db400;
}

/* 일반 항목 기본 색 */
.sbs-nav-item button {
  color: #555;
}

/* hover */
.sbs-nav-item button:hover {
  background: #f5f5f5;
}

/* 활성 - UGC */
.sbs-nav-item.sbs-nav-item--ugc.sbs-nav-item--active button {
  background: #03c75a;
  color: #fff;
  font-weight: 600;
}

/* 활성 - 일반 */
.sbs-nav-item.sbs-nav-item--active button {
  background: #555;
  color: #fff;
  font-weight: 600;
}

/* 활성 UGC가 일반 활성보다 우선 (중복 규칙 충돌 방지) */
.sbs-nav-item.sbs-nav-item--ugc.sbs-nav-item--active button {
  background: #03c75a;
  color: #fff;
}

.sbs-nav-dot {
  font-size: 8px;
  line-height: 1;
  flex-shrink: 0;
}

.sbs-nav-label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
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

    // 2. 일반 data 속성 셀렉터
    let el;
    el = document.querySelector(`[data-meta-area^="${areaId}"]`);
    if (el) return el;

    el = document.querySelector(`[data-slog-container="${areaId}"]`);
    if (el) return el;

    el = document.querySelector(`[data-slog-container^="${areaId}"]`);
    if (el) return el;

    el = document.querySelector(`[data-laim-exp-id="${areaId}"]`);
    if (el) return el;

    // 3. id 폴백
    el = document.querySelector(`#${areaId}_root`);
    if (el) return el;

    el = document.querySelector(`[id^="${areaId}"]`);
    if (el) return el;

    return null;
  }

  /**
   * areaId에 해당하는 SECTION_MAP 항목을 반환.
   * SECTION_MAP의 키로 startsWith() 매칭.
   * @param {string} areaId
   * @returns {{ label: string, isUgc: boolean }|null}
   */
  function getSectionMeta(areaId) {
    if (!areaId) return null;
    const key = Object.keys(SECTION_MAP).find((k) => areaId.startsWith(k));
    return key ? SECTION_MAP[key] : null;
  }

  // ─── DOM 생성 / 렌더 ──────────────────────────────────────────────────────────

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
    title.textContent = "섹션";

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
      li.className = "sbs-nav-item" + (sec.isUgc ? " sbs-nav-item--ugc" : "");
      li.dataset.areaId = sec.areaId;

      const btn = document.createElement("button");
      btn.setAttribute("type", "button");

      const dot = document.createElement("span");
      dot.className = "sbs-nav-dot";
      dot.textContent = "○";
      dot.setAttribute("aria-hidden", "true");

      const labelSpan = document.createElement("span");
      labelSpan.className = "sbs-nav-label";
      labelSpan.textContent = sec.label;

      btn.appendChild(dot);
      btn.appendChild(labelSpan);

      // 클릭 → 해당 섹션으로 부드러운 스크롤 (상단 70px 여유)
      btn.addEventListener("click", () => {
        const rect = sec.element.getBoundingClientRect();
        const targetY = window.scrollY + rect.top - 70;
        window.scrollTo({ top: targetY, behavior: "smooth" });
      });

      li.appendChild(btn);
      ul.appendChild(li);
    }

    aside.appendChild(ul);
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

    // 렌더 직후 활성 항목 반영
    updateActive();
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
      // 100ms throttle: 짧은 시간에 여러 DOM 변경이 몰려도 한 번만 재로드
      if (state.mutationThrottle) return;
      state.mutationThrottle = setTimeout(() => {
        state.mutationThrottle = null;
        if (state.enabled && !state.closed) {
          loadSections();
        }
      }, 100);
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
   * nx_cr_area_info 파싱 → SECTION_MAP 필터 → DOM 요소 탐색 → 렌더.
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

    state.sections = raw
      .map((s) => {
        const meta = getSectionMeta(s.n);
        if (!meta) return null;
        const element = findSectionElement(s.n);
        if (!element) return null;
        return { areaId: s.n, element, label: meta.label, isUgc: meta.isUgc };
      })
      .filter(Boolean);

    renderNav();
    updateActive();
  }

  /**
   * nx_cr_area_info를 끝내 못 찾았을 때의 폴백.
   * DOM의 data-meta-area 속성을 직접 스캔해 섹션 목록을 구성.
   */
  function loadSectionsFallback() {
    const candidates = document.querySelectorAll("[data-meta-area]");
    const seen = new Set();

    state.sections = [];

    for (const el of candidates) {
      const areaId = el.getAttribute("data-meta-area");
      if (!areaId || seen.has(areaId)) continue;
      seen.add(areaId);
      const meta = getSectionMeta(areaId);
      if (!meta) continue;
      state.sections.push({ areaId, element: el, label: meta.label, isUgc: meta.isUgc });
    }

    renderNav();
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
    state.sections     = [];
    state.activeAreaId = null;
  }

  // ─── storage 토글 연동 ────────────────────────────────────────────────────────

  // 페이지 로드 시 저장된 설정 읽기 (기본값 true)
  chrome.storage.sync.get(STORAGE_KEY).then((stored) => {
    state.enabled = stored[STORAGE_KEY] ?? true;
    if (state.enabled) init();
  });

  // 팝업에서 토글 변경 시 실시간 반응
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" || !(STORAGE_KEY in changes)) return;
    const next = changes[STORAGE_KEY].newValue;
    if (next === state.enabled) return;
    state.enabled = next;

    if (state.enabled) {
      state.closed = false;  // 토글 ON 시 닫힘 상태 초기화
      init();
    } else {
      teardown();
    }
  });

  // 창 크기 변경 감지: 좁아지면 숨기고, 넓어지면 재표시
  window.addEventListener("resize", () => {
    if (!state.enabled) return;
    if (window.innerWidth < 1200) {
      // 좁아졌을 때: DOM만 제거 (closed는 건드리지 않음)
      destroyNav();
    } else if (!document.getElementById(NAV_ID) && !state.closed) {
      init();
    }
  });
})();
