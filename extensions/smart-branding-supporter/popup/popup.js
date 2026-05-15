// 스마트 브랜딩 서포터 — popup
// 4개 기능 토글 상태를 chrome.storage.sync에 저장/불러오기.

const FEATURE_KEYS = ["blogCleaner", "searchNavigator", "searchHighlighter", "searchVolume"];

const DEFAULTS = {
  blogCleaner: true,
  searchNavigator: true,
  searchHighlighter: true,
  searchVolume: false, // 백엔드 미완성 → 기본 OFF
};

document.addEventListener("DOMContentLoaded", async () => {
  const toggles = document.querySelectorAll("input.toggle");
  const stored = await chrome.storage.sync.get(FEATURE_KEYS);

  // 초기값 반영
  toggles.forEach((input) => {
    const key = input.dataset.feature;
    if (input.disabled) return;
    input.checked = stored[key] ?? DEFAULTS[key];
  });

  // 변경 시 즉시 저장
  toggles.forEach((input) => {
    input.addEventListener("change", async () => {
      if (input.disabled) return;
      const key = input.dataset.feature;
      await chrome.storage.sync.set({ [key]: input.checked });
      flashStatus(`${labelOf(key)}: ${input.checked ? "켬" : "끔"}`);
    });
  });
});

function labelOf(key) {
  return {
    blogCleaner: "글감 패널 숨기기",
    searchNavigator: "좌측 섹션 네비게이터",
    searchHighlighter: "블로그 결과 강조",
    searchVolume: "검색량 표시",
  }[key] ?? key;
}

function flashStatus(text) {
  const el = document.getElementById("statusMessage");
  if (!el) return;
  el.textContent = text;
  clearTimeout(flashStatus._timer);
  flashStatus._timer = setTimeout(() => {
    el.textContent = "설정은 즉시 저장됩니다.";
  }, 1600);
}
