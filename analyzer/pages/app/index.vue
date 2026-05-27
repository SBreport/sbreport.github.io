<script setup lang="ts">
import { WORKER_BASE } from '~/composables/useWorkerBase'

definePageMeta({
  layout: 'default',
})

// ─── 인증 ─────────────────────────────────────────────────────────────────────

const authStore = useAuthStore()

// ─── Block 1: 이용 현황 ────────────────────────────────────────────────────────

const planLabel = computed(() => {
  const p = authStore.user?.plan
  if (p === 'pro') return 'Pro'
  return '무료'
})

const expiresLabel = computed(() => {
  const exp = authStore.user?.plan_expires_at
  if (!exp) return '무기한'
  const dateStr = exp.slice(0, 10)
  const days = Math.ceil((new Date(exp).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
  const dayStr = days <= 0 ? '(만료)' : `(D-${days})`
  return `~${dateStr} ${dayStr}`
})

// ─── Block 2: 키워드 검색 ─────────────────────────────────────────────────────

const searchInput = ref('')

function goSearch() {
  const q = searchInput.value.trim()
  if (!q) return
  navigateTo('/app/search?q=' + encodeURIComponent(q))
}

// ─── Block 4: 최근 분석한 키워드 ──────────────────────────────────────────────

interface HistoryItem {
  id: string
  keyword: string
  pc_volume: number | null
  mobile_volume: number | null
  competition: string | null
  created_at: string
}

type HistoryState = 'loading' | 'empty' | 'error' | 'done'

const historyState = ref<HistoryState>('loading')
const historyItems = ref<HistoryItem[]>([])
const historyError = ref('')

async function fetchHistory() {
  historyState.value = 'loading'
  historyError.value = ''
  try {
    const res = await fetch(`${WORKER_BASE}/api/history?limit=5`, {
      headers: authStore.token ? { Authorization: `Bearer ${authStore.token}` } : {},
    })
    if (!res.ok) {
      historyError.value = `오류 ${res.status}`
      historyState.value = 'error'
      return
    }
    const data = await res.json() as { history: HistoryItem[] }
    historyItems.value = data.history ?? []
    historyState.value = historyItems.value.length === 0 ? 'empty' : 'done'
  } catch (e: unknown) {
    historyError.value = e instanceof Error ? e.message : '알 수 없는 오류'
    historyState.value = 'error'
  }
}

function formatNumber(n: number | null | undefined): string {
  if (n == null) return '-'
  return n.toLocaleString('ko-KR')
}

function relativeTime(isoStr: string): string {
  const diff = Date.now() - new Date(isoStr).getTime()
  const min = Math.floor(diff / (1000 * 60))
  const hour = Math.floor(diff / (1000 * 60 * 60))
  const day = Math.floor(diff / (1000 * 60 * 60 * 24))
  if (min < 1) return '방금'
  if (min < 60) return `${min}분 전`
  if (hour < 24) return `${hour}시간 전`
  if (day === 1) return '어제'
  if (day < 7) return `${day}일 전`
  return isoStr.slice(0, 10)
}

onMounted(fetchHistory)
</script>

<template>
  <div class="h-full flex flex-col gap-4 max-w-6xl">

    <h1 class="shrink-0 text-lg font-semibold text-gray-900">홈</h1>

    <div class="flex flex-row gap-4">

      <!-- 메인 -->
      <div class="flex-1 min-w-0 flex flex-col gap-4">

        <!-- Block 2: 키워드 검색 -->
        <div class="rounded-lg border border-gray-200 p-4 flex flex-col gap-3">
          <div class="flex items-center gap-1.5">
            <UIcon name="i-heroicons-magnifying-glass" class="w-4 h-4 text-gray-600 shrink-0" />
            <span class="text-sm font-medium text-gray-900">키워드 검색</span>
          </div>
          <div class="flex items-center gap-2">
            <UInput
              v-model="searchInput"
              placeholder="키워드 입력"
              class="flex-1 text-sm"
              @keydown.enter="goSearch"
            />
            <UButton
              label="분석하기"
              size="sm"
              class="shrink-0 h-9"
              :disabled="searchInput.trim().length === 0"
              @click="goSearch"
            />
          </div>
        </div>

        <!-- Block 4: 최근 분석한 키워드 -->
        <div class="rounded-lg border border-gray-200 p-4 flex flex-col gap-3">
          <span class="text-sm font-medium text-gray-900">최근 분석한 키워드</span>

          <!-- Loading -->
          <div v-if="historyState === 'loading'" class="flex flex-col gap-2">
            <USkeleton v-for="i in 3" :key="i" class="h-8 w-full rounded" />
          </div>

          <!-- Empty -->
          <div v-else-if="historyState === 'empty'" class="flex flex-col items-center gap-3 py-4">
            <UEmptyState
              icon="i-heroicons-clock"
              title="아직 분석한 키워드가 없습니다"
              description="키워드 검색에서 분석을 시작해 보세요."
            />
            <UButton
              label="키워드 검색하러 가기"
              size="sm"
              variant="outline"
              @click="navigateTo('/app/search')"
            />
          </div>

          <!-- Error -->
          <div v-else-if="historyState === 'error'" class="flex flex-col gap-2">
            <UAlert color="error" :description="historyError || '히스토리를 불러오지 못했습니다.'" />
            <div>
              <UButton label="재시도" size="sm" variant="outline" @click="fetchHistory" />
            </div>
          </div>

          <!-- Done -->
          <div v-else class="flex flex-col divide-y divide-gray-100">
            <button
              v-for="item in historyItems"
              :key="item.id"
              class="flex items-center gap-3 py-2 text-sm text-left hover:bg-gray-50 rounded px-2 transition-colors"
              @click="navigateTo('/app/search?q=' + encodeURIComponent(item.keyword))"
            >
              <span class="flex-1 font-medium text-gray-900 truncate">{{ item.keyword }}</span>
              <span class="tabular-nums text-gray-600 shrink-0 text-xs">
                {{ formatNumber(item.pc_volume) }} + {{ formatNumber(item.mobile_volume) }}
              </span>
              <span class="text-xs text-gray-400 shrink-0 w-14 text-right">{{ relativeTime(item.created_at) }}</span>
            </button>
          </div>
        </div>

      </div>

      <!-- 사이드 -->
      <aside class="w-80 shrink-0 flex flex-col gap-4">

        <!-- Block 1: 이용 현황 -->
        <div class="rounded-lg border border-gray-200 p-4 flex flex-col gap-1">
          <span class="text-xs text-gray-500">플랜</span>
          <span class="text-sm font-medium text-gray-900">{{ planLabel }}</span>
          <span class="text-xs text-gray-500 mt-2">이용 기간</span>
          <span class="text-sm text-gray-700">{{ expiresLabel }}</span>
        </div>

        <!-- Block 3: 순위 추적 -->
        <div class="rounded-lg border border-gray-200 p-4 flex flex-col gap-3">
          <div class="flex items-center gap-1.5">
            <UIcon name="i-heroicons-chart-bar" class="w-4 h-4 text-gray-600 shrink-0" />
            <span class="text-sm font-medium text-gray-900">순위 추적</span>
          </div>
          <p class="text-xs text-gray-500">내 글 순위 추적</p>
          <div>
            <UButton
              label="바로가기 →"
              variant="outline"
              size="sm"
              @click="navigateTo('/app/tracking')"
            />
          </div>
        </div>

        <!-- Block 5: 확장 프로그램 -->
        <div class="rounded-lg border border-gray-200 p-4 flex flex-col gap-3">
          <div class="flex items-center gap-1.5">
            <UIcon name="i-heroicons-puzzle-piece" class="w-4 h-4 text-gray-600 shrink-0" />
            <span class="text-sm font-medium text-gray-900">스마트 브랜딩 서포터 (확장)</span>
          </div>
          <p class="text-xs text-gray-500">네이버 검색 페이지 위에서 동작하는 확장 프로그램</p>
          <div>
            <UButton
              label="다운로드 안내 →"
              variant="outline"
              size="sm"
              as="a"
              href="https://sbsupport.netlify.app/"
              target="_blank"
              rel="noopener"
            />
          </div>
        </div>

        <!-- Block 6: 문의 -->
        <div class="rounded-lg border border-gray-200 p-4 flex flex-col gap-3">
          <div class="flex items-center gap-1.5">
            <UIcon name="i-heroicons-chat-bubble-left-right" class="w-4 h-4 text-gray-600 shrink-0" />
            <span class="text-sm font-medium text-gray-900">문의</span>
          </div>
          <p class="text-xs text-gray-500">카카오톡 채널로 빠르게 문의해 주세요</p>
          <div>
            <UButton
              label="카카오톡 채널 →"
              variant="outline"
              size="sm"
              as="a"
              href="http://pf.kakao.com/_mCQGG/chat"
              target="_blank"
              rel="noopener"
            />
          </div>
        </div>

      </aside>

    </div>

  </div>
</template>
