/**
 * 네이버 블로그 글감 숨기기 Content Script v1.1
 *
 * 핵심 변경:
 * 1. all_frames: true → iframe 내부에서도 실행됨
 * 2. MutationObserver로 동적 로드 대응
 * 3. 다양한 셀렉터로 글감 요소 탐색
 */

let isHidden = false;
let styleElement = null;
let observer = null;

// 글감 관련 셀렉터 목록 (여러 경로로 시도)
const SELECTORS = [
  ".se-floating-material-container",
  ".se-floating-material-menu",
  ".se-floating-search-area",
  'form.se-floating-search-wrapper',
  '[class*="floating-material"]',
  '[class*="floating-search"]',
];

// 글감 요소를 찾는 함수 (현재 document + iframe 내부 모두 탐색)
function findGeulgamElements() {
  const found = [];

  // 1. 현재 document에서 찾기
  for (const sel of SELECTORS) {
    const els = document.querySelectorAll(sel);
    els.forEach((el) => found.push(el));
  }

  // 2. iframe 내부에서도 찾기 (same-origin만 가능)
  try {
    const iframes = document.querySelectorAll("iframe");
    iframes.forEach((iframe) => {
      try {
        const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
        if (iframeDoc) {
          for (const sel of SELECTORS) {
            const els = iframeDoc.querySelectorAll(sel);
            els.forEach((el) => found.push(el));
          }
        }
      } catch (e) {
        // cross-origin iframe은 접근 불가 - 무시
      }
    });
  } catch (e) {
    // iframe 접근 실패 무시
  }

  // 중복 제거: 자식 요소가 이미 포함된 부모가 있으면 부모만 유지
  const containers = found.filter(
    (el) => el.classList.contains("se-floating-material-container")
  );
  if (containers.length > 0) return containers;

  return [...new Set(found)];
}

function toggleGeulgam() {
  if (isHidden) {
    showGeulgam();
  } else {
    hideGeulgam();
  }
}

function hideGeulgam() {
  // 방법 1: 직접 요소 숨기기
  const elements = findGeulgamElements();
  elements.forEach((el) => {
    el.style.setProperty("display", "none", "important");
    el.setAttribute("data-geulgam-hidden", "true");
  });

  if (elements.length > 0) {
    console.log(`[글감 숨기기] ${elements.length}개 요소를 직접 숨겼습니다.`);
  }

  // 방법 2: CSS 주입 (현재 document에)
  injectCSS(document);

  // 방법 3: iframe 내부에도 CSS 주입
  try {
    document.querySelectorAll("iframe").forEach((iframe) => {
      try {
        const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
        if (iframeDoc) {
          injectCSS(iframeDoc);
        }
      } catch (e) {}
    });
  } catch (e) {}

  // 방법 4: MutationObserver로 나중에 생기는 요소도 숨기기
  startObserver();

  isHidden = true;
  console.log("[글감 숨기기] 글감 패널 숨기기 활성화됨");
}

function injectCSS(doc) {
  if (doc.getElementById("naver-blog-geulgam-hider")) return;

  const style = doc.createElement("style");
  style.id = "naver-blog-geulgam-hider";
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
  (doc.head || doc.documentElement).appendChild(style);
}

function removeCSS(doc) {
  const style = doc.getElementById("naver-blog-geulgam-hider");
  if (style) style.remove();
}

function startObserver() {
  if (observer) return;

  observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue;

        // 추가된 노드 자체가 글감인지 확인
        if (
          node.classList?.contains("se-floating-material-container") ||
          node.classList?.contains("se-floating-material-menu") ||
          node.querySelector?.(".se-floating-material-container")
        ) {
          const target =
            node.classList.contains("se-floating-material-container")
              ? node
              : node.querySelector(".se-floating-material-container") || node;
          target.style.setProperty("display", "none", "important");
          target.setAttribute("data-geulgam-hidden", "true");
          console.log("[글감 숨기기] 동적으로 생성된 글감 요소를 숨겼습니다.");
        }

        // iframe이 추가된 경우 내부에도 CSS 주입
        if (node.tagName === "IFRAME") {
          node.addEventListener("load", () => {
            try {
              const iframeDoc = node.contentDocument || node.contentWindow?.document;
              if (iframeDoc) injectCSS(iframeDoc);
            } catch (e) {}
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
  if (observer) {
    observer.disconnect();
    observer = null;
  }
}

function showGeulgam() {
  stopObserver();

  // 직접 숨긴 요소 복원
  document.querySelectorAll('[data-geulgam-hidden="true"]').forEach((el) => {
    el.style.removeProperty("display");
    el.style.removeProperty("visibility");
    el.style.removeProperty("opacity");
    el.style.removeProperty("pointer-events");
    el.style.removeProperty("height");
    el.style.removeProperty("overflow");
    el.removeAttribute("data-geulgam-hidden");
  });

  // CSS 제거 (현재 document)
  removeCSS(document);

  // iframe 내부 CSS 제거
  try {
    document.querySelectorAll("iframe").forEach((iframe) => {
      try {
        const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
        if (iframeDoc) {
          removeCSS(iframeDoc);
          iframeDoc.querySelectorAll('[data-geulgam-hidden="true"]').forEach((el) => {
            el.style.removeProperty("display");
            el.removeAttribute("data-geulgam-hidden");
          });
        }
      } catch (e) {}
    });
  } catch (e) {}

  isHidden = false;
  console.log("[글감 숨기기] 글감 패널 다시 보이기");
}

// 메시지 수신 (아이콘 클릭 시)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "toggleGeulgam") {
    toggleGeulgam();
    sendResponse({ success: true, isHidden });
  }
  return true; // 비동기 응답 허용
});
