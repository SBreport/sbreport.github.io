// 스마트 브랜딩 서포터 — 백그라운드 서비스 워커
// 향후 검색량 API 프록시 호출 등의 메시지 라우팅을 담당.
// 현재는 골격 단계.

chrome.runtime.onInstalled.addListener(() => {
  console.log("[SBS] service-worker installed");
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 향후 SBS_* 타입 메시지 라우팅
  // 예: SBS_FETCH_SEARCH_VOLUME, ...
  console.log("[SBS] message received:", message?.type);

  // ── 블로그 캡처 핸들러 ────────────────────────────────────────

  // SBS_CAPTURE_SHOOT: 현재 탭 화면을 PNG dataURL로 찍어 반환.
  // captureVisibleTab은 content script 권한 밖이라 service worker가 대신 실행.
  if (message.type === "SBS_CAPTURE_SHOOT") {
    chrome.tabs.captureVisibleTab(
      sender.tab.windowId,
      { format: "png" },
      (dataURL) => {
        if (chrome.runtime.lastError) {
          console.log("[SBS] captureVisibleTab 실패:", chrome.runtime.lastError.message);
          sendResponse({ dataURL: null });
        } else {
          sendResponse({ dataURL });
        }
      }
    );
    return true; // 비동기 sendResponse를 위해 true 반환 필수
  }

  // SBS_CAPTURE_DOWNLOAD: dataURL을 파일로 자동 저장.
  // content script의 canvas.toDataURL() 결과를 chrome.downloads API로 내려받음.
  if (message.type === "SBS_CAPTURE_DOWNLOAD") {
    chrome.downloads.download(
      {
        url: message.dataURL,
        filename: message.filename || "sbs-capture.png",
        saveAs: false, // 자동 저장 — 매번 다이얼로그 불필요
      },
      () => {
        if (chrome.runtime.lastError) {
          console.log("[SBS] download 실패:", chrome.runtime.lastError.message);
          sendResponse({ ok: false });
        } else {
          sendResponse({ ok: true });
        }
      }
    );
    return true; // 비동기 sendResponse를 위해 true 반환 필수
  }

  return false; // 비동기 응답이 필요한 핸들러는 true 반환할 것
});
