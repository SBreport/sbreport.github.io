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
}

interface CollectionEvent {
  id: string
  source: 'cron' | 'manual'
  inserted: number
  skipped: number
  pages_fetched: number
  total_server: number | null
  blocked: number
  error: string | null
  collected_at: string
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
  selectedPlace.value = place
  currentPage.value = 1
  collectToast.value = null
  fetchReviews(place.id)
  fetchCollections(place.id)
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

// ─── CSV 내보내기 ─────────────────────────────────────────────────────────────

function exportCsv() {
  if (!selectedPlace.value || reviews.value.length === 0) return

  const headers = ['작성일', '작성자', '본문', '방문일', '답글여부', '사진여부']

  const escape = (v: string | number | null | undefined): string => {
    const s = String(v ?? '')
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s
  }

  const csvLines = [headers.join(',')]
  for (const r of reviews.value) {
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
}

// ─── 초기 로드 ────────────────────────────────────────────────────────────────

onMounted(() => {
  fetchPlaces()
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

    <!-- ── 본문 2열: 플레이스 목록 + 우측 패널 ──────────────────────── -->
    <div class="flex-1 min-h-0 flex gap-3">

      <!-- 좌측: 플레이스 목록 (고정 너비) -->
      <div class="w-56 shrink-0 flex flex-col border border-gray-200 rounded-lg overflow-hidden">
        <!-- 좌측 헤더 -->
        <div class="shrink-0 flex items-center justify-between px-3 py-2 border-b border-gray-200 bg-gray-50">
          <span class="text-xs font-medium text-gray-600">플레이스 목록</span>
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
            class="px-3 py-2.5 cursor-pointer transition-colors"
            :class="selectedPlace?.id === place.id
              ? 'bg-primary-50 text-primary-700'
              : 'hover:bg-gray-50 text-gray-700'"
            @click="selectPlace(place)"
          >
            <p class="text-sm font-medium leading-snug truncate">{{ placeName(place) }}</p>
            <div class="flex items-center gap-2 mt-0.5">
              <span class="text-xs text-gray-400 tabular-nums">
                리뷰 {{ place.total_reviews != null ? place.total_reviews.toLocaleString('ko-KR') : '—' }}
              </span>
              <span class="text-xs text-gray-300">·</span>
              <span class="text-xs text-gray-400">{{ formatDate(place.last_collected_at) }}</span>
            </div>
          </li>
        </ul>
      </div>

      <!-- 우측: 리뷰 표 + 수집 이력 (상하 분할) -->
      <div class="flex-1 min-h-0 flex flex-col gap-3">

        <!-- 우측 상단: 리뷰 표 -->
        <div class="flex-1 min-h-0 flex flex-col border border-gray-200 rounded-lg overflow-hidden">

          <!-- 헤더 -->
          <div class="shrink-0 flex items-center justify-between px-3 py-2 border-b border-gray-200 bg-gray-50">
            <span class="text-xs font-medium text-gray-600">
              <template v-if="selectedPlace">
                {{ placeName(selectedPlace) }}
                <span v-if="reviewsStatus === 'done'" class="font-normal text-gray-400 ml-1">
                  총 {{ reviewsTotal.toLocaleString('ko-KR') }}건
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
                @click="collectNow"
              />
              <UButton
                v-if="reviewsStatus === 'done' && reviews.length > 0"
                label="CSV"
                size="xs"
                color="neutral"
                variant="outline"
                icon="i-heroicons-arrow-down-tray"
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
                  <tr class="h-10">
                    <th class="px-3 text-left font-medium text-gray-600 text-xs whitespace-nowrap border-b border-gray-200 w-24">작성일</th>
                    <th class="px-3 text-left font-medium text-gray-600 text-xs whitespace-nowrap border-b border-gray-200 w-24">작성자</th>
                    <th class="px-3 text-left font-medium text-gray-600 text-xs border-b border-gray-200">본문</th>
                    <th class="px-3 text-center font-medium text-gray-600 text-xs whitespace-nowrap border-b border-gray-200 w-16">답글</th>
                    <th class="px-3 text-center font-medium text-gray-600 text-xs whitespace-nowrap border-b border-gray-200 w-12">사진</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="review in reviews"
                    :key="review.id"
                    class="border-b border-gray-100 last:border-0 hover:bg-gray-50 transition-colors"
                  >
                    <!-- 작성일 -->
                    <td class="px-3 py-2 align-top whitespace-nowrap text-xs text-gray-500">
                      {{ formatDate(review.review_created_at) }}
                    </td>
                    <!-- 작성자 -->
                    <td class="px-3 py-2 align-top whitespace-nowrap text-xs text-gray-700 max-w-[6rem] truncate">
                      {{ review.author_nick || '—' }}
                    </td>
                    <!-- 본문 -->
                    <td class="px-3 py-2 align-top text-xs text-gray-800 leading-relaxed">
                      {{ review.body || '—' }}
                    </td>
                    <!-- 답글여부 -->
                    <td class="px-3 py-2 align-top text-center text-xs text-gray-500 whitespace-nowrap">
                      {{ review.owner_reply ? '있음' : '' }}
                    </td>
                    <!-- 사진여부 -->
                    <td class="px-3 py-2 align-top text-center text-sm text-gray-500 whitespace-nowrap">
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

        <!-- 우측 하단: 수집 이력 패널 (선택 플레이스 있을 때만) -->
        <div
          v-if="selectedPlace"
          class="shrink-0 flex flex-col border border-gray-200 rounded-lg overflow-hidden"
          style="max-height: 220px;"
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
                  <th class="px-3 py-1.5 text-left font-medium text-gray-500 whitespace-nowrap border-b border-gray-200 w-14">구분</th>
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
                  <td class="px-3 py-1.5">
                    <span
                      class="inline-block px-1.5 py-0.5 rounded text-xs font-medium"
                      :class="ev.source === 'cron'
                        ? 'bg-gray-100 text-gray-600'
                        : 'bg-blue-50 text-blue-600'"
                    >
                      {{ ev.source === 'cron' ? '자동' : '수동' }}
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
</template>
