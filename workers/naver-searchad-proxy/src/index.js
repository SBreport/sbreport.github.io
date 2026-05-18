// SBS 확장 + 차세대 키워드 분석 대시보드용 네이버 검색광고 API 프록시

const ALLOWED_ORIGINS = [
  'chrome-extension://',
  'http://localhost:',
  'https://sbreport.github.io',
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

    return jsonResponse({ error: 'not found' }, 404, corsHeaders);
  },
};

// --- CORS ---

function getCorsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.some((prefix) => origin.startsWith(prefix));
  if (!allowed) return null;

  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
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
  const url = new URL(request.url);
  const raw = url.searchParams.get('keywords');

  if (!raw) {
    return jsonResponse({ error: 'missing query parameter "keywords"' }, 400, corsHeaders);
  }

  const keywords = raw
    .split(',')
    .map((k) => k.trim())
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
