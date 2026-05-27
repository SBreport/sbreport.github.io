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

// data-block-id 값 → { type, label } 매핑
const BLOCK_ID_MAP = [
  { pattern: /^review\/.*blog/i,            type: 'blog',          label: '블로그' },
  { pattern: /^kin\//i,                     type: 'kin',           label: '지식인' },
  { pattern: /^web\//i,                     type: 'web',           label: '웹사이트' },
  { pattern: /^news\//i,                    type: 'news',          label: '뉴스' },
  { pattern: /^video\//i,                   type: 'video',         label: '동영상' },
  { pattern: /^qra\//i,                     type: 'qra',           label: '함께 많이 찾는' },
  { pattern: /^ugc\/.*influencer/i,         type: 'influencer',    label: '인플루언서' },
  { pattern: /^ugc\/.*powercontents/i,      type: 'powercontents', label: '파워컨텐츠' },
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
  const cacheUrl = `https://cache.internal/v2/api-search?keyword=${encodeURIComponent(normalizedKeyword)}`;
  const cache = caches.default;

  const cached = await cache.match(cacheUrl);
  if (cached) {
    const body = await cached.json();
    return jsonResponse(body, 200, corsHeaders, { 'X-Cache': 'HIT' });
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

  // 캐시 저장 (비동기)
  const cacheResponse = new Response(JSON.stringify(payload), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    },
  });
  ctx.waitUntil(cache.put(cacheUrl, cacheResponse));

  return jsonResponse(payload, 200, corsHeaders, { 'X-Cache': 'MISS' });
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

  // 1) power_link (파워링크 광고) — data-block-id보다 먼저 등장하는 경우가 많음
  const powerLinkCount = countOccurrences(html, 'power_link');
  if (powerLinkCount > 0) {
    sections.push({ order: order++, type: 'powerlink', label: '파워링크', count: powerLinkCount });
    seen.add('powerlink');
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
  // 알 수 없는 block-id: fallback (모니터링용)
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
