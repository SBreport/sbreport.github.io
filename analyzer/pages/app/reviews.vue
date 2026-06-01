<script setup lang="ts">
// 플레이스 리뷰 수집 페이지: default 레이아웃
definePageMeta({
  layout: 'default',
})

// ─── 타입 ────────────────────────────────────────────────────────────────────

interface Place {
  id: number
  place_id: string
  business_type: string | null
  name: string | null
  total_reviews: number | null
  last_collected_at: string | null
  backfill_done: number | null
  created_at: string
  auto_collect: number  // 1 = on, 0 = off
}

interface Review {
  id: number
  naver_review_id: string
  author_nick: string | null
  body: string | null
  has_photo: number | null
  owner_reply: string | null
  visited_at: string | null
  review_created_at: string | null
  review_date: string | null  // ISO YYYY-MM-DD (정렬·집계용)
  collected_at: string
  first_source: 'cron' | 'manual' | 'backfill' | null
}

interface CollectionEvent {
  id: string
  source: 'cron' | 'manual' | 'backfill'
  inserted: number
  skipped: number
  pages_fetched: number
  total_server: number | null
  blocked: number
  error: string | null
  collected_at: string
}

interface BackfillChunkResult {
  done: boolean
  inserted: number
  skipped: number
  pages_fetched: number
  blocked: boolean
  error?: string
  total_server: number | null
  stored_count: number
}

interface PlaceStats {
  stored_count: number
  total_server: number | null
  reply_count: number
  reply_rate: number
  photo_count: number
  photo_rate: number
  monthly: { month: string; count: number }[]
  top_keywords: { word: string; count: number }[]
  snapshots: { captured_at: string; total_reviews: number; stored_count: number }[]
}

type LoadStatus = 'idle' | 'loading' | 'done' | 'error'

// ─── 상태 ────────────────────────────────────────────────────────────────────

const authStore = useAuthStore()

const WORKER_BASE = 'https://naver-searchad-proxy.sbreport.workers.dev'

// 플레이스 등록 폼
const urlInput = ref('')
const registerLoading = ref(false)
const registerError = ref<string | null>(null)

// 플레이스 목록
const places = ref<Place[]>([])
const placesStatus = ref<LoadStatus>('idle')
const placesError = ref<string | null>(null)

// 선택 플레이스
const selectedPlace = ref<Place | null>(null)

// 다중 선택 (체크박스)
const checkedPlaceIds = ref<Set<number>>(new Set())

const checkedPlaces = computed(() =>
  places.value.filter(p => checkedPlaceIds.value.has(p.id))
)

const allChecked = computed(() =>
  places.value.length > 0 && places.value.every(p => checkedPlaceIds.value.has(p.id))
)

const someChecked = computed(() =>
  places.value.some(p => checkedPlaceIds.value.has(p.id)) && !allChecked.value
)

function toggleCheck(place: Place) {
  const next = new Set(checkedPlaceIds.value)
  if (next.has(place.id)) next.delete(place.id)
  else next.add(place.id)
  checkedPlaceIds.value = next
}

function toggleAllCheck() {
  if (allChecked.value) {
    checkedPlaceIds.value = new Set()
  } else {
    checkedPlaceIds.value = new Set(places.value.map(p => p.id))
  }
}

// 리뷰 목록
const reviews = ref<Review[]>([])
const reviewsStatus = ref<LoadStatus>('idle')
const reviewsError = ref<string | null>(null)
const reviewsTotal = ref(0)

// 페이지네이션
const LIMIT = 50
const currentPage = ref(1)
const offset = computed(() => (currentPage.value - 1) * LIMIT)

// 수집 이력
const collectionEvents = ref<CollectionEvent[]>([])
const collectionsStatus = ref<LoadStatus>('idle')
const collectionsError = ref<string | null>(null)

// 지금 수집
const collectLoading = ref(false)
const collectToast = ref<{ type: 'success' | 'warn' | 'error'; message: string } | null>(null)

// 전체 수집 (단일 백필)
const backfillRunning = ref(false)
const backfillStopped = ref(false)
const backfillStoredCount = ref<number | null>(null)
const backfillTotalServer = ref<number | null>(null)
const backfillInsertedTotal = ref(0)
const backfillStatus = ref<'idle' | 'running' | 'done' | 'blocked' | 'error'>('idle')
const backfillMessage = ref<string | null>(null)

// 다중 지점 순차 백필
const multiBackfillRunning = ref(false)
const multiBackfillStopped = ref(false)
const multiBackfillCurrentIndex = ref(0)  // 0-based
const multiBackfillTotal = ref(0)
const multiBackfillCurrentPlaceName = ref('')
const multiBackfillCurrentStored = ref<number | null>(null)
const multiBackfillCurrentTotal = ref<number | null>(null)
const multiBackfillStatus = ref<'idle' | 'running' | 'done' | 'blocked' | 'error'>('idle')
const multiBackfillMessage = ref<string | null>(null)
const completedPlaceIds = ref<Set<number>>(new Set())

// CSV 다운로드 (단일)
const csvLoading = ref(false)
const csvProgress = ref<{ current: number; total: number } | null>(null)

// CSV 다운로드 (다중)
const multiCsvLoading = ref(false)
const multiCsvProgress = ref<{ placeIndex: number; placeTotal: number; rowCount: number } | null>(null)

// 수집 이력 패널 토글
const showHistory = ref(false)

// 삭제
const deleteConfirmOpen = ref(false)
const deleteLoading = ref(false)

// 자동갱신 토글
const autoCollectTogglingIds = ref<Set<number>>(new Set())

// 지점 통계 대시보드
const placeStats = ref<PlaceStats | null>(null)
const statsStatus = ref<LoadStatus>('idle')
const statsError = ref<string | null>(null)

// ─── AI 인사이트 리포트 타입 ──────────────────────────────────────────────────

interface ReportMeta {
  place_name: string
  sample_size: number
  model: string
  generated_at: string
}

interface ReportQuantitative {
  stored_count: number
  total_server: number | null
  reply_rate: number
  photo_rate: number
  monthly: { month: string; count: number }[]
  snapshots: { captured_at: string; total_reviews: number; stored_count: number }[]
}

interface ReportStrength {
  point: string
  evidence: string
}

interface ReportTheme {
  keyword: string
  sentiment: 'positive' | 'neutral' | 'negative'
  mentions: number
}

interface ReportQualitative {
  summary: string
  strengths: ReportStrength[]
  improvements: ReportStrength[]
  sentiment: { positive: number; neutral: number; negative: number }
  themes: ReportTheme[]
  representative_reviews: { positive: string[]; negative: string[] }
}

interface ReportJson {
  meta: ReportMeta
  quantitative: ReportQuantitative
  qualitative?: ReportQualitative
}

// AI 인사이트 리포트 상태
const placeReport = ref<ReportJson | null>(null)
const reportStatus = ref<'idle' | 'loading' | 'empty' | 'error' | 'done'>('idle')
const reportError = ref<string | null>(null)
const reportErrorCode = ref<string | null>(null)  // 'no_openai_key' 등
const reportGenerating = ref(false)

// ─── 리뷰 예시 생성 (Phase 4-3) 타입 ────────────────────────────────────────

interface ReviewSample {
  id: string
  body: string
  length: 'short' | 'medium' | 'long'
  tone: 'friendly' | 'polite' | 'emotional' | 'plain'
  focus: 'taste' | 'service' | 'mood' | 'price' | 'revisit'
  model?: string
  created_at?: string
}

interface GenerateSamplesResponse {
  place_name: string
  model: string
  generated_at: string
  samples: ReviewSample[]
}

// 리뷰 예시 생성 상태
const sampleCount = ref(10)
const samples = ref<ReviewSample[]>([])
const samplesStatus = ref<'idle' | 'loading' | 'generating' | 'empty' | 'error' | 'done'>('idle')
const samplesError = ref<string | null>(null)
const samplesErrorCode = ref<string | null>(null)
const samplesGenerating = ref(false)

// enum → 한글 매핑
const lengthLabel: Record<string, string> = { short: '한줄', medium: '중간', long: '장문' }
const toneLabel: Record<string, string> = { friendly: '친근', polite: '정중', emotional: '감성', plain: '담백' }
const focusLabel: Record<string, string> = { taste: '맛·품질', service: '서비스', mood: '분위기', price: '가격', revisit: '재방문' }

// ─── 신규 리뷰 판별 (cron 자동 수집으로 처음 적재된 리뷰만 신규로 표시) ─────

function isNewReview(review: Review): boolean {
  return review.first_source === 'cron'
}

// 네이버 플레이스 리뷰 URL 조립
function naverReviewUrl(place: Place): string {
  const type = place.business_type || 'place'
  return `https://pcmap.place.naver.com/${type}/${place.place_id}/review/visitor`
}

// ─── 헬퍼 ────────────────────────────────────────────────────────────────────

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (authStore.token) h['Authorization'] = `Bearer ${authStore.token}`
  return h
}

function formatDate(s: string | null | undefined): string {
  if (!s) return '—'
  const d = new Date(s)
  if (isNaN(d.getTime())) return s
  return d.toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

/** 리뷰 작성일 표시: review_date(ISO)가 있으면 YY.M.D(요일) 형식으로 통일. 없으면 원본 fallback. */
function formatReviewDate(review_date: string | null | undefined, review_created_at: string | null | undefined): string {
  if (review_date) {
    // review_date: "YYYY-MM-DD" → Date 생성 (로컬 자정으로 해석되도록 T00:00 붙임)
    const d = new Date(review_date + 'T00:00:00')
    if (!isNaN(d.getTime())) {
      const yy = String(d.getFullYear()).slice(2)
      const M = d.getMonth() + 1
      const D = d.getDate()
      const days = ['일', '월', '화', '수', '목', '금', '토']
      const dow = days[d.getDay()]
      return `${yy}.${M}.${D}(${dow})`
    }
  }
  // fallback: 원본 문자열 그대로
  return review_created_at || '—'
}

function formatDateTime(s: string | null | undefined): string {
  if (!s) return '—'
  const d = new Date(s)
  if (isNaN(d.getTime())) return s
  return d.toLocaleDateString('ko-KR', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

function placeName(p: Place): string {
  return p.name || p.place_id
}

// ─── API 호출 ─────────────────────────────────────────────────────────────────

async function fetchPlaces() {
  placesStatus.value = 'loading'
  placesError.value = null
  try {
    const res = await fetch(`${WORKER_BASE}/api/places`, {
      headers: authHeaders(),
    })
    if (!res.ok) {
      placesError.value = `오류 ${res.status}`
      placesStatus.value = 'error'
      return
    }
    const data = await res.json() as { places: Place[] }
    places.value = data.places
    placesStatus.value = 'done'
  } catch (e: unknown) {
    placesError.value = e instanceof Error ? e.message : '알 수 없는 오류'
    placesStatus.value = 'error'
  }
}

async function registerPlace() {
  const url = urlInput.value.trim()
  if (!url) return
  registerLoading.value = true
  registerError.value = null
  try {
    const res = await fetch(`${WORKER_BASE}/api/places`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ url }),
    })
    if (!res.ok) {
      let code = ''
      try {
        const body = await res.json() as { error?: string }
        code = body.error ?? ''
      } catch { /* ignore */ }
      if (code === 'invalid_url') {
        registerError.value = 'URL에서 플레이스 ID를 추출할 수 없습니다'
      } else {
        registerError.value = `등록 실패 (${res.status})`
      }
      return
    }
    urlInput.value = ''
    await fetchPlaces()
  } catch (e: unknown) {
    registerError.value = e instanceof Error ? e.message : '알 수 없는 오류'
  } finally {
    registerLoading.value = false
  }
}

async function fetchReviews(placeId: number) {
  reviewsStatus.value = 'loading'
  reviewsError.value = null
  reviews.value = []
  reviewsTotal.value = 0
  try {
    const params = new URLSearchParams({
      limit: String(LIMIT),
      offset: String(offset.value),
    })
    const res = await fetch(`${WORKER_BASE}/api/places/${placeId}/reviews?${params}`, {
      headers: authHeaders(),
    })
    if (!res.ok) {
      reviewsError.value = `오류 ${res.status}`
      reviewsStatus.value = 'error'
      return
    }
    const data = await res.json() as { reviews: Review[]; total: number }
    reviews.value = data.reviews
    reviewsTotal.value = data.total
    reviewsStatus.value = 'done'
  } catch (e: unknown) {
    reviewsError.value = e instanceof Error ? e.message : '알 수 없는 오류'
    reviewsStatus.value = 'error'
  }
}

async function fetchCollections(placeId: number) {
  collectionsStatus.value = 'loading'
  collectionsError.value = null
  collectionEvents.value = []
  try {
    const res = await fetch(`${WORKER_BASE}/api/places/${placeId}/collections?limit=30`, {
      headers: authHeaders(),
    })
    if (!res.ok) {
      collectionsError.value = `오류 ${res.status}`
      collectionsStatus.value = 'error'
      return
    }
    const data = await res.json() as { events: CollectionEvent[] }
    collectionEvents.value = data.events
    collectionsStatus.value = 'done'
  } catch (e: unknown) {
    collectionsError.value = e instanceof Error ? e.message : '알 수 없는 오류'
    collectionsStatus.value = 'error'
  }
}

async function fetchPlaceStats(placeId: number) {
  statsStatus.value = 'loading'
  statsError.value = null
  placeStats.value = null
  try {
    const res = await fetch(`${WORKER_BASE}/api/places/${placeId}/stats`, {
      headers: authHeaders(),
    })
    if (!res.ok) {
      statsError.value = `오류 ${res.status}`
      statsStatus.value = 'error'
      return
    }
    const data = await res.json() as PlaceStats
    placeStats.value = data
    statsStatus.value = 'done'
  } catch (e: unknown) {
    statsError.value = e instanceof Error ? e.message : '알 수 없는 오류'
    statsStatus.value = 'error'
  }
}

async function fetchPlaceReport(placeId: number) {
  reportStatus.value = 'loading'
  reportError.value = null
  reportErrorCode.value = null
  placeReport.value = null
  try {
    const res = await fetch(`${WORKER_BASE}/api/places/${placeId}/report`, {
      headers: authHeaders(),
    })
    if (res.status === 404) {
      reportStatus.value = 'empty'
      return
    }
    if (!res.ok) {
      let code = ''
      try {
        const body = await res.json() as { error?: string; code?: string }
        code = body.code ?? body.error ?? ''
      } catch { /* ignore */ }
      reportErrorCode.value = code
      reportError.value = `오류 ${res.status}`
      reportStatus.value = 'error'
      return
    }
    const data = await res.json() as ReportJson
    placeReport.value = data
    reportStatus.value = 'done'
  } catch {
    // 백엔드 미완성 시 조용히 empty 처리
    reportStatus.value = 'empty'
  }
}

async function generateReport(placeId: number) {
  if (reportGenerating.value) return
  reportGenerating.value = true
  reportError.value = null
  reportErrorCode.value = null
  try {
    const res = await fetch(`${WORKER_BASE}/api/places/${placeId}/report`, {
      method: 'POST',
      headers: authHeaders(),
    })
    if (!res.ok) {
      let code = ''
      let msg = `생성 실패 (${res.status})`
      try {
        const body = await res.json() as { error?: string; code?: string; message?: string }
        code = body.code ?? body.error ?? ''
        if (body.message) msg = body.message
        if (res.status === 503 && (code === 'no_openai_key' || code === 'openai_key_missing')) {
          msg = 'OpenAI API 키가 설정되지 않았습니다. 관리자에게 문의하세요.'
        }
      } catch { /* ignore */ }
      reportErrorCode.value = code
      reportError.value = msg
      reportStatus.value = 'error'
      return
    }
    const data = await res.json() as ReportJson
    placeReport.value = data
    reportStatus.value = 'done'
  } catch (e: unknown) {
    reportError.value = e instanceof Error ? e.message : '알 수 없는 오류'
    reportStatus.value = 'error'
  } finally {
    reportGenerating.value = false
  }
}

// ─── 리뷰 예시 생성 API (Phase 4-3) ─────────────────────────────────────────

async function fetchSamples(placeId: number) {
  samplesStatus.value = 'loading'
  samplesError.value = null
  samplesErrorCode.value = null
  samples.value = []
  try {
    const res = await fetch(`${WORKER_BASE}/api/places/${placeId}/samples`, {
      headers: authHeaders(),
    })
    if (!res.ok) {
      let code = ''
      try {
        const body = await res.json() as { error?: string }
        code = body.error ?? ''
      } catch { /* ignore */ }
      samplesErrorCode.value = code
      samplesError.value = `오류 ${res.status}`
      samplesStatus.value = 'error'
      return
    }
    const data = await res.json() as { samples: ReviewSample[] }
    samples.value = data.samples ?? []
    samplesStatus.value = samples.value.length > 0 ? 'done' : 'empty'
  } catch (e: unknown) {
    samplesError.value = e instanceof Error ? e.message : '알 수 없는 오류'
    samplesStatus.value = 'error'
  }
}

async function generateSamples(placeId: number) {
  if (samplesGenerating.value) return
  samplesGenerating.value = true
  samplesStatus.value = 'generating'
  samplesError.value = null
  samplesErrorCode.value = null
  try {
    const res = await fetch(`${WORKER_BASE}/api/places/${placeId}/generate-samples`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ count: sampleCount.value }),
    })
    if (!res.ok) {
      let code = ''
      let msg = `생성 실패 (${res.status})`
      try {
        const body = await res.json() as { error?: string; message?: string }
        code = body.error ?? ''
        if (body.message) msg = body.message
        if (res.status === 503 && code === 'no_openai_key') {
          msg = 'OpenAI API 키가 설정되지 않았습니다.'
        } else if (res.status === 400 && code === 'no_sample') {
          msg = '분석할 리뷰가 부족합니다. 리뷰를 먼저 수집하세요.'
        } else if (res.status === 403) {
          msg = '관리자 전용 기능입니다.'
        }
      } catch { /* ignore */ }
      samplesErrorCode.value = code
      samplesError.value = msg
      samplesStatus.value = 'error'
      return
    }
    const data = await res.json() as GenerateSamplesResponse
    const newItems = data.samples ?? []
    // 새 생성물을 기존 이력 위에 누적
    samples.value = [...newItems, ...samples.value]
    samplesStatus.value = samples.value.length > 0 ? 'done' : 'empty'
  } catch (e: unknown) {
    samplesError.value = e instanceof Error ? e.message : '알 수 없는 오류'
    samplesStatus.value = 'error'
  } finally {
    samplesGenerating.value = false
  }
}

function copySampleBody(body: string) {
  navigator.clipboard.writeText(body).catch(() => { /* 무시 */ })
}

function exportSamplesCsv() {
  if (samples.value.length === 0) return
  const headers = ['본문', '길이', '어조', '초점']
  const lines = [headers.join(',')]
  for (const s of samples.value) {
    lines.push([
      csvEscape(s.body),
      csvEscape(lengthLabel[s.length] ?? s.length),
      csvEscape(toneLabel[s.tone] ?? s.tone),
      csvEscape(focusLabel[s.focus] ?? s.focus),
    ].join(','))
  }
  const bom = '﻿'
  const blob = new Blob([bom + lines.join('\n')], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  const pname = selectedPlace.value ? placeName(selectedPlace.value).replace(/[^a-zA-Z0-9가-힣_-]/g, '_') : 'samples'
  a.download = `review_samples_${pname}_${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

async function collectNow() {
  if (!selectedPlace.value || collectLoading.value) return
  collectLoading.value = true
  collectToast.value = null
  const placeId = selectedPlace.value.id
  try {
    const res = await fetch(`${WORKER_BASE}/api/places/${placeId}/collect`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ maxPages: 3 }),
    })
    if (!res.ok) {
      let msg = `수집 실패 (${res.status})`
      try {
        const body = await res.json() as { message?: string }
        if (body.message) msg = body.message
      } catch { /* ignore */ }
      collectToast.value = { type: 'error', message: msg }
      return
    }
    const result = await res.json() as {
      inserted: number; skipped: number; blocked: boolean; error?: string
    }
    if (result.blocked) {
      collectToast.value = {
        type: 'warn',
        message: result.error ? `차단/오류: ${result.error}` : '수집 중 차단이 감지됐습니다',
      }
    } else {
      collectToast.value = {
        type: 'success',
        message: `신규 ${result.inserted}건 / 스킵 ${result.skipped}건`,
      }
    }
    // 수집 이력 + 리뷰표 새로고침
    await Promise.all([
      fetchCollections(placeId),
      fetchReviews(placeId),
    ])
    // 플레이스 목록도 갱신 (last_collected_at 반영)
    fetchPlaces()
  } catch (e: unknown) {
    collectToast.value = {
      type: 'error',
      message: e instanceof Error ? e.message : '알 수 없는 오류',
    }
  } finally {
    collectLoading.value = false
  }
}

function selectPlace(place: Place) {
  // 이전 플레이스 전환 시 백필 루프 정지 (메모리 누수·유령 호출 방지)
  backfillStopped.value = true
  backfillRunning.value = false
  backfillStatus.value = 'idle'
  backfillMessage.value = null
  backfillStoredCount.value = null
  backfillTotalServer.value = null
  backfillInsertedTotal.value = 0

  selectedPlace.value = place
  currentPage.value = 1
  collectToast.value = null
  showHistory.value = false
  placeStats.value = null
  statsStatus.value = 'idle'
  statsError.value = null
  placeReport.value = null
  reportStatus.value = 'idle'
  reportError.value = null
  reportErrorCode.value = null
  reportGenerating.value = false
  samples.value = []
  samplesStatus.value = 'idle'
  samplesError.value = null
  samplesErrorCode.value = null
  samplesGenerating.value = false
  fetchReviews(place.id)
  fetchCollections(place.id)
  fetchPlaceStats(place.id)
  fetchPlaceReport(place.id)
  if (authStore.isAdmin) fetchSamples(place.id)
}

function toggleHistory() {
  showHistory.value = !showHistory.value
}

function stopBackfill() {
  backfillStopped.value = true
  backfillMessage.value = '다음 청크 전송 중단 — 현재 진행 커서는 저장되어 있습니다'
}

// ─── 공용 백필 루프 (단일 지점) ──────────────────────────────────────────────
// stoppedRef: 외부에서 정지 신호를 주는 ref.  returns 'done' | 'blocked' | 'stopped' | 'error'

async function runBackfillLoop(
  placeId: number,
  stoppedRef: Ref<boolean>,
  onProgress: (result: BackfillChunkResult) => void,
): Promise<'done' | 'blocked' | 'stopped' | 'error'> {
  let consecutiveErrors = 0

  while (true) {
    if (stoppedRef.value) return 'stopped'

    let result: BackfillChunkResult
    try {
      const res = await fetch(`${WORKER_BASE}/api/places/${placeId}/backfill`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ maxPages: 5 }),
      })
      if (!res.ok) {
        let msg = `수집 오류 (${res.status})`
        try {
          const body = await res.json() as { message?: string }
          if (body.message) msg = body.message
        } catch { /* ignore */ }
        throw new Error(msg)
      }
      result = await res.json() as BackfillChunkResult
      consecutiveErrors = 0
    } catch (e: unknown) {
      consecutiveErrors++
      if (consecutiveErrors >= 3) {
        return 'error'
      }
      await new Promise((r) => setTimeout(r, 1000))
      continue
    }

    onProgress(result)

    if (result.blocked) return 'blocked'
    if (result.done) return 'done'

    // 청크 간 텀 (1초)
    await new Promise((r) => setTimeout(r, 1000))
  }
}

async function backfillAll() {
  if (!selectedPlace.value || backfillRunning.value) return

  backfillRunning.value = true
  backfillStopped.value = false
  backfillStatus.value = 'running'
  backfillMessage.value = null
  backfillInsertedTotal.value = 0
  backfillStoredCount.value = null
  backfillTotalServer.value = null

  const placeId = selectedPlace.value.id

  const outcome = await runBackfillLoop(
    placeId,
    backfillStopped,
    (result) => {
      backfillInsertedTotal.value += result.inserted
      if (result.stored_count != null) backfillStoredCount.value = result.stored_count
      if (result.total_server != null) backfillTotalServer.value = result.total_server
    },
  )

  backfillRunning.value = false

  if (outcome === 'done') {
    backfillStatus.value = 'done'
    backfillMessage.value = null
    await Promise.all([fetchCollections(placeId), fetchReviews(placeId)])
    fetchPlaces()
  } else if (outcome === 'blocked') {
    backfillStatus.value = 'blocked'
    backfillMessage.value = '차단 감지 — 잠시 후 "전체 수집"을 다시 누르면 이어서 진행됩니다.'
    await Promise.all([fetchCollections(placeId), fetchReviews(placeId)])
    fetchPlaces()
  } else if (outcome === 'stopped') {
    backfillStatus.value = 'idle'
    if (!backfillMessage.value) {
      backfillMessage.value = '수집이 중단되었습니다. 다시 시작하면 이어서 진행됩니다.'
    }
  } else {
    backfillStatus.value = 'error'
    backfillMessage.value = '네트워크 오류 3회 연속 — 수집 중단. 다시 시작하면 이어서 진행됩니다.'
  }
}

// ─── 다중 지점 순차 백필 ──────────────────────────────────────────────────────

function stopMultiBackfill() {
  multiBackfillStopped.value = true
  multiBackfillMessage.value = '다음 청크 전송 중단 — 각 지점의 커서는 저장되어 있습니다'
}

async function startMultiBackfill() {
  if (multiBackfillRunning.value || checkedPlaces.value.length === 0) return

  const targets = [...checkedPlaces.value]

  multiBackfillRunning.value = true
  multiBackfillStopped.value = false
  multiBackfillStatus.value = 'running'
  multiBackfillMessage.value = null
  multiBackfillTotal.value = targets.length
  multiBackfillCurrentIndex.value = 0
  completedPlaceIds.value = new Set()

  for (let i = 0; i < targets.length; i++) {
    if (multiBackfillStopped.value) break

    const place = targets[i]
    multiBackfillCurrentIndex.value = i
    multiBackfillCurrentPlaceName.value = placeName(place)
    multiBackfillCurrentStored.value = null
    multiBackfillCurrentTotal.value = null

    const outcome = await runBackfillLoop(
      place.id,
      multiBackfillStopped,
      (result) => {
        if (result.stored_count != null) multiBackfillCurrentStored.value = result.stored_count
        if (result.total_server != null) multiBackfillCurrentTotal.value = result.total_server
      },
    )

    // 이 지점 결과 처리
    if (outcome === 'done') {
      const done = new Set(completedPlaceIds.value)
      done.add(place.id)
      completedPlaceIds.value = done
      // 현재 선택된 지점이면 리뷰·이력 갱신
      if (selectedPlace.value?.id === place.id) {
        await Promise.all([fetchCollections(place.id), fetchReviews(place.id)])
      }
      fetchPlaces()
    } else if (outcome === 'blocked') {
      multiBackfillRunning.value = false
      multiBackfillStatus.value = 'blocked'
      multiBackfillMessage.value = `차단 감지 (${placeName(place)}) — 커서가 저장되어 있습니다. 잠시 후 다시 시도하세요.`
      if (selectedPlace.value?.id === place.id) {
        await Promise.all([fetchCollections(place.id), fetchReviews(place.id)])
      }
      fetchPlaces()
      return
    } else if (outcome === 'error') {
      multiBackfillRunning.value = false
      multiBackfillStatus.value = 'error'
      multiBackfillMessage.value = `네트워크 오류 (${placeName(place)}) — 수집 중단.`
      return
    } else if (outcome === 'stopped') {
      break
    }

    // 지점 간 텀 (2초)
    if (i < targets.length - 1 && !multiBackfillStopped.value) {
      await new Promise((r) => setTimeout(r, 2000))
    }
  }

  multiBackfillRunning.value = false

  if (multiBackfillStopped.value) {
    multiBackfillStatus.value = 'idle'
    if (!multiBackfillMessage.value) {
      multiBackfillMessage.value = '수집이 중단되었습니다. 각 지점의 커서가 저장되어 있습니다.'
    }
  } else {
    multiBackfillStatus.value = 'done'
    multiBackfillMessage.value = null
    fetchPlaces()
  }
}

async function retryReviews() {
  if (!selectedPlace.value) return
  await fetchReviews(selectedPlace.value.id)
}

// 페이지 변경
watch(currentPage, () => {
  if (selectedPlace.value) {
    fetchReviews(selectedPlace.value.id)
  }
})

// ─── CSV 전체 다운로드 ────────────────────────────────────────────────────────

// 공용 헬퍼: 특정 placeId의 리뷰 전체를 순차 페이지 순회로 수집
async function fetchAllReviews(placeId: number): Promise<Review[]> {
  const FETCH_LIMIT = 200
  const firstRes = await fetch(
    `${WORKER_BASE}/api/places/${placeId}/reviews?limit=${FETCH_LIMIT}&offset=0`,
    { headers: authHeaders() },
  )
  if (!firstRes.ok) throw new Error(`리뷰 fetch 실패 (${firstRes.status})`)
  const firstData = await firstRes.json() as { reviews: Review[]; total: number }

  const total = firstData.total
  const result: Review[] = [...firstData.reviews]

  if (result.length === 0 || result.length >= total) return result

  const maxPages = Math.ceil(total / FETCH_LIMIT) + 5  // 안전 가드
  let fetchOffset = result.length
  let pageCount = 1

  while (true) {
    if (pageCount >= maxPages) break
    if (result.length >= total) break

    const params = new URLSearchParams({
      limit: String(FETCH_LIMIT),
      offset: String(fetchOffset),
    })
    const res = await fetch(`${WORKER_BASE}/api/places/${placeId}/reviews?${params}`, {
      headers: authHeaders(),
    })
    if (!res.ok) throw new Error(`리뷰 fetch 실패 (${res.status})`)
    const data = await res.json() as { reviews: Review[]; total: number }
    const batch = data.reviews

    if (batch.length === 0) break

    result.push(...batch)
    fetchOffset += batch.length
    pageCount++

    if (batch.length < FETCH_LIMIT) break
  }

  return result
}

// CSV 이스케이프 헬퍼
function csvEscape(v: string | number | null | undefined): string {
  const s = String(v ?? '')
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"`
    : s
}

async function exportCsv() {
  if (!selectedPlace.value || csvLoading.value) return
  if (reviewsTotal.value === 0) return

  csvLoading.value = true
  csvProgress.value = { current: 0, total: reviewsTotal.value }

  try {
    const allReviews = await fetchAllReviews(selectedPlace.value.id)
    csvProgress.value = { current: allReviews.length, total: reviewsTotal.value }

    if (allReviews.length === 0) return

    const headers = ['작성일', '작성자', '본문', '방문일', '답글여부', '사진여부']
    const csvLines = [headers.join(',')]
    for (const r of allReviews) {
      csvLines.push([
        csvEscape(formatReviewDate(r.review_date, r.review_created_at)),
        csvEscape(r.author_nick),
        csvEscape(r.body),
        csvEscape(formatDate(r.visited_at)),
        csvEscape(r.owner_reply ? '있음' : '없음'),
        csvEscape(r.has_photo === 1 ? '○' : ''),
      ].join(','))
    }

    const bom = '﻿'
    const blob = new Blob([bom + csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const pname = placeName(selectedPlace.value).replace(/[^a-zA-Z0-9가-힣_-]/g, '_')
    a.download = `reviews_${pname}_${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  } catch (e: unknown) {
    collectToast.value = {
      type: 'error',
      message: `CSV 다운로드 실패: ${e instanceof Error ? e.message : '알 수 없는 오류'}`,
    }
  } finally {
    csvLoading.value = false
    csvProgress.value = null
  }
}

// 다중 지점 선택 CSV 다운로드
async function exportMultiCsv() {
  if (checkedPlaces.value.length === 0 || multiCsvLoading.value) return
  if (multiBackfillRunning.value) return

  const targets = [...checkedPlaces.value]
  multiCsvLoading.value = true
  multiCsvProgress.value = { placeIndex: 0, placeTotal: targets.length, rowCount: 0 }

  const allRows: string[] = []
  const failedPlaces: string[] = []

  try {
    for (let i = 0; i < targets.length; i++) {
      const place = targets[i]
      multiCsvProgress.value = { placeIndex: i + 1, placeTotal: targets.length, rowCount: allRows.length }

      let placeReviews: Review[]
      try {
        placeReviews = await fetchAllReviews(place.id)
      } catch (e: unknown) {
        console.warn(`[exportMultiCsv] ${placeName(place)} fetch 실패:`, e)
        failedPlaces.push(placeName(place))
        continue
      }

      for (const r of placeReviews) {
        allRows.push([
          csvEscape(placeName(place)),
          csvEscape(formatReviewDate(r.review_date, r.review_created_at)),
          csvEscape(r.author_nick),
          csvEscape(r.body),
          csvEscape(formatDate(r.visited_at)),
          csvEscape(r.owner_reply ? '있음' : '없음'),
          csvEscape(r.has_photo === 1 ? '○' : ''),
        ].join(','))
      }
    }

    if (allRows.length === 0) {
      if (failedPlaces.length > 0) {
        collectToast.value = { type: 'error', message: `모든 지점 fetch 실패: ${failedPlaces[0]}` }
      }
      return
    }

    const headers = ['지점명', '작성일', '작성자', '본문', '방문일', '답글여부', '사진여부']
    const csvLines = [headers.join(','), ...allRows]

    const bom = '﻿'
    const blob = new Blob([bom + csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const dateStr = new Date().toISOString().slice(0, 10)
    const n = targets.length
    a.download = n === 1
      ? `reviews_${placeName(targets[0]).replace(/[^a-zA-Z0-9가-힣_-]/g, '_')}_${dateStr}.csv`
      : `reviews_${n}개지점_${dateStr}.csv`
    a.click()
    URL.revokeObjectURL(url)

    if (failedPlaces.length > 0) {
      collectToast.value = {
        type: 'warn',
        message: `CSV 저장됨 (${allRows.length}건). 일부 실패: ${failedPlaces.join(', ')}`,
      }
    }
  } catch (e: unknown) {
    collectToast.value = {
      type: 'error',
      message: `다중 CSV 다운로드 실패: ${e instanceof Error ? e.message : '알 수 없는 오류'}`,
    }
  } finally {
    multiCsvLoading.value = false
    multiCsvProgress.value = null
  }
}

// ─── 삭제 ────────────────────────────────────────────────────────────────────

function openDeleteConfirm() {
  if (checkedPlaces.value.length === 0 || deleteLoading.value) return
  deleteConfirmOpen.value = true
}

function closeDeleteConfirm() {
  deleteConfirmOpen.value = false
}

async function confirmDelete() {
  if (checkedPlaces.value.length === 0 || deleteLoading.value) return

  const targets = [...checkedPlaces.value]
  deleteLoading.value = true
  deleteConfirmOpen.value = false

  let successCount = 0
  const errors: string[] = []
  const deletedIds = new Set<number>()

  for (const place of targets) {
    try {
      const res = await fetch(`${WORKER_BASE}/api/places/${place.id}`, {
        method: 'DELETE',
        headers: authHeaders(),
      })
      if (!res.ok) {
        let msg = `${placeName(place)}: 삭제 실패 (${res.status})`
        try {
          const body = await res.json() as { message?: string }
          if (body.message) msg = `${placeName(place)}: ${body.message}`
        } catch { /* ignore */ }
        errors.push(msg)
      } else {
        successCount++
        deletedIds.add(place.id)
      }
    } catch (e: unknown) {
      errors.push(`${placeName(place)}: ${e instanceof Error ? e.message : '알 수 없는 오류'}`)
    }
  }

  deleteLoading.value = false

  // 선택 목록에서 삭제된 항목 제거
  const nextChecked = new Set(checkedPlaceIds.value)
  deletedIds.forEach(id => nextChecked.delete(id))
  checkedPlaceIds.value = nextChecked

  // 선택된 플레이스가 삭제됐으면 선택 해제 (리뷰표·이력 초기화)
  if (selectedPlace.value && deletedIds.has(selectedPlace.value.id)) {
    selectedPlace.value = null
    reviews.value = []
    reviewsStatus.value = 'idle'
    reviewsTotal.value = 0
    collectionEvents.value = []
    collectionsStatus.value = 'idle'
    collectToast.value = null
  }

  // 목록 새로고침
  await fetchPlaces()

  // 결과 토스트
  if (errors.length === 0) {
    collectToast.value = {
      type: 'success',
      message: `${successCount}개 플레이스 삭제됨`,
    }
  } else if (successCount > 0) {
    collectToast.value = {
      type: 'warn',
      message: `${successCount}개 삭제됨, ${errors.length}개 실패: ${errors[0]}`,
    }
  } else {
    collectToast.value = {
      type: 'error',
      message: `삭제 실패: ${errors[0]}`,
    }
  }
}

// ─── 자동갱신 토글 ───────────────────────────────────────────────────────────

async function toggleAutoCollect(place: Place) {
  if (autoCollectTogglingIds.value.has(place.id)) return

  const newValue = place.auto_collect === 1 ? 0 : 1

  // 낙관적 업데이트: UI 즉시 반영
  const toggleIds = new Set(autoCollectTogglingIds.value)
  toggleIds.add(place.id)
  autoCollectTogglingIds.value = toggleIds
  place.auto_collect = newValue

  try {
    const res = await fetch(`${WORKER_BASE}/api/places/${place.id}/auto-collect`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ auto_collect: newValue }),
    })
    if (!res.ok) {
      // 실패 시 롤백
      place.auto_collect = newValue === 1 ? 0 : 1
      let msg = `자동갱신 설정 실패 (${res.status})`
      try {
        const body = await res.json() as { message?: string }
        if (body.message) msg = body.message
      } catch { /* ignore */ }
      collectToast.value = { type: 'error', message: msg }
    }
  } catch (e: unknown) {
    // 네트워크 오류 시 롤백
    place.auto_collect = newValue === 1 ? 0 : 1
    collectToast.value = {
      type: 'error',
      message: e instanceof Error ? e.message : '자동갱신 설정 중 오류 발생',
    }
  } finally {
    const ids = new Set(autoCollectTogglingIds.value)
    ids.delete(place.id)
    autoCollectTogglingIds.value = ids
  }
}

// ─── 초기 로드 / 정리 ────────────────────────────────────────────────────────

onMounted(() => {
  fetchPlaces()
})

// 페이지 이탈 시 백필 루프 정지 (메모리 누수·유령 호출 방지)
onUnmounted(() => {
  backfillStopped.value = true
  multiBackfillStopped.value = true
})
</script>

<template>
  <!--
    height 체인: default 레이아웃 main(flex-1 min-h-0 overflow-y-auto p-6) → h-full flex flex-col
    등록 폼 shrink-0 / 본문(2열) flex-1 min-h-0
  -->
  <div class="h-full flex flex-col gap-3">

    <!-- ── 등록 폼 (shrink-0) ──────────────────────────────────────── -->
    <div class="shrink-0 flex flex-col gap-1.5">
      <div class="flex items-center gap-2">
        <UInput
          v-model="urlInput"
          placeholder="네이버 플레이스 URL을 입력하세요 (예: https://map.naver.com/p/...)"
          class="flex-1 text-sm"
          :disabled="registerLoading"
          @keydown.enter="registerPlace"
        />
        <UButton
          label="등록"
          :loading="registerLoading"
          :disabled="!urlInput.trim()"
          class="shrink-0"
          @click="registerPlace"
        />
      </div>
      <p v-if="registerError" class="text-xs text-red-500">{{ registerError }}</p>
    </div>

    <!-- ── 다중 백필 진행 바 (선택 지점 있고 실행 중일 때) ─────────────── -->
    <div
      v-if="multiBackfillStatus !== 'idle'"
      class="shrink-0 px-3 py-2 border rounded-lg text-xs flex items-center gap-3"
      :class="{
        'bg-blue-50 text-blue-700 border-blue-100': multiBackfillStatus === 'running',
        'bg-green-50 text-green-700 border-green-100': multiBackfillStatus === 'done',
        'bg-amber-50 text-amber-700 border-amber-100': multiBackfillStatus === 'blocked',
        'bg-red-50 text-red-700 border-red-100': multiBackfillStatus === 'error',
      }"
    >
      <template v-if="multiBackfillStatus === 'running'">
        <UIcon name="i-heroicons-arrow-path" class="w-3.5 h-3.5 shrink-0 animate-spin" />
        <span class="font-medium whitespace-nowrap">지점 {{ multiBackfillCurrentIndex + 1 }}/{{ multiBackfillTotal }}</span>
        <span class="text-blue-600 truncate">{{ multiBackfillCurrentPlaceName }}</span>
        <template v-if="multiBackfillCurrentStored !== null">
          <span class="tabular-nums whitespace-nowrap">
            {{ multiBackfillCurrentStored.toLocaleString('ko-KR') }}
            <template v-if="multiBackfillCurrentTotal">
              / {{ multiBackfillCurrentTotal.toLocaleString('ko-KR') }}건
            </template>
          </span>
          <div v-if="multiBackfillCurrentTotal" class="flex-1 min-w-0 h-1.5 rounded-full bg-blue-100 overflow-hidden">
            <div
              class="h-full rounded-full bg-blue-400 transition-all duration-300"
              :style="{ width: Math.min(100, Math.round(multiBackfillCurrentStored / multiBackfillCurrentTotal * 100)) + '%' }"
            />
          </div>
        </template>
        <UButton
          label="멈춤"
          size="xs"
          color="warning"
          variant="soft"
          class="shrink-0 ml-auto"
          @click="stopMultiBackfill"
        />
      </template>
      <template v-else-if="multiBackfillStatus === 'done'">
        <UIcon name="i-heroicons-check-circle" class="w-3.5 h-3.5 shrink-0" />
        <span class="font-medium">{{ multiBackfillTotal }}개 지점 전체 수집 완료</span>
      </template>
      <template v-else>
        <UIcon name="i-heroicons-exclamation-triangle" class="w-3.5 h-3.5 shrink-0" />
        <span>{{ multiBackfillMessage }}</span>
      </template>
    </div>

    <!-- ── 본문 2열: 플레이스 목록 + 우측 패널 ──────────────────────── -->
    <div class="flex-1 min-h-0 flex gap-3">

      <!-- 좌측: 플레이스 목록 (고정 너비) -->
      <div class="w-60 shrink-0 flex flex-col border border-gray-200 rounded-lg overflow-hidden">
        <!-- 좌측 헤더 -->
        <div class="shrink-0 flex items-center justify-between px-3 py-2 border-b border-gray-200 bg-gray-50">
          <div class="flex items-center gap-2 min-w-0">
            <!-- 전체선택 체크박스 -->
            <input
              type="checkbox"
              class="w-3.5 h-3.5 shrink-0 cursor-pointer accent-primary-600"
              :checked="allChecked"
              :indeterminate="someChecked"
              :disabled="places.length === 0"
              @change="toggleAllCheck"
            />
            <span class="text-xs font-medium text-gray-600">플레이스 목록</span>
          </div>
          <div class="flex items-center gap-1 shrink-0">
            <UButton
              icon="i-heroicons-arrow-path"
              size="xs"
              color="neutral"
              variant="ghost"
              :loading="placesStatus === 'loading'"
              aria-label="새로고침"
              @click="fetchPlaces"
            />
          </div>
        </div>

        <!-- 선택 지점 전체 수집 버튼 + 삭제 버튼 -->
        <div
          v-if="checkedPlaces.length > 0"
          class="shrink-0 px-2 py-1.5 border-b border-gray-200 bg-gray-50 flex flex-col gap-1"
        >
          <UButton
            v-if="!multiBackfillRunning"
            :label="`선택 지점 전체 수집 (${checkedPlaces.length})`"
            size="xs"
            color="primary"
            variant="soft"
            icon="i-heroicons-archive-box-arrow-down"
            class="w-full"
            @click="startMultiBackfill"
          />
          <UButton
            v-else
            label="수집 중... (멈춤)"
            size="xs"
            color="warning"
            variant="soft"
            icon="i-heroicons-pause-circle"
            class="w-full"
            @click="stopMultiBackfill"
          />
          <UButton
            :label="multiCsvLoading
              ? (multiCsvProgress ? `받는 중... (지점 ${multiCsvProgress.placeIndex}/${multiCsvProgress.placeTotal})` : '받는 중...')
              : `선택 지점 CSV (${checkedPlaces.length})`"
            size="xs"
            color="neutral"
            variant="outline"
            icon="i-heroicons-arrow-down-tray"
            class="w-full"
            :disabled="multiCsvLoading || multiBackfillRunning"
            :loading="multiCsvLoading"
            @click="exportMultiCsv"
          />
          <UButton
            :label="`선택 삭제 (${checkedPlaces.length})`"
            size="xs"
            color="error"
            variant="outline"
            icon="i-heroicons-trash"
            class="w-full"
            :disabled="deleteLoading || multiBackfillRunning"
            :loading="deleteLoading"
            @click="openDeleteConfirm"
          />
        </div>

        <!-- Loading -->
        <div v-if="placesStatus === 'loading'" class="flex-1 flex items-center justify-center p-4">
          <UIcon name="i-heroicons-arrow-path" class="w-5 h-5 text-gray-400 animate-spin" />
        </div>

        <!-- Error -->
        <div v-else-if="placesStatus === 'error'" class="flex-1 flex flex-col items-center justify-center gap-2 p-4">
          <p class="text-xs text-red-500 text-center">{{ placesError }}</p>
          <UButton label="재시도" size="xs" color="neutral" variant="outline" @click="fetchPlaces" />
        </div>

        <!-- Empty -->
        <div v-else-if="placesStatus === 'done' && places.length === 0" class="flex-1 flex items-center justify-center p-4">
          <p class="text-xs text-gray-400 text-center">등록된 플레이스가 없습니다</p>
        </div>

        <!-- Success: 목록 -->
        <ul v-else class="flex-1 min-h-0 overflow-y-auto divide-y divide-gray-100">
          <li
            v-for="place in places"
            :key="place.id"
            class="px-2 py-2.5 cursor-pointer transition-colors"
            :class="selectedPlace?.id === place.id
              ? 'bg-primary-50 text-primary-700'
              : 'hover:bg-gray-50 text-gray-700'"
            @click="selectPlace(place)"
          >
            <div class="flex items-center gap-1.5 min-w-0">
              <!-- 체크박스 -->
              <input
                type="checkbox"
                class="w-3.5 h-3.5 shrink-0 cursor-pointer accent-primary-600"
                :checked="checkedPlaceIds.has(place.id)"
                @click.stop
                @change="toggleCheck(place)"
              />
              <!-- 완료 뱃지 -->
              <span
                v-if="completedPlaceIds.has(place.id)"
                class="shrink-0 w-2 h-2 rounded-full bg-green-500"
                title="이번 다중 수집 완료"
              />
              <p class="text-sm font-medium leading-snug truncate flex-1 min-w-0">{{ placeName(place) }}</p>
              <a
                :href="naverReviewUrl(place)"
                target="_blank"
                rel="noopener noreferrer"
                class="shrink-0 text-gray-400 hover:text-primary-600 transition-colors"
                title="네이버 플레이스 리뷰 보기"
                @click.stop
              >
                <UIcon name="i-heroicons-arrow-top-right-on-square" class="w-3.5 h-3.5" />
              </a>
            </div>
            <div class="flex items-center gap-2 mt-0.5 pl-5">
              <span class="text-xs text-gray-400 tabular-nums">
                리뷰 {{ place.total_reviews != null ? place.total_reviews.toLocaleString('ko-KR') : '—' }}
              </span>
              <span class="text-xs text-gray-300">·</span>
              <span class="text-xs text-gray-400">갱신: {{ place.last_collected_at ? formatDate(place.last_collected_at) : '전' }}</span>
              <span class="text-xs text-gray-300">·</span>
              <!-- 자동갱신 토글 -->
              <button
                class="flex items-center gap-1 shrink-0"
                :class="autoCollectTogglingIds.has(place.id) ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'"
                :title="place.auto_collect === 1 ? '자동갱신 켜짐 — 클릭해서 끄기' : '자동갱신 꺼짐 — 클릭해서 켜기'"
                :disabled="autoCollectTogglingIds.has(place.id)"
                @click.stop="toggleAutoCollect(place)"
              >
                <!-- 토글 트랙 -->
                <span
                  class="relative inline-flex h-3 w-5 shrink-0 rounded-full transition-colors duration-150"
                  :class="place.auto_collect === 1 ? 'bg-primary-500' : 'bg-gray-300'"
                >
                  <span
                    class="absolute top-0.5 h-2 w-2 rounded-full bg-white shadow transition-transform duration-150"
                    :class="place.auto_collect === 1 ? 'translate-x-2.5' : 'translate-x-0.5'"
                  />
                </span>
                <span
                  class="text-xs"
                  :class="place.auto_collect === 1 ? 'text-primary-600' : 'text-gray-400'"
                >{{ place.auto_collect === 1 ? '자동' : '수동' }}</span>
              </button>
            </div>
          </li>
        </ul>
      </div>

      <!-- 우측: 리뷰 표(위) + 수집 이력(아래) — flex-col 분배 -->
      <div class="flex-1 min-h-0 flex flex-col gap-3">

        <!-- 우측 상단: 리뷰 표 (flex-[3]) -->
        <div class="flex-[3] min-h-0 flex flex-col border border-gray-200 rounded-lg overflow-hidden">

          <!-- 헤더 -->
          <div class="shrink-0 flex flex-col border-b border-gray-200 bg-gray-50">
            <!-- 헤더 행 1: 이름 + 버튼들 -->
            <div class="flex items-center justify-between px-3 py-2">
              <span class="text-xs font-medium text-gray-600">
                <template v-if="selectedPlace">
                  {{ placeName(selectedPlace) }}
                  <span v-if="reviewsStatus === 'done'" class="font-normal text-gray-400 ml-1">
                    총 {{ selectedPlace.total_reviews != null ? selectedPlace.total_reviews.toLocaleString('ko-KR') : '—' }}건 중 {{ reviewsTotal.toLocaleString('ko-KR') }}건 보유
                  </span>
                </template>
                <template v-else>리뷰</template>
              </span>
              <div class="flex items-center gap-2">
                <!-- 지금 수집 버튼 -->
                <UButton
                  v-if="selectedPlace"
                  label="지금 수집"
                  size="xs"
                  color="primary"
                  variant="soft"
                  icon="i-heroicons-arrow-down-circle"
                  :loading="collectLoading"
                  :disabled="backfillRunning"
                  @click="collectNow"
                />
                <!-- 전체 수집(백필) 버튼 -->
                <template v-if="selectedPlace">
                  <!-- 완료 상태 -->
                  <UButton
                    v-if="backfillStatus === 'done'"
                    label="전체 수집 완료"
                    size="xs"
                    color="neutral"
                    variant="outline"
                    icon="i-heroicons-check-circle"
                    disabled
                  />
                  <!-- 수집 중: 멈춤 버튼 -->
                  <UButton
                    v-else-if="backfillRunning"
                    label="수집 중... (멈춤)"
                    size="xs"
                    color="warning"
                    variant="soft"
                    icon="i-heroicons-pause-circle"
                    @click="stopBackfill"
                  />
                  <!-- 기본 / 이어하기 버튼 -->
                  <UButton
                    v-else
                    :label="backfillStatus === 'idle' ? '전체 수집' : '이어서 수집'"
                    size="xs"
                    color="neutral"
                    variant="outline"
                    icon="i-heroicons-archive-box-arrow-down"
                    :disabled="collectLoading"
                    @click="backfillAll"
                  />
                </template>
                <!-- CSV 다운로드 버튼 -->
                <UButton
                  v-if="reviewsStatus === 'done' && reviewsTotal > 0"
                  :label="csvLoading ? (csvProgress ? `${csvProgress.current}/${csvProgress.total}` : '받는 중...') : 'CSV'"
                  size="xs"
                  color="neutral"
                  variant="outline"
                  icon="i-heroicons-arrow-down-tray"
                  :loading="csvLoading"
                  :disabled="csvLoading"
                  @click="exportCsv"
                />
              </div>
            </div>

            <!-- 헤더 행 2: 마지막 갱신 요약 + 수집이력 토글 + 자동 갱신 안내 -->
            <div class="flex items-center justify-between px-3 pb-1.5 gap-3">
              <!-- 마지막 갱신 요약 + 수집이력 토글 -->
              <div class="flex items-center gap-1.5 min-w-0">
                <template v-if="selectedPlace">
                  <span class="text-xs text-gray-400">
                    갱신:
                    <span class="tabular-nums">{{ selectedPlace.last_collected_at ? formatDateTime(selectedPlace.last_collected_at) : '갱신 전' }}</span>
                  </span>
                  <span class="text-gray-300 text-xs">·</span>
                  <button
                    class="text-xs text-primary-600 hover:text-primary-800 transition-colors flex items-center gap-0.5 whitespace-nowrap"
                    @click="toggleHistory"
                  >
                    수집 이력
                    <UIcon
                      :name="showHistory ? 'i-heroicons-chevron-down' : 'i-heroicons-chevron-right'"
                      class="w-3 h-3"
                    />
                  </button>
                </template>
              </div>
              <!-- 자동 갱신 안내 -->
              <div class="flex items-center gap-1 shrink-0 text-gray-400">
                <UIcon name="i-heroicons-information-circle" class="w-3.5 h-3.5 shrink-0" />
                <span class="text-xs">매일 새벽 3시(KST) 자동 수집됩니다. 지점별 on/off는 좌측 목록에서 설정.</span>
              </div>
            </div>
          </div>

          <!-- 수집 결과 토스트 -->
          <div
            v-if="collectToast"
            class="shrink-0 px-3 py-1.5 text-xs border-b"
            :class="{
              'bg-green-50 text-green-700 border-green-100': collectToast.type === 'success',
              'bg-amber-50 text-amber-700 border-amber-100': collectToast.type === 'warn',
              'bg-red-50 text-red-700 border-red-100': collectToast.type === 'error',
            }"
          >
            {{ collectToast.message }}
          </div>

          <!-- 백필 진행 상태 바 (단일) -->
          <div
            v-if="selectedPlace && backfillStatus !== 'idle'"
            class="shrink-0 px-3 py-1.5 border-b text-xs flex items-center gap-3"
            :class="{
              'bg-blue-50 text-blue-700 border-blue-100': backfillStatus === 'running',
              'bg-green-50 text-green-700 border-green-100': backfillStatus === 'done',
              'bg-amber-50 text-amber-700 border-amber-100': backfillStatus === 'blocked',
              'bg-red-50 text-red-700 border-red-100': backfillStatus === 'error',
            }"
          >
            <!-- 수집 중: 스피너 + 진행률 -->
            <template v-if="backfillStatus === 'running'">
              <UIcon name="i-heroicons-arrow-path" class="w-3.5 h-3.5 shrink-0 animate-spin" />
              <span class="font-medium whitespace-nowrap">전체 수집 중</span>
              <template v-if="backfillStoredCount !== null">
                <span class="tabular-nums whitespace-nowrap">
                  보유 {{ backfillStoredCount.toLocaleString('ko-KR') }}
                  <template v-if="backfillTotalServer">&nbsp;/&nbsp;총 {{ backfillTotalServer.toLocaleString('ko-KR') }}건
                    <span class="text-blue-500">({{ Math.min(100, Math.round(backfillStoredCount / backfillTotalServer * 100)) }}%)</span>
                  </template>
                </span>
                <!-- 진행바 -->
                <div
                  v-if="backfillTotalServer"
                  class="flex-1 min-w-0 h-1.5 rounded-full bg-blue-100 overflow-hidden"
                >
                  <div
                    class="h-full rounded-full bg-blue-400 transition-all duration-300"
                    :style="{ width: Math.min(100, Math.round(backfillStoredCount / backfillTotalServer * 100)) + '%' }"
                  />
                </div>
              </template>
              <template v-else>
                <span class="tabular-nums whitespace-nowrap">신규 {{ backfillInsertedTotal.toLocaleString('ko-KR') }}건 수집 중...</span>
              </template>
            </template>
            <!-- 완료 -->
            <template v-else-if="backfillStatus === 'done'">
              <UIcon name="i-heroicons-check-circle" class="w-3.5 h-3.5 shrink-0" />
              <span class="font-medium">전체 수집 완료</span>
              <span v-if="backfillStoredCount !== null" class="tabular-nums whitespace-nowrap">
                보유 {{ backfillStoredCount.toLocaleString('ko-KR') }}건
              </span>
            </template>
            <!-- 차단 / 에러 / 정지 -->
            <template v-else>
              <UIcon name="i-heroicons-exclamation-triangle" class="w-3.5 h-3.5 shrink-0" />
              <span>{{ backfillMessage }}</span>
            </template>
          </div>

          <!-- Idle (플레이스 미선택) -->
          <div v-if="!selectedPlace" class="flex-1 flex items-center justify-center">
            <p class="text-sm text-gray-400">좌측에서 플레이스를 선택하세요.</p>
          </div>

          <!-- Loading -->
          <div v-else-if="reviewsStatus === 'loading'" class="flex-1 flex items-center justify-center">
            <UIcon name="i-heroicons-arrow-path" class="w-5 h-5 text-gray-400 animate-spin" />
          </div>

          <!-- Error -->
          <div v-else-if="reviewsStatus === 'error'" class="flex-1 flex flex-col items-center justify-center gap-2 p-4">
            <p class="text-sm text-red-500">{{ reviewsError }}</p>
            <UButton label="재시도" size="sm" color="neutral" variant="outline" @click="retryReviews" />
          </div>

          <!-- Empty -->
          <div v-else-if="reviewsStatus === 'done' && reviews.length === 0" class="flex-1 flex items-center justify-center">
            <p class="text-sm text-gray-400">수집된 리뷰가 없습니다.</p>
          </div>

          <!-- Success: 리뷰 표 -->
          <template v-else>

            <!-- ── AI 인사이트 패널 (shrink-0, 미니 통계 위) ─────────── -->
            <div class="shrink-0 border-b border-gray-100">

              <!-- Loading -->
              <div v-if="reportStatus === 'loading' || reportGenerating" class="flex items-center gap-1.5 px-3 py-2.5">
                <UIcon name="i-heroicons-arrow-path" class="w-3.5 h-3.5 text-gray-400 animate-spin shrink-0" />
                <span class="text-xs text-gray-400">{{ reportGenerating ? 'AI 리포트 생성 중 (수 초 소요)...' : 'AI 인사이트 불러오는 중...' }}</span>
              </div>

              <!-- Empty -->
              <div v-else-if="reportStatus === 'empty'" class="flex items-center justify-between px-3 py-2">
                <div class="flex items-center gap-1.5 min-w-0">
                  <UIcon name="i-heroicons-sparkles" class="w-3.5 h-3.5 text-gray-400 shrink-0" />
                  <span class="text-xs text-gray-400">AI 인사이트 리포트가 없습니다.</span>
                </div>
                <UButton
                  label="리포트 생성"
                  size="xs"
                  color="primary"
                  variant="soft"
                  icon="i-heroicons-sparkles"
                  :disabled="reportGenerating"
                  @click="selectedPlace && generateReport(selectedPlace.id)"
                />
              </div>

              <!-- Error -->
              <div v-else-if="reportStatus === 'error'" class="flex items-center gap-1.5 px-3 py-2">
                <UIcon name="i-heroicons-exclamation-circle" class="w-3.5 h-3.5 text-red-400 shrink-0" />
                <span v-if="reportErrorCode === 'no_openai_key' || reportErrorCode === 'openai_key_missing'" class="text-xs text-red-500">
                  OpenAI API 키가 설정되지 않았습니다. 관리자에게 문의하세요.
                </span>
                <span v-else class="text-xs text-red-400">리포트 로드 실패 — {{ reportError }}</span>
                <button
                  class="text-xs text-primary-600 hover:text-primary-800 transition-colors ml-1"
                  @click="selectedPlace && fetchPlaceReport(selectedPlace.id)"
                >재시도</button>
              </div>

              <!-- Success -->
              <div v-else-if="reportStatus === 'done' && placeReport" class="flex flex-col divide-y divide-gray-100">

                <!-- 총평 헤더 -->
                <div class="flex items-start justify-between gap-3 px-3 py-2">
                  <div class="flex items-start gap-1.5 min-w-0">
                    <UIcon name="i-heroicons-sparkles" class="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />
                    <p class="text-xs text-gray-700 leading-relaxed">
                      <span class="font-medium text-gray-900">AI 인사이트</span>
                      <span v-if="placeReport.qualitative?.summary" class="text-gray-400 mx-1">—</span>
                      <span v-if="placeReport.qualitative?.summary">{{ placeReport.qualitative.summary }}</span>
                    </p>
                  </div>
                  <!-- 다시 분석 버튼 + meta -->
                  <div class="flex items-center gap-2 shrink-0">
                    <span class="text-[10px] text-gray-400 tabular-nums whitespace-nowrap">
                      표본 {{ placeReport.meta.sample_size.toLocaleString('ko-KR') }}건 · {{ placeReport.meta.model }} · {{ placeReport.meta.generated_at.slice(0, 10) }}
                    </span>
                    <UButton
                      label="다시 분석"
                      size="xs"
                      color="neutral"
                      variant="ghost"
                      icon="i-heroicons-arrow-path"
                      :loading="reportGenerating"
                      :disabled="reportGenerating"
                      @click="selectedPlace && generateReport(selectedPlace.id)"
                    />
                  </div>
                </div>

                <!-- qualitative 블록 (없으면 스킵) -->
                <template v-if="placeReport.qualitative">

                  <!-- 강점 / 개선점 + 감성 분포 + 테마 칩 (한 행) -->
                  <div class="flex gap-0 divide-x divide-gray-100">

                    <!-- 강점 -->
                    <div
                      v-if="placeReport.qualitative.strengths?.length"
                      class="flex-1 min-w-0 px-3 py-2 flex flex-col gap-1"
                    >
                      <span class="text-[10px] font-medium text-green-700 uppercase tracking-wide">강점</span>
                      <div class="flex flex-col gap-1">
                        <div
                          v-for="s in placeReport.qualitative.strengths"
                          :key="s.point"
                          class="flex flex-col gap-0.5"
                        >
                          <span class="text-xs font-medium text-gray-800">{{ s.point }}</span>
                          <span class="text-[10px] text-gray-400 italic leading-snug line-clamp-2" :title="s.evidence">"{{ s.evidence }}"</span>
                        </div>
                      </div>
                    </div>

                    <!-- 개선점 -->
                    <div
                      v-if="placeReport.qualitative.improvements?.length"
                      class="flex-1 min-w-0 px-3 py-2 flex flex-col gap-1"
                    >
                      <span class="text-[10px] font-medium text-red-600 uppercase tracking-wide">개선점</span>
                      <div class="flex flex-col gap-1">
                        <div
                          v-for="imp in placeReport.qualitative.improvements"
                          :key="imp.point"
                          class="flex flex-col gap-0.5"
                        >
                          <span class="text-xs font-medium text-gray-800">{{ imp.point }}</span>
                          <span class="text-[10px] text-gray-400 italic leading-snug line-clamp-2" :title="imp.evidence">"{{ imp.evidence }}"</span>
                        </div>
                      </div>
                    </div>

                    <!-- 감성 분포 -->
                    <div
                      v-if="placeReport.qualitative.sentiment"
                      class="w-44 shrink-0 px-3 py-2 flex flex-col gap-1.5"
                    >
                      <span class="text-[10px] font-medium text-gray-500 uppercase tracking-wide">감성 분포</span>
                      <!-- 누적 가로 바 -->
                      <div class="flex h-3 rounded overflow-hidden gap-px">
                        <div
                          v-if="placeReport.qualitative.sentiment.positive > 0"
                          class="bg-green-400"
                          :style="{ width: placeReport.qualitative.sentiment.positive + '%' }"
                          :title="`긍정 ${placeReport.qualitative.sentiment.positive}%`"
                        />
                        <div
                          v-if="placeReport.qualitative.sentiment.neutral > 0"
                          class="bg-gray-300"
                          :style="{ width: placeReport.qualitative.sentiment.neutral + '%' }"
                          :title="`중립 ${placeReport.qualitative.sentiment.neutral}%`"
                        />
                        <div
                          v-if="placeReport.qualitative.sentiment.negative > 0"
                          class="bg-red-300"
                          :style="{ width: placeReport.qualitative.sentiment.negative + '%' }"
                          :title="`부정 ${placeReport.qualitative.sentiment.negative}%`"
                        />
                      </div>
                      <!-- 레전드 -->
                      <div class="flex items-center gap-2 flex-wrap">
                        <span class="flex items-center gap-1 text-[10px] text-gray-500">
                          <span class="inline-block w-2 h-2 rounded-sm bg-green-400 shrink-0" />
                          긍정 {{ placeReport.qualitative.sentiment.positive }}%
                        </span>
                        <span class="flex items-center gap-1 text-[10px] text-gray-500">
                          <span class="inline-block w-2 h-2 rounded-sm bg-gray-300 shrink-0" />
                          중립 {{ placeReport.qualitative.sentiment.neutral }}%
                        </span>
                        <span class="flex items-center gap-1 text-[10px] text-gray-500">
                          <span class="inline-block w-2 h-2 rounded-sm bg-red-300 shrink-0" />
                          부정 {{ placeReport.qualitative.sentiment.negative }}%
                        </span>
                      </div>
                    </div>

                    <!-- 테마 키워드 칩 -->
                    <div
                      v-if="placeReport.qualitative.themes?.length"
                      class="flex-1 min-w-0 px-3 py-2 flex flex-col gap-1.5"
                    >
                      <span class="text-[10px] font-medium text-gray-500 uppercase tracking-wide">테마 키워드</span>
                      <div class="flex flex-wrap gap-1">
                        <span
                          v-for="t in placeReport.qualitative.themes"
                          :key="t.keyword"
                          class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs whitespace-nowrap"
                          :class="{
                            'bg-green-50 text-green-700': t.sentiment === 'positive',
                            'bg-gray-100 text-gray-600': t.sentiment === 'neutral',
                            'bg-red-50 text-red-600': t.sentiment === 'negative',
                          }"
                          :title="`${t.mentions}회 언급 · ${t.sentiment === 'positive' ? '긍정' : t.sentiment === 'neutral' ? '중립' : '부정'}`"
                        >
                          {{ t.keyword }}
                          <span
                            class="tabular-nums text-[10px]"
                            :class="{
                              'text-green-500': t.sentiment === 'positive',
                              'text-gray-400': t.sentiment === 'neutral',
                              'text-red-400': t.sentiment === 'negative',
                            }"
                          >{{ t.mentions }}</span>
                        </span>
                      </div>
                    </div>

                  </div>

                  <!-- 대표 리뷰 (긍/부) -->
                  <div
                    v-if="placeReport.qualitative.representative_reviews && (placeReport.qualitative.representative_reviews.positive?.length || placeReport.qualitative.representative_reviews.negative?.length)"
                    class="flex gap-0 divide-x divide-gray-100"
                  >
                    <!-- 긍정 대표 리뷰 -->
                    <div
                      v-if="placeReport.qualitative.representative_reviews.positive?.length"
                      class="flex-1 min-w-0 px-3 py-2 flex flex-col gap-1"
                    >
                      <span class="text-[10px] font-medium text-green-700 uppercase tracking-wide">긍정 대표 리뷰</span>
                      <div class="flex flex-col gap-1">
                        <blockquote
                          v-for="(q, i) in placeReport.qualitative.representative_reviews.positive.slice(0, 2)"
                          :key="i"
                          class="border-l-2 border-green-200 pl-2 text-[10px] text-gray-600 italic leading-snug line-clamp-2"
                          :title="q"
                        >{{ q }}</blockquote>
                      </div>
                    </div>
                    <!-- 부정 대표 리뷰 -->
                    <div
                      v-if="placeReport.qualitative.representative_reviews.negative?.length"
                      class="flex-1 min-w-0 px-3 py-2 flex flex-col gap-1"
                    >
                      <span class="text-[10px] font-medium text-red-600 uppercase tracking-wide">부정 대표 리뷰</span>
                      <div class="flex flex-col gap-1">
                        <blockquote
                          v-for="(q, i) in placeReport.qualitative.representative_reviews.negative.slice(0, 2)"
                          :key="i"
                          class="border-l-2 border-red-200 pl-2 text-[10px] text-gray-600 italic leading-snug line-clamp-2"
                          :title="q"
                        >{{ q }}</blockquote>
                      </div>
                    </div>
                  </div>

                </template>

                <!-- qualitative 없을 때: 정량만 있다는 안내 -->
                <div v-else class="px-3 py-1.5">
                  <span class="text-[10px] text-gray-400">정성 분석 데이터가 없습니다 (정량 데이터만 포함된 리포트)</span>
                </div>

              </div>
            </div>
            <!-- ── /AI 인사이트 패널 ────────────────────────────────── -->

            <!-- ── Phase 4-3: 리뷰 예시 생성 패널 (관리자 전용) ─────── -->
            <div v-if="authStore.isAdmin" class="shrink-0 border-b border-gray-100">

              <!-- 패널 헤더 -->
              <div class="flex items-center justify-between px-3 py-1.5 bg-gray-50 border-b border-gray-100">
                <div class="flex items-center gap-1.5">
                  <UIcon name="i-heroicons-beaker" class="w-3.5 h-3.5 text-gray-500 shrink-0" />
                  <span class="text-xs font-medium text-gray-700">리뷰 예시 생성</span>
                  <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-700 whitespace-nowrap">
                    AI 합성·연구용
                  </span>
                </div>
                <!-- 생성 컨트롤 -->
                <div class="flex items-center gap-2 shrink-0">
                  <span class="text-xs text-gray-400">개수</span>
                  <input
                    v-model.number="sampleCount"
                    type="number"
                    min="1"
                    max="30"
                    class="w-12 px-1.5 py-0.5 text-xs border border-gray-200 rounded text-center tabular-nums focus:outline-none focus:border-primary-400"
                    :disabled="samplesGenerating"
                  />
                  <UButton
                    label="예시 생성"
                    size="xs"
                    color="primary"
                    variant="soft"
                    icon="i-heroicons-sparkles"
                    :loading="samplesGenerating"
                    :disabled="samplesGenerating"
                    @click="selectedPlace && generateSamples(selectedPlace.id)"
                  />
                  <UButton
                    v-if="samples.length > 0"
                    label="CSV"
                    size="xs"
                    color="neutral"
                    variant="outline"
                    icon="i-heroicons-arrow-down-tray"
                    @click="exportSamplesCsv"
                  />
                </div>
              </div>

              <!-- 생성 중 -->
              <div v-if="samplesStatus === 'generating' || samplesGenerating" class="flex items-center gap-1.5 px-3 py-2.5">
                <UIcon name="i-heroicons-arrow-path" class="w-3.5 h-3.5 text-gray-400 animate-spin shrink-0" />
                <span class="text-xs text-gray-400">AI 예시 생성 중 (수 초 소요)...</span>
              </div>

              <!-- Loading (이력 조회 중) -->
              <div v-else-if="samplesStatus === 'loading'" class="flex items-center gap-1.5 px-3 py-2.5">
                <UIcon name="i-heroicons-arrow-path" class="w-3.5 h-3.5 text-gray-400 animate-spin shrink-0" />
                <span class="text-xs text-gray-400">예시 이력 불러오는 중...</span>
              </div>

              <!-- Error -->
              <div v-else-if="samplesStatus === 'error'" class="flex items-center gap-1.5 px-3 py-2">
                <UIcon name="i-heroicons-exclamation-circle" class="w-3.5 h-3.5 text-red-400 shrink-0" />
                <span class="text-xs text-red-500">{{ samplesError }}</span>
                <button
                  class="text-xs text-primary-600 hover:text-primary-800 transition-colors ml-1"
                  @click="selectedPlace && fetchSamples(selectedPlace.id)"
                >재시도</button>
              </div>

              <!-- Empty -->
              <div v-else-if="samplesStatus === 'empty' || samplesStatus === 'idle'" class="flex items-center gap-1.5 px-3 py-2.5">
                <UIcon name="i-heroicons-document-text" class="w-3.5 h-3.5 text-gray-300 shrink-0" />
                <span class="text-xs text-gray-400">아직 생성된 예시가 없습니다. 위 "예시 생성" 버튼을 누르세요.</span>
              </div>

              <!-- Success: 카드 리스트 -->
              <div v-else-if="samplesStatus === 'done' && samples.length > 0" class="overflow-y-auto" style="max-height: 280px">
                <div class="flex flex-col divide-y divide-gray-100">
                  <div
                    v-for="sample in samples"
                    :key="sample.id"
                    class="flex items-start gap-2 px-3 py-2 hover:bg-gray-50 transition-colors group"
                  >
                    <!-- 본문 -->
                    <p class="flex-1 min-w-0 text-xs text-gray-800 leading-relaxed">{{ sample.body }}</p>
                    <!-- 스타일 칩 + 복사 버튼 -->
                    <div class="flex items-center gap-1 shrink-0 flex-wrap justify-end">
                      <span class="inline-flex items-center px-1.5 py-0.5 rounded bg-gray-100 text-[10px] text-gray-600 whitespace-nowrap">
                        {{ lengthLabel[sample.length] ?? sample.length }}
                      </span>
                      <span class="inline-flex items-center px-1.5 py-0.5 rounded bg-blue-50 text-[10px] text-blue-700 whitespace-nowrap">
                        {{ toneLabel[sample.tone] ?? sample.tone }}
                      </span>
                      <span class="inline-flex items-center px-1.5 py-0.5 rounded bg-emerald-50 text-[10px] text-emerald-700 whitespace-nowrap">
                        {{ focusLabel[sample.focus] ?? sample.focus }}
                      </span>
                      <button
                        class="opacity-0 group-hover:opacity-100 transition-opacity ml-0.5 p-0.5 rounded text-gray-400 hover:text-gray-700"
                        title="본문 복사"
                        @click="copySampleBody(sample.body)"
                      >
                        <UIcon name="i-heroicons-clipboard-document" class="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>

            </div>
            <!-- ── /Phase 4-3: 리뷰 예시 생성 패널 ───────────────────── -->

            <!-- ── 미니 통계 대시보드 (shrink-0, 리뷰 표 위) ───────── -->
            <div class="shrink-0 border-b border-gray-100">
              <!-- Loading -->
              <div v-if="statsStatus === 'loading'" class="flex items-center gap-1.5 px-3 py-2">
                <UIcon name="i-heroicons-arrow-path" class="w-3.5 h-3.5 text-gray-400 animate-spin shrink-0" />
                <span class="text-xs text-gray-400">통계 집계 중...</span>
              </div>

              <!-- Error -->
              <div v-else-if="statsStatus === 'error'" class="flex items-center gap-1.5 px-3 py-2">
                <UIcon name="i-heroicons-exclamation-circle" class="w-3.5 h-3.5 text-red-400 shrink-0" />
                <span class="text-xs text-red-400">통계 로드 실패 — {{ statsError }}</span>
                <button
                  class="text-xs text-primary-600 hover:text-primary-800 transition-colors ml-1"
                  @click="selectedPlace && fetchPlaceStats(selectedPlace.id)"
                >재시도</button>
              </div>

              <!-- Success -->
              <div v-else-if="statsStatus === 'done' && placeStats" class="flex flex-col gap-0 divide-y divide-gray-100">

                <!-- KPI 카드 줄 -->
                <div class="flex items-stretch divide-x divide-gray-100">
                  <div class="flex flex-col items-center justify-center px-4 py-2 min-w-0 flex-1 gap-0.5">
                    <span class="text-xs text-gray-400 whitespace-nowrap">저장 리뷰</span>
                    <span class="text-base font-semibold tabular-nums text-gray-800">{{ placeStats.stored_count.toLocaleString('ko-KR') }}</span>
                  </div>
                  <div class="flex flex-col items-center justify-center px-4 py-2 min-w-0 flex-1 gap-0.5">
                    <span class="text-xs text-gray-400 whitespace-nowrap">답글률</span>
                    <span class="text-base font-semibold tabular-nums text-gray-800">{{ (placeStats.reply_rate * 100).toFixed(1) }}<span class="text-xs font-normal text-gray-400">%</span></span>
                  </div>
                  <div class="flex flex-col items-center justify-center px-4 py-2 min-w-0 flex-1 gap-0.5">
                    <span class="text-xs text-gray-400 whitespace-nowrap">사진첨부율</span>
                    <span class="text-base font-semibold tabular-nums text-gray-800">{{ (placeStats.photo_rate * 100).toFixed(1) }}<span class="text-xs font-normal text-gray-400">%</span></span>
                  </div>
                  <div class="flex flex-col items-center justify-center px-4 py-2 min-w-0 flex-1 gap-0.5">
                    <span class="text-xs text-gray-400 whitespace-nowrap">서버 총 리뷰</span>
                    <span class="text-base font-semibold tabular-nums text-gray-800">
                      {{ placeStats.total_server != null ? placeStats.total_server.toLocaleString('ko-KR') : '—' }}
                    </span>
                  </div>
                </div>

                <!-- 키워드 + 월별 분포 + 추이 (한 줄) -->
                <div class="flex gap-0 divide-x divide-gray-100">

                  <!-- 키워드 칩 영역 -->
                  <div
                    v-if="placeStats.top_keywords.length > 0"
                    class="flex-1 min-w-0 px-3 py-2 flex flex-col gap-1.5"
                  >
                    <span class="text-xs text-gray-400">리뷰 본문 단순 빈도 (정밀 분석 예정)</span>
                    <div class="flex flex-wrap gap-1">
                      <span
                        v-for="(kw, i) in placeStats.top_keywords"
                        :key="kw.word"
                        class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-gray-100 text-gray-700 whitespace-nowrap"
                        :class="i < 3 ? 'font-medium text-xs' : 'font-normal text-xs text-gray-500'"
                        :title="`${kw.count}회`"
                      >{{ kw.word }}<span class="text-gray-400 text-[10px] tabular-nums">{{ kw.count }}</span></span>
                    </div>
                  </div>

                  <!-- 월별 분포 미니 바 차트 -->
                  <div
                    v-if="placeStats.monthly.length > 0"
                    class="w-52 shrink-0 px-3 py-2 flex flex-col gap-1.5"
                  >
                    <span class="text-xs text-gray-400">월별 리뷰 수 (최근 12개월)</span>
                    <div class="flex items-end gap-px h-10">
                      <template v-if="Math.max(...placeStats.monthly.map(m => m.count)) > 0">
                        <div
                          v-for="m in placeStats.monthly"
                          :key="m.month"
                          class="flex-1 min-w-0 bg-primary-400 rounded-sm transition-all"
                          :style="{ height: Math.max(2, Math.round(m.count / Math.max(...placeStats.monthly.map(x => x.count)) * 40)) + 'px' }"
                          :title="`${m.month}: ${m.count}건`"
                        />
                      </template>
                    </div>
                    <div class="flex justify-between text-[10px] text-gray-400 tabular-nums">
                      <span>{{ placeStats.monthly[0]?.month?.slice(5) }}</span>
                      <span>{{ placeStats.monthly[placeStats.monthly.length - 1]?.month?.slice(5) }}</span>
                    </div>
                  </div>

                  <!-- 스냅샷 추이 -->
                  <div class="w-44 shrink-0 px-3 py-2 flex flex-col gap-1.5">
                    <span class="text-xs text-gray-400">저장 리뷰 추이</span>
                    <template v-if="placeStats.snapshots.length >= 2">
                      <div class="flex items-end gap-px h-10">
                        <template v-if="Math.max(...placeStats.snapshots.map(s => s.stored_count)) > 0">
                          <div
                            v-for="s in placeStats.snapshots"
                            :key="s.captured_at"
                            class="flex-1 min-w-0 bg-emerald-400 rounded-sm transition-all"
                            :style="{ height: Math.max(2, Math.round(s.stored_count / Math.max(...placeStats.snapshots.map(x => x.stored_count)) * 40)) + 'px' }"
                            :title="`${s.captured_at.slice(0,10)}: ${s.stored_count.toLocaleString('ko-KR')}건`"
                          />
                        </template>
                      </div>
                      <div class="flex justify-between text-[10px] text-gray-400 tabular-nums">
                        <span>{{ placeStats.snapshots[0]?.captured_at?.slice(5,10) }}</span>
                        <span>{{ placeStats.snapshots[placeStats.snapshots.length - 1]?.captured_at?.slice(5,10) }}</span>
                      </div>
                    </template>
                    <div v-else class="flex-1 flex items-center">
                      <span class="text-xs text-gray-400">데이터 누적 중 (며칠 뒤 표시)</span>
                    </div>
                  </div>

                </div>
              </div>
            </div>
            <!-- ── /미니 통계 대시보드 ─────────────────────────────── -->

            <!-- 표 스크롤 영역 -->
            <div class="flex-1 min-h-0 overflow-auto">
              <table class="w-full text-sm border-collapse">
                <thead class="sticky top-0 z-10 bg-gray-50">
                  <tr class="h-8">
                    <th class="px-3 text-left font-medium text-gray-600 text-xs whitespace-nowrap border-b border-gray-200 w-20">작성일</th>
                    <th class="px-3 text-left font-medium text-gray-600 text-xs whitespace-nowrap border-b border-gray-200 w-28">작성자</th>
                    <th class="px-3 text-left font-medium text-gray-600 text-xs border-b border-gray-200">본문</th>
                    <th class="px-3 text-center font-medium text-gray-600 text-xs whitespace-nowrap border-b border-gray-200 w-14">답글</th>
                    <th class="px-3 text-center font-medium text-gray-600 text-xs whitespace-nowrap border-b border-gray-200 w-10">사진</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="review in reviews"
                    :key="review.id"
                    class="border-b border-gray-100 last:border-0 hover:bg-gray-50 transition-colors"
                  >
                    <!-- 작성일 (review_date 기반 YY.M.D(요일) 표시, 없으면 원본 fallback) -->
                    <td class="px-3 py-1.5 whitespace-nowrap text-xs text-gray-500 tabular-nums">
                      {{ formatReviewDate(review.review_date, review.review_created_at) }}
                    </td>
                    <!-- 작성자 -->
                    <td class="px-3 py-1.5 text-xs text-gray-700 w-28 max-w-[7rem]">
                      <span class="flex items-center gap-1 min-w-0">
                        <span
                          v-if="isNewReview(review)"
                          class="inline-block shrink-0 w-2 h-2 rounded-full bg-green-500"
                          title="자동 수집으로 새로 포착된 리뷰"
                        />
                        <span class="truncate" :title="review.author_nick || ''">{{ review.author_nick || '—' }}</span>
                      </span>
                    </td>
                    <!-- 본문: 한 줄 말줄임, hover title로 전체 확인 -->
                    <td class="px-3 py-1.5 text-xs text-gray-800 max-w-0">
                      <span class="block truncate" :title="review.body || ''">{{ review.body || '—' }}</span>
                    </td>
                    <!-- 답글여부 -->
                    <td class="px-3 py-1.5 text-center text-xs text-gray-500 whitespace-nowrap">
                      {{ review.owner_reply ? '있음' : '' }}
                    </td>
                    <!-- 사진여부 -->
                    <td class="px-3 py-1.5 text-center text-xs text-gray-500 whitespace-nowrap">
                      {{ review.has_photo === 1 ? '○' : '' }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <!-- 페이지네이션 -->
            <div
              v-if="reviewsTotal > LIMIT"
              class="shrink-0 flex items-center justify-between px-3 py-2 border-t border-gray-200 bg-gray-50"
            >
              <span class="text-xs text-gray-400">
                {{ (currentPage - 1) * LIMIT + 1 }}–{{ Math.min(currentPage * LIMIT, reviewsTotal) }} / {{ reviewsTotal.toLocaleString('ko-KR') }}건
              </span>
              <div class="flex items-center gap-1">
                <UButton
                  icon="i-heroicons-chevron-left"
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  :disabled="currentPage === 1"
                  aria-label="이전 페이지"
                  @click="currentPage--"
                />
                <span class="text-xs text-gray-600 tabular-nums px-1">{{ currentPage }} / {{ Math.ceil(reviewsTotal / LIMIT) }}</span>
                <UButton
                  icon="i-heroicons-chevron-right"
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  :disabled="currentPage * LIMIT >= reviewsTotal"
                  aria-label="다음 페이지"
                  @click="currentPage++"
                />
              </div>
            </div>
          </template>
        </div>

        <!-- 우측 하단: 수집 이력 패널 (토글, 최대 1/3 높이) -->
        <div
          v-if="selectedPlace && showHistory"
          class="shrink-0 flex flex-col border border-gray-200 rounded-lg overflow-hidden"
          style="max-height: 34%"
        >
          <!-- 헤더 -->
          <div class="shrink-0 flex items-center justify-between px-3 py-1.5 border-b border-gray-200 bg-gray-50">
            <span class="text-xs font-medium text-gray-600">수집 이력</span>
            <div class="flex items-center gap-1">
              <UButton
                icon="i-heroicons-arrow-path"
                size="xs"
                color="neutral"
                variant="ghost"
                :loading="collectionsStatus === 'loading'"
                aria-label="이력 새로고침"
                @click="selectedPlace && fetchCollections(selectedPlace.id)"
              />
              <UButton
                icon="i-heroicons-chevron-down"
                size="xs"
                color="neutral"
                variant="ghost"
                aria-label="이력 접기"
                @click="showHistory = false"
              />
            </div>
          </div>

          <!-- Loading -->
          <div v-if="collectionsStatus === 'loading'" class="flex items-center justify-center py-4">
            <UIcon name="i-heroicons-arrow-path" class="w-4 h-4 text-gray-400 animate-spin" />
          </div>

          <!-- Error -->
          <div v-else-if="collectionsStatus === 'error'" class="flex items-center justify-center py-4">
            <p class="text-xs text-red-500">{{ collectionsError }}</p>
          </div>

          <!-- Empty -->
          <div v-else-if="collectionsStatus === 'done' && collectionEvents.length === 0" class="flex items-center justify-center py-4">
            <p class="text-xs text-gray-400">아직 수집 이력이 없습니다</p>
          </div>

          <!-- Success: 이력 표 -->
          <div v-else class="overflow-y-auto">
            <table class="w-full text-xs border-collapse">
              <thead class="sticky top-0 z-10 bg-gray-50">
                <tr>
                  <th class="px-3 py-1.5 text-left font-medium text-gray-500 whitespace-nowrap border-b border-gray-200 w-36">수집 시각</th>
                  <th class="px-3 py-1.5 text-left font-medium text-gray-500 whitespace-nowrap border-b border-gray-200 w-16">구분</th>
                  <th class="px-3 py-1.5 text-right font-medium text-gray-500 whitespace-nowrap border-b border-gray-200 w-14">신규</th>
                  <th class="px-3 py-1.5 text-right font-medium text-gray-500 whitespace-nowrap border-b border-gray-200 w-14">스킵</th>
                  <th class="px-3 py-1.5 text-left font-medium text-gray-500 border-b border-gray-200">비고</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="ev in collectionEvents"
                  :key="ev.id"
                  class="border-b border-gray-100 last:border-0 hover:bg-gray-50"
                  :class="ev.blocked ? 'bg-red-50' : ''"
                >
                  <td class="px-3 py-1.5 whitespace-nowrap text-gray-500 tabular-nums">
                    {{ formatDateTime(ev.collected_at) }}
                  </td>
                  <td class="px-3 py-1.5 whitespace-nowrap">
                    <span
                      class="inline-block px-1.5 py-0.5 rounded text-xs font-medium whitespace-nowrap"
                      :class="ev.source === 'cron'
                        ? 'bg-gray-100 text-gray-600'
                        : ev.source === 'backfill'
                          ? 'bg-emerald-50 text-emerald-700'
                          : 'bg-blue-50 text-blue-600'"
                    >
                      {{ ev.source === 'cron' ? '자동' : ev.source === 'backfill' ? '전체' : '수동' }}
                    </span>
                  </td>
                  <td class="px-3 py-1.5 text-right tabular-nums text-gray-700">
                    {{ ev.inserted }}
                  </td>
                  <td class="px-3 py-1.5 text-right tabular-nums text-gray-400">
                    {{ ev.skipped }}
                  </td>
                  <td class="px-3 py-1.5">
                    <span
                      v-if="ev.blocked"
                      class="text-red-500 font-medium"
                      :title="ev.error ?? ''"
                    >
                      차단/오류
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

      </div>
    </div>
  </div>

  <!-- 삭제 확인 다이얼로그 -->
  <UModal v-model:open="deleteConfirmOpen">
    <template #content>
      <div class="p-5 flex flex-col gap-4 max-w-sm w-full">
        <div class="flex flex-col gap-1">
          <p class="text-sm font-semibold text-gray-900">플레이스 삭제</p>
          <p class="text-xs text-gray-500">
            선택한 <span class="font-medium text-red-600">{{ checkedPlaces.length }}개</span> 플레이스와
            <span class="font-medium">수집된 모든 리뷰·이력이 영구 삭제</span>됩니다. 되돌릴 수 없습니다.
          </p>
        </div>
        <ul class="flex flex-col gap-0.5 max-h-32 overflow-y-auto">
          <li
            v-for="p in checkedPlaces"
            :key="p.id"
            class="text-xs text-gray-700 px-2 py-1 bg-gray-50 rounded truncate"
            :title="placeName(p)"
          >
            {{ placeName(p) }}
          </li>
        </ul>
        <div class="flex items-center justify-end gap-2">
          <UButton
            label="취소"
            size="sm"
            color="neutral"
            variant="outline"
            @click="closeDeleteConfirm"
          />
          <UButton
            label="삭제"
            size="sm"
            color="error"
            variant="solid"
            icon="i-heroicons-trash"
            @click="confirmDelete"
          />
        </div>
      </div>
    </template>
  </UModal>
</template>
