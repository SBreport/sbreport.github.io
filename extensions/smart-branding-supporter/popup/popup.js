// 스마트 브랜딩 서포터 — popup
// 4개 기능 토글 상태를 chrome.storage.sync에 저장/불러오기.

const FEATURE_KEYS = ["blogCleaner", "searchNavigator", "searchHighlighter", "searchVolume", "relatedKeywords", "blogCount"];
const OPTION_KEYS  = ["searchHighlighterColor", "searchNavigatorPosition"];

const DEFAULTS = {
  blogCleaner: true,
  searchNavigator: true,
  searchHighlighter: true,
  searchVolume: true,
  relatedKeywords: false,
  blogCount: true,
  searchHighlighterColor: "blue",
  searchNavigatorPosition: "left-top",
};

// 스마트브랜딩 웹페이지 URL (정식 사이트 출시 시 1줄 교체)
const SITE_URL = "https://sbsupport.netlify.app/";

document.addEventListener("DOMContentLoaded", async () => {
  const toggles  = document.querySelectorAll("input.toggle");
  // .segmented 와 .position-picker 모두 data-segmented 속성으로 통합 처리
  const segments = document.querySelectorAll("[data-segmented]");
  const allKeys  = [...FEATURE_KEYS, ...OPTION_KEYS];
  const stored   = await chrome.storage.sync.get(allKeys);

  // 웹페이지 이동 버튼
  const siteBtn = document.getElementById("openSiteBtn");
  if (siteBtn) {
    siteBtn.addEventListener("click", () => {
      chrome.tabs.create({ url: SITE_URL });
    });
  }

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
    relatedKeywords: "연관 검색어 표시",
    blogCount: "블로그 카운트 강조",
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

// ── 블로그 전체 캡처 ────────────────────────────────────────────

(function sbsCaptureInit() {
  const captureBtn    = document.getElementById("sbsCaptureBtn");
  const captureList   = document.getElementById("sbsCaptureList");
  const captureStatus = document.getElementById("sbsCaptureStatus");

  if (!captureBtn) return;

  // 허용 도메인 패턴
  const ALLOWED_PATTERNS = [
    /^https?:\/\/blog\.naver\.com\//,
    /^https?:\/\/m\.blog\.naver\.com\//,
    /^https?:\/\/[^/]*\.editor\.naver\.com\//,
  ];

  // ── 상태 표시 헬퍼 ─────────────────────────────────────────
  function setCaptureStatus(text, type = "") {
    captureStatus.textContent = text;
    captureStatus.className   = type; // '' | 'sbs-capture-error' | 'sbs-capture-done'
  }

  // ── 탭 메시지 헬퍼 (Promise) ───────────────────────────────
  function sbcSendToTab(tabId, msg) {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, msg, (resp) => {
        if (chrome.runtime.lastError) {
          resolve({ __error: chrome.runtime.lastError.message });
        } else {
          resolve(resp || {});
        }
      });
    });
  }

  // ── 활성 탭 가져오기 ────────────────────────────────────────
  function sbcGetActiveTab() {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => resolve(tab));
    });
  }

  // ── 목록 렌더 ───────────────────────────────────────────────
  function sbcRenderList(scrollers, tabId) {
    captureList.innerHTML = "";

    const recommended = scrollers.find((s) => s.recommended);
    const others      = scrollers.filter((s) => !s.recommended);
    const pages       = (s) => s.ratio ?? Math.ceil(s.scrollHeight / (s.clientHeight || 800));

    function makeBtn(s, isRec) {
      const btn = document.createElement("button");
      btn.className = isRec ? "sbsCapture-recommended" : "sbsCapture-alt-btn";
      btn.innerHTML = isRec
        ? `<span class="sbsCapture-friendly">이 범위 캡처 &nbsp;${sbcEsc(s.friendlyLabel)}</span>
           <span class="sbsCapture-meta">${s.scrollHeight}px · 예상 ${pages(s)}장</span>
           <span class="sbsCapture-sub">${sbcEsc(s.label)}</span>`
        : `<span class="sbsCapture-friendly">${sbcEsc(s.friendlyLabel)}</span>
           <span class="sbsCapture-meta">${s.scrollHeight}px · 예상 ${pages(s)}장</span>
           <span class="sbsCapture-sub">${sbcEsc(s.label)}</span>`;

      btn.addEventListener("mouseenter", () => {
        sbcSendToTab(tabId, { type: "SBS_CAPTURE_HIGHLIGHT", index: s.index });
      });
      btn.addEventListener("mouseleave", () => {
        sbcSendToTab(tabId, { type: "SBS_CAPTURE_UNHIGHLIGHT" });
      });
      btn.addEventListener("click", () => sbcRun(tabId, s.index));
      return btn;
    }

    if (recommended) {
      captureList.appendChild(makeBtn(recommended, true));
    }

    if (others.length > 0) {
      const details = document.createElement("details");
      details.className = "sbsCapture-details";
      const summary = document.createElement("summary");
      summary.className = "sbsCapture-summary";
      summary.textContent = `다른 범위 선택 (${others.length}개)`;
      details.appendChild(summary);

      const altList = document.createElement("div");
      altList.className = "sbsCapture-alt-list";
      others.forEach((s) => altList.appendChild(makeBtn(s, false)));
      details.appendChild(altList);
      captureList.appendChild(details);
    }
  }

  // ── 캡처 실행 ───────────────────────────────────────────────
  async function sbcRun(tabId, index) {
    captureList.querySelectorAll("button").forEach((b) => (b.disabled = true));
    captureBtn.disabled = true;
    setCaptureStatus("캡처 준비 중…");

    const resp = await sbcSendToTab(tabId, { type: "SBS_CAPTURE_RUN", index });

    if (!resp || !resp.started) {
      setCaptureStatus("캡처 시작 실패 — 페이지를 새로고침한 뒤 다시 시도하세요", "sbs-capture-error");
      captureList.querySelectorAll("button").forEach((b) => (b.disabled = false));
      captureBtn.disabled = false;
      return;
    }

    // 최대 90초 대기 후 UI 복원 (진행/완료는 onMessage로 처리)
    sbcRun._timeout = setTimeout(() => {
      captureList.querySelectorAll("button").forEach((b) => (b.disabled = false));
      captureBtn.disabled = false;
    }, 90_000);
  }

  // ── 캡처 버튼 클릭 ─────────────────────────────────────────
  captureBtn.addEventListener("click", async () => {
    captureList.innerHTML = "";
    setCaptureStatus("");

    const tab = await sbcGetActiveTab();
    if (!tab) {
      setCaptureStatus("활성 탭을 찾을 수 없습니다.", "sbs-capture-error");
      return;
    }

    const allowed = ALLOWED_PATTERNS.some((p) => p.test(tab.url || ""));
    if (!allowed) {
      setCaptureStatus("블로그 글쓰기·보기 페이지에서 사용하세요.", "sbs-capture-error");
      return;
    }

    setCaptureStatus("범위 탐색 중…");
    captureBtn.disabled = true;

    const resp = await sbcSendToTab(tab.id, { type: "SBS_CAPTURE_DETECT" });

    captureBtn.disabled = false;

    if (resp && resp.__error) {
      setCaptureStatus("페이지를 새로고침한 뒤 다시 시도하세요.", "sbs-capture-error");
      return;
    }

    if (!resp || !resp.scrollers) {
      setCaptureStatus("페이지를 새로고침한 뒤 다시 시도하세요.", "sbs-capture-error");
      return;
    }

    if (resp.scrollers.length === 0) {
      setCaptureStatus("캡처 가능한 영역을 찾지 못했습니다.");
      return;
    }

    setCaptureStatus(`${resp.scrollers.length}개 영역 발견 — 캡처할 범위를 선택하세요`);
    sbcRenderList(resp.scrollers, tab.id);
  });

  // ── background/content → popup 수신 ────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "SBS_CAPTURE_PROGRESS") {
      setCaptureStatus(`캡처 중… ${msg.cur} / ${msg.total}`);
    } else if (msg.type === "SBS_CAPTURE_DONE") {
      clearTimeout(sbcRun._timeout);
      setCaptureStatus("완료 — 다운로드 폴더를 확인하세요.", "sbs-capture-done");
      captureList.querySelectorAll("button").forEach((b) => (b.disabled = false));
      captureBtn.disabled = false;
    } else if (msg.type === "SBS_CAPTURE_ERROR") {
      clearTimeout(sbcRun._timeout);
      setCaptureStatus(msg.message || "캡처 중 오류가 발생했어요.", "sbs-capture-error");
      captureList.querySelectorAll("button").forEach((b) => (b.disabled = false));
      captureBtn.disabled = false;
    }
  });

  // ── 유틸 ───────────────────────────────────────────────────
  function sbcEsc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
})();
