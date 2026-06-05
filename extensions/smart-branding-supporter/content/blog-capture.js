// 기능: 블로그 전체 캡처
// 적용 페이지: blog.naver.com, m.blog.naver.com, *.editor.naver.com
//
// 동작 원리:
//   팝업이 SBS_CAPTURE_DETECT 메시지를 보내면 스크롤 가능 영역을 탐지해 반환.
//   SBS_CAPTURE_RUN 메시지를 받으면 선택 영역을 위→아래 스크롤하며 캔버스에 합성,
//   합성 완료 후 SBS_CAPTURE_DOWNLOAD 메시지로 background에 다운로드를 위임.
//   captureVisibleTab은 content script 권한 밖이므로 SBS_CAPTURE_SHOOT로 background 경유.

(function () {
  "use strict";

  // 중복 주입 방지 — 이미 초기화됐으면 조용히 종료
  if (window.__SBS_CAPTURE__) {
    console.log("[SBS] blog-capture: 이미 초기화됨 — 중복 주입 무시");
    return;
  }
  window.__SBS_CAPTURE__ = true;
  console.log("[SBS] blog-capture 초기화");

  // 탐지 결과를 모듈 스코프에 보관.
  // el 레퍼런스는 직렬화 불가이므로 메타(index, label 등)만 메시지로 보내고
  // 실제 캡처 시엔 이 배열의 el을 직접 참조한다.
  let scrollers = [];

  // 하이라이트 상태 추적: 이전 outline 값 복원을 위해 보관
  let _highlightEl = null;
  let _highlightPrevOutline = "";

  // ── 유틸리티 ────────────────────────────────────────────────

  /** ms만큼 기다리는 Promise */
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  /** src → HTMLImageElement (Promise) */
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  /**
   * background에 화면 캡처를 요청하고 dataURL을 반환한다.
   * captureVisibleTab은 content script 권한 밖이라 background 경유가 필수.
   */
  function shoot() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "SBS_CAPTURE_SHOOT" }, (resp) => {
        if (chrome.runtime.lastError) {
          console.log("[SBS] shoot 메시지 실패:", chrome.runtime.lastError.message);
          resolve(null);
        } else {
          resolve(resp?.dataURL ?? null);
        }
      });
    });
  }

  /**
   * 사용자에게 알려야 할 캡처 오류를 팝업 상태줄로 전달한다.
   * 수신자(팝업)가 없을 때 발생하는 lastError는 조용히 무시한다.
   */
  function notifyCaptureError(message) {
    chrome.runtime.sendMessage(
      { type: "SBS_CAPTURE_ERROR", message },
      () => void chrome.runtime.lastError
    );
  }

  /**
   * 요소의 좌표를 최상위(탭) 뷰포트 기준으로 변환한다.
   *
   * el.getBoundingClientRect()는 el이 속한 문서(iframe 내부) 기준이다.
   * iframe 안에 있으면 iframe 자체도 뷰포트에서 offset이 있으므로
   * frameElement 체인을 따라 올라가며 각 iframe의 위치를 누적 합산해야
   * 최종 탭 뷰포트 기준 좌표가 나온다.
   */
  function getScreenRect(el) {
    // 요소의 로컬 rect (소속 문서 기준)
    const localRect = el.getBoundingClientRect();
    let left = localRect.left;
    let top = localRect.top;

    // 현재 문서의 window에서 시작해 최상위까지 올라간다
    let win = el.ownerDocument.defaultView;
    while (win && win !== window.top) {
      const frameEl = win.frameElement; // 이 window를 감싼 <iframe> 요소
      if (!frameEl) break;
      const frameRect = frameEl.getBoundingClientRect(); // 부모 문서 기준 iframe 위치
      left += frameRect.left;
      top += frameRect.top;
      win = frameEl.ownerDocument.defaultView; // 한 단계 위 window로 이동
    }

    return {
      left,
      top,
      // 크기는 스크롤 뷰포트의 실제 보이는 영역
      width: el.clientWidth,
      height: el.clientHeight,
    };
  }

  // ── 스크롤러 탐지 ────────────────────────────────────────────

  /**
   * doc 안의 스크롤 가능한 요소들을 재귀적으로 수집한다.
   * @param {Document} doc        탐색할 문서
   * @param {string}   pathPrefix 레이블용 iframe 경로 접두어
   * @param {Array}    results    결과 배열 (재귀 누적용)
   */
  function collectScrollers(doc, pathPrefix, results) {
    // 모든 요소를 순회하며 스크롤 가능 여부 판정
    const all = doc.querySelectorAll("*");
    for (const el of all) {
      try {
        const style = getComputedStyle(el);
        const overflowY = style.overflowY;
        const isScrollable = overflowY === "auto" || overflowY === "scroll";
        const hasScroll = el.scrollHeight > el.clientHeight + 10;
        const isTall = el.clientHeight > 50; // 너무 작은 요소는 제외

        if (isScrollable && hasScroll && isTall) {
          // 레이블 조합: "IFRAME#mainFrame > DIV.se-main-container" 형태
          const tag = el.tagName;
          const id = el.id ? `#${el.id}` : "";
          const cls = el.classList.length
            ? "." + [...el.classList].slice(0, 2).join(".") // 앞 2개 클래스만 표시
            : "";
          const label = pathPrefix
            ? `${pathPrefix} > ${tag}${id}${cls}`
            : `${tag}${id}${cls}`;

          results.push({
            el,                          // 실제 DOM 참조 (직렬화 안 됨, 로컬 전용)
            label,
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
          });
        }
      } catch (e) {
        // 일부 요소는 getComputedStyle 시 예외 발생 — 무시
      }
    }

    // 문서 내 scrollingElement (보통 <html> 또는 <body>) 도 후보에 포함
    const se = doc.scrollingElement;
    if (
      se &&
      se.scrollHeight > se.clientHeight + 10 &&
      se.clientHeight > 50
    ) {
      const label = pathPrefix
        ? `${pathPrefix} > scrollingElement`
        : "scrollingElement";
      // 중복 방지: 이미 수집된 el과 같으면 건너뜀
      if (!results.find((r) => r.el === se)) {
        results.push({
          el: se,
          label,
          scrollHeight: se.scrollHeight,
          clientHeight: se.clientHeight,
        });
      }
    }

    // same-origin iframe 재귀 탐색 (cross-origin은 contentDocument 접근 시 예외 발생 → 건너뜀)
    const iframes = doc.querySelectorAll("iframe");
    for (const iframe of iframes) {
      try {
        const childDoc = iframe.contentDocument;
        if (!childDoc) continue;

        // iframe 레이블 구성
        const iframeId = iframe.id ? `#${iframe.id}` : "";
        const iframeCls = iframe.classList.length
          ? "." + [...iframe.classList].slice(0, 1).join(".")
          : "";
        const iframePath = pathPrefix
          ? `${pathPrefix} > IFRAME${iframeId}${iframeCls}`
          : `IFRAME${iframeId}${iframeCls}`;

        collectScrollers(childDoc, iframePath, results);
      } catch (e) {
        // cross-origin iframe — 접근 불가, 정상 동작으로 건너뜀
      }
    }
  }

  /**
   * 중복 병합: scrollingElement와 BODY/HTML이 scrollHeight·clientHeight가 동일하면
   * 같은 영역을 두 번 나열하는 것이므로 하나로 합친다.
   * 병합 기준: el이 다른데 scrollHeight·clientHeight가 완전히 같은 쌍.
   * 우선순위: scrollingElement를 남기고(전체 페이지 대표), 나머지는 제거.
   */
  function dedupeScrollers(results) {
    const kept = [];
    for (const item of results) {
      const isDup = kept.some(
        (k) =>
          k.el !== item.el &&
          k.scrollHeight === item.scrollHeight &&
          k.clientHeight === item.clientHeight
      );
      if (isDup) {
        console.log(`[SBS] 중복 병합 제거: ${item.label}`);
        continue;
      }
      kept.push(item);
    }
    return kept;
  }

  /**
   * 자동 추천: scrollHeight 최대 항목에 recommended:true.
   * 동률이면 ratio(scrollHeight/clientHeight) 큰 것.
   * recommended 항목은 팝업에서 "이 영역 캡처" 버튼으로 맨 위에 강조 표시된다.
   */
  function markRecommended(results) {
    if (results.length === 0) return results;
    let best = results[0];
    for (const item of results) {
      const betterHeight = item.scrollHeight > best.scrollHeight;
      const sameHeightBetterRatio =
        item.scrollHeight === best.scrollHeight &&
        item.scrollHeight / item.clientHeight > best.scrollHeight / best.clientHeight;
      if (betterHeight || sameHeightBetterRatio) best = item;
    }
    best.recommended = true;
    return results;
  }

  /**
   * 친화 라벨 부여:
   * - scrollingElement / BODY / HTML 류 → "전체"
   * - 그 외(본문류) → 본문류 항목이 1개이면 "본문", 2개 이상이면 "본문 1", "본문 2", …
   * recommended 플래그 로직은 그대로 유지되며, 라벨 부여에는 영향을 주지 않는다.
   * 기존 label(셀렉터)은 friendlyLabel과 별도로 유지되어 부가 설명으로 쓰인다.
   */
  function assignFriendlyLabels(results) {
    // 전체류/본문류 분류
    const isWholePageItem = (item) =>
      item.label === "scrollingElement" ||
      /^(BODY|HTML)/.test(item.label) ||
      item.label.endsWith("> scrollingElement");

    const bodyItems = results.filter((item) => !isWholePageItem(item));
    const multiBody = bodyItems.length >= 2;

    let bodyCount = 0;
    for (const item of results) {
      if (isWholePageItem(item)) {
        item.friendlyLabel = "전체";
      } else {
        if (multiBody) {
          bodyCount++;
          item.friendlyLabel = `본문 ${bodyCount}`;
        } else {
          item.friendlyLabel = "본문";
        }
      }
    }
    return results;
  }

  /** findScrollers: 전체 탐색 → 중복 병합 → 추천 → 친화 라벨 → 직렬화 메타 반환 */
  function findScrollers() {
    const raw = [];
    collectScrollers(document, "", raw);

    // 중복 병합 — scrollingElement와 BODY/HTML의 실질적 동일 영역 제거
    const deduped = dedupeScrollers(raw);

    // 자동 추천 플래그
    markRecommended(deduped);

    // 친화 라벨
    assignFriendlyLabels(deduped);

    scrollers = deduped; // 로컬 보관 (el 포함)
    console.log(`[SBS] 스크롤러 ${scrollers.length}개 탐지 (중복 병합 후)`);

    // 메시지로 보낼 직렬화 가능한 메타만 추출
    return scrollers.map((s, i) => ({
      index: i,
      label: s.label,
      friendlyLabel: s.friendlyLabel,
      recommended: !!s.recommended,
      scrollHeight: s.scrollHeight,
      clientHeight: s.clientHeight,
      ratio: Math.ceil(s.scrollHeight / s.clientHeight), // 예상 캡처 장수
    }));
  }

  // ── 하이라이트 ───────────────────────────────────────────────

  /**
   * 팝업에서 mouseenter 시 해당 요소를 빨간 테두리로 하이라이트.
   * outline은 레이아웃을 밀지 않아 페이지 구조를 건드리지 않는다.
   * 기존 인라인 outline 값을 저장해 unhighlight 시 정확히 복원한다.
   */
  function highlight(index) {
    // 이전 하이라이트 먼저 해제
    unhighlight();
    const scroller = scrollers[index];
    if (!scroller) return;
    _highlightEl = scroller.el;
    _highlightPrevOutline = _highlightEl.style.outline;
    _highlightEl.style.outline = "3px solid red";
    _highlightEl.style.outlineOffset = "-3px";
  }

  /** 하이라이트 해제 — 저장된 이전 outline 값으로 복원 */
  function unhighlight() {
    if (!_highlightEl) return;
    _highlightEl.style.outline = _highlightPrevOutline;
    _highlightEl.style.outlineOffset = "";
    _highlightEl = null;
    _highlightPrevOutline = "";
  }

  // ── fixed/sticky 요소 처리 ──────────────────────────────────

  /**
   * sticky 요소를 position:static으로 전환한다.
   * "달라붙는" 성질만 제거되어 본문과 함께 스크롤되므로
   * 캡처 전체에서 딱 한 번만 찍힌다. 본문 흐름은 유지되어
   * 조상 요소여도 숨기지 않고 변환만 하면 안전하다.
   *
   * document와 모든 same-origin iframe을 훑는다.
   * 루프 시작 전(워밍업 후) 1회만 호출한다.
   *
   * @param {Element} targetEl 캡처 대상 요소 (진단 로그용, 제외하지 않음)
   * @returns {Array} 복원용 배열 [{el, prevPosition, docLabel}]
   */
  function convertStickyToStatic(targetEl) {
    const saved = [];

    function processDoc(doc, docLabel) {
      const all = doc.querySelectorAll("*");
      for (const el of all) {
        try {
          const pos = getComputedStyle(el).position;
          if (pos === "sticky" || pos === "-webkit-sticky") {
            // 인라인 position 값 저장 후 static으로 강제 변환
            const prevPosition = el.style.position;
            el.style.setProperty("position", "static", "important");

            // 진단 로그: 태그#id.class, computed position, 소속 문서
            const tag = el.tagName;
            const id = el.id ? `#${el.id}` : "";
            const cls = el.classList.length
              ? "." + [...el.classList].slice(0, 2).join(".")
              : "";
            console.log(`[SBS] sticky→static: ${tag}${id}${cls} (${docLabel})`);

            saved.push({ el, prevPosition, docLabel });
          }
        } catch (e) {
          // getComputedStyle 실패 시 무시
        }
      }
    }

    processDoc(document, "top");

    // same-origin iframe도 처리
    const iframes = document.querySelectorAll("iframe");
    for (const iframe of iframes) {
      try {
        if (iframe.contentDocument) {
          const iframeId = iframe.id ? `iframe#${iframe.id}` : "iframe";
          processDoc(iframe.contentDocument, iframeId);
        }
      } catch (e) {
        // cross-origin — 무시
      }
    }

    console.log(`[SBS] sticky→static 변환 ${saved.length}개`);
    return saved;
  }

  /**
   * convertStickyToStatic의 반환값으로 position을 복원한다.
   */
  function restoreStickyPositions(saved) {
    for (const { el, prevPosition } of saved) {
      el.style.position = prevPosition;
    }
    console.log(`[SBS] sticky position ${saved.length}개 복원`);
  }

  /**
   * 캡처 루프 첫 프레임 직후에 호출.
   * fixed 요소만 visibility:hidden으로 숨긴다.
   * (sticky는 convertStickyToStatic에서 이미 static 처리되었으므로 제외)
   *
   * visibility:hidden은 공간을 유지하므로 본문 좌표가 밀리지 않는다.
   * targetEl과 그 조상은 제외: 숨기면 캡처 대상 본문 자체가 사라진다.
   *
   * @param {Element} targetEl 캡처 대상 요소 (제외 대상)
   * @returns {Array} 복원용 저장 배열 [{el, prevVisibility}]
   */
  function hideFixedElements(targetEl) {
    const saved = [];

    function processDoc(doc, docLabel) {
      const all = doc.querySelectorAll("*");
      for (const el of all) {
        try {
          // 타깃 자신이나 타깃을 포함하는 조상은 숨기면 본문도 사라지므로 제외
          if (el === targetEl || el.contains(targetEl)) continue;

          const pos = getComputedStyle(el).position;
          // fixed만 대상 (sticky는 convertStickyToStatic에서 이미 처리)
          if (pos === "fixed") {
            const tag = el.tagName;
            const id = el.id ? `#${el.id}` : "";
            const cls = el.classList.length
              ? "." + [...el.classList].slice(0, 2).join(".")
              : "";
            console.log(`[SBS] fixed→hidden: ${tag}${id}${cls} (${docLabel})`);

            saved.push({ el, prevVisibility: el.style.visibility });
            // !important: 다른 확장이 주입한 인라인 스타일도 덮어쓴다
            el.style.setProperty("visibility", "hidden", "important");
          }
        } catch (e) {
          // getComputedStyle 실패 시 무시
        }
      }
    }

    // 최상위 문서 처리
    processDoc(document, "top");

    // same-origin iframe도 처리 (cross-origin은 예외 발생 → 건너뜀)
    const iframes = document.querySelectorAll("iframe");
    for (const iframe of iframes) {
      try {
        if (iframe.contentDocument) {
          const iframeId = iframe.id ? `iframe#${iframe.id}` : "iframe";
          processDoc(iframe.contentDocument, iframeId);
        }
      } catch (e) {
        // cross-origin — 무시
      }
    }

    console.log(`[SBS] fixed ${saved.length}개 숨김`);
    return saved;
  }

  /**
   * hideFixedElements의 반환값으로 visibility를 복원한다.
   * try/finally에서 반드시 호출돼 에러가 나도 원복이 보장된다.
   */
  function restoreFixedElements(saved) {
    for (const { el, prevVisibility } of saved) {
      el.style.visibility = prevVisibility;
    }
    console.log(`[SBS] fixed ${saved.length}개 복원`);
  }

  // ── 가상 요소 제거 CSS 주입 ──────────────────────────────────

  /**
   * captureScroller 호출 직후, 워밍업 전에 주입한다.
   * CSS ::before / ::after 가상 요소는 querySelectorAll로 잡히지 않고
   * el.style로도 변경 불가이므로, <style> 규칙을 직접 주입해 끈다.
   *
   * 주입 대상:
   *   - targetEl.ownerDocument (가상 요소가 실제로 있는 문서)
   *   - 최상위 document (혹시 모를 경우 대비)
   *
   * @param {Element} targetEl 캡처 대상 요소
   * @returns {HTMLStyleElement[]} 주입한 style 요소 배열 (복원용)
   */
  function injectCaptureStyle(targetEl) {
    const injected = [];

    const css = `
.se-content::before, .se-content::after,
[data-title]::before, [data-title]::after {
  content: none !important;
  display: none !important;
}`;

    const docs = [targetEl.ownerDocument, document].filter(Boolean);
    // 동일 문서 중복 주입 방지
    const seen = new Set();

    for (const doc of docs) {
      if (seen.has(doc)) continue;
      seen.add(doc);

      try {
        const style = doc.createElement("style");
        style.id = "__sbs_capture_style";
        style.textContent = css;
        const parent = doc.head || doc.documentElement;
        parent.appendChild(style);
        injected.push(style);
      } catch (e) {
        // cross-origin 등 접근 불가 시 건너뜀
      }
    }

    console.log("[SBS] 캡처용 CSS 주입 — 가상요소 제목 제거");
    return injected;
  }

  /**
   * injectCaptureStyle이 반환한 style 요소들을 DOM에서 제거한다.
   * finally 블록에서 가장 먼저 호출해 원 상태를 복원한다.
   *
   * @param {HTMLStyleElement[]} styles injectCaptureStyle의 반환값
   */
  function removeCaptureStyle(styles) {
    for (const style of styles) {
      try {
        if (style.parentNode) {
          style.parentNode.removeChild(style);
        }
      } catch (e) {
        // 이미 제거됐거나 접근 불가 시 무시
      }
    }
    console.log("[SBS] 캡처용 CSS 제거");
  }

  // ── 파일명 생성 ──────────────────────────────────────────────

  /**
   * 선택 영역의 문서에서 페이지 제목을 추출한다.
   * 네이버 블로그 전용 셀렉터 → og:title 메타 → document.title 순으로 시도.
   * 실패 시 'capture' 반환.
   */
  function getDocTitle(el) {
    const doc = el.ownerDocument || document;

    // 네이버 블로그 본문 제목 셀렉터 (Smart Editor 3 계열)
    const naverSelectors = [
      ".se-title-text",
      ".se-documentTitle",
      ".pcol1",
      ".htitle",
    ];
    for (const sel of naverSelectors) {
      try {
        const found = doc.querySelector(sel);
        if (found && found.textContent.trim()) {
          return found.textContent.trim();
        }
      } catch (e) { /* 무시 */ }
    }

    // og:title 메타 태그
    try {
      const og = doc.querySelector('meta[property="og:title"]');
      if (og && og.content && og.content.trim()) {
        return og.content.trim();
      }
    } catch (e) { /* 무시 */ }

    // document.title — 네이버 블로그 접미어 제거
    const rawTitle = doc.title || document.title || "";
    if (rawTitle.trim()) {
      return rawTitle.trim();
    }

    return "capture";
  }

  /**
   * 캡처 파일명을 생성한다.
   * 형식: [yy-mm-dd] 제목.png
   * - 네이버 블로그 접미어(" : 네이버 블로그" 등) 정규식으로 제거
   * - 윈도우 금지 문자 치환, 80자 절단
   */
  function buildFilename(el) {
    let title = getDocTitle(el);

    // 네이버 블로그 접미어 제거 (다양한 공백·구분자 변형 포함)
    title = title.replace(/\s*[:\-]\s*네이버\s*블로그\s*$/i, "").trim();

    // 윈도우 금지 문자 → 공백, 연속 공백 1칸으로, 앞뒤 정리, 80자 절단
    title = title
      .replace(/[\\/:*?"<>|]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);

    if (!title) title = "capture";

    // yy-mm-dd (2자리 연도, 월·일 0패딩)
    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");

    const filename = `[${yy}-${mm}-${dd}] ${title}.png`;
    console.log("[SBS] 생성된 파일명:", filename);
    return filename;
  }

  // ── 프레임 이미지 로딩 대기 ─────────────────────────────────

  /**
   * 단일 이미지가 로드 완료될 때까지 기다린다.
   * @param {HTMLImageElement} img       대기할 img 요소
   * @param {number}           timeout   최대 대기 시간(ms). 초과 시 강제 resolve.
   * @returns {Promise<void>}
   */
  function imageReady(img, timeout) {
    // 이미 로드된 경우 즉시 통과
    if (img.complete && img.naturalWidth > 0) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      let settled = false;

      const settle = () => {
        if (settled) return;
        settled = true;
        img.removeEventListener("load", settle);
        img.removeEventListener("error", settle);
        clearTimeout(timer);
        resolve();
      };

      // 로드 완료 또는 에러 어느 쪽이든 resolve (에러도 더 기다리지 않음)
      img.addEventListener("load", settle);
      img.addEventListener("error", settle);

      // timeout 후 강제 resolve (무한 대기 방지)
      const timer = setTimeout(settle, timeout);
    });
  }

  /**
   * 스크롤 요소 el의 현재 보이는 구간에 걸치는 img 요소들이
   * 모두 로드 완료될 때까지 기다린다.
   * 이미 로드된 이미지는 즉시 통과하므로 대부분의 프레임에서 거의 즉시 끝난다.
   *
   * @param {Element} el             캡처 대상 스크롤 요소
   * @param {number}  perImgTimeout  이미지 1장당 최대 대기 시간(ms, 기본 3000)
   * @returns {Promise<void>}
   */
  async function waitForImagesInView(el, perImgTimeout = 3000) {
    // el 안의 모든 img 수집
    const allImgs = [...el.querySelectorAll("img")];
    if (allImgs.length === 0) return;

    // el의 현재 보이는 세로 구간 (el 좌표계 기준)
    const elRect = el.getBoundingClientRect();
    const viewTop = elRect.top;
    const viewBottom = elRect.bottom;

    // el의 client rect와 img rect가 세로로 교차하는 이미지만 필터링
    const visibleImgs = allImgs.filter((img) => {
      try {
        const r = img.getBoundingClientRect();
        // 교차 조건: img 하단이 el 상단보다 아래 AND img 상단이 el 하단보다 위
        return r.bottom > viewTop && r.top < viewBottom;
      } catch (e) {
        return false;
      }
    });

    if (visibleImgs.length === 0) return;

    console.log(`[SBS] 프레임 이미지 ${visibleImgs.length}장 로딩 대기`);
    await Promise.all(visibleImgs.map((img) => imageReady(img, perImgTimeout)));
    console.log(`[SBS] 프레임 이미지 ${visibleImgs.length}장 로딩 완료`);
  }

  // ── 캡처 루프 ────────────────────────────────────────────────

  /**
   * 캡처 전에 대상 요소를 끝까지 스크롤해
   * lazy-load 콘텐츠를 모두 로드한 뒤 맨 위로 복귀한다.
   * scrollHeight가 2회 연속 동일하면 안정으로 간주한다.
   *
   * @param {Element} el 대상 스크롤 요소
   */
  async function warmUp(el) {
    console.log("[SBS] 워밍업 시작 — lazy-load 콘텐츠 사전 로드");
    let last = -1;
    let stable = 0;
    for (let i = 0; i < 60 && stable < 2; i++) {
      el.scrollTop = el.scrollHeight; // 끝까지 스크롤
      await delay(300);
      const h = el.scrollHeight;
      if (h === last) {
        stable++;
      } else {
        stable = 0;
      }
      last = h;
    }
    el.scrollTop = 0; // 맨 위로 복귀
    await delay(300);
    console.log(`[SBS] 워밍업 완료 — 최종 scrollHeight:${el.scrollHeight}`);
  }

  /**
   * 선택된 스크롤러를 위에서 아래로 스크롤하며 캡처하고
   * canvas에 합성한 뒤 PNG dataURL을 background로 보내 다운로드한다.
   *
   * 전체 흐름:
   *   unhighlight → injectCaptureStyle → warmUp → totalH 실측 → 캔버스 생성
   *   → convertStickyToStatic → 루프(첫 프레임 후 fixed hide) → 다운로드
   *   → finally (CSS 복원 + sticky 복원 + fixed 복원 + scrollTop 복원)
   */
  async function captureScroller(index) {
    const scroller = scrollers[index];
    if (!scroller) {
      console.log("[SBS] 유효하지 않은 index:", index);
      return;
    }

    const el = scroller.el;
    const dpr = window.devicePixelRatio || 1; // Retina 대응
    const viewH = el.clientHeight;
    const viewW = el.clientWidth;

    // 원래 scrollTop 저장 (finally에서 복원)
    const origScrollTop = el.scrollTop;

    // finally에서 복원할 저장 배열 초기화
    let savedSticky = [];
    let savedFixed = [];
    let injectedStyles = [];

    try {
      // ── Step 1: 하이라이트 제거 ──────────────────────────────
      // 팝업 hover 시 붙은 빨간 outline이 캡처에 찍히는 것을 방지
      unhighlight();

      // ── Step 1-b: 가상 요소 제거 CSS 주입 ───────────────────
      // ::before / ::after 가상 요소(예: .se-content::before의 sticky 제목)는
      // querySelectorAll과 el.style로는 건드릴 수 없으므로 <style> 규칙으로 제거.
      // 워밍업·측정 전에 주입해야 높이와 캡처 모두 가상 요소 없는 상태로 진행된다.
      injectedStyles = injectCaptureStyle(el);

      // ── Step 2: 워밍업 ────────────────────────────────────────
      // lazy-load 콘텐츠를 미리 끝까지 스크롤해 모두 로드
      await warmUp(el);

      // ── Step 3: totalH 실측 ───────────────────────────────────
      // 워밍업 후 실제 scrollHeight를 다시 읽어 캔버스 높이 결정
      const totalH = el.scrollHeight;
      console.log(`[SBS] 캡처 시작 — scrollHeight(워밍업후):${totalH}, clientHeight:${viewH}, dpr:${dpr}`);

      // ── Step 4: 합성 캔버스 생성 ─────────────────────────────
      const canvas = document.createElement("canvas");
      canvas.width = viewW * dpr;
      canvas.height = totalH * dpr;

      if (totalH * dpr > 16384) {
        console.log("[SBS] 캔버스 높이가 16384px 초과 — 브라우저에 따라 잘릴 수 있음");
        notifyCaptureError("페이지가 매우 길어 이미지 일부가 잘릴 수 있어요.");
      }

      const ctx = canvas.getContext("2d");

      // ── Step 5: sticky → static 변환 ─────────────────────────
      // 루프 전 1회만 적용. 조상 포함 모두 변환하므로 타깃 제외 없음.
      savedSticky = convertStickyToStatic(el);

      // 진행률 분모: 워밍업 후 totalH 기준으로 재계산
      const total = Math.ceil(totalH / viewH);

      // ── Step 6: 캡처 루프 ─────────────────────────────────────
      // 바닥 판정을 실시간 maxScroll로, 무한루프 방지 가드(MAX_FRAMES) 추가
      const MAX_FRAMES = 80;
      let y = 0;        // 다음 스크롤 목표
      let cur = 0;      // 캡처 진행 횟수
      let prevY = -1;   // 스턱 감지용
      let successFrames = 0; // 실제로 캔버스에 그려진 프레임 수

      while (cur < MAX_FRAMES) {
        // 1. 스크롤 이동
        el.scrollTop = y;

        // 2. captureVisibleTab 레이트리밋 회피
        //    (captureVisibleTab은 초당 2회 제한이 있어 500ms로 안전마진 확보)
        await delay(500);

        // 2-b. 현재 프레임에 보이는 lazy-load 이미지가 실제 픽셀까지 로드됐는지 대기.
        //      높이(scrollHeight)만으로는 보장 안 되는 네이버 이미지 픽셀 로딩을 커버한다.
        //      per-img 3초 타임아웃으로 한 장이 안 떠도 무한 대기하지 않음.
        await waitForImagesInView(el);

        // 3. 실제로 클램핑된 scrollTop 읽기 (최하단에서 y와 다를 수 있음)
        const actualY = el.scrollTop;

        // 4. 화면에서 이 요소의 위치 측정 (매번 측정 — 리플로우로 변할 수 있음)
        const rect = getScreenRect(el);

        cur++;
        console.log(`[SBS] ${cur}/${total} 캡처 — scrollTop:${actualY}, rect:`, rect);

        // 5. 진행률 팝업으로 전송
        chrome.runtime.sendMessage({ type: "SBS_CAPTURE_PROGRESS", cur, total });

        // 6. 화면 스냅샷 요청
        const dataURL = await shoot();
        if (!dataURL) {
          console.log(`[SBS] ${cur}번째 캡처 실패 — 건너뜀`);
          // 실패해도 루프 계속
        } else {
          // 7. Image 로드
          const img = await loadImage(dataURL);

          // 8. 캔버스에 붙이기
          // 소스: 탭 스크린샷에서 rect 위치만큼 잘라냄
          // 대상: canvas의 actualY 위치에 그림
          ctx.drawImage(
            img,
            rect.left * dpr,    // 소스 x
            rect.top * dpr,     // 소스 y
            rect.width * dpr,   // 소스 너비
            rect.height * dpr,  // 소스 높이
            0,                  // 대상 x
            actualY * dpr,      // 대상 y (스크롤된 만큼 아래에 붙임)
            rect.width * dpr,   // 대상 너비
            rect.height * dpr   // 대상 높이
          );
          successFrames++;
        }

        // 8-b. 첫 프레임 캡처 직후 fixed 요소 숨김 → 2번째 프레임부터 반복 차단.
        //      visibility:hidden은 공간을 유지하므로 본문 좌표가 안 밀려 합성이 어긋나지 않는다.
        //      → fixed 헤더·위젯이 첫 장(맨 위)에 딱 한 번만 등장.
        //      (sticky는 이미 Step 5에서 static 변환됨)
        if (cur === 1) {
          savedFixed = hideFixedElements(el);
        }

        // 9. 바닥 도달 여부 확인 (실시간 maxScroll 사용)
        const maxScroll = el.scrollHeight - el.clientHeight;
        if (actualY >= maxScroll - 1) {
          console.log("[SBS] 캡처 완료 — 바닥 도달");
          break;
        }

        // 10. 스크롤 한계 도달: scrollTop이 더 안 움직이면(에디터 하단 비스크롤 영역 등)
        //     정상 종료로 처리. 바닥 체크와 동급이라 일반 로그로 남긴다(에러 패널 노이즈 방지).
        //     실제로 캡처가 잘리는 경우는 결과 이미지에서 바로 드러나므로 콘솔 경고가 불필요.
        if (actualY === prevY) {
          console.log("[SBS] 캡처 완료 — 스크롤 한계 도달");
          break;
        }
        prevY = actualY;

        // 11. 다음 스크롤 위치
        y = actualY + viewH;
      }

      if (cur >= MAX_FRAMES) {
        console.log(`[SBS] MAX_FRAMES(${MAX_FRAMES}) 도달 — 안전 상한으로 루프 종료`);
      }

      // 성공 프레임이 단 한 장도 없으면 사용자에게 알림
      if (successFrames === 0) {
        notifyCaptureError("화면 캡처에 실패했어요. 페이지를 새로고침한 뒤 다시 시도해 주세요.");
        console.log("[SBS] 성공 프레임 0 — 캡처 전체 실패");
        return;
      }

      // 파일명 생성 후 download 메시지에 포함
      const filename = buildFilename(el);

      // 합성 PNG를 background로 보내 다운로드 (파일명 전달)
      const outDataURL = canvas.toDataURL("image/png");
      console.log("[SBS] 합성 완료 — 다운로드 요청, 파일명:", filename);
      chrome.runtime.sendMessage(
        { type: "SBS_CAPTURE_DOWNLOAD", dataURL: outDataURL, filename },
        (resp) => {
          if (chrome.runtime.lastError) {
            console.log("[SBS] download 메시지 실패:", chrome.runtime.lastError.message);
            notifyCaptureError("이미지 저장에 실패했어요. 다시 시도해 주세요.");
          } else if (resp && resp.ok === false) {
            console.log("[SBS] 다운로드 실패 응답:", resp);
            notifyCaptureError("이미지 저장에 실패했어요. 다시 시도해 주세요.");
          } else {
            console.log("[SBS] 다운로드 응답:", resp);
          }
        }
      );

      // 완료 알림
      chrome.runtime.sendMessage({ type: "SBS_CAPTURE_DONE" });

    } finally {
      // 가상 요소 제거 CSS 복원 — 가장 먼저 제거해 페이지 원상복구
      removeCaptureStyle(injectedStyles);
      // sticky position 복원 — try 안에서 에러가 나도 반드시 실행
      restoreStickyPositions(savedSticky);
      // fixed visibility 복원
      restoreFixedElements(savedFixed);
      // scrollTop 복원 — 에러 발생 시에도 페이지 위치 원복
      el.scrollTop = origScrollTop;
    }
  }

  // ── 메시지 리스너 ────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "SBS_CAPTURE_DETECT") {
      // 스크롤 가능한 요소 탐지 — 동기 응답
      const meta = findScrollers();
      sendResponse({ scrollers: meta });
      return false;

    } else if (msg.type === "SBS_CAPTURE_RUN") {
      // 캡처 루프는 async이므로 sendResponse를 즉시 보내고 루프는 비동기로 돌린다
      sendResponse({ started: true });
      captureScroller(msg.index).catch((err) => {
        console.log("[SBS] 캡처 중단:", err && err.message ? err.message : err);
        notifyCaptureError("캡처 중 문제가 발생했어요. 페이지를 새로고침한 뒤 다시 시도해 주세요.");
      });
      return false;

    } else if (msg.type === "SBS_CAPTURE_HIGHLIGHT") {
      // 팝업에서 mouseenter 시 해당 요소 빨간 테두리 하이라이트
      highlight(msg.index);
      return false;

    } else if (msg.type === "SBS_CAPTURE_UNHIGHLIGHT") {
      // 팝업에서 mouseleave 시 하이라이트 해제
      unhighlight();
      return false;
    }
  });

  console.log("[SBS] blog-capture 메시지 리스너 등록 완료");

})();
