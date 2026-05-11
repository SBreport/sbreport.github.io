/* ============================================================
   확장프로그램 랜딩 페이지 공용 뷰어
   window.EXT_CONFIG = { name, slug, title, sub, tags[], folder }
   ============================================================ */

(function () {
  const cfg = window.EXT_CONFIG;
  if (!cfg) {
    document.body.innerHTML = '<p style="padding:24px;color:#b91c1c">EXT_CONFIG 누락</p>';
    return;
  }

  const REPO = 'SBreport/sbreport.github.io';
  const githubFolderUrl = `https://github.com/${REPO}/tree/main/extensions/${cfg.slug}`;
  const zipUrl = `https://download-directory.github.io/?url=${encodeURIComponent(githubFolderUrl)}`;

  // HTML 구조 빌드
  document.body.innerHTML = `
    <a id="home-link" href="../../" title="홈으로">← 홈</a>

    <main class="page">
      <header class="ext-header">
        <div class="ext-tags">
          ${(cfg.tags || []).map(t => `<span class="ext-tag">${t}</span>`).join('')}
        </div>
        <h1 class="ext-title">${cfg.title}</h1>
        <p class="ext-sub">${cfg.sub || ''}</p>
      </header>

      <div class="ext-actions">
        <a class="btn btn-primary" href="${zipUrl}" target="_blank" rel="noopener">
          ⬇ ZIP 다운로드
        </a>
        <a class="btn btn-secondary" href="${githubFolderUrl}" target="_blank" rel="noopener">
          GitHub에서 보기 →
        </a>
      </div>

      <hr class="divider" />

      <article class="readme" id="readme">
        <p class="loading">README 불러오는 중...</p>
      </article>
    </main>

    <button id="theme-toggle" aria-label="다크모드 전환">
      <span id="theme-icon">🌙</span> <span id="theme-label">다크</span>
    </button>
  `;

  // README 로드
  fetch('README.md?t=' + Date.now())
    .then(res => {
      if (!res.ok) throw new Error('README.md 없음 (' + res.status + ')');
      return res.text();
    })
    .then(md => {
      marked.setOptions({ gfm: true, breaks: false });
      document.getElementById('readme').innerHTML = marked.parse(md);
    })
    .catch(err => {
      document.getElementById('readme').innerHTML =
        `<div class="error">README 로드 실패: ${err.message}</div>`;
    });

  // 다크모드
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    const icon = document.getElementById('theme-icon');
    const label = document.getElementById('theme-label');
    if (icon && label) {
      icon.textContent = theme === 'dark' ? '☀' : '🌙';
      label.textContent = theme === 'dark' ? '라이트' : '다크';
    }
  }
  applyTheme(localStorage.getItem('theme') || 'light');
  document.getElementById('theme-toggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    applyTheme(next);
    localStorage.setItem('theme', next);
  });
})();
