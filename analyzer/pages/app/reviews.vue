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

// CSV 다운로드
const csvLoading = ref(false)
const csvProgress = ref<{ current: number; total: number } | null>(null)

// 삭제
const deleteConfirmOpen = ref(false)
const deleteLoading = ref(false)

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
  fetchReviews(place.id)
  fetchCollections(place.id)
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

async function exportCsv() {
  if (!selectedPlace.value || csvLoading.value) return
  if (reviewsTotal.value === 0) return

  const placeId = selectedPlace.value.id
  const total = reviewsTotal.value
  const FETCH_LIMIT = 200
  const maxPages = Math.ceil(total / FETCH_LIMIT) + 5  // 안전 가드

  csvLoading.value = true
  csvProgress.value = { current: 0, total }

  const allReviews: Review[] = []

  try {
    let fetchOffset = 0
    let pageCount = 0

    while (true) {
      if (pageCount >= maxPages) break  // 무한루프 방지

      const params = new URLSearchParams({
        limit: String(FETCH_LIMIT),
        offset: String(fetchOffset),
      })
      const res = await fetch(`${WORKER_BASE}/api/places/${placeId}/reviews?${params}`, {
        headers: authHeaders(),
      })
      if (!res.ok) {
        throw new Error(`리뷰 fetch 실패 (${res.status})`)
      }
      const data = await res.json() as { reviews: Review[]; total: number }
      const batch = data.reviews

      if (batch.length === 0) break  // 더 없음

      allReviews.push(...batch)
      csvProgress.value = { current: allReviews.length, total }

      fetchOffset += batch.length
      pageCount++

      if (batch.length < FETCH_LIMIT) break  // 마지막 페이지
      if (allReviews.length >= total) break   // total 도달
    }

    if (allReviews.length === 0) return

    // CSV 생성
    const headers = ['작성일', '작성자', '본문', '방문일', '답글여부', '사진여부']

    const escape = (v: string | number | null | undefined): string => {
      const s = String(v ?? '')
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? `"${s.replace(/"/g, '""')}"`
        : s
    }

    const csvLines = [headers.join(',')]
    for (const r of allReviews) {
      csvLines.push([
        escape(formatDate(r.review_created_at)),
        escape(r.author_nick),
        escape(r.body),
        escape(formatDate(r.visited_at)),
        escape(r.owner_reply ? '있음' : '없음'),
        escape(r.has_photo === 1 ? '○' : ''),
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
              <span class="text-xs text-gray-400">{{ formatDate(place.last_collected_at) }}</span>
            </div>
          </li>
        </ul>
      </div>

      <!-- 우측: 리뷰 표(위) + 수집 이력(아래) — flex-col 분배 -->
      <div class="flex-1 min-h-0 flex flex-col gap-3">

        <!-- 우측 상단: 리뷰 표 (flex-[3]) -->
        <div class="flex-[3] min-h-0 flex flex-col border border-gray-200 rounded-lg overflow-hidden">

          <!-- 헤더 -->
          <div class="shrink-0 flex items-center justify-between px-3 py-2 border-b border-gray-200 bg-gray-50">
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
                    <!-- 작성일 -->
                    <td class="px-3 py-1.5 whitespace-nowrap text-xs text-gray-500 tabular-nums">
                      {{ formatDate(review.review_created_at) }}
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

        <!-- 우측 하단: 수집 이력 패널 (flex-[1], flex 분배) -->
        <div
          v-if="selectedPlace"
          class="flex-[1] min-h-0 flex flex-col border border-gray-200 rounded-lg overflow-hidden"
        >
          <!-- 헤더 -->
          <div class="shrink-0 flex items-center justify-between px-3 py-2 border-b border-gray-200 bg-gray-50">
            <span class="text-xs font-medium text-gray-600">수집 이력</span>
            <UButton
              icon="i-heroicons-arrow-path"
              size="xs"
              color="neutral"
              variant="ghost"
              :loading="collectionsStatus === 'loading'"
              aria-label="이력 새로고침"
              @click="selectedPlace && fetchCollections(selectedPlace.id)"
            />
          </div>

          <!-- Loading -->
          <div v-if="collectionsStatus === 'loading'" class="flex-1 flex items-center justify-center py-4">
            <UIcon name="i-heroicons-arrow-path" class="w-4 h-4 text-gray-400 animate-spin" />
          </div>

          <!-- Error -->
          <div v-else-if="collectionsStatus === 'error'" class="flex-1 flex items-center justify-center py-4">
            <p class="text-xs text-red-500">{{ collectionsError }}</p>
          </div>

          <!-- Empty -->
          <div v-else-if="collectionsStatus === 'done' && collectionEvents.length === 0" class="flex-1 flex items-center justify-center py-4">
            <p class="text-xs text-gray-400">아직 수집 이력이 없습니다</p>
          </div>

          <!-- Success: 이력 표 -->
          <div v-else class="flex-1 min-h-0 overflow-y-auto">
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
