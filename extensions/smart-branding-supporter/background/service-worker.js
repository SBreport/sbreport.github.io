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
  return false; // 비동기 응답이 필요한 핸들러는 true 반환할 것
});
