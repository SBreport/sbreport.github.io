<script setup lang="ts">
// 키워드 검색 페이지: default 레이아웃 (기획서 6.2, 부록 C.5)
definePageMeta({
  layout: 'default',
})

// ─── 타입 ───────────────────────────────────────────────────────────────────

interface Section {
  order: number
  type: string
  label: string
  count: number | null
}

interface RelatedKeyword {
  keyword: string
  total: number
}

interface SearchResult {
  keyword: string
  pc_volume: number | null
  mobile_volume: number | null
  total: number | null
  competition: string | null
  related_keywords: RelatedKeyword[]
  sections: Section[]
  pc_sections?: Section[]
}

type RowStatus = 'pending' | 'loading' | 'done' | 'error'
type RowSource = 'seed' | 'autocomplete' | 'related'

interface Row {
  keyword: string
  status: RowStatus
  result: SearchResult | null
  error: string | null
  source: RowSource
}

// ─── 상태 ────────────────────────────────────────────────────────────────────

// 인증된 사용자만 Worker /api/search 호출 가능 (Authorization Bearer 헤더)
const authStore = useAuthStore()

const inputText = ref('')
const rows = ref<Row[]>([])
const isAnalyzing = ref(false)

type ViewMode = 'mobile' | 'pc' | 'both'

const VIEW_MODE_OPTIONS: { value: ViewMode; label: string }[] = [
  { value: 'mobile', label: '모바일' },
  { value: 'pc', label: 'PC' },
  { value: 'both', label: '둘 다' },
]

const viewMode = ref<ViewMode>('mobile')

type SortKey = 'keyword' | 'source' | 'total' | 'competition'
type SortDir = 'asc' | 'desc'

const sortKey = ref<SortKey | null>(null)
const sortDir = ref<SortDir>('desc')

function handleSort(key: SortKey) {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'desc' ? 'asc' : 'desc'
  } else {
    sortKey.value = key
    sortDir.value = 'desc'
  }
}

watch(viewMode, (val) => {
  if (typeof window !== 'undefined') localStorage.setItem('sb_serp_view', val)
})

const optAutocomplete = ref(false)
const optRelated = ref(false)
const optExpand = computed(() => optAutocomplete.value || optRelated.value)

// 슬라이드 패널
const slideoverOpen = ref(false)
const selectedRow = ref<Row | null>(null)

// ─── Worker 엔드포인트 ────────────────────────────────────────────────────────

const WORKER_URL = 'https://naver-searchad-proxy.sbreport.workers.dev/api/search'
const EXPAND_URL = 'https://naver-searchad-proxy.sbreport.workers.dev/api/expand'

// 403 pending_approval 감지 시 /pending으로 이동
const pendingRedirectShown = ref(false)

// ─── 헬퍼 ────────────────────────────────────────────────────────────────────

function parseKeywords(text: string): string[] {
  return text
    .split('\n')
    .map(k => k.trim())
    .filter(k => k.length > 0)
}

function formatNumber(n: number | null | undefined): string {
  if (n == null) return '-'
  return n.toLocaleString('ko-KR')
}

function competitionLabel(c: string | null): string {
  if (!c) return '-'
  const map: Record<string, string> = {
    HIGH: '높음',
    MIDDLE: '중간',
    LOW: '낮음',
    높음: '높음',
    중간: '중간',
    낮음: '낮음',
  }
  return map[c] ?? c
}

/** SERP 순서 번호를 ①②③… 형태로 변환 (1~20 범위) */
function circledNumber(n: number): string {
  const circles = ['①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩',
                   '⑪','⑫','⑬','⑭','⑮','⑯','⑰','⑱','⑲','⑳']
  return circles[n - 1] ?? `(${n})`
}

/** 섹션 type → Tailwind 색상 클래스 */
function sectionColorClass(type: string): string {
  const map: Record<string, string> = {
    powerlink:     'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
    place:         'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
    blog:          'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
    kin:           'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
    cafe:          'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
    influencer:    'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400',
    powercontents: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
    video:         'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
    clip:          'bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-900/30 dark:text-fuchsia-400',
    ai_briefing:   'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400',
    popular_article: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
    ugc:           'bg-lime-100 text-lime-700 dark:bg-lime-900/30 dark:text-lime-400',
    ugc_snippet:   'bg-lime-100 text-lime-700 dark:bg-lime-900/30 dark:text-lime-400',
    shortents:     'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400',
    news:          'bg-gray-100 text-gray-600 dark:bg-slate-700 dark:text-slate-300',
    web:           'bg-gray-100 text-gray-600 dark:bg-slate-700 dark:text-slate-300',
    qra:           'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
  }
  return map[type] ?? 'bg-gray-100 text-gray-500 dark:bg-slate-700 dark:text-slate-400'
}

// ─── 분석 실행 ───────────────────────────────────────────────────────────────

async function runAnalysis() {
  const seeds = parseKeywords(inputText.value)
  if (seeds.length === 0) return

  isAnalyzing.value = true

  let allKeywords: Array<{ keyword: string, source: RowSource }> = []

  if (optExpand.value) {
    const expandController = new AbortController()
    const expandTimeoutId = setTimeout(() => expandController.abort(), 20_000)

    const expandPromises = seeds.map(seed => fetchExpand(seed, {
      autocomplete: optAutocomplete.value,
      related: optRelated.value,
    }, expandController.signal))

    const expandResults = await Promise.allSettled(expandPromises)
    clearTimeout(expandTimeoutId)

    const seen = new Set<string>()
    for (const seed of seeds) {
      if (!seen.has(seed)) {
        seen.add(seed)
        allKeywords.push({ keyword: seed, source: 'seed' })
      }
    }
    for (let i = 0; i < expandResults.length; i++) {
      const res = expandResults[i]
      if (res.status !== 'fulfilled' || !res.value) continue
      for (const item of res.value.keywords) {
        if (!seen.has(item.keyword)) {
          seen.add(item.keyword)
          allKeywords.push({ keyword: item.keyword, source: item.source })
        }
      }
    }

    if (allKeywords.length > 50) {
      allKeywords = allKeywords.slice(0, 50)
    }
  } else {
    allKeywords = seeds.map(kw => ({ keyword: kw, source: 'seed' as RowSource }))
  }

  const newKeywords = allKeywords.map(k => k.keyword)
  rows.value = rows.value.filter(r => !newKeywords.includes(r.keyword))

  const startIdx = rows.value.length
  for (const item of allKeywords) {
    rows.value.push({
      keyword: item.keyword,
      status: 'loading' as RowStatus,
      result: null,
      error: null,
      source: item.source,
    })
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 30_000)

  const promises = allKeywords.map((item, i) =>
    fetchKeyword(item.keyword, startIdx + i, controller.signal)
  )

  await Promise.allSettled(promises)
  clearTimeout(timeoutId)

  isAnalyzing.value = false
}

async function fetchKeyword(keyword: string, idx: number, signal: AbortSignal) {
  try {
    const res = await fetch(WORKER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authStore.token ? { Authorization: `Bearer ${authStore.token}` } : {}),
      },
      body: JSON.stringify({ keyword }),
      signal,
    })

    if (!res.ok) {
      let message = `오류 ${res.status}`
      let errorCode = ''
      try {
        const body = await res.json() as { error?: string, message?: string }
        if (body.error) errorCode = body.error
        if (body.message) message = body.message
      } catch { /* ignore */ }

      // 403 pending_approval: 미들웨어가 놓친 경우 (직접 URL 진입 등) → /pending 이동
      if (res.status === 403 && errorCode === 'pending_approval') {
        if (!pendingRedirectShown.value) {
          pendingRedirectShown.value = true
          navigateTo('/pending', { replace: true })
        }
        return
      }

      rows.value[idx] = { keyword, status: 'error', result: null, error: message, source: rows.value[idx].source }
      return
    }

    const data = await res.json() as SearchResult
    rows.value[idx] = { keyword, status: 'done', result: data, error: null, source: rows.value[idx].source }
  } catch (e: unknown) {
    const message = e instanceof Error
      ? (e.name === 'AbortError' ? '요청 시간 초과 (30초)' : e.message)
      : '알 수 없는 오류'
    rows.value[idx] = { keyword, status: 'error', result: null, error: message, source: rows.value[idx].source }
  }
}

async function retryRow(row: Row) {
  const origIdx = rows.value.indexOf(row)
  if (origIdx === -1) return
  const kw = row.keyword
  const src = row.source
  rows.value[origIdx] = { keyword: kw, status: 'loading', result: null, error: null, source: src }
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 30_000)
  await fetchKeyword(kw, origIdx, controller.signal)
  clearTimeout(timeoutId)
}

async function fetchExpand(
  keyword: string,
  options: { autocomplete: boolean, related: boolean },
  signal: AbortSignal,
): Promise<{ seed: string, keywords: Array<{ keyword: string, source: RowSource }> } | null> {
  try {
    const res = await fetch(EXPAND_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authStore.token ? { Authorization: `Bearer ${authStore.token}` } : {}),
      },
      body: JSON.stringify({ keyword, ...options }),
      signal,
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

// ─── 슬라이드 패널 ───────────────────────────────────────────────────────────

function openPanel(row: Row) {
  if (row.status !== 'done') return
  selectedRow.value = row
  slideoverOpen.value = true
}

// ─── CSV 내보내기 ─────────────────────────────────────────────────────────────

function exportCsv() {
  const doneRows = rows.value.filter(r => r.status === 'done' && r.result)
  if (doneRows.length === 0) return

  const headers = [
    '키워드',
    'PC검색량',
    '모바일검색량',
    '합계',
    '경쟁도',
    '구좌구성(모바일)',
    '구좌구성(PC)',
    '파워링크수',
    '플레이스수',
    '블로그수',
    '지식인수',
  ]

  const escape = (v: string | number | null) => {
    const s = String(v ?? '')
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s
  }

  const csvLines = [headers.join(',')]

  for (const row of doneRows) {
    const r = row.result!
    const sectionText = r.sections
      .sort((a, b) => a.order - b.order)
      .map(s => `${circledNumber(s.order)}${s.label}${s.count != null ? s.count : '?'}`)
      .join(' ')

    const pcSectionText = (r.pc_sections ?? [])
      .slice()
      .sort((a, b) => a.order - b.order)
      .map(s => `${circledNumber(s.order)}${s.label}${s.count != null ? s.count : '?'}`)
      .join(' ')

    // count null(정적 불가 구좌)은 '?'로 내보냄 — 0·빈칸과 구분
    const countOf = (type: string) => {
      const s = r.sections.find(sec => sec.type === type)
      return s != null ? (s.count != null ? s.count : '?') : ''
    }

    csvLines.push([
      escape(r.keyword),
      escape(r.pc_volume),
      escape(r.mobile_volume),
      escape(r.total ?? ((r.pc_volume ?? 0) + (r.mobile_volume ?? 0))),
      escape(competitionLabel(r.competition)),
      escape(sectionText),
      escape(pcSectionText),
      escape(countOf('powerlink')),
      escape(countOf('place')),
      escape(countOf('blog')),
      escape(countOf('kin')),
    ].join(','))
  }

  const bom = '﻿'
  const blob = new Blob([bom + csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `keyword_analysis_${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

function clearAll() {
  rows.value = []
}

// ─── 계산된 값 ────────────────────────────────────────────────────────────────

const hasResults = computed(() => rows.value.length > 0)
const hasDoneRows = computed(() => rows.value.some(r => r.status === 'done'))
const keywordCount = computed(() => parseKeywords(inputText.value).length)
const overLimit = computed(() => keywordCount.value > (optExpand.value ? 3 : 5))

const sortedRows = computed(() => {
  if (!sortKey.value) return rows.value
  const key = sortKey.value
  const dir = sortDir.value
  const arr = [...rows.value]

  const competitionOrder: Record<string, number> = { '높음': 3, '중간': 2, '낮음': 1 }
  const sourceOrder: Record<RowSource, number> = { seed: 3, autocomplete: 2, related: 1 }

  arr.sort((a, b) => {
    let cmp = 0
    if (key === 'keyword') {
      cmp = a.keyword.localeCompare(b.keyword, 'ko-KR')
    } else if (key === 'total') {
      const at = a.result ? (a.result.total ?? ((a.result.pc_volume ?? 0) + (a.result.mobile_volume ?? 0))) : -1
      const bt = b.result ? (b.result.total ?? ((b.result.pc_volume ?? 0) + (b.result.mobile_volume ?? 0))) : -1
      cmp = at - bt
    } else if (key === 'competition') {
      const ac = competitionOrder[a.result?.competition ?? ''] ?? 0
      const bc = competitionOrder[b.result?.competition ?? ''] ?? 0
      cmp = ac - bc
    } else if (key === 'source') {
      cmp = (sourceOrder[a.source] ?? 0) - (sourceOrder[b.source] ?? 0)
    }
    return dir === 'desc' ? -cmp : cmp
  })
  return arr
})

// ─── 구좌 병합 헬퍼 (상세 패널 비교 표용) ────────────────────────────────────

interface MergedSection {
  type: string
  label: string
  mobileOrder: number | null
  pcOrder: number | null
  mobileCount: number | null | undefined
  pcCount: number | null | undefined
}

function mergeSections(mobileSections: Section[], pcSections: Section[]): MergedSection[] {
  const map = new Map<string, MergedSection>()

  for (const s of mobileSections) {
    map.set(s.type, {
      type: s.type,
      label: s.label,
      mobileOrder: s.order,
      pcOrder: null,
      mobileCount: s.count,
      pcCount: undefined,
    })
  }
  for (const s of pcSections) {
    const existing = map.get(s.type)
    if (existing) {
      existing.pcOrder = s.order
      existing.pcCount = s.count
    } else {
      map.set(s.type, {
        type: s.type,
        label: s.label,
        mobileOrder: null,
        pcOrder: s.order,
        mobileCount: undefined,
        pcCount: s.count,
      })
    }
  }

  return [...map.values()].sort((a, b) => {
    const ao = a.mobileOrder ?? (a.pcOrder != null ? a.pcOrder + 1000 : 9999)
    const bo = b.mobileOrder ?? (b.pcOrder != null ? b.pcOrder + 1000 : 9999)
    return ao - bo
  })
}

// ─── URL ?q= 자동 실행 ────────────────────────────────────────────────────────

onMounted(async () => {
  // viewMode 복원
  const saved = localStorage.getItem('sb_serp_view') as ViewMode | null
  if (saved && (saved === 'mobile' || saved === 'pc' || saved === 'both')) {
    viewMode.value = saved
  }

  const q = useRoute().query.q
  if (typeof q === 'string' && q.trim()) {
    inputText.value = q.trim()
    await nextTick()
    runAnalysis()
  }
})
</script>

<template>
  <!--
    height 체인: default 레이아웃 main(flex-1 min-h-0 overflow-y-auto p-6) → 이 div(h-full flex flex-col)
    입력 shrink-0 / 결과 표 flex-1 min-h-0 overflow-y-auto
  -->
  <div class="h-full flex flex-col gap-4">

    <!-- ── 입력 영역 (shrink-0) ──────────────────────────────────────── -->
    <div class="shrink-0 flex flex-col gap-3">
      <div class="flex items-center gap-3 text-sm">
        <UCheckbox v-model="optAutocomplete" label="자동완성 키워드" />
        <UCheckbox v-model="optRelated" label="연관검색어" />
      </div>
      <div class="flex items-start gap-3">
        <div class="flex-1 min-w-0 flex flex-col gap-1">
          <UTextarea
            v-model="inputText"
            placeholder="키워드를 한 줄에 하나씩 입력하세요&#10;예) 강남 치과&#10;청주 한의원"
            :rows="4"
            class="w-full text-sm"
            :disabled="isAnalyzing"
          />
          <p class="text-xs text-gray-500 dark:text-slate-400">
            <template v-if="optExpand">
              한 줄에 하나씩 · 옵션이 켜져 있어 <span class="font-medium text-gray-700 dark:text-slate-300">시드 최대 3개 권장</span> · 시드당 풀이 자동 확장됩니다 (자동완성 5 / 연관 10)
            </template>
            <template v-else>
              한 줄에 하나씩 · 한 번에 <span class="font-medium text-gray-700 dark:text-slate-300">최대 5개 권장</span> · 결과는 아래에 누적됩니다
            </template>
          </p>
          <p v-if="overLimit" class="text-xs text-amber-600">
            {{ optExpand ? '시드 3개' : '5개' }} 초과 입력 시 처리 속도가 느려지거나 일부 키워드가 실패할 수 있습니다 (입력: {{ keywordCount }}개).
          </p>
        </div>
        <UButton
          label="분석하기"
          :loading="isAnalyzing"
          :disabled="keywordCount === 0"
          class="shrink-0 h-9 mt-0.5"
          @click="runAnalysis"
        />
      </div>
    </div>

    <!-- ── 결과 영역 (flex-1 min-h-0) ───────────────────────────────── -->
    <div class="flex-1 min-h-0 flex flex-col">

      <!-- 빈 상태 -->
      <div
        v-if="!hasResults"
        class="flex-1 flex items-center justify-center"
      >
        <p class="text-sm text-gray-400 dark:text-slate-500">키워드를 입력하고 분석하기를 누르세요.</p>
      </div>

      <!-- 결과 표 -->
      <template v-else>
        <!-- 표 상단 액션 바 -->
        <div class="shrink-0 flex items-center justify-between mb-2">
          <p class="text-xs text-gray-500 dark:text-slate-400">{{ rows.length }}개 키워드 분석</p>
          <div class="flex items-center gap-2">
            <!-- 표시 모드 토글 -->
            <div class="inline-flex items-center rounded border border-gray-200 dark:border-slate-700 overflow-hidden text-xs">
              <button
                v-for="opt in VIEW_MODE_OPTIONS"
                :key="opt.value"
                class="px-2 py-1 leading-none transition-colors"
                :class="viewMode === opt.value
                  ? 'bg-gray-800 text-white font-medium dark:bg-slate-600'
                  : 'bg-white text-gray-500 hover:bg-gray-50 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700/50'"
                @click="viewMode = opt.value"
              >
                {{ opt.label }}
              </button>
            </div>
            <UButton
              v-if="hasDoneRows"
              label="CSV 내보내기"
              size="xs"
              color="neutral"
              variant="outline"
              icon="i-heroicons-arrow-down-tray"
              @click="exportCsv"
            />
            <UButton
              label="전체 비우기"
              size="xs"
              color="neutral"
              variant="ghost"
              icon="i-heroicons-trash"
              @click="clearAll"
            />
          </div>
        </div>

        <!-- 표 래퍼: x-overflow 대비 + 내부 스크롤 -->
        <div class="flex-1 min-h-0 overflow-auto border border-gray-200 dark:border-slate-700 rounded-lg">
          <table class="w-full text-sm border-collapse">
            <thead class="sticky top-0 z-10 bg-gray-50 dark:bg-slate-700/50">
              <tr class="h-11">
                <th
                  class="px-3 text-left font-medium text-gray-600 dark:text-slate-300 text-xs whitespace-nowrap border-b border-gray-200 dark:border-slate-700 w-32 cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-700 select-none"
                  @click="handleSort('keyword')"
                >
                  <span class="inline-flex items-center gap-1">
                    키워드
                    <UIcon v-if="sortKey === 'keyword'" :name="sortDir === 'desc' ? 'i-heroicons-chevron-down' : 'i-heroicons-chevron-up'" class="w-3 h-3" />
                    <UIcon v-else name="i-heroicons-chevron-up-down" class="w-3 h-3 text-gray-300 dark:text-slate-600" />
                  </span>
                </th>
                <th
                  class="px-3 text-right font-medium text-gray-600 dark:text-slate-300 text-xs whitespace-nowrap border-b border-gray-200 dark:border-slate-700 w-40 cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-700 select-none"
                  @click="handleSort('total')"
                >
                  <span class="inline-flex items-center gap-1 justify-end w-full">
                    검색량
                    <UIcon v-if="sortKey === 'total'" :name="sortDir === 'desc' ? 'i-heroicons-chevron-down' : 'i-heroicons-chevron-up'" class="w-3 h-3" />
                    <UIcon v-else name="i-heroicons-chevron-up-down" class="w-3 h-3 text-gray-300 dark:text-slate-600" />
                  </span>
                </th>
                <th class="px-3 text-left font-medium text-gray-600 dark:text-slate-300 text-xs whitespace-nowrap border-b border-gray-200 dark:border-slate-700">
                  구좌 구성
                </th>
                <th
                  class="px-3 text-left font-medium text-gray-600 dark:text-slate-300 text-xs whitespace-nowrap border-b border-gray-200 dark:border-slate-700 w-28 cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-700 select-none"
                  @click="handleSort('competition')"
                >
                  <span class="inline-flex items-center gap-1">
                    경쟁도 / 유형
                    <UIcon v-if="sortKey === 'competition'" :name="sortDir === 'desc' ? 'i-heroicons-chevron-down' : 'i-heroicons-chevron-up'" class="w-3 h-3" />
                    <UIcon v-else name="i-heroicons-chevron-up-down" class="w-3 h-3 text-gray-300 dark:text-slate-600" />
                  </span>
                </th>
                <th class="px-3 text-right font-medium text-gray-600 dark:text-slate-300 text-xs whitespace-nowrap border-b border-gray-200 dark:border-slate-700 w-12">
                  상세
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(row, idx) in sortedRows"
                :key="row.keyword + idx"
                class="border-b border-gray-100 dark:border-slate-700 last:border-0 hover:bg-gray-50 dark:hover:bg-slate-700/50 transition-colors"
                :class="{ 'cursor-pointer': row.status === 'done' }"
                @click="openPanel(row)"
              >
                <!-- 키워드 -->
                <td class="px-3 py-2.5 align-top whitespace-nowrap">
                  <span class="font-medium text-gray-900 dark:text-slate-100">{{ row.keyword }}</span>
                  <span
                    v-if="row.source === 'autocomplete'"
                    class="ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-blue-50 text-blue-600"
                  >자동완성</span>
                  <span
                    v-else-if="row.source === 'related'"
                    class="ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-green-50 text-green-600"
                  >연관</span>
                </td>

                <!-- 검색량 -->
                <td class="px-3 py-2.5 align-top text-right whitespace-nowrap">
                  <template v-if="row.status === 'loading'">
                    <USkeleton class="h-4 w-28 ml-auto" />
                  </template>
                  <template v-else-if="row.status === 'error'">
                    <span class="text-red-500 text-xs">-</span>
                  </template>
                  <template v-else-if="row.status === 'done' && row.result">
                    <div class="flex flex-col items-end gap-0.5">
                      <span class="tabular-nums text-base font-semibold text-gray-900 dark:text-slate-100">
                        {{ formatNumber(row.result.total ?? ((row.result.pc_volume ?? 0) + (row.result.mobile_volume ?? 0))) }}
                      </span>
                      <span class="tabular-nums text-xs text-gray-400 dark:text-slate-500">
                        PC {{ formatNumber(row.result.pc_volume) }} · M {{ formatNumber(row.result.mobile_volume) }}
                      </span>
                    </div>
                  </template>
                </td>

                <!-- 구좌 구성 (가장 넓은 컬럼, 행 높이 가변) -->
                <td class="px-3 py-2 align-top">
                  <!-- 로딩 -->
                  <template v-if="row.status === 'loading'">
                    <div class="flex flex-wrap gap-1.5 py-0.5">
                      <USkeleton v-for="i in 4" :key="i" class="h-5 w-16 rounded-full" />
                    </div>
                  </template>
                  <!-- 에러 -->
                  <template v-else-if="row.status === 'error'">
                    <div class="flex items-center gap-2 py-0.5">
                      <span class="text-xs text-red-500">{{ row.error }}</span>
                      <UButton
                        label="재시도"
                        size="xs"
                        color="neutral"
                        variant="ghost"
                        @click.stop="retryRow(row)"
                      />
                    </div>
                  </template>
                  <!-- 완료 -->
                  <template v-else-if="row.status === 'done' && row.result">
                    <div class="flex flex-col gap-1.5 py-0.5">
                      <!-- both: 모바일 + PC 두 줄 -->
                      <template v-if="viewMode === 'both'">
                        <div class="flex items-start gap-1.5">
                          <span class="shrink-0 mt-0.5 w-10 text-xs font-medium text-gray-400 dark:text-slate-500">모바일</span>
                          <div v-if="row.result.sections.length === 0" class="text-xs text-gray-400 dark:text-slate-500">구좌 정보 없음</div>
                          <div v-else class="flex flex-wrap gap-1">
                            <span
                              v-for="section in [...row.result.sections].sort((a, b) => a.order - b.order)"
                              :key="'m' + section.order"
                              class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs font-medium leading-none"
                              :class="sectionColorClass(section.type)"
                            >
                              {{ circledNumber(section.order) }}{{ section.label }}<template v-if="section.count != null">{{ section.count }}</template><span v-else class="text-[10px] text-gray-400 dark:text-slate-500 font-normal" title="이 구좌는 노출되지만 개수는 직접 확인이 필요합니다">?</span>
                            </span>
                          </div>
                        </div>
                        <div class="flex items-start gap-1.5">
                          <span class="shrink-0 mt-0.5 w-10 text-xs font-medium text-gray-400 dark:text-slate-500">PC</span>
                          <div v-if="!(row.result.pc_sections && row.result.pc_sections.length)" class="text-xs text-gray-400 dark:text-slate-500">구좌 정보 없음</div>
                          <div v-else class="flex flex-wrap gap-1">
                            <span
                              v-for="section in [...row.result.pc_sections].sort((a, b) => a.order - b.order)"
                              :key="'pc' + section.order"
                              class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs font-medium leading-none"
                              :class="sectionColorClass(section.type)"
                            >
                              {{ circledNumber(section.order) }}{{ section.label }}<template v-if="section.count != null">{{ section.count }}</template><span v-else class="text-[10px] text-gray-400 dark:text-slate-500 font-normal" title="이 구좌는 노출되지만 개수는 직접 확인이 필요합니다">?</span>
                            </span>
                          </div>
                        </div>
                      </template>
                      <!-- mobile 단독 -->
                      <template v-else-if="viewMode === 'mobile'">
                        <div v-if="row.result.sections.length === 0" class="text-xs text-gray-400 dark:text-slate-500">구좌 정보 없음</div>
                        <div v-else class="flex flex-wrap gap-1">
                          <span
                            v-for="section in [...row.result.sections].sort((a, b) => a.order - b.order)"
                            :key="'m' + section.order"
                            class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs font-medium leading-none"
                            :class="sectionColorClass(section.type)"
                          >
                            {{ circledNumber(section.order) }}{{ section.label }}<template v-if="section.count != null">{{ section.count }}</template><span v-else class="text-[10px] text-gray-400 dark:text-slate-500 font-normal" title="이 구좌는 노출되지만 개수는 직접 확인이 필요합니다">?</span>
                          </span>
                        </div>
                      </template>
                      <!-- pc 단독 -->
                      <template v-else>
                        <div v-if="!(row.result.pc_sections && row.result.pc_sections.length)" class="text-xs text-gray-400 dark:text-slate-500">구좌 정보 없음</div>
                        <div v-else class="flex flex-wrap gap-1">
                          <span
                            v-for="section in [...row.result.pc_sections].sort((a, b) => a.order - b.order)"
                            :key="'pc' + section.order"
                            class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs font-medium leading-none"
                            :class="sectionColorClass(section.type)"
                          >
                            {{ circledNumber(section.order) }}{{ section.label }}<template v-if="section.count != null">{{ section.count }}</template><span v-else class="text-[10px] text-gray-400 dark:text-slate-500 font-normal" title="이 구좌는 노출되지만 개수는 직접 확인이 필요합니다">?</span>
                          </span>
                        </div>
                      </template>
                    </div>
                  </template>
                </td>

                <!-- 경쟁도 / 유형 -->
                <td class="px-3 py-2.5 align-top text-gray-700 dark:text-slate-300 whitespace-nowrap">
                  <template v-if="row.status === 'loading'">
                    <USkeleton class="h-4 w-16" />
                  </template>
                  <template v-else-if="row.status === 'done' && row.result">
                    <span class="text-sm">{{ competitionLabel(row.result.competition) }}</span>
                    <span class="text-xs text-gray-400 dark:text-slate-500 ml-1">/ 유형 -</span>
                  </template>
                  <template v-else-if="row.status === 'error'">
                    <span class="text-gray-300 dark:text-slate-600">-</span>
                  </template>
                </td>

                <!-- 상세 버튼 -->
                <td class="px-3 py-2.5 align-top text-right">
                  <UButton
                    v-if="row.status === 'done'"
                    icon="i-heroicons-arrow-right"
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    aria-label="상세 보기"
                    @click.stop="openPanel(row)"
                  />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </div>

    <!-- ── 우측 슬라이드 패널 ────────────────────────────────────────── -->
    <USlideover
      v-model:open="slideoverOpen"
      title="키워드 상세"
      description=""
      side="right"
    >
      <template #body>
        <div
          v-if="selectedRow && selectedRow.result"
          class="flex flex-col gap-5 p-5 h-full overflow-y-auto"
        >
          <!-- 키워드 제목 + 네이버 검색 이동 N 아이콘 -->
          <div>
            <p class="text-xs text-gray-400 dark:text-slate-500 mb-0.5">키워드</p>
            <div class="flex items-center gap-2">
              <h2 class="text-base font-semibold text-gray-900 dark:text-slate-100">{{ selectedRow.result.keyword }}</h2>
              <a
                :href="`https://search.naver.com/search.naver?query=${encodeURIComponent(selectedRow.result.keyword)}`"
                target="_blank"
                rel="noopener"
                class="inline-flex items-center justify-center w-5 h-5 rounded bg-[#03C75A] text-white text-xs font-bold hover:opacity-80 transition-opacity shrink-0"
                title="네이버에서 검색 결과 보기"
                aria-label="네이버에서 검색"
              >N</a>
            </div>
          </div>

          <!-- 검색량 수치 -->
          <div class="grid grid-cols-2 gap-3">
            <div class="bg-gray-50 dark:bg-slate-700/50 rounded-lg p-3">
              <p class="text-xs text-gray-500 dark:text-slate-400 mb-1">PC 검색량</p>
              <p class="text-sm font-semibold tabular-nums dark:text-slate-100">{{ formatNumber(selectedRow.result.pc_volume) }}</p>
            </div>
            <div class="bg-gray-50 dark:bg-slate-700/50 rounded-lg p-3">
              <p class="text-xs text-gray-500 dark:text-slate-400 mb-1">모바일 검색량</p>
              <p class="text-sm font-semibold tabular-nums dark:text-slate-100">{{ formatNumber(selectedRow.result.mobile_volume) }}</p>
            </div>
            <div class="bg-gray-50 dark:bg-slate-700/50 rounded-lg p-3">
              <p class="text-xs text-gray-500 dark:text-slate-400 mb-1">합계</p>
              <p class="text-sm font-semibold tabular-nums dark:text-slate-100">
                {{ formatNumber(selectedRow.result.total ?? ((selectedRow.result.pc_volume ?? 0) + (selectedRow.result.mobile_volume ?? 0))) }}
              </p>
            </div>
            <div class="bg-gray-50 dark:bg-slate-700/50 rounded-lg p-3">
              <p class="text-xs text-gray-500 dark:text-slate-400 mb-1">경쟁도</p>
              <p class="text-sm font-semibold dark:text-slate-100">{{ competitionLabel(selectedRow.result.competition) }}</p>
            </div>
          </div>

          <!-- 구좌 구성 -->
          <div>
            <p class="text-xs text-gray-400 dark:text-slate-500 mb-2 font-medium">구좌 구성</p>

            <!-- both: 2열 비교 표 -->
            <template v-if="viewMode === 'both'">
              <div
                v-if="!selectedRow.result.sections.length && !(selectedRow.result.pc_sections && selectedRow.result.pc_sections.length)"
                class="text-sm text-gray-400 dark:text-slate-500"
              >
                구좌 정보 없음
              </div>
              <table v-else class="w-full text-xs border-collapse">
                <thead>
                  <tr class="border-b border-gray-200 dark:border-slate-700">
                    <th class="py-1 pr-2 text-left text-gray-500 dark:text-slate-400 font-medium w-28">구좌</th>
                    <th class="py-1 px-2 text-center text-gray-500 dark:text-slate-400 font-medium w-16">모바일</th>
                    <th class="py-1 pl-2 text-center text-gray-500 dark:text-slate-400 font-medium w-16">PC</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="row in mergeSections(
                      selectedRow.result.sections,
                      selectedRow.result.pc_sections ?? []
                    )"
                    :key="row.type"
                    class="border-b border-gray-100 dark:border-slate-700 last:border-0"
                  >
                    <td class="py-1 pr-2 align-middle">
                      <span
                        class="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium leading-none"
                        :class="sectionColorClass(row.type)"
                      >{{ row.label }}</span>
                    </td>
                    <td class="py-1 px-2 text-center align-middle tabular-nums text-gray-700 dark:text-slate-300">
                      <template v-if="row.mobileOrder != null">
                        {{ circledNumber(row.mobileOrder) }}<template v-if="row.mobileCount != null"> {{ row.mobileCount }}</template><span v-else class="text-[10px] text-gray-400 dark:text-slate-500 font-normal" title="이 구좌는 노출되지만 개수는 직접 확인이 필요합니다">?</span>
                      </template>
                      <template v-else><span class="text-gray-300 dark:text-slate-600">-</span></template>
                    </td>
                    <td class="py-1 pl-2 text-center align-middle tabular-nums text-gray-700 dark:text-slate-300">
                      <template v-if="row.pcOrder != null">
                        {{ circledNumber(row.pcOrder) }}<template v-if="row.pcCount != null"> {{ row.pcCount }}</template><span v-else class="text-[10px] text-gray-400 dark:text-slate-500 font-normal" title="이 구좌는 노출되지만 개수는 직접 확인이 필요합니다">?</span>
                      </template>
                      <template v-else><span class="text-gray-300 dark:text-slate-600">-</span></template>
                    </td>
                  </tr>
                </tbody>
              </table>
            </template>

            <!-- mobile 단독 세로 목록 -->
            <template v-else-if="viewMode === 'mobile'">
              <div
                v-if="selectedRow.result.sections.length === 0"
                class="text-sm text-gray-400 dark:text-slate-500"
              >
                구좌 정보 없음
              </div>
              <div v-else class="flex flex-col gap-2">
                <div
                  v-for="section in [...selectedRow.result.sections].sort((a, b) => a.order - b.order)"
                  :key="'m' + section.order"
                  class="flex items-center gap-2"
                >
                  <span
                    class="inline-flex items-center gap-0.5 px-2 py-0.5 rounded text-xs font-medium leading-none shrink-0"
                    :class="sectionColorClass(section.type)"
                  >
                    {{ circledNumber(section.order) }} {{ section.label }}
                  </span>
                  <span v-if="section.count != null" class="text-xs text-gray-500 dark:text-slate-400 tabular-nums">
                    {{ section.count }}개
                  </span>
                  <span v-else class="text-xs text-gray-400 dark:text-slate-500" title="이 구좌는 노출되지만 개수는 직접 확인이 필요합니다">확인 필요</span>
                </div>
              </div>
            </template>

            <!-- pc 단독 세로 목록 -->
            <template v-else>
              <div
                v-if="!(selectedRow.result.pc_sections && selectedRow.result.pc_sections.length)"
                class="text-sm text-gray-400 dark:text-slate-500"
              >
                구좌 정보 없음
              </div>
              <div v-else class="flex flex-col gap-2">
                <div
                  v-for="section in [...selectedRow.result.pc_sections].sort((a, b) => a.order - b.order)"
                  :key="'pc' + section.order"
                  class="flex items-center gap-2"
                >
                  <span
                    class="inline-flex items-center gap-0.5 px-2 py-0.5 rounded text-xs font-medium leading-none shrink-0"
                    :class="sectionColorClass(section.type)"
                  >
                    {{ circledNumber(section.order) }} {{ section.label }}
                  </span>
                  <span v-if="section.count != null" class="text-xs text-gray-500 dark:text-slate-400 tabular-nums">
                    {{ section.count }}개
                  </span>
                  <span v-else class="text-xs text-gray-400 dark:text-slate-500" title="이 구좌는 노출되지만 개수는 직접 확인이 필요합니다">확인 필요</span>
                </div>
              </div>
            </template>
          </div>

          <!-- 연관 검색어 -->
          <div v-if="selectedRow.result.related_keywords && selectedRow.result.related_keywords.length > 0">
            <p class="text-xs text-gray-400 dark:text-slate-500 mb-2 font-medium">연관 검색어</p>
            <div class="flex flex-wrap gap-1.5">
              <span
                v-for="kw in selectedRow.result.related_keywords.slice(0, 10)"
                :key="kw.keyword"
                class="inline-flex items-center gap-1.5 pl-2 pr-1.5 py-0.5 rounded-full text-xs bg-gray-100 dark:bg-slate-700 text-gray-700 dark:text-slate-300"
              >
                <span class="font-medium">{{ kw.keyword }}</span>
                <span class="text-gray-400 dark:text-slate-500 tabular-nums">{{ formatNumber(kw.total) }}</span>
              </span>
            </div>
          </div>

          <!-- 하단: 순위 추적 추가 버튼 (현재 disabled) -->
          <div class="mt-auto pt-4 border-t border-gray-100 dark:border-slate-700">
            <UButton
              label="순위 추적 추가"
              icon="i-heroicons-plus"
              class="w-full justify-center"
              color="primary"
              disabled
              title="순위 추적 기능은 준비 중입니다"
            />
            <p class="text-xs text-gray-400 dark:text-slate-500 mt-1.5 text-center">순위 추적 기능 준비 중</p>
          </div>
        </div>
      </template>
    </USlideover>

  </div>
</template>
