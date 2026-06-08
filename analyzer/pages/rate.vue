<script setup lang="ts">
// 블라인드 자연스러움 평가 페이지 — 로그인 불필요
// 미들웨어(auth.global.ts)는 /app/* 만 가드하므로 /rate는 별도 설정 없이 통과

definePageMeta({
  layout: false, // 앱 레이아웃(헤더 등) 없이 독립 페이지로 렌더
})

const WORKER_BASE = 'https://naver-searchad-proxy.sbreport.workers.dev'

// ─── 컬러모드 토글 (독립 페이지라 자체 토글 제공) ──────────────────────────────
const colorMode = useColorMode()
function toggleColorMode() {
  colorMode.preference = colorMode.value === 'dark' ? 'light' : 'dark'
}

// ─── 타입 ────────────────────────────────────────────────────────────────────

interface RateItem {
  id: string
  body: string
}

interface RatingEntry {
  item_id: string
  rating: number | null
  note: string
}

// ─── 상태 머신 ────────────────────────────────────────────────────────────────

type Phase = 'input' | 'rating' | 'done' | 'error'
const phase = ref<Phase>('input')

// 입력 화면
const codeInput = ref('')
const nicknameInput = ref('')
const startLoading = ref(false)
const startError = ref<string | null>(null)

// 평가 화면
const pool = ref<string>('')
const items = ref<RateItem[]>([])
const ratings = ref<RatingEntry[]>([])
const noteOpenIds = ref<Set<string>>(new Set())

// 제출
const submitLoading = ref(false)
const submitError = ref<string | null>(null)
const savedCount = ref(0)

// ─── localStorage 닉네임 기억 ─────────────────────────────────────────────────

onMounted(() => {
  const saved = localStorage.getItem('blind_nickname')
  if (saved) nicknameInput.value = saved
})

// ─── 진행률 ──────────────────────────────────────────────────────────────────

const ratedCount = computed(() => ratings.value.filter(r => r.rating !== null).length)
const totalCount = computed(() => items.value.length)
const progressPct = computed(() =>
  totalCount.value > 0 ? Math.round((ratedCount.value / totalCount.value) * 100) : 0
)

// ─── 시작: GET items ──────────────────────────────────────────────────────────

async function start() {
  const code = codeInput.value.trim()
  const nick = nicknameInput.value.trim()
  if (!code || !nick) {
    startError.value = '접근코드와 닉네임을 모두 입력해 주세요.'
    return
  }
  startLoading.value = true
  startError.value = null
  try {
    const res = await fetch(`${WORKER_BASE}/api/blind-test/items?code=${encodeURIComponent(code)}`)
    const data = await res.json() as
      | { pool: string; items: RateItem[] }
      | { error: string }

    if ('error' in data) {
      const msgMap: Record<string, string> = {
        bad_code: '접근코드가 올바르지 않습니다.',
        no_pool: '평가할 항목이 아직 없습니다. 관리자가 풀을 구성한 뒤 다시 시도하세요.',
        not_configured: '관리자 설정이 필요합니다. 관리자에게 문의하세요.',
      }
      startError.value = msgMap[data.error] ?? `오류: ${data.error}`
      return
    }

    localStorage.setItem('blind_nickname', nick)
    pool.value = data.pool
    items.value = data.items
    ratings.value = data.items.map(it => ({ item_id: it.id, rating: null, note: '' }))
    phase.value = 'rating'
  } catch {
    startError.value = '서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.'
  } finally {
    startLoading.value = false
  }
}

// ─── 평가 ────────────────────────────────────────────────────────────────────

function setRating(itemId: string, val: number) {
  const entry = ratings.value.find(r => r.item_id === itemId)
  if (entry) entry.rating = val
}

function toggleNote(itemId: string) {
  const next = new Set(noteOpenIds.value)
  if (next.has(itemId)) next.delete(itemId)
  else next.add(itemId)
  noteOpenIds.value = next
}

// ─── 제출 ────────────────────────────────────────────────────────────────────

async function submit(force = false) {
  const unrated = ratings.value.filter(r => r.rating === null).length
  if (!force && unrated > 0) {
    const ok = confirm(`아직 평가하지 않은 항목이 ${unrated}건 있습니다. 평가한 항목만 제출할까요?`)
    if (!ok) return
  }

  const toSend = ratings.value
    .filter(r => r.rating !== null)
    .map(r => ({ item_id: r.item_id, rating: r.rating as number, ...(r.note.trim() ? { note: r.note.trim() } : {}) }))

  if (toSend.length === 0) {
    submitError.value = '최소 1개 이상 평가해야 제출할 수 있습니다.'
    return
  }

  submitLoading.value = true
  submitError.value = null
  try {
    const res = await fetch(`${WORKER_BASE}/api/blind-test/ratings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: codeInput.value.trim(),
        nickname: nicknameInput.value.trim(),
        ratings: toSend,
      }),
    })
    if (!res.ok) {
      submitError.value = `제출 실패 (${res.status}). 다시 시도해 주세요.`
      return
    }
    const data = await res.json() as { saved: number; skipped: number }
    savedCount.value = data.saved
    phase.value = 'done'
  } catch {
    submitError.value = '서버에 연결할 수 없습니다. 다시 시도해 주세요.'
  } finally {
    submitLoading.value = false
  }
}

// ─── 더 평가하기 ──────────────────────────────────────────────────────────────

async function loadMore() {
  phase.value = 'input'
  // 코드는 유지, 닉네임도 유지. 새 풀로 다시 GET
  await start()
}

// ─── 점수 라벨 ────────────────────────────────────────────────────────────────
const RATING_LABELS: Record<number, { short: string; desc: string }> = {
  1: { short: '1점', desc: 'AI 같음·어색함' },
  2: { short: '2점', desc: '어색한 부분 있음' },
  3: { short: '3점', desc: '보통' },
  4: { short: '4점', desc: '자연스러운 편' },
  5: { short: '5점', desc: '자연스러움·사람 같음' },
}
</script>

<template>
  <div class="h-screen overflow-hidden bg-gray-50 dark:bg-slate-900 flex flex-col">
    <!-- 헤더 -->
    <header class="shrink-0 bg-white dark:bg-slate-800 border-b border-gray-200 dark:border-slate-700 px-4 py-3 flex items-center justify-between gap-3">
      <div class="min-w-0">
        <h1 class="text-sm font-semibold text-gray-800 dark:text-slate-100">후기 자연스러움 평가</h1>
        <p class="text-xs text-gray-400 dark:text-slate-500 mt-0.5">후기가 얼마나 자연스러운지 1~5점으로 평가해 주세요.</p>
      </div>
      <button
        class="shrink-0 flex items-center justify-center w-8 h-8 rounded-md text-slate-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors"
        :title="colorMode.value === 'dark' ? '라이트 모드' : '다크 모드'"
        aria-label="라이트/다크 전환"
        @click="toggleColorMode"
      >
        <UIcon :name="colorMode.value === 'dark' ? 'i-heroicons-sun' : 'i-heroicons-moon'" class="w-4.5 h-4.5" />
      </button>
    </header>

    <main class="flex-1 min-h-0 overflow-y-auto flex flex-col items-center px-4 py-6">

      <!-- ── 입력 화면 ─────────────────────────────────────────── -->
      <div v-if="phase === 'input'" class="w-full max-w-sm flex flex-col gap-4">
        <div class="bg-white dark:bg-slate-800 rounded-lg border border-gray-200 dark:border-slate-700 p-5 flex flex-col gap-4">
          <div class="flex flex-col gap-1.5">
            <label class="text-xs font-medium text-gray-600 dark:text-slate-300">접근코드</label>
            <input
              v-model="codeInput"
              type="text"
              placeholder="관리자에게 받은 코드"
              class="w-full border border-gray-300 dark:border-slate-600 rounded px-3 py-2 text-sm bg-white dark:bg-slate-700 text-gray-800 dark:text-slate-100 placeholder-gray-400 dark:placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-primary-500"
              @keydown.enter="start"
            />
          </div>
          <div class="flex flex-col gap-1.5">
            <label class="text-xs font-medium text-gray-600 dark:text-slate-300">닉네임</label>
            <input
              v-model="nicknameInput"
              type="text"
              placeholder="평가자 이름 또는 닉네임"
              class="w-full border border-gray-300 dark:border-slate-600 rounded px-3 py-2 text-sm bg-white dark:bg-slate-700 text-gray-800 dark:text-slate-100 placeholder-gray-400 dark:placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-primary-500"
              @keydown.enter="start"
            />
          </div>
          <p v-if="startError" class="text-xs text-red-500 dark:text-red-400">{{ startError }}</p>
          <button
            :disabled="startLoading"
            class="w-full bg-primary-600 hover:bg-primary-700 disabled:opacity-50 text-white text-sm font-medium py-2.5 rounded transition-colors"
            @click="start"
          >
            <span v-if="startLoading">불러오는 중...</span>
            <span v-else>시작</span>
          </button>
        </div>
      </div>

      <!-- ── 평가 화면 ─────────────────────────────────────────── -->
      <div v-else-if="phase === 'rating'" class="w-full max-w-2xl flex flex-col gap-4">

        <!-- 진행률 바 -->
        <div class="flex items-center gap-3">
          <div class="flex-1 h-2 bg-gray-200 dark:bg-slate-700 rounded-full overflow-hidden">
            <div
              class="h-full bg-primary-500 rounded-full transition-all duration-300"
              :style="{ width: progressPct + '%' }"
            />
          </div>
          <span class="text-xs tabular-nums text-gray-500 dark:text-slate-400 shrink-0">{{ ratedCount }} / {{ totalCount }}</span>
        </div>

        <!-- 점수 범례 -->
        <div class="bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg px-4 py-3 flex flex-wrap gap-x-4 gap-y-1">
          <span v-for="(lbl, score) in RATING_LABELS" :key="score" class="text-xs text-gray-500 dark:text-slate-400">
            <span class="font-medium text-gray-700 dark:text-slate-300">{{ lbl.short }}</span> — {{ lbl.desc }}
          </span>
        </div>

        <!-- 후기 카드 목록 -->
        <div class="flex flex-col gap-3">
          <div
            v-for="(item, idx) in items"
            :key="item.id"
            class="bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg p-4 flex flex-col gap-3"
          >
            <!-- 번호 + 본문 -->
            <div class="flex gap-2">
              <span class="shrink-0 text-xs tabular-nums text-gray-400 dark:text-slate-500 mt-0.5 w-5 text-right">{{ idx + 1 }}.</span>
              <p class="text-sm text-gray-800 dark:text-slate-100 leading-relaxed flex-1 whitespace-pre-wrap">{{ item.body }}</p>
            </div>

            <!-- 점수 라디오 -->
            <div class="flex gap-2 flex-wrap pl-7">
              <button
                v-for="score in [1, 2, 3, 4, 5]"
                :key="score"
                class="min-w-[44px] px-3 py-2 text-xs font-medium rounded border transition-colors"
                :class="ratings.find(r => r.item_id === item.id)?.rating === score
                  ? 'bg-primary-600 border-primary-600 text-white'
                  : 'bg-white dark:bg-slate-700 border-gray-300 dark:border-slate-600 text-gray-700 dark:text-slate-300 hover:border-primary-400 hover:text-primary-600'"
                @click="setRating(item.id, score)"
              >
                {{ score }}
              </button>
              <!-- 선택된 점수 라벨 -->
              <span
                v-if="ratings.find(r => r.item_id === item.id)?.rating"
                class="text-xs text-primary-600 dark:text-primary-400 self-center"
              >
                {{ RATING_LABELS[ratings.find(r => r.item_id === item.id)!.rating!]?.desc }}
              </span>
            </div>

            <!-- 메모 (접기/펼치기) -->
            <div class="pl-7">
              <button
                class="text-xs text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300 transition-colors"
                @click="toggleNote(item.id)"
              >
                {{ noteOpenIds.has(item.id) ? '메모 접기' : '메모 추가 (선택)' }}
              </button>
              <textarea
                v-if="noteOpenIds.has(item.id)"
                v-model="ratings.find(r => r.item_id === item.id)!.note"
                rows="2"
                placeholder="특이사항 메모 (선택)"
                class="mt-1.5 w-full border border-gray-200 dark:border-slate-600 rounded px-2.5 py-1.5 text-xs bg-white dark:bg-slate-700 text-gray-700 dark:text-slate-200 placeholder-gray-400 dark:placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-primary-400 resize-none"
              />
            </div>
          </div>
        </div>

        <!-- 제출 -->
        <div class="flex flex-col gap-2 pb-6">
          <p v-if="submitError" class="text-xs text-red-500 dark:text-red-400">{{ submitError }}</p>
          <button
            :disabled="submitLoading"
            class="w-full bg-primary-600 hover:bg-primary-700 disabled:opacity-50 text-white text-sm font-medium py-3 rounded-lg transition-colors"
            @click="submit(false)"
          >
            <span v-if="submitLoading">제출 중...</span>
            <span v-else>제출 ({{ ratedCount }}건 평가 완료)</span>
          </button>
          <p class="text-xs text-center text-gray-400 dark:text-slate-500">
            미평가 항목이 있어도 제출 가능합니다.
          </p>
        </div>
      </div>

      <!-- ── 완료 화면 ─────────────────────────────────────────── -->
      <div v-else-if="phase === 'done'" class="w-full max-w-sm flex flex-col gap-4">
        <div class="bg-white dark:bg-slate-800 rounded-lg border border-gray-200 dark:border-slate-700 p-6 flex flex-col items-center gap-4 text-center">
          <div class="w-12 h-12 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
            <svg class="w-6 h-6 text-green-600 dark:text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <div>
            <p class="text-sm font-semibold text-gray-800 dark:text-slate-100">평가 제출 완료</p>
            <p class="text-xs text-gray-500 dark:text-slate-400 mt-1">{{ savedCount }}건이 저장되었습니다. 감사합니다!</p>
          </div>
          <button
            class="w-full bg-gray-100 dark:bg-slate-700 hover:bg-gray-200 dark:hover:bg-slate-600 text-gray-700 dark:text-slate-300 text-sm font-medium py-2.5 rounded transition-colors"
            @click="loadMore"
          >
            더 평가하기
          </button>
        </div>
      </div>

    </main>
  </div>
</template>
