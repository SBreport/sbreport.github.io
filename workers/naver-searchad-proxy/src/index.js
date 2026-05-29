// SBS 확장 + 차세대 키워드 분석 대시보드용 네이버 검색광고 API 프록시

// 정확 매칭 + 접두사 매칭 분리: prefix 매칭만 쓰면 도메인 위조에 취약함
// (예: https://sbreport.github.io.evil.com 이 startsWith로 통과되는 문제)
const ALLOWED_ORIGINS = [
  { type: 'exact', value: 'https://search.naver.com' },
  { type: 'exact', value: 'https://sbreport.github.io' },
  { type: 'exact', value: 'https://smartsupport.sbreport.workers.dev' },
  { type: 'prefix', value: 'chrome-extension://' },
  { type: 'prefix', value: 'http://localhost:' },
];

const GOOGLE_REDIRECT_URI = 'https://naver-searchad-proxy.sbreport.workers.dev/api/auth/google/callback';
const FRONTEND_CALLBACK_URL = 'https://smartsupport.sbreport.workers.dev/auth/callback';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

// data-block-id 값 → { type, label } 매핑
const BLOCK_ID_MAP = [
  { pattern: /^review\/.*blog/i,            type: 'blog',          label: '블로그' },
  // review/ugc.* — 블로그/카페 등 UGC 인기글 묶음. 네이버 화면 라벨은 업종별 동적
  // ("패션·미용 인기글", "맛집 인기글" 등) → 우리는 업종 무관 일반명 '인기글'로 표기.
  { pattern: /^review\/.*ugc/i,             type: 'popular',       label: '인기글' },
  { pattern: /^ai-briefing\//i,             type: 'ai_briefing',   label: 'AI 브리핑' },
  { pattern: /^image\//i,                   type: 'image',         label: '이미지' },
  { pattern: /^kin\//i,                     type: 'kin',           label: '지식인' },
  { pattern: /^web\//i,                     type: 'web',           label: '관련사이트' },
  { pattern: /^news\//i,                    type: 'news',          label: '뉴스' },
  { pattern: /^video\//i,                   type: 'video',         label: '동영상' },
  { pattern: /^clip\//i,                    type: 'clip',          label: '클립' },
  { pattern: /^shortents\//i,               type: 'shortents',     label: '숏텐츠' },
  { pattern: /^qra\//i,                     type: 'qra',           label: '함께 많이 찾는' },
  { pattern: /^ugc\/.*influencer/i,         type: 'influencer',    label: '인플루언서' },
  { pattern: /^ugc\/.*powercontents/i,      type: 'powercontents', label: '파워컨텐츠' },
  // 구체 패턴(influencer/powercontents)이 먼저 매칭되도록 위에. default는 일반 UGC 통합.
  { pattern: /^ugc\/.*popular_article/i,    type: 'popular_article', label: '인기글' },
  { pattern: /^ugc\/.*snippet/i,            type: 'ugc_snippet',   label: '스마트블록' },
  { pattern: /^ugc\/.*default/i,            type: 'ugc',           label: '스마트블록' },
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const corsHeaders = getCorsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return handleOptions(origin);
    }

    if (url.pathname === '/' || url.pathname === '/health') {
      return handleHealth(corsHeaders);
    }

    if (url.pathname === '/search-volume') {
      return handleSearchVolume(request, env, ctx, corsHeaders);
    }

    if (url.pathname === '/api/search' && request.method === 'POST') {
      return handleApiSearch(request, env, ctx, corsHeaders);
    }

    if (url.pathname === '/api/auth/google' && request.method === 'GET') {
      return handleAuthGoogle(request, env);
    }

    if (url.pathname === '/api/auth/google/callback' && request.method === 'GET') {
      return handleAuthGoogleCallback(request, env);
    }

    if (url.pathname === '/api/me' && request.method === 'GET') {
      return handleMe(request, env, corsHeaders);
    }

    if (url.pathname === '/api/history' && request.method === 'GET') {
      return handleApiHistory(request, env, corsHeaders);
    }

    if (url.pathname === '/api/version' && request.method === 'GET') {
      return handleVersion(request, env, corsHeaders);
    }

    if (url.pathname === '/api/expand' && request.method === 'POST') {
      return handleApiExpand(request, env, ctx, corsHeaders);
    }

    // --- 플레이스 리뷰 수집 Phase 1 라우팅 ---
    if (url.pathname === '/api/places' && request.method === 'POST') {
      return handleCreatePlace(request, env, corsHeaders);
    }
    if (url.pathname === '/api/places' && request.method === 'GET') {
      return handleListPlaces(request, env, corsHeaders);
    }
    const reviewsMatch = url.pathname.match(/^\/api\/places\/([^/]+)\/reviews$/);
    if (reviewsMatch && request.method === 'POST') {
      return handlePostReviews(request, env, corsHeaders, reviewsMatch[1]);
    }
    if (reviewsMatch && request.method === 'GET') {
      return handleGetReviews(request, env, corsHeaders, reviewsMatch[1]);
    }
    // POST /api/places/:id/collect — 증분 수집 수동 트리거 (측정용)
    const collectMatch = url.pathname.match(/^\/api\/places\/([^/]+)\/collect$/);
    if (collectMatch && request.method === 'POST') {
      return handleCollectPlace(request, env, corsHeaders, collectMatch[1]);
    }

    // --- 관리자 (role='admin' 전용) ---
    if (url.pathname === '/api/admin/users' && request.method === 'GET') {
      return handleAdminListUsers(request, env, corsHeaders);
    }
    const adminStatusMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/status$/);
    if (adminStatusMatch && request.method === 'POST') {
      return handleAdminSetStatus(request, env, corsHeaders, adminStatusMatch[1]);
    }

    return jsonResponse({ error: 'not found' }, 404, corsHeaders);
  },
};

// --- CORS ---

function getCorsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.some(({ type, value }) =>
    type === 'exact' ? origin === value : origin.startsWith(value)
  );
  if (!allowed) return null;

  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
}

function handleOptions(origin) {
  const corsHeaders = getCorsHeaders(origin);
  if (!corsHeaders) {
    return new Response('Forbidden', { status: 403 });
  }
  return new Response(null, { status: 204, headers: corsHeaders });
}

// --- 헬퍼 ---

function jsonResponse(data, status = 200, corsHeaders, extraHeaders = {}) {
  if (!corsHeaders) {
    return new Response('Forbidden', { status: 403 });
  }
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders,
      ...extraHeaders,
    },
  });
}

// --- 핸들러 ---

function handleHealth(corsHeaders) {
  return jsonResponse(
    { ok: true, service: 'naver-searchad-proxy', stage: 'v1' },
    200,
    corsHeaders
  );
}

async function handleSearchVolume(request, env, ctx, corsHeaders) {
  // 베타 종료 차단: secret BETA_ENDED=true 설정 시 모든 호출 410으로 차단하고 안내 URL 반환
  // 사용자가 정식 버전 출시 시점에 `wrangler secret put BETA_ENDED` true 로 즉시 적용
  if (env.BETA_ENDED === 'true' || env.BETA_ENDED === true) {
    return jsonResponse(
      {
        error: 'beta_ended',
        message: '베타 버전이 종료되었습니다.',
        redirect_url: env.BETA_REDIRECT_URL || '',
      },
      410,
      corsHeaders
    );
  }

  const url = new URL(request.url);
  const raw = url.searchParams.get('keywords');

  if (!raw) {
    return jsonResponse({ error: 'missing query parameter "keywords"' }, 400, corsHeaders);
  }

  // 네이버 keywordstool은 공백 포함 키워드를 거부 (code 11001).
  // 공백을 모두 제거해서 동일 의미의 변형들이 같은 캐시 키를 갖도록 정규화.
  const keywords = raw
    .split(',')
    .map((k) => k.replace(/\s+/g, ''))
    .filter(Boolean);

  if (keywords.length === 0) {
    return jsonResponse({ error: 'no valid keywords' }, 400, corsHeaders);
  }
  if (keywords.length > 5) {
    return jsonResponse({ error: 'too many keywords (max 5)' }, 400, corsHeaders);
  }

  // 캐시 키: 정렬 후 콤마 join (호출 순서 무관하게 동일 키 보장)
  const normalizedKey = [...keywords].sort().join(',');
  const cacheUrl = `https://cache.internal/v1/search-volume?keywords=${encodeURIComponent(normalizedKey)}`;
  const cache = caches.default;

  const cached = await cache.match(cacheUrl);
  if (cached) {
    const body = await cached.json();
    return jsonResponse(body, 200, corsHeaders, { 'X-Cache': 'HIT' });
  }

  try {
    const naverData = await fetchKeywordVolume(keywords, env);
    const result = normalizeResult(naverData);
    const payload = {
      keywords: result,
      meta: { fetched_at: new Date().toISOString() },
    };

    // 캐시 저장은 응답 후 비동기로 처리
    const cacheResponse = new Response(JSON.stringify(payload), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=86400',
      },
    });
    ctx.waitUntil(cache.put(cacheUrl, cacheResponse));

    return jsonResponse(payload, 200, corsHeaders, { 'X-Cache': 'MISS' });
  } catch (err) {
    if (err instanceof UpstreamError) {
      return jsonResponse(
        { error: 'upstream fetch failed', status: err.status, detail: err.detail },
        502,
        corsHeaders
      );
    }
    return jsonResponse({ error: 'internal error', detail: err.message }, 500, corsHeaders);
  }
}

// --- POST /api/search 핸들러 ---

async function handleApiSearch(request, env, ctx, corsHeaders) {
  // origin 미포함(직접 curl 등) 또는 화이트리스트 외부 차단
  if (!corsHeaders) {
    return new Response('Forbidden', { status: 403 });
  }

  // 승인된 사용자만 접근 가능 — 핵심 보안 게이트
  const authResult = await requireApprovedUser(request, env);
  if (authResult.error) {
    return jsonResponse(
      { error: authResult.error, message: authResult.message },
      authResult.status,
      corsHeaders
    );
  }

  // 입력 파싱
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'invalid_json', message: 'Request body must be valid JSON' }, 400, corsHeaders);
  }

  const rawKeyword = body?.keyword;
  if (!rawKeyword || typeof rawKeyword !== 'string' || rawKeyword.trim() === '') {
    return jsonResponse(
      { error: 'missing_keyword', message: '"keyword" 필드가 필요합니다' },
      400,
      corsHeaders
    );
  }

  // 검색량 API용 공백 제거 정규화 (캐시 키에도 사용)
  const normalizedKeyword = rawKeyword.trim().replace(/\s+/g, '');

  // 캐시 확인 (24h TTL)
  const cacheUrl = `https://cache.internal/v8/api-search?keyword=${encodeURIComponent(normalizedKeyword)}`;
  const cache = caches.default;

  const cached = await cache.match(cacheUrl);
  if (cached) {
    const cachedBody = await cached.json();
    const history_id = crypto.randomUUID();
    ctx.waitUntil(insertSearchHistory(env, {
      id: history_id,
      user_id: authResult.user.id,
      keyword: rawKeyword.trim(),
      pc_volume: cachedBody.pc_volume,
      mobile_volume: cachedBody.mobile_volume,
      competition: cachedBody.competition,
      sections_json: JSON.stringify(cachedBody.sections),
    }));
    return jsonResponse({ ...cachedBody, history_id }, 200, corsHeaders, { 'X-Cache': 'HIT' });
  }

  // 검색광고 API + m.search(모바일) + search(PC) 병렬 호출
  const [adResult, mobileResult, pcResult] = await Promise.allSettled([
    fetchKeywordVolume([normalizedKeyword], env),
    fetchNaverSearch(rawKeyword.trim()),
    fetchNaverSearchPc(rawKeyword.trim()),
  ]);

  // 검색광고 API 실패 → 502
  if (adResult.status === 'rejected') {
    const err = adResult.reason;
    if (err instanceof UpstreamError) {
      return jsonResponse(
        { error: 'upstream_failed', message: '네이버 검색광고 API 오류', status: err.status, detail: err.detail },
        502,
        corsHeaders
      );
    }
    return jsonResponse({ error: 'internal_error', message: err.message }, 500, corsHeaders);
  }

  // 검색광고 결과 정규화
  const adNormalized = normalizeResult(adResult.value);
  const adKeyword = adNormalized.find(
    (k) => k.keyword === normalizedKeyword
  ) || adNormalized[0] || { keyword: normalizedKeyword, pc: 0, mobile: 0, total: 0, competition: null };

  // m.search 실패 → 구좌 빈 배열로 grace degrade
  let sections = [];
  let pcSections = [];
  let relatedKeywords = [];

  if (mobileResult.status === 'fulfilled') {
    sections = mobileResult.value.sections;
  }
  if (pcResult.status === 'fulfilled') {
    pcSections = pcResult.value.sections;
  }

  // 연관 검색어: adNormalized에서 입력 키워드 외의 항목들
  relatedKeywords = adNormalized
    .filter((k) => k.keyword !== normalizedKeyword)
    .map((k) => ({ keyword: k.keyword, total: k.total }));

  const payload = {
    keyword: rawKeyword.trim(),
    pc_volume: adKeyword.pc,
    mobile_volume: adKeyword.mobile,
    total: adKeyword.total,
    competition: mapCompetition(adKeyword.competition),
    related_keywords: relatedKeywords,
    sections,
    pc_sections: pcSections,
    fetched_at: new Date().toISOString(),
  };

  // 캐시 저장 (history_id 제외한 payload 저장)
  const cacheResponse = new Response(JSON.stringify(payload), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    },
  });
  ctx.waitUntil(cache.put(cacheUrl, cacheResponse));

  const history_id = crypto.randomUUID();
  ctx.waitUntil(insertSearchHistory(env, {
    id: history_id,
    user_id: authResult.user.id,
    keyword: rawKeyword.trim(),
    pc_volume: payload.pc_volume,
    mobile_volume: payload.mobile_volume,
    competition: payload.competition,
    sections_json: JSON.stringify(sections),
  }));

  return jsonResponse({ ...payload, history_id }, 200, corsHeaders, { 'X-Cache': 'MISS' });
}

// --- m.search.naver.com fetch + 구좌 파싱 ---

async function fetchNaverSearch(keyword) {
  const encodedKeyword = encodeURIComponent(keyword);
  const url = `https://m.search.naver.com/search.naver?query=${encodedKeyword}`;

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });

  if (!res.ok) {
    throw new UpstreamError(res.status, `m.search fetch failed: ${res.status}`);
  }

  const html = await res.text();
  const sections = parseNaverSections(html);
  return { sections };
}

async function fetchNaverSearchPc(keyword) {
  const encodedKeyword = encodeURIComponent(keyword);
  const url = `https://search.naver.com/search.naver?query=${encodedKeyword}`;

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });

  if (!res.ok) {
    throw new UpstreamError(res.status, `search(pc) fetch failed: ${res.status}`);
  }

  const html = await res.text();
  const sections = parseNaverSections(html, 'pc');
  return { sections };
}

function parseNaverSections(html, device = 'mobile') {
  // 모든 구좌를 HTML 내 등장 위치(byte offset)로 모은 뒤 한 번에 정렬한다.
  // (과거 버그: 파워링크→block-id→플레이스를 단계별로 push해서, data-block-id가 없는
  //  플레이스(place-app-root)가 실제 위치와 무관하게 항상 맨 끝으로 밀렸다.
  //  실제 SERP에선 플레이스가 상단(파워링크 다음)에 오는 경우가 많아 순서가 어긋났음.)
  const candidates = []; // { offset, type, label, count }
  const seen = new Set(); // 중복 type 방지 (같은 구좌가 여러 번 등장 시 첫 위치만)

  // 1) 파워링크 광고 — 컨테이너(id=power_link_body)의 위치 + 광고 카드 수.
  //    모바일은 카드마다 data-sv-log="pwl", PC는 lst js-hover-item (마커가 다름).
  //    주의: 첫 fetch 시점 노출 광고만 잡히므로 PC/모바일 광고 수는 다를 수 있다.
  const powerlinkOffset = html.indexOf('id="power_link_body"');
  if (powerlinkOffset !== -1 || html.includes('power_link')) {
    const adCardCount = device === 'pc'
      ? countPcPowerlinkCards(html)
      : countOccurrences(html, 'data-sv-log="pwl"');
    if (adCardCount > 0) {
      // power_link_body가 없고 'power_link'만 있으면 0 위치로(최상단 취급)
      candidates.push({ offset: powerlinkOffset === -1 ? 0 : powerlinkOffset, type: 'powerlink', label: '파워링크', count: adCardCount });
      seen.add('powerlink');
    }
  }

  // 2) data-block-id 구좌 — 첫 등장 위치 기준
  const blockIdRegex = /data-block-id="([^"]+)"/g;
  let match;
  while ((match = blockIdRegex.exec(html)) !== null) {
    const blockId = match[1];
    const mapped = resolveBlockId(blockId);
    const type = mapped.type;

    if (seen.has(type)) continue; // 이미 처리한 구좌는 스킵 (첫 위치 보존)
    seen.add(type);

    const count = countOccurrences(html, `data-block-id="${blockId}"`);
    candidates.push({ offset: match.index, type, label: mapped.label, count });
  }

  // 3) place-app-root (플레이스) — data-block-id에 안 잡히므로 별도 수집(첫 등장 위치)
  if (!seen.has('place')) {
    const placeOffset = html.indexOf('place-app-root');
    if (placeOffset !== -1) {
      const placeCount = countOccurrences(html, 'place-app-root');
      candidates.push({ offset: placeOffset, type: 'place', label: '플레이스', count: placeCount });
      seen.add('place');
    }
  }

  // 4) 등장 위치 순으로 정렬 후 order 부여
  candidates.sort((a, b) => a.offset - b.offset);
  return candidates.map((c, i) => ({ order: i + 1, type: c.type, label: c.label, count: c.count }));
}

function resolveBlockId(blockId) {
  for (const { pattern, type, label } of BLOCK_ID_MAP) {
    if (pattern.test(blockId)) {
      return { type, label };
    }
  }
  // 미매칭 block-id 모니터링 — Cloudflare Workers Logs(Tail)에서 "[UNMAPPED_BLOCK_ID]" 검색해 발견된 신규 패턴 보강
  console.log(`[UNMAPPED_BLOCK_ID] ${blockId}`);
  return { type: blockId, label: blockId };
}

function countOccurrences(str, sub) {
  let count = 0;
  let pos = 0;
  while ((pos = str.indexOf(sub, pos)) !== -1) {
    count++;
    pos += sub.length;
  }
  return count;
}

// PC SERP 파워링크 카드 수: power_link_body 컨테이너부터 첫 구좌(data-block-id) 전까지 구간에서
// 광고 카드(li.lst.js-hover-item) 등장 횟수를 센다. PC는 모바일의 data-sv-log="pwl" 마커가 없다.
function countPcPowerlinkCards(html) {
  const start = html.indexOf('id="power_link_body"');
  if (start === -1) return 0;
  const blockIdPos = html.indexOf('data-block-id=', start);
  const end = blockIdPos === -1 ? html.length : blockIdPos;
  return countOccurrences(html.slice(start, end), 'lst js-hover-item');
}

// --- 경쟁도 한국어 변환 ---

function mapCompetition(raw) {
  if (!raw) return null;
  const map = { high: '높음', medium: '중간', low: '낮음' };
  return map[raw.toLowerCase()] ?? raw;
}

// --- 네이버 API ---

class UpstreamError extends Error {
  constructor(status, detail) {
    super(`upstream ${status}`);
    this.status = status;
    this.detail = detail;
  }
}

async function fetchKeywordVolume(keywords, env) {
  const timestamp = Date.now().toString();
  const method = 'GET';
  // 시그니처 path는 쿼리스트링 제외
  const apiPath = '/keywordstool';
  const signature = await makeSignature(timestamp, method, apiPath, env.NAVER_SECRET_KEY);

  const qs = new URLSearchParams({
    hintKeywords: keywords.join(','),
    showDetail: '1',
  });
  const apiUrl = `https://api.searchad.naver.com${apiPath}?${qs}`;

  const res = await fetch(apiUrl, {
    method: 'GET',
    headers: {
      'X-Timestamp': timestamp,
      'X-API-KEY': env.NAVER_API_KEY,
      'X-Customer': env.NAVER_CUSTOMER_ID,
      'X-Signature': signature,
      'Content-Type': 'application/json; charset=UTF-8',
    },
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new UpstreamError(res.status, detail);
  }

  return res.json();
}

function normalizeResult(naverData) {
  const list = naverData?.keywordList ?? [];
  return list.map((item) => {
    // 검색량이 적으면 네이버가 "< 10" 같은 문자열로 반환하므로 타입 체크 필수
    const pc = typeof item.monthlyPcQcCnt === 'number' ? item.monthlyPcQcCnt : 0;
    const mobile = typeof item.monthlyMobileQcCnt === 'number' ? item.monthlyMobileQcCnt : 0;
    return {
      keyword: item.relKeyword,
      pc,
      mobile,
      total: pc + mobile,
      competition: item.compIdx || null,
    };
  });
}

// --- Google OAuth 핸들러 ---

// GET /api/auth/google
// 인증 없음. 브라우저 직접 navigate → CORS 불필요. 302 redirect만 반환.
function handleAuthGoogle(request, env) {
  const state = crypto.randomUUID(); // MVP: 생성만, 검증은 추후 (stateless Worker에서 검증하려면 KV 필요)

  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'online',
    prompt: 'select_account',
    state,
  });

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  return Response.redirect(authUrl, 302);
}

// GET /api/auth/google/callback?code=...
// 브라우저 redirect 수신 → 구글 토큰 교환 → D1 users INSERT/UPDATE → JWT 발급 → 프론트 fragment redirect
async function handleAuthGoogleCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error || !code) {
    // 사용자가 취소하거나 오류 발생 — 로그인 페이지로 돌려보냄
    return Response.redirect(`${FRONTEND_CALLBACK_URL}#error=${encodeURIComponent(error || 'no_code')}`, 302);
  }

  // 1) 구글 토큰 교환
  let tokenRes;
  try {
    tokenRes = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI,
      }),
    });
  } catch (err) {
    return Response.redirect(`${FRONTEND_CALLBACK_URL}#error=token_exchange_failed`, 302);
  }

  if (!tokenRes.ok) {
    return Response.redirect(`${FRONTEND_CALLBACK_URL}#error=token_exchange_failed`, 302);
  }

  const tokenData = await tokenRes.json();
  const idToken = tokenData.id_token;
  if (!idToken) {
    return Response.redirect(`${FRONTEND_CALLBACK_URL}#error=no_id_token`, 302);
  }

  // 2) id_token 기본 검증 (MVP: iss, aud, exp만 확인. JWKS 서명 검증은 추후)
  let googlePayload;
  try {
    googlePayload = decodeJwtPayload(idToken);
  } catch {
    return Response.redirect(`${FRONTEND_CALLBACK_URL}#error=invalid_id_token`, 302);
  }

  const now = Math.floor(Date.now() / 1000);
  if (
    !googlePayload.sub ||
    googlePayload.exp < now ||
    (googlePayload.aud !== env.GOOGLE_CLIENT_ID) ||
    (!googlePayload.iss.startsWith('https://accounts.google.com'))
  ) {
    return Response.redirect(`${FRONTEND_CALLBACK_URL}#error=id_token_invalid`, 302);
  }

  // 3) D1 users 테이블 INSERT/UPDATE
  const { sub, email, name, picture } = googlePayload;
  const nowIso = new Date().toISOString();

  try {
    const existing = await env.DB.prepare(
      'SELECT id, status FROM users WHERE google_sub = ?'
    ).bind(sub).first();

    if (existing) {
      // 기존 사용자: last_login_at + 프로필 정보 갱신
      await env.DB.prepare(
        'UPDATE users SET last_login_at = ?, email = ?, name = ?, picture = ? WHERE google_sub = ?'
      ).bind(nowIso, email, name, picture, sub).run();
    } else {
      // 신규 사용자: pending 상태로 등록
      const uuid = crypto.randomUUID();
      await env.DB.prepare(
        "INSERT INTO users (id, google_sub, email, name, picture, status, plan, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, 'pending', 'free', ?, ?)"
      ).bind(uuid, sub, email, name, picture, nowIso, nowIso).run();
    }
  } catch (err) {
    // D1 오류 시 콜백 실패로 처리 (JWT 없이 redirect)
    return Response.redirect(`${FRONTEND_CALLBACK_URL}#error=db_error`, 302);
  }

  // 4) JWT 발급 — status와 무관하게 항상 발급 (승인 대기 화면에서도 로그인 상태 유지)
  // status는 JWT에 포함하지 않음 — 승인 변경 시 즉시 반영을 위해 매 요청마다 D1 조회
  const jwt = await issueJwt({ sub, email, name, picture }, env.JWT_SECRET);

  return Response.redirect(`${FRONTEND_CALLBACK_URL}#token=${jwt}`, 302);
}

// GET /api/me
// Authorization: Bearer <JWT> → D1에서 사용자 정보 조회 후 반환 (status, plan, role 포함)
async function handleMe(request, env, corsHeaders) {
  // OPTIONS preflight는 fetch 핸들러 상단에서 처리됨
  if (!corsHeaders) {
    return new Response('Forbidden', { status: 403 });
  }

  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return jsonResponse({ error: 'unauthorized', message: '토큰이 없습니다' }, 401, corsHeaders);
  }

  let payload;
  try {
    payload = await verifyJwt(token, env.JWT_SECRET);
  } catch (err) {
    return jsonResponse({ error: 'unauthorized', message: err.message }, 401, corsHeaders);
  }

  // JWT payload.sub(= google_sub)로 D1에서 최신 상태 조회
  let user;
  try {
    user = await getUserFromDB(env, payload.sub);
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: 'DB 조회 실패' }, 500, corsHeaders);
  }

  if (!user) {
    // DB에 사용자 없음 — 이상 케이스 (콜백 전 JWT 사용 등)
    return jsonResponse({ error: 'user_not_found', message: '사용자 정보를 찾을 수 없습니다' }, 401, corsHeaders);
  }

  return jsonResponse({
    id: user.id,
    sub: user.google_sub,
    email: user.email,
    name: user.name,
    picture: user.picture,
    status: user.status,
    plan: user.plan,
    plan_expires_at: user.plan_expires_at,
    role: user.role,
  }, 200, corsHeaders);
}

// --- D1 사용자 헬퍼 ---

// D1에서 사용자 조회 + role 결정 (admin: ADMIN_EMAILS 기반, user: 기본)
async function getUserFromDB(env, googleSub) {
  const row = await env.DB.prepare(
    'SELECT id, google_sub, email, name, picture, status, plan, plan_expires_at FROM users WHERE google_sub = ?'
  ).bind(googleSub).first();

  if (!row) return null;

  // role 결정: ADMIN_EMAILS 환경변수 없으면 admin 0명 (안전 fallback)
  const adminEmails = (env.ADMIN_EMAILS || '').split(',').map(s => s.trim()).filter(Boolean);
  row.role = adminEmails.includes(row.email) ? 'admin' : 'user';

  return row;
}

// JWT 검증 + D1 조회 + status='approved' 확인 헬퍼
// 통과 시: { user }  /  실패 시: { error, status, message? }
async function requireApprovedUser(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;

  if (!token) {
    return { error: 'unauthorized', status: 401, message: '인증 토큰이 없습니다' };
  }

  let payload;
  try {
    payload = await verifyJwt(token, env.JWT_SECRET);
  } catch {
    return { error: 'invalid_token', status: 401, message: '유효하지 않은 토큰입니다' };
  }

  let user;
  try {
    user = await getUserFromDB(env, payload.sub);
  } catch {
    return { error: 'db_error', status: 500, message: 'DB 조회 중 오류가 발생했습니다' };
  }

  if (!user) {
    return { error: 'user_not_found', status: 401, message: '사용자 정보를 찾을 수 없습니다' };
  }

  if (user.status === 'pending') {
    return { error: 'pending_approval', status: 403, message: '관리자 승인 대기 중입니다' };
  }

  if (user.status === 'suspended') {
    return { error: 'suspended', status: 403, message: '계정이 정지되었습니다' };
  }

  if (user.status !== 'approved') {
    return { error: 'forbidden', status: 403, message: '접근 권한이 없습니다' };
  }

  return { user };
}

// --- GET /api/history 핸들러 ---

async function handleApiHistory(request, env, corsHeaders) {
  if (!corsHeaders) {
    return new Response('Forbidden', { status: 403 });
  }

  const authResult = await requireApprovedUser(request, env);
  if (authResult.error) {
    return jsonResponse(
      { error: authResult.error, message: authResult.message },
      authResult.status,
      corsHeaders
    );
  }

  const url = new URL(request.url);
  const rawLimit = url.searchParams.get('limit');
  let limit = 5;
  if (rawLimit !== null) {
    const parsed = parseInt(rawLimit, 10);
    if (!Number.isInteger(parsed) || isNaN(parsed) || parsed <= 0) {
      return jsonResponse({ error: 'invalid_param', message: 'limit은 1 이상의 정수여야 합니다' }, 400, corsHeaders);
    }
    limit = Math.min(parsed, 50);
  }

  try {
    const { results } = await env.DB.prepare(
      'SELECT id, keyword, pc_volume, mobile_volume, competition, created_at FROM (SELECT id, keyword, pc_volume, mobile_volume, competition, created_at, ROW_NUMBER() OVER (PARTITION BY keyword ORDER BY created_at DESC) AS rn FROM search_history WHERE user_id = ?) WHERE rn = 1 ORDER BY created_at DESC LIMIT ?'
    ).bind(authResult.user.id, limit).all();

    return jsonResponse({ history: results ?? [] }, 200, corsHeaders);
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, corsHeaders);
  }
}

// --- GET /api/version 핸들러 ---

function handleVersion(request, env, corsHeaders) {
  if (!corsHeaders) {
    return new Response('Forbidden', { status: 403 });
  }

  return jsonResponse({
    id: env.CF_VERSION_METADATA?.id ?? null,
    tag: env.CF_VERSION_METADATA?.tag ?? null,
    timestamp: env.CF_VERSION_METADATA?.timestamp ?? null,
  }, 200, corsHeaders);
}

// --- POST /api/expand 핸들러 ---

async function handleApiExpand(request, env, ctx, corsHeaders) {
  if (!corsHeaders) {
    return new Response('Forbidden', { status: 403 });
  }

  const authResult = await requireApprovedUser(request, env);
  if (authResult.error) {
    return jsonResponse(
      { error: authResult.error, message: authResult.message },
      authResult.status,
      corsHeaders
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'invalid_json', message: 'Request body must be valid JSON' }, 400, corsHeaders);
  }

  const { keyword, autocomplete, related } = body ?? {};

  if (!keyword || typeof keyword !== 'string' || keyword.trim() === '') {
    return jsonResponse({ error: 'missing_keyword', message: '"keyword" 필드가 필요합니다' }, 400, corsHeaders);
  }

  if (!autocomplete && !related) {
    return jsonResponse({ error: 'no_option_selected', message: 'autocomplete 또는 related 중 하나 이상을 true로 설정해야 합니다' }, 400, corsHeaders);
  }

  const [autocompleteSettled, relatedSettled] = await Promise.allSettled([
    autocomplete ? fetchNaverAutocomplete(keyword) : Promise.resolve([]),
    related ? fetchRelatedKeywords(keyword, env) : Promise.resolve([]),
  ]);

  const autocompleteList = autocompleteSettled.status === 'fulfilled' ? autocompleteSettled.value : [];
  const relatedList = relatedSettled.status === 'fulfilled' ? relatedSettled.value : [];

  const seen = new Set();
  const keywords = [];

  for (const kw of autocompleteList) {
    if (!seen.has(kw)) {
      seen.add(kw);
      keywords.push({ keyword: kw, source: 'autocomplete' });
    }
  }

  for (const kw of relatedList) {
    if (!seen.has(kw)) {
      seen.add(kw);
      keywords.push({ keyword: kw, source: 'related' });
    }
  }

  return jsonResponse({ seed: keyword, keywords }, 200, corsHeaders);
}

async function fetchNaverAutocomplete(keyword) {
  try {
    const url = `https://ac.search.naver.com/nx/ac?q=${encodeURIComponent(keyword)}&con=0&frm=nv&ans=2&r_format=json&r_enc=UTF-8&r_unicode=0&t_koreng=1&run=2&rev=4&q_enc=UTF-8&st=100`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
        'Referer': 'https://m.search.naver.com/',
      },
    });
    if (!res.ok) return [];

    const data = await res.json();
    const items = data?.items?.[0] ?? [];
    return items
      .map(it => Array.isArray(it) ? it[0] : it)
      .filter(s => typeof s === 'string' && s.trim() && s.trim() !== keyword.trim())
      .slice(0, 5);
  } catch {
    return [];
  }
}

async function fetchRelatedKeywords(keyword, env) {
  try {
    const data = await fetchKeywordVolume([keyword], env);
    const list = data?.keywordList ?? [];
    const normalized = keyword.trim().replace(/\s+/g, '');
    return list
      .map(item => item.relKeyword)
      .filter(kw => typeof kw === 'string' && kw && kw !== normalized)
      .slice(0, 10);
  } catch {
    return [];
  }
}

// --- search_history INSERT 헬퍼 ---

async function insertSearchHistory(env, { id, user_id, keyword, pc_volume, mobile_volume, competition, sections_json }) {
  try {
    await env.DB.prepare(
      'INSERT INTO search_history (id, user_id, keyword, pc_volume, mobile_volume, competition, sections_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(id, user_id, keyword, pc_volume ?? null, mobile_volume ?? null, competition ?? null, sections_json, new Date().toISOString()).run();
  } catch (err) {
    console.error('search_history INSERT failed:', err.message);
  }
}

// --- 플레이스 URL에서 placeId/businessType 추출 유틸 ---

/**
 * 네이버 플레이스 URL에서 placeId와 businessType을 추출한다.
 * naver.me 단축 URL 해석은 Phase 1 범위 밖 — 호출자가 풀 URL을 제공한다는 전제.
 * @param {string} rawUrl
 * @returns {{ placeId: string, businessType: string|null } | null}
 */
function extractPlaceInfo(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const u = rawUrl.trim();

  // 패턴 1: map.naver.com/p/entry/place/{id}
  let m = u.match(/\/entry\/place\/(\d+)/);
  if (m) return { placeId: m[1], businessType: 'place' };

  // 패턴 2: place.naver.com / pcmap.place.naver.com / m.place.naver.com 의 /{업종}/{id}
  m = u.match(/(?:place\.naver\.com|pcmap\.place\.naver\.com|m\.place\.naver\.com)\/([a-z]+)\/(\d+)/i);
  if (m) return { placeId: m[2], businessType: m[1].toLowerCase() };

  // 패턴 3: 일반 /{세그먼트}/{5자리 이상 숫자}
  m = u.match(/\/([a-z]+)\/(\d{5,})/i);
  if (m) return { placeId: m[2], businessType: m[1].toLowerCase() };

  // 패턴 4 (폴백): URL에서 6자리 이상 순수 숫자
  m = u.match(/(\d{6,})/);
  if (m) return { placeId: m[1], businessType: null };

  return null;
}

// --- 플레이스 리뷰 수집 Phase 1 핸들러 ---

/**
 * POST /api/places — 플레이스 등록 (UPSERT)
 * body: { url } 또는 { place_id, business_type, name }
 */
async function handleCreatePlace(request, env, corsHeaders) {
  // 로컬 백필 스크립트(서버-서버, Origin 없음)가 호출할 수 있으므로 corsHeaders가 null이어도 진행.
  // 보안 게이트는 JWT(requireApprovedUser).
  const cors = corsHeaders || {};

  const authResult = await requireApprovedUser(request, env);
  if (authResult.error) {
    return jsonResponse({ error: authResult.error, message: authResult.message }, authResult.status, cors);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'invalid_json', message: 'Request body must be valid JSON' }, 400, cors);
  }

  let placeId, businessType;

  if (body.url) {
    // URL로부터 placeId·businessType 추출
    const info = extractPlaceInfo(body.url);
    if (!info) {
      return jsonResponse(
        { error: 'invalid_url', message: '플레이스 URL에서 placeId를 추출할 수 없습니다' },
        400,
        cors
      );
    }
    placeId = info.placeId;
    businessType = info.businessType;
  } else if (body.place_id) {
    // place_id 직접 전달
    placeId = body.place_id;
    businessType = body.business_type ?? null;
  } else {
    return jsonResponse(
      { error: 'missing_param', message: 'url 또는 place_id 중 하나가 필요합니다' },
      400,
      cors
    );
  }

  const name = body.name ?? null;
  const placeUrl = body.url ?? null;
  const now = new Date().toISOString();
  const newId = crypto.randomUUID();

  try {
    // UPSERT: (user_id, place_id) 충돌 시 기존 row 유지하며 새 값으로 갱신(COALESCE)
    await env.DB.prepare(
      `INSERT INTO review_places (id, user_id, place_id, business_type, place_url, name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, place_id) DO UPDATE SET
         business_type = COALESCE(excluded.business_type, business_type),
         place_url     = COALESCE(excluded.place_url, place_url),
         name          = COALESCE(excluded.name, name)`
    ).bind(newId, authResult.user.id, placeId, businessType, placeUrl, name, now).run();

    // 삽입/갱신된 row 조회
    const row = await env.DB.prepare(
      `SELECT id, place_id, business_type, name, total_reviews, last_collected_at, created_at
       FROM review_places
       WHERE user_id = ? AND place_id = ?`
    ).bind(authResult.user.id, placeId).first();

    return jsonResponse({ place: row }, 200, cors);
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
  }
}

/**
 * GET /api/places — 등록된 플레이스 목록 조회
 */
async function handleListPlaces(request, env, corsHeaders) {
  const cors = corsHeaders || {};

  const authResult = await requireApprovedUser(request, env);
  if (authResult.error) {
    return jsonResponse({ error: authResult.error, message: authResult.message }, authResult.status, cors);
  }

  try {
    const { results } = await env.DB.prepare(
      `SELECT id, place_id, business_type, name, total_reviews, last_collected_at, created_at
       FROM review_places
       WHERE user_id = ?
       ORDER BY created_at DESC`
    ).bind(authResult.user.id).all();

    return jsonResponse({ places: results ?? [] }, 200, cors);
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
  }
}

/**
 * POST /api/places/:id/reviews — 리뷰 배치 적재 (로컬 백필 스크립트가 호출)
 * body: { reviews: [...], total_reviews?, name? }
 */
async function handlePostReviews(request, env, corsHeaders, placeRowId) {
  // 로컬 백필 스크립트(Origin 없음)가 호출하므로 corsHeaders null이어도 진행.
  const cors = corsHeaders || {};

  const authResult = await requireApprovedUser(request, env);
  if (authResult.error) {
    return jsonResponse({ error: authResult.error, message: authResult.message }, authResult.status, cors);
  }

  // 플레이스 소유 확인
  let placeRow;
  try {
    placeRow = await env.DB.prepare(
      'SELECT id, user_id FROM review_places WHERE id = ?'
    ).bind(placeRowId).first();
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
  }

  if (!placeRow) {
    return jsonResponse({ error: 'place_not_found', message: '등록된 플레이스를 찾을 수 없습니다' }, 404, cors);
  }
  if (placeRow.user_id !== authResult.user.id) {
    return jsonResponse({ error: 'forbidden', message: '해당 플레이스에 대한 권한이 없습니다' }, 403, cors);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'invalid_json', message: 'Request body must be valid JSON' }, 400, cors);
  }

  const reviews = body.reviews;
  if (!Array.isArray(reviews) || reviews.length === 0) {
    return jsonResponse({ error: 'invalid_reviews', message: 'reviews는 비어 있지 않은 배열이어야 합니다' }, 400, cors);
  }

  const now = new Date().toISOString();

  // 각 리뷰를 INSERT OR IGNORE 문으로 준비 (중복 키: place_row_id + naver_review_id)
  const stmts = reviews.map((r) => {
    return env.DB.prepare(
      `INSERT OR IGNORE INTO place_reviews
         (id, place_row_id, naver_review_id, author_nick, body, has_photo, owner_reply, visited_at, review_created_at, collected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      crypto.randomUUID(),
      placeRowId,
      r.naver_review_id ?? null,
      r.author_nick ?? null,
      r.body ?? null,
      r.has_photo ? 1 : 0,        // truthy → 1, falsy → 0
      r.owner_reply ?? null,
      r.visited_at ?? null,
      r.review_created_at ?? null,
      now
    );
  });

  let batchResults;
  try {
    batchResults = await env.DB.batch(stmts);
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
  }

  // 삽입 성공 건수: meta.changes === 1이면 실제 삽입, 0이면 중복으로 무시됨
  const inserted = batchResults.reduce((sum, r) => sum + (r.meta?.changes ?? 0), 0);
  const skipped = reviews.length - inserted;

  // review_places 갱신: last_collected_at=now, total_reviews/name은 COALESCE로 새 값 우선
  const newTotalReviews = body.total_reviews ?? null;
  const newName = body.name ?? null;
  try {
    await env.DB.prepare(
      `UPDATE review_places
       SET last_collected_at = ?,
           total_reviews     = COALESCE(?, total_reviews),
           name              = COALESCE(?, name)
       WHERE id = ?`
    ).bind(now, newTotalReviews, newName, placeRowId).run();
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
  }

  return jsonResponse({ inserted, skipped }, 200, cors);
}

/**
 * GET /api/places/:id/reviews — 리뷰 목록 열람 (페이지네이션)
 */
async function handleGetReviews(request, env, corsHeaders, placeRowId) {
  const cors = corsHeaders || {};

  const authResult = await requireApprovedUser(request, env);
  if (authResult.error) {
    return jsonResponse({ error: authResult.error, message: authResult.message }, authResult.status, cors);
  }

  // 플레이스 소유 확인
  let placeRow;
  try {
    placeRow = await env.DB.prepare(
      'SELECT id, user_id FROM review_places WHERE id = ?'
    ).bind(placeRowId).first();
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
  }

  if (!placeRow) {
    return jsonResponse({ error: 'place_not_found', message: '등록된 플레이스를 찾을 수 없습니다' }, 404, cors);
  }
  if (placeRow.user_id !== authResult.user.id) {
    return jsonResponse({ error: 'forbidden', message: '해당 플레이스에 대한 권한이 없습니다' }, 403, cors);
  }

  // 쿼리 파라미터: limit (기본 50, 최대 200), offset (기본 0)
  const reqUrl = new URL(request.url);
  const rawLimit = reqUrl.searchParams.get('limit');
  const rawOffset = reqUrl.searchParams.get('offset');

  let limit = 50;
  if (rawLimit !== null) {
    const parsed = parseInt(rawLimit, 10);
    limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 200) : 50;
  }

  let offset = 0;
  if (rawOffset !== null) {
    const parsed = parseInt(rawOffset, 10);
    offset = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  try {
    // 전체 건수 조회
    const countRow = await env.DB.prepare(
      'SELECT COUNT(*) AS c FROM place_reviews WHERE place_row_id = ?'
    ).bind(placeRowId).first();

    const total = countRow?.c ?? 0;

    // 리뷰 목록 조회 (최신 리뷰 순)
    const { results } = await env.DB.prepare(
      `SELECT id, naver_review_id, author_nick, body, has_photo, owner_reply, visited_at, review_created_at, collected_at
       FROM place_reviews
       WHERE place_row_id = ?
       ORDER BY review_created_at DESC
       LIMIT ? OFFSET ?`
    ).bind(placeRowId, limit, offset).all();

    return jsonResponse({ reviews: results ?? [], total }, 200, cors);
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
  }
}

// ─── 플레이스 리뷰 증분 수집 ────────────────────────────────────────────────────

// 네이버 getVisitorReviews GraphQL 쿼리 (backfill.mjs GQL_QUERY 그대로 복사)
const PLACE_GQL_QUERY =
  'query getVisitorReviews($input: VisitorReviewsInput) {\n' +
  '  visitorReviews(input: $input) {\n' +
  '    items {\n' +
  '      id\n' +
  '      cursor\n' +
  '      reviewId\n' +
  '      rating\n' +
  '      author {\n' +
  '        id\n' +
  '        nickname\n' +
  '        from\n' +
  '        imageUrl\n' +
  '        objectId\n' +
  '        url\n' +
  '        __typename\n' +
  '      }\n' +
  '      body\n' +
  '      thumbnail\n' +
  '      media {\n' +
  '        type\n' +
  '        thumbnail\n' +
  '        videoId\n' +
  '        videoUrl\n' +
  '        __typename\n' +
  '      }\n' +
  '      tags\n' +
  '      status\n' +
  '      visitCount\n' +
  '      viewCount\n' +
  '      visited\n' +
  '      created\n' +
  '      reply {\n' +
  '        body\n' +
  '        editedBy\n' +
  '        created\n' +
  '        date\n' +
  '        replyTitle\n' +
  '        status\n' +
  '        __typename\n' +
  '      }\n' +
  '      originType\n' +
  '      language\n' +
  '      businessName\n' +
  '      votedKeywords {\n' +
  '        code\n' +
  '        name\n' +
  '        __typename\n' +
  '      }\n' +
  '      nickname\n' +
  '      __typename\n' +
  '    }\n' +
  '    total\n' +
  '    __typename\n' +
  '  }\n' +
  '}';

const NAVER_GRAPHQL_URL = 'https://pcmap-api.place.naver.com/graphql';

// fetchNaverSearchPc 의 UA를 재사용 (데스크톱 크롬)
const PLACE_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * x-wtm-graphql 헤더 값 생성.
 * Worker 환경에는 Buffer 없으므로 btoa 사용.
 * JSON 내부에 비ASCII 문자 없어 btoa 안전.
 * @param {string} placeId
 * @param {string} businessType
 * @returns {string}
 */
function makeWtmGraphql(placeId, businessType) {
  return btoa(JSON.stringify({ arg: placeId, type: businessType, source: 'place' })).replace(/=+$/, '');
}

/**
 * 네이버 getVisitorReviews GraphQL 한 페이지 호출.
 * 실패 시 1회 짧은 백오프 재시도 후 에러를 throw.
 * @param {string} placeId
 * @param {string} businessType
 * @param {string|null} after  커서 (첫 요청은 null)
 * @param {object} env
 * @returns {Promise<{total: number, items: any[]}>}
 */
async function fetchNaverReviewPage(placeId, businessType, after, env) {
  const wtmHeader = makeWtmGraphql(placeId, businessType);

  const headers = {
    'content-type': 'application/json',
    'accept': '*/*',
    'accept-language': 'ko',
    'Referer': `https://pcmap.place.naver.com/${businessType}/${placeId}/review/visitor`,
    'Origin': 'https://pcmap.place.naver.com',
    'User-Agent': PLACE_USER_AGENT,
    'x-wtm-graphql': wtmHeader,
  };

  // NCAPTCHA_TOKEN 환경변수 있으면 추가 (없으면 생략 — 1차 측정은 토큰 없이)
  if (env.NCAPTCHA_TOKEN) {
    headers['x-wtm-ncaptcha-token'] = env.NCAPTCHA_TOKEN;
  }

  const body = JSON.stringify([
    {
      operationName: 'getVisitorReviews',
      variables: {
        input: {
          businessId: placeId,
          businessType: businessType,
          item: '0',
          // 커서 기반 페이지네이션: after 있으면 포함, 첫 요청은 미포함
          ...(after ? { after } : {}),
          size: 10,
          isPhotoUsed: false,
          includeContent: true,
          getUserStats: false,
          includeReceiptPhotos: false,
          getReactions: false,
          getTrailer: false,
        },
      },
      query: PLACE_GQL_QUERY,
    },
  ]);

  // 호출 헬퍼: 1회 재시도 포함
  const doFetch = async () => {
    const res = await fetch(NAVER_GRAPHQL_URL, { method: 'POST', headers, body });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const json = await res.json();
    if (!Array.isArray(json) || json[0]?.errors) {
      const errMsg = json[0]?.errors?.[0]?.message ?? 'unknown';
      throw new Error(`GraphQL 오류: ${errMsg}`);
    }
    const visitorReviews = json[0]?.data?.visitorReviews;
    if (!visitorReviews) {
      throw new Error('visitorReviews 필드 없음');
    }
    return visitorReviews; // { total, items[] }
  };

  try {
    return await doFetch();
  } catch (firstErr) {
    // 1회 재시도: 500ms 대기 후 재시도
    await new Promise((r) => setTimeout(r, 500));
    try {
      return await doFetch();
    } catch (retryErr) {
      throw new Error(`네이버 호출 실패: ${retryErr.message}`);
    }
  }
}

/**
 * 리뷰 아이템 → DB INSERT 형식으로 매핑.
 * backfill.mjs mapItem 과 동일 필드.
 */
function mapReviewItem(item) {
  return {
    naver_review_id: String(item.id),
    author_nick: item.author?.nickname ?? item.nickname ?? null,
    body: item.body ?? null,
    has_photo: Array.isArray(item.media) && item.media.length > 0 ? 1 : 0,
    owner_reply: item.reply?.body ?? null,
    visited_at: item.visited ?? null,
    review_created_at: item.created ?? null,
  };
}

/**
 * 플레이스 리뷰 증분 수집 핵심 함수.
 * Cron 재사용을 위해 핸들러에서 분리.
 *
 * @param {object} env         Worker env
 * @param {object} placeRow    { id, place_id, business_type, name } — DB 조회 row
 * @param {object} opts        { maxPages? } (기본 3)
 * @returns {Promise<{place_id, total_server, inserted, skipped, pages_fetched, blocked, error?}>}
 */
async function collectPlaceReviews(env, placeRow, opts = {}) {
  const maxPages = opts.maxPages ?? 3;
  const placeRowId = placeRow.id;
  const placeId = placeRow.place_id;
  // business_type 없으면 'place'로 폴백
  const businessType = placeRow.business_type || 'place';

  let totalServer = null;   // 서버 기준 총 리뷰 수 (첫 응답에서 확정)
  let placeName = null;     // 첫 item.businessName (업체명 갱신용)
  let after = null;         // 커서: 직전 페이지 마지막 item.cursor
  let inserted = 0;         // 누적 삽입 성공 수
  let skipped = 0;          // 누적 중복 스킵 수
  let pagesFetched = 0;     // 실제 수집한 페이지 수
  let blocked = false;
  let errorMsg = null;
  const now = new Date().toISOString();

  for (let page = 1; page <= maxPages; page++) {
    // 페이지 간 딜레이 (첫 페이지 제외, Worker wall-clock 고려해 800ms)
    if (page > 1) {
      await new Promise((r) => setTimeout(r, 800));
    }

    // 네이버 호출
    let visitorReviews;
    try {
      visitorReviews = await fetchNaverReviewPage(placeId, businessType, after, env);
    } catch (err) {
      blocked = true;
      errorMsg = err.message;
      console.error(`[collectPlaceReviews] place_id=${placeId} page=${page} 실패: ${err.message}`);
      break;
    }

    pagesFetched++;
    const { total, items } = visitorReviews;

    // 첫 페이지에서 total·업체명 확정
    if (page === 1) {
      totalServer = total;
    }

    // items가 비어 있으면 종료
    if (!items || items.length === 0) {
      break;
    }

    // 업체명 첫 발견 시 저장
    for (const item of items) {
      if (!placeName && item.businessName) {
        placeName = item.businessName;
        break;
      }
    }

    // 이번 페이지 items → 매핑 후 INSERT OR IGNORE batch
    const mapped = items.map(mapReviewItem);
    const stmts = mapped.map((r) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO place_reviews
           (id, place_row_id, naver_review_id, author_nick, body, has_photo, owner_reply, visited_at, review_created_at, collected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        crypto.randomUUID(),
        placeRowId,
        r.naver_review_id ?? null,
        r.author_nick ?? null,
        r.body ?? null,
        r.has_photo ? 1 : 0,
        r.owner_reply ?? null,
        r.visited_at ?? null,
        r.review_created_at ?? null,
        now
      )
    );

    let batchResults;
    try {
      batchResults = await env.DB.batch(stmts);
    } catch (err) {
      // DB batch 실패 — 이번 페이지 건너뜀, 에러 기록 후 중단
      blocked = true;
      errorMsg = `DB batch 오류: ${err.message}`;
      console.error(`[collectPlaceReviews] DB batch 실패: ${err.message}`);
      break;
    }

    // 이번 페이지 삽입/스킵 집계
    const pageInserted = batchResults.reduce((sum, r) => sum + (r.meta?.changes ?? 0), 0);
    const pageSkipped = mapped.length - pageInserted;
    inserted += pageInserted;
    skipped += pageSkipped;

    // 다음 커서 갱신 (이번 페이지 마지막 item.cursor)
    after = items[items.length - 1]?.cursor ?? null;

    // 조기 종료: 2페이지 이상이고 이번 페이지가 전부 중복 → "이미 가진 영역" 도달로 판단
    if (page >= 2 && pageInserted === 0) {
      console.log(`[collectPlaceReviews] place_id=${placeId} page=${page} 전부 중복 → 증분 조기 종료`);
      break;
    }

    // 조기 종료: 커서 없으면 다음 페이지 불가
    if (!after) {
      break;
    }

    // 조기 종료: total 도달
    if (totalServer !== null && inserted + skipped >= totalServer) {
      break;
    }
  }

  // review_places UPDATE: last_collected_at, total_reviews, name 갱신
  try {
    await env.DB.prepare(
      `UPDATE review_places
       SET last_collected_at = ?,
           total_reviews     = COALESCE(?, total_reviews),
           name              = COALESCE(?, name)
       WHERE id = ?`
    ).bind(now, totalServer, placeName, placeRowId).run();
  } catch (err) {
    console.error(`[collectPlaceReviews] review_places UPDATE 실패: ${err.message}`);
  }

  const result = {
    place_id: placeId,
    total_server: totalServer,
    inserted,
    skipped,
    pages_fetched: pagesFetched,
    blocked,
  };
  if (errorMsg) {
    result.error = errorMsg;
  }
  return result;
}

/**
 * POST /api/places/:id/collect
 * 플레이스 리뷰 증분 수집 수동 트리거 (데이터센터 IP에서 네이버 호출 가능 여부 측정용).
 * body(선택): { maxPages } (1~10, 기본 3)
 */
async function handleCollectPlace(request, env, corsHeaders, placeRowId) {
  // 로컬 호출(Origin 없음)도 허용. 보안 게이트는 JWT.
  const cors = corsHeaders || {};

  const authResult = await requireApprovedUser(request, env);
  if (authResult.error) {
    return jsonResponse({ error: authResult.error, message: authResult.message }, authResult.status, cors);
  }

  // 플레이스 소유 확인 (handleGetReviews 와 동일 패턴)
  let placeRow;
  try {
    placeRow = await env.DB.prepare(
      'SELECT id, place_id, business_type, name, user_id FROM review_places WHERE id = ?'
    ).bind(placeRowId).first();
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
  }

  if (!placeRow) {
    return jsonResponse({ error: 'place_not_found', message: '등록된 플레이스를 찾을 수 없습니다' }, 404, cors);
  }
  if (placeRow.user_id !== authResult.user.id) {
    return jsonResponse({ error: 'forbidden', message: '해당 플레이스에 대한 권한이 없습니다' }, 403, cors);
  }

  // body(선택): maxPages 파싱 (1~10 clamp, 기본 3)
  let maxPages = 3;
  try {
    const body = await request.json().catch(() => ({}));
    if (body.maxPages !== undefined) {
      const parsed = Number(body.maxPages);
      if (Number.isFinite(parsed) && parsed > 0) {
        maxPages = Math.min(Math.max(Math.floor(parsed), 1), 10);
      }
    }
  } catch {
    // body 파싱 실패 시 기본값 유지
  }

  // 증분 수집 실행
  let result;
  try {
    result = await collectPlaceReviews(env, placeRow, { maxPages });
  } catch (err) {
    return jsonResponse({ error: 'collect_failed', message: err.message }, 500, cors);
  }

  // 차단 여부와 무관하게 200 반환 (측정 데이터로 활용)
  return jsonResponse(result, 200, cors);
}

// --- 관리자 엔드포인트 (role='admin' 전용) ---

// 관리자 게이트: requireApprovedUser 통과 + user.role === 'admin' 확인.
// 통과 시 { user } / 실패 시 { error, status, message }.
async function requireAdmin(request, env) {
  const authResult = await requireApprovedUser(request, env);
  if (authResult.error) return authResult;
  if (authResult.user.role !== 'admin') {
    return { error: 'forbidden', status: 403, message: '관리자 권한이 필요합니다' };
  }
  return authResult;
}

// GET /api/admin/users — 전체 사용자 목록 (가입 신청 검토용)
async function handleAdminListUsers(request, env, corsHeaders) {
  const cors = corsHeaders || {};

  const authResult = await requireAdmin(request, env);
  if (authResult.error) {
    return jsonResponse({ error: authResult.error, message: authResult.message }, authResult.status, cors);
  }

  try {
    const { results } = await env.DB.prepare(
      `SELECT id, email, name, picture, status, plan, created_at, last_login_at, approved_at
       FROM users ORDER BY created_at DESC`
    ).all();

    // role은 ADMIN_EMAILS 기반으로 응답 시 계산해 부여 (DB에 role 컬럼 없음)
    const adminEmails = (env.ADMIN_EMAILS || '').split(',').map(s => s.trim()).filter(Boolean);
    const users = (results ?? []).map(u => ({
      ...u,
      role: adminEmails.includes(u.email) ? 'admin' : 'user',
    }));

    return jsonResponse({ users }, 200, cors);
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
  }
}

// POST /api/admin/users/:id/status — 사용자 status 변경 (승인/정지/해제)
// body: { status: 'approved' | 'suspended' | 'pending' }
async function handleAdminSetStatus(request, env, corsHeaders, targetUserId) {
  const cors = corsHeaders || {};

  const authResult = await requireAdmin(request, env);
  if (authResult.error) {
    return jsonResponse({ error: authResult.error, message: authResult.message }, authResult.status, cors);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'invalid_json', message: 'Request body must be valid JSON' }, 400, cors);
  }

  const newStatus = body?.status;
  const ALLOWED = ['approved', 'suspended', 'pending'];
  if (!ALLOWED.includes(newStatus)) {
    return jsonResponse(
      { error: 'invalid_status', message: `status는 ${ALLOWED.join('/')} 중 하나여야 합니다` },
      400,
      cors
    );
  }

  // 대상 사용자 존재 확인
  let target;
  try {
    target = await env.DB.prepare('SELECT id, email, status FROM users WHERE id = ?').bind(targetUserId).first();
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
  }
  if (!target) {
    return jsonResponse({ error: 'user_not_found', message: '대상 사용자를 찾을 수 없습니다' }, 404, cors);
  }

  // 본인 계정 강등 방지: 관리자가 자기 자신을 정지/대기로 내리는 것 차단 (lockout 방지)
  if (target.id === authResult.user.id && newStatus !== 'approved') {
    return jsonResponse(
      { error: 'cannot_demote_self', message: '본인 계정의 상태는 변경할 수 없습니다' },
      400,
      cors
    );
  }

  // approved로 처음 승인 시 approved_at 기록 (이미 값 있으면 유지)
  const nowIso = new Date().toISOString();
  try {
    if (newStatus === 'approved') {
      await env.DB.prepare(
        "UPDATE users SET status = 'approved', approved_at = COALESCE(approved_at, ?) WHERE id = ?"
      ).bind(nowIso, targetUserId).run();
    } else {
      await env.DB.prepare('UPDATE users SET status = ? WHERE id = ?').bind(newStatus, targetUserId).run();
    }
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
  }

  return jsonResponse({ id: targetUserId, status: newStatus }, 200, cors);
}

// --- JWT 유틸리티 (HS256, crypto.subtle 직접 구현) ---

function base64urlEncode(buf) {
  // ArrayBuffer 또는 Uint8Array → base64url 문자열
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(str) {
  // base64url → Uint8Array
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + (4 - (base64.length % 4)) % 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJwtPayload(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('JWT 형식 오류');
  const payloadJson = new TextDecoder().decode(base64urlDecode(parts[1]));
  return JSON.parse(payloadJson);
}

async function getHmacKey(secret) {
  const keyBytes = new TextEncoder().encode(secret);
  return crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

async function issueJwt(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 7 * 24 * 60 * 60; // 7일

  const headerB64 = base64urlEncode(new TextEncoder().encode(JSON.stringify(header)));
  const payloadB64 = base64urlEncode(new TextEncoder().encode(JSON.stringify({ ...payload, iat, exp })));
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await getHmacKey(secret);
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
  const sigB64 = base64urlEncode(sigBuf);

  return `${signingInput}.${sigB64}`;
}

async function verifyJwt(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('JWT 형식 오류');

  const [headerB64, payloadB64, sigB64] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;

  // 서명 검증
  const key = await getHmacKey(secret);
  const expectedSig = base64urlDecode(sigB64);
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    expectedSig,
    new TextEncoder().encode(signingInput)
  );
  if (!valid) throw new Error('JWT 서명 불일치');

  // 페이로드 파싱
  const payloadJson = new TextDecoder().decode(base64urlDecode(payloadB64));
  const payload = JSON.parse(payloadJson);

  // 만료 확인
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) throw new Error('JWT 만료');

  return payload;
}

// --- 시그니처 ---

async function makeSignature(timestamp, method, path, secretKey) {
  const message = `${timestamp}.${method}.${path}`;
  const keyBytes = new TextEncoder().encode(secretKey);
  const msgBytes = new TextEncoder().encode(message);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, msgBytes);
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}
