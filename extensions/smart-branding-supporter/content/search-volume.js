// 기능 ④: 검색량 박스 표시
// 적용 페이지: search.naver.com
// Cloudflare Worker를 통해 네이버 검색광고 API 검색량을 조회하고 네비게이터 패널에 표시.
// 구조: 현재 키워드 검색량 → 헤더 바로 아래 (강조), 연관 검색어 → 박스 최하단

(() => {
  'use strict';

  const WORKER_URL = 'https://naver-searchad-proxy.sbreport.workers.dev/search-volume';
  const SECTION_CLASS_TOP = 'sbs-nav-section-volume-top';
  const SECTION_CLASS_RELATED = 'sbs-nav-section-volume-related';
  const STYLE_ID = 'sbs-volume-style';
  const RELATED_KEYWORDS_KEY = 'relatedKeywords';

  // 메모리 캐시: keyword → data[]
  const cache = new Map();

  // 진행 중인 fetch 키 관리 (중복 호출 방지)
  const inFlight = new Set();

  // ─── 스타일 주입 (1회) ──────────────────────────────────────────────────────

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
/* 상단 — 현재 키워드 강조 */
.sbs-nav-section-volume-top {
  padding: 10px 12px;
  background: linear-gradient(180deg, #f0f8ff 0%, #fafafa 100%);
  border-bottom: 1px solid #e0e8f0;
}
.sbs-nav-section-volume-top .sbs-nav-volume-title {
  font-size: 10.5px;
  font-weight: 700;
  color: #4a7ab8;
  letter-spacing: 0.3px;
  margin-bottom: 4px;
}
.sbs-nav-volume-current-keyword {
  font-size: 14px;
  font-weight: 700;
  color: #1a1a1a;
  line-height: 1.3;
}
.sbs-nav-volume-current-detail {
  font-size: 11.5px;
  color: #555;
  margin-top: 2px;
}

/* 하단 — 연관 검색어 리스트 */
.sbs-nav-section-volume-related {
  padding: 8px 10px;
  border-top: 1px solid #ececec;
  margin-top: 4px;
  background: #fafafa;
}
.sbs-nav-section-volume-related .sbs-nav-volume-title {
  font-size: 11px;
  font-weight: 700;
  color: #888;
  margin-bottom: 6px;
}
.sbs-nav-volume-item {
  padding: 5px 0;
  border-bottom: 1px dashed #eee;
}
.sbs-nav-volume-item:last-child { border-bottom: none; }
.sbs-nav-volume-keyword {
  font-size: 12px;
  font-weight: 600;
  color: #222;
}
.sbs-nav-volume-detail {
  font-size: 10.5px;
  color: #666;
  margin-top: 1px;
}

/* 로딩·에러 */
.sbs-nav-volume-loading,
.sbs-nav-volume-error {
  font-size: 11.5px;
  color: #aaa;
  padding: 4px 0;
}
.sbs-nav-volume-error { color: #c0392b; }
`;
    document.head.appendChild(style);
  }

  // ─── 유틸 ───────────────────────────────────────────────────────────────────

  function formatNum(n) {
    return new Intl.NumberFormat('ko-KR').format(n);
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function extractKeyword() {
    const params = new URLSearchParams(location.search);
    const raw = params.get('query') || params.get('q') || '';
    // Worker가 공백을 제거해 정규화하므로(예: "청주 피부과" → "청주피부과"),
    // 응답의 keyword 필드와 매칭하려면 클라이언트도 같은 정규화를 적용해야 함.
    return raw.replace(/\s+/g, '');
  }

  // ─── 토글 상태 확인 ─────────────────────────────────────────────────────────

  async function isToggleEnabled() {
    try {
      const result = await chrome.storage.sync.get('searchVolume');
      // 저장값 없으면 기본 ON
      return result.searchVolume !== false;
    } catch {
      return true;
    }
  }

  // ─── Worker 호출 ────────────────────────────────────────────────────────────

  async function fetchVolume(keyword) {
    const url = `${WORKER_URL}?keywords=${encodeURIComponent(keyword)}`;
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.keywords || [];
  }

  // ─── 렌더 함수 ──────────────────────────────────────────────────────────────

  function removeAllSections(panel) {
    panel.querySelector(`.${SECTION_CLASS_TOP}`)?.remove();
    panel.querySelector(`.${SECTION_CLASS_RELATED}`)?.remove();
  }

  function renderTopSection(panel, currentItem) {
    panel.querySelector(`.${SECTION_CLASS_TOP}`)?.remove();
    if (!currentItem) return;

    const header = panel.querySelector('.sbs-nav-header');
    if (!header) return;

    const section = document.createElement('div');
    section.className = SECTION_CLASS_TOP;

    const total = formatNum(currentItem.total || 0);
    const pc = formatNum(currentItem.pc || 0);
    const mobile = formatNum(currentItem.mobile || 0);
    const kw = escapeHtml(currentItem.keyword);

    section.innerHTML = `
      <div class="sbs-nav-volume-title">검색량 (월간)</div>
      <div class="sbs-nav-volume-current">
        <div class="sbs-nav-volume-current-keyword">${kw} (${total})</div>
        <div class="sbs-nav-volume-current-detail">M ${mobile} + P ${pc}</div>
      </div>
    `;
    header.insertAdjacentElement('afterend', section);
  }

  function renderRelatedSection(panel, relatedItems) {
    panel.querySelector(`.${SECTION_CLASS_RELATED}`)?.remove();
    if (!relatedItems || relatedItems.length === 0) return;

    const section = document.createElement('div');
    section.className = SECTION_CLASS_RELATED;

    let html = '<div class="sbs-nav-volume-title">연관 검색어 (월간)</div>';
    for (const it of relatedItems) {
      const total = formatNum(it.total || 0);
      const pc = formatNum(it.pc || 0);
      const mobile = formatNum(it.mobile || 0);
      const kw = escapeHtml(it.keyword);
      html += `
        <div class="sbs-nav-volume-item">
          <div class="sbs-nav-volume-keyword">${kw} (${total})</div>
          <div class="sbs-nav-volume-detail">M ${mobile} + P ${pc}</div>
        </div>`;
    }
    section.innerHTML = html;
    panel.appendChild(section);
  }

  function renderAllSections(panel, items, currentKeyword) {
    const validItems = items.filter(it => (it.total || 0) > 0);
    const current = validItems.find(it => it.keyword === currentKeyword) || null;
    const related = validItems
      .filter(it => it.keyword !== currentKeyword)
      .sort((a, b) => (b.total || 0) - (a.total || 0))
      .slice(0, 6);
    renderTopSection(panel, current);
    renderRelatedSection(panel, related);
  }

  function renderLoading(panel) {
    removeAllSections(panel);
    const header = panel.querySelector('.sbs-nav-header');
    if (!header) return;

    const section = document.createElement('div');
    section.className = SECTION_CLASS_TOP;
    section.innerHTML = `
      <div class="sbs-nav-volume-title">검색량 (월간)</div>
      <div class="sbs-nav-volume-loading">불러오는 중…</div>
    `;
    header.insertAdjacentElement('afterend', section);
  }

  function renderError(panel) {
    removeAllSections(panel);
    const header = panel.querySelector('.sbs-nav-header');
    if (!header) return;

    const section = document.createElement('div');
    section.className = SECTION_CLASS_TOP;
    section.innerHTML = `
      <div class="sbs-nav-volume-title">검색량 (월간)</div>
      <div class="sbs-nav-volume-error">조회 실패</div>
    `;
    header.insertAdjacentElement('afterend', section);
  }

  // ─── 메인 핸들러 ────────────────────────────────────────────────────────────

  async function handleNavRendered(panel) {
    const enabled = await isToggleEnabled();
    if (!enabled) return;

    const keyword = extractKeyword();
    if (!keyword) return;

    injectStyle();

    // 캐시 히트
    if (cache.has(keyword)) {
      renderAllSections(panel, cache.get(keyword), keyword);
      return;
    }

    // 동일 키워드 진행 중이면 중복 호출 방지
    if (inFlight.has(keyword)) return;

    renderLoading(panel);
    inFlight.add(keyword);

    try {
      const items = await fetchVolume(keyword);
      cache.set(keyword, items);

      // 키워드가 바뀌었으면 결과 무시
      if (extractKeyword() !== keyword) return;

      const currentPanel = document.getElementById('sbs-nav');
      if (!currentPanel) return;
      renderAllSections(currentPanel, items, keyword);
    } catch (err) {
      // "Failed to fetch" / AbortError는 페이지 reload·네비게이션 중 자연 발생 → 노이즈 방지
      const isTransient = err.name === 'AbortError' || /Failed to fetch/i.test(String(err.message || err));
      if (!isTransient) {
        console.warn('[SBS] 검색량 조회 실패:', err);
      }
      if (extractKeyword() !== keyword) return;
      const currentPanel = document.getElementById('sbs-nav');
      if (!currentPanel) return;
      renderError(currentPanel);
    } finally {
      inFlight.delete(keyword);
    }
  }

  // ─── 연관 검색어 표시 클래스 헬퍼 ──────────────────────────────────────────────

  function applyRelatedClass(enabled) {
    const nav = document.getElementById('sbs-nav');
    if (!nav) return;
    nav.classList.toggle('sbs-nav-hide-related', !enabled);
  }

  // ─── 이벤트 수신 ────────────────────────────────────────────────────────────

  document.addEventListener('sbs-nav-rendered', (e) => {
    const panel = (e.detail && e.detail.panel) || e.target;
    if (!panel) return;
    handleNavRendered(panel);
    // 연관 검색어 토글 상태 즉시 반영
    chrome.storage.sync.get(RELATED_KEYWORDS_KEY).then((stored) => {
      applyRelatedClass(stored[RELATED_KEYWORDS_KEY] ?? true);
    });
  });

  // 토글 상태 변경 즉시 반영
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;

    // 연관 검색어 표시 토글
    if (RELATED_KEYWORDS_KEY in changes) {
      applyRelatedClass(changes[RELATED_KEYWORDS_KEY].newValue ?? true);
    }

    if (!('searchVolume' in changes)) return;
    const enabled = changes.searchVolume.newValue;
    const panel = document.getElementById('sbs-nav');
    if (!panel) return;

    if (!enabled) {
      // OFF → 두 섹션 모두 제거
      removeAllSections(panel);
    } else {
      // ON → 즉시 렌더 시도
      handleNavRendered(panel);
    }
  });
})();
