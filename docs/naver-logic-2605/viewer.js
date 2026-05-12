/* ============================================================
   공유 마크다운 뷰어 — 각 탭 폴더의 index.html이 호출
   window.VIEWER_CONFIG = { mdFile, currentTab }
   ============================================================ */

(function () {
  const cfg = window.VIEWER_CONFIG;
  if (!cfg) {
    document.body.innerHTML = '<p style="padding:24px;color:#b91c1c">VIEWER_CONFIG 누락</p>';
    return;
  }

  // 탭 정의 (실행 가이드가 메인, pro는 footer 숨김 링크)
  const TABS = [
    { id: 'playbook',  label: '실행 가이드', href: '../playbook/'  },
    { id: 'principle', label: '원리 설명',   href: '../principle/' }
  ];
  const PRO_TAB = { id: 'pro', label: '현업 버전', href: '../pro/' };

  // ===== HTML 구조 빌드 =====
  document.body.innerHTML = `
    <a id="home-link" href="../../../" title="홈으로">← 홈</a>
    <button id="toc-toggle" aria-label="목차 열기/닫기">☰ 목차</button>

    <aside id="sidebar">
      <div class="sidebar-header">
        <div id="version-switch" role="tablist" aria-label="버전 선택">
          ${TABS.map(t => `
            <a class="ver-btn ${t.id === cfg.currentTab ? 'active' : ''}" href="${t.href}">${t.label}</a>
          `).join('')}
        </div>
        <h2>목차</h2>
        <input type="search" id="toc-search" placeholder="섹션 검색..." />
      </div>
      <nav id="toc"></nav>
    </aside>

    <main id="content-wrapper">
      <article id="content">
        <p class="loading">콘텐츠를 불러오는 중...</p>
      </article>
      <footer>
        <a class="ver-btn-hidden ${cfg.currentTab === 'pro' ? 'active' : ''}" href="${PRO_TAB.href}" id="pro-version-link" title="현업 버전 (전문가용)">현업 버전</a>
        <button id="theme-toggle" aria-label="다크모드 전환"><span class="theme-icon">🌙</span> <span class="theme-label">다크</span></button>
        <button id="print-btn" aria-label="인쇄">🖨 인쇄</button>
        <button id="top-btn" aria-label="맨 위로">↑ Top</button>
      </footer>
    </main>
  `;

  // ===== 마크다운 로드 & 렌더링 =====
  async function loadLecture() {
    try {
      const res = await fetch(cfg.mdFile + '?t=' + Date.now());
      if (!res.ok) throw new Error('파일을 찾을 수 없습니다 (' + cfg.mdFile + ')');
      const md = await res.text();

      marked.setOptions({ gfm: true, breaks: false, headerIds: true });

      const renderer = new marked.Renderer();
      const slugify = (text) => {
        const stripped = String(text).replace(/<[^>]+>/g, '');
        return 'h-' + stripped.trim().replace(/\s+/g, '-').replace(/[^\w가-힣\-]/g, '');
      };
      renderer.heading = (text, level) => {
        let displayText = text;
        let id = '';
        const m = text.match(/\s*\{#([^}]+)\}\s*$/);
        if (m) {
          id = m[1];
          displayText = text.replace(/\s*\{#[^}]+\}\s*$/, '');
        } else {
          id = slugify(text);
        }
        return `<h${level} id="${id}">${displayText}</h${level}>`;
      };

      const html = marked.parse(md, { renderer });
      document.getElementById('content').innerHTML = html;
      buildTOC();
      observeHeadings();
    } catch (err) {
      document.getElementById('content').innerHTML =
        `<div class="error">⚠ 로드 실패: ${err.message}<br><br>` +
        `브라우저에서 직접 열면 fetch가 차단됩니다.<br>` +
        `이 폴더 상위에서 <code>python -m http.server 8000</code> 실행 후 접속하세요.</div>`;
    }
  }

  // ===== TOC 자동 생성 (h2, h3) — 카드 마커는 제외 =====
  const CARD_MARKERS = /^(💡|🎯|🔍|⚠|➡)/;
  function buildTOC() {
    const headings = document.querySelectorAll('#content h2, #content h3');
    const toc = document.getElementById('toc');
    const ul = document.createElement('ul');
    headings.forEach(h => {
      const text = h.textContent.trim();
      if (CARD_MARKERS.test(text)) {
        h.classList.add('card-marker');
        return;
      }
      const li = document.createElement('li');
      li.className = 'toc-' + h.tagName.toLowerCase();
      const a = document.createElement('a');
      a.href = '#' + h.id;
      a.textContent = text;
      a.addEventListener('click', (e) => {
        e.preventDefault();
        h.scrollIntoView({ behavior: 'smooth', block: 'start' });
        history.replaceState(null, '', '#' + h.id);
        if (window.innerWidth < 900) document.body.classList.remove('sidebar-open');
      });
      li.appendChild(a);
      ul.appendChild(li);
    });
    toc.innerHTML = '';
    toc.appendChild(ul);
  }

  // ===== 검색 필터 =====
  document.getElementById('toc-search').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    document.querySelectorAll('#toc li').forEach(li => {
      const match = li.textContent.toLowerCase().includes(q);
      li.style.display = match ? '' : 'none';
    });
  });

  // ===== 사이드바 토글 =====
  document.getElementById('toc-toggle').addEventListener('click', () => {
    document.body.classList.toggle('sidebar-open');
  });

  // ===== 다크모드 =====
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    const icon = document.querySelector('#theme-toggle .theme-icon');
    const label = document.querySelector('#theme-toggle .theme-label');
    if (icon && label) {
      icon.textContent = theme === 'dark' ? '☀' : '🌙';
      label.textContent = theme === 'dark' ? '라이트' : '다크';
    }
  }
  applyTheme(localStorage.getItem('theme') || 'light');
  document.getElementById('theme-toggle').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme;
    const next = cur === 'light' ? 'dark' : 'light';
    applyTheme(next);
    localStorage.setItem('theme', next);
  });

  // ===== 인쇄 =====
  document.getElementById('print-btn').addEventListener('click', () => window.print());

  // ===== 맨 위로 =====
  document.getElementById('top-btn').addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // ===== 스크롤 시 현재 섹션 하이라이트 =====
  let observer = null;
  function observeHeadings() {
    if (observer) observer.disconnect();
    observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const id = entry.target.id;
          document.querySelectorAll('#toc a').forEach(a => {
            a.classList.toggle('active', a.getAttribute('href') === '#' + id);
          });
        }
      });
    }, { rootMargin: '-30% 0px -60% 0px' });
    document.querySelectorAll('#content h2, #content h3').forEach(h => observer.observe(h));
  }

  loadLecture();
})();
