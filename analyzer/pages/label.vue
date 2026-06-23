<script setup lang="ts">
// IAA 라벨링 페이지 — 로그인 불필요
// 미들웨어(auth.global.ts)는 /app/* 만 가드하므로 /label은 별도 설정 없이 통과

definePageMeta({
  layout: false,
})

const WORKER_BASE = 'https://naver-searchad-proxy.sbreport.workers.dev'

// ─── 컬러모드 토글 ────────────────────────────────────────────────────────────
const colorMode = useColorMode()
function toggleColorMode() {
  colorMode.preference = colorMode.value === 'dark' ? 'light' : 'dark'
}

// ─── 타입 ─────────────────────────────────────────────────────────────────────

type LabelValue = 'genuine' | 'ad' | 'ai' | 'unsure'

interface IaaItem {
  review_id: string
  body: string
}

interface LabelEntry {
  review_id: string
  label: LabelValue | null
  note: string
}

// ─── 상태 머신 ────────────────────────────────────────────────────────────────

type Phase = 'input' | 'labeling' | 'done' | 'error'
const phase = ref<Phase>('input')

// 입력 화면
const codeInput = ref('')
const nicknameInput = ref('')
const startLoading = ref(false)
const startError = ref<string | null>(null)

// 라벨링 화면
const setId = ref<string>('')
const items = ref<IaaItem[]>([])
const labels = ref<LabelEntry[]>([])
const noteOpenIds = ref<Set<string>>(new Set())

// 제출
const submitLoading = ref(false)
const submitError = ref<string | null>(null)
const savedCount = ref(0)

// ─── 4분류 정의 ───────────────────────────────────────────────────────────────

interface LabelDef {
  value: LabelValue
  name: string
  hint: string
  colorClass: string
  selectedClass: string
}

const LABEL_DEFS: LabelDef[] = [
  {
    value: 'genuine',
    name: '진짜손님',
    hint: '구체 수치·부위·개인상황·불완전성·군말',
    colorClass: 'border-gray-300 dark:border-slate-600 text-gray-700 dark:text-slate-300 hover:border-emerald-400 hover:text-emerald-600',
    selectedClass: 'bg-emerald-600 border-emerald-600 text-white',
  },
  {
    value: 'ad',
    name: '사람마케팅',
    hint: '지역+추천 유도, 담당자 실명, 광고 말투',
    colorClass: 'border-gray-300 dark:border-slate-600 text-gray-700 dark:text-slate-300 hover:border-amber-400 hover:text-amber-600',
    selectedClass: 'bg-amber-500 border-amber-500 text-white',
  },
  {
    value: 'ai',
    name: 'AI조립',
    hint: '구체경험 없음, 일반 칭찬 틀 반복, 정갈함',
    colorClass: 'border-gray-300 dark:border-slate-600 text-gray-700 dark:text-slate-300 hover:border-violet-400 hover:text-violet-600',
    selectedClass: 'bg-violet-600 border-violet-600 text-white',
  },
  {
    value: 'unsure',
    name: '모름',
    hint: '신호 부족·상충',
    colorClass: 'border-gray-300 dark:border-slate-600 text-gray-700 dark:text-slate-300 hover:border-gray-400 hover:text-gray-600',
    selectedClass: 'bg-gray-500 border-gray-500 text-white',
  },
]

// ─── localStorage 닉네임 기억 ─────────────────────────────────────────────────

onMounted(() => {
  const saved = localStorage.getItem('iaa_nickname')
  if (saved) nicknameInput.value = saved
})

// ─── 진행률 ──────────────────────────────────────────────────────────────────

const labeledCount = computed(() => labels.value.filter(l => l.label !== null).length)
const totalCount = computed(() => items.value.length)
const progressPct = computed(() =>
  totalCount.value > 0 ? Math.round((labeledCount.value / totalCount.value) * 100) : 0
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
    // set 파라미터 비워서 최근 세트
    const res = await fetch(
      `${WORKER_BASE}/api/iaa/items?code=${encodeURIComponent(code)}&set=`
    )
    const data = await res.json() as
      | { set_id: string; items: IaaItem[] }
      | { error: string }

    if ('error' in data) {
      const msgMap: Record<string, string> = {
        bad_code: '접근코드가 올바르지 않습니다.',
        no_pool: '평가할 세트가 아직 없습니다. 관리자가 세트를 구성한 뒤 다시 시도하세요.',
        not_configured: '관리자 설정이 필요합니다. 관리자에게 문의하세요.',
      }
      startError.value = msgMap[data.error] ?? `오류: ${data.error}`
      return
    }

    localStorage.setItem('iaa_nickname', nick)
    setId.value = data.set_id
    items.value = data.items
    labels.value = data.items.map(it => ({ review_id: it.review_id, label: null, note: '' }))
    phase.value = 'labeling'
  } catch {
    startError.value = '서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.'
  } finally {
    startLoading.value = false
  }
}

// ─── 라벨 선택 ────────────────────────────────────────────────────────────────

function setLabel(reviewId: string, val: LabelValue) {
  const entry = labels.value.find(l => l.review_id === reviewId)
  if (entry) {
    // 같은 라벨 재클릭 시 해제
    entry.label = entry.label === val ? null : val
  }
}

function getEntry(reviewId: string): LabelEntry | undefined {
  return labels.value.find(l => l.review_id === reviewId)
}

function toggleNote(reviewId: string) {
  const next = new Set(noteOpenIds.value)
  if (next.has(reviewId)) next.delete(reviewId)
  else next.add(reviewId)
  noteOpenIds.value = next
}

// ─── 제출 ────────────────────────────────────────────────────────────────────

async function submit(force = false) {
  const unlabeled = labels.value.filter(l => l.label === null).length
  if (!force && unlabeled > 0) {
    const ok = confirm(
      `아직 분류하지 않은 항목이 ${unlabeled}건 있습니다. 분류한 항목만 제출할까요?`
    )
    if (!ok) return
  }

  const toSend = labels.value
    .filter(l => l.label !== null)
    .map(l => ({
      review_id: l.review_id,
      label: l.label as LabelValue,
      ...(l.note.trim() ? { note: l.note.trim() } : {}),
    }))

  if (toSend.length === 0) {
    submitError.value = '최소 1개 이상 분류해야 제출할 수 있습니다.'
    return
  }

  submitLoading.value = true
  submitError.value = null
  try {
    const res = await fetch(`${WORKER_BASE}/api/iaa/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: codeInput.value.trim(),
        nickname: nicknameInput.value.trim(),
        set: setId.value,
        labels: toSend,
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

// ─── 더 하기 ─────────────────────────────────────────────────────────────────

function restart() {
  phase.value = 'input'
  setId.value = ''
  items.value = []
  labels.value = []
  noteOpenIds.value = new Set()
  submitError.value = null
}
</script>

<template>
  <div class="h-screen overflow-hidden bg-gray-50 dark:bg-slate-900 flex flex-col">
    <!-- 헤더 -->
    <header class="shrink-0 bg-white dark:bg-slate-800 border-b border-gray-200 dark:border-slate-700 px-4 py-3 flex items-center justify-between gap-3">
      <div class="min-w-0">
        <h1 class="text-sm font-semibold text-gray-800 dark:text-slate-100">후기 분류 라벨링</h1>
        <p class="text-xs text-gray-400 dark:text-slate-500 mt-0.5">각 후기를 4가지 유형 중 하나로 분류해 주세요.</p>
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

        <!-- 코드북 범례 (입력 화면에도 표시) -->
        <div class="bg-white dark:bg-slate-800 rounded-lg border border-gray-200 dark:border-slate-700 p-4 flex flex-col gap-2">
          <p class="text-xs font-semibold text-gray-600 dark:text-slate-300">분류 기준</p>
          <div v-for="def in LABEL_DEFS" :key="def.value" class="flex items-start gap-2">
            <span class="text-xs font-medium text-gray-700 dark:text-slate-300 shrink-0 w-20">{{ def.name }}</span>
            <span class="text-xs text-gray-400 dark:text-slate-500 leading-snug">{{ def.hint }}</span>
          </div>
        </div>
      </div>

      <!-- ── 라벨링 화면 ─────────────────────────────────────────── -->
      <div v-else-if="phase === 'labeling'" class="w-full max-w-2xl flex flex-col gap-4">

        <!-- 진행률 바 -->
        <div class="flex items-center gap-3">
          <div class="flex-1 h-2 bg-gray-200 dark:bg-slate-700 rounded-full overflow-hidden">
            <div
              class="h-full bg-primary-500 rounded-full transition-all duration-300"
              :style="{ width: progressPct + '%' }"
            />
          </div>
          <span class="text-xs tabular-nums text-gray-500 dark:text-slate-400 shrink-0">{{ labeledCount }} / {{ totalCount }}</span>
        </div>

        <!-- 범례 (간결) -->
        <div class="bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg px-4 py-2.5 flex flex-wrap gap-x-4 gap-y-1">
          <div v-for="def in LABEL_DEFS" :key="def.value" class="flex items-center gap-1.5">
            <span class="text-xs font-medium text-gray-700 dark:text-slate-300">{{ def.name }}</span>
            <span class="text-xs text-gray-400 dark:text-slate-500">— {{ def.hint }}</span>
          </div>
        </div>

        <!-- 후기 카드 목록 -->
        <div class="flex flex-col gap-3">
          <div
            v-for="(item, idx) in items"
            :key="item.review_id"
            class="bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg p-4 flex flex-col gap-3"
            :class="getEntry(item.review_id)?.label ? 'border-l-4' : ''"
            :style="getEntry(item.review_id)?.label
              ? {
                  borderLeftColor:
                    getEntry(item.review_id)?.label === 'genuine' ? 'rgb(5 150 105)' :
                    getEntry(item.review_id)?.label === 'ad' ? 'rgb(245 158 11)' :
                    getEntry(item.review_id)?.label === 'ai' ? 'rgb(124 58 237)' :
                    'rgb(107 114 128)'
                }
              : {}"
          >
            <!-- 번호 + 본문 -->
            <div class="flex gap-2">
              <span class="shrink-0 text-xs tabular-nums text-gray-400 dark:text-slate-500 mt-0.5 w-5 text-right">{{ idx + 1 }}.</span>
              <p class="text-sm text-gray-800 dark:text-slate-100 leading-relaxed flex-1 whitespace-pre-wrap">{{ item.body }}</p>
            </div>

            <!-- 4분류 버튼 -->
            <div class="flex gap-2 flex-wrap pl-7">
              <button
                v-for="def in LABEL_DEFS"
                :key="def.value"
                class="px-3 py-1.5 text-xs font-medium rounded border transition-colors"
                :class="getEntry(item.review_id)?.label === def.value
                  ? def.selectedClass
                  : `bg-white dark:bg-slate-700 ${def.colorClass}`"
                @click="setLabel(item.review_id, def.value)"
              >
                {{ def.name }}
              </button>
            </div>

            <!-- 메모 (접기/펼치기) -->
            <div class="pl-7">
              <button
                class="text-xs text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300 transition-colors"
                @click="toggleNote(item.review_id)"
              >
                {{ noteOpenIds.has(item.review_id) ? '메모 접기' : '메모 추가 (선택)' }}
              </button>
              <textarea
                v-if="noteOpenIds.has(item.review_id)"
                v-model="getEntry(item.review_id)!.note"
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
            <span v-else>제출 ({{ labeledCount }}건 분류 완료)</span>
          </button>
          <p class="text-xs text-center text-gray-400 dark:text-slate-500">
            미분류 항목이 있어도 제출 가능합니다.
          </p>
        </div>
      </div>

      <!-- ── 완료 화면 ─────────────────────────────────────────── -->
      <div v-else-if="phase === 'done'" class="w-full max-w-sm flex flex-col gap-4">
        <div class="bg-white dark:bg-slate-800 rounded-lg border border-gray-200 dark:border-slate-700 p-5 flex flex-col gap-3 text-center">
          <UIcon name="i-heroicons-check-circle" class="w-8 h-8 text-emerald-500 mx-auto" />
          <p class="text-sm font-semibold text-gray-800 dark:text-slate-100">
            {{ savedCount }}개 라벨 저장됨
          </p>
          <p class="text-xs text-gray-400 dark:text-slate-500">감사합니다. 라벨링이 완료되었습니다.</p>
        </div>
        <button
          class="w-full bg-gray-100 dark:bg-slate-700 hover:bg-gray-200 dark:hover:bg-slate-600 text-gray-700 dark:text-slate-300 text-sm font-medium py-2.5 rounded transition-colors"
          @click="restart"
        >
          더 하기
        </button>
      </div>

    </main>
  </div>
</template>
