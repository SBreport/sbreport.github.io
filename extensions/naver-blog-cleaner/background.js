chrome.action.onClicked.addListener(async (tab) => {
  if (
    tab.url &&
    (tab.url.includes("blog.naver.com") ||
      tab.url.includes("editor.blog.naver.com"))
  ) {
    try {
      // 모든 프레임에 메시지 전송
      await chrome.tabs.sendMessage(tab.id, { action: "toggleGeulgam" });
    } catch (e) {
      // content script 미로드 시 모든 프레임에 직접 주입
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          files: ["content.js"],
        });
        setTimeout(async () => {
          try {
            await chrome.tabs.sendMessage(tab.id, { action: "toggleGeulgam" });
          } catch (err) {
            console.log("글감 요소를 찾을 수 없습니다.", err);
          }
        }, 500);
      } catch (err2) {
        console.log("스크립트 주입 실패:", err2);
      }
    }
  }
});
