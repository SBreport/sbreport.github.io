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
  // review/ugc.* — blog 외 UGC 단일 의도 추천 (블로그 매칭 안 되는 추천형 섹션)
  { pattern: /^review\/.*ugc/i,             type: 'related',       label: '추천' },
  { pattern: /^ai-briefing\//i,             type: 'ai_briefing',   label: 'AI 브리핑' },
  { pattern: /^image\//i,                   type: 'image',         label: '이미지' },
  { pattern: /^kin\//i,                     type: 'kin',           label: '지식인' },
  { pattern: /^web\//i,                     type: 'web',           label: '웹사이트' },
  { pattern: /^news\//i,                    type: 'news',          label: '뉴스' },
  { pattern: /^video\//i,                   type: 'video',         label: '동영상' },
  { pattern: /^clip\//i,                    type: 'clip',          label: '클립' },
  { pattern: /^qra\//i,                     type: 'qra',           label: '함께 많이 찾는' },
  { pattern: /^ugc\/.*influencer/i,         type: 'influencer',    label: '인플루언서' },
  { pattern: /^ugc\/.*powercontents/i,      type: 'powercontents', label: '파워컨텐츠' },
  // 구체 패턴(influencer/powercontents)이 먼저 매칭되도록 위에. default는 일반 UGC 통합.
  { pattern: /^ugc\/.*popular_article/i,    type: 'popular_article', label: '인기글' },
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
  const cacheUrl = `https://cache.internal/v6/api-search?keyword=${encodeURIComponent(normalizedKeyword)}`;
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

  // 검색광고 API + m.search.naver.com 병렬 호출
  const [adResult, searchResult] = await Promise.allSettled([
    fetchKeywordVolume([normalizedKeyword], env),
    fetchNaverSearch(rawKeyword.trim()),
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
  let relatedKeywords = [];

  if (searchResult.status === 'fulfilled') {
    sections = searchResult.value.sections;
    // 연관 검색어: adNormalized에서 입력 키워드 외의 항목들 (네이버 API가 연관 키워드를 함께 반환)
    relatedKeywords = adNormalized
      .filter((k) => k.keyword !== normalizedKeyword)
      .map((k) => ({ keyword: k.keyword, total: k.total }));
  } else {
    // m.search fetch 실패: 연관 검색어도 없음, sections 빈 배열
    relatedKeywords = adNormalized
      .filter((k) => k.keyword !== normalizedKeyword)
      .map((k) => ({ keyword: k.keyword, total: k.total }));
  }

  const payload = {
    keyword: rawKeyword.trim(),
    pc_volume: adKeyword.pc,
    mobile_volume: adKeyword.mobile,
    total: adKeyword.total,
    competition: mapCompetition(adKeyword.competition),
    related_keywords: relatedKeywords,
    sections,
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

function parseNaverSections(html) {
  const sections = [];
  const seen = new Set(); // 중복 type 방지 (같은 구좌가 여러 번 등장 시 첫 번째 순서 유지)
  let order = 1;

  // 1) 파워링크 광고 — 영역 컨테이너(id=power_link_body)가 있으면, 그 안의 개별 광고 카드 수를 카운트
  //    카드 마커 `data-sv-log="pwl"`은 광고 카드 각각에 1번씩 부여됨 (모바일 SERP 기준).
  //    주의: 모바일 SERP는 첫 fetch 시점에 광고 일부만 노출 → PC SERP와 광고 수가 다를 수 있다.
  if (html.includes('id="power_link_body"') || html.includes('power_link')) {
    const adCardCount = countOccurrences(html, 'data-sv-log="pwl"');
    if (adCardCount > 0) {
      sections.push({ order: order++, type: 'powerlink', label: '파워링크', count: adCardCount });
      seen.add('powerlink');
    }
  }

  // 2) data-block-id 등장 순서대로 수집
  const blockIdRegex = /data-block-id="([^"]+)"/g;
  let match;

  while ((match = blockIdRegex.exec(html)) !== null) {
    const blockId = match[1];
    const mapped = resolveBlockId(blockId);
    const type = mapped.type;

    if (seen.has(type)) continue; // 이미 처리한 구좌는 스킵 (첫 등장 순서 보존)
    seen.add(type);

    // 해당 구좌 카운트: data-block-id="<blockId>" 등장 횟수
    const count = countOccurrences(html, `data-block-id="${blockId}"`);
    sections.push({ order: order++, type, label: mapped.label, count });
  }

  // 3) place-app-root (플레이스) — data-block-id에 잡히지 않는 경우 보완
  if (!seen.has('place')) {
    const placeCount = countOccurrences(html, 'place-app-root');
    if (placeCount > 0) {
      sections.push({ order: order++, type: 'place', label: '플레이스', count: placeCount });
      seen.add('place');
    }
  }

  return sections;
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

// TODO: 관리자 엔드포인트 (다음 단계)
// GET  /api/admin/users            — 사용자 목록 (role='admin' 전용)
// POST /api/admin/users/:id/approve — 사용자 승인
// POST /api/admin/users/:id/suspend — 사용자 정지
// requireApprovedUser + user.role === 'admin' 추가 확인 필요

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
