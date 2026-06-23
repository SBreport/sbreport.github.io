# place-review-backfill

네이버 플레이스 **방문자 리뷰** 초기 백필 스크립트.  
한 플레이스의 리뷰를 페이지 단위로 수집해 우리 Cloudflare Worker에 적재한다.

## 요구 사항

- **Node.js 18+** (내장 `fetch` 사용, 추가 패키지 없음)
- 가정용 IP에서 실행 (데이터센터/VPN IP는 네이버에서 403 차단 가능)

---

## 환경 변수

| 변수 | 필수 | 설명 |
|---|---|---|
| `JWT` | **필수** | Worker 인증 토큰 (`Authorization: Bearer <JWT>`) |
| `PLACE_URL` | **필수** | 네이버 플레이스 URL (또는 스크립트 첫 번째 인자) |
| `NCAPTCHA_TOKEN` | 선택 | 네이버 캡챠 토큰 (`x-wtm-ncaptcha-token` 헤더) |
| `NAVER_COOKIE` | 선택 | 네이버 로그인 쿠키 (`Cookie` 헤더, 차단 우회 용도) |
| `WORKER_BASE` | 선택 | Worker 베이스 URL (기본: `https://naver-searchad-proxy.sbreport.workers.dev`) |
| `START_PAGE` | 선택 | 수집 시작 페이지 (기본: `1`) |
| `MAX_PAGES` | 선택 | 최대 수집 페이지 수 (기본: 무제한, total까지) |
| `PAGE_SIZE` | 선택 | 페이지당 리뷰 수 (기본: `10`, 네이버 기본값) |
| `DELAY_MS` | 선택 | 요청 간 딜레이 ms (기본: `1500`) |
| `BATCH_SIZE` | 선택 | Worker 적재 단위 건수 (기본: `100`) |

> **보안 주의**: `JWT`, `NAVER_COOKIE`, `NCAPTCHA_TOKEN`은 절대 소스에 하드코딩하지 말 것. 터미널 환경 변수 또는 `.env` 파일(git 제외)로만 관리.

---

## 실행 예시

### 기본 실행

```bash
JWT=eyJhbGci... PLACE_URL="https://pcmap.place.naver.com/hospital/1876125206/home" node tools/place-review-backfill/backfill.mjs
```

### 쿠키 + 캡챠 + 속도 조절

```bash
JWT=eyJhbGci... \
PLACE_URL="https://pcmap.place.naver.com/restaurant/12345678/home" \
NAVER_COOKIE="NNB=xxx; NID_AUT=yyy" \
NCAPTCHA_TOKEN="token값" \
DELAY_MS=2000 \
PAGE_SIZE=10 \
node tools/place-review-backfill/backfill.mjs
```

### 특정 구간만 수집 (이어받기)

```bash
# 51페이지부터 20페이지만 수집
JWT=... PLACE_URL=... START_PAGE=51 MAX_PAGES=20 node tools/place-review-backfill/backfill.mjs
```

---

## 동작 흐름

1. `PLACE_URL`에서 `placeId`와 `businessType` 자동 추출
2. Worker `POST /api/places`로 플레이스 행 확보 (`place_row_id` 획득)
3. 네이버 GraphQL `getVisitorReviews`를 페이지 순서로 호출
   - 요청마다 `DELAY_MS` 딜레이 (매너 수집)
   - 차단/오류 감지 시 지수 백오프 재시도 (최대 4회: 2초→4초→8초→16초)
4. 수집 건수가 `BATCH_SIZE`에 도달할 때마다 Worker `POST /api/places/:id/reviews`로 flush
5. 종료 후 남은 데이터 최종 flush
6. 완료 요약 출력 (수집수/적재수/스킵수/소요시간/차단여부)

---

## 차단 대응

- HTTP 비정상 / GraphQL errors / `visitorReviews` 필드 누락 → 자동 재시도
- 4회 재시도 후에도 실패 → 차단으로 판단, 지금까지 수집한 데이터 적재 후 종료
- 차단 발생 시 `START_PAGE`로 이어받기 수집 가능

---

## 지원 URL 형식

```
https://pcmap.place.naver.com/hospital/1876125206/home
https://pcmap.place.naver.com/restaurant/12345678/review/visitor
https://place.naver.com/restaurant/12345678
https://m.place.naver.com/hospital/1876125206
https://map.naver.com/p/entry/place/1876125206
1876125206  (숫자만 — businessType은 'place'로 폴백)
```
