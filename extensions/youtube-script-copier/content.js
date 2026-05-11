// YouTube Script Copy - Content Script (ISOLATED world)
// Primary: InnerTube API (like Glasp), Fallback: transcript panel DOM scraping
(() => {
  'use strict';

  const BUTTON_ID = 'yt-script-copy-btn';
  const PARA_MIN_CHARS = 300;   // 이 글자수 이상 + 문장종결 → 문단 분리
  const PARA_MAX_CHARS = 800;   // 이 글자수 초과 시 강제 분리
  const PARA_TIME_GAP  = 10.0;  // 10초 이상 침묵 → 주제 전환으로 간주, 강제 분리
  const LOG = (...args) => console.log('[YT Script Copy]', ...args);

  // ─── Utilities ───────────────────────────────────────────────

  function waitForElement(selector, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);
      const observer = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) { observer.disconnect(); resolve(el); }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { observer.disconnect(); reject(new Error(`timeout: ${selector}`)); }, timeout);
    });
  }

  function formatDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function formatTimestamp(totalSeconds) {
    const m = Math.floor(totalSeconds / 60);
    const s = Math.floor(totalSeconds % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function parseTimestamp(str) {
    const parts = str.trim().split(':').map(Number);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return 0;
  }

  function decodeHTMLEntities(text) {
    return text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n/g, ' ').trim();
  }

  async function copyToClipboard(text) {
    window.focus();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
  }

  // ─── Metadata (from DOM) ────────────────────────────────────

  function extractMetadata() {
    const videoId = new URLSearchParams(location.search).get('v') || '';
    const title =
      document.querySelector('h1.ytd-watch-metadata yt-formatted-string')?.textContent?.trim() ||
      document.title.replace(' - YouTube', '').trim() || '제목 없음';
    const channel =
      document.querySelector('#channel-name yt-formatted-string a')?.textContent?.trim() ||
      document.querySelector('#channel-name yt-formatted-string')?.textContent?.trim() || '채널명 없음';
    const durationEl = document.querySelector('.ytp-time-duration');
    const lengthSeconds = durationEl ? parseTimestamp(durationEl.textContent) : 0;
    const dateEl = document.querySelector('#info-strings yt-formatted-string');

    return {
      title, channel, lengthSeconds, videoId,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      uploadDate: dateEl?.textContent?.trim() || '',
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // METHOD 1: InnerTube API (same approach as Glasp extension)
  // ═══════════════════════════════════════════════════════════════

  function extractTranscriptParams(html) {
    const parts = html.split('"getTranscriptEndpoint":');
    if (parts.length < 2) return '';
    try { return parts[1].split('"params":"')[1].split('"')[0] || ''; }
    catch { return ''; }
  }

  async function method1_API(videoId) {
    LOG('Method 1: InnerTube API 시도...');

    // Step 1: 현재 페이지 DOM에서 params 추출 시도 (네트워크 요청 없이 즉시)
    let params = '';
    try {
      const domHtml = document.documentElement.innerHTML;
      params = extractTranscriptParams(domHtml);
      if (params) LOG('  ✓ DOM에서 params 추출 (빠른 경로)');
    } catch (e) {
      LOG('  DOM 추출 실패:', e.message);
    }

    // Fallback: DOM에 없으면 페이지 HTML 재다운로드
    if (!params) {
      LOG('  DOM에 params 없음, 페이지 재다운로드...');
      const pageResp = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
        credentials: 'omit',
        headers: { 'DNT': '1', 'Upgrade-Insecure-Requests': '1', 'Cache-Control': 'no-cache', Cookie: '' },
        mode: 'cors',
        cache: 'no-store',
      });
      const pageHtml = await pageResp.text();
      LOG('  페이지 HTML 길이:', pageHtml.length);
      params = extractTranscriptParams(pageHtml);
    }

    if (!params) throw new Error('자막 파라미터 없음');
    LOG('  params 추출 완료, 길이:', params.length);

    // Step 2: Call get_transcript (default credentials = same-origin = includes cookies)
    const dates = Array.from({ length: 30 }, (_, i) => {
      const d = new Date(); d.setDate(d.getDate() - i);
      return d.toISOString().split('T')[0].replace(/-/g, '');
    });
    const version = `2.${dates[Math.floor(Math.random() * dates.length)]}.00.00`;

    const resp = await fetch('https://www.youtube.com/youtubei/v1/get_transcript?prettyPrint=false', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        context: { client: { clientName: 'WEB', clientVersion: version } },
        params,
      }),
    });
    LOG('  API 응답 status:', resp.status);

    const text = await resp.text();
    if (!text) throw new Error('빈 응답');

    const data = JSON.parse(text);
    if (data.error) throw new Error(`API ${data.error.code}: ${data.error.message}`);

    const panel = data?.actions?.[0]?.updateEngagementPanelAction?.content
      ?.transcriptRenderer?.content?.transcriptSearchPanelRenderer;
    if (!panel) throw new Error('응답에 트랜스크립트 없음');

    const segments = (panel?.body?.transcriptSegmentListRenderer?.initialSegments || [])
      .map(seg => {
        const r = seg?.transcriptSegmentRenderer;
        if (!r?.startMs || !r?.snippet?.runs?.[0]?.text) return null;
        return {
          start: Number(r.startMs) / 1000,
          text: decodeHTMLEntities(r.snippet.runs[0].text),
        };
      })
      .filter(Boolean);

    if (segments.length === 0) throw new Error('세그먼트 0개');
    LOG('  성공! 세그먼트:', segments.length);
    return segments;
  }

  // ═══════════════════════════════════════════════════════════════
  // METHOD 2: Transcript Panel DOM Scraping (fallback)
  // ═══════════════════════════════════════════════════════════════

  async function method2_PanelScrape() {
    LOG('Method 2: 패널 스크래핑 시도...');

    // Open transcript panel
    const expandBtn = document.querySelector('tp-yt-paper-button#expand');
    if (expandBtn) { expandBtn.click(); await new Promise(r => setTimeout(r, 500)); }

    const btnSelectors = [
      'ytd-video-description-transcript-section-renderer button',
      'button[aria-label*="스크립트"]',
      'button[aria-label*="transcript" i]',
    ];
    let clicked = false;
    for (const sel of btnSelectors) {
      const btn = document.querySelector(sel);
      if (btn) { btn.click(); clicked = true; LOG('  버튼 클릭:', sel); break; }
    }
    if (!clicked) throw new Error('스크립트 버튼 없음');

    // Wait for segments to appear (poll instead of checking panel visibility)
    LOG('  세그먼트 대기 중...');
    let segments = [];
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500));
      segments = scrapeAllSegments();
      if (segments.length > 0) break;
    }

    if (segments.length === 0) throw new Error('세그먼트를 찾을 수 없음');

    // Scroll to load all segments
    const panel = findAnyTranscriptPanel();
    if (panel) {
      const scrollable = panel.querySelector('#content');
      if (scrollable) {
        let prevCount = 0, stable = 0;
        for (let i = 0; i < 60; i++) {
          scrollable.scrollTop = scrollable.scrollHeight;
          await new Promise(r => setTimeout(r, 250));
          const count = scrapeAllSegments().length;
          if (count === prevCount) { stable++; if (stable >= 3) break; }
          else stable = 0;
          prevCount = count;
        }
        scrollable.scrollTop = 0;
        await new Promise(r => setTimeout(r, 200));
      }
    }

    segments = scrapeAllSegments();
    LOG('  성공! 세그먼트:', segments.length);

    // Close panel
    if (panel) {
      const closeBtn = panel.querySelector('#visibility-button button') ||
        panel.querySelector('button[aria-label="닫기"]') ||
        panel.querySelector('button[aria-label="Close"]');
      if (closeBtn) closeBtn.click();
    }

    return segments;
  }

  function findAnyTranscriptPanel() {
    const panels = document.querySelectorAll('ytd-engagement-panel-section-list-renderer');
    for (const p of panels) {
      const tid = p.getAttribute('target-id') || '';
      if (tid.includes('transcript') || tid.includes('Transcript') || tid === 'PAmodern_transcript_view') {
        return p;
      }
    }
    return null;
  }

  function scrapeAllSegments() {
    // Modern: transcript-segment-view-model (anywhere in document)
    const modernSegs = document.querySelectorAll('transcript-segment-view-model');
    if (modernSegs.length > 0) {
      const segments = [];
      for (const seg of modernSegs) {
        const divs = seg.querySelectorAll('div');
        const span = seg.querySelector('span');
        const ts = divs[0]?.textContent?.trim() || '';
        const text = span?.textContent?.trim() || '';
        if (ts && text) segments.push({ start: parseTimestamp(ts), text });
      }
      return segments;
    }

    // Legacy: ytd-transcript-segment-renderer
    const legacySegs = document.querySelectorAll('ytd-transcript-segment-renderer');
    if (legacySegs.length > 0) {
      const segments = [];
      for (const seg of legacySegs) {
        const ts = seg.querySelector('.segment-timestamp')?.textContent?.trim() || '';
        const text = seg.querySelector('.segment-text')?.textContent?.trim() || '';
        if (ts && text) segments.push({ start: parseTimestamp(ts), text });
      }
      return segments;
    }

    return [];
  }

  // ─── Paragraph Grouping ─────────────────────────────────────

  function groupIntoParagraphs(segments) {
    if (!segments.length) return [];
    const paragraphs = [];
    let current = { startTime: segments[0].start, texts: [] };

    for (let i = 0; i < segments.length; i++) {
      current.texts.push(segments[i].text);
      const accumulated = current.texts.join(' ');
      const charLen = accumulated.length;

      if (i < segments.length - 1) {
        const gap = segments[i + 1].start - segments[i].start;
        const trimmed = segments[i].text.trim();
        // 한국어 종결어미(다, 요, 죠, 니다 등) 또는 일반 구두점
        const endsSentence = /[.!?。！？]$/.test(trimmed) ||
          /(?:다|요|죠|니다|까요|세요|네요|습니다|됩니다|합니다|입니다|었다|였다|겠다|한다|인다|된다|나요|던가|는데|거든|잖아|구나|더라|니까|래요|네|거야|는걸|지요)$/.test(trimmed);

        const shouldBreak =
          gap >= PARA_TIME_GAP ||                              // 긴 침묵 → 강제
          charLen >= PARA_MAX_CHARS ||                         // 최대 글자수 초과 → 강제
          (charLen >= PARA_MIN_CHARS && endsSentence);         // 최소 글자수 이상 + 문장 종결

        if (shouldBreak) {
          paragraphs.push({ timestamp: formatTimestamp(current.startTime), text: accumulated });
          current = { startTime: segments[i + 1].start, texts: [] };
        }
      }
    }
    if (current.texts.length) {
      paragraphs.push({ timestamp: formatTimestamp(current.startTime), text: current.texts.join(' ') });
    }
    return paragraphs;
  }

  // ─── Button Injection ───────────────────────────────────────

  function tryInjectButton() {
    if (document.getElementById(BUTTON_ID)) return;
    const container = document.querySelector('#flexible-item-buttons, #top-level-buttons-computed');
    if (!container) return;

    const wrapper = document.createElement('div');
    wrapper.id = BUTTON_ID;
    const button = document.createElement('button');
    button.setAttribute('aria-label', '스크립트 복사');
    button.title = '스크립트 복사';

    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', 'M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z');
    svg.appendChild(path);
    const span = document.createElement('span');
    span.textContent = '스크립트 복사';

    button.appendChild(svg);
    button.appendChild(span);
    button.addEventListener('click', handleCopyClick);
    wrapper.appendChild(button);
    container.prepend(wrapper);
  }

  // ─── Copy Handler ───────────────────────────────────────────

  async function handleCopyClick() {
    const button = document.querySelector(`#${BUTTON_ID} button`);
    const textEl = button.querySelector('span');
    const originalText = textEl.textContent;
    button.className = 'loading';
    textEl.textContent = '추출 중...';

    try {
      const meta = extractMetadata();

      // Try Method 1 (API), then Method 2 (panel scraping) as fallback
      let segments = null;
      let error1 = null;

      try {
        segments = await method1_API(meta.videoId);
      } catch (e) {
        error1 = e;
        LOG('Method 1 실패:', e.message);
      }

      if (!segments) {
        try {
          segments = await method2_PanelScrape();
        } catch (e) {
          LOG('Method 2 실패:', e.message);
          throw new Error(`API: ${error1?.message || '?'} / 패널: ${e.message}`);
        }
      }

      let transcriptSection;
      if (!segments || segments.length === 0) {
        transcriptSection = '(자막 없음)';
      } else {
        const paragraphs = groupIntoParagraphs(segments);
        transcriptSection = paragraphs.map(p => `[${p.timestamp}]\n${p.text}`).join('\n\n');
      }

      const lines = [`제목: ${meta.title}`, `채널: ${meta.channel}`, `길이: ${formatDuration(meta.lengthSeconds)}`];
      if (meta.uploadDate) lines.push(`업로드: ${meta.uploadDate}`);
      lines.push(`URL: ${meta.url}`, '', '--- 스크립트 ---', '', transcriptSection);

      await copyToClipboard(lines.join('\n'));
      button.className = 'success';
      textEl.textContent = '복사 완료!';
    } catch (error) {
      LOG('최종 오류:', error);
      button.className = 'error';
      textEl.textContent = '오류 발생';
    }

    setTimeout(() => { button.className = ''; textEl.textContent = originalText; }, 2500);
  }

  // ─── SPA Navigation ─────────────────────────────────────────

  function onNavigate() {
    if (location.pathname !== '/watch') return;
    waitForElement('#flexible-item-buttons, #top-level-buttons-computed')
      .then(() => tryInjectButton()).catch(() => {});
  }

  document.addEventListener('yt-navigate-start', () => { document.getElementById(BUTTON_ID)?.remove(); });
  document.addEventListener('yt-navigate-finish', onNavigate);
  if (location.pathname === '/watch') onNavigate();
})();
