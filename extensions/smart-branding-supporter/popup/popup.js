// 스마트 브랜딩 서포터 — popup
// 4개 기능 토글 상태를 chrome.storage.sync에 저장/불러오기.

const FEATURE_KEYS = ["blogCleaner", "searchNavigator", "searchHighlighter", "searchVolume"];
const OPTION_KEYS  = ["searchHighlighterColor", "searchNavigatorPosition"];

const DEFAULTS = {
  blogCleaner: true,
  searchNavigator: true,
  searchHighlighter: true,
  searchVolume: false, // 백엔드 미완성 → 기본 OFF
  searchHighlighterColor: "blue",
  searchNavigatorPosition: "left-top",
};

document.addEventListener("DOMContentLoaded", async () => {
  const toggles  = document.querySelectorAll("input.toggle");
  // .segmented 와 .position-picker 모두 data-segmented 속성으로 통합 처리
  const segments = document.querySelectorAll("[data-segmented]");
  const allKeys  = [...FEATURE_KEYS, ...OPTION_KEYS];
  const stored   = await chrome.storage.sync.get(allKeys);

  // 토글 초기값 반영
  toggles.forEach((input) => {
    const key = input.dataset.feature;
    if (input.disabled) return;
    input.checked = stored[key] ?? DEFAULTS[key];
    syncFeatureItemState(input);
  });

  // 토글 변경 시 즉시 저장
  toggles.forEach((input) => {
    input.addEventListener("change", async () => {
      if (input.disabled) return;
      const key = input.dataset.feature;
      await chrome.storage.sync.set({ [key]: input.checked });
      flashStatus(`${labelOf(key)}: ${input.checked ? "켬" : "끔"}`);
      syncFeatureItemState(input);
    });
  });

  // segmented / position-picker 초기값 반영 + 클릭 이벤트
  segments.forEach((seg) => {
    const key     = seg.dataset.segmented;
    const current = stored[key] ?? DEFAULTS[key];
    applySegmentedValue(seg, current);

    seg.querySelectorAll("button[data-value]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const val = btn.dataset.value;
        applySegmentedValue(seg, val);
        await chrome.storage.sync.set({ [key]: val });
        const labelFn = key === "searchHighlighterColor" ? labelOfColor : labelOfPosition;
        flashStatus(`${labelOfKey(key)}: ${labelFn(val)}`);
      });
    });
  });
});

// segmented 버튼의 active 클래스를 value에 맞게 갱신
function applySegmentedValue(seg, value) {
  seg.querySelectorAll("button[data-value]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.value === value);
  });
}

// 토글 상태에 따라 .feature-on 클래스 동기화
function syncFeatureItemState(input) {
  const li = input.closest(".feature-item");
  if (!li) return;
  li.classList.toggle("feature-on", input.checked && !input.disabled);
}

function labelOf(key) {
  return {
    blogCleaner: "글감 패널 숨기기",
    searchNavigator: "좌측 섹션 네비게이터",
    searchHighlighter: "블로그 결과 강조",
    searchVolume: "검색량 표시",
  }[key] ?? key;
}

function labelOfColor(v) {
  return { green: "녹색", yellow: "노랑", blue: "하늘" }[v] ?? v;
}

function labelOfPosition(v) {
  return {
    auto: "자동(콘텐츠 옆)",
    "left-top": "좌상", "left-middle": "좌중(s)", "left-bottom": "좌중(l)",
    "right-top": "우상", "right-middle": "우중(s)", "right-bottom": "우중(l)",
  }[v] ?? v;
}

function labelOfKey(k) {
  return {
    searchHighlighterColor: "색상",
    searchNavigatorPosition: "위치",
  }[k] ?? k;
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
