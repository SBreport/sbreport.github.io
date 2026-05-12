/**
 * 스마트브랜딩 온보딩 — 서브 슬라이드 지원 앱 스크립트
 *
 * 구조: 챕터(탭) → 서브 슬라이드 배열
 * 각 챕터는 slides 배열을 가지며, 화살표·키보드로 전환
 */

(function () {
  'use strict';

  // ---- 챕터 정의 (슬라이드 ID 배열) ----
  const CHAPTERS = [
    {
      id: 'welcome',
      label: 'Welcome',
      slides: ['tpl-welcome-1'],
    },
    {
      id: 'industry',
      label: '업계 & 포지셔닝',
      slides: ['tpl-industry-1', 'tpl-industry-2', 'tpl-industry-3'],
    },
    {
      id: 'company',
      label: '회사 소개',
      slides: ['tpl-company-1', 'tpl-company-2', 'tpl-company-3'],
    },
    {
      id: 'organization',
      label: '조직도',
      slides: ['tpl-org-1'],
    },
    {
      id: 'culture',
      label: '일하는 방식',
      slides: ['tpl-culture-1', 'tpl-culture-2'],
    },
    {
      id: 'meetings',
      label: '회의 & 보고',
      slides: ['tpl-meetings-1', 'tpl-meetings-2'],
    },
    {
      id: 'operations',
      label: 'Operations',
      slides: [
        'tpl-ops-1',
        'tpl-ops-2',
        'tpl-ops-3',
        'tpl-ops-4',
        'tpl-ops-5',
      ],
    },
  ];

  // ---- 상태 ----
  let currentChapterIdx = 0;
  let currentSlideIdx = 0;
  const slideCache = {}; // tplId → DOM element

  // ---- DOM 참조 ----
  const contentArea = document.getElementById('content-area');
  const tabButtons = document.querySelectorAll('.tab-btn');
  const btnPrev = document.getElementById('btn-prev');
  const btnNext = document.getElementById('btn-next');
  const slideIndicator = document.getElementById('slide-indicator');

  // ---- 슬라이드 캐시 준비 ----
  function ensureSlide(tplId) {
    if (slideCache[tplId]) return slideCache[tplId];

    const tpl = document.getElementById(tplId);
    if (!tpl) {
      console.warn('Template not found:', tplId);
      return null;
    }

    const node = tpl.content.cloneNode(true);
    const el = node.firstElementChild;
    el.dataset.tplId = tplId;
    el.classList.add('slide-page');
    contentArea.appendChild(el);
    slideCache[tplId] = el;
    return el;
  }

  // ---- 슬라이드 표시 ----
  function showSlide(chapterIdx, slideIdx) {
    const chapter = CHAPTERS[chapterIdx];
    if (!chapter) return;

    const clampedSlide = Math.max(0, Math.min(slideIdx, chapter.slides.length - 1));
    const tplId = chapter.slides[clampedSlide];

    // 로딩 상태 제거
    const loadingEl = document.getElementById('loading-state');
    if (loadingEl) loadingEl.remove();

    // 현재 visible 슬라이드 숨기기
    contentArea.querySelectorAll('.slide-page.visible').forEach(el => {
      el.classList.remove('visible');
    });

    // 대상 슬라이드 확보 & 표시
    const target = ensureSlide(tplId);
    if (target) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          target.classList.add('visible');
        });
      });
    }

    currentChapterIdx = chapterIdx;
    currentSlideIdx = clampedSlide;

    updateNav();
  }

  // ---- 네비게이션 UI 업데이트 ----
  function updateNav() {
    const chapter = CHAPTERS[currentChapterIdx];
    const total = chapter.slides.length;
    const current = currentSlideIdx + 1;

    // 인디케이터
    if (slideIndicator) {
      if (total <= 1) {
        slideIndicator.textContent = '';
        slideIndicator.style.display = 'none';
      } else {
        slideIndicator.textContent = `${current} / ${total}`;
        slideIndicator.style.display = '';
      }
    }

    // 이전/다음 버튼
    if (btnPrev) {
      btnPrev.disabled = currentSlideIdx === 0;
    }
    if (btnNext) {
      btnNext.disabled = currentSlideIdx >= total - 1;
    }

    // 탭 활성 상태
    tabButtons.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === chapter.id);
    });
  }

  // ---- 챕터 전환 ----
  function goToChapter(chapterIdx) {
    if (chapterIdx < 0 || chapterIdx >= CHAPTERS.length) return;
    showSlide(chapterIdx, 0);
  }

  // ---- 슬라이드 이동 ----
  function goSlide(delta) {
    const chapter = CHAPTERS[currentChapterIdx];
    const newIdx = currentSlideIdx + delta;
    if (newIdx < 0 || newIdx >= chapter.slides.length) return;
    showSlide(currentChapterIdx, newIdx);
  }

  // ---- 탭 버튼 클릭 ----
  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const tabId = btn.dataset.tab;
      const chapterIdx = CHAPTERS.findIndex(c => c.id === tabId);
      if (chapterIdx < 0) return;
      if (chapterIdx === currentChapterIdx) return;
      goToChapter(chapterIdx);
    });
  });

  // ---- 화살표 버튼 ----
  if (btnPrev) btnPrev.addEventListener('click', () => goSlide(-1));
  if (btnNext) btnNext.addEventListener('click', () => goSlide(1));

  // ---- 키보드 지원 ----
  document.addEventListener('keydown', (e) => {
    switch (e.key) {
      case 'ArrowRight':
        e.preventDefault();
        goSlide(1);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        goSlide(-1);
        break;
      case 'ArrowDown':
      case 'PageDown':
        e.preventDefault();
        goToChapter(currentChapterIdx + 1);
        break;
      case 'ArrowUp':
      case 'PageUp':
        e.preventDefault();
        goToChapter(currentChapterIdx - 1);
        break;
    }
  });

  // ---- 에러 상태 표시 ----
  function showError(msg) {
    const loadingEl = document.getElementById('loading-state');
    if (loadingEl) loadingEl.remove();
    const existingError = contentArea.querySelector('.state-error');
    if (existingError) existingError.remove();

    const div = document.createElement('div');
    div.className = 'state-error';
    div.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      <span>${msg}</span>
    `;
    contentArea.appendChild(div);
  }

  // ---- 초기 로드 ----
  function init() {
    const hash = location.hash.replace('#', '');
    const initialChapter = CHAPTERS.findIndex(c => c.id === hash);
    const startChapter = initialChapter >= 0 ? initialChapter : 0;
    showSlide(startChapter, 0);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
