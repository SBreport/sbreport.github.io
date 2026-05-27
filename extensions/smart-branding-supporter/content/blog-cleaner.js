// 기능 ①: 블로그 글감 패널 숨기기
// 적용 페이지: blog.naver.com, m.blog.naver.com, *.editor.naver.com
//
// 동작 원리:
//   - popup의 "blogCleaner" 토글이 ON  → 글감 패널 DOM 요소 인라인 숨김 + CSS 규칙 주입 + MutationObserver 감시
//   - popup의 "blogCleaner" 토글이 OFF → 숨김 해제 + CSS 제거 + Observer 중단
//   - chrome.storage.onChanged 리스너로 토글 변화 실시간 감지

(function () {
  "use strict";

  const STORAGE_KEY = "blogCleaner";
  const HIDDEN_ATTR = "data-sbs-cleaner-hidden";
  const STYLE_ID = "sbs-cleaner-style";

  // 네이버 블로그 에디터의 글감(floating material) 관련 셀렉터 6종
  const SELECTORS = [
    ".se-floating-material-container",
    ".se-floating-material-menu",
    ".se-floating-search-area",
    "form.se-floating-search-wrapper",
    '[class*="floating-material"]',
    '[class*="floating-search"]',
  ];

  let observer = null;
  let enabled = false;

  // ─── 요소 탐색 ────────────────────────────────────────────────

  /**
   * 현재 document와 same-origin iframe 내부에서 글감 요소를 모두 찾는다.
   * .se-floating-material-container 가 존재하면 해당 요소들만 반환해
   * 자식 중복을 방지한다.
   */
  function findTargetElements(doc) {
    const found = [];
    for (const sel of SELECTORS) {
      doc.querySelectorAll(sel).forEach((el) => found.push(el));
    }

    // 최상위 컨테이너만 있으면 그것만 반환 (자식 중복 처리 방지)
    const containers = found.filter((el) =>
      el.classList.contains("se-floating-material-container")
    );
    if (containers.length > 0) return containers;

    return [...new Set(found)];
  }

  /**
   * 같은 origin의 iframe 목록을 배열로 반환.
   * cross-origin iframe 접근 시 발생하는 예외는 조용히 무시한다.
   */
  function getSameOriginIframeDocs(doc) {
    const docs = [];
    try {
      doc.querySelectorAll("iframe").forEach((iframe) => {
        try {
          const iframeDoc =
            iframe.contentDocument || iframe.contentWindow?.document;
          if (iframeDoc) docs.push(iframeDoc);
        } catch (_) {
          // cross-origin — 접근 불가, 무시
        }
      });
    } catch (_) {}
    return docs;
  }

  // ─── CSS 주입 / 제거 ──────────────────────────────────────────

  /**
   * 지정 document에 글감 요소 숨김 CSS를 영구 규칙으로 주입한다.
   * 이미 주입되어 있으면 중복 주입하지 않는다.
   */
  function injectCSS(doc) {
    if (doc.getElementById(STYLE_ID)) return;

    const style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .se-floating-material-container,
      .se-floating-material-menu,
      .se-floating-search-area,
      form.se-floating-search-wrapper,
      [class*="se-floating-material"],
      [class*="floating-material-container"] {
        display: none !important;
        visibility: hidden !important;
        opacity: 0 !important;
        pointer-events: none !important;
        height: 0 !important;
        overflow: hidden !important;
      }
    `;
    // 빈/로드 전 iframe document는 head·documentElement 모두 null일 수 있음 → skip
    (doc.head || doc.documentElement)?.appendChild(style);
  }

  /** 지정 document에서 글감 숨김 CSS 태그를 제거한다. */
  function removeCSS(doc) {
    doc.getElementById(STYLE_ID)?.remove();
  }

  // ─── 숨김 적용 / 해제 ────────────────────────────────────────

  /**
   * 글감 요소를 숨긴다.
   *   1. 현재 document에서 요소 탐색 → 인라인 display:none + HIDDEN_ATTR 마킹
   *   2. 현재 document에 CSS 영구 규칙 주입
   *   3. same-origin iframe 내부도 동일하게 처리
   */
  function applyCleaner() {
    // 현재 document 처리
    const elements = findTargetElements(document);
    elements.forEach((el) => {
      el.style.setProperty("display", "none", "important");
      el.setAttribute(HIDDEN_ATTR, "true");
    });
    injectCSS(document);

    // same-origin iframe 처리
    getSameOriginIframeDocs(document).forEach((iframeDoc) => {
      findTargetElements(iframeDoc).forEach((el) => {
        el.style.setProperty("display", "none", "important");
        el.setAttribute(HIDDEN_ATTR, "true");
      });
      injectCSS(iframeDoc);
    });
  }

  /**
   * 글감 요소 숨김을 해제한다.
   *   1. HIDDEN_ATTR 마킹된 요소의 인라인 스타일 모두 복원
   *   2. 주입된 CSS 태그 제거
   *   3. same-origin iframe 내부도 동일하게 복원
   */
  function revertCleaner() {
    function restoreInDoc(doc) {
      doc.querySelectorAll(`[${HIDDEN_ATTR}="true"]`).forEach((el) => {
        el.style.removeProperty("display");
        el.style.removeProperty("visibility");
        el.style.removeProperty("opacity");
        el.style.removeProperty("pointer-events");
        el.style.removeProperty("height");
        el.style.removeProperty("overflow");
        el.removeAttribute(HIDDEN_ATTR);
      });
      removeCSS(doc);
    }

    restoreInDoc(document);
    getSameOriginIframeDocs(document).forEach(restoreInDoc);
  }

  // ─── MutationObserver ─────────────────────────────────────────

  /**
   * DOM에 동적으로 추가되는 글감 요소를 실시간으로 감지해 즉시 숨긴다.
   * iframe이 동적으로 추가되는 경우에도 load 이후 CSS를 주입한다.
   * Observer는 토글 ON일 때만 활성 상태를 유지한다.
   */
  function startObserver() {
    if (observer) return;

    observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1) continue;

          // 추가된 노드 자체가 글감 컨테이너이거나 내부에 포함하는 경우
          if (
            node.classList?.contains("se-floating-material-container") ||
            node.classList?.contains("se-floating-material-menu") ||
            node.querySelector?.(".se-floating-material-container")
          ) {
            const target = node.classList.contains(
              "se-floating-material-container"
            )
              ? node
              : node.querySelector(".se-floating-material-container") || node;
            target.style.setProperty("display", "none", "important");
            target.setAttribute(HIDDEN_ATTR, "true");
          }

          // 동적으로 추가된 iframe에도 CSS 주입
          if (node.tagName === "IFRAME") {
            node.addEventListener("load", () => {
              try {
                const iframeDoc =
                  node.contentDocument || node.contentWindow?.document;
                if (iframeDoc) injectCSS(iframeDoc);
              } catch (_) {}
            });
          }
        }
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  function stopObserver() {
    if (!observer) return;
    observer.disconnect();
    observer = null;
  }

  // ─── 초기화 ───────────────────────────────────────────────────

  async function init() {
    const stored = await chrome.storage.sync.get(STORAGE_KEY);
    // popup 기본값 true와 동일하게 스토리지 미설정 시 ON
    enabled = stored[STORAGE_KEY] ?? true;
    if (enabled) {
      applyCleaner();
      startObserver();
    }
  }

  // ─── 스토리지 변경 실시간 감지 ───────────────────────────────

  // popup에서 토글 변경 → storage.sync 업데이트 → 이 리스너에서 즉시 반영
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" || !(STORAGE_KEY in changes)) return;
    const next = changes[STORAGE_KEY].newValue;
    if (next === enabled) return;
    enabled = next;

    if (enabled) {
      applyCleaner();
      startObserver();
    } else {
      stopObserver();
      revertCleaner();
    }
  });

  // ─── 진입점 ───────────────────────────────────────────────────

  // run_at: document_idle 이지만 DOMContentLoaded 이전 실행 가능성 방어
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
