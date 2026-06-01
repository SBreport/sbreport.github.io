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
    // POST /api/places/:id/backfill — 과거 리뷰 전체 백필 (청크 단위, 커서 저장)
    const backfillMatch = url.pathname.match(/^\/api\/places\/([^/]+)\/backfill$/);
    if (backfillMatch && request.method === 'POST') {
      return handleBackfillPlace(request, env, corsHeaders, backfillMatch[1]);
    }
    // GET /api/places/:id/collections — 수집 이력 조회
    const collectionsMatch = url.pathname.match(/^\/api\/places\/([^/]+)\/collections$/);
    if (collectionsMatch && request.method === 'GET') {
      return handleGetCollections(request, env, corsHeaders, collectionsMatch[1]);
    }
    // POST /api/places/:id/auto-collect — 자동수집 on/off 토글
    const autoCollectMatch = url.pathname.match(/^\/api\/places\/([^/]+)\/auto-collect$/);
    if (autoCollectMatch && request.method === 'POST') {
      return handleToggleAutoCollect(request, env, corsHeaders, autoCollectMatch[1]);
    }
    // GET /api/places/:id/stats — 지점별 미니 통계 대시보드
    const statsMatch = url.pathname.match(/^\/api\/places\/([^/]+)\/stats$/);
    if (statsMatch && request.method === 'GET') {
      return handleGetPlaceStats(request, env, corsHeaders, statsMatch[1]);
    }
    // POST /api/places/:id/report — 업체 피드백 리포트 생성 (GPT + 정량 SQL)
    // GET  /api/places/:id/report — 캐시된 리포트 조회
    const reportMatch = url.pathname.match(/^\/api\/places\/([^/]+)\/report$/);
    if (reportMatch && request.method === 'POST') {
      return handleGenerateReport(request, env, corsHeaders, reportMatch[1]);
    }
    if (reportMatch && request.method === 'GET') {
      return handleGetReport(request, env, corsHeaders, reportMatch[1]);
    }
    // GET /api/places/:id/usage — LLM 호출 누적 비용 조회 (승인 사용자 + 소유 확인)
    const usageMatch = url.pathname.match(/^\/api\/places\/([^/]+)\/usage$/);
    if (usageMatch && request.method === 'GET') {
      return handleGetPlaceUsage(request, env, corsHeaders, usageMatch[1]);
    }
    // POST /api/places/:id/generate-samples — 리뷰 예시 생성 (researcher 이상)
    // GET  /api/places/:id/samples         — 저장된 생성 예시 조회 (researcher 이상)
    // POST /api/places/:id/samples/:sampleId/status — 샘플 평가 라벨 변경 (researcher 이상)
    // POST /api/places/:id/samples/delete  — 샘플 다중 삭제 (researcher 이상)
    // 주의: 구체적인 경로(:sampleId/status, delete)를 /samples$ 보다 먼저 매칭
    const generateSamplesMatch = url.pathname.match(/^\/api\/places\/([^/]+)\/generate-samples$/);
    if (generateSamplesMatch && request.method === 'POST') {
      return handleGenerateSamples(request, env, corsHeaders, generateSamplesMatch[1]);
    }
    const sampleStatusMatch = url.pathname.match(/^\/api\/places\/([^/]+)\/samples\/([^/]+)\/status$/);
    if (sampleStatusMatch && request.method === 'POST') {
      return handleUpdateSampleStatus(request, env, corsHeaders, sampleStatusMatch[1], sampleStatusMatch[2]);
    }
    const samplesDeleteMatch = url.pathname.match(/^\/api\/places\/([^/]+)\/samples\/delete$/);
    if (samplesDeleteMatch && request.method === 'POST') {
      return handleDeleteSamples(request, env, corsHeaders, samplesDeleteMatch[1]);
    }
    const samplesMatch = url.pathname.match(/^\/api\/places\/([^/]+)\/samples$/);
    if (samplesMatch && request.method === 'GET') {
      return handleGetSamples(request, env, corsHeaders, samplesMatch[1]);
    }
    // DELETE /api/places/:id — 플레이스 + 연관 데이터 cascade 삭제
    // 주의: 정확히 /api/places/{id} 로 끝나는 것만 매칭(하위 경로 없음)
    const deletePlaceMatch = url.pathname.match(/^\/api\/places\/([^/]+)$/);
    if (deletePlaceMatch && request.method === 'DELETE') {
      return handleDeletePlace(request, env, corsHeaders, deletePlaceMatch[1]);
    }

    // --- 관리자 (role='admin' 전용) ---
    if (url.pathname === '/api/admin/users' && request.method === 'GET') {
      return handleAdminListUsers(request, env, corsHeaders);
    }
    const adminStatusMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/status$/);
    if (adminStatusMatch && request.method === 'POST') {
      return handleAdminSetStatus(request, env, corsHeaders, adminStatusMatch[1]);
    }
    const adminMemoMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/memo$/);
    if (adminMemoMatch && request.method === 'POST') {
      return handleAdminSetMemo(request, env, corsHeaders, adminMemoMatch[1]);
    }
    const adminRoleMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/role$/);
    if (adminRoleMatch && request.method === 'POST') {
      return handleAdminSetRole(request, env, corsHeaders, adminRoleMatch[1]);
    }

    return jsonResponse({ error: 'not found' }, 404, corsHeaders);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDailyReviewCollection(env));
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
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
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
  const cacheUrl = `https://cache.internal/v9/api-search?keyword=${encodeURIComponent(normalizedKeyword)}`;
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

  // 2) data-block-id 구좌 — 각 블록의 region(현재 block-id ~ 다음 block-id) 안에서만 카운트
  //    빈 블록(any-tpl === 0)은 candidates에서 제외.
  //    카운트 우선순위: ugcItem > any-tpl(폴백).
  //    단, layout/sdsHorzDivider/header/footer 같은 구조 마커만 있는 구좌는 count 산출 불가 → null.
  //    (실측: PC/모바일 HTML에 data-template-id="root"가 없으므로 root 마커 전략 폐기.
  //     ugcItem이 실제 UGC 카드 1개당 1개씩 정확히 매핑됨 — 브라우저 실측 일치 확인.)
  const STRUCTURAL_TPLS = new Set(['layout', 'sdsHorzDivider', 'header', 'footer']);
  // 구좌별 실제 콘텐츠 카드 마커 (우선순위 순)
  const CONTENT_MARKERS = ['ugcItem', 'articleSource'];

  const blockMatches = [...html.matchAll(/data-block-id="([^"]+)"/g)];
  for (let i = 0; i < blockMatches.length; i++) {
    const match = blockMatches[i];
    const blockId = match[1];
    const mapped = resolveBlockId(blockId);
    const type = mapped.type;

    if (seen.has(type)) continue; // 이미 처리한 구좌는 스킵 (첫 위치 보존)
    seen.add(type);

    // region 슬라이스: 현재 block-id 위치 ~ 다음 block-id 위치 (없으면 EOF)
    const regionStart = match.index;
    const regionEnd = i + 1 < blockMatches.length ? blockMatches[i + 1].index : html.length;
    const region = html.slice(regionStart, regionEnd);

    // 모든 data-template-id 카운트
    const anyTplCount = countOccurrences(region, 'data-template-id="');

    // 빈 블록 제외 (placeholder만 있어 화면 미노출)
    if (anyTplCount === 0) {
      console.log('[EMPTY_BLOCK_SKIPPED] ' + blockId);
      continue;
    }

    // 콘텐츠 마커 우선 탐색
    let count = null; // null = 정적 HTML로 산출 불가
    for (const marker of CONTENT_MARKERS) {
      const c = countOccurrences(region, `data-template-id="${marker}"`);
      if (c > 0) {
        count = c;
        break;
      }
    }

    // 콘텐츠 마커 없고 구조 마커뿐이면 count null (정적 산출 불가)
    if (count === null) {
      const allTplMatches = [...region.matchAll(/data-template-id="([^"]+)"/g)];
      const hasNonStructural = allTplMatches.some(m => !STRUCTURAL_TPLS.has(m[1]));
      if (hasNonStructural) {
        // 미분류 마커 — 폴백으로 any-tpl 사용
        count = anyTplCount;
        console.log('[BLOCK_CONTENT_FALLBACK] ' + blockId + ' anyTpl=' + anyTplCount);
      }
      // 구조 마커만 있으면 count = null 유지 (정적 불가)
    }

    candidates.push({ offset: regionStart, type, label: mapped.label, count });
  }

  // 3) place-app-root (플레이스) — data-block-id에 안 잡히므로 별도 수집(첫 등장 위치).
  //    정적 HTML에 카드 데이터 없음(JS가 API로 렌더) → count: null (정적 산출 불가).
  if (!seen.has('place')) {
    const placeOffset = html.indexOf('place-app-root');
    if (placeOffset !== -1) {
      candidates.push({ offset: placeOffset, type: 'place', label: '플레이스', count: null });
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

// D1에서 사용자 조회 + role 결정
// 우선순위: ADMIN_EMAILS 포함 → 'admin' (환경변수 우선),
//           DB role 컬럼이 'researcher' → 'researcher',
//           그 외 → 'user'
async function getUserFromDB(env, googleSub) {
  const row = await env.DB.prepare(
    'SELECT id, google_sub, email, name, picture, status, plan, plan_expires_at, role FROM users WHERE google_sub = ?'
  ).bind(googleSub).first();

  if (!row) return null;

  // ADMIN_EMAILS 환경변수가 있으면 최우선으로 admin 부여
  const adminEmails = (env.ADMIN_EMAILS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (adminEmails.includes(row.email)) {
    row.role = 'admin';
  } else if (row.role === 'researcher') {
    // DB에 researcher로 명시된 경우 유지
    row.role = 'researcher';
  } else {
    row.role = 'user';
  }

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

  let name = body.name ?? null;
  const placeUrl = body.url ?? null;
  const now = new Date().toISOString();
  const newId = crypto.randomUUID();

  // 이름이 안 들어왔으면 네이버 첫 페이지에서 업체명(businessName) 1회 확보 시도.
  // (등록 직후 화면에 placeId 대신 실제 지점명이 보이게 함. 실패해도 등록은 계속 진행 — name=null)
  if (!name) {
    try {
      const vr = await fetchNaverReviewPage(placeId, businessType || 'place', null, env);
      const bn = vr?.items?.find((it) => it.businessName)?.businessName ?? null;
      if (bn) name = bn;
    } catch (e) {
      // 네이버 호출 실패 시 이름 없이 등록 (수집 시 채워짐)
      console.log(`[CREATE_PLACE] businessName 확보 실패 place_id=${placeId}: ${e.message}`);
    }
  }

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
      `SELECT id, place_id, business_type, name, total_reviews, last_collected_at, created_at, auto_collect
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
    const reviewDate = r.review_date ?? parseNaverReviewDate(r.review_created_at ?? null, new Date());
    return env.DB.prepare(
      `INSERT OR IGNORE INTO place_reviews
         (id, place_row_id, naver_review_id, author_nick, body, has_photo, owner_reply, visited_at, review_created_at, review_date, collected_at, first_source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      reviewDate,
      now,
      'manual'
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
    // review_date(ISO)로 정렬. NULL인 옛 행은 뒤로, 그 안에선 review_created_at 원본순.
    const { results } = await env.DB.prepare(
      `SELECT id, naver_review_id, author_nick, body, has_photo, owner_reply, visited_at, review_created_at, review_date, collected_at, first_source
       FROM place_reviews
       WHERE place_row_id = ?
       ORDER BY review_date IS NULL, review_date DESC, review_created_at DESC
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
/**
 * 네이버 표시용 상대 날짜 문자열 → ISO YYYY-MM-DD 변환.
 *
 * 형식 규칙:
 *   "5.9.토"     → 2026-05-09  (올해, M.D.요일)
 *   "5.31.일"    → 2026-05-31  (올해, M.D.요일)
 *   "25.9.9.화"  → 2025-09-09  (과거, YY.M.D.요일)
 *   "18.11.1.목" → 2018-11-01  (과거, YY.M.D.요일)
 *
 * @param {string|null|undefined} raw      네이버 API item.created 값
 * @param {Date}                  refDate  기준 시점 (보통 new Date())
 * @returns {string|null}                  "YYYY-MM-DD" 또는 null
 */
function parseNaverReviewDate(raw, refDate) {
  if (!raw || typeof raw !== 'string') return null;
  // '.'으로 분리, 공백 제거, 빈 토큰 제거
  let parts = raw.split('.').map((s) => s.trim()).filter(Boolean);
  // 마지막 토큰이 요일(월화수목금토일 포함)이면 제거
  if (parts.length && /[월화수목금토일]/.test(parts[parts.length - 1])) parts.pop();
  let y, m, d;
  if (parts.length === 2) {
    // 올해(연도 생략): [M, D]
    m = Number(parts[0]);
    d = Number(parts[1]);
    y = refDate.getFullYear();
    // 만든 날짜가 기준일보다 미래면 작년 (예: 5월에 "12.31"을 보면 작년 12월)
    if (new Date(y, m - 1, d) > refDate) y -= 1;
  } else if (parts.length === 3) {
    // [YY, M, D] → 2000 + YY
    y = 2000 + Number(parts[0]);
    m = Number(parts[1]);
    d = Number(parts[2]);
  } else {
    return null;
  }
  if (
    !Number.isInteger(m) || !Number.isInteger(d) ||
    m < 1 || m > 12 || d < 1 || d > 31
  ) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${y}-${pad(m)}-${pad(d)}`;
}

function mapReviewItem(item) {
  const raw = item.created ?? null;
  return {
    naver_review_id: String(item.id),
    author_nick: item.author?.nickname ?? item.nickname ?? null,
    body: item.body ?? null,
    has_photo: Array.isArray(item.media) && item.media.length > 0 ? 1 : 0,
    owner_reply: item.reply?.body ?? null,
    visited_at: item.visited ?? null,
    review_created_at: raw,
    review_date: parseNaverReviewDate(raw, new Date()),
  };
}

/**
 * 플레이스 리뷰 증분 수집 핵심 함수.
 * Cron 재사용을 위해 핸들러에서 분리.
 *
// ─── Cron: 플레이스 리뷰 일일 자동 수집 ────────────────────────────────────

/** 1회 Cron 실행 시 처리할 최대 플레이스 수 */
const CRON_MAX_PLACES = 50;

/**
 * 모든 review_places를 last_collected_at 오래된 순(NULL 먼저)으로 최대 CRON_MAX_PLACES개 순회하며
 * 증분 수집 + 스냅샷 적재. scheduled 핸들러에서 ctx.waitUntil()로 호출.
 */
async function runDailyReviewCollection(env) {
  let places;
  try {
    const result = await env.DB.prepare(
      `SELECT id, place_id, business_type, name
         FROM review_places
        WHERE auto_collect = 1
        ORDER BY (last_collected_at IS NULL) DESC, last_collected_at ASC
        LIMIT ?`
    ).bind(CRON_MAX_PLACES).all();
    places = result.results ?? [];
  } catch (err) {
    console.error('[CRON] review_places 조회 실패:', err.message);
    return;
  }

  console.log(`[CRON] 시작 ${places.length}개`);

  let consecutiveBlocked = 0;
  let totalInserted = 0;
  let totalSkipped = 0;

  for (let i = 0; i < places.length; i++) {
    const place = places[i];

    // 플레이스 간 딜레이 2000ms (첫 건 제외)
    if (i > 0) {
      await new Promise((r) => setTimeout(r, 2000));
    }

    let result;
    try {
      result = await collectPlaceReviews(env, place, { maxPages: 3, source: 'cron' });
    } catch (err) {
      // collectPlaceReviews는 throw 안 하지만 혹시 모를 예외 대비
      console.error(`[CRON] place_id=${place.place_id} 예외:`, err.message);
      consecutiveBlocked++;
      if (consecutiveBlocked >= 2) {
        console.warn('[CRON] 연속 차단 감지 → 중단');
        break;
      }
      continue;
    }

    console.log(
      `[CRON] place_id=${result.place_id} inserted=${result.inserted} skipped=${result.skipped} blocked=${result.blocked}`
    );

    totalInserted += result.inserted;
    totalSkipped += result.skipped;

    // 연속 차단 카운터 관리
    if (result.blocked) {
      consecutiveBlocked++;
      if (consecutiveBlocked >= 2) {
        console.warn('[CRON] 연속 차단 감지 → 중단');
        break;
      }
    } else {
      consecutiveBlocked = 0;
    }

    // 스냅샷 적재: total_server가 null이면 스킵 (차단·오류로 유효값 없음)
    if (result.total_server == null) {
      continue;
    }

    try {
      const countRow = await env.DB.prepare(
        'SELECT COUNT(*) AS c FROM place_reviews WHERE place_row_id = ?'
      ).bind(place.id).first();
      const storedCount = countRow?.c ?? 0;

      await env.DB.prepare(
        `INSERT INTO place_review_snapshots (id, place_row_id, total_reviews, stored_count, captured_at)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(
        crypto.randomUUID(),
        place.id,
        result.total_server,
        storedCount,
        new Date().toISOString()
      ).run();
    } catch (err) {
      console.error(`[CRON] 스냅샷 적재 실패 place_id=${place.place_id}:`, err.message);
      // 스냅샷 실패는 치명적이지 않으므로 계속 진행
    }
  }

  console.log(`[CRON] 완료 총 inserted=${totalInserted} skipped=${totalSkipped}`);
}

// ────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} env         Worker env
 * @param {object} placeRow    { id, place_id, business_type, name } — DB 조회 row
 * @param {object} opts        { maxPages?, source? } (기본 maxPages 3, source 'manual')
 * @returns {Promise<{place_id, total_server, inserted, skipped, pages_fetched, blocked, error?}>}
 */
async function collectPlaceReviews(env, placeRow, opts = {}) {
  const maxPages = opts.maxPages ?? 3;
  const source = opts.source ?? 'manual';
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
           (id, place_row_id, naver_review_id, author_nick, body, has_photo, owner_reply, visited_at, review_created_at, review_date, collected_at, first_source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        r.review_date ?? null,
        now,
        source
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

  // 수집 이벤트 기록 (실패해도 결과에 영향 없음)
  try {
    await env.DB.prepare(
      `INSERT INTO place_collection_events
         (id, place_row_id, source, inserted, skipped, pages_fetched, total_server, blocked, error, collected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      crypto.randomUUID(),
      placeRowId,
      source,
      inserted,
      skipped,
      pagesFetched,
      totalServer,
      blocked ? 1 : 0,
      errorMsg ?? null,
      now
    ).run();
  } catch (err) {
    console.error(`[collectPlaceReviews] 이벤트 INSERT 실패: ${err.message}`);
  }

  return result;
}

/**
 * 플레이스 리뷰 백필 청크 함수.
 * 증분(collectPlaceReviews)과 달리 중복을 만나도 끝까지 진행하며 커서를 DB에 저장.
 * 한 호출 = 한 청크(여러 페이지). 프론트가 done=true 될 때까지 반복 호출.
 *
 * @param {object} env        Worker env
 * @param {object} placeRow   { id, place_id, business_type, name, backfill_cursor }
 * @param {object} opts       { maxPages? } (기본 5, 1~10 clamp)
 * @returns {Promise<{done, inserted, skipped, pages_fetched, blocked, error?, total_server, stored_count}>}
 */
async function backfillPlaceChunk(env, placeRow, opts = {}) {
  const maxPages = Math.min(Math.max(Math.floor(opts.maxPages ?? 5), 1), 10);
  const placeRowId = placeRow.id;
  const placeId = placeRow.place_id;
  const businessType = placeRow.business_type || 'place';

  // 시작 커서: 이전 청크에서 저장된 커서(없으면 null=처음부터)
  let after = placeRow.backfill_cursor ?? null;
  let totalServer = null;
  let firstBusinessName = null;
  let inserted = 0;
  let skipped = 0;
  let pagesFetched = 0;
  let blocked = false;
  let errorMsg = null;
  let done = false;
  const now = new Date().toISOString();

  for (let page = 1; page <= maxPages; page++) {
    // 페이지 간 딜레이 (첫 페이지 제외)
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
      // 커서는 마지막 성공 지점 유지 (after 갱신 안 함)
      break;
    }

    pagesFetched++;
    const { total, items } = visitorReviews;

    if (page === 1) {
      totalServer = total;
    }

    // 업체명 첫 발견 시 저장
    if (!firstBusinessName && items) {
      for (const item of items) {
        if (item.businessName) {
          firstBusinessName = item.businessName;
          break;
        }
      }
    }

    // items가 비었으면 백필 완료
    if (!items || items.length === 0) {
      done = true;
      break;
    }

    // INSERT OR IGNORE batch (collectPlaceReviews와 동일 패턴)
    const mapped = items.map(mapReviewItem);
    const stmts = mapped.map((r) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO place_reviews
           (id, place_row_id, naver_review_id, author_nick, body, has_photo, owner_reply, visited_at, review_created_at, review_date, collected_at, first_source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        r.review_date ?? null,
        now,
        'backfill'
      )
    );

    try {
      const batchResults = await env.DB.batch(stmts);
      const pageInserted = batchResults.reduce((sum, r) => sum + (r.meta?.changes ?? 0), 0);
      const pageSkipped = mapped.length - pageInserted;
      inserted += pageInserted;
      skipped += pageSkipped;
    } catch (err) {
      blocked = true;
      errorMsg = `DB batch 오류: ${err.message}`;
      break;
    }

    // 다음 커서 갱신 (이번 페이지 마지막 item.cursor)
    const nextCursor = items[items.length - 1]?.cursor ?? null;

    // 백필은 skipped여도 계속 진행(중복 무시, 끝까지).
    // 단 다음 커서가 없으면 완료.
    if (!nextCursor) {
      done = true;
      after = null;
      break;
    }

    after = nextCursor;

    // total 도달 확인
    if (totalServer !== null && inserted + skipped >= totalServer) {
      done = true;
      after = null;
      break;
    }
  }

  // review_places UPDATE: backfill 상태 + total_reviews + name 갱신
  try {
    await env.DB.prepare(
      `UPDATE review_places
       SET backfill_cursor     = ?,
           backfill_done       = ?,
           backfill_updated_at = ?,
           last_collected_at   = ?,
           total_reviews       = COALESCE(?, total_reviews),
           name                = COALESCE(?, name)
       WHERE id = ?`
    ).bind(
      done ? null : after,
      done ? 1 : 0,
      now,
      now,
      totalServer,
      firstBusinessName,
      placeRowId
    ).run();
  } catch (err) {
    console.error(`[backfillPlaceChunk] review_places UPDATE 실패: ${err.message}`);
  }

  // 수집 이벤트 기록 (source='backfill')
  try {
    await env.DB.prepare(
      `INSERT INTO place_collection_events
         (id, place_row_id, source, inserted, skipped, pages_fetched, total_server, blocked, error, collected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      crypto.randomUUID(),
      placeRowId,
      'backfill',
      inserted,
      skipped,
      pagesFetched,
      totalServer,
      blocked ? 1 : 0,
      errorMsg ?? null,
      now
    ).run();
  } catch (err) {
    console.error(`[backfillPlaceChunk] 이벤트 INSERT 실패: ${err.message}`);
  }

  // 보유수 계산
  let storedCount = 0;
  try {
    const countRow = await env.DB.prepare(
      'SELECT COUNT(*) AS c FROM place_reviews WHERE place_row_id = ?'
    ).bind(placeRowId).first();
    storedCount = countRow?.c ?? 0;
  } catch (err) {
    console.error(`[backfillPlaceChunk] COUNT 실패: ${err.message}`);
  }

  const result = {
    done,
    inserted,
    skipped,
    pages_fetched: pagesFetched,
    blocked,
    total_server: totalServer,
    stored_count: storedCount,
  };
  if (errorMsg) {
    result.error = errorMsg;
  }
  return result;
}

/**
 * POST /api/places/:id/backfill
 * 과거 리뷰 전체 수집 — 청크 단위 백필 트리거.
 * 프론트가 done=true 될 때까지 반복 호출하는 방식.
 * body(선택): { maxPages } (1~10 clamp, 기본 5)
 */
async function handleBackfillPlace(request, env, corsHeaders, placeRowId) {
  const cors = corsHeaders || {};

  const authResult = await requireApprovedUser(request, env);
  if (authResult.error) {
    return jsonResponse({ error: authResult.error, message: authResult.message }, authResult.status, cors);
  }

  // 플레이스 소유 확인 + backfill 관련 컬럼 포함
  let placeRow;
  try {
    placeRow = await env.DB.prepare(
      'SELECT id, place_id, business_type, name, user_id, backfill_cursor, backfill_done FROM review_places WHERE id = ?'
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

  // body(선택): maxPages 파싱 (1~10 clamp, 기본 5)
  let maxPages = 5;
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

  // 백필 청크 실행
  let result;
  try {
    result = await backfillPlaceChunk(env, placeRow, { maxPages });
  } catch (err) {
    return jsonResponse({ error: 'backfill_failed', message: err.message }, 500, cors);
  }

  // 차단 여부와 무관하게 200 반환 (프론트가 blocked·error 보고 판단)
  return jsonResponse(result, 200, cors);
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
    result = await collectPlaceReviews(env, placeRow, { maxPages, source: 'manual' });
  } catch (err) {
    return jsonResponse({ error: 'collect_failed', message: err.message }, 500, cors);
  }

  // 차단 여부와 무관하게 200 반환 (측정 데이터로 활용)
  return jsonResponse(result, 200, cors);
}

/**
 * GET /api/places/:id/collections?limit=
 * 수집 이력(place_collection_events) 조회
 */
async function handleGetCollections(request, env, corsHeaders, placeRowId) {
  const cors = corsHeaders || {};

  const authResult = await requireApprovedUser(request, env);
  if (authResult.error) {
    return jsonResponse({ error: authResult.error, message: authResult.message }, authResult.status, cors);
  }

  // 플레이스 소유 확인 (handleGetReviews 와 동일 패턴)
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

  // limit 파라미터 파싱 (기본 30, 최대 100)
  const url = new URL(request.url);
  let limit = 30;
  const limitParam = url.searchParams.get('limit');
  if (limitParam !== null) {
    const parsed = Number(limitParam);
    if (Number.isFinite(parsed) && parsed > 0) {
      limit = Math.min(Math.max(Math.floor(parsed), 1), 100);
    }
  }

  try {
    const { results } = await env.DB.prepare(
      `SELECT id, source, inserted, skipped, pages_fetched, total_server, blocked, error, collected_at
         FROM place_collection_events
        WHERE place_row_id = ?
        ORDER BY collected_at DESC
        LIMIT ?`
    ).bind(placeRowId, limit).all();

    return jsonResponse({ events: results ?? [] }, 200, cors);
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
  }
}

/**
 * POST /api/places/:id/auto-collect — 지점별 자동수집 on/off 토글.
 * body: { "auto_collect": 0 | 1 }
 * 소유 확인 필수 — 다른 사용자의 플레이스는 변경 불가.
 */
async function handleToggleAutoCollect(request, env, corsHeaders, placeRowId) {
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

  const autoCollect = body.auto_collect;
  if (autoCollect !== 0 && autoCollect !== 1) {
    return jsonResponse({ error: 'invalid_value', message: 'auto_collect 값은 0 또는 1이어야 합니다' }, 400, cors);
  }

  // 소유 확인 (handleDeletePlace 패턴과 동일)
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

  try {
    await env.DB.prepare(
      'UPDATE review_places SET auto_collect = ? WHERE id = ? AND user_id = ?'
    ).bind(autoCollect, placeRowId, authResult.user.id).run();
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
  }

  return jsonResponse({ updated: true, place_id: placeRowId, auto_collect: autoCollect }, 200, cors);
}

/**
 * [공통] 정량 지표 SQL 집계.
 * handleGetPlaceStats 와 handleGenerateReport 양쪽에서 재사용.
 * 반환: { stored_count, total_server, reply_count, reply_rate, photo_count, photo_rate,
 *          monthly, top_keywords, snapshots }
 * total_server 는 placeRow.total_reviews 를 받아서 채운다.
 */
async function computePlaceQuantitative(env, placeRowId, totalServer) {
  // 1) 기본 카운트 집계 (stored_count, reply_count, photo_count)
  const countRow = await env.DB.prepare(`
    SELECT
      COUNT(*)                                       AS stored_count,
      SUM(CASE WHEN owner_reply IS NOT NULL THEN 1 ELSE 0 END) AS reply_count,
      SUM(CASE WHEN has_photo = 1 THEN 1 ELSE 0 END)           AS photo_count
    FROM place_reviews
    WHERE place_row_id = ?
  `).bind(placeRowId).first();

  const storedCount  = countRow?.stored_count  ?? 0;
  const replyCount   = countRow?.reply_count   ?? 0;
  const photoCount   = countRow?.photo_count   ?? 0;
  const replyRate    = storedCount > 0 ? replyCount / storedCount : 0;
  const photoRate    = storedCount > 0 ? photoCount / storedCount : 0;

  // 2) 월별 분포 (최근 12개월, review_date ISO 기준)
  const { results: monthlyRows } = await env.DB.prepare(`
    SELECT substr(review_date, 1, 7) AS month, COUNT(*) AS count
    FROM place_reviews
    WHERE place_row_id = ?
      AND review_date IS NOT NULL
      AND review_date >= date('now', '-12 months')
    GROUP BY month
    ORDER BY month ASC
  `).bind(placeRowId).all();

  // 3) 리뷰 본문 수집 (최근 collected_at 기준 LIMIT 1000)
  const { results: bodyRows } = await env.DB.prepare(`
    SELECT body FROM place_reviews
    WHERE place_row_id = ? AND body IS NOT NULL AND body != ''
    ORDER BY collected_at DESC
    LIMIT 1000
  `).bind(placeRowId).all();

  // MVP 단순 빈도 — 정밀 분석은 Phase 4 AI 예정
  const STOPWORDS = new Set([
    '너무','정말','진짜','그리고','하지만','에서','으로','합니다','했어요','같아요','있어요',
    '너무너무','조금','약간','매우','아주','그냥','근데','그래서','이런','저런','여기','거기',
    '이곳','저곳','이거','저거','이게','저게','것도','것은','것이','것을','것만','것같아요',
    '같은','같이','처럼','부터','까지','이나','또는','그냥','뭔가','어서','이라','에도',
    '하고','않고','않아요','없어요','없는','있는','이번','다음','가장','때문','때문에',
    '하나','하는','하는데','해서','해요','해도','했는데','했어','이렇게','저렇게','어떻게',
    '너무나','좀더','더욱','매번','항상','자주','가끔','이미','벌써','항상','절대','역시',
  ]);

  const wordFreq = new Map();
  for (const row of bodyRows) {
    if (!row.body) continue;
    // 공백·문장부호 기준 토큰화
    const tokens = row.body.split(/[\s.,!?;:·""''()\[\]{}<>/\\|@#$%^&*+=~`\-—–…]+/u);
    for (const token of tokens) {
      const word = token.trim();
      // 2글자 이상, 숫자·한 글자 제거, 불용어 제거
      if (word.length < 2) continue;
      if (/^\d+$/.test(word)) continue;
      if (STOPWORDS.has(word)) continue;
      wordFreq.set(word, (wordFreq.get(word) ?? 0) + 1);
    }
  }

  // 상위 15개 내림차순
  const topKeywords = Array.from(wordFreq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([word, count]) => ({ word, count }));

  // 4) 스냅샷 추이 (최근 60개)
  const { results: snapshots } = await env.DB.prepare(`
    SELECT captured_at, total_reviews, stored_count
    FROM place_review_snapshots
    WHERE place_row_id = ?
    ORDER BY captured_at ASC
    LIMIT 60
  `).bind(placeRowId).all();

  return {
    stored_count:  storedCount,
    total_server:  totalServer ?? null,
    reply_count:   replyCount,
    reply_rate:    replyRate,
    photo_count:   photoCount,
    photo_rate:    photoRate,
    monthly:       monthlyRows ?? [],
    top_keywords:  topKeywords,
    snapshots:     snapshots ?? [],
  };
}

/**
 * GET /api/places/:id/stats
 * 지점별 미니 통계 대시보드 집계.
 * 응답: stored_count, total_server, reply_count, reply_rate, photo_count, photo_rate,
 *       monthly([{month,count}]), top_keywords([{word,count}]), snapshots([{captured_at,total_reviews,stored_count}])
 */
async function handleGetPlaceStats(request, env, corsHeaders, placeRowId) {
  const cors = corsHeaders || {};

  const authResult = await requireApprovedUser(request, env);
  if (authResult.error) {
    return jsonResponse({ error: authResult.error, message: authResult.message }, authResult.status, cors);
  }

  // 플레이스 소유 확인 (handleGetCollections 패턴과 동일)
  let placeRow;
  try {
    placeRow = await env.DB.prepare(
      'SELECT id, user_id, total_reviews FROM review_places WHERE id = ?'
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

  try {
    const quant = await computePlaceQuantitative(env, placeRowId, placeRow.total_reviews);
    return jsonResponse(quant, 200, cors);
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
  }
}

/**
 * DELETE /api/places/:id
 * 플레이스 + 연관 데이터(place_reviews, place_collection_events, place_review_snapshots) cascade 삭제.
 * 소유 확인 필수 — 다른 사용자의 플레이스는 삭제 불가.
 */
async function handleDeletePlace(request, env, corsHeaders, placeRowId) {
  const cors = corsHeaders || {};

  const authResult = await requireApprovedUser(request, env);
  if (authResult.error) {
    return jsonResponse({ error: authResult.error, message: authResult.message }, authResult.status, cors);
  }

  // 소유 확인 (handleCollectPlace 패턴과 동일)
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

  // 자식부터 부모 순서로 cascade 삭제 — batch로 한 번에 실행
  let batchResults;
  try {
    batchResults = await env.DB.batch([
      env.DB.prepare('DELETE FROM place_reviews WHERE place_row_id = ?').bind(placeRowId),
      env.DB.prepare('DELETE FROM place_collection_events WHERE place_row_id = ?').bind(placeRowId),
      env.DB.prepare('DELETE FROM place_review_snapshots WHERE place_row_id = ?').bind(placeRowId),
      env.DB.prepare('DELETE FROM place_insights WHERE place_row_id = ?').bind(placeRowId),
      env.DB.prepare('DELETE FROM place_generated_samples WHERE place_row_id = ?').bind(placeRowId),
      env.DB.prepare('DELETE FROM llm_usage WHERE place_row_id = ?').bind(placeRowId),
      // user_id 조건 이중 방어 (소유 확인을 이미 했지만 파괴적 작업이므로 한 번 더)
      env.DB.prepare('DELETE FROM review_places WHERE id = ? AND user_id = ?').bind(placeRowId, authResult.user.id),
    ]);
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
  }

  const [reviewsResult, eventsResult, snapshotsResult, placeResult] = batchResults;

  return jsonResponse({
    deleted: true,
    place_id: placeRowId,
    reviews_deleted: reviewsResult.meta?.changes ?? 0,
    events_deleted: eventsResult.meta?.changes ?? 0,
    snapshots_deleted: snapshotsResult.meta?.changes ?? 0,
  }, 200, cors);
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

// 연구원 게이트: requireApprovedUser 통과 + user.role이 'admin' 또는 'researcher'면 통과.
// 통과 시 { user } / 실패 시 { error, status, message }.
async function requireResearcher(request, env) {
  const authResult = await requireApprovedUser(request, env);
  if (authResult.error) return authResult;
  const role = authResult.user.role;
  if (role !== 'admin' && role !== 'researcher') {
    return { error: 'forbidden', status: 403, message: '연구원(researcher) 이상 권한이 필요합니다' };
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
      `SELECT id, email, name, picture, status, plan, role, created_at, last_login_at, approved_at, admin_memo
       FROM users ORDER BY created_at DESC`
    ).all();

    // ADMIN_EMAILS에 있으면 'admin' 우선 부여, 아니면 DB role 사용 (null → 'user')
    const adminEmails = (env.ADMIN_EMAILS || '').split(',').map(s => s.trim()).filter(Boolean);
    const users = (results ?? []).map(u => ({
      ...u,
      role: adminEmails.includes(u.email)
        ? 'admin'
        : (u.role === 'researcher' ? 'researcher' : 'user'),
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

// POST /api/admin/users/:id/memo — 관리자 메모 저장
// body: { memo: string }  빈 문자열=삭제, 최대 1000자(초과 시 잘라 저장)
async function handleAdminSetMemo(request, env, corsHeaders, targetUserId) {
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

  const rawMemo = body?.memo;
  if (typeof rawMemo !== 'string') {
    return jsonResponse({ error: 'invalid_memo', message: 'memo는 string이어야 합니다' }, 400, cors);
  }

  // 대상 사용자 존재 확인
  let target;
  try {
    target = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(targetUserId).first();
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
  }
  if (!target) {
    return jsonResponse({ error: 'user_not_found', message: '대상 사용자를 찾을 수 없습니다' }, 404, cors);
  }

  // 빈 문자열은 null로 저장(삭제), 1000자 초과 시 잘라 저장
  const trimmed = rawMemo.trim();
  const memoValue = trimmed === '' ? null : trimmed.slice(0, 1000);

  try {
    await env.DB.prepare('UPDATE users SET admin_memo = ? WHERE id = ?').bind(memoValue, targetUserId).run();
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
  }

  return jsonResponse({ id: targetUserId, admin_memo: memoValue }, 200, cors);
}

// POST /api/admin/users/:id/role — 사용자 role 변경 (admin 전용)
// body: { role: 'user' | 'researcher' | 'admin' }
// 본인을 admin 아닌 role로 강등 불가.
async function handleAdminSetRole(request, env, corsHeaders, targetUserId) {
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

  const newRole = body?.role;
  const ALLOWED_ROLES = ['user', 'researcher', 'admin'];
  if (!ALLOWED_ROLES.includes(newRole)) {
    return jsonResponse(
      { error: 'invalid_role', message: `role은 ${ALLOWED_ROLES.join(' | ')} 중 하나여야 합니다` },
      400,
      cors
    );
  }

  // 대상 사용자 존재 확인
  let target;
  try {
    target = await env.DB.prepare('SELECT id, email FROM users WHERE id = ?').bind(targetUserId).first();
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
  }
  if (!target) {
    return jsonResponse({ error: 'user_not_found', message: '대상 사용자를 찾을 수 없습니다' }, 404, cors);
  }

  // 본인 강등 방지: admin이 자기 자신을 admin 아닌 role로 내리는 것 차단
  if (target.id === authResult.user.id && newRole !== 'admin') {
    return jsonResponse(
      { error: 'cannot_demote_self', message: '본인 계정의 role은 변경할 수 없습니다' },
      400,
      cors
    );
  }

  // ADMIN_EMAILS에 포함된 사용자는 DB role 변경해도 런타임에 항상 admin으로 계산됨 — 그대로 저장만 함
  try {
    await env.DB.prepare('UPDATE users SET role = ? WHERE id = ?').bind(newRole, targetUserId).run();
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
  }

  return jsonResponse({ ok: true, id: targetUserId, role: newRole }, 200, cors);
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

// --- Phase 4-3: 리뷰 예시 생성 (연구용·관리자 전용) ---

/** 스타일 축 정의 */
const SAMPLE_LENGTHS = ['short', 'medium', 'long'];
const SAMPLE_TONES   = ['friendly', 'polite', 'emotional', 'plain'];
const SAMPLE_FOCUSES = ['outcome', 'service', 'space', 'price', 'revisit'];

/** few-shot 표본 최대 건수 */
const SAMPLE_FEW_SHOT_SIZE = 25;

/** fact pool 상위 키워드 수 */
const SAMPLE_FACT_POOL_SIZE = 25;

/**
 * count 개의 스타일 조합을 골고루 분산 생성.
 * 세 축을 독립 순환(라운드로빈)하면서 최대 다양성을 유지.
 * @param {number} count
 * @returns {{ length: string, tone: string, focus: string }[]}
 */
function buildStyleAssignments(count) {
  const assignments = [];
  // 각 축을 개별 순환 인덱스로 돌려 중복 최소화
  for (let i = 0; i < count; i++) {
    assignments.push({
      length: SAMPLE_LENGTHS[i % SAMPLE_LENGTHS.length],
      tone:   SAMPLE_TONES[i   % SAMPLE_TONES.length],
      focus:  SAMPLE_FOCUSES[i % SAMPLE_FOCUSES.length],
    });
  }
  // 피셔-예이츠 셔플로 예측 가능한 순서 탈피
  for (let i = assignments.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [assignments[i], assignments[j]] = [assignments[j], assignments[i]];
  }
  return assignments;
}

/**
 * fact pool(허용 소재 키워드 목록) 추출.
 * computePlaceQuantitative 의 STOPWORDS + 토큰화 로직을 재사용해 상위 N개 반환.
 * @param {object} env
 * @param {string} placeRowId
 * @param {number} topN
 * @returns {Promise<string[]>} 단어 배열 (빈도 내림차순)
 */
async function extractFactPool(env, placeRowId, topN = SAMPLE_FACT_POOL_SIZE) {
  const { results: bodyRows } = await env.DB.prepare(`
    SELECT body FROM place_reviews
    WHERE place_row_id = ? AND body IS NOT NULL AND body != ''
    ORDER BY collected_at DESC
    LIMIT 1000
  `).bind(placeRowId).all();

  const STOPWORDS = new Set([
    '너무','정말','진짜','그리고','하지만','에서','으로','합니다','했어요','같아요','있어요',
    '너무너무','조금','약간','매우','아주','그냥','근데','그래서','이런','저런','여기','거기',
    '이곳','저곳','이거','저거','이게','저게','것도','것은','것이','것을','것만','것같아요',
    '같은','같이','처럼','부터','까지','이나','또는','그냥','뭔가','어서','이라','에도',
    '하고','않고','않아요','없어요','없는','있는','이번','다음','가장','때문','때문에',
    '하나','하는','하는데','해서','해요','해도','했는데','했어','이렇게','저렇게','어떻게',
    '너무나','좀더','더욱','매번','항상','자주','가끔','이미','벌써','항상','절대','역시',
  ]);

  const wordFreq = new Map();
  for (const row of bodyRows) {
    if (!row.body) continue;
    const tokens = row.body.split(/[\s.,!?;:·""''()\[\]{}<>/\\|@#$%^&*+=~`\-—–…]+/u);
    for (const token of tokens) {
      const word = token.trim();
      if (word.length < 2) continue;
      if (/^\d+$/.test(word)) continue;
      if (STOPWORDS.has(word)) continue;
      wordFreq.set(word, (wordFreq.get(word) ?? 0) + 1);
    }
  }

  return Array.from(wordFreq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([word]) => word);
}

/**
 * GPT gpt-5.4-mini 호출 — 리뷰 예시 대량 생성 (환각방지 프롬프트).
 * structured output: response_format {type:"json_object"}.
 * 파싱 실패 1회 재시도.
 * @param {object} env
 * @param {{ placeName, businessType, factPool: string[], fewShotReviews: string[], styles: {length,tone,focus}[] }} params
 * @returns {Promise<{index:number, body:string}[]>}
 */
async function callOpenAIForSamples(env, { placeName, businessType, factPool, fewShotReviews, styles }) {
  const styleLine = (s, i) =>
    `${i + 1}번: length=${s.length} / tone=${s.tone} / focus=${s.focus}`;

  const systemPrompt = `너는 실제 방문자가 직접 쓴 것 같은 한국어 리뷰를 생성한다. 광고스럽거나 AI가 쓴 티가 나면 실패다. 연구용 합성 데이터이며 관리자 전용이다.

[절대 금지]
- 본문에 업체 이름·지점명을 절대 쓰지 마라. 실제 방문자는 자기 리뷰에 가게 풀네임을 안 쓴다. 지칭이 필요하면 "여기", "이곳", "이 병원", "이 집" 정도만 사용.
- "친절했습니다", "꼼꼼하게", "안심이 됐습니다", "만족스러웠습니다" 같은 추상 칭찬만 나열 금지. 반드시 아래 fact pool의 구체 항목 1~2개를 자연스럽게 녹여라.
- 광고체·홍보체 문장("강력 추천!", "최고의 선택!") 금지.
- 별점·평점 언급 금지(네이버 별점 폐지됨).
- 모든 예시가 동일한 구조나 문장 패턴으로 시작/끝나지 않게 다양하게.

[구체성 필수]
fact pool(허용 소재)에 있는 구체 항목(시술명, 메뉴명, 직원 호칭, 특징어 등)을 1~2개 자연스럽게 녹여라. fact pool에 없는 메뉴·상품·시술명을 지어내지 말 것.

[실제 말투 모사]
아래 제공되는 실제 리뷰 예시들의 어투·문장 호흡·구어체를 모사하라. 실제 사람은:
- 한두 가지에 집중하고 나머지는 생략한다
- 구어체를 쓴다 ("~했어요", "~더라구요", "~인 것 같아요", "~거 같음")
- 가끔 짧게 끊거나 말이 완결되지 않기도 한다
- 문장이 너무 매끄럽지 않고 날것이다

[길이 엄수]
- short: 1문장(40자 내외). 딱 한 마디.
- medium: 2~3문장. 핵심 + 간단한 부연.
- long: 5문장 이상. 여러 측면을 자연스럽게 풀어냄.

[focus 정의 — 지정된 focus 측면을 중심으로 작성]
- outcome: 핵심 경험·결과. 식당=음식 맛, 병원=시술 결과·효과, 카페=음료·디저트
- service: 직원 응대·상담·친절
- space: 시설·청결·분위기·인테리어
- price: 가격·가성비·이벤트·혜택
- revisit: 재방문 의사·주변 추천

[업종 맥락 유지]
업종(business_type) 맥락을 지킬 것. 병원 리뷰에 음식 맛 언급, 식당 리뷰에 시술 언급 같은 소재 혼입 금지.

[출력 형식]
반드시 JSON 객체만: { "samples": [ { "index": 번호, "body": "리뷰 본문" } ] }
표본 리뷰와 완전히 동일한 문장 복사 금지. 소재·톤·맥락은 참고 가능.`;

  const factPoolText = factPool.length > 0
    ? `[허용 소재(fact pool) — 본문에 자연스럽게 녹일 수 있는 실제 소재 목록]\n${factPool.join(', ')}`
    : '[허용 소재(fact pool)]\n(리뷰 본문 없음 — 업종 일반 상식 범위 내에서만 작성)';

  const fewShotText = fewShotReviews.length > 0
    ? `[실제 리뷰 예시 — 어투·문장 호흡·구어체 참고용. 문장 그대로 복사 금지]\n${fewShotReviews.map((r, i) => `(${i + 1}) ${r}`).join('\n')}`
    : '[실제 리뷰 예시: 없음]';

  const stylesText = styles.map(styleLine).join('\n');

  const userPrompt = `[업체 정보 — 맥락 참고용. 본문에 업체명·지점명을 직접 쓰지 말 것]
업체명: ${placeName}
업종: ${businessType || '미분류'}

${factPoolText}

${fewShotText}

[생성할 리뷰 목록]
${stylesText}

위 ${styles.length}개 리뷰를 생성해서 JSON으로 응답하시오.`;

  // count가 많아지면 토큰을 넉넉하게
  const maxTokens = Math.max(2000, styles.length * 250);

  const body = {
    model: 'gpt-5.4-mini',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt },
    ],
    temperature: 0.9,
    max_completion_tokens: maxTokens,
  };

  async function fetchOnce() {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`OpenAI API 오류 ${resp.status}: ${errText.slice(0, 200)}`);
    }

    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error('OpenAI 응답에 content가 없습니다');

    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed?.samples)) throw new Error('GPT 응답 구조 오류: samples 배열 없음');
    const usage = {
      prompt_tokens:     data?.usage?.prompt_tokens     ?? 0,
      completion_tokens: data?.usage?.completion_tokens ?? 0,
    };
    return { samples: parsed.samples, usage };
  }

  // 1차 시도
  try {
    return await fetchOnce();
  } catch (firstErr) {
    if (firstErr instanceof SyntaxError) {
      return await fetchOnce();
    }
    throw firstErr;
  }
}

/**
 * 멀티 provider 추상화 — 리뷰 예시 생성 LLM 호출.
 * provider: 'openai' | 'anthropic' | 'xai'
 * model: 생략 시 PROVIDER_DEFAULT_MODEL[provider] 사용.
 * 반환: { gptSamples: [{index, body}], usage: { prompt_tokens, completion_tokens } }
 */
async function callLLMForSamples(env, provider, model, { systemPrompt, userPrompt, count }) {
  const maxTokens = Math.max(2000, count * 250);

  if (provider === 'openai') {
    if (!env.OPENAI_API_KEY) throw Object.assign(new Error('OpenAI API 키가 설정되지 않았습니다'), { code: 'no_openai_key' });

    const body = {
      model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt },
      ],
      temperature: 0.9,
      max_completion_tokens: maxTokens,
    };

    async function fetchOnceOpenAI() {
      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`OpenAI API 오류 ${resp.status}: ${errText.slice(0, 200)}`);
      }
      const data = await resp.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new Error('OpenAI 응답에 content가 없습니다');
      const parsed = JSON.parse(content);
      if (!Array.isArray(parsed?.samples)) throw new Error('OpenAI 응답 구조 오류: samples 배열 없음');
      return {
        gptSamples: parsed.samples,
        usage: {
          prompt_tokens:     data?.usage?.prompt_tokens     ?? 0,
          completion_tokens: data?.usage?.completion_tokens ?? 0,
        },
      };
    }

    try {
      return await fetchOnceOpenAI();
    } catch (firstErr) {
      if (firstErr instanceof SyntaxError) return await fetchOnceOpenAI();
      throw firstErr;
    }
  }

  if (provider === 'xai') {
    if (!env.XAI_API_KEY) throw Object.assign(new Error('xAI API 키가 설정되지 않았습니다'), { code: 'no_xai_key' });

    const body = {
      model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt },
      ],
      temperature: 0.9,
      max_completion_tokens: maxTokens,
    };

    async function fetchOnceXAI() {
      const resp = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.XAI_API_KEY}`,
        },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`xAI API 오류 ${resp.status}: ${errText.slice(0, 200)}`);
      }
      const data = await resp.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new Error('xAI 응답에 content가 없습니다');
      const parsed = JSON.parse(content);
      if (!Array.isArray(parsed?.samples)) throw new Error('xAI 응답 구조 오류: samples 배열 없음');
      return {
        gptSamples: parsed.samples,
        usage: {
          prompt_tokens:     data?.usage?.prompt_tokens     ?? 0,
          completion_tokens: data?.usage?.completion_tokens ?? 0,
        },
      };
    }

    try {
      return await fetchOnceXAI();
    } catch (firstErr) {
      if (firstErr instanceof SyntaxError) return await fetchOnceXAI();
      throw firstErr;
    }
  }

  if (provider === 'anthropic') {
    if (!env.ANTHROPIC_API_KEY) throw Object.assign(new Error('Anthropic API 키가 설정되지 않았습니다'), { code: 'no_anthropic_key' });

    const anthropicBody = {
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [
        { role: 'user', content: userPrompt },
      ],
      tools: [
        {
          name: 'emit_samples',
          description: '생성한 리뷰 예시 목록을 반환한다',
          input_schema: {
            type: 'object',
            properties: {
              samples: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    index: { type: 'integer' },
                    body:  { type: 'string' },
                  },
                  required: ['index', 'body'],
                },
              },
            },
            required: ['samples'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'emit_samples' },
      temperature: 0.9,
    };

    async function fetchOnceAnthropic() {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type':    'application/json',
          'x-api-key':       env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(anthropicBody),
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`Anthropic API 오류 ${resp.status}: ${errText.slice(0, 200)}`);
      }
      const data = await resp.json();
      // tool_use 블록에서 input 추출
      const toolBlock = Array.isArray(data?.content)
        ? data.content.find(b => b.type === 'tool_use' && b.name === 'emit_samples')
        : null;
      if (!toolBlock?.input) throw new Error('Anthropic 응답에 emit_samples tool_use 블록이 없습니다');
      const parsed = toolBlock.input;
      if (!Array.isArray(parsed?.samples)) throw new Error('Anthropic 응답 구조 오류: samples 배열 없음');
      return {
        gptSamples: parsed.samples,
        usage: {
          prompt_tokens:     data?.usage?.input_tokens  ?? 0,
          completion_tokens: data?.usage?.output_tokens ?? 0,
        },
      };
    }

    return await fetchOnceAnthropic();
  }

  throw new Error(`지원하지 않는 provider: ${provider}`);
}

/**
 * POST /api/places/:id/generate-samples  (researcher 이상)
 * fact pool 추출 → few-shot 표본 선정 → 스타일 조합 → GPT 생성 → DB 저장 → 반환.
 */
async function handleGenerateSamples(request, env, corsHeaders, placeRowId) {
  const cors = corsHeaders || {};

  // researcher 이상 (admin 포함)
  const authResult = await requireResearcher(request, env);
  if (authResult.error) {
    return jsonResponse({ error: authResult.error, message: authResult.message }, authResult.status, cors);
  }

  // 요청 body 파싱
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'invalid_json', message: 'Request body must be valid JSON' }, 400, cors);
  }

  // provider / model 파싱
  const VALID_PROVIDERS = ['openai', 'anthropic', 'xai'];
  const provider = body?.provider ?? 'openai';
  if (!VALID_PROVIDERS.includes(provider)) {
    return jsonResponse(
      { error: 'invalid_provider', message: `provider는 ${VALID_PROVIDERS.join(' | ')} 중 하나여야 합니다` },
      400,
      cors
    );
  }

  // provider별 API 키 사전 확인
  const keyCheck = {
    openai:    { key: env.OPENAI_API_KEY,    code: 'no_openai_key',    msg: 'OpenAI API 키가 설정되지 않았습니다' },
    anthropic: { key: env.ANTHROPIC_API_KEY, code: 'no_anthropic_key', msg: 'Anthropic API 키가 설정되지 않았습니다' },
    xai:       { key: env.XAI_API_KEY,       code: 'no_xai_key',       msg: 'xAI API 키가 설정되지 않았습니다' },
  };
  const { key: providerKey, code: keyErrorCode, msg: keyErrorMsg } = keyCheck[provider];
  if (!providerKey) {
    return jsonResponse({ error: keyErrorCode, message: keyErrorMsg }, 503, cors);
  }

  const model = (typeof body?.model === 'string' && body.model.trim())
    ? body.model.trim()
    : PROVIDER_DEFAULT_MODEL[provider];

  // count 파싱 (기본 10, clamp 1~30)
  let count = body?.count ?? 10;
  if (typeof count !== 'number' || !Number.isFinite(count)) count = 10;
  count = Math.max(1, Math.min(30, Math.floor(count)));

  // 플레이스 소유 확인 (관리자이므로 user_id 비교 없이 존재만 확인)
  let placeRow;
  try {
    placeRow = await env.DB.prepare(
      'SELECT id, user_id, name, business_type FROM review_places WHERE id = ?'
    ).bind(placeRowId).first();
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
  }

  if (!placeRow) {
    return jsonResponse({ error: 'place_not_found', message: '등록된 플레이스를 찾을 수 없습니다' }, 404, cors);
  }

  // fact pool 추출
  let factPool;
  try {
    factPool = await extractFactPool(env, placeRowId, SAMPLE_FACT_POOL_SIZE);
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
  }

  // few-shot 표본 선정: length >= 30, review_date DESC
  let fewShotReviews;
  try {
    const { results } = await env.DB.prepare(`
      SELECT body
      FROM place_reviews
      WHERE place_row_id = ?
        AND body IS NOT NULL
        AND length(body) >= 30
      ORDER BY review_date DESC
      LIMIT ?
    `).bind(placeRowId, SAMPLE_FEW_SHOT_SIZE).all();
    fewShotReviews = results ?? [];
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
  }

  if (fewShotReviews.length === 0) {
    return jsonResponse(
      { error: 'no_sample', message: '분석할 30자 이상 리뷰가 없습니다' },
      400,
      cors
    );
  }

  // 스타일 조합 생성
  const styleAssignments = buildStyleAssignments(count);

  // 공용 프롬프트 구성 (callOpenAIForSamples의 로직 재사용)
  const styleLine = (s, i) =>
    `${i + 1}번: length=${s.length} / tone=${s.tone} / focus=${s.focus}`;

  const systemPrompt = `너는 실제 방문자가 직접 쓴 것 같은 한국어 리뷰를 생성한다. 광고스럽거나 AI가 쓴 티가 나면 실패다. 연구용 합성 데이터이며 관리자 전용이다.

[절대 금지]
- 본문에 업체 이름·지점명을 절대 쓰지 마라. 실제 방문자는 자기 리뷰에 가게 풀네임을 안 쓴다. 지칭이 필요하면 "여기", "이곳", "이 병원", "이 집" 정도만 사용.
- "친절했습니다", "꼼꼼하게", "안심이 됐습니다", "만족스러웠습니다" 같은 추상 칭찬만 나열 금지. 반드시 아래 fact pool의 구체 항목 1~2개를 자연스럽게 녹여라.
- 광고체·홍보체 문장("강력 추천!", "최고의 선택!") 금지.
- 별점·평점 언급 금지(네이버 별점 폐지됨).
- 모든 예시가 동일한 구조나 문장 패턴으로 시작/끝나지 않게 다양하게.

[구체성 필수]
fact pool(허용 소재)에 있는 구체 항목(시술명, 메뉴명, 직원 호칭, 특징어 등)을 1~2개 자연스럽게 녹여라. fact pool에 없는 메뉴·상품·시술명을 지어내지 말 것.

[실제 말투 모사]
아래 제공되는 실제 리뷰 예시들의 어투·문장 호흡·구어체를 모사하라. 실제 사람은:
- 한두 가지에 집중하고 나머지는 생략한다
- 구어체를 쓴다 ("~했어요", "~더라구요", "~인 것 같아요", "~거 같음")
- 가끔 짧게 끊거나 말이 완결되지 않기도 한다
- 문장이 너무 매끄럽지 않고 날것이다

[길이 엄수]
- short: 1문장(40자 내외). 딱 한 마디.
- medium: 2~3문장. 핵심 + 간단한 부연.
- long: 5문장 이상. 여러 측면을 자연스럽게 풀어냄.

[focus 정의 — 지정된 focus 측면을 중심으로 작성]
- outcome: 핵심 경험·결과. 식당=음식 맛, 병원=시술 결과·효과, 카페=음료·디저트
- service: 직원 응대·상담·친절
- space: 시설·청결·분위기·인테리어
- price: 가격·가성비·이벤트·혜택
- revisit: 재방문 의사·주변 추천

[업종 맥락 유지]
업종(business_type) 맥락을 지킬 것. 병원 리뷰에 음식 맛 언급, 식당 리뷰에 시술 언급 같은 소재 혼입 금지.

[출력 형식]
반드시 JSON 객체만: { "samples": [ { "index": 번호, "body": "리뷰 본문" } ] }
표본 리뷰와 완전히 동일한 문장 복사 금지. 소재·톤·맥락은 참고 가능.`;

  const factPoolText = factPool.length > 0
    ? `[허용 소재(fact pool) — 본문에 자연스럽게 녹일 수 있는 실제 소재 목록]\n${factPool.join(', ')}`
    : '[허용 소재(fact pool)]\n(리뷰 본문 없음 — 업종 일반 상식 범위 내에서만 작성)';

  const fewShotText = fewShotReviews.length > 0
    ? `[실제 리뷰 예시 — 어투·문장 호흡·구어체 참고용. 문장 그대로 복사 금지]\n${fewShotReviews.map((r, i) => `(${i + 1}) ${r.body}`).join('\n')}`
    : '[실제 리뷰 예시: 없음]';

  const stylesText = styleAssignments.map(styleLine).join('\n');

  const userPrompt = `[업체 정보 — 맥락 참고용. 본문에 업체명·지점명을 직접 쓰지 말 것]
업체명: ${placeRow.name ?? ''}
업종: ${placeRow.business_type || '미분류'}

${factPoolText}

${fewShotText}

[생성할 리뷰 목록]
${stylesText}

위 ${styleAssignments.length}개 리뷰를 생성해서 JSON으로 응답하시오.`;

  // LLM 호출 (provider 분기)
  let gptSamples;
  let samplesUsage = { prompt_tokens: 0, completion_tokens: 0 };
  try {
    const result = await callLLMForSamples(env, provider, model, {
      systemPrompt,
      userPrompt,
      count,
    });
    gptSamples   = result.gptSamples;
    samplesUsage = result.usage;
  } catch (err) {
    // 키 에러는 503, 나머지는 502
    if (err.code && err.code.startsWith('no_')) {
      return jsonResponse({ error: err.code, message: err.message }, 503, cors);
    }
    return jsonResponse({ error: 'llm_error', message: err.message }, 502, cors);
  }

  const generatedAt = new Date().toISOString();

  const samplesCostUsd = computeCostUsd(model, samplesUsage.prompt_tokens, samplesUsage.completion_tokens);

  // DB 저장 + 응답 샘플 조립
  const samples = [];
  const insertStmts = [];

  for (let i = 0; i < styleAssignments.length; i++) {
    const style = styleAssignments[i];
    // LLM 응답에서 index 매칭 (1-based). 없으면 순서대로 사용.
    const gptItem = gptSamples.find(s => s.index === i + 1) ?? gptSamples[i];
    if (!gptItem?.body) continue;

    const sampleId = crypto.randomUUID();
    samples.push({
      id:       sampleId,
      body:     gptItem.body,
      length:   style.length,
      tone:     style.tone,
      focus:    style.focus,
      status:   'active',
      provider,
      model,
    });
    insertStmts.push(
      env.DB.prepare(`
        INSERT INTO place_generated_samples
          (id, place_row_id, body, style_length, style_tone, style_focus, model, provider, created_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
      `).bind(sampleId, placeRowId, gptItem.body, style.length, style.tone, style.focus, model, provider, generatedAt)
    );
  }

  // llm_usage INSERT
  const usageId = crypto.randomUUID();
  insertStmts.push(
    env.DB.prepare(`
      INSERT INTO llm_usage (id, place_row_id, kind, provider, model, prompt_tokens, completion_tokens, cost_usd, created_at)
      VALUES (?, ?, 'samples', ?, ?, ?, ?, ?, ?)
    `).bind(usageId, placeRowId, provider, model, samplesUsage.prompt_tokens, samplesUsage.completion_tokens, samplesCostUsd, generatedAt)
  );

  try {
    await env.DB.batch(insertStmts);
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
  }

  return jsonResponse({
    place_name:   placeRow.name ?? '',
    provider,
    model,
    generated_at: generatedAt,
    samples,
    usage: {
      prompt_tokens:     samplesUsage.prompt_tokens,
      completion_tokens: samplesUsage.completion_tokens,
      cost_usd:          samplesCostUsd,
    },
  }, 200, cors);
}

/**
 * GET /api/places/:id/samples  (researcher 이상)
 * 저장된 생성 예시 최근순 반환.
 */
async function handleGetSamples(request, env, corsHeaders, placeRowId) {
  const cors = corsHeaders || {};

  // researcher 이상 (admin 포함)
  const authResult = await requireResearcher(request, env);
  if (authResult.error) {
    return jsonResponse({ error: authResult.error, message: authResult.message }, authResult.status, cors);
  }

  // 플레이스 존재 확인
  let placeRow;
  try {
    placeRow = await env.DB.prepare(
      'SELECT id FROM review_places WHERE id = ?'
    ).bind(placeRowId).first();
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
  }

  if (!placeRow) {
    return jsonResponse({ error: 'place_not_found', message: '등록된 플레이스를 찾을 수 없습니다' }, 404, cors);
  }

  // ?status= 필터 (없으면 전체 반환)
  const urlObj = new URL(request.url);
  const statusFilter = urlObj.searchParams.get('status');
  const VALID_STATUSES = ['active', 'kept', 'archived'];
  if (statusFilter && !VALID_STATUSES.includes(statusFilter)) {
    return jsonResponse({ error: 'invalid_status', message: 'status는 active | kept | archived 중 하나여야 합니다' }, 400, cors);
  }

  let results;
  try {
    const sql = statusFilter
      ? `SELECT id, body, style_length AS length, style_tone AS tone,
                style_focus AS focus, status, provider, model, created_at
         FROM place_generated_samples
         WHERE place_row_id = ? AND status = ?
         ORDER BY created_at DESC`
      : `SELECT id, body, style_length AS length, style_tone AS tone,
                style_focus AS focus, status, provider, model, created_at
         FROM place_generated_samples
         WHERE place_row_id = ?
         ORDER BY created_at DESC`;
    const stmt = statusFilter
      ? env.DB.prepare(sql).bind(placeRowId, statusFilter)
      : env.DB.prepare(sql).bind(placeRowId);
    const res = await stmt.all();
    results = res.results ?? [];
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
  }

  return jsonResponse({ samples: results }, 200, cors);
}

/**
 * POST /api/places/:id/samples/:sampleId/status  (researcher 이상)
 * 생성 예시 평가 라벨 변경: active | kept | archived
 */
async function handleUpdateSampleStatus(request, env, corsHeaders, placeRowId, sampleId) {
  const cors = corsHeaders || {};

  const authResult = await requireResearcher(request, env);
  if (authResult.error) {
    return jsonResponse({ error: authResult.error, message: authResult.message }, authResult.status, cors);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'invalid_json', message: '요청 바디가 올바른 JSON이 아닙니다' }, 400, cors);
  }

  const VALID_STATUSES = ['active', 'kept', 'archived'];
  const newStatus = body?.status;
  if (!newStatus || !VALID_STATUSES.includes(newStatus)) {
    return jsonResponse({ error: 'invalid_status', message: 'status는 active | kept | archived 중 하나여야 합니다' }, 400, cors);
  }

  // 해당 sample이 이 place 소속인지 확인
  let sample;
  try {
    sample = await env.DB.prepare(
      'SELECT id FROM place_generated_samples WHERE id = ? AND place_row_id = ?'
    ).bind(sampleId, placeRowId).first();
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
  }

  if (!sample) {
    return jsonResponse({ error: 'not_found', message: '해당 샘플을 찾을 수 없습니다' }, 404, cors);
  }

  try {
    await env.DB.prepare(
      'UPDATE place_generated_samples SET status = ? WHERE id = ? AND place_row_id = ?'
    ).bind(newStatus, sampleId, placeRowId).run();
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
  }

  return jsonResponse({ ok: true, id: sampleId, status: newStatus }, 200, cors);
}

/**
 * POST /api/places/:id/samples/delete  (researcher 이상)
 * 생성 예시 다중 삭제. body: { "ids": ["uuid1", ...] }
 */
async function handleDeleteSamples(request, env, corsHeaders, placeRowId) {
  const cors = corsHeaders || {};

  const authResult = await requireResearcher(request, env);
  if (authResult.error) {
    return jsonResponse({ error: authResult.error, message: authResult.message }, authResult.status, cors);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'invalid_json', message: '요청 바디가 올바른 JSON이 아닙니다' }, 400, cors);
  }

  const ids = body?.ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    return jsonResponse({ error: 'invalid_ids', message: 'ids는 1개 이상의 배열이어야 합니다' }, 400, cors);
  }

  // 최대 100개 제한 (안전 장치)
  if (ids.length > 100) {
    return jsonResponse({ error: 'too_many_ids', message: '한 번에 최대 100개까지 삭제 가능합니다' }, 400, cors);
  }

  const placeholders = ids.map(() => '?').join(', ');
  let deleted = 0;
  try {
    const result = await env.DB.prepare(
      `DELETE FROM place_generated_samples WHERE id IN (${placeholders}) AND place_row_id = ?`
    ).bind(...ids, placeRowId).run();
    deleted = result.meta?.changes ?? 0;
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
  }

  return jsonResponse({ ok: true, deleted }, 200, cors);
}

/**
 * GET /api/places/:id/usage  (승인 사용자 + 소유 확인)
 * 해당 지점의 LLM 호출 누적 비용·횟수 반환.
 */
async function handleGetPlaceUsage(request, env, corsHeaders, placeRowId) {
  const cors = corsHeaders || {};

  const authResult = await requireApprovedUser(request, env);
  if (authResult.error) {
    return jsonResponse({ error: authResult.error, message: authResult.message }, authResult.status, cors);
  }

  // 소유 확인
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

  let rows;
  try {
    const res = await env.DB.prepare(`
      SELECT kind, COUNT(*) AS calls, COALESCE(SUM(cost_usd), 0) AS cost_usd
      FROM llm_usage
      WHERE place_row_id = ?
      GROUP BY kind
    `).bind(placeRowId).all();
    rows = res.results ?? [];
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
  }

  const byKind = rows.map(r => ({
    kind:     r.kind,
    calls:    r.calls,
    cost_usd: r.cost_usd,
  }));

  const totalCostUsd = byKind.reduce((sum, r) => sum + r.cost_usd, 0);
  const totalCalls   = byKind.reduce((sum, r) => sum + r.calls, 0);

  return jsonResponse({
    total_cost_usd: totalCostUsd,
    total_calls:    totalCalls,
    by_kind:        byKind,
  }, 200, cors);
}

// --- Phase 4-1: 업체 피드백 리포트 ---

/** 표본 선정: body 길이 30자 이상인 최신 리뷰 최대 150건 */
const REPORT_SAMPLE_SIZE = 150;

/**
 * POST /api/places/:id/report
 * 소유 확인 → 표본 선정 → 정량 SQL(computePlaceQuantitative) + GPT 호출
 * → report_json 조립 → place_insights UPSERT → 결과 반환.
 */
async function handleGenerateReport(request, env, corsHeaders, placeRowId) {
  const cors = corsHeaders || {};

  // OpenAI 키 사전 확인 (키 없으면 GPT 호출 불가 — 미리 에러 반환)
  if (!env.OPENAI_API_KEY) {
    return jsonResponse(
      { error: 'no_openai_key', message: 'OpenAI API 키가 설정되지 않았습니다' },
      503,
      cors
    );
  }

  const authResult = await requireApprovedUser(request, env);
  if (authResult.error) {
    return jsonResponse({ error: authResult.error, message: authResult.message }, authResult.status, cors);
  }

  // 플레이스 소유 확인
  let placeRow;
  try {
    placeRow = await env.DB.prepare(
      'SELECT id, user_id, name, business_type, total_reviews FROM review_places WHERE id = ?'
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

  // 표본 선정: length(body) >= 30, review_date DESC 기준 최대 REPORT_SAMPLE_SIZE 건
  let sampleReviews;
  try {
    const { results } = await env.DB.prepare(`
      SELECT body
      FROM place_reviews
      WHERE place_row_id = ?
        AND body IS NOT NULL
        AND length(body) >= 30
      ORDER BY review_date DESC
      LIMIT ?
    `).bind(placeRowId, REPORT_SAMPLE_SIZE).all();
    sampleReviews = results ?? [];
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
  }

  const sampleSize = sampleReviews.length;

  // 표본 0건이면 GPT 호출 무의미(비용·무내용) — 조기 반환
  if (sampleSize === 0) {
    return jsonResponse(
      { error: 'no_sample', message: '분석할 30자 이상 리뷰가 없습니다' },
      400,
      cors
    );
  }

  // 정량 지표 (SQL, 재사용)
  let quantitative;
  try {
    quantitative = await computePlaceQuantitative(env, placeRowId, placeRow.total_reviews);
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
  }

  // GPT 호출로 정성 인사이트 생성
  let qualitative;
  let insightsUsage = { prompt_tokens: 0, completion_tokens: 0 };
  try {
    const result = await callOpenAIForInsights(env, {
      placeName:    placeRow.name ?? '',
      businessType: placeRow.business_type ?? '',
      replyRate:    quantitative.reply_rate,
      totalReviews: quantitative.stored_count,
      reviews:      sampleReviews.map(r => r.body),
    });
    qualitative    = result.qualitative;
    insightsUsage  = result.usage;
  } catch (err) {
    return jsonResponse(
      { error: 'openai_error', message: err.message },
      502,
      cors
    );
  }

  const generatedAt = new Date().toISOString();
  const model = 'gpt-5.4-mini';

  const costUsd = computeCostUsd(model, insightsUsage.prompt_tokens, insightsUsage.completion_tokens);

  const reportJson = {
    meta: {
      place_name:   placeRow.name ?? '',
      sample_size:  sampleSize,
      model,
      generated_at: generatedAt,
      usage: {
        prompt_tokens:     insightsUsage.prompt_tokens,
        completion_tokens: insightsUsage.completion_tokens,
        cost_usd:          costUsd,
      },
    },
    quantitative: {
      stored_count: quantitative.stored_count,
      total_server: quantitative.total_server,
      reply_rate:   quantitative.reply_rate,
      photo_rate:   quantitative.photo_rate,
      monthly:      quantitative.monthly,
      snapshots:    quantitative.snapshots,
    },
    qualitative,
  };

  const reportJsonStr = JSON.stringify(reportJson);

  // place_insights UPSERT + llm_usage INSERT — batch
  const usageId = crypto.randomUUID();
  try {
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO place_insights (place_row_id, report_json, sample_size, model, generated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(place_row_id) DO UPDATE SET
          report_json  = excluded.report_json,
          sample_size  = excluded.sample_size,
          model        = excluded.model,
          generated_at = excluded.generated_at
      `).bind(placeRowId, reportJsonStr, sampleSize, model, generatedAt),
      env.DB.prepare(`
        INSERT INTO llm_usage (id, place_row_id, kind, provider, model, prompt_tokens, completion_tokens, cost_usd, created_at)
        VALUES (?, ?, 'report', 'openai', ?, ?, ?, ?, ?)
      `).bind(usageId, placeRowId, model, insightsUsage.prompt_tokens, insightsUsage.completion_tokens, costUsd, generatedAt),
    ]);
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
  }

  return jsonResponse(reportJson, 200, cors);
}

/**
 * GET /api/places/:id/report
 * 소유 확인 → place_insights 캐시 조회.
 * 없으면 { exists: false } 404.
 */
async function handleGetReport(request, env, corsHeaders, placeRowId) {
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

  let insight;
  try {
    insight = await env.DB.prepare(
      'SELECT report_json, sample_size, model, generated_at FROM place_insights WHERE place_row_id = ?'
    ).bind(placeRowId).first();
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
  }

  if (!insight) {
    return jsonResponse({ exists: false, message: '아직 생성된 리포트가 없습니다. POST /report 로 생성하세요' }, 404, cors);
  }

  let reportJson;
  try {
    reportJson = JSON.parse(insight.report_json);
  } catch {
    return jsonResponse({ error: 'parse_error', message: '저장된 리포트 파싱 실패' }, 500, cors);
  }

  // POST와 동일하게 report_json을 직접 반환(계약 일치). meta에 sample_size·model·generated_at 포함.
  return jsonResponse(reportJson, 200, cors);
}

// --- OpenAI GPT 호출 (정성 인사이트) ---

/**
 * GPT gpt-5.4-mini 호출로 정성 인사이트(qualitative) 생성.
 * structured output: response_format {type:"json_object"} + 스키마 지시 in system prompt.
 * 파싱 실패 시 1회 재시도.
 * @param {object} env - Worker env (env.OPENAI_API_KEY 필요)
 * @param {{ placeName, businessType, replyRate, totalReviews, reviews: string[] }} params
 * @returns {Promise<object>} qualitative JSON
 */
// --- Phase 4: LLM 비용 추적 ---

/** USD per 1M tokens. model 키로 확장 가능. */
const MODEL_PRICING = {
  'gpt-5.4-mini':               { input: 0.75, output: 4.50 },
  'grok-4.3':                   { input: 1.25, output: 2.50 },
  'claude-haiku-4-5-20251001':  { input: 1.00, output: 5.00 },
};

/** provider별 기본 모델 */
const PROVIDER_DEFAULT_MODEL = {
  openai:    'gpt-5.4-mini',
  anthropic: 'claude-haiku-4-5-20251001',
  xai:       'grok-4.3',
};

/**
 * 토큰 수로 USD 비용 계산.
 * @param {string} model
 * @param {number} promptTokens
 * @param {number} completionTokens
 * @returns {number|null} null = 미등록 모델
 */
function computeCostUsd(model, promptTokens, completionTokens) {
  const p = MODEL_PRICING[model];
  if (!p) return null;
  return (promptTokens * p.input + completionTokens * p.output) / 1_000_000;
}

// --- Phase 4-1 인사이트 생성 ---

async function callOpenAIForInsights(env, { placeName, businessType, replyRate, totalReviews, reviews }) {
  const systemPrompt = `당신은 네이버 플레이스 리뷰를 분석하는 전문가입니다.
주어진 리뷰 표본을 근거로 업체의 강점·개선점·감성 비율·테마 키워드·대표 리뷰를 도출합니다.

반드시 다음 JSON 구조로만 응답하세요 (다른 텍스트 없이 순수 JSON):
{
  "summary": "지점 한 줄 총평 (100자 이내)",
  "strengths": [
    {"point": "강점 설명", "evidence": "근거가 되는 실제 리뷰 인용문"}
  ],
  "improvements": [
    {"point": "개선점 설명", "evidence": "근거가 되는 실제 리뷰 인용문"}
  ],
  "sentiment": {"positive": 0, "neutral": 0, "negative": 0},
  "themes": [
    {"keyword": "정제된 키워드 (조사 제거·의미 단위)", "sentiment": "positive|neutral|negative", "mentions": 0}
  ],
  "representative_reviews": {
    "positive": ["긍정 대표 리뷰 인용 1", "긍정 대표 리뷰 인용 2"],
    "negative": ["부정 대표 리뷰 인용 1"]
  }
}

규칙:
- strengths는 최소 1개, 최대 5개. 반드시 evidence 포함.
- improvements: 표본에 부정 신호가 없으면 빈 배열([])도 허용. 있으면 실제 근거 리뷰 인용 필수.
- sentiment의 positive+neutral+negative 합은 반드시 100.
- themes는 3~8개. 조사(이/가/은/는/을/를 등) 제거한 의미 단위 키워드.
- representative_reviews.positive는 2~3개, negative는 0~2개.
- 표본에 없는 내용 추측 금지. 근거 없는 칭찬·비판 금지.`;

  const reviewsText = reviews
    .map((r, i) => `[${i + 1}] ${r}`)
    .join('\n');

  const userPrompt = `업체명: ${placeName}
업종: ${businessType || '미분류'}
DB 저장 리뷰 수: ${totalReviews}건
사장님 답글률: ${(replyRate * 100).toFixed(1)}%
표본 리뷰 수: ${reviews.length}건

--- 표본 리뷰 목록 ---
${reviewsText}`;

  const body = {
    model: 'gpt-5.4-mini',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt },
    ],
    temperature: 0.3,
    max_completion_tokens: 2000,
  };

  async function fetchOnce() {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`OpenAI API 오류 ${resp.status}: ${errText.slice(0, 200)}`);
    }

    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('OpenAI 응답에 content가 없습니다');
    }
    const usage = {
      prompt_tokens:     data?.usage?.prompt_tokens     ?? 0,
      completion_tokens: data?.usage?.completion_tokens ?? 0,
    };
    return { qualitative: JSON.parse(content), usage };
  }

  // 1차 시도
  try {
    return await fetchOnce();
  } catch (firstErr) {
    // 파싱 실패(JSON.parse 오류)인 경우에만 1회 재시도
    if (firstErr instanceof SyntaxError) {
      return await fetchOnce();
    }
    throw firstErr;
  }
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
