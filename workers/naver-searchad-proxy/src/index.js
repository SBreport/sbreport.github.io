// SBS 확장 + 차세대 키워드 분석 대시보드용 네이버 검색광고 API 프록시

// R2: 자연스러움 채점기 (순수 함수 + 프로파일)
import { scoreNaturalness } from './naturalness-score.js';
import naturalnessProfile from './naturalness-profile.json';

// 환각 탐지기 (soft-flag 조기경보 — 재생성/차단 아님)
import { detectHallucination } from './hallucination-detect.js';

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

    if (url.pathname === '/api/worker-version' && request.method === 'GET') {
      return handleWorkerVersion(request, env, corsHeaders);
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
    // POST /api/places/:id/analyze-reviews — AI 리뷰 진단 (admin 전용)
    const analyzeReviewsMatch = url.pathname.match(/^\/api\/places\/([^/]+)\/analyze-reviews$/);
    if (analyzeReviewsMatch && request.method === 'POST') {
      return handleAnalyzeReviews(request, env, corsHeaders, analyzeReviewsMatch[1]);
    }
    // GET /api/places/:id/ai-diagnosis — AI 진단 결과 조회 (researcher 이상)
    const aiDiagnosisMatch = url.pathname.match(/^\/api\/places\/([^/]+)\/ai-diagnosis$/);
    if (aiDiagnosisMatch && request.method === 'GET') {
      return handleGetAiDiagnosis(request, env, corsHeaders, aiDiagnosisMatch[1]);
    }
    // GET /api/places/:id/ai-reviews — 분류/점수대 드릴다운 조회 (researcher 이상)
    const aiReviewsMatch = url.pathname.match(/^\/api\/places\/([^/]+)\/ai-reviews$/);
    if (aiReviewsMatch && request.method === 'GET') {
      return handleGetAiReviews(request, env, corsHeaders, aiReviewsMatch[1]);
    }
    // POST /api/places/:id/reviews/:reviewId/label — 사람 검수 라벨 저장/해제 (researcher 이상)
    const reviewLabelMatch = url.pathname.match(/^\/api\/places\/([^/]+)\/reviews\/([^/]+)\/label$/);
    if (reviewLabelMatch && request.method === 'POST') {
      return handleSetReviewLabel(request, env, corsHeaders, reviewLabelMatch[1], reviewLabelMatch[2]);
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
    // GET /api/places/review-sprint-sample — 라벨링 스프린트 표본 추출 (researcher 이상)
    // 주의: 정확히 /api/places/{id} 매칭보다 먼저 위치해야 함
    if (url.pathname === '/api/places/review-sprint-sample' && request.method === 'GET') {
      return handleReviewSprintSample(request, env, corsHeaders);
    }
    // GET /api/places/review-sprint-stats — 라벨링 스프린트 진행 통계 (researcher 이상)
    if (url.pathname === '/api/places/review-sprint-stats' && request.method === 'GET') {
      return handleReviewSprintStats(request, env, corsHeaders);
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
    if (url.pathname === '/api/admin/research-activity' && request.method === 'GET') {
      return handleAdminResearchActivity(request, env, corsHeaders);
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
    // POST /api/labels/llm-classify — LLM judge 판별 실행 (admin 전용)
    // 사람 라벨된 리뷰 전체를 codebook 기반 4분류 → review_llm_classifications upsert
    // 결과는 잠정(단일 평가자 대비) — IAA 검증 전
    if (url.pathname === '/api/labels/llm-classify' && request.method === 'POST') {
      return handleLLMClassify(request, env, corsHeaders);
    }

    // --- 블라인드 테스트 ---
    // POST   /api/blind-test/pool          — 풀 구성 (admin)
    // GET    /api/blind-test/pools         — 풀 목록 (researcher/admin)
    // DELETE /api/blind-test/pools/:pool   — 풀 삭제 (admin)
    // GET    /api/blind-test/access-code   — 접근코드 조회 (researcher/admin)
    // GET    /api/blind-test/items         — 아이템 목록 (공개 + 접근코드)
    // POST   /api/blind-test/ratings       — 평점 제출 (공개 + 접근코드)
    // GET    /api/blind-test/results       — 집계 결과 (researcher/admin)
    if (url.pathname === '/api/blind-test/pool' && request.method === 'POST') {
      return handleBlindTestPool(request, env, corsHeaders);
    }
    if (url.pathname === '/api/blind-test/pools' && request.method === 'GET') {
      return handleBlindTestPools(request, env, corsHeaders);
    }
    {
      const m = url.pathname.match(/^\/api\/blind-test\/pools\/([^/]+)$/);
      if (m && request.method === 'DELETE') {
        return handleBlindTestPoolDelete(m[1], request, env, corsHeaders);
      }
    }
    if (url.pathname === '/api/blind-test/access-code' && request.method === 'GET') {
      return handleBlindTestAccessCode(request, env, corsHeaders);
    }
    if (url.pathname === '/api/blind-test/items' && request.method === 'GET') {
      return handleBlindTestItems(request, env, corsHeaders);
    }
    if (url.pathname === '/api/blind-test/ratings' && request.method === 'POST') {
      return handleBlindTestRatings(request, env, corsHeaders);
    }
    if (url.pathname === '/api/blind-test/results' && request.method === 'GET') {
      return handleBlindTestResults(request, env, corsHeaders);
    }

    // --- IAA (평가자 간 일치도) ---
    // POST /api/iaa/set     — 세트 생성 (admin)
    // GET  /api/iaa/sets    — 세트 목록 (researcher)
    // GET  /api/iaa/items   — 아이템 목록 (공개 + 코드)
    // POST /api/iaa/labels  — 라벨 제출 (공개 + 코드)
    // GET  /api/iaa/results — κ 결과 (researcher)
    if (url.pathname === '/api/iaa/set' && request.method === 'POST') {
      return handleIaaSet(request, env, corsHeaders);
    }
    if (url.pathname === '/api/iaa/sets' && request.method === 'GET') {
      return handleIaaSets(request, env, corsHeaders);
    }
    if (url.pathname === '/api/iaa/items' && request.method === 'GET') {
      return handleIaaItems(request, env, corsHeaders);
    }
    if (url.pathname === '/api/iaa/labels' && request.method === 'POST') {
      return handleIaaLabels(request, env, corsHeaders);
    }
    if (url.pathname === '/api/iaa/results' && request.method === 'GET') {
      return handleIaaResults(request, env, corsHeaders);
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
  } else if (row.role === 'admin' || row.role === 'researcher' || row.role === 'tester') {
    // DB에 admin/researcher/tester로 명시된 role 그대로 유지
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

// --- GET /api/worker-version 핸들러 (무인증, CF 배포 메타데이터 반환) ---

function handleWorkerVersion(request, env, corsHeaders) {
  // CORS 미허용 오리진도 정보 조회 가능하도록 null corsHeaders 허용
  const headers = corsHeaders ?? {};
  return jsonResponse({
    id: env.CF_VERSION_METADATA?.id ?? null,
    tag: env.CF_VERSION_METADATA?.tag ?? null,
    timestamp: env.CF_VERSION_METADATA?.timestamp ?? null,
  }, 200, headers);
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
 * naver.me 단축 URL을 최종 리다이렉트 목적지 URL로 해석한다.
 * - 호스트가 naver.me인 경우에만 fetch(redirect: 'follow')로 추적. SSRF 방지.
 * - 네트워크 실패 / 타임아웃 시 원본 url 그대로 반환 (기존 추출 경로로 폴백).
 * @param {string} url
 * @returns {Promise<string>} 해석된 최종 URL 또는 원본 url
 */
async function resolveShortPlaceUrl(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return url; // 파싱 실패 시 원본 반환
  }

  if (host !== 'naver.me') return url; // naver.me가 아니면 추적 안 함

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000); // 5초 타임아웃
    try {
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });
      return res.url || url; // response.url = 최종 리다이렉트 도착 URL
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    console.log(`[RESOLVE_SHORT_URL] 단축링크 해석 실패 (${url}): ${e.message}`);
    return url; // graceful fallback — 원본으로 기존 추출 시도
  }
}

/**
 * 네이버 플레이스 URL에서 placeId와 businessType을 추출한다.
 * naver.me 단축 URL은 resolveShortPlaceUrl()로 먼저 해석 후 이 함수에 전달.
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

  // tester는 지점 등록 불가 (읽기·예시 생성만 허용)
  if (authResult.user.role === 'tester') {
    return jsonResponse({ error: 'forbidden', message: '테스터는 지점 등록을 할 수 없습니다' }, 403, cors);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'invalid_json', message: 'Request body must be valid JSON' }, 400, cors);
  }

  let placeId, businessType;
  let resolvedUrl = null; // 단축링크 해석 후 최종 URL (저장용)

  if (body.url) {
    const inputUrl = body.url.trim();

    // naver.me 단축링크 여부 확인 — 맞으면 먼저 해석
    let targetUrl = inputUrl;
    try {
      const inputHost = new URL(inputUrl).hostname;
      if (inputHost === 'naver.me') {
        targetUrl = await resolveShortPlaceUrl(inputUrl);
        resolvedUrl = targetUrl; // 해석된 URL을 저장
      }
    } catch {
      // URL 파싱 실패 시 원본 그대로 (extractPlaceInfo에서 처리)
    }

    // 해석된(또는 원본) URL에서 placeId·businessType 추출
    const info = extractPlaceInfo(targetUrl);
    if (!info) {
      return jsonResponse(
        {
          error: 'invalid_url',
          message:
            '플레이스 URL에서 placeId를 추출할 수 없습니다. 단축링크 해석 실패 가능 — 풀 URL(map.naver.com/p/entry/place/...)을 넣어보세요',
        },
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
  // 단축링크 입력 시 해석된 최종 URL을 저장 (후속 작업에서 풀 URL이 더 유용).
  // resolvedUrl은 naver.me 입력일 때만 세팅됨. 일반 풀 URL은 body.url 그대로.
  const placeUrl = resolvedUrl ?? body.url ?? null;
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
 * tester/admin은 모든 지점 반환, 그 외 자기 소유만 반환.
 */
async function handleListPlaces(request, env, corsHeaders) {
  const cors = corsHeaders || {};

  const authResult = await requireApprovedUser(request, env);
  if (authResult.error) {
    return jsonResponse({ error: authResult.error, message: authResult.message }, authResult.status, cors);
  }

  const role = authResult.user.role;
  const isUnrestricted = role === 'admin' || role === 'tester';

  try {
    let results;
    if (isUnrestricted) {
      // tester/admin: 모든 지점 반환 (소유 필터 미적용)
      const res = await env.DB.prepare(
        `SELECT id, place_id, business_type, name, total_reviews, last_collected_at, created_at, auto_collect
         FROM review_places
         ORDER BY created_at DESC`
      ).all();
      results = res.results;
    } else {
      const res = await env.DB.prepare(
        `SELECT id, place_id, business_type, name, total_reviews, last_collected_at, created_at, auto_collect
         FROM review_places
         WHERE user_id = ?
         ORDER BY created_at DESC`
      ).bind(authResult.user.id).all();
      results = res.results;
    }

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
 * tester/admin은 소유 불문 전 지점 접근 가능.
 */
async function handleGetReviews(request, env, corsHeaders, placeRowId) {
  const cors = corsHeaders || {};

  const authResult = await requireApprovedUser(request, env);
  if (authResult.error) {
    return jsonResponse({ error: authResult.error, message: authResult.message }, authResult.status, cors);
  }

  // 플레이스 소유 확인 (tester/admin은 소유 우회)
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
  const role = authResult.user.role;
  const isUnrestricted = role === 'admin' || role === 'tester';
  if (!isUnrestricted && placeRow.user_id !== authResult.user.id) {
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
 * @param {object} opts        { maxPages?, source?, actorUserId? } (기본 maxPages 3, source 'manual', actorUserId null=시스템)
 * @returns {Promise<{place_id, total_server, inserted, skipped, pages_fetched, blocked, error?}>}
 */
async function collectPlaceReviews(env, placeRow, opts = {}) {
  const maxPages = opts.maxPages ?? 3;
  const source = opts.source ?? 'manual';
  const actorUserId = opts.actorUserId ?? null;
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
         (id, place_row_id, source, inserted, skipped, pages_fetched, total_server, blocked, error, collected_at, actor_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      now,
      actorUserId
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
 * @param {object} opts       { maxPages?, actorUserId? } (기본 5, 1~10 clamp; actorUserId null=시스템)
 * @returns {Promise<{done, inserted, skipped, pages_fetched, blocked, error?, total_server, stored_count}>}
 */
async function backfillPlaceChunk(env, placeRow, opts = {}) {
  const maxPages = Math.min(Math.max(Math.floor(opts.maxPages ?? 5), 1), 10);
  const actorUserId = opts.actorUserId ?? null;
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
         (id, place_row_id, source, inserted, skipped, pages_fetched, total_server, blocked, error, collected_at, actor_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      now,
      actorUserId
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

  // tester는 백필(전체 수집) 불가
  if (authResult.user.role === 'tester') {
    return jsonResponse({ error: 'forbidden', message: '테스터는 수집 기능을 사용할 수 없습니다' }, 403, cors);
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
    result = await backfillPlaceChunk(env, placeRow, { maxPages, actorUserId: authResult.user.id });
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

  // tester는 수집 불가
  if (authResult.user.role === 'tester') {
    return jsonResponse({ error: 'forbidden', message: '테스터는 수집 기능을 사용할 수 없습니다' }, 403, cors);
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
    result = await collectPlaceReviews(env, placeRow, { maxPages, source: 'manual', actorUserId: authResult.user.id });
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

  // tester는 삭제 불가
  if (authResult.user.role === 'tester') {
    return jsonResponse({ error: 'forbidden', message: '테스터는 지점 삭제를 할 수 없습니다' }, 403, cors);
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
  const isAdmin = authResult.user.role === 'admin';
  if (!isAdmin && placeRow.user_id !== authResult.user.id) {
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
      // 소유자 기준 삭제 (소유 확인 통과 후). admin이 타 계정 지점도 지울 수 있게 실제 소유자 user_id 사용.
      env.DB.prepare('DELETE FROM review_places WHERE id = ? AND user_id = ?').bind(placeRowId, placeRow.user_id),
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
// tester는 의도적으로 제외 — tester는 requireTester 게이트를 사용.
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

// 테스터 게이트: requireApprovedUser 통과 + user.role이 'admin', 'researcher', 'tester'면 통과.
// 테스터는 소유권 우회가 별도 로직으로 처리됨 (isAdmin || isTester 패턴).
// 통과 시 { user } / 실패 시 { error, status, message }.
async function requireTester(request, env) {
  const authResult = await requireApprovedUser(request, env);
  if (authResult.error) return authResult;
  const role = authResult.user.role;
  if (role !== 'admin' && role !== 'researcher' && role !== 'tester') {
    return { error: 'forbidden', status: 403, message: '테스터(tester) 이상 권한이 필요합니다' };
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
        : (u.role === 'admin' || u.role === 'researcher' || u.role === 'tester' ? u.role : 'user'),
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
  const ALLOWED_ROLES = ['user', 'researcher', 'admin', 'tester'];
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

// GET /api/admin/research-activity — 연구원별 활동·비용 집계 (admin 전용)
// users 테이블 기준으로 role=researcher|admin인 사용자마다 활동 수치를 actor_user_id로 LEFT JOIN 집계.
// 활동이 전혀 없는 연구원도 0으로 표시.
async function handleAdminResearchActivity(request, env, corsHeaders) {
  const cors = corsHeaders || {};

  const authResult = await requireAdmin(request, env);
  if (authResult.error) {
    return jsonResponse({ error: authResult.error, message: authResult.message }, authResult.status, cors);
  }

  try {
    // ADMIN_EMAILS를 런타임에 admin으로 처리하므로, DB의 role 컬럼 기준으로 researcher/admin 조회.
    // ADMIN_EMAILS 환경변수에 속한 사용자도 포함하기 위해 전체 approved 사용자를 대상으로 하되,
    // role 판정은 getUserFromDB와 동일 로직으로 JS에서 적용.
    const { results: userRows } = await env.DB.prepare(
      `SELECT id, email, name, role FROM users WHERE status = 'approved' ORDER BY name ASC`
    ).all();

    const adminEmails = (env.ADMIN_EMAILS || '').split(',').map(s => s.trim()).filter(Boolean);

    // status='approved'인 전체 사용자를 포함 (테스터·일반 사용자도 활동·비용 표시)
    const researchers = (userRows ?? []).map(u => ({
      user_id: u.id,
      name: u.name,
      email: u.email,
      role: adminEmails.includes(u.email) ? 'admin'
        : (u.role === 'researcher' ? 'researcher'
          : (u.role === 'tester' ? 'tester' : 'user')),
    }));

    if (researchers.length === 0) {
      return jsonResponse({ researchers: [], unattributed_cost_usd: 0 }, 200, cors);
    }

    // 활동 집계: 각 테이블별로 actor_user_id 기준 GROUP BY
    const [collectRes, sampleRes, usageRes] = await Promise.all([
      env.DB.prepare(
        `SELECT actor_user_id, COUNT(*) AS cnt
         FROM place_collection_events
         WHERE actor_user_id IS NOT NULL
         GROUP BY actor_user_id`
      ).all(),
      env.DB.prepare(
        `SELECT actor_user_id, COUNT(*) AS cnt
         FROM place_generated_samples
         WHERE actor_user_id IS NOT NULL
         GROUP BY actor_user_id`
      ).all(),
      env.DB.prepare(
        `SELECT actor_user_id,
                SUM(CASE WHEN kind = 'report' THEN 1 ELSE 0 END) AS report_cnt,
                COALESCE(SUM(cost_usd), 0) AS total_cost_usd
         FROM llm_usage
         WHERE actor_user_id IS NOT NULL
         GROUP BY actor_user_id`
      ).all(),
    ]);

    // 집계 결과를 Map으로 변환
    const collectMap = new Map((collectRes.results ?? []).map(r => [r.actor_user_id, r.cnt]));
    const sampleMap  = new Map((sampleRes.results  ?? []).map(r => [r.actor_user_id, r.cnt]));
    const usageMap   = new Map((usageRes.results   ?? []).map(r => [
      r.actor_user_id,
      { report_cnt: r.report_cnt ?? 0, total_cost_usd: r.total_cost_usd ?? 0 },
    ]));

    const result = researchers.map(u => ({
      user_id:        u.user_id,
      name:           u.name,
      email:          u.email,
      role:           u.role,
      collect_count:  collectMap.get(u.user_id) ?? 0,
      sample_count:   sampleMap.get(u.user_id)  ?? 0,
      report_count:   usageMap.get(u.user_id)?.report_cnt      ?? 0,
      total_cost_usd: usageMap.get(u.user_id)?.total_cost_usd  ?? 0,
    }));

    // 미귀속 비용: actor_user_id가 NULL이거나 users에 없는 llm_usage 행의 비용 합계
    const unattributedRow = await env.DB.prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total
       FROM llm_usage
       WHERE actor_user_id IS NULL
          OR actor_user_id NOT IN (SELECT id FROM users)`
    ).first();
    const unattributed_cost_usd = unattributedRow?.total ?? 0;

    return jsonResponse({ researchers: result, unattributed_cost_usd }, 200, cors);
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
  }
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
 * 담당자명(실장님/원장님 등)을 포함할 샘플 비율 (0~1).
 * 0.3 = 전체 샘플의 약 30%에만 담당자명 배정. 튜닝 시 여기만 조정.
 */
const STAFF_NAME_RATE = 0.3;

// ── 모드붕괴 방지 상수 ─────────────────────────────────────────────────────────
/** lengthParam 지정 시 본보기 풀이 이 수보다 작으면 인접 길이→전체로 확장 */
const MIN_EXEMPLAR_POOL = 8;
/** 이 Jaccard 유사도를 초과하는 샘플 쌍을 '붕괴'로 간주 */
const SIMILARITY_THRESHOLD = 0.55;
/** 붕괴 샘플 재생성 최대 패스 수 */
const MAX_REGEN_PASSES = 1;

/**
 * 텍스트를 정규화한다 (공백·문장부호·이모티콘 제거, 소문자화).
 * 유사도 비교용 전처리에 사용.
 * @param {string} text
 * @returns {string}
 */
function normalizeForSimilarity(text) {
  return text
    .replace(/[\s.,!?;:·""''()\[\]{}<>/\\|@#$%^&*+=~`\-—–…♡♥ㅋㅎ^.~]+/gu, '')
    .replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{FE0F}\u{1F000}-\u{1FFFF}]/gu, '')
    .toLowerCase();
}

/**
 * 문자 trigram 집합을 반환한다.
 * @param {string} s 정규화된 문자열
 * @returns {Set<string>}
 */
function trigramSet(s) {
  const set = new Set();
  for (let i = 0; i + 3 <= s.length; i++) {
    set.add(s.slice(i, i + 3));
  }
  return set;
}

/**
 * 문자 trigram Jaccard 유사도 계산 (0~1).
 * 문자열이 너무 짧으면(trigram 없음) 0 반환.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function trigramJaccard(a, b) {
  const na = normalizeForSimilarity(a);
  const nb = normalizeForSimilarity(b);
  const sa = trigramSet(na);
  const sb = trigramSet(nb);
  if (sa.size === 0 && sb.size === 0) return 1; // 둘 다 빈 문자열 → 동일
  if (sa.size === 0 || sb.size === 0) return 0;
  let intersection = 0;
  for (const t of sa) {
    if (sb.has(t)) intersection++;
  }
  const union = sa.size + sb.size - intersection;
  return intersection / union;
}

/**
 * 배치 내 붕괴 샘플 인덱스를 반환한다.
 * 앞서 등장한 샘플과 유사도 > threshold 인 것을 '붕괴'로 표시.
 * @param {string[]} bodies 본문 배열
 * @param {number} threshold
 * @returns {Set<number>} 붕괴 샘플의 인덱스 집합
 */
function detectCollapsedSamples(bodies, threshold) {
  const collapsed = new Set();
  for (let i = 1; i < bodies.length; i++) {
    for (let j = 0; j < i; j++) {
      if (trigramJaccard(bodies[i], bodies[j]) > threshold) {
        collapsed.add(i);
        break; // i는 붕괴 확정, 더 비교 불필요
      }
    }
  }
  return collapsed;
}

/**
 * 최종 본문 배열의 배치 다양성 지표를 계산한다.
 * - distinct2: 정규화된 전체 본문의 문자 bigram 중 고유 비율 (0~1, 높을수록 다양)
 * - avgSimilarity: 모든 쌍의 trigramJaccard 평균 (0~1, 낮을수록 다양)
 * - maxSimilarity: 모든 쌍의 trigramJaccard 최대 (0~1, 낮을수록 다양)
 * count < 2면 null 반환.
 * @param {string[]} bodies 최종 본문 배열
 * @returns {{ distinct2: number, avgSimilarity: number, maxSimilarity: number, count: number } | null}
 */
function computeBatchDiversity(bodies) {
  const n = bodies.length;
  if (n < 2) return null;

  // distinct-2: 전체 본문 합산의 문자 bigram 고유 비율
  const allBigrams = [];
  const distinctBigrams = new Set();
  for (const body of bodies) {
    const norm = normalizeForSimilarity(body);
    for (let i = 0; i + 2 <= norm.length; i++) {
      const bg = norm.slice(i, i + 2);
      allBigrams.push(bg);
      distinctBigrams.add(bg);
    }
  }
  const distinct2 = allBigrams.length > 0 ? distinctBigrams.size / allBigrams.length : 0;

  // avgSimilarity / maxSimilarity: 모든 쌍의 trigramJaccard
  let sumSim = 0;
  let maxSim = 0;
  let pairCount = 0;
  for (let i = 1; i < n; i++) {
    for (let j = 0; j < i; j++) {
      const sim = trigramJaccard(bodies[i], bodies[j]);
      sumSim += sim;
      if (sim > maxSim) maxSim = sim;
      pairCount++;
    }
  }
  const avgSimilarity = pairCount > 0 ? sumSim / pairCount : 0;

  return {
    distinct2:     Math.round(distinct2 * 1000) / 1000,
    avgSimilarity: Math.round(avgSimilarity * 1000) / 1000,
    maxSimilarity: Math.round(maxSim * 1000) / 1000,
    count:         n,
  };
}

/**
 * count 개의 스타일 조합을 실측 길이 분포 가중치로 분산 생성.
 * length 축:
 *   includeLong=false(기본): short 45% · medium 55% (long 제외)
 *   includeLong=true: 실제 리뷰 분포(short 35% · medium 45% · long 20%) 3분할
 *   - short  = 1문장, ~30자
 *   - medium = 1~2문장, 30~70자
 *   - long   = 2~4문장, 80~150자 (5문장+ 장황 금지)
 * tone / focus 축은 기존 라운드로빈 유지.
 * @param {number} count
 * @param {boolean} [includeLong=false]
 * @returns {{ length: string, tone: string, focus: string }[]}
 */
function buildStyleAssignments(count, includeLong = false) {
  // 길이 가중치: includeLong=false이면 short/medium만, true이면 3분할
  const LENGTH_WEIGHTS = includeLong
    ? [
        { value: 'short',  weight: 35 },
        { value: 'medium', weight: 45 },
        { value: 'long',   weight: 20 },
      ]
    : [
        { value: 'short',  weight: 45 },
        { value: 'medium', weight: 55 },
      ];
  const totalWeight = LENGTH_WEIGHTS.reduce((s, w) => s + w.weight, 0); // 100

  // 가중치 비례로 각 length 배정 개수 계산 (정수 나눔 + 나머지 보정)
  const lengthCounts = LENGTH_WEIGHTS.map(w => Math.floor(count * w.weight / totalWeight));
  let remaining = count - lengthCounts.reduce((s, n) => s + n, 0);
  // 나머지는 가중치가 높은 순(medium)부터 배정
  for (let i = 0; remaining > 0; i = (i + 1) % LENGTH_WEIGHTS.length) {
    lengthCounts[i]++;
    remaining--;
  }

  // length 배열 구성 (short * nShort, medium * nMedium, ...)
  const lengths = [];
  for (let wi = 0; wi < LENGTH_WEIGHTS.length; wi++) {
    for (let k = 0; k < lengthCounts[wi]; k++) {
      lengths.push(LENGTH_WEIGHTS[wi].value);
    }
  }

  // 피셔-예이츠 셔플로 length 순서 무작위화
  for (let i = lengths.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [lengths[i], lengths[j]] = [lengths[j], lengths[i]];
  }

  // tone / focus는 기존 라운드로빈 (다양성 유지)
  const assignments = [];
  for (let i = 0; i < count; i++) {
    assignments.push({
      length: lengths[i],
      tone:   SAMPLE_TONES[i   % SAMPLE_TONES.length],
      focus:  SAMPLE_FOCUSES[i % SAMPLE_FOCUSES.length],
    });
  }
  // 전체 순서도 셔플 (예측 가능한 패턴 탈피)
  for (let i = assignments.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [assignments[i], assignments[j]] = [assignments[j], assignments[i]];
  }
  return assignments;
}

/**
 * fact pool(허용 소재 키워드 목록) 추출.
 * 빈도순 단어 + 담당자명 엔티티를 함께 반환해 구체성을 높인다.
 * @param {object} env
 * @param {string} placeRowId
 * @param {number} topN
 * @returns {Promise<string[]>} 단어 배열 (엔티티 우선, 빈도 내림차순)
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
    // 시술/제품/담당자가 아닌 흔한 일반어 — fact pool 오염 방지
    '모두','오늘','처음','다른','부분','시간','생각','느낌','정도','이것저것','하나씩','중간중간',
    '진행','과정','방식','방법','설명','안내','선택','결정','경험','결과','효과','반응',
    '상태','분들','분위기','느낌이','생각이','것같','것같이','것이라','이라서','라서',
  ]);

  // 일반 칭찬어·필러 — 어느 가게든 쓸 수 있는 흔한 어휘. fact pool에서 제거.
  // 가게 고유 시술명·메뉴명·사람 이름처럼 구체적인 단어는 여기에 없으므로 통과된다.
  const GENERIC_FILLER = new Set([
    '친절','깔끔','청결','만족','추천','최고','정성','꼼꼼','편안','훌륭','완벽','탁월','감동',
    '좋아요','좋았','좋습니다','좋네요','굿','좋아','좋은','좋고','좋게',
    '상담','원장','원장님','직원','선생님','실장님','선생','담당','담당자',
    '시설','분위기','가격','효과','깨끗','방문','예약','진료','병원','의원',
    '여기','이곳','시술','관리','받았','받고','받아','받은','관리받','받았어요',
    '서비스','이용','가봤','다녀','다녀왔','왔어요','갔어요','했어요','했습니다',
    '강추','극추','마음에','마음에들','만족스','만족했','재방문','또왔','또방문',
    '추천합니다','추천해요','강력추천','항상','계속','앞으로','다음에','또올게요',
    '처음','오늘','저번','지난','이번에',
  ]);

  // 빈도 바닥: freq ≥ 2 인 엔티티만 최종 채택 (1회짜리 노이즈 제거)
  const STAFF_NAME_MIN_FREQ = 2;

  // 담당자명 엔티티 추출: "이름+(실장님|원장님|선생님|쌤|대표님|상담실장)" 패턴
  // 예: "김실장님", "박원장님", "수연쌤", "지은 상담실장"
  const STAFF_TITLE_RE = /([가-힣]{1,4})\s*(실장님|원장님|선생님|쌤|대표님|상담실장)/g;
  // 형용사 관형형(친절한/꼼꼼한 등)이 이름으로 오탐되는 것 방지용 블록셋
  const BAD_STAFF_NAMES = new Set([
    '친절한','꼼꼼한','깔끔한','편안한','세심한','자세한','정확한','상냥한','능숙한','깨끗한','시원한','훌륭한',
    '친절하신','꼼꼼하신','깔끔하신','세심하신','자세하신','친절했던','꼼꼼했던',
  ]);
  // 역할어·지시어 블록리스트 — namePart 자체가 역할어/지시어인 경우 제외
  const STAFF_DESCRIPTOR = new Set([
    '의사','여의사','남의사','간호사','관리사','피부','데스크','코디','코디네이터','인포',
    '총괄','대표','부원장','원장','실장','선생','지점','병원','타병원','의원',
    '상담','담당','직원','분들','여자','여성','남자','남성',
    '우리','그분','메인','모든','모두','다른','전체','여기','이곳',
    // 강조 부사·접속어 (이름 아님)
    '특히','특히나','그리고','또한','바로','정말','진짜','항상','매번',
  ]);
  // 동사·접속어로 끝나는 namePart 오탐 차단 — 기존 항목 유지 + 다음 어미 추가
  const BAD_STAFF_SUFFIX_RE = /(하시고|하셔서|하신|했던|하고|해서|한|하게|하며|하여|시고|셔서|히고|시는|주시는|으시는|시구|으시구|하시구|는데|어요|아요|에요|예요|으며|으신|으셔|셨|셔서|시던|주신|주셨|다는|라서|다고|길래|는지|군요|네요|더라|더라구|았|었|였|해서|했던)$/;
  // 형용사 어근 포함 오탐 차단 — "친절", "꼼꼼" 등이 namePart에 포함된 경우
  const BAD_STAFF_ADJECTIVE_RE = /친절|꼼꼼|깔끔|세심|자세|정확|상냥|편안|능숙|훌륭|깨끗/;
  const staffEntityFreq = new Map();

  const wordFreq = new Map();
  for (const row of bodyRows) {
    if (!row.body) continue;

    // 담당자명 엔티티 수집 (원형 보존)
    let m;
    STAFF_TITLE_RE.lastIndex = 0;
    while ((m = STAFF_TITLE_RE.exec(row.body)) !== null) {
      const namePart = m[1];
      // 형용사 관형형·일반어가 이름으로 잡힌 오탐 제거
      if (BAD_STAFF_NAMES.has(namePart) || GENERIC_FILLER.has(namePart) || STOPWORDS.has(namePart)) continue;
      // 역할어·지시어 블록리스트 (의사/데스크/여자 등 자체가 역할어인 경우)
      if (STAFF_DESCRIPTOR.has(namePart)) continue;
      // 동사·접속어 어미로 끝나는 경우 ("절하시고", "주시는" 등) 제거
      if (BAD_STAFF_SUFFIX_RE.test(namePart)) continue;
      // 형용사 어근이 namePart 안에 포함된 경우 제거
      if (BAD_STAFF_ADJECTIVE_RE.test(namePart)) continue;
      // 길이 제한: 한국 이름은 2~3자 (1자·4자 제외)
      if (namePart.length < 2 || namePart.length > 3) continue;
      const entity = m[0].replace(/\s+/g, ''); // 공백 제거해서 정규화
      staffEntityFreq.set(entity, (staffEntityFreq.get(entity) ?? 0) + 1);
    }

    // 빈도 단어 수집 (기존 로직)
    const tokens = row.body.split(/[\s.,!?;:·""''()\[\]{}<>/\\|@#$%^&*+=~`\-—–…]+/u);
    for (const token of tokens) {
      const word = token.trim();
      if (word.length < 2) continue;
      if (/^\d+$/.test(word)) continue;
      if (STOPWORDS.has(word)) continue;
      if (GENERIC_FILLER.has(word)) continue;
      wordFreq.set(word, (wordFreq.get(word) ?? 0) + 1);
    }
  }

  // 엔티티(담당자명)를 우선 배치, 나머지 슬롯을 빈도 단어로 채움
  // freq ≥ STAFF_NAME_MIN_FREQ 인 엔티티만 채택 (1회짜리 노이즈 제거)
  const staffEntities = Array.from(staffEntityFreq.entries())
    .filter(([, freq]) => freq >= STAFF_NAME_MIN_FREQ)
    .sort((a, b) => b[1] - a[1])
    .map(([word]) => word);

  // freqWords도 freq ≥ 2 인 단어만 채택 (1회짜리 오타·노이즈 팩트 제거)
  const freqWords = Array.from(wordFreq.entries())
    .filter(([, freq]) => freq >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([word]) => word)
    .filter(w => !staffEntities.includes(w)); // 중복 제거

  // 엔티티 최대 5개 우선 + 나머지 빈도 단어로 topN 채우기
  const entitySlots = Math.min(staffEntities.length, 5);
  const result = [
    ...staffEntities.slice(0, entitySlots),
    ...freqWords.slice(0, topN - entitySlots),
  ];

  return result.slice(0, topN);
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
      temperature: 0.8,
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
      temperature: 0.8,
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

    // ★ Opus temperature rider: claude-opus-* 모델은 temperature 제외 (deprecated)
    const isOpusSamples = model.startsWith('claude-opus-');

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
      ...(isOpusSamples ? {} : { temperature: 0.8 }),
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

// =============================================================================
// Phase 4-2 — AI 리뷰 진단 탐지 엔진
// =============================================================================

// ── effectiveSuspect 튜닝 상수 (재배포만으로 조정 가능) ─────────────────────
/** 이 글자수 미만 = '짧은 리뷰' */
const AI_SHORT_LEN = 30;
/** 짧은 리뷰이고 강신호가 없으면 의심점수를 이 값으로 캡 (의심 임계 60 미만) */
const AI_SOFT_SHORT_CAP = 39;
/** 길이 무관 강신호 플래그 — 이 중 하나라도 있으면 캡 적용 안 함 */
const AI_HARD_FLAGS = new Set(['광고체', '과장', '업종불일치', '템플릿성']);

/**
 * 읽기 시점 의심점수 보정 헬퍼 (저장값 변경 없음, 재배포만으로 즉시 반영).
 * 짧은 리뷰(AI_SHORT_LEN 미만)는 디테일이 없는 게 당연하므로,
 * 강신호 플래그가 없는 경우에 한해 AI_SOFT_SHORT_CAP으로 캡을 씌운다.
 *
 * @param {number|null} rawAiSuspect  DB 원점수
 * @param {number}      bodyLen       본문 글자 수 (length(pr.body))
 * @param {string[]}    flags         분석 플래그 배열
 * @returns {number|null}  유효 의심점수 (null이면 GPT 미판정)
 */
function effectiveSuspect(rawAiSuspect, bodyLen, flags) {
  if (rawAiSuspect === null || rawAiSuspect === undefined) return null;
  if (bodyLen < AI_SHORT_LEN) {
    const hasHardFlag = Array.isArray(flags) && flags.some(f => AI_HARD_FLAGS.has(f));
    if (!hasHardFlag) {
      return Math.min(rawAiSuspect, AI_SOFT_SHORT_CAP);
    }
  }
  return rawAiSuspect;
}

// ── AI형/광고형 꼬리표 헬퍼 (읽는 시점 계산, 저장값 변경 없음) ─────────────
/** 광고 성격 플래그 — 하나라도 있으면 'ad' */
const AD_KIND_FLAGS = new Set(['광고체', '과장']);
/** AI 작성 성격 플래그 — 광고형 없고 이것들만 있으면 'ai' */
const AI_KIND_FLAGS = new Set(['격식체', '템플릿성', '장점나열', '정갈끝이모지', '추상칭찬', '구체성결여']);

/**
 * 저장된 flags 배열에서 'ad'|'ai'|null 꼬리표를 결정.
 * 광고형 우선: 광고형 플래그 있으면 'ad', 없고 AI형 플래그만 있으면 'ai', 둘 다 없으면 null.
 * @param {string[]} flags
 * @returns {'ad'|'ai'|null}
 */
function reviewKind(flags) {
  if (!Array.isArray(flags)) return null;
  if (flags.some(f => AD_KIND_FLAGS.has(f))) return 'ad';
  if (flags.some(f => AI_KIND_FLAGS.has(f))) return 'ai';
  return null;
}

/**
 * 1단계 규칙 필터 — 명백한 저품질 리뷰 판별 (무료, deterministic).
 * true = 저품질(빈·극초단문·자모·특수문자만) → AI 아님, GPT 호출 스킵.
 * @param {string|null} body
 * @returns {boolean}
 */
function classifyRuleLowQuality(body) {
  if (body == null) return true;
  const trimmed = body.trim();
  // 빈 문자열 또는 길이 ≤ 2
  if (trimmed.length <= 2) return true;
  // 자모만 (한글 자음·모음·공백만으로 구성)
  if (/^[ㄱ-ㅎㅏ-ㅣ\s]+$/.test(trimmed)) return true;
  // 한글 음절(가-힣)도 없고 영문자(a-zA-Z)도 없음 → 특수문자·숫자·기호·이모지만
  if (!/[가-힣a-zA-Z]/.test(trimmed)) return true;
  return false;
}

/**
 * 2단계 휴리스틱 슬롭 점수 (무료, deterministic).
 * §8.2 신호를 가점 합산 후 0~100 클램프.
 * @param {string} body 리뷰 본문
 * @param {Set<string>} factPoolSet extractFactPool 결과를 Set으로 변환한 것
 * @returns {{ score: number, flags: string[] }}
 *
 * 후속 TODO: 템플릿 유사도 (동일 골격 반복) — 리뷰 간 비교라 이번엔 생략
 */
function computeHeuristicSlopScore(body, factPoolSet) {
  const flags = [];
  let score = 0;

  if (!body || body.trim().length === 0) return { score: 0, flags };

  // ── 신호 1: 격식체 종결어미 비율 높음 ────────────────────────────────
  // 문장 끝 격식 패턴 수 / 전체 종결 패턴 수 비율
  const FORMAL_ENDINGS = /습니다|였습니다|입니다|됩니다|습니까|겠습니다|드립니다|합니다|았습니다|었습니다/g;
  const CASUAL_ENDINGS = /아요|어요|이에요|예요|죠|네요|거든요|더라구요|인 것 같아요|같아요|같음|ㄴ것 같|거 같|것 같|것같|했어|이야|이에요|라구요|라고요/g;
  const formalCount  = (body.match(FORMAL_ENDINGS) || []).length;
  const casualCount  = (body.match(CASUAL_ENDINGS) || []).length;
  const totalEndings = formalCount + casualCount;
  if (totalEndings > 0) {
    const formalRatio = formalCount / totalEndings;
    if (formalRatio >= 0.7) {
      // 격식 종결이 70% 이상
      score += 30;
      flags.push('격식체');
    } else if (formalRatio >= 0.4) {
      score += 15;
      flags.push('격식체');
    }
  } else if (formalCount >= 2) {
    // 구어 없이 격식만 2개+
    score += 25;
    flags.push('격식체');
  }

  // ── 신호 2: 추상 칭찬어 다수 + fact pool 구체명사 겹침 0 ──────────────
  const ABSTRACT_PRAISE = [
    '친절', '깨끗', '청결', '만족', '추천', '최고', '정성', '꼼꼼', '편안',
    '훌륭', '탁월', '완벽', '감동', '뛰어나', '좋았', '좋아요', '좋습니다',
    '마음에 들', '마음에들', '강추', '극추',
  ];
  const abstractCount = ABSTRACT_PRAISE.filter(w => body.includes(w)).length;

  // fact pool과 토큰 겹침 확인
  const tokens = body.split(/[\s.,!?;:·""''()\[\]{}<>/\\|@#$%^&*+=~`\-—–…]+/u)
    .map(t => t.trim())
    .filter(t => t.length >= 2);
  const hasFactOverlap = tokens.some(t => factPoolSet.has(t));

  if (abstractCount >= 3 && !hasFactOverlap) {
    score += 25;
    flags.push('추상칭찬');
  } else if (abstractCount >= 2 && !hasFactOverlap) {
    score += 12;
    flags.push('추상칭찬');
  }

  // ── 신호 3: 구체성 결여 — 본문 토큰이 fact pool과 하나도 안 겹침 ────────
  if (!hasFactOverlap && factPoolSet.size > 0) {
    score += 15;
    flags.push('구체성결여');
  }

  // ── 신호 4: 장점 나열 패턴 (형용사 3개+ "~고/~며/~하고"로 연결) ─────────
  // 한국어 형용사 어간 + 연결어미 패턴: ~고, ~며, ~하고, ~이고
  const ADJ_CHAIN = /(?:[가-힣]{1,6}(?:하고|이고|으며|고|며)\s*){2,}[가-힣]{1,6}(?:했어요|합니다|했습니다|이에요|이어요|요)/g;
  const chainMatches = body.match(ADJ_CHAIN) || [];
  if (chainMatches.length > 0) {
    score += 20;
    flags.push('장점나열');
  }

  // ── 신호 5: 정갈한 문장(격식체 or 오타 없음) + 끝 그림이모지 ─────────────
  // 그림이모지: 기본 이모지 유니코드 범위 (U+1F300~U+1F9FF, U+2600~U+27BF, U+FE0F 등)
  const EMOJI_RE = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{FE0F}]/u;
  const lastChars = body.trim().slice(-10);
  const endsWithEmoji = EMOJI_RE.test(lastChars);
  if (endsWithEmoji && (formalCount >= 1 || (abstractCount >= 2 && casualCount === 0))) {
    score += 15;
    flags.push('정갈끝이모지');
  }

  return { score: Math.min(100, Math.max(0, score)), flags };
}

/**
 * 3단계 LLM 진정성 판별 — 배치 호출 (유료, §8.3 기준).
 * callLLMForSamples와 동일한 provider 분기 패턴.
 * @param {object} env
 * @param {string} provider  'openai' | 'anthropic' | 'xai'
 * @param {string} model
 * @param {{ review_id: string, body: string }[]} items  배치 (20~30건 권장)
 * @returns {Promise<{ results: { review_id:string, ai_suspect:number, flags:string[], sentiment:string, reason:string }[], usage: {prompt_tokens:number, completion_tokens:number} }>}
 */
async function callLLMForAuthenticity(env, provider, model, items) {
  const systemPrompt = `너는 한국어 네이버 플레이스 리뷰가 AI·광고 대행사에 의해 작성됐을 가능성을 판별하는 전문가다.

[중요: 짧은 리뷰 취급]
대략 30자 미만의 짧은 리뷰는 디테일이 없는 게 정상이다.
단지 짧고 구체성이 없다는 이유만으로 AI/광고로 의심하지 마라.
AI/광고 의심은 *길게 쓰면서도* 상투적·홍보성·과장된 경우에 집중하라.
짧은 캐주얼 리뷰(예: '친절해요^^', '좋았어요', '맛있어요~')는 대개 평범한 사람 리뷰이므로 낮은 점수(0~30)를 부여하라.

[판별 기준]
🚩 AI/광고 의심 신호:
- 구체성 결여: 메뉴·시술·직원·시간·상황 등 실제 경험 디테일 없이 일반 칭찬만 나열 (긴 리뷰에서만 의미 있음)
- 템플릿성: "친절하고 깨끗하고 만족스러웠어요" 류 상투어 나열
- 광고체·문어체(격식체) 어조, 부자연스러운 과장
- 업종 맥락 불일치 (리뷰 내용이 업종과 어울리지 않음)

✅ 진짜(사람) 확률 ↑ 신호:
- 구체적 불만·개인 감정
- 특정 메뉴명·직원명·날짜·날씨 등 디테일 포함
- 비대칭 평가 (좋은 점과 아쉬운 점 혼재)
- 오타·구어체·말 줄임
- 짧고 캐주얼한 일상 표현 (길이 30자 미만)

[출력 규칙]
반드시 다음 JSON 구조만 응답 (다른 텍스트 없이 순수 JSON):
{
  "results": [
    {
      "review_id": "...",
      "ai_suspect": 0,
      "flags": [],
      "sentiment": "positive",
      "reason": "한 줄 근거"
    }
  ]
}

- ai_suspect: 0~100 정수. 높을수록 AI/광고 의심 (낮을수록 진짜 사람 리뷰).
- flags: 해당하는 것만 포함. 후보: ["구체성결여","템플릿성","광고체","격식체","업종불일치","추상칭찬","과장"]
- sentiment: "positive" | "neutral" | "negative"
- reason: 판단 근거 한 줄 (30자 이내)
- 입력된 모든 review_id에 대해 빠짐없이 결과를 반환할 것.`;

  const reviewsText = items
    .map((item, i) => `[${i + 1}] review_id=${item.review_id}\n${item.body}`)
    .join('\n\n');
  const userPrompt = `다음 ${items.length}개 리뷰를 판별하라:\n\n${reviewsText}`;

  const maxTokens = Math.max(1000, items.length * 120);

  if (provider === 'openai') {
    if (!env.OPENAI_API_KEY) throw Object.assign(new Error('OpenAI API 키가 설정되지 않았습니다'), { code: 'no_openai_key' });

    const reqBody = {
      model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt },
      ],
      temperature: 0.1,
      max_completion_tokens: maxTokens,
    };

    async function fetchOnceOpenAI() {
      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.OPENAI_API_KEY}` },
        body: JSON.stringify(reqBody),
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`OpenAI API 오류 ${resp.status}: ${errText.slice(0, 200)}`);
      }
      const data = await resp.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new Error('OpenAI 응답에 content가 없습니다');
      const parsed = JSON.parse(content);
      if (!Array.isArray(parsed?.results)) throw new Error('OpenAI 응답 구조 오류: results 배열 없음');
      return {
        results: parsed.results,
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

    const reqBody = {
      model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt },
      ],
      temperature: 0.1,
      max_completion_tokens: maxTokens,
    };

    async function fetchOnceXAI() {
      const resp = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.XAI_API_KEY}` },
        body: JSON.stringify(reqBody),
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`xAI API 오류 ${resp.status}: ${errText.slice(0, 200)}`);
      }
      const data = await resp.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new Error('xAI 응답에 content가 없습니다');
      const parsed = JSON.parse(content);
      if (!Array.isArray(parsed?.results)) throw new Error('xAI 응답 구조 오류: results 배열 없음');
      return {
        results: parsed.results,
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

    // ★ Opus temperature rider: claude-opus-* 모델은 temperature 제외 (deprecated)
    const isOpusAuth = model.startsWith('claude-opus-');

    const anthropicBody = {
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      tools: [
        {
          name: 'emit_analysis',
          description: '리뷰 진정성 분석 결과를 반환한다',
          input_schema: {
            type: 'object',
            properties: {
              results: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    review_id:  { type: 'string' },
                    ai_suspect: { type: 'integer' },
                    flags:      { type: 'array', items: { type: 'string' } },
                    sentiment:  { type: 'string' },
                    reason:     { type: 'string' },
                  },
                  required: ['review_id', 'ai_suspect', 'flags', 'sentiment', 'reason'],
                },
              },
            },
            required: ['results'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'emit_analysis' },
      ...(isOpusAuth ? {} : { temperature: 0.1 }),
    };

    async function fetchOnceAnthropic() {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(anthropicBody),
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`Anthropic API 오류 ${resp.status}: ${errText.slice(0, 200)}`);
      }
      const data = await resp.json();
      const toolBlock = Array.isArray(data?.content)
        ? data.content.find(b => b.type === 'tool_use' && b.name === 'emit_analysis')
        : null;
      if (!toolBlock?.input) throw new Error('Anthropic 응답에 emit_analysis tool_use 블록이 없습니다');
      const parsed = toolBlock.input;
      if (!Array.isArray(parsed?.results)) throw new Error('Anthropic 응답 구조 오류: results 배열 없음');
      return {
        results: parsed.results,
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

// =============================================================================
// Phase 4-2 Step A2 — LLM judge: codebook 기반 4분류 판별기
// 주의: 다중평가(IAA) 전이라 결과는 *잠정(단일 평가자 대비)* — "검증됨" 주장 금지.
// =============================================================================

/**
 * Codebook 기반 LLM 판별기 — 배치 호출.
 * place_review_labels에 사람 라벨된 리뷰를 4분류(genuine/ad/ai/unsure)하고
 * review_llm_classifications 테이블에 upsert 저장용 결과를 반환한다.
 *
 * ★ Opus temperature rider:
 *   anthropic provider에서 model이 'claude-opus-'로 시작하면
 *   temperature 파라미터를 제외한다 (Opus 4.8 deprecated).
 *
 * @param {object} env
 * @param {string} provider  'openai' | 'anthropic' | 'xai'
 * @param {string} model
 * @param {{ review_id: string, body: string }[]} items
 * @returns {Promise<{ results: { review_id: string, llm_label: string, reason: string }[], usage: { prompt_tokens: number, completion_tokens: number } }>}
 */
async function classifyReviewLLM(env, provider, model, items) {
  // Codebook 핵심 규칙을 임베드한 시스템 프롬프트
  const systemPrompt = `너는 한국어 네이버 플레이스 리뷰를 4분류하는 전문가다.
아래 Codebook 규칙에 따라 각 리뷰를 정확히 분류하라.

## 4분류 정의
- genuine: 실제 방문·시술 경험을 본인이 직접 서술. 홍보 의도 없음.
- ad: 사람이 썼지만 판촉 구조(추천 CTA·지역 타겟·실명 plug)가 핵심.
- ai: 구체 경험 없이 기계적으로 조립된 일반 칭찬 패턴.
- unsure: 신호 부족·상충으로 판단 불가.

## 판정 체크리스트 (이 순서로 적용)
1. 판촉 구조 있음? (지역CTA "경기광주 분 추천" / 담당자 실명 plug / 이벤트 유도)
   → YES → ad

2. 구체 경험 0 + 표현이 정갈·반복적? ("말랑말랑+촉촉+다음방문기대" 같은 骨格 반복)
   → YES → ai

3. 오타·구체 디테일·군말·불완전성 있음? (시술명·수치·부위·개인상황·양가감정)
   → YES → genuine

4. 그 외 (너무 짧아 단서 없음 / 신호 상충)?
   → unsure (단, 하나라도 뚜렷한 신호 있으면 억지로 unsure 두지 말 것)

## 주의
- 길고 긍정적이라고 ad가 아님. genuine도 길게 쓴다.
- ai vs genuine 핵심: 정갈함(no 오타·구체성) vs 불완전성(오타·디테일·군말).
- unsure 남발 금지. 뚜렷한 신호 하나면 해당 라벨로.

## 출력 규칙
반드시 다음 JSON 구조만 응답 (다른 텍스트 없이 순수 JSON):
{
  "results": [
    {
      "review_id": "...",
      "llm_label": "genuine",
      "reason": "판단 근거 한 줄 (30자 이내)"
    }
  ]
}
- llm_label 값은 반드시 genuine | ad | ai | unsure 중 하나.
- 입력된 모든 review_id에 대해 빠짐없이 결과를 반환할 것.`;

  const reviewsText = items
    .map((item, i) => `[${i + 1}] review_id=${item.review_id}\n${item.body}`)
    .join('\n\n');
  const userPrompt = `다음 ${items.length}개 리뷰를 Codebook 기준으로 4분류하라:\n\n${reviewsText}`;

  const maxTokens = Math.max(800, items.length * 100);

  if (provider === 'openai') {
    if (!env.OPENAI_API_KEY) throw Object.assign(new Error('OpenAI API 키가 설정되지 않았습니다'), { code: 'no_openai_key' });

    const reqBody = {
      model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt },
      ],
      temperature: 0.1,
      max_completion_tokens: maxTokens,
    };

    async function fetchOnceOpenAIClassify() {
      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.OPENAI_API_KEY}` },
        body: JSON.stringify(reqBody),
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`OpenAI API 오류 ${resp.status}: ${errText.slice(0, 200)}`);
      }
      const data = await resp.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new Error('OpenAI 응답에 content가 없습니다');
      const parsed = JSON.parse(content);
      if (!Array.isArray(parsed?.results)) throw new Error('OpenAI 응답 구조 오류: results 배열 없음');
      return {
        results: parsed.results,
        usage: {
          prompt_tokens:     data?.usage?.prompt_tokens     ?? 0,
          completion_tokens: data?.usage?.completion_tokens ?? 0,
        },
      };
    }

    try {
      return await fetchOnceOpenAIClassify();
    } catch (firstErr) {
      if (firstErr instanceof SyntaxError) return await fetchOnceOpenAIClassify();
      throw firstErr;
    }
  }

  if (provider === 'xai') {
    if (!env.XAI_API_KEY) throw Object.assign(new Error('xAI API 키가 설정되지 않았습니다'), { code: 'no_xai_key' });

    const reqBody = {
      model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt },
      ],
      temperature: 0.1,
      max_completion_tokens: maxTokens,
    };

    async function fetchOnceXAIClassify() {
      const resp = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.XAI_API_KEY}` },
        body: JSON.stringify(reqBody),
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`xAI API 오류 ${resp.status}: ${errText.slice(0, 200)}`);
      }
      const data = await resp.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new Error('xAI 응답에 content가 없습니다');
      const parsed = JSON.parse(content);
      if (!Array.isArray(parsed?.results)) throw new Error('xAI 응답 구조 오류: results 배열 없음');
      return {
        results: parsed.results,
        usage: {
          prompt_tokens:     data?.usage?.prompt_tokens     ?? 0,
          completion_tokens: data?.usage?.completion_tokens ?? 0,
        },
      };
    }

    try {
      return await fetchOnceXAIClassify();
    } catch (firstErr) {
      if (firstErr instanceof SyntaxError) return await fetchOnceXAIClassify();
      throw firstErr;
    }
  }

  if (provider === 'anthropic') {
    if (!env.ANTHROPIC_API_KEY) throw Object.assign(new Error('Anthropic API 키가 설정되지 않았습니다'), { code: 'no_anthropic_key' });

    // ★ Opus temperature rider: claude-opus-* 모델은 temperature 제외 (deprecated)
    const isOpus = model.startsWith('claude-opus-');

    const anthropicBody = {
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      tools: [
        {
          name: 'emit_classifications',
          description: '리뷰 4분류(genuine/ad/ai/unsure) 결과를 반환한다',
          input_schema: {
            type: 'object',
            properties: {
              results: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    review_id: { type: 'string' },
                    llm_label: { type: 'string', enum: ['genuine', 'ad', 'ai', 'unsure'] },
                    reason:    { type: 'string' },
                  },
                  required: ['review_id', 'llm_label', 'reason'],
                },
              },
            },
            required: ['results'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'emit_classifications' },
      ...(isOpus ? {} : { temperature: 0.1 }),
    };

    async function fetchOnceAnthropicClassify() {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(anthropicBody),
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`Anthropic API 오류 ${resp.status}: ${errText.slice(0, 200)}`);
      }
      const data = await resp.json();
      const toolBlock = Array.isArray(data?.content)
        ? data.content.find(b => b.type === 'tool_use' && b.name === 'emit_classifications')
        : null;
      if (!toolBlock?.input) throw new Error('Anthropic 응답에 emit_classifications tool_use 블록이 없습니다');
      const parsed = toolBlock.input;
      if (!Array.isArray(parsed?.results)) throw new Error('Anthropic 응답 구조 오류: results 배열 없음');
      return {
        results: parsed.results,
        usage: {
          prompt_tokens:     data?.usage?.input_tokens  ?? 0,
          completion_tokens: data?.usage?.output_tokens ?? 0,
        },
      };
    }

    return await fetchOnceAnthropicClassify();
  }

  throw new Error(`지원하지 않는 provider: ${provider}`);
}

/**
 * POST /api/labels/llm-classify  (admin 전용)
 * place_review_labels에 라벨된 리뷰 전체를 classifyReviewLLM으로 분류 →
 * review_llm_classifications에 upsert 저장.
 * body: { provider?: string, model?: string }
 * 결과: { ok: true, classified: number, usage: {...}, cost_usd: number|null }
 *
 * 주의: 결과는 *잠정(단일 평가자 대비)* — IAA 검증 전임.
 */
async function handleLLMClassify(request, env, corsHeaders) {
  const cors = corsHeaders || {};

  // admin 전용
  const authResult = await requireAdmin(request, env);
  if (authResult.error) {
    return jsonResponse({ error: authResult.error, message: authResult.message }, authResult.status, cors);
  }

  // body 파싱
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'invalid_json', message: 'Request body must be valid JSON' }, 400, cors);
  }

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

  const resolvedModel = (typeof body?.model === 'string' && body.model.trim())
    ? body.model.trim()
    : PROVIDER_DEFAULT_MODEL[provider];

  // place_review_labels에 라벨된 리뷰 + 본문 로드
  let labeledRows;
  try {
    const { results } = await env.DB.prepare(`
      SELECT prl.review_id, pr.body
      FROM place_review_labels prl
      LEFT JOIN place_reviews pr ON pr.id = prl.review_id
      WHERE prl.human_label IS NOT NULL
    `).all();
    labeledRows = results ?? [];
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
  }

  if (labeledRows.length === 0) {
    return jsonResponse({ ok: true, classified: 0, usage: { prompt_tokens: 0, completion_tokens: 0 }, cost_usd: 0 }, 200, cors);
  }

  // 배치 처리 (25건씩)
  const BATCH_SIZE = 25;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  const classifyResultMap = new Map();

  try {
    for (let i = 0; i < labeledRows.length; i += BATCH_SIZE) {
      const batch = labeledRows.slice(i, i + BATCH_SIZE).map(r => ({
        review_id: r.review_id,
        body:      r.body ?? '',
      }));
      const { results, usage } = await classifyReviewLLM(env, provider, resolvedModel, batch);
      totalPromptTokens     += usage.prompt_tokens;
      totalCompletionTokens += usage.completion_tokens;
      for (const r of results) {
        classifyResultMap.set(r.review_id, r);
      }
    }
  } catch (err) {
    return jsonResponse({ error: 'llm_error', message: err.message }, 502, cors);
  }

  // review_llm_classifications에 upsert
  const VALID_LLM_LABELS = new Set(['genuine', 'ad', 'ai', 'unsure']);
  const now = new Date().toISOString();
  let classified = 0;

  try {
    for (const row of labeledRows) {
      const res = classifyResultMap.get(row.review_id);
      if (!res) continue;
      const llmLabel = VALID_LLM_LABELS.has(res.llm_label) ? res.llm_label : 'unsure';
      const reason = typeof res.reason === 'string' ? res.reason.slice(0, 200) : null;

      await env.DB.prepare(`
        INSERT INTO review_llm_classifications (review_id, model, llm_label, reason, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(review_id, model) DO UPDATE SET
          llm_label  = excluded.llm_label,
          reason     = excluded.reason,
          created_at = excluded.created_at
      `).bind(row.review_id, resolvedModel, llmLabel, reason, now).run();

      classified++;
    }
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
  }

  const costUsd = computeCostUsd(resolvedModel, totalPromptTokens, totalCompletionTokens);

  return jsonResponse({
    ok: true,
    classified,
    model: resolvedModel,
    // 결과는 잠정(단일 평가자 대비) — IAA 검증 전
    note: '잠정(단일 평가자 대비) — IAA 검증 전',
    usage: { prompt_tokens: totalPromptTokens, completion_tokens: totalCompletionTokens },
    cost_usd: costUsd,
  }, 200, cors);
}

/**
 * AI 리뷰 진단 오케스트레이션.
 * 미캐시 리뷰를 로드 → 규칙필터 → 휴리스틱 triage → GPT 배치 판별 → DB 캐시 저장.
 *
 * @param {object} env
 * @param {string} placeRowId
 * @param {{ heuristicThreshold?: number, maxGpt?: number, provider?: string, model?: string, actorUserId?: string }} opts
 * @returns {Promise<{ analyzed: number, low_quality: number, gpt_called: number, gpt_skipped: number, usage: { prompt_tokens: number, completion_tokens: number, cost_usd: number|null } }>}
 */
const ANALYZE_GATE = 40; // 내부 고정 — 외부 노출 안 함

async function analyzePlaceReviews(env, placeRowId, {
  scope = 'suspect',   // 'suspect' | 'all' | 'rejudge' | 'heuristic'
  maxGpt = 200,
  provider = 'openai',
  model = null,
  actorUserId = null,
} = {}) {
  const resolvedModel = model || PROVIDER_DEFAULT_MODEL[provider] || PROVIDER_DEFAULT_MODEL['openai'];

  // scope='rejudge': 이미 GPT 판정된 행 전체를 재판정 (개선된 프롬프트 적용)
  if (scope === 'rejudge') {
    const { results: rejudgeRows } = await env.DB.prepare(`
      SELECT pra.review_id, pr.body, pra.heuristic_score, pra.flags AS existing_flags
      FROM place_review_analysis pra
      LEFT JOIN place_reviews pr ON pr.id = pra.review_id
      WHERE pra.place_row_id = ?
        AND pra.ai_suspect IS NOT NULL
    `).bind(placeRowId).all();

    if (rejudgeRows.length === 0) {
      return { analyzed: 0, low_quality: 0, gpt_called: 0, gpt_skipped: 0, usage: { prompt_tokens: 0, completion_tokens: 0, cost_usd: 0 } };
    }

    const factPoolArr = await extractFactPool(env, placeRowId, SAMPLE_FACT_POOL_SIZE);
    const factPoolSet = new Set(factPoolArr);
    const analyzedAt = new Date().toISOString();

    // 재판정 대상 중 최대 maxGpt건
    const rejudgeCandidates = rejudgeRows.slice(0, maxGpt);
    const BATCH_SIZE = 25;
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    const gptResultMap = new Map();

    for (let i = 0; i < rejudgeCandidates.length; i += BATCH_SIZE) {
      const batch = rejudgeCandidates.slice(i, i + BATCH_SIZE).map(r => ({
        review_id: r.review_id,
        body:      r.body ?? '',
      }));
      const { results, usage } = await callLLMForAuthenticity(env, provider, resolvedModel, batch);
      totalPromptTokens     += usage.prompt_tokens;
      totalCompletionTokens += usage.completion_tokens;
      for (const r of results) {
        gptResultMap.set(r.review_id, r);
      }
    }

    const insertStmts = [];
    for (const cand of rejudgeCandidates) {
      const gptResult = gptResultMap.get(cand.review_id);
      if (!gptResult) continue;

      const { score: hScore, flags: hFlags } = computeHeuristicSlopScore(cand.body ?? '', factPoolSet);
      const mergedFlagsSet = new Set([...hFlags, ...(gptResult.flags ?? [])]);
      const mergedFlags = JSON.stringify([...mergedFlagsSet]);
      const aiSuspect = typeof gptResult.ai_suspect === 'number'
        ? Math.min(100, Math.max(0, Math.round(gptResult.ai_suspect)))
        : null;
      insertStmts.push(
        env.DB.prepare(`
          INSERT OR REPLACE INTO place_review_analysis
            (review_id, place_row_id, ai_suspect, rule_low_quality, heuristic_score, flags, sentiment, reason, model, analyzed_at)
          VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
        `).bind(
          cand.review_id, placeRowId, aiSuspect,
          hScore, mergedFlags,
          gptResult.sentiment ?? null, gptResult.reason ?? null, resolvedModel, analyzedAt
        )
      );
    }

    if (gptResultMap.size > 0) {
      const costUsd = computeCostUsd(resolvedModel, totalPromptTokens, totalCompletionTokens);
      const usageId = crypto.randomUUID();
      insertStmts.push(
        env.DB.prepare(`
          INSERT INTO llm_usage
            (id, place_row_id, kind, provider, model, prompt_tokens, completion_tokens, cost_usd, created_at, actor_user_id)
          VALUES (?, ?, 'analysis', ?, ?, ?, ?, ?, ?, ?)
        `).bind(usageId, placeRowId, provider, resolvedModel, totalPromptTokens, totalCompletionTokens, costUsd, analyzedAt, actorUserId)
      );
    }

    const CHUNK = 100;
    for (let i = 0; i < insertStmts.length; i += CHUNK) {
      await env.DB.batch(insertStmts.slice(i, i + CHUNK));
    }

    return {
      analyzed:    rejudgeCandidates.length,
      low_quality: 0,
      gpt_called:  gptResultMap.size,
      gpt_skipped: rejudgeCandidates.length - gptResultMap.size,
      usage: {
        prompt_tokens:     totalPromptTokens,
        completion_tokens: totalCompletionTokens,
        cost_usd:          gptResultMap.size > 0
          ? computeCostUsd(resolvedModel, totalPromptTokens, totalCompletionTokens)
          : 0,
      },
    };
  }

  // scope='heuristic': GPT 0회 — 규칙필터 + 휴리스틱 점수만으로 미캐시 전체 분류
  if (scope === 'heuristic') {
    const { results: uncachedForHeuristic } = await env.DB.prepare(`
      SELECT pr.id AS review_id, pr.body
      FROM place_reviews pr
      WHERE pr.place_row_id = ?
        AND pr.id NOT IN (SELECT review_id FROM place_review_analysis WHERE place_row_id = ?)
    `).bind(placeRowId, placeRowId).all();

    if (uncachedForHeuristic.length === 0) {
      return { analyzed: 0, low_quality: 0, heuristic_suspect: 0, presumed_human: 0, gpt_called: 0, gpt_skipped: 0, usage: { prompt_tokens: 0, completion_tokens: 0, cost_usd: 0 } };
    }

    const factPoolArr = await extractFactPool(env, placeRowId, SAMPLE_FACT_POOL_SIZE);
    const factPoolSet = new Set(factPoolArr);

    const analyzedAt = new Date().toISOString();
    const insertStmts = [];
    let hLowQuality = 0;
    let hSuspect = 0;
    let hPresumedHuman = 0;

    for (const row of uncachedForHeuristic) {
      const { review_id, body } = row;

      if (classifyRuleLowQuality(body)) {
        // 규칙 저품질 → ai_suspect=null, rule_low_quality=1
        hLowQuality++;
        insertStmts.push(
          env.DB.prepare(`
            INSERT OR REPLACE INTO place_review_analysis
              (review_id, place_row_id, ai_suspect, rule_low_quality, heuristic_score, flags, sentiment, reason, model, analyzed_at)
            VALUES (?, ?, NULL, 1, 0, '[]', NULL, NULL, NULL, ?)
          `).bind(review_id, placeRowId, analyzedAt)
        );
      } else {
        const { score, flags } = computeHeuristicSlopScore(body ?? '', factPoolSet);

        if (score >= ANALYZE_GATE) {
          // 게이트 통과 — 휴리스틱 추정 의심분: ai_suspect=score, 'heuristic_only' 마커 추가
          hSuspect++;
          const mergedFlags = JSON.stringify([...flags, 'heuristic_only']);
          insertStmts.push(
            env.DB.prepare(`
              INSERT OR REPLACE INTO place_review_analysis
                (review_id, place_row_id, ai_suspect, rule_low_quality, heuristic_score, flags, sentiment, reason, model, analyzed_at)
              VALUES (?, ?, ?, 0, ?, ?, NULL, NULL, NULL, ?)
            `).bind(review_id, placeRowId, score, score, mergedFlags, analyzedAt)
          );
        } else {
          // 게이트 미달 — presumed_human (ai_suspect=null)
          hPresumedHuman++;
          const mergedFlags = JSON.stringify([...flags, 'presumed_human']);
          insertStmts.push(
            env.DB.prepare(`
              INSERT OR REPLACE INTO place_review_analysis
                (review_id, place_row_id, ai_suspect, rule_low_quality, heuristic_score, flags, sentiment, reason, model, analyzed_at)
              VALUES (?, ?, NULL, 0, ?, ?, NULL, NULL, NULL, ?)
            `).bind(review_id, placeRowId, score, mergedFlags, analyzedAt)
          );
        }
      }
    }

    if (insertStmts.length > 0) {
      const CHUNK = 100;
      for (let i = 0; i < insertStmts.length; i += CHUNK) {
        await env.DB.batch(insertStmts.slice(i, i + CHUNK));
      }
    }

    return {
      analyzed:         uncachedForHeuristic.length,
      low_quality:      hLowQuality,
      heuristic_suspect: hSuspect,
      presumed_human:   hPresumedHuman,
      gpt_called:       0,
      gpt_skipped:      0,
      usage: { prompt_tokens: 0, completion_tokens: 0, cost_usd: 0 },
    };
  }

  // 1a. 미캐시 리뷰 로드 (분석 행 없는 것)
  const { results: uncachedRows } = await env.DB.prepare(`
    SELECT pr.id AS review_id, pr.body
    FROM place_reviews pr
    WHERE pr.place_row_id = ?
      AND pr.id NOT IN (SELECT review_id FROM place_review_analysis WHERE place_row_id = ?)
  `).bind(placeRowId, placeRowId).all();

  // 1b. 사람추정 재판정 후보 — ai_suspect IS NULL AND rule_low_quality=0 (캐시됐지만 GPT 미판정)
  const { results: presumedRows } = await env.DB.prepare(`
    SELECT pra.review_id, pr.body, pra.heuristic_score
    FROM place_review_analysis pra
    LEFT JOIN place_reviews pr ON pr.id = pra.review_id
    WHERE pra.place_row_id = ?
      AND pra.ai_suspect IS NULL
      AND (pra.rule_low_quality IS NULL OR pra.rule_low_quality = 0)
  `).bind(placeRowId).all();

  // 1c. heuristic_only 재판정 후보 — 휴리스틱 진단만 된 행(ai_suspect>=GATE, flags에 'heuristic_only')을 GPT로 정밀 판정
  const { results: heuristicOnlyRows } = await env.DB.prepare(`
    SELECT pra.review_id, pr.body, pra.heuristic_score, pra.flags AS existing_flags
    FROM place_review_analysis pra
    LEFT JOIN place_reviews pr ON pr.id = pra.review_id
    WHERE pra.place_row_id = ?
      AND pra.ai_suspect IS NOT NULL
      AND pra.ai_suspect >= ?
      AND pra.flags LIKE '%heuristic_only%'
      AND (pra.rule_low_quality IS NULL OR pra.rule_low_quality = 0)
  `).bind(placeRowId, ANALYZE_GATE).all();

  const hasWork = uncachedRows.length > 0 || presumedRows.length > 0 || heuristicOnlyRows.length > 0;
  if (!hasWork) {
    return { analyzed: 0, low_quality: 0, gpt_called: 0, gpt_skipped: 0, usage: { prompt_tokens: 0, completion_tokens: 0, cost_usd: 0 } };
  }

  // fact pool 추출 (구체성 결여 신호 계산에 사용)
  const factPoolArr = await extractFactPool(env, placeRowId, SAMPLE_FACT_POOL_SIZE);
  const factPoolSet = new Set(factPoolArr);

  const analyzedAt = new Date().toISOString();
  const insertStmts = [];
  let lowQualityCount = 0;
  // gptQueue: { review_id, body, heuristicScore, heuristicFlags }
  const gptQueue = [];
  let gptSkipped = 0;

  // 2 & 3. 미캐시 각 리뷰: 규칙필터 → 휴리스틱
  for (const row of uncachedRows) {
    const { review_id, body } = row;

    if (classifyRuleLowQuality(body)) {
      // 규칙 저품질 → ai_suspect=null, 즉시 캐시
      lowQualityCount++;
      insertStmts.push(
        env.DB.prepare(`
          INSERT OR REPLACE INTO place_review_analysis
            (review_id, place_row_id, ai_suspect, rule_low_quality, heuristic_score, flags, sentiment, reason, model, analyzed_at)
          VALUES (?, ?, NULL, 1, 0, '[]', NULL, NULL, NULL, ?)
        `).bind(review_id, placeRowId, analyzedAt)
      );
    } else {
      const { score, flags } = computeHeuristicSlopScore(body ?? '', factPoolSet);
      gptQueue.push({ review_id, body: body ?? '', heuristicScore: score, heuristicFlags: flags });
    }
  }

  // 사람추정 재판정 후보를 gptQueue에 추가 (heuristic_score 재사용, 없으면 재계산)
  for (const row of presumedRows) {
    const body = row.body ?? '';
    let heuristicScore = typeof row.heuristic_score === 'number' ? row.heuristic_score : null;
    let heuristicFlags = [];
    if (heuristicScore === null) {
      const computed = computeHeuristicSlopScore(body, factPoolSet);
      heuristicScore = computed.score;
      heuristicFlags = computed.flags;
    }
    // 이미 gptQueue에 없을 때만 추가 (review_id 중복 방지)
    gptQueue.push({ review_id: row.review_id, body, heuristicScore, heuristicFlags, isRecheck: true });
  }

  // 휴리스틱 전용 판정 후보를 gptQueue에 추가 — GPT 정밀 판정 대상 (isHeuristicOnly=true 마킹)
  const gptQueueIds = new Set(gptQueue.map(r => r.review_id));
  for (const row of heuristicOnlyRows) {
    if (gptQueueIds.has(row.review_id)) continue; // 중복 방지
    const body = row.body ?? '';
    const heuristicScore = typeof row.heuristic_score === 'number' ? row.heuristic_score : ANALYZE_GATE;
    // existing_flags에서 'heuristic_only' 제거한 순수 heuristic flags만 남김
    let existingFlags = [];
    try { existingFlags = JSON.parse(row.existing_flags ?? '[]'); } catch { /* ignore */ }
    const heuristicFlags = existingFlags.filter(f => f !== 'heuristic_only');
    gptQueue.push({ review_id: row.review_id, body, heuristicScore, heuristicFlags, isRecheck: true, isHeuristicOnly: true });
    gptQueueIds.add(row.review_id);
  }

  // 4. GPT 후보 결정
  // scope='suspect': heuristic_score >= GATE 인 것만
  // scope='all': 전부
  const gptCandidates = (
    scope === 'all'
      ? [...gptQueue]
      : gptQueue.filter(r => r.heuristicScore >= ANALYZE_GATE)
  )
    .sort((a, b) => b.heuristicScore - a.heuristicScore)
    .slice(0, maxGpt);

  const gptCandidateIds = new Set(gptCandidates.map(r => r.review_id));

  // 게이트 미달(또는 scope=suspect에서 score 낮은) 미캐시 → presumed_human으로 즉시 캐시
  for (const row of gptQueue) {
    if (!gptCandidateIds.has(row.review_id) && !row.isRecheck) {
      // 미캐시이면서 GPT 대상 아닌 것만 새로 캐시
      gptSkipped++;
      const flags = JSON.stringify([...row.heuristicFlags, 'presumed_human']);
      insertStmts.push(
        env.DB.prepare(`
          INSERT OR REPLACE INTO place_review_analysis
            (review_id, place_row_id, ai_suspect, rule_low_quality, heuristic_score, flags, sentiment, reason, model, analyzed_at)
          VALUES (?, ?, NULL, 0, ?, ?, NULL, NULL, NULL, ?)
        `).bind(row.review_id, placeRowId, row.heuristicScore, flags, analyzedAt)
      );
    }
  }

  // 5. GPT 배치 호출
  const BATCH_SIZE = 25;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  const gptResultMap = new Map(); // review_id → result

  for (let i = 0; i < gptCandidates.length; i += BATCH_SIZE) {
    const batch = gptCandidates.slice(i, i + BATCH_SIZE).map(r => ({
      review_id: r.review_id,
      body:      r.body,
    }));
    const { results, usage } = await callLLMForAuthenticity(env, provider, resolvedModel, batch);
    totalPromptTokens     += usage.prompt_tokens;
    totalCompletionTokens += usage.completion_tokens;
    for (const r of results) {
      gptResultMap.set(r.review_id, r);
    }
  }

  // 6. GPT 결과 + heuristic flags 병합 → INSERT
  for (const cand of gptCandidates) {
    const gptResult = gptResultMap.get(cand.review_id);
    if (!gptResult) {
      // GPT가 해당 review_id 결과를 빠뜨린 경우 — heuristic만으로 저장
      const flags = JSON.stringify(cand.heuristicFlags);
      insertStmts.push(
        env.DB.prepare(`
          INSERT OR REPLACE INTO place_review_analysis
            (review_id, place_row_id, ai_suspect, rule_low_quality, heuristic_score, flags, sentiment, reason, model, analyzed_at)
          VALUES (?, ?, NULL, 0, ?, ?, NULL, 'GPT 응답 누락', ?, ?)
        `).bind(cand.review_id, placeRowId, cand.heuristicScore, flags, resolvedModel, analyzedAt)
      );
      continue;
    }
    // heuristic flags + gpt flags 합산 (중복 제거, 'heuristic_only' 마커는 GPT 정밀 완료로 제거)
    const mergedFlagsSet = new Set([...cand.heuristicFlags, ...(gptResult.flags ?? [])]);
    mergedFlagsSet.delete('heuristic_only');
    const mergedFlags = JSON.stringify([...mergedFlagsSet]);
    const aiSuspect = typeof gptResult.ai_suspect === 'number'
      ? Math.min(100, Math.max(0, Math.round(gptResult.ai_suspect)))
      : null;
    insertStmts.push(
      env.DB.prepare(`
        INSERT OR REPLACE INTO place_review_analysis
          (review_id, place_row_id, ai_suspect, rule_low_quality, heuristic_score, flags, sentiment, reason, model, analyzed_at)
        VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
      `).bind(
        cand.review_id, placeRowId, aiSuspect,
        cand.heuristicScore, mergedFlags,
        gptResult.sentiment ?? null, gptResult.reason ?? null, resolvedModel, analyzedAt
      )
    );
  }

  // llm_usage 기록 (GPT 호출이 있었던 경우만)
  if (gptCandidates.length > 0) {
    const costUsd = computeCostUsd(resolvedModel, totalPromptTokens, totalCompletionTokens);
    const usageId = crypto.randomUUID();
    insertStmts.push(
      env.DB.prepare(`
        INSERT INTO llm_usage
          (id, place_row_id, kind, provider, model, prompt_tokens, completion_tokens, cost_usd, created_at, actor_user_id)
        VALUES (?, ?, 'analysis', ?, ?, ?, ?, ?, ?, ?)
      `).bind(usageId, placeRowId, provider, resolvedModel, totalPromptTokens, totalCompletionTokens, costUsd, analyzedAt, actorUserId)
    );
  }

  // 배치 INSERT
  if (insertStmts.length > 0) {
    // D1 batch는 한 번에 최대 100개 — 청크로 나눠 처리
    const CHUNK = 100;
    for (let i = 0; i < insertStmts.length; i += CHUNK) {
      await env.DB.batch(insertStmts.slice(i, i + CHUNK));
    }
  }

  return {
    analyzed:    uncachedRows.length,
    low_quality: lowQualityCount,
    gpt_called:  gptCandidates.length,
    gpt_skipped: gptSkipped,
    usage: {
      prompt_tokens:     totalPromptTokens,
      completion_tokens: totalCompletionTokens,
      cost_usd:          gptCandidates.length > 0
        ? computeCostUsd(resolvedModel, totalPromptTokens, totalCompletionTokens)
        : 0,
    },
  };
}

/**
 * GET /api/places/:id/ai-diagnosis  (researcher 이상, admin 포함)
 * 진단 집계 결과 조회. 비용 0 (DB 조회 전용).
 * 쿼리: suspectThreshold(기본 60, 0~100) — 이 점수 이상을 "AI 의심"으로 카운트.
 */
async function handleGetAiDiagnosis(request, env, corsHeaders, placeRowId) {
  const cors = corsHeaders || {};

  // researcher 이상 (admin 포함)
  const authResult = await requireResearcher(request, env);
  if (authResult.error) {
    return jsonResponse({ error: authResult.error, message: authResult.message }, authResult.status, cors);
  }

  // 플레이스 존재 + 소유 확인 (admin은 전체, researcher는 자기 지점만)
  let placeRow;
  try {
    placeRow = await env.DB.prepare(
      'SELECT id, user_id, name FROM review_places WHERE id = ?'
    ).bind(placeRowId).first();
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
  }

  if (!placeRow) {
    return jsonResponse({ error: 'place_not_found', message: '등록된 플레이스를 찾을 수 없습니다' }, 404, cors);
  }

  {
    const isAdmin = authResult.user.role === 'admin';
    if (!isAdmin && placeRow.user_id !== authResult.user.id) {
      return jsonResponse({ error: 'forbidden', message: '해당 플레이스에 대한 권한이 없습니다' }, 403, cors);
    }
  }

  // suspectThreshold 파싱 (기본 60, 0~100)
  const urlObj = new URL(request.url);
  let suspectThreshold = parseInt(urlObj.searchParams.get('suspectThreshold') ?? '60', 10);
  if (!Number.isFinite(suspectThreshold)) suspectThreshold = 60;
  suspectThreshold = Math.max(0, Math.min(100, suspectThreshold));

  // humanCorrection 파라미터 (bool) — true 면 사람 라벨로 suspect 분류 덮어쓰기
  const humanCorrection = urlObj.searchParams.get('humanCorrection') === 'true';

  try {
    // 1) 지점 전체 리뷰 수
    const totalReviewsRow = await env.DB.prepare(
      'SELECT COUNT(*) AS cnt FROM place_reviews WHERE place_row_id = ?'
    ).bind(placeRowId).first();
    const total_reviews = totalReviewsRow?.cnt ?? 0;

    // 2) 분석 행 전체 로드 + 사람 라벨 LEFT JOIN
    const { results: analysisRows } = await env.DB.prepare(`
      SELECT
        pra.ai_suspect,
        pra.rule_low_quality,
        pra.flags,
        pra.sentiment,
        pra.reason,
        pra.review_id,
        pr.body,
        pr.review_date,
        length(pr.body) AS body_len,
        prl.human_label,
        prl.human_note
      FROM place_review_analysis pra
      LEFT JOIN place_reviews pr ON pr.id = pra.review_id
      LEFT JOIN place_review_labels prl ON prl.review_id = pra.review_id
      WHERE pra.place_row_id = ?
    `).bind(placeRowId).all();

    const allRows = analysisRows ?? [];

    // JS 집계 — 유효 의심점수(effectiveSuspect) 기준 (+ humanCorrection 선택 적용)
    let total_analyzed    = 0;
    let low_quality       = 0;
    let presumed_human    = 0;
    let gpt_judged        = 0;  // 진짜 GPT 판정 건수 (heuristic_only 제외)
    let heuristic_suspect = 0;  // 휴리스틱 추정 건수 (ai_suspect 있으나 heuristic_only 마커 있음)
    let suspect           = 0;
    let suspect_pending   = 0;  // 휴리스틱 의심 중 GPT 미판정 건수 (suspect 버튼 대상)

    const buckets = ['0-19', '20-39', '40-59', '60-79', '80-100'];
    const bucketRanges = [[0, 19], [20, 39], [40, 59], [60, 79], [80, 100]];
    const distribution = Object.fromEntries(buckets.map(b => [b, 0]));
    const flag_breakdown = {};

    // 사람 검수 집계용
    const human_counts = { human: 0, ad: 0, ai: 0, unsure: 0 };
    // AI 일치율 집계 (unsure 제외한 human/ad/ai 라벨만)
    let agree_count = 0;
    let compared_count = 0;
    let false_positive = 0;  // AI=suspect, 사람=human
    let false_negative = 0;  // AI=not-suspect, 사람∈{ad,ai}

    // GPT 판정 행만 따로 수집 (sample_suspect 용)
    const gptJudgedItems = [];

    for (const row of allRows) {
      total_analyzed++;
      let flags_parsed = [];
      try { flags_parsed = JSON.parse(row.flags ?? '[]'); } catch { /* ignore */ }

      // 사람 라벨 집계 (분류 여부 무관)
      if (row.human_label === 'human') human_counts.human++;
      else if (row.human_label === 'ad') human_counts.ad++;
      else if (row.human_label === 'ai') human_counts.ai++;
      else if (row.human_label === 'unsure') human_counts.unsure++;

      if (row.rule_low_quality === 1) {
        low_quality++;
        continue;
      }

      if (row.ai_suspect === null || row.ai_suspect === undefined) {
        presumed_human++;
        continue;
      }

      // heuristic_only 마커 여부로 휴리스틱 추정 vs 진짜 GPT 분리
      const isHeuristicOnly = flags_parsed.includes('heuristic_only');
      const eff = effectiveSuspect(row.ai_suspect, row.body_len ?? 0, flags_parsed);

      if (isHeuristicOnly) {
        heuristic_suspect++;
      } else {
        // 진짜 GPT 판정 행
        gpt_judged++;
      }

      // humanCorrection 적용: 사람 라벨로 suspect 덮어쓰기
      // human∈{ad,ai} → suspect, human='human' → not-suspect, unsure/없음 → effectiveSuspect
      let isSuspect;
      if (humanCorrection) {
        if (row.human_label === 'ad' || row.human_label === 'ai') {
          isSuspect = true;
        } else if (row.human_label === 'human') {
          isSuspect = false;
        } else {
          isSuspect = eff >= suspectThreshold;
        }
      } else {
        isSuspect = eff >= suspectThreshold;
      }

      // AI 일치율 집계 (GPT 판정 행만 — 휴리스틱 추정 제외, 보정 모드 무관 순수 AI 기준)
      // "의심 정답" = human∈{ad,ai}, "사람 정답" = human='human', unsure 제외
      const aiIsSuspect = eff >= suspectThreshold;
      const humanIsSuspect = row.human_label === 'ad' || row.human_label === 'ai';
      if (!isHeuristicOnly && (row.human_label === 'human' || row.human_label === 'ad' || row.human_label === 'ai')) {
        compared_count++;
        if (aiIsSuspect === humanIsSuspect) {
          agree_count++;
        } else if (aiIsSuspect && !humanIsSuspect) {
          false_positive++;
        } else {
          false_negative++;
        }
      }

      // 점수대 분포 (항상 effectiveSuspect 기준)
      for (let i = 0; i < bucketRanges.length; i++) {
        const [lo, hi] = bucketRanges[i];
        if (eff >= lo && eff <= hi) {
          distribution[buckets[i]]++;
          break;
        }
      }

      // 의심 판정 (heuristic_only 포함 모두 effectiveSuspect 기준)
      if (isSuspect) {
        suspect++;
        // 플래그 집계 (의심 행만)
        for (const f of flags_parsed) {
          if (typeof f === 'string') {
            flag_breakdown[f] = (flag_breakdown[f] ?? 0) + 1;
          }
        }
      }

      // suspect_pending: 휴리스틱 의심 중 GPT 미판정 건수 ("의심만" 버튼 대상)
      if (isHeuristicOnly && eff >= suspectThreshold) {
        suspect_pending++;
      }

      // sample_suspect는 GPT 판정 행(진짜 GPT)에서만 수집
      if (isHeuristicOnly) continue;

      gptJudgedItems.push({
        review_id:     row.review_id,
        body:          row.body ?? '',
        ai_suspect:    eff,             // 유효점수
        raw_ai_suspect: row.ai_suspect, // 원점수
        flags:         flags_parsed,
        sentiment:     row.sentiment ?? null,
        reason:        row.reason ?? null,
        review_date:   row.review_date ?? null,
        body_len:      row.body_len ?? 0,
        human_label:   row.human_label ?? null,
        human_note:    row.human_note ?? null,
        is_suspect:    isSuspect,
      });
    }

    const denominator  = total_analyzed - low_quality;
    const suspect_rate = denominator > 0 ? suspect / denominator : 0;

    // 의심 리뷰 상위 30건 (유효점수 내림차순)
    const sample_suspect = gptJudgedItems
      .filter(r => r.is_suspect)
      .sort((a, b) => b.ai_suspect - a.ai_suspect)
      .slice(0, 30)
      .map(r => ({
        review_id:     r.review_id,
        body:          r.body,
        ai_suspect:    r.ai_suspect,
        raw_ai_suspect: r.raw_ai_suspect !== r.ai_suspect ? r.raw_ai_suspect : undefined,
        flags:         r.flags,
        sentiment:     r.sentiment,
        reason:        r.reason,
        review_date:   r.review_date,
        human_label:   r.human_label,
        human_note:    r.human_note,
        kind:          reviewKind(r.flags),
      }));

    // pending_all = GPT 미판정 전체 건수 (사람추정 + 미분석 + 휴리스틱 추정)
    // heuristic_only도 아직 GPT 판정이 안 된 상태이므로 전체 대상에 포함
    const unanalyzed = Math.max(0, total_reviews - total_analyzed);
    const pending_all = presumed_human + unanalyzed + heuristic_suspect;

    // agreement 계산 (unsure 제외, human/ad 라벨이 있는 GPT 판정 행만)
    const agreement = {
      compared: compared_count,
      agree:    agree_count,
      rate:     compared_count > 0 ? agree_count / compared_count : null,
      false_positive,
      false_negative,
    };

    return jsonResponse({
      place_name:        placeRow.name ?? '',
      suspect_threshold: suspectThreshold,
      human_correction:  humanCorrection,
      total_reviews,
      total_analyzed,
      low_quality,
      presumed_human,
      heuristic_suspect,
      gpt_judged,
      suspect,
      suspect_pending,
      denominator,
      suspect_rate,
      pending_all,
      distribution,
      flag_breakdown,
      sample_suspect,
      human_counts,
      agreement,
    }, 200, cors);
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
  }
}

/**
 * POST /api/places/:id/analyze-reviews  (admin 전용)
 * 미캐시 리뷰를 규칙필터 → 휴리스틱 triage → GPT 판별 → place_review_analysis 캐시 저장.
 * body: { scope?: 'suspect'|'all'(기본 'suspect'), maxGpt?: number(기본 200), provider?: string, model?: string }
 */
async function handleAnalyzeReviews(request, env, corsHeaders, placeRowId) {
  const cors = corsHeaders || {};

  // admin 전용
  const authResult = await requireAdmin(request, env);
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

  // scope 파싱 ('suspect' | 'all' | 'rejudge' | 'heuristic', 기본 'suspect')
  const VALID_SCOPES = ['suspect', 'all', 'rejudge', 'heuristic'];
  const scope = body?.scope ?? 'suspect';
  if (!VALID_SCOPES.includes(scope)) {
    return jsonResponse(
      { error: 'invalid_scope', message: `scope는 ${VALID_SCOPES.join(' | ')} 중 하나여야 합니다` },
      400,
      cors
    );
  }

  // heuristic scope는 GPT 불필요 — provider/key 검증 스킵
  let provider = body?.provider ?? 'openai';
  if (scope !== 'heuristic') {
    // provider / model 파싱
    const VALID_PROVIDERS = ['openai', 'anthropic', 'xai'];
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
  }

  const model = (typeof body?.model === 'string' && body.model.trim())
    ? body.model.trim()
    : PROVIDER_DEFAULT_MODEL[provider];

  // maxGpt 파싱 (기본 200)
  let maxGpt = body?.maxGpt ?? 200;
  if (typeof maxGpt !== 'number' || !Number.isFinite(maxGpt)) maxGpt = 200;
  maxGpt = Math.max(1, Math.min(5000, Math.floor(maxGpt)));

  // 플레이스 존재 확인 (admin은 전체 접근 가능)
  let placeRow;
  try {
    placeRow = await env.DB.prepare(
      'SELECT id, name FROM review_places WHERE id = ?'
    ).bind(placeRowId).first();
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
  }

  if (!placeRow) {
    return jsonResponse({ error: 'place_not_found', message: '등록된 플레이스를 찾을 수 없습니다' }, 404, cors);
  }

  // 분석 실행
  let analysisResult;
  try {
    analysisResult = await analyzePlaceReviews(env, placeRowId, {
      scope,
      maxGpt,
      provider,
      model,
      actorUserId: authResult.user.id,
    });
  } catch (err) {
    if (err.code === 'no_openai_key' || err.code === 'no_anthropic_key' || err.code === 'no_xai_key') {
      return jsonResponse({ error: err.code, message: err.message }, 503, cors);
    }
    return jsonResponse({ error: 'analysis_error', message: err.message }, 502, cors);
  }

  return jsonResponse({
    place_name: placeRow.name ?? '',
    provider,
    model,
    scope,
    max_gpt: maxGpt,
    ...analysisResult,
  }, 200, cors);
}

/**
 * GET /api/places/:id/ai-reviews  (researcher 이상)
 * 분류/점수대 드릴다운 조회.
 * 쿼리: bucket(low_quality|presumed_human|judged|suspect|all), scoreMin, scoreMax,
 *       suspectThreshold(기본 60), page(기본 1), size(기본 30, 최대 100)
 */
async function handleGetAiReviews(request, env, corsHeaders, placeRowId) {
  const cors = corsHeaders || {};

  // researcher 이상 (admin 포함)
  const authResult = await requireResearcher(request, env);
  if (authResult.error) {
    return jsonResponse({ error: authResult.error, message: authResult.message }, authResult.status, cors);
  }

  // 플레이스 존재 + 소유 확인
  let placeRow;
  try {
    placeRow = await env.DB.prepare(
      'SELECT id, user_id, name FROM review_places WHERE id = ?'
    ).bind(placeRowId).first();
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
  }

  if (!placeRow) {
    return jsonResponse({ error: 'place_not_found', message: '등록된 플레이스를 찾을 수 없습니다' }, 404, cors);
  }

  {
    const isAdmin = authResult.user.role === 'admin';
    if (!isAdmin && placeRow.user_id !== authResult.user.id) {
      return jsonResponse({ error: 'forbidden', message: '해당 플레이스에 대한 권한이 없습니다' }, 403, cors);
    }
  }

  // 쿼리 파라미터 파싱
  const urlObj = new URL(request.url);
  const VALID_BUCKETS = ['low_quality', 'presumed_human', 'judged', 'suspect', 'all'];
  const bucket = urlObj.searchParams.get('bucket') ?? 'all';

  let suspectThreshold = parseInt(urlObj.searchParams.get('suspectThreshold') ?? '60', 10);
  if (!Number.isFinite(suspectThreshold)) suspectThreshold = 60;
  suspectThreshold = Math.max(0, Math.min(100, suspectThreshold));

  const scoreMinRaw = urlObj.searchParams.get('scoreMin');
  const scoreMaxRaw = urlObj.searchParams.get('scoreMax');
  const scoreMin = scoreMinRaw !== null ? Math.max(0, Math.min(100, parseInt(scoreMinRaw, 10))) : null;
  const scoreMax = scoreMaxRaw !== null ? Math.max(0, Math.min(100, parseInt(scoreMaxRaw, 10))) : null;

  let page = parseInt(urlObj.searchParams.get('page') ?? '1', 10);
  if (!Number.isFinite(page) || page < 1) page = 1;

  let size = parseInt(urlObj.searchParams.get('size') ?? '30', 10);
  if (!Number.isFinite(size) || size < 1) size = 30;
  size = Math.min(100, size);

  // 사람 라벨 필터 (human|ad|ai|unsure)
  const VALID_HUMAN_LABELS = ['human', 'ad', 'ai', 'unsure'];
  const humanLabelFilter = urlObj.searchParams.get('humanLabel') ?? null;
  if (humanLabelFilter !== null && !VALID_HUMAN_LABELS.includes(humanLabelFilter)) {
    return jsonResponse(
      { error: 'invalid_humanLabel', message: `humanLabel은 ${VALID_HUMAN_LABELS.join(' | ')} 중 하나여야 합니다` },
      400,
      cors
    );
  }

  // humanCorrection — suspect 분류 시 사람 라벨 덮어쓰기
  const humanCorrection = urlObj.searchParams.get('humanCorrection') === 'true';

  if (!VALID_BUCKETS.includes(bucket)) {
    return jsonResponse(
      { error: 'invalid_bucket', message: `bucket는 ${VALID_BUCKETS.join(' | ')} 중 하나여야 합니다` },
      400,
      cors
    );
  }

  // effectiveSuspect 가 필요한 버킷: suspect, judged, scoreFilter, humanCorrection
  const hasScoreFilter = scoreMin !== null || scoreMax !== null;
  const needsEffective = hasScoreFilter || bucket === 'suspect' || bucket === 'judged' || humanLabelFilter !== null || humanCorrection;

  const offset = (page - 1) * size;

  try {
    if (needsEffective) {
      // GPT 판정 행 전체 로드 → JS에서 effectiveSuspect 계산 → 필터·정렬·페이지네이션
      const { results: judgedRows } = await env.DB.prepare(`
        SELECT
          pra.review_id,
          pr.body,
          pra.ai_suspect AS raw_ai_suspect,
          pra.flags,
          pra.sentiment,
          pra.reason,
          pr.review_date,
          pra.rule_low_quality,
          pra.heuristic_score,
          length(pr.body) AS body_len,
          prl.human_label,
          prl.human_note
        FROM place_review_analysis pra
        LEFT JOIN place_reviews pr ON pr.id = pra.review_id
        LEFT JOIN place_review_labels prl ON prl.review_id = pra.review_id
        WHERE pra.place_row_id = ? AND pra.ai_suspect IS NOT NULL
      `).bind(placeRowId).all();

      // effectiveSuspect 계산 후 필터
      const processed = (judgedRows ?? []).map(r => {
        let flags_parsed = [];
        try { flags_parsed = JSON.parse(r.flags ?? '[]'); } catch { /* ignore */ }
        const eff = effectiveSuspect(r.raw_ai_suspect, r.body_len ?? 0, flags_parsed);
        // humanCorrection 적용
        let isSuspect;
        if (humanCorrection) {
          if (r.human_label === 'ad' || r.human_label === 'ai') isSuspect = true;
          else if (r.human_label === 'human') isSuspect = false;
          else isSuspect = eff >= suspectThreshold;
        } else {
          isSuspect = eff >= suspectThreshold;
        }
        return { ...r, flags_parsed, eff, isSuspect };
      });

      let filtered;
      if (humanLabelFilter !== null) {
        // humanLabel 필터: 해당 라벨인 것만
        filtered = processed.filter(r => r.human_label === humanLabelFilter);
      } else if (hasScoreFilter) {
        filtered = processed.filter(r =>
          (scoreMin === null || r.eff >= scoreMin) &&
          (scoreMax === null || r.eff <= scoreMax)
        );
      } else if (bucket === 'suspect') {
        filtered = processed.filter(r => r.isSuspect);
      } else {
        // judged: 전부
        filtered = processed;
      }

      // 정렬: 유효점수 내림차순
      filtered.sort((a, b) => b.eff - a.eff);

      const total = filtered.length;
      const pageItems = filtered.slice(offset, offset + size);

      const items = pageItems.map(r => ({
        review_id:       r.review_id,
        body:            r.body ?? '',
        ai_suspect:      r.eff,
        raw_ai_suspect:  r.raw_ai_suspect !== r.eff ? r.raw_ai_suspect : undefined,
        flags:           r.flags_parsed,
        sentiment:       r.sentiment ?? null,
        reason:          r.reason ?? null,
        review_date:     r.review_date ?? null,
        rule_low_quality: r.rule_low_quality === 1,
        heuristic_score: r.heuristic_score ?? null,
        human_label:     r.human_label ?? null,
        human_note:      r.human_note ?? null,
        kind:            reviewKind(r.flags_parsed),
      }));

      return jsonResponse({ total, page, size, items }, 200, cors);
    }

    // effectiveSuspect 영향 없는 버킷: SQL 직접 처리
    const conditions = ['pra.place_row_id = ?'];
    const binds = [placeRowId];

    if (bucket === 'low_quality') {
      conditions.push('pra.rule_low_quality = 1');
    } else if (bucket === 'presumed_human') {
      conditions.push('pra.ai_suspect IS NULL');
      conditions.push('(pra.rule_low_quality IS NULL OR pra.rule_low_quality = 0)');
    }
    // bucket='all' → 조건 없음

    const whereClause = conditions.map(c => `(${c})`).join(' AND ');
    const orderClause = 'pr.review_date DESC NULLS LAST';

    const countRow = await env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM place_review_analysis pra LEFT JOIN place_reviews pr ON pr.id = pra.review_id LEFT JOIN place_review_labels prl ON prl.review_id = pra.review_id WHERE ${whereClause}`
    ).bind(...binds).first();
    const total = countRow?.cnt ?? 0;

    const { results: rows } = await env.DB.prepare(`
      SELECT
        pra.review_id,
        pr.body,
        pra.ai_suspect,
        pra.flags,
        pra.sentiment,
        pra.reason,
        pr.review_date,
        pra.rule_low_quality,
        pra.heuristic_score,
        length(pr.body) AS body_len,
        prl.human_label,
        prl.human_note
      FROM place_review_analysis pra
      LEFT JOIN place_reviews pr ON pr.id = pra.review_id
      LEFT JOIN place_review_labels prl ON prl.review_id = pra.review_id
      WHERE ${whereClause}
      ORDER BY ${orderClause}
      LIMIT ? OFFSET ?
    `).bind(...binds, size, offset).all();

    const items = (rows ?? []).map(r => {
      let flags_parsed = [];
      try { flags_parsed = JSON.parse(r.flags ?? '[]'); } catch { /* ignore */ }
      const rawSuspect = r.ai_suspect ?? null;
      const eff = rawSuspect !== null
        ? effectiveSuspect(rawSuspect, r.body_len ?? 0, flags_parsed)
        : null;
      return {
        review_id:       r.review_id,
        body:            r.body ?? '',
        ai_suspect:      eff,
        raw_ai_suspect:  (rawSuspect !== null && rawSuspect !== eff) ? rawSuspect : undefined,
        flags:           flags_parsed,
        sentiment:       r.sentiment ?? null,
        reason:          r.reason ?? null,
        review_date:     r.review_date ?? null,
        rule_low_quality: r.rule_low_quality === 1,
        heuristic_score: r.heuristic_score ?? null,
        human_label:     r.human_label ?? null,
        human_note:      r.human_note ?? null,
        kind:            reviewKind(flags_parsed),
      };
    });

    return jsonResponse({ total, page, size, items }, 200, cors);
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
  }
}

/**
 * POST /api/places/:id/reviews/:reviewId/label  (researcher 이상)
 * 사람 검수 라벨 저장(UPSERT) 또는 해제(DELETE).
 * body: { label: 'human'|'ad'|'unsure'|null, note?: string }
 */
async function handleSetReviewLabel(request, env, corsHeaders, placeRowId, reviewId) {
  const cors = corsHeaders || {};

  // researcher 이상 (admin 포함)
  const authResult = await requireResearcher(request, env);
  if (authResult.error) {
    return jsonResponse({ error: authResult.error, message: authResult.message }, authResult.status, cors);
  }

  // 플레이스 존재 + 소유 확인
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

  {
    const isAdmin = authResult.user.role === 'admin';
    if (!isAdmin && placeRow.user_id !== authResult.user.id) {
      return jsonResponse({ error: 'forbidden', message: '해당 플레이스에 대한 권한이 없습니다' }, 403, cors);
    }
  }

  // body 파싱
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'invalid_json', message: 'Request body must be valid JSON' }, 400, cors);
  }

  const VALID_LABELS = ['human', 'ad', 'ai', 'unsure'];
  const label = body?.label ?? null;
  const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 500) : null;

  if (label !== null && !VALID_LABELS.includes(label)) {
    return jsonResponse(
      { error: 'invalid_label', message: `label은 ${VALID_LABELS.join(' | ')} 또는 null 이어야 합니다` },
      400,
      cors
    );
  }

  // 리뷰가 해당 지점 소속인지 확인
  let reviewRow;
  try {
    reviewRow = await env.DB.prepare(
      'SELECT id FROM place_reviews WHERE id = ? AND place_row_id = ?'
    ).bind(reviewId, placeRowId).first();
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
  }

  if (!reviewRow) {
    return jsonResponse({ error: 'review_not_found', message: '해당 리뷰를 찾을 수 없습니다' }, 404, cors);
  }

  try {
    if (label === null) {
      // 라벨 해제 — 행 삭제
      await env.DB.prepare(
        'DELETE FROM place_review_labels WHERE review_id = ?'
      ).bind(reviewId).run();

      return jsonResponse({ ok: true, review_id: reviewId, human_label: null, human_note: null }, 200, cors);
    }

    // UPSERT
    const now = new Date().toISOString();
    await env.DB.prepare(`
      INSERT INTO place_review_labels (review_id, place_row_id, human_label, human_note, labeled_by, labeled_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(review_id) DO UPDATE SET
        human_label = excluded.human_label,
        human_note  = excluded.human_note,
        labeled_by  = excluded.labeled_by,
        labeled_at  = excluded.labeled_at
    `).bind(reviewId, placeRowId, label, note, authResult.user.id, now).run();

    return jsonResponse({ ok: true, review_id: reviewId, human_label: label, human_note: note }, 200, cors);
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
  }
}

// =============================================================================
// Phase 4 — 구조적 휴머나이저 (생성 후 미세 불완전성 주입)
// =============================================================================

/**
 * 휴머나이즈 강도별 파라미터 상수 테이블.
 * - rate       : 리뷰당 적용 여부 확률 (0=꺼짐, 1=전체)
 * - maxEdits   : 리뷰당 총 편집 상한 (가독성 캡)
 * - spaceMergeMax : 띄어쓰기 붙이기를 최대 N군데 적용
 * - commaProb  : 쉼표→공백/줄바꿈 치환 확률 (쉼표 하나당 독립 시행)
 * - typoProb   : 구어 변형 오타 적용 확률
 */
const HUMANIZE_LEVEL_PARAMS = {
  off:    { rate: 0,   maxEdits: 0, spaceMergeMax: 0, commaProb: 0,   typoProb: 0    },
  light:  { rate: 0.5, maxEdits: 2, spaceMergeMax: 1, commaProb: 0.6, typoProb: 0.2  },
  medium: { rate: 0.8, maxEdits: 3, spaceMergeMax: 2, commaProb: 0.7, typoProb: 0.3  },
  strong: { rate: 1.0, maxEdits: 5, spaceMergeMax: 4, commaProb: 0.8, typoProb: 0.45 },
};

/**
 * 알려진 캐주얼 구어 변형 맵 (첫 매치 1개만 치환).
 * 문장 의미를 바꾸지 않는 표기 변형만 포함.
 */
const HUMANIZE_TYPO_MAP = [
  ['좋아요', '조아요'],
  ['너무', '넘'],
  ['받았어요', '받았어용'],
  ['감사합니다', '감사함다'],
  ['같아요', '같아용'],
  ['왔어요', '왔어용'],
];

/**
 * LLM이 생성한 리뷰 본문에 사람 글 특유의 미세 불완전성을 확률적으로 주입한다.
 * - 이모지/이모티콘 추가 금지. 종결어미 변경 금지. 가독성 유지 필수.
 * @param {string} text 원본 생성 본문
 * @param {'off'|'light'|'medium'|'strong'} level 강도 (기본 'medium')
 * @returns {string} 후처리된 본문
 */
function humanizeBody(text, level = 'medium') {
  const params = HUMANIZE_LEVEL_PARAMS[level] ?? HUMANIZE_LEVEL_PARAMS.medium;
  if (params.maxEdits === 0) return text;

  let result = text;
  let editCount = 0;

  // ── 1. 쉼표 줄이기 ──────────────────────────────────────────────────────
  // 사람은 쉼표를 거의 쓰지 않음 → ", " 를 공백 또는 줄바꿈으로 확률 치환
  if (editCount < params.maxEdits) {
    result = result.replace(/, /g, (match) => {
      if (editCount >= params.maxEdits) return match;
      if (Math.random() < params.commaProb) {
        editCount++;
        // 줄바꿈이 이미 있는 텍스트엔 공백, 아니면 50% 확률로 줄바꿈
        return Math.random() < 0.5 ? ' ' : '\n';
      }
      return match;
    });
  }

  // ── 2. 띄어쓰기 붙이기 (여러 군데 가능) ────────────────────────────────
  // spaceMergeMax 회까지 반복. 매번 다른 한글 어절 경계 무작위 선택, 중복 방지.
  if (editCount < params.maxEdits && params.spaceMergeMax > 0) {
    // 현재 result 기준 모든 어절 경계 수집
    const collectSpacePositions = (str) => {
      const positions = [];
      const spacePattern = /([가-힣]+) ([가-힣])/g;
      let m;
      while ((m = spacePattern.exec(str)) !== null) {
        positions.push(m.index + m[1].length);
      }
      return positions;
    };

    const usedOffsets = new Set(); // 이미 처리한 원본 위치 추적
    let mergesDone = 0;

    while (mergesDone < params.spaceMergeMax && editCount < params.maxEdits) {
      // 매 반복마다 현재 result를 기준으로 위치 재수집
      const positions = collectSpacePositions(result).filter(p => !usedOffsets.has(p));
      if (positions.length === 0) break;

      const pos = positions[Math.floor(Math.random() * positions.length)];
      usedOffsets.add(pos); // 처리 전 원본 오프셋 기록
      result = result.slice(0, pos) + result.slice(pos + 1);
      editCount++;
      mergesDone++;
      // 공백 제거로 이후 위치가 1씩 당겨지므로 usedOffsets의 기존 값 보정 불필요
      // (positions를 매 반복마다 새로 수집하므로 자연히 처리됨)
    }
  }

  // ── 3. 가벼운 오타 (구어 변형) ──────────────────────────────────────────
  // 안전 맵에서 첫 매치 1개만 치환
  if (editCount < params.maxEdits && Math.random() < params.typoProb) {
    for (const [from, to] of HUMANIZE_TYPO_MAP) {
      if (result.includes(from)) {
        result = result.replace(from, to); // 첫 번째 매치만 replace
        editCount++;
        break;
      }
    }
  }

  return result;
}

/**
 * POST /api/places/:id/generate-samples  (researcher/tester 이상)
 * fact pool 추출 → few-shot 표본 선정 → 스타일 조합 → GPT 생성 → DB 저장 → 반환.
 * tester는 소유권 우회(전 지점 접근).
 */
async function handleGenerateSamples(request, env, corsHeaders, placeRowId) {
  const cors = corsHeaders || {};

  // researcher/tester 이상 (admin 포함)
  const authResult = await requireTester(request, env);
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

  // model 검증: MODEL_PRICING에 등록돼 있고 provider와 짝이 맞아야 함
  const PROVIDER_MODEL_PREFIX = { openai: 'gpt-', anthropic: 'claude-', xai: 'grok-' };
  const requestedModel = (typeof body?.model === 'string' && body.model.trim()) ? body.model.trim() : null;
  const isValidModel = requestedModel
    && MODEL_PRICING[requestedModel] !== undefined
    && requestedModel.startsWith(PROVIDER_MODEL_PREFIX[provider]);
  const model = isValidModel ? requestedModel : PROVIDER_DEFAULT_MODEL[provider];

  // count 파싱 (기본 10, clamp 1~30)
  let count = body?.count ?? 10;
  if (typeof count !== 'number' || !Number.isFinite(count)) count = 10;
  count = Math.max(1, Math.min(30, Math.floor(count)));

  // includeLong 파싱 (기본 false — long 길이 제외)
  const includeLong = body?.includeLong === true;

  // length 파싱: 'auto' | 'short' | 'medium' | 'long' (기본 'auto')
  const VALID_LENGTHS = ['auto', 'short', 'medium', 'long'];
  const lengthParam = VALID_LENGTHS.includes(body?.length) ? body.length : 'auto';

  // includeNames 파싱: boolean (기본 true)
  const includeNames = body?.includeNames !== false;

  // humanizeLevel 파싱: 'off' | 'light' | 'medium' | 'strong' (기본 'medium')
  const VALID_HUMANIZE_LEVELS = ['off', 'light', 'medium', 'strong'];
  const humanizeLevel = VALID_HUMANIZE_LEVELS.includes(body?.humanizeLevel) ? body.humanizeLevel : 'medium';

  // 플레이스 소유 확인 (admin/tester는 전체 접근, researcher는 자기 지점만)
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

  const isAdmin = authResult.user.role === 'admin';
  const isTester = authResult.user.role === 'tester';
  if (!isAdmin && !isTester && placeRow.user_id !== authResult.user.id) {
    return jsonResponse({ error: 'forbidden', message: '해당 플레이스에 대한 권한이 없습니다' }, 403, cors);
  }

  // fact pool 추출
  let factPool;
  try {
    factPool = await extractFactPool(env, placeRowId, SAMPLE_FACT_POOL_SIZE);
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
  }

  // ── 스타일 본보기 풀: 각 생성 샘플의 말투·길이·호흡 레퍼런스 ──
  // 우선순위: (a) human_label='human' → (b) 광고/AI 아닌 것(라벨없음 포함), length>=20
  //           → (c) length>=20 아무거나
  let styleExamples;
  try {
    // 부정 후기 키워드 — 이 단어가 body에 포함된 리뷰는 본보기 후보에서 제외
    // (부정적 말투가 생성물에 전염되는 것 방지)
    const NEGATIVE_RE = /별로|최악|불친절|환불|실망|아깝|비추|짜증|그닥|돈만|불만|최악|별로예요|후회|최악이|별로임|실망임|돈낭비|다시는/;

    // (a) 사람 라벨 확정 리뷰 (긍정만)
    const { results: humanRows } = await env.DB.prepare(`
      SELECT r.body
      FROM place_reviews r
      LEFT JOIN place_review_labels l ON l.review_id = r.id
      WHERE r.place_row_id = ?
        AND r.body IS NOT NULL
        AND length(r.body) >= 20
        AND l.human_label = 'human'
      ORDER BY RANDOM()
      LIMIT ?
    `).bind(placeRowId, count * 5).all();

    styleExamples = (humanRows ?? []).filter(r => !NEGATIVE_RE.test(r.body));

    // (b) 광고·AI 아닌 것 (라벨 없음 포함), length>=20 으로 보충 (긍정만)
    if (styleExamples.length < count) {
      const needed = count * 5 - styleExamples.length;
      const seenA = new Set(styleExamples.map(r => r.body));
      const { results: cleanRows } = await env.DB.prepare(`
        SELECT r.body
        FROM place_reviews r
        LEFT JOIN place_review_labels l ON l.review_id = r.id
        WHERE r.place_row_id = ?
          AND r.body IS NOT NULL
          AND length(r.body) >= 20
          AND COALESCE(l.human_label, '') NOT IN ('ad', 'ai')
        ORDER BY RANDOM()
        LIMIT ?
      `).bind(placeRowId, needed).all();
      styleExamples = [
        ...styleExamples,
        ...(cleanRows ?? []).filter(r => !seenA.has(r.body) && !NEGATIVE_RE.test(r.body)),
      ];
    }

    // (c) fallback: length>=20 아무거나 (긍정만)
    if (styleExamples.length < count) {
      const needed = count * 2 - styleExamples.length;
      const seenB = new Set(styleExamples.map(r => r.body));
      const { results: anyRows } = await env.DB.prepare(`
        SELECT body
        FROM place_reviews
        WHERE place_row_id = ?
          AND body IS NOT NULL
          AND length(body) >= 20
        ORDER BY RANDOM()
        LIMIT ?
      `).bind(placeRowId, needed).all();
      styleExamples = [
        ...styleExamples,
        ...(anyRows ?? []).filter(r => !seenB.has(r.body) && !NEGATIVE_RE.test(r.body)),
      ];
    }
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
  }

  if (styleExamples.length === 0) {
    return jsonResponse(
      { error: 'no_sample', message: '스타일 본보기로 쓸 20자 이상 리뷰가 없습니다' },
      400,
      cors
    );
  }

  // ── (a-1) length 파라미터에 따른 본보기 필터 + 풀 자동 확장 ────────────────
  // 'auto': 자연 분포 / 그 외: 해당 구간 본보기 우선 필터링.
  // 필터 후 풀이 MIN_EXEMPLAR_POOL 미만이면 인접 길이 → 전체로 단계적 확장.
  // 목표: 한 본보기가 배치를 지배하는 씨앗 독점 차단.
  const LENGTH_CHAR_RANGES = { short: [0, 29], medium: [30, 80], long: [81, Infinity] };
  let filteredExamples = styleExamples;
  if (lengthParam !== 'auto') {
    const [lo, hi] = LENGTH_CHAR_RANGES[lengthParam];
    const rangeFiltered = styleExamples.filter(r => r.body.length >= lo && r.body.length <= hi);
    if (rangeFiltered.length >= MIN_EXEMPLAR_POOL) {
      filteredExamples = rangeFiltered;
    } else if (rangeFiltered.length > 0) {
      // 인접 길이까지 확장: 대상 길이 ±1단계 포함
      const LENGTH_ORDER = ['short', 'medium', 'long'];
      const targetIdx = LENGTH_ORDER.indexOf(lengthParam);
      const adjacentKeys = LENGTH_ORDER.filter((_, i) => Math.abs(i - targetIdx) <= 1);
      const adjFiltered = styleExamples.filter(r => {
        return adjacentKeys.some(k => {
          const [al, ah] = LENGTH_CHAR_RANGES[k];
          return r.body.length >= al && r.body.length <= ah;
        });
      });
      filteredExamples = adjFiltered.length >= MIN_EXEMPLAR_POOL ? adjFiltered : styleExamples;
    } else {
      // 해당 길이 본보기 전혀 없으면 전체 풀 사용
      filteredExamples = styleExamples;
    }
  }

  // ── (a-2) 배치 내 distinct 본보기 배정 ──────────────────────────────────────
  // 풀≥count: modulo 재사용 없이 distinct 배정 (피셔-예이츠 셔플 후 순서대로).
  // 풀<count: 어쩔 수 없이 모듈로 재사용. facts로 차별화.
  const shuffledExamples = [...filteredExamples].sort(() => Math.random() - 0.5);
  // 각 샘플 i에 배정할 본보기: 풀이 충분하면 distinct, 아니면 modulo.
  function getExemplarForIdx(i) {
    if (shuffledExamples.length >= count) {
      return shuffledExamples[i]; // distinct
    }
    return shuffledExamples[i % shuffledExamples.length]; // modulo 재사용
  }

  // 스타일 조합은 길이 배정 목적으로만 생성 (tone/focus는 n/a 처리)
  // lengthParam이 'auto'가 아니면 해당 길이로 모든 styleAssignment.length를 고정
  const styleAssignments = buildStyleAssignments(count, includeLong);
  if (lengthParam !== 'auto') {
    styleAssignments.forEach(a => { a.length = lengthParam; });
  }

  // length 힌트 문자열 (프롬프트 각 항목에 삽입 — 출력 길이 목표 유지용)
  const LENGTH_HINTS = { short: '짧게 한 줄(~30자)', medium: '중간 길이(30~80자)', long: '장문(80~150자)' };

  // ── 변형 기반 프롬프트 구성 (가드레일 2개 포함) ──
  const systemPrompt = `너는 한국어 리뷰 작성 보조 도구다. 아래 규칙을 엄격히 따른다.

[역할]
각 요청마다 "말투 본보기 리뷰" 1개가 주어진다. 그 리뷰의 말투·문장 길이·호흡·구조를 흉내내되, 내용은 완전히 새로 지어라. 내용의 중심은 "내가 겪은 것" — 받은 결과·변화, 몸으로 느낀 감각, 예약·대기·주차 같은 생활 디테일이다. 시술명·메뉴·담당자명은 [허용 사실] 목록 안에서만 가져온다.
긍정적이고 만족한 후기만 생성. 불만·부정·가격 불만 내용 절대 금지.

[가드레일 i — 천편일률·장황함 방지 (단어 금지가 아니라 반복·길이 관리)]
- "친절", "만족", "꼼꼼", "깔끔" 같은 칭찬어는 실제 후기에도 매우 흔하니 자연스럽게 써도 된다. 시술명·메뉴도 자유롭게 불러라([허용 사실] 범위). "또 올게요"·"다음에 또" 같은 자연스러운 마무리도 괜찮다. 단어 자체를 피하려 애쓰지 마라.
- 핵심 제약 둘: (1) 한 후기를 칭찬어만으로 길게 늘리지 마라. 짧으면 단순 칭찬 한두 마디로 끝내도 좋다(실제 후기 다수가 그렇다). 길게 쓸 거면 반드시 겪은 구체 하나를 담아라 — 결과·변화(며칠 뒤 어땠는지), 몸의 느낌, 예약·대기·주차 같은 디테일. (2) 여러 샘플이 같은 칭찬 표현·감탄 패턴을 복붙하듯 똑같이 반복하지 마라(배치 다양성).
- 알맹이 없는 추상 연결어로 길이만 채우지 마라: "흐름이 이어져서", "동선이 짧아서", "막힘 없이", "부담 없이", "설명이 끊기지 않게" 류.
- 진료 과정 중계 금지(중요): 실제 손님은 "피부 상태를 부위별로 짚어주셨다", "시술 전에 하나하나 설명해주셨다", "상태를 보면서 얘기해주셨다" 같은 *의사가 해준 진료 과정*을 거의 쓰지 않는다(실제 후기 실측). 시술자가 무엇을 해줬는지 중계하지 말고, 내가 무엇을 겪고 어떻게 느꼈는지를 써라.

[가드레일 ii — 말투 본보기 충실 재현]
- 각 샘플에 지정된 "말투 본보기" 리뷰의 말투·길이·호흡·구조를 그대로 따라라. 본보기가 짧으면 짧게. 본보기가 캐주얼하면 캐주얼하게.
- 오타·미완결·구어적 특성도 그대로 살려라. 원본보다 더 매끄럽게 다듬지 마라.
- 종결어미는 '~어요'만 반복하지 말고 음슴체('~함', '~음')·구어체를 섞어라. 쉼표 대신 줄바꿈이나 물결(~)을 활용하라.

[절대 금지]
- 업체명·지점명을 쓰지 마라.
- [허용 사실] 목록에 없는 시술명·메뉴명·담당자 이름을 지어내지 마라.
- 구체적 가격·금액(예: "5만원", "82500원"), 정확한 용량·횟수·샷수(예: "600샷", "2cc", "3회차")를 지어내지 마라. 이런 검증 가능한 수치는 실제와 다르면 *없는 사실*이 된다. — 단, 주관적 경험("며칠 지나니까", "금방 끝남", "몇 번 받았는데")처럼 *대략적·체감* 표현은 괜찮다. 정확한 숫자는 [허용 사실]에 있을 때만.
- 말투 본보기와 내용이 거의 같은 문장을 그대로 내지 마라. 내용은 반드시 바꿔야 한다.
- 각 후기는 서로 다른 소재·경험을 담아라. 막을 것은 *같은 칭찬 표현·감탄 패턴*이 여러 편에 똑같이 반복되는 것이지, 시술명 같은 사실어(예: "보톡스")가 여러 편에 등장하는 것은 자연스러우니 허용한다.

[허용]
- [허용 사실] 목록 안의 항목(시술명·메뉴명·담당자명·특징어)은 자유롭게 사용.
- 목록이 비어 있으면 사실을 새로 지어내지 말고, 본보기 말투·구조만 살려 내용을 추상적으로 변형.
- 상황·기분·군말 같은 '사람 냄새' 표현은 자유롭게 추가.

[출력 형식]
반드시 JSON 객체만: { "samples": [ { "index": 번호, "body": "리뷰 본문" } ] }`;

  const factPoolText = factPool.length > 0
    ? `[허용 사실 — 시술명·메뉴·담당자명·특징어. 이 목록 안에서만 구체적 사실을 사용할 것]\n${factPool.join(', ')}`
    : '[허용 사실: 없음 — 구체적 사실을 새로 지어내지 말 것]';

  // ── (a-3) 담당자명 희소 배정 + 주 fact 중복 방지 ──────────────────────────
  // factPool을 담당자명(staffNames)과 그 외 사실(otherFacts)로 분리.
  // 담당자명은 전체 샘플의 STAFF_NAME_RATE(≈30%)에만, 이름마다 최대 1회 배정.
  // otherFacts는 샘플 간 주 fact(첫 번째로 배정되는 fact)를 공유하지 않도록 강제.
  const STAFF_NAME_RE = /(실장님|원장님|선생님|쌤|대표님|상담실장)$/;
  const staffNames = factPool.filter(f => STAFF_NAME_RE.test(f));
  const otherFacts = factPool.filter(f => !STAFF_NAME_RE.test(f));

  // 이름을 받을 샘플 수: includeNames=false이면 0, 아니면 있는 이름 개수와 rate 기준 수 중 작은 값
  const nameQuota = includeNames
    ? Math.min(staffNames.length, Math.ceil(count * STAFF_NAME_RATE))
    : 0;

  // count개 인덱스 중 nameQuota개를 무작위로 골라 named 샘플 집합 구성
  const allIndices = Array.from({ length: count }, (_, i) => i);
  const shuffledIndices = [...allIndices].sort(() => Math.random() - 0.5);
  const nameSampleIdx = new Set(shuffledIndices.slice(0, nameQuota));

  // named 샘플에 배정할 이름 순서 (셔플, 중복 없이 순서대로 1개씩)
  const shuffledStaffNames = [...staffNames].sort(() => Math.random() - 0.5);

  // otherFacts 배정용: 샘플 간 겹침 최소화
  const shuffledOtherFacts = [...otherFacts].sort(() => Math.random() - 0.5);
  const assignedFactSet = new Set(); // 배치 내 이미 배정된 fact 추적
  const assignedPrimaryFacts = new Set(); // 주 fact(첫 번째 배정 fact) 중복 방지

  let namedCount = 0; // 이름 배정 카운터

  /**
   * 환각 방지: 본보기 구체 수치 마스킹.
   * 말투·구조는 유지하되, 가격·용량·횟수 등 검증 가능한 구체 수치를 제거해
   * 모델이 본보기 수치를 그대로 베껴 환각 리뷰를 생성하는 것을 막는다.
   *
   * 제거 대상:
   *   1. 가격: "8만원", "82,500원", "3천원" 등 (숫자 + 원/만원/천원)
   *   2. 용량·횟수·단위: "2cc", "600샷", "3회차", "50mg", "3개월" 등
   *   3. 독립된 큰 숫자(3자리 이상): 앞 두 패턴에서 걸러지지 않은 가격류 수치
   *
   * @param {string} text 원본 본보기 본문
   * @returns {string} 수치가 제거된 본보기 본문
   */
  function maskExemplarSpecifics(text) {
    let t = text;
    // 1. 범위 가격: "2~3만원", "1~3만원" 같은 X~Y단위 패턴 (1보다 먼저 처리)
    t = t.replace(/\d+\s*~\s*\d+\s*(원|만원|천원)/g, '');
    // 2. 가격 (숫자 + 원/만원/천원)
    t = t.replace(/\d[\d,]*\s*(원|만원|천원)/g, '');
    // 3. 용량·횟수·단위 (숫자 + cc|ml|샷|바이알|mg|회차|회|%|개월|주|번)
    t = t.replace(/\d+\s*(cc|ml|샷|바이알|mg|회차|회|%|개월|주|번)/g, '');
    // 4. 독립된 3자리 이상 숫자 (앞 규칙에서 남은 가격류)
    t = t.replace(/\b\d{3,}\b/g, '');
    // 연속 공백 정리 (줄바꿈 보존)
    t = t.replace(/[^\S\n]{2,}/g, ' ').trim();
    return t;
  }

  /**
   * 샘플 i에 대한 itemLine 문자열을 생성하는 내부 헬퍼.
   * @param {number} i 샘플 인덱스 (0-based)
   * @param {object} style styleAssignments[i]
   * @param {string} exampleText 본보기 본문 (마스킹 전 원본)
   * @param {string|null} conflictHint 재생성 시 충돌 본문 힌트 (null이면 최초 생성)
   * @param {boolean} resetAssigned 재생성 시 assigned 추적 무시 여부
   */
  function buildItemLine(i, style, exampleText, conflictHint = null, resetAssigned = false) {
    // 환각 방지: 프롬프트에 넣기 전 본보기 구체 수치 마스킹
    const maskedExample = maskExemplarSpecifics(exampleText);
    // otherFacts 중 이 본보기에 없고, 주 fact 중복 아닌 것 우선
    const notInExample = shuffledOtherFacts.filter(f => !exampleText.includes(f));
    const freshOther = notInExample.filter(f =>
      !assignedFactSet.has(f) && !assignedPrimaryFacts.has(f)
    );
    const usedButNotPrimary = notInExample.filter(f =>
      assignedFactSet.has(f) && !assignedPrimaryFacts.has(f)
    );
    const fallbackOther = notInExample.filter(f => assignedFactSet.has(f));
    // 주 fact 선택 우선순위: 완전히 새 것 > 이미 쓰였지만 주 fact는 아닌 것 > 전체 폴백
    const primaryCandidates = [...freshOther, ...usedButNotPrimary, ...fallbackOther];

    let pickedFacts;
    if (nameSampleIdx.has(i) && namedCount < shuffledStaffNames.length) {
      // named 샘플: 이름 1개 + otherFacts 1개(있으면)
      const assignedName = shuffledStaffNames[namedCount++];
      const primaryPick = primaryCandidates.slice(0, 1);
      pickedFacts = [assignedName, ...primaryPick];
      if (primaryPick.length > 0) assignedPrimaryFacts.add(primaryPick[0]);
    } else {
      // 일반 샘플: otherFacts 1~2개(이름 없음)
      const primaryPick = primaryCandidates.slice(0, 1);
      const secondaryCandidates = notInExample.filter(f =>
        !assignedFactSet.has(f) && f !== primaryPick[0]
      );
      const secondaryPick = secondaryCandidates.slice(0, 1);
      pickedFacts = [...primaryPick, ...secondaryPick];
      if (primaryPick.length > 0) assignedPrimaryFacts.add(primaryPick[0]);
    }

    if (!resetAssigned) {
      pickedFacts.forEach(f => assignedFactSet.add(f));
    }

    const factsStr = pickedFacts.length > 0
      ? pickedFacts.filter(Boolean).join(', ')
      : '(없음 — 본보기 말투·구조만 살려 변형)';

    // 길이 힌트: lengthParam 지정 시 목표 길이 명시 (본보기가 달라도 길이 목표 유지)
    const lengthHint = (lengthParam !== 'auto' && LENGTH_HINTS[lengthParam])
      ? ` [목표 길이: ${LENGTH_HINTS[lengthParam]}]`
      : '';

    // 재생성 시 충돌 힌트 추가
    const conflictNote = conflictHint
      ? ` [주의: 아래 문장들과 도입·문장구조를 반드시 다르게 써라: ${conflictHint}]`
      : '';

    return `[${i + 1}] 말투 본보기: "${maskedExample}" / 이번 리뷰에 담을 사실(구체 내용만, 칭찬어 금지): ${factsStr}${lengthHint} → 본보기 말투·길이 유지, 내용은 완전히 새로${conflictNote}`;
  }

  const itemLines = styleAssignments.map((style, i) => {
    const example = getExemplarForIdx(i);
    return buildItemLine(i, style, example.body);
  }).join('\n\n');

  const userPrompt = `[업체 정보 — 맥락 참고용. 본문에 업체명·지점명을 절대 쓰지 말 것]
업체명: ${placeRow.name ?? ''}
업종: ${placeRow.business_type || '미분류'}

${factPoolText}

[생성 요청 목록 — 각 번호마다 말투 본보기가 다름]
주의: 상투적 칭찬어(친절·꼼꼼·깔끔·가성비 등) 반복 금지. 각 후기는 서로 다른 시술·소재. 알맹이 없는 과정 묘사("흐름이 이어져서", "동선이 짧아서") 금지. 본보기가 짧으면 짧게.
${itemLines}

위 ${styleAssignments.length}개 리뷰를 생성해서 JSON으로 응답하시오.`;

  // LLM 호출 (provider 분기) — 1차 생성
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

  // ── (b) 배치 다양성 측정 + 붕괴 샘플 1회 재생성 ────────────────────────────
  // 1차 생성 본문 배열 추출 (index 순서 기준)
  const orderedBodies = styleAssignments.map((_, i) => {
    const item = gptSamples.find(s => s.index === i + 1) ?? gptSamples[i];
    return item?.body ?? '';
  });

  // trigram Jaccard로 붕괴 감지
  const collapsedIndices = detectCollapsedSamples(orderedBodies, SIMILARITY_THRESHOLD);

  if (collapsedIndices.size > 0) {
    // 붕괴 샘플에 대해 재생성 프롬프트 구성
    const regenLines = [];
    for (const ci of collapsedIndices) {
      // 앞선 정상 샘플들 중 이 샘플과 유사한 것들 힌트로 제공
      const conflictBodies = [];
      for (let j = 0; j < ci; j++) {
        if (trigramJaccard(orderedBodies[ci], orderedBodies[j]) > SIMILARITY_THRESHOLD) {
          conflictBodies.push(`"${orderedBodies[j].slice(0, 40)}..."`);
        }
      }
      const conflictHint = conflictBodies.join(' / ');
      // 다른 본보기 선택 (풀에서 가능한 한 기존과 다른 것)
      const altExemplarIdx = (ci + Math.floor(shuffledExamples.length / 2)) % shuffledExamples.length;
      const altExemplar = shuffledExamples[altExemplarIdx] ?? getExemplarForIdx(ci);
      regenLines.push(buildItemLine(ci, styleAssignments[ci], altExemplar.body, conflictHint, true));
    }

    const regenUserPrompt = `[업체 정보 — 맥락 참고용. 본문에 업체명·지점명을 절대 쓰지 말 것]
업체명: ${placeRow.name ?? ''}
업종: ${placeRow.business_type || '미분류'}

${factPoolText}

[재생성 요청 — 기존 생성 결과와 너무 유사해 다시 작성이 필요한 번호만]
주의: 상투적 칭찬어(친절·꼼꼼·깔끔·가성비 등) 반복 금지. 각 후기는 서로 다른 시술·소재. 본보기가 짧으면 짧게.
${regenLines.join('\n\n')}

위 번호의 리뷰만 새로 생성해서 JSON으로 응답하시오. (응답 형식 동일: { "samples": [ { "index": 번호, "body": "..." } ] })`;

    try {
      const regenResult = await callLLMForSamples(env, provider, model, {
        systemPrompt,
        userPrompt: regenUserPrompt,
        count: collapsedIndices.size,
      });
      // 재생성분으로 교체 (index 매칭)
      for (const regenItem of regenResult.gptSamples) {
        const origIdx = gptSamples.findIndex(s => s.index === regenItem.index);
        if (origIdx !== -1) {
          gptSamples[origIdx] = regenItem;
        }
      }
      samplesUsage = {
        prompt_tokens:     samplesUsage.prompt_tokens     + regenResult.usage.prompt_tokens,
        completion_tokens: samplesUsage.completion_tokens + regenResult.usage.completion_tokens,
      };
    } catch {
      // 재생성 실패는 best-effort — 1차 결과 그대로 사용
    }
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

    // ── 구조적 휴머나이저 후처리 ──────────────────────────────────────────
    // humanizeLevel별 rate 확률 통과 시 humanizeBody(text, level) 적용.
    // 'off'이면 rate=0이므로 항상 원본 반환.
    const hlParams = HUMANIZE_LEVEL_PARAMS[humanizeLevel] ?? HUMANIZE_LEVEL_PARAMS.medium;
    const finalBody = Math.random() < hlParams.rate
      ? humanizeBody(gptItem.body, humanizeLevel)
      : gptItem.body;

    const sampleId = crypto.randomUUID();
    // style_length: 실제 생성 결과 길이로 계산 (short<30 / medium<80 / long)
    const bodyLen = finalBody.length;
    const actualLength = bodyLen < 30 ? 'short' : bodyLen < 80 ? 'medium' : 'long';
    // style_tone / style_focus: 허구 라벨 대신 정직한 'n/a' 저장
    samples.push({
      id:       sampleId,
      body:     finalBody,
      length:   actualLength,
      tone:     'n/a',
      focus:    'n/a',
      status:   'active',
      provider,
      model,
    });
    insertStmts.push(
      env.DB.prepare(`
        INSERT INTO place_generated_samples
          (id, place_row_id, body, style_length, style_tone, style_focus, model, provider, created_at, status, actor_user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
      `).bind(sampleId, placeRowId, finalBody, actualLength, 'n/a', 'n/a', model, provider, generatedAt, authResult.user.id)
    );
  }

  // llm_usage INSERT
  const usageId = crypto.randomUUID();
  insertStmts.push(
    env.DB.prepare(`
      INSERT INTO llm_usage (id, place_row_id, kind, provider, model, prompt_tokens, completion_tokens, cost_usd, created_at, actor_user_id)
      VALUES (?, ?, 'samples', ?, ?, ?, ?, ?, ?, ?)
    `).bind(usageId, placeRowId, provider, model, samplesUsage.prompt_tokens, samplesUsage.completion_tokens, samplesCostUsd, generatedAt, authResult.user.id)
  );

  try {
    await env.DB.batch(insertStmts);
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
  }

  // 최종 본문 배열로 배치 다양성 계산 (모드붕괴 재생성 후 확정된 본문 기준)
  const finalBodies = samples.map(s => s.body);
  const diversity = computeBatchDiversity(finalBodies);

  return jsonResponse({
    place_name:   placeRow.name ?? '',
    provider,
    model,
    generated_at: generatedAt,
    samples,
    diversity,
    usage: {
      prompt_tokens:     samplesUsage.prompt_tokens,
      completion_tokens: samplesUsage.completion_tokens,
      cost_usd:          samplesCostUsd,
    },
  }, 200, cors);
}

/**
 * GET /api/places/:id/samples  (researcher/tester 이상)
 * 저장된 생성 예시 최근순 반환.
 * tester는 소유권 우회(전 지점 접근).
 */
async function handleGetSamples(request, env, corsHeaders, placeRowId) {
  const cors = corsHeaders || {};

  // researcher/tester 이상 (admin 포함)
  const authResult = await requireTester(request, env);
  if (authResult.error) {
    return jsonResponse({ error: authResult.error, message: authResult.message }, authResult.status, cors);
  }

  // 플레이스 존재 + 소유 확인 (admin/tester는 전체, researcher는 자기 지점만)
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

  {
    const isAdmin = authResult.user.role === 'admin';
    const isTester = authResult.user.role === 'tester';
    if (!isAdmin && !isTester && placeRow.user_id !== authResult.user.id) {
      return jsonResponse({ error: 'forbidden', message: '해당 플레이스에 대한 권한이 없습니다' }, 403, cors);
    }
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

  // ── R2: 자연스러움 점수 즉석 계산 (저장/마이그 없음) ──────────────────────
  // 배치 추이 감시용 지표. 개별 합격/불합격 판단에 쓰지 말 것.

  // 환각 탐지용 팩트풀: 전체 배열(allowedFacts)과 담당자명 필터(allowedStaffNames) 분리 (요청당 1회)
  let allowedStaffNames = [];
  let allowedFacts = [];
  if (results.length > 0) {
    try {
      const factPoolArr = await extractFactPool(env, placeRowId);
      allowedFacts = factPoolArr; // treatment 검사용 — 팩트풀 원본 전체
      const STAFF_TITLE_SUFFIX_RE = /(원장님|실장님|선생님|쌤|대표님|상담실장)$/;
      allowedStaffNames = factPoolArr.filter(e => STAFF_TITLE_SUFFIX_RE.test(e));
    } catch (_) {
      // 탐지기는 soft-flag 조기경보 — 팩트풀 오류가 샘플 조회를 막지 않도록
    }
  }

  const scoredSamples = results.map(s => {
    const scored = scoreNaturalness(s.body ?? '', naturalnessProfile);
    const halResult = detectHallucination(s.body ?? '', allowedStaffNames, allowedFacts);
    return {
      ...s,
      naturalness:  Math.round(scored.naturalness),
      slop_hits:    scored.slop.hits.length,
      slop_top:     scored.slop.hits.slice(0, 3).map(h => h.ngram),
      hallucination: {
        risk:  halResult.risk,
        flags: halResult.flags.slice(0, 5).map(f => ({ type: f.type, text: f.text })),
      },
    };
  });

  // 배치 요약 (빈 목록 엣지 처리)
  let naturalness_summary = null;
  if (scoredSamples.length > 0) {
    const scores = scoredSamples.map(s => s.naturalness);
    const slopHits = scoredSamples.map(s => s.slop_hits);
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const sorted = [...scores].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0
      ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
      : sorted[mid];
    const min = sorted[0];
    const meanSlopHits = parseFloat((slopHits.reduce((a, b) => a + b, 0) / slopHits.length).toFixed(2));
    naturalness_summary = {
      count:          scoredSamples.length,
      mean:           Math.round(mean),
      median,
      min,
      mean_slop_hits: meanSlopHits,
    };
  }

  // 환각 탐지 배치 요약
  const hallucination_summary = scoredSamples.length > 0 ? {
    high: scoredSamples.filter(s => s.hallucination.risk === 'high').length,
    low:  scoredSamples.filter(s => s.hallucination.risk === 'low').length,
  } : null;

  return jsonResponse({ samples: scoredSamples, naturalness_summary, hallucination_summary }, 200, cors);
}

/**
 * POST /api/places/:id/samples/:sampleId/status  (researcher/tester 이상)
 * 생성 예시 평가 라벨 변경: active | kept | archived
 * tester는 소유권 우회(전 지점 접근).
 */
async function handleUpdateSampleStatus(request, env, corsHeaders, placeRowId, sampleId) {
  const cors = corsHeaders || {};

  const authResult = await requireTester(request, env);
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

  // 플레이스 소유 확인 (admin/tester는 전체, researcher는 자기 지점만)
  let placeOwnerRow;
  try {
    placeOwnerRow = await env.DB.prepare(
      'SELECT id, user_id FROM review_places WHERE id = ?'
    ).bind(placeRowId).first();
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
  }

  if (!placeOwnerRow) {
    return jsonResponse({ error: 'place_not_found', message: '등록된 플레이스를 찾을 수 없습니다' }, 404, cors);
  }

  {
    const isAdmin = authResult.user.role === 'admin';
    const isTester = authResult.user.role === 'tester';
    if (!isAdmin && !isTester && placeOwnerRow.user_id !== authResult.user.id) {
      return jsonResponse({ error: 'forbidden', message: '해당 플레이스에 대한 권한이 없습니다' }, 403, cors);
    }
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
 * POST /api/places/:id/samples/delete  (researcher/tester 이상)
 * 생성 예시 다중 삭제. body: { "ids": ["uuid1", ...] }
 * tester는 소유권 우회(전 지점 접근).
 */
async function handleDeleteSamples(request, env, corsHeaders, placeRowId) {
  const cors = corsHeaders || {};

  const authResult = await requireTester(request, env);
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

  // 플레이스 소유 확인 (admin/tester는 전체, researcher는 자기 지점만)
  let placeOwnerRow;
  try {
    placeOwnerRow = await env.DB.prepare(
      'SELECT id, user_id FROM review_places WHERE id = ?'
    ).bind(placeRowId).first();
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
  }

  if (!placeOwnerRow) {
    return jsonResponse({ error: 'place_not_found', message: '등록된 플레이스를 찾을 수 없습니다' }, 404, cors);
  }

  {
    const isAdmin = authResult.user.role === 'admin';
    const isTester = authResult.user.role === 'tester';
    if (!isAdmin && !isTester && placeOwnerRow.user_id !== authResult.user.id) {
      return jsonResponse({ error: 'forbidden', message: '해당 플레이스에 대한 권한이 없습니다' }, 403, cors);
    }
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
        INSERT INTO llm_usage (id, place_row_id, kind, provider, model, prompt_tokens, completion_tokens, cost_usd, created_at, actor_user_id)
        VALUES (?, ?, 'report', 'openai', ?, ?, ?, ?, ?, ?)
      `).bind(usageId, placeRowId, model, insightsUsage.prompt_tokens, insightsUsage.completion_tokens, costUsd, generatedAt, authResult.user.id),
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
  'gpt-5.4-mini':               { input: 0.75, output:  4.50 },
  'grok-4.3':                   { input: 1.25, output:  2.50 },
  'claude-haiku-4-5-20251001':  { input: 1.00, output:  5.00 },
  'claude-sonnet-4-6':          { input: 3.00, output: 15.00 },
  'claude-opus-4-8':            { input: 5.00, output: 25.00 },
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

// --- 라벨링 스프린트 ---

/**
 * GET /api/places/review-sprint-sample?limit=200  (researcher 이상)
 * 26개 지점 × 본문 길이 구간(~30 / 30~80 / 80~)으로 골고루 층화 표본 추출.
 * 이미 라벨된 review_id 및 명백한 저품질(body 2자 이하) 제외.
 */
async function handleReviewSprintSample(request, env, corsHeaders) {
  const cors = corsHeaders || {};

  const authResult = await requireResearcher(request, env);
  if (authResult.error) {
    return jsonResponse({ error: authResult.error, message: authResult.message }, authResult.status, cors);
  }

  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '200', 10), 500);

  try {
    // 전체 지점 목록
    const { results: places } = await env.DB.prepare(
      `SELECT id, name, place_id FROM review_places ORDER BY id`
    ).all();

    if (!places || places.length === 0) {
      return jsonResponse({ total: 0, items: [] }, 200, cors);
    }

    // 길이 구간 3개
    const BUCKETS = [
      { key: 'short',  minLen: 0,  maxLen: 29  },
      { key: 'medium', minLen: 30, maxLen: 79  },
      { key: 'long',   minLen: 80, maxLen: 9999 },
    ];

    const placeCount = places.length;
    const bucketCount = BUCKETS.length;
    // 지점당 각 구간에서 뽑을 목표: ceil(limit / (지점수 * 구간수))
    const perSlot = Math.max(1, Math.ceil(limit / (placeCount * bucketCount)));

    const collected = [];

    for (const place of places) {
      for (const bucket of BUCKETS) {
        const rows = await env.DB.prepare(`
          SELECT pr.id AS review_id, pr.body, pr.review_date
          FROM place_reviews pr
          LEFT JOIN place_review_labels prl ON prl.review_id = pr.id
          WHERE pr.place_row_id = ?
            AND prl.review_id IS NULL
            AND LENGTH(COALESCE(pr.body, '')) > 2
            AND LENGTH(COALESCE(pr.body, '')) >= ?
            AND LENGTH(COALESCE(pr.body, '')) <= ?
          ORDER BY RANDOM()
          LIMIT ?
        `).bind(place.id, bucket.minLen, bucket.maxLen, perSlot).all();

        for (const row of (rows.results ?? [])) {
          collected.push({
            review_id:   row.review_id,
            body:        row.body,
            place_row_id: place.id,
            place_name:  place.name || place.place_id,
            length_bucket: bucket.key,
            body_length: (row.body || '').length,
            review_date: row.review_date,
          });
        }
      }
    }

    // 전체를 섞고 limit 수만큼 반환
    for (let i = collected.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [collected[i], collected[j]] = [collected[j], collected[i]];
    }
    const items = collected.slice(0, limit);

    return jsonResponse({ total: items.length, items }, 200, cors);
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
  }
}

/**
 * GET /api/places/review-sprint-stats  (researcher 이상)
 * 전체 라벨링 진행 통계: 총 라벨 수, 분류별 합계, 지점별 소계.
 */
async function handleReviewSprintStats(request, env, corsHeaders) {
  const cors = corsHeaders || {};

  const authResult = await requireResearcher(request, env);
  if (authResult.error) {
    return jsonResponse({ error: authResult.error, message: authResult.message }, authResult.status, cors);
  }

  try {
    // 전체 라벨 건수
    const totalRow = await env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM place_review_labels`
    ).first();
    const total = totalRow?.cnt ?? 0;

    // 분류별
    const { results: labelRows } = await env.DB.prepare(
      `SELECT human_label, COUNT(*) AS cnt FROM place_review_labels GROUP BY human_label`
    ).all();

    const by_label = { human: 0, ad: 0, ai: 0, unsure: 0 };
    for (const r of (labelRows ?? [])) {
      if (r.human_label in by_label) by_label[r.human_label] = r.cnt;
    }

    // 지점별
    const { results: placeRows } = await env.DB.prepare(`
      SELECT rp.id, rp.name, rp.place_id,
             COUNT(prl.review_id) AS labeled_count
      FROM review_places rp
      LEFT JOIN place_review_labels prl ON prl.place_row_id = rp.id
      GROUP BY rp.id
      ORDER BY labeled_count DESC
    `).all();

    const by_place = (placeRows ?? []).map(r => ({
      place_row_id:  r.id,
      place_name:    r.name || r.place_id,
      labeled_count: r.labeled_count ?? 0,
    }));

    return jsonResponse({ total, by_label, by_place }, 200, cors);
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
  }
}

// ============================================================
// 블라인드 테스트 (blind_test_items / blind_test_ratings)
// ============================================================

// 공개 엔드포인트용 접근코드 검증 헬퍼.
// 반환: null(통과) | Response(에러)
function checkBlindTestCode(code, env, corsHeaders) {
  if (!env.BLIND_TEST_ACCESS_CODE) {
    return jsonResponse({ error: 'not_configured' }, 503, corsHeaders);
  }
  if (code !== env.BLIND_TEST_ACCESS_CODE) {
    return jsonResponse({ error: 'bad_code' }, 401, corsHeaders);
  }
  return null;
}

// POST /api/blind-test/pool — 평가 풀 구성 (admin 전용)
async function handleBlindTestPool(request, env, corsHeaders) {
  const auth = await requireAdmin(request, env);
  if (auth.error) return jsonResponse({ error: auth.error, message: auth.message }, auth.status, corsHeaders);

  let body;
  try { body = await request.json(); } catch { body = {}; }

  const n_real = Number(body.n_real ?? 15);
  const n_gen  = Number(body.n_gen  ?? 15);
  const place_row_id = body.place_row_id ?? null;
  const gen_since    = body.gen_since    ?? null;

  // real 추출: human_label='human' 우선, 부족하면 라벨 없는 것으로 보충
  const placeFilterReal = place_row_id ? `AND pr.place_row_id = '${place_row_id}'` : '';
  const realRows = await env.DB.prepare(`
    SELECT pr.id, pr.body
    FROM place_reviews pr
    LEFT JOIN place_review_labels prl ON prl.review_id = pr.id
    WHERE length(pr.body) BETWEEN 15 AND 200
      ${placeFilterReal}
    ORDER BY CASE WHEN prl.human_label = 'human' THEN 0 ELSE 1 END, RANDOM()
    LIMIT ?
  `).bind(n_real).all();

  // gen 추출: status 'deleted'/'hidden' 제외
  const placeFilterGen = place_row_id ? `AND place_row_id = '${place_row_id}'` : '';
  const genSinceFilter = gen_since ? `AND created_at > '${gen_since}'` : '';
  const genRows = await env.DB.prepare(`
    SELECT id, body
    FROM place_generated_samples
    WHERE status NOT IN ('deleted', 'hidden')
      AND length(body) BETWEEN 15 AND 200
      ${placeFilterGen}
      ${genSinceFilter}
    ORDER BY RANDOM()
    LIMIT ?
  `).bind(n_gen).all();

  const realItems = realRows.results ?? [];
  const genItems  = genRows.results  ?? [];

  if (realItems.length === 0 && genItems.length === 0) {
    return jsonResponse({ error: 'no_data', message: '조건에 맞는 데이터가 없습니다' }, 404, corsHeaders);
  }

  const pool = 'pool_' + crypto.randomUUID().slice(0, 8);
  const now  = new Date().toISOString();

  // 배치 INSERT
  const stmt = env.DB.prepare(
    `INSERT INTO blind_test_items (id, pool, source, ref_id, body, created_at, active)
     VALUES (?, ?, ?, ?, ?, ?, 1)`
  );
  const batch = [
    ...realItems.map(r => stmt.bind(crypto.randomUUID(), pool, 'real', r.id, r.body, now)),
    ...genItems.map(r  => stmt.bind(crypto.randomUUID(), pool, 'gen',  r.id, r.body, now)),
  ];
  await env.DB.batch(batch);

  return jsonResponse({
    pool,
    n_real: realItems.length,
    n_gen:  genItems.length,
    total:  realItems.length + genItems.length,
  }, 200, corsHeaders);
}

// GET /api/blind-test/pools — 풀별 집계 목록 (researcher/admin)
async function handleBlindTestPools(request, env, corsHeaders) {
  const auth = await requireResearcher(request, env);
  if (auth.error) return jsonResponse({ error: auth.error, message: auth.message }, auth.status, corsHeaders);

  try {
    // 풀별 아이템 집계
    const itemsRes = await env.DB.prepare(`
      SELECT pool,
             MIN(created_at) AS created_at,
             SUM(CASE WHEN source = 'real' THEN 1 ELSE 0 END) AS n_real,
             SUM(CASE WHEN source = 'gen'  THEN 1 ELSE 0 END) AS n_gen,
             COUNT(*) AS total_items
      FROM blind_test_items
      GROUP BY pool
      ORDER BY MIN(created_at) DESC
    `).all();

    const pools = itemsRes.results ?? [];

    if (pools.length === 0) {
      return jsonResponse({ pools: [] }, 200, corsHeaders);
    }

    // 풀별 평가 집계 (total_ratings, raters)
    const ratingsRes = await env.DB.prepare(`
      SELECT bti.pool,
             COUNT(btr.id)              AS total_ratings,
             COUNT(DISTINCT btr.rater_label) AS raters
      FROM blind_test_items bti
      LEFT JOIN blind_test_ratings btr ON btr.item_id = bti.id
      GROUP BY bti.pool
    `).all();

    const ratingsMap = new Map(
      (ratingsRes.results ?? []).map(r => [r.pool, { total_ratings: r.total_ratings ?? 0, raters: r.raters ?? 0 }])
    );

    const result = pools.map(p => ({
      pool:          p.pool,
      created_at:    p.created_at,
      n_real:        p.n_real ?? 0,
      n_gen:         p.n_gen  ?? 0,
      total_items:   p.total_items ?? 0,
      total_ratings: ratingsMap.get(p.pool)?.total_ratings ?? 0,
      raters:        ratingsMap.get(p.pool)?.raters        ?? 0,
    }));

    return jsonResponse({ pools: result }, 200, corsHeaders);
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, corsHeaders);
  }
}

// GET /api/blind-test/items?code=&pool= — 아이템 목록 (공개 + 접근코드)
async function handleBlindTestItems(request, env, corsHeaders) {
  const url  = new URL(request.url);
  const code = url.searchParams.get('code') ?? '';
  const codeErr = checkBlindTestCode(code, env, corsHeaders);
  if (codeErr) return codeErr;

  let pool = url.searchParams.get('pool') ?? '';

  // pool 미지정이면 가장 최근 pool 사용
  if (!pool) {
    const poolRow = await env.DB.prepare(
      `SELECT pool FROM blind_test_items ORDER BY created_at DESC LIMIT 1`
    ).first();
    if (!poolRow) {
      return jsonResponse({ error: 'no_pool', message: '등록된 풀이 없습니다' }, 404, corsHeaders);
    }
    pool = poolRow.pool;
  }

  const rows = await env.DB.prepare(
    `SELECT id, body FROM blind_test_items WHERE pool = ? AND active = 1`
  ).bind(pool).all();

  const items = rows.results ?? [];

  // Fisher-Yates 셔플 (source 포함 금지 — id·body만)
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }

  return jsonResponse({ pool, items }, 200, corsHeaders);
}

// POST /api/blind-test/ratings — 평점 제출 (공개 + 접근코드)
async function handleBlindTestRatings(request, env, corsHeaders) {
  let body;
  try { body = await request.json(); } catch { body = {}; }

  const code = body.code ?? '';
  const codeErr = checkBlindTestCode(code, env, corsHeaders);
  if (codeErr) return codeErr;

  const nickname = (body.nickname ?? '').trim();
  if (!nickname) {
    return jsonResponse({ error: 'bad_request', message: 'nickname이 비어있습니다' }, 400, corsHeaders);
  }

  const ratings = Array.isArray(body.ratings) ? body.ratings : [];
  if (ratings.length === 0) {
    return jsonResponse({ error: 'bad_request', message: 'ratings 배열이 비어있습니다' }, 400, corsHeaders);
  }

  // 유효한 item_id 집합 조회 (존재하지 않는 항목 skip용)
  const itemIds = ratings.map(r => r.item_id).filter(Boolean);
  if (itemIds.length === 0) {
    return jsonResponse({ saved: 0, skipped: ratings.length }, 200, corsHeaders);
  }

  const placeholders = itemIds.map(() => '?').join(',');
  const existRows = await env.DB.prepare(
    `SELECT id FROM blind_test_items WHERE id IN (${placeholders})`
  ).bind(...itemIds).all();
  const existSet = new Set((existRows.results ?? []).map(r => r.id));

  const now  = new Date().toISOString();
  const stmt = env.DB.prepare(
    `INSERT OR IGNORE INTO blind_test_ratings (id, item_id, rater_label, rating, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  const batch = [];
  let skipped = 0;
  for (const r of ratings) {
    const rating = Number(r.rating);
    // rating이 1~5 정수가 아니거나 item_id가 없으면 skip
    if (!Number.isInteger(rating) || rating < 1 || rating > 5 || !existSet.has(r.item_id)) {
      skipped++;
      continue;
    }
    batch.push(stmt.bind(
      crypto.randomUUID(),
      r.item_id,
      nickname,
      rating,
      r.note ?? null,
      now
    ));
  }

  if (batch.length > 0) {
    await env.DB.batch(batch);
  }

  // ─── 채점 결과 + 해답 (제출 후 공개) ────────────────────────────────────────
  // 유효 점수(1~5)인 항목만 대상으로 한다.
  const validRatings = ratings.filter(r => {
    const v = Number(r.rating);
    return Number.isInteger(v) && v >= 1 && v <= 5 && r.item_id;
  });

  let summary = { total: 0, correct: 0, correct_human: 0, correct_ai: 0, abstain: 0, wrong: 0 };
  let reveal = [];

  if (validRatings.length > 0) {
    const validIds = validRatings.map(r => r.item_id);
    const ph2 = validIds.map(() => '?').join(',');
    const sourceRows = await env.DB.prepare(
      `SELECT id, source FROM blind_test_items WHERE id IN (${ph2})`
    ).bind(...validIds).all();
    const sourceMap = {};
    for (const row of (sourceRows.results ?? [])) {
      sourceMap[row.id] = row.source;
    }

    let correct_human = 0, correct_ai = 0, abstain = 0;
    for (const r of validRatings) {
      const source = sourceMap[r.item_id];
      if (!source) continue; // 이상값 제외
      const rating = Number(r.rating);
      reveal.push({ item_id: r.item_id, source, rating });
      if (rating === 3) {
        abstain++;
      } else if ((rating >= 4 && source === 'real') || (rating <= 2 && source === 'gen')) {
        correct_human += (source === 'real') ? 1 : 0;
        correct_ai    += (source === 'gen')  ? 1 : 0;
      }
    }
    const total = reveal.length;
    const correct = correct_human + correct_ai;
    const wrong = total - correct - abstain;
    summary = { total, correct, correct_human, correct_ai, abstain, wrong };
  }

  return jsonResponse({ saved: batch.length, skipped, summary, reveal }, 200, corsHeaders);
}

// GET /api/blind-test/results?pool= — 집계 결과 (researcher/admin)
async function handleBlindTestPoolDelete(pool, request, env, corsHeaders) {
  const auth = await requireAdmin(request, env);
  if (auth.error) return jsonResponse({ error: auth.error, message: auth.message }, auth.status, corsHeaders);

  // ratings 먼저 삭제 (FK 제약 고려)
  const ratingsResult = await env.DB.prepare(
    `DELETE FROM blind_test_ratings WHERE item_id IN (SELECT id FROM blind_test_items WHERE pool = ?)`
  ).bind(pool).run();

  const itemsResult = await env.DB.prepare(
    `DELETE FROM blind_test_items WHERE pool = ?`
  ).bind(pool).run();

  return jsonResponse({
    deleted_items: itemsResult.meta?.changes ?? 0,
    deleted_ratings: ratingsResult.meta?.changes ?? 0,
  }, 200, corsHeaders);
}

async function handleBlindTestAccessCode(request, env, corsHeaders) {
  const auth = await requireResearcher(request, env);
  if (auth.error) return jsonResponse({ error: auth.error, message: auth.message }, auth.status, corsHeaders);

  return jsonResponse({ code: env.BLIND_TEST_ACCESS_CODE ?? null }, 200, corsHeaders);
}

async function handleBlindTestResults(request, env, corsHeaders) {
  const auth = await requireResearcher(request, env);
  if (auth.error) return jsonResponse({ error: auth.error, message: auth.message }, auth.status, corsHeaders);

  const url  = new URL(request.url);
  const pool = url.searchParams.get('pool') ?? '';

  // source별 평점 목록 조회
  const poolFilter = pool ? `AND bti.pool = '${pool}'` : '';
  const rows = await env.DB.prepare(`
    SELECT bti.source, btr.rating, btr.rater_label
    FROM blind_test_ratings btr
    JOIN blind_test_items bti ON bti.id = btr.item_id
    WHERE 1=1 ${poolFilter}
  `).all();

  const allRatings = rows.results ?? [];

  // source별 분리
  const realRatings = allRatings.filter(r => r.source === 'real').map(r => r.rating);
  const genRatings  = allRatings.filter(r => r.source === 'gen').map(r => r.rating);
  const raters = new Set(allRatings.map(r => r.rater_label)).size;

  function summarize(arr) {
    const n = arr.length;
    if (n === 0) return { n: 0, mean: null, dist: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } };
    const sum  = arr.reduce((a, b) => a + b, 0);
    const mean = Math.round((sum / n) * 1000) / 1000;
    const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const v of arr) { if (dist[v] !== undefined) dist[v]++; }
    return { n, mean, dist };
  }

  const real = summarize(realRatings);
  const gen  = summarize(genRatings);
  const mean_diff = (real.mean !== null && gen.mean !== null)
    ? Math.round((real.mean - gen.mean) * 1000) / 1000
    : null;

  // Mann-Whitney U 검정 (동점 평균순위 처리, 정규근사)
  const mw = mannWhitneyU(realRatings, genRatings);

  return jsonResponse({
    pool: pool || null,
    real,
    gen,
    mean_diff,
    raters,
    mann_whitney: mw,
  }, 200, corsHeaders);
}

// Mann-Whitney U 검정 (순수 JS, 동점 평균순위 처리, 타이 보정 포함)
// 반환: { U, z, p_approx, note }
function mannWhitneyU(x, y) {
  const nx = x.length;
  const ny = y.length;

  if (nx === 0 || ny === 0) {
    return { U: null, z: null, p_approx: null, note: '데이터 부족으로 계산 불가' };
  }

  // 전체 통합 후 평균 순위 부여
  const combined = [
    ...x.map(v => ({ v, g: 'x' })),
    ...y.map(v => ({ v, g: 'y' })),
  ].sort((a, b) => a.v - b.v);

  const n = combined.length;
  const rank = new Array(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j < n && combined[j].v === combined[i].v) j++;
    const avgRank = (i + 1 + j) / 2; // 1-indexed 평균
    for (let k = i; k < j; k++) rank[k] = avgRank;
    i = j;
  }

  // 그룹별 순위합
  let Rx = 0;
  for (let k = 0; k < n; k++) {
    if (combined[k].g === 'x') Rx += rank[k];
  }

  const Ux = Rx - (nx * (nx + 1)) / 2;
  const Uy = nx * ny - Ux;
  const U  = Math.min(Ux, Uy);

  // 타이 보정 variance
  // 타이 그룹 크기 계산
  let tieCorrection = 0;
  let ti = 0;
  while (ti < n) {
    let tj = ti;
    while (tj < n && combined[tj].v === combined[ti].v) tj++;
    const t = tj - ti;
    if (t > 1) tieCorrection += (t * t * t - t);
    ti = tj;
  }
  const varU = (nx * ny / 12) * ((n + 1) - tieCorrection / (n * (n - 1)));
  const muU  = (nx * ny) / 2;

  let z = null;
  let p_approx = null;

  if (varU > 0) {
    z = Math.round(((U - muU) / Math.sqrt(varU)) * 1000) / 1000;
    // 양측 p 정규 근사: p ≈ 2 * Φ(-|z|)
    p_approx = Math.round(2 * normalCDF(-Math.abs(z)) * 10000) / 10000;
  }

  const note = (nx < 20 || ny < 20)
    ? '표본이 적어 p값은 참고용(정규근사 오차 큼)'
    : '정규근사 (n≥20 기준 충족)';

  return { U, z, p_approx, note };
}

// 표준정규분포 CDF 근사 (Abramowitz & Stegun, 최대오차 7.5e-8)
function normalCDF(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422820 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.7814779 + t * (-1.8212560 + t * 1.3302744))));
  return x >= 0 ? 1 - p : p;
}

// ============================================================
// IAA (평가자 간 일치도) 엔드포인트
// ============================================================

/**
 * POST /api/iaa/set  (admin 전용)
 * body: { n=60 }
 * 층화 표본(지점 × 길이구간)으로 place_reviews에서 n건 추출해 iaa_items에 저장.
 * 반환: { set_id, count }
 */
async function handleIaaSet(request, env, corsHeaders) {
  const cors = corsHeaders || {};

  const authResult = await requireAdmin(request, env);
  if (authResult.error) {
    return jsonResponse({ error: authResult.error, message: authResult.message }, authResult.status, cors);
  }

  let body;
  try { body = await request.json(); } catch { body = {}; }
  const n = Math.max(1, Math.min(parseInt(body?.n ?? 60, 10) || 60, 500));

  // 전체 지점 목록
  const { results: places } = await env.DB.prepare(
    `SELECT id FROM review_places ORDER BY id`
  ).all();

  if (!places || places.length === 0) {
    return jsonResponse({ error: 'no_places', message: '등록된 지점이 없습니다' }, 404, cors);
  }

  const BUCKETS = [
    { minLen: 10,  maxLen: 49  },
    { minLen: 50,  maxLen: 149 },
    { minLen: 150, maxLen: 400 },
  ];

  const placeCount  = places.length;
  const bucketCount = BUCKETS.length;
  const perSlot     = Math.max(1, Math.ceil(n / (placeCount * bucketCount)));

  const collected = [];

  for (const place of places) {
    for (const bucket of BUCKETS) {
      const { results: rows } = await env.DB.prepare(`
        SELECT id, body
        FROM place_reviews
        WHERE place_row_id = ?
          AND LENGTH(COALESCE(body, '')) >= ?
          AND LENGTH(COALESCE(body, '')) <= ?
        ORDER BY RANDOM()
        LIMIT ?
      `).bind(place.id, bucket.minLen, bucket.maxLen, perSlot).all();

      for (const row of (rows ?? [])) {
        collected.push({ review_id: row.id, body: row.body });
      }
    }
  }

  // 전체 셔플 → n건 절단 (중복 review_id 제거)
  for (let i = collected.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [collected[i], collected[j]] = [collected[j], collected[i]];
  }
  const seen = new Set();
  const items = [];
  for (const item of collected) {
    if (!seen.has(item.review_id) && items.length < n) {
      seen.add(item.review_id);
      items.push(item);
    }
  }

  if (items.length === 0) {
    return jsonResponse({ error: 'no_reviews', message: '조건에 맞는 리뷰가 없습니다' }, 404, cors);
  }

  const set_id   = 'iaa_' + crypto.randomUUID().slice(0, 8);
  const now      = new Date().toISOString();
  const insertStmt = env.DB.prepare(
    `INSERT INTO iaa_items (id, set_id, review_id, body, created_at) VALUES (?, ?, ?, ?, ?)`
  );

  const batch = items.map(item =>
    insertStmt.bind(crypto.randomUUID(), set_id, item.review_id, item.body, now)
  );
  await env.DB.batch(batch);

  return jsonResponse({ set_id, count: items.length }, 200, cors);
}

/**
 * GET /api/iaa/sets  (researcher 이상)
 * 세트 목록 + 메타(아이템 수, 평가자 수, 라벨 수).
 * 반환: { sets:[{ set_id, created_at, item_count, annotator_count, label_count }] }
 */
async function handleIaaSets(request, env, corsHeaders) {
  const cors = corsHeaders || {};

  const authResult = await requireResearcher(request, env);
  if (authResult.error) {
    return jsonResponse({ error: authResult.error, message: authResult.message }, authResult.status, cors);
  }

  try {
    const { results } = await env.DB.prepare(`
      SELECT
        i.set_id,
        MIN(i.created_at) AS created_at,
        COUNT(DISTINCT i.id) AS item_count,
        COUNT(DISTINCT l.annotator) AS annotator_count,
        COUNT(l.id) AS label_count
      FROM iaa_items i
      LEFT JOIN iaa_labels l ON l.set_id = i.set_id
      GROUP BY i.set_id
      ORDER BY created_at DESC
    `).all();

    return jsonResponse({ sets: results ?? [] }, 200, cors);
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
  }
}

/**
 * GET /api/iaa/items?code=&set=  (공개 + 접근코드)
 * set 미지정 시 최근 세트 사용. 셔플 후 반환.
 * 반환: { set_id, items:[{ review_id, body }] }
 */
async function handleIaaItems(request, env, corsHeaders) {
  const cors = corsHeaders || {};

  const url  = new URL(request.url);
  const code = url.searchParams.get('code') ?? '';
  const codeErr = checkBlindTestCode(code, env, corsHeaders);
  if (codeErr) return codeErr;

  let set_id = url.searchParams.get('set') ?? '';

  if (!set_id) {
    const row = await env.DB.prepare(
      `SELECT set_id FROM iaa_items ORDER BY created_at DESC LIMIT 1`
    ).first();
    if (!row) {
      return jsonResponse({ error: 'no_set', message: '등록된 세트가 없습니다' }, 404, cors);
    }
    set_id = row.set_id;
  }

  try {
    const { results } = await env.DB.prepare(
      `SELECT review_id, body FROM iaa_items WHERE set_id = ?`
    ).bind(set_id).all();

    const items = results ?? [];
    // Fisher-Yates 셔플
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }

    return jsonResponse({ set_id, items }, 200, cors);
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
  }
}

/**
 * POST /api/iaa/labels  (공개 + 접근코드)
 * body: { code, nickname, set, labels:[{ review_id, label, note? }] }
 * label∈{genuine,ad,ai,unsure} 외 skip. INSERT OR IGNORE.
 * 반환: { saved, skipped }
 */
async function handleIaaLabels(request, env, corsHeaders) {
  const cors = corsHeaders || {};

  let body;
  try { body = await request.json(); } catch { body = {}; }

  const code = body.code ?? '';
  const codeErr = checkBlindTestCode(code, env, corsHeaders);
  if (codeErr) return codeErr;

  const nickname = (body.nickname ?? '').trim();
  if (!nickname) {
    return jsonResponse({ error: 'bad_request', message: 'nickname이 비어있습니다' }, 400, cors);
  }

  const set_id = (body.set ?? '').trim();
  if (!set_id) {
    return jsonResponse({ error: 'bad_request', message: 'set이 비어있습니다' }, 400, cors);
  }

  const VALID_LABELS = new Set(['genuine', 'ad', 'ai', 'unsure']);
  const labels = Array.isArray(body.labels) ? body.labels : [];

  const now  = new Date().toISOString();
  const stmt = env.DB.prepare(
    `INSERT OR IGNORE INTO iaa_labels (id, set_id, review_id, annotator, label, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  const batch = [];
  let skipped = 0;

  for (const entry of labels) {
    const review_id = (entry.review_id ?? '').trim();
    const label     = (entry.label ?? '').trim();
    if (!review_id || !VALID_LABELS.has(label)) {
      skipped++;
      continue;
    }
    batch.push(stmt.bind(
      crypto.randomUUID(),
      set_id,
      review_id,
      nickname,
      label,
      entry.note ?? null,
      now
    ));
  }

  if (batch.length > 0) {
    try {
      await env.DB.batch(batch);
    } catch (err) {
      return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
    }
  }

  return jsonResponse({ saved: batch.length, skipped }, 200, cors);
}

/**
 * GET /api/iaa/results?set=  (researcher 이상)
 * Fleiss' κ + 쌍별 Cohen's κ + raw_agreement + class_dist.
 * 반환: { set, n_reviews_multi, annotators, fleiss_kappa, interpretation,
 *         pairwise, raw_agreement, class_dist, note? }
 */
async function handleIaaResults(request, env, corsHeaders) {
  const cors = corsHeaders || {};

  const authResult = await requireResearcher(request, env);
  if (authResult.error) {
    return jsonResponse({ error: authResult.error, message: authResult.message }, authResult.status, cors);
  }

  const url   = new URL(request.url);
  let set_id  = url.searchParams.get('set') ?? '';

  // set 미지정 시 최근 세트
  if (!set_id) {
    try {
      const row = await env.DB.prepare(
        `SELECT set_id FROM iaa_items ORDER BY created_at DESC LIMIT 1`
      ).first();
      if (row) set_id = row.set_id;
    } catch (err) {
      return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
    }
  }

  if (!set_id) {
    return jsonResponse({ error: 'no_set', message: '등록된 세트가 없습니다' }, 404, cors);
  }

  let labelRows;
  try {
    const { results } = await env.DB.prepare(
      `SELECT review_id, annotator, label FROM iaa_labels WHERE set_id = ?`
    ).bind(set_id).all();
    labelRows = results ?? [];
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: err.message }, 500, cors);
  }

  // --- 기본값 (데이터 부족) ---
  const CATEGORIES = ['genuine', 'ad', 'ai', 'unsure'];

  // annotator별 라벨 수 집계
  const annotatorCountMap = new Map();
  for (const row of labelRows) {
    annotatorCountMap.set(row.annotator, (annotatorCountMap.get(row.annotator) ?? 0) + 1);
  }
  const annotators = [...annotatorCountMap.entries()].map(([name, count]) => ({ name, count }));

  // review_id별 { annotator -> label } 맵 구성
  const reviewMap = new Map(); // review_id -> Map<annotator, label>
  for (const row of labelRows) {
    if (!reviewMap.has(row.review_id)) reviewMap.set(row.review_id, new Map());
    reviewMap.get(row.review_id).set(row.annotator, row.label);
  }

  // 2명 이상 라벨한 리뷰만 분석 대상
  const multiReviews = [...reviewMap.entries()].filter(([, m]) => m.size >= 2);
  const N = multiReviews.length;

  // class_dist: 전체 라벨 분포
  const classDist = { genuine: 0, ad: 0, ai: 0, unsure: 0 };
  for (const row of labelRows) {
    if (row.label in classDist) classDist[row.label]++;
  }

  // 데이터 부족
  if (annotators.length < 2 || N < 1) {
    return jsonResponse({
      set: set_id,
      n_reviews_multi: N,
      annotators,
      fleiss_kappa: null,
      interpretation: null,
      pairwise: [],
      raw_agreement: null,
      class_dist: classDist,
      note: '분석 대상 리뷰 부족 (평가자 2명 이상, 공통 리뷰 1건 이상 필요)',
    }, 200, cors);
  }

  // ─── Fleiss' κ (가변 평가자 수 버전) ─────────────────────────────────────────
  // P̄ = 평균(P_i),  P_e = Σ_c p_c²
  // P_i = (Σ_c n_ic² − n_i) / (n_i(n_i − 1))
  // p_c = (Σ_i n_ic) / (Σ_i n_i)
  // κ = (P̄ − P_e) / (1 − P_e)

  let sumPi        = 0;
  let totalLabels  = 0;               // Σ_i n_i
  const catTotal   = new Map(CATEGORIES.map(c => [c, 0])); // Σ_i n_ic per category

  for (const [, annotMap] of multiReviews) {
    const ni = annotMap.size;
    // 이 리뷰의 카테고리별 카운트
    const catCount = new Map(CATEGORIES.map(c => [c, 0]));
    for (const label of annotMap.values()) {
      if (catCount.has(label)) catCount.set(label, catCount.get(label) + 1);
    }

    // P_i
    let sumSq = 0;
    for (const c of CATEGORIES) sumSq += catCount.get(c) ** 2;
    const Pi = (sumSq - ni) / (ni * (ni - 1));
    sumPi      += Pi;
    totalLabels += ni;

    for (const c of CATEGORIES) {
      catTotal.set(c, catTotal.get(c) + catCount.get(c));
    }
  }

  const Pbar = sumPi / N;
  // p_c = catTotal_c / totalLabels
  let Pe = 0;
  for (const c of CATEGORIES) {
    const pc = catTotal.get(c) / totalLabels;
    Pe += pc * pc;
  }

  let fleiss_kappa = null;
  if (1 - Pe !== 0) {
    fleiss_kappa = Math.round(((Pbar - Pe) / (1 - Pe)) * 10000) / 10000;
  }

  // Landis-Koch 해석
  function interpretKappa(k) {
    if (k === null) return null;
    if (k < 0)   return 'poor (우연보다 낮음)';
    if (k < 0.2) return 'slight (매우 약함)';
    if (k < 0.4) return 'fair (약함)';
    if (k < 0.6) return 'moderate (보통)';
    if (k < 0.8) return 'substantial (상당함)';
    return 'almost perfect (거의 완전 일치)';
  }
  const interpretation = interpretKappa(fleiss_kappa);

  // ─── 쌍별 Cohen's κ ──────────────────────────────────────────────────────────
  const annotatorList = annotators.map(a => a.name);
  const pairwise = [];

  for (let ai = 0; ai < annotatorList.length; ai++) {
    for (let bi = ai + 1; bi < annotatorList.length; bi++) {
      const A = annotatorList[ai];
      const B = annotatorList[bi];

      // 둘 다 라벨한 리뷰
      const shared = [];
      for (const [, annotMap] of reviewMap) {
        if (annotMap.has(A) && annotMap.has(B)) {
          shared.push({ la: annotMap.get(A), lb: annotMap.get(B) });
        }
      }

      const pairN = shared.length;
      if (pairN === 0) {
        pairwise.push({ a: A, b: B, kappa: null, n: 0 });
        continue;
      }

      // 관측 일치 Po
      let agree = 0;
      const countA = new Map(CATEGORIES.map(c => [c, 0]));
      const countB = new Map(CATEGORIES.map(c => [c, 0]));
      for (const { la, lb } of shared) {
        if (la === lb) agree++;
        if (countA.has(la)) countA.set(la, countA.get(la) + 1);
        if (countB.has(lb)) countB.set(lb, countB.get(lb) + 1);
      }
      const Po = agree / pairN;

      // 기대 일치 Pe = Σ_c (nA_c/n) * (nB_c/n)
      let pairPe = 0;
      for (const c of CATEGORIES) {
        pairPe += (countA.get(c) / pairN) * (countB.get(c) / pairN);
      }

      let pairKappa = null;
      if (1 - pairPe !== 0) {
        pairKappa = Math.round(((Po - pairPe) / (1 - pairPe)) * 10000) / 10000;
      }

      pairwise.push({ a: A, b: B, kappa: pairKappa, n: pairN });
    }
  }

  // ─── raw_agreement ────────────────────────────────────────────────────────────
  // 다중 라벨 리뷰 중 모든 평가자 라벨이 동일한 비율
  let fullAgree = 0;
  for (const [, annotMap] of multiReviews) {
    const vals = [...annotMap.values()];
    if (vals.every(v => v === vals[0])) fullAgree++;
  }
  const raw_agreement = Math.round((fullAgree / N) * 10000) / 10000;

  return jsonResponse({
    set: set_id,
    n_reviews_multi: N,
    annotators,
    fleiss_kappa,
    interpretation,
    pairwise,
    raw_agreement,
    class_dist: classDist,
  }, 200, cors);
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
