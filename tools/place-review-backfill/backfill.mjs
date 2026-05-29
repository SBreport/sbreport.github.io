/**
 * backfill.mjs
 * 네이버 플레이스 방문자 리뷰 초기 백필 스크립트 (Node 18+ ESM)
 * 외부 의존성 없음 — Node 내장 fetch 사용
 *
 * 사용법:
 *   JWT=<토큰> PLACE_URL=<URL> node tools/place-review-backfill/backfill.mjs
 *
 * 필수 env: JWT, PLACE_URL (또는 첫 번째 인자)
 * 선택 env: NCAPTCHA_TOKEN, NAVER_COOKIE, MAX_PAGES, START_PAGE, PAGE_SIZE,
 *           DELAY_MS, WORKER_BASE, BATCH_SIZE
 */

// ─── GraphQL 쿼리 상수 ────────────────────────────────────────────────────────
const GQL_QUERY =
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

// ─── 상수 ─────────────────────────────────────────────────────────────────────
const NAVER_GRAPHQL_URL = 'https://pcmap-api.place.naver.com/graphql';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─── 유틸: 딜레이 ──────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── x-wtm-graphql 헤더 생성 ─────────────────────────────────────────────────
// 패딩 없는 base64url 사용 (네이버 서버 검증 실측)
function makeWtmGraphql(placeId, businessType) {
  const payload = JSON.stringify({ arg: placeId, type: businessType, source: 'place' });
  return Buffer.from(payload).toString('base64').replace(/=+$/, '');
}

// ─── URL에서 placeId·businessType 추출 ───────────────────────────────────────
// Worker와 동일 로직
function extractPlaceInfo(u) {
  if (!u || typeof u !== 'string') return null;
  u = u.trim();

  let m = u.match(/\/entry\/place\/(\d+)/);
  if (m) return { placeId: m[1], businessType: 'place' };

  m = u.match(
    /(?:place\.naver\.com|pcmap\.place\.naver\.com|m\.place\.naver\.com)\/([a-z]+)\/(\d+)/i
  );
  if (m) return { placeId: m[2], businessType: m[1].toLowerCase() };

  m = u.match(/\/([a-z]+)\/(\d{5,})/i);
  if (m) return { placeId: m[2], businessType: m[1].toLowerCase() };

  m = u.match(/(\d{6,})/);
  if (m) return { placeId: m[1], businessType: null };

  return null;
}

// ─── 네이버 GraphQL 호출 (지수 백오프 재시도) ────────────────────────────────
async function fetchNaverReviews(placeId, businessType, page, pageSize, retryCount = 0) {
  const MAX_RETRY = 4;
  const BACKOFF_BASE_MS = 2000;

  const wtmHeader = makeWtmGraphql(placeId, businessType);

  const headers = {
    'content-type': 'application/json',
    accept: '*/*',
    'accept-language': 'ko',
    Referer: `https://pcmap.place.naver.com/${businessType}/${placeId}/review/visitor`,
    Origin: 'https://pcmap.place.naver.com',
    'User-Agent': USER_AGENT,
    'x-wtm-graphql': wtmHeader,
  };

  // 선택 헤더: ncaptcha, 쿠키 (민감값이므로 env에서만 주입)
  if (process.env.NCAPTCHA_TOKEN) {
    headers['x-wtm-ncaptcha-token'] = process.env.NCAPTCHA_TOKEN;
  }
  if (process.env.NAVER_COOKIE) {
    headers['Cookie'] = process.env.NAVER_COOKIE;
  }

  const body = JSON.stringify([
    {
      operationName: 'getVisitorReviews',
      variables: {
        input: {
          businessId: placeId,
          businessType: businessType,
          item: '0',
          page: page,
          size: pageSize,
          isPhotoUsed: false,
          includeContent: true,
          getUserStats: false,
          includeReceiptPhotos: false,
          getReactions: false,
          getTrailer: false,
        },
      },
      query: GQL_QUERY,
    },
  ]);

  let res;
  try {
    res = await fetch(NAVER_GRAPHQL_URL, { method: 'POST', headers, body });
  } catch (netErr) {
    // 네트워크 오류 → 백오프 재시도
    if (retryCount >= MAX_RETRY) {
      throw new Error(`네트워크 오류 (재시도 소진): ${netErr.message}`);
    }
    const wait = BACKOFF_BASE_MS * 2 ** retryCount;
    console.log(`  [재시도 ${retryCount + 1}/${MAX_RETRY}] 네트워크 오류 → ${wait}ms 대기 후 재시도`);
    await sleep(wait);
    return fetchNaverReviews(placeId, businessType, page, pageSize, retryCount + 1);
  }

  // HTTP 비정상 응답 → 차단 가능성
  if (!res.ok) {
    if (retryCount >= MAX_RETRY) {
      throw new Error(`HTTP ${res.status} (재시도 소진)`);
    }
    const wait = BACKOFF_BASE_MS * 2 ** retryCount;
    console.log(
      `  [재시도 ${retryCount + 1}/${MAX_RETRY}] HTTP ${res.status} → ${wait}ms 대기 후 재시도`
    );
    await sleep(wait);
    return fetchNaverReviews(placeId, businessType, page, pageSize, retryCount + 1);
  }

  let json;
  try {
    json = await res.json();
  } catch (parseErr) {
    if (retryCount >= MAX_RETRY) throw new Error('JSON 파싱 실패 (재시도 소진)');
    const wait = BACKOFF_BASE_MS * 2 ** retryCount;
    console.log(`  [재시도 ${retryCount + 1}/${MAX_RETRY}] JSON 파싱 실패 → ${wait}ms 후 재시도`);
    await sleep(wait);
    return fetchNaverReviews(placeId, businessType, page, pageSize, retryCount + 1);
  }

  // GraphQL errors 필드 → 차단/오류
  if (!Array.isArray(json) || json[0]?.errors) {
    const errMsg = json[0]?.errors?.[0]?.message ?? 'unknown';
    if (retryCount >= MAX_RETRY) {
      throw new Error(`GraphQL 오류: ${errMsg} (재시도 소진)`);
    }
    const wait = BACKOFF_BASE_MS * 2 ** retryCount;
    console.log(
      `  [재시도 ${retryCount + 1}/${MAX_RETRY}] GraphQL 오류 "${errMsg}" → ${wait}ms 후 재시도`
    );
    await sleep(wait);
    return fetchNaverReviews(placeId, businessType, page, pageSize, retryCount + 1);
  }

  const visitorReviews = json[0]?.data?.visitorReviews;
  if (!visitorReviews) {
    if (retryCount >= MAX_RETRY) {
      throw new Error('visitorReviews 필드 없음 (재시도 소진)');
    }
    const wait = BACKOFF_BASE_MS * 2 ** retryCount;
    console.log(
      `  [재시도 ${retryCount + 1}/${MAX_RETRY}] visitorReviews 없음 → ${wait}ms 후 재시도`
    );
    await sleep(wait);
    return fetchNaverReviews(placeId, businessType, page, pageSize, retryCount + 1);
  }

  return visitorReviews; // { total, items[] }
}

// ─── 리뷰 아이템 → Worker POST body 형식으로 매핑 ────────────────────────────
function mapItem(item) {
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

// ─── Worker POST /api/places/:id/reviews ─────────────────────────────────────
async function flushToWorker(workerBase, jwt, placeRowId, reviews, totalReviews, placeName) {
  const url = `${workerBase}/api/places/${placeRowId}/reviews`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({
      reviews,
      total_reviews: totalReviews,
      name: placeName ?? undefined,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Worker 응답 오류 HTTP ${res.status}: ${text}`);
  }

  const json = await res.json();
  return json; // { inserted, skipped }
}

// ─── Worker POST /api/places → place_row_id 확보 ────────────────────────────
async function ensurePlaceRow(workerBase, jwt, placeUrl) {
  const url = `${workerBase}/api/places`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({ url: placeUrl }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`플레이스 등록 실패 HTTP ${res.status}: ${text}`);
  }

  const json = await res.json();
  const placeRowId = json?.place?.id;
  if (!placeRowId) {
    throw new Error(`플레이스 id를 응답에서 찾을 수 없습니다: ${JSON.stringify(json)}`);
  }
  return placeRowId;
}

// ─── 메인 ─────────────────────────────────────────────────────────────────────
async function main() {
  const startTime = Date.now();

  // ── env·인자 읽기 ──
  const jwt = process.env.JWT;
  const placeUrl = process.env.PLACE_URL ?? process.argv[2];
  const workerBase =
    process.env.WORKER_BASE ?? 'https://naver-searchad-proxy.sbreport.workers.dev';
  const maxPages = process.env.MAX_PAGES ? Number(process.env.MAX_PAGES) : Infinity;
  const startPage = process.env.START_PAGE ? Number(process.env.START_PAGE) : 1;
  const pageSize = process.env.PAGE_SIZE ? Number(process.env.PAGE_SIZE) : 10;
  const delayMs = process.env.DELAY_MS ? Number(process.env.DELAY_MS) : 1500;
  const batchSize = process.env.BATCH_SIZE ? Number(process.env.BATCH_SIZE) : 100;

  // ── 필수값 검증 ──
  if (!jwt || !placeUrl) {
    console.error('사용법: JWT=<토큰> PLACE_URL=<URL> node backfill.mjs');
    console.error('  필수 env: JWT, PLACE_URL');
    console.error('  선택 env: NCAPTCHA_TOKEN, NAVER_COOKIE, MAX_PAGES, START_PAGE,');
    console.error('           PAGE_SIZE, DELAY_MS, WORKER_BASE, BATCH_SIZE');
    process.exit(1);
  }

  // ── placeId·businessType 추출 ──
  const info = extractPlaceInfo(placeUrl);
  if (!info) {
    console.error(`PLACE_URL에서 placeId를 추출할 수 없습니다: ${placeUrl}`);
    process.exit(1);
  }

  let { placeId, businessType } = info;
  if (!businessType) {
    console.warn(
      `[경고] businessType을 URL에서 판별하지 못했습니다. 'place'로 폴백합니다.`
    );
    businessType = 'place';
  }

  console.log(`[시작] placeId=${placeId}, businessType=${businessType}`);
  console.log(`       startPage=${startPage}, pageSize=${pageSize}, delayMs=${delayMs}ms`);
  console.log(`       batchSize=${batchSize}, maxPages=${maxPages === Infinity ? '무제한' : maxPages}`);

  // ── 1단계: Worker에 플레이스 행 확보 ──
  let placeRowId;
  try {
    placeRowId = await ensurePlaceRow(workerBase, jwt, placeUrl);
    console.log(`[플레이스 등록] place_row_id=${placeRowId}`);
  } catch (err) {
    console.error(`[오류] 플레이스 등록 실패: ${err.message}`);
    process.exit(1);
  }

  // ── 루프 상태 초기화 ──
  let page = startPage;
  let totalReviews = null;   // 첫 응답에서 확정
  let placeName = null;      // 첫 item.businessName
  let buffer = [];           // 누적 버퍼
  let totalInserted = 0;
  let totalSkipped = 0;
  let totalCollected = 0;
  let blocked = false;
  let firstPage = true;

  // ── 2단계: 페이지 루프 ──
  while (true) {
    // 딜레이 (첫 페이지는 생략)
    if (!firstPage) {
      await sleep(delayMs);
    }

    console.log(`[페이지 ${page}] 수집 중...`);

    let visitorReviews;
    try {
      visitorReviews = await fetchNaverReviews(placeId, businessType, page, pageSize);
    } catch (err) {
      console.error(`[차단/오류] page=${page}: ${err.message}`);
      blocked = true;
      break;
    }

    const { total, items } = visitorReviews;

    // 첫 페이지에서 total 확정 + 샘플 출력
    if (firstPage) {
      totalReviews = total;
      console.log(`[총 리뷰 수] ${totalReviews}건 (서버 기준)`);

      if (items && items.length > 0) {
        const sample = items[0];
        console.log(
          `[샘플 item] id=${sample.id}, reviewId=${sample.reviewId}, ` +
          `author=${sample.author?.nickname ?? sample.nickname ?? '(없음)'}, ` +
          `created=${sample.created}`
        );
      }
      firstPage = false;
    }

    // items 비었으면 종료
    if (!items || items.length === 0) {
      console.log(`[종료] items가 비어 있습니다. (page=${page})`);
      break;
    }

    // 매핑 후 버퍼 누적
    for (const item of items) {
      if (!placeName && item.businessName) {
        placeName = item.businessName;
      }
      buffer.push(mapItem(item));
    }
    totalCollected += items.length;
    console.log(`  → ${items.length}건 수집 (누적 ${totalCollected}건)`);

    // 배치 flush
    if (buffer.length >= batchSize) {
      const chunk = buffer.splice(0, batchSize);
      try {
        const result = await flushToWorker(workerBase, jwt, placeRowId, chunk, totalReviews, placeName);
        totalInserted += result.inserted ?? 0;
        totalSkipped += result.skipped ?? 0;
        console.log(
          `  [flush] ${chunk.length}건 → inserted=${result.inserted}, skipped=${result.skipped}`
        );
      } catch (err) {
        console.error(`  [flush 오류] ${err.message}`);
        // flush 실패 시 버퍼에 되돌림 (데이터 유실 방지)
        buffer.unshift(...chunk);
      }
    }

    // 종료 조건 체크
    const maxPage = totalReviews ? Math.ceil(totalReviews / pageSize) : Infinity;
    if (totalCollected >= totalReviews) {
      console.log(`[종료] 총 리뷰 수 도달 (${totalCollected}/${totalReviews})`);
      break;
    }
    if (page >= maxPage) {
      console.log(`[종료] 마지막 페이지 도달 (page=${page}, maxPage=${maxPage})`);
      break;
    }
    if (page - startPage + 1 >= maxPages) {
      console.log(`[종료] MAX_PAGES 도달 (${maxPages}페이지)`);
      break;
    }

    page++;
  }

  // ── 3단계: 남은 버퍼 flush ──
  if (buffer.length > 0) {
    console.log(`[최종 flush] 남은 ${buffer.length}건 적재 중...`);
    try {
      const result = await flushToWorker(workerBase, jwt, placeRowId, buffer, totalReviews, placeName);
      totalInserted += result.inserted ?? 0;
      totalSkipped += result.skipped ?? 0;
      console.log(
        `  [flush] ${buffer.length}건 → inserted=${result.inserted}, skipped=${result.skipped}`
      );
      buffer = [];
    } catch (err) {
      console.error(`[최종 flush 오류] ${err.message}`);
    }
  }

  // ── 최종 요약 ──
  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n═══════════════════════════════════');
  console.log('[완료 요약]');
  console.log(`  업체명        : ${placeName ?? '(미확인)'}`);
  console.log(`  총 수집       : ${totalCollected}건`);
  console.log(`  적재 (inserted): ${totalInserted}건`);
  console.log(`  중복 스킵      : ${totalSkipped}건`);
  console.log(`  마지막 page   : ${page}`);
  console.log(`  차단 발생      : ${blocked ? '예' : '아니오'}`);
  console.log(`  소요 시간      : ${elapsedSec}초`);
  console.log('═══════════════════════════════════');
}

main().catch((err) => {
  console.error('[치명적 오류]', err.message);
  process.exit(1);
});
