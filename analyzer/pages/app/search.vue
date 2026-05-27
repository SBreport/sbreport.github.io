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

interface SearchResult {
  keyword: string
  pc_volume: number | null
  mobile_volume: number | null
  total: number | null
  competition: string | null
  related_keywords: string[]
  sections: Section[]
}

type RowStatus = 'pending' | 'loading' | 'done' | 'error'

interface Row {
  keyword: string
  status: RowStatus
  result: SearchResult | null
  error: string | null
}

// ─── 상태 ────────────────────────────────────────────────────────────────────

const inputText = ref('')
const rows = ref<Row[]>([])
const isAnalyzing = ref(false)

// 슬라이드 패널
const slideoverOpen = ref(false)
const selectedRow = ref<Row | null>(null)

// ─── Worker 엔드포인트 ────────────────────────────────────────────────────────

const WORKER_URL = 'https://naver-searchad-proxy.sbreport.workers.dev/api/search'

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
    powerlink:     'bg-amber-100 text-amber-700',
    place:         'bg-red-100 text-red-700',
    blog:          'bg-blue-100 text-blue-700',
    kin:           'bg-green-100 text-green-700',
    cafe:          'bg-orange-100 text-orange-700',
    influencer:    'bg-violet-100 text-violet-700',
    powercontents: 'bg-purple-100 text-purple-700',
    video:         'bg-teal-100 text-teal-700',
    news:          'bg-gray-100 text-gray-600',
    web:           'bg-gray-100 text-gray-600',
    qra:           'bg-cyan-100 text-cyan-700',
  }
  return map[type] ?? 'bg-gray-100 text-gray-500'
}

// ─── 분석 실행 ───────────────────────────────────────────────────────────────

async function runAnalysis() {
  const keywords = parseKeywords(inputText.value)
  if (keywords.length === 0) return

  if (keywords.length > 5) {
    // 5개 초과 안내 (처리는 막지 않음)
    // UNotification 대신 간단히 계속 진행
  }

  isAnalyzing.value = true

  // 기존 결과 초기화 후 로딩 행 생성
  rows.value = keywords.map(kw => ({
    keyword: kw,
    status: 'loading' as RowStatus,
    result: null,
    error: null,
  }))

  // 병렬 호출 (Promise.allSettled — 일부 실패해도 나머지 계속)
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 20_000)

  const promises = keywords.map((kw, idx) =>
    fetchKeyword(kw, idx, controller.signal)
  )

  await Promise.allSettled(promises)
  clearTimeout(timeoutId)

  isAnalyzing.value = false
}

async function fetchKeyword(keyword: string, idx: number, signal: AbortSignal) {
  try {
    const res = await fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

      rows.value[idx] = { keyword, status: 'error', result: null, error: message }
      return
    }

    const data = await res.json() as SearchResult
    rows.value[idx] = { keyword, status: 'done', result: data, error: null }
  } catch (e: unknown) {
    const message = e instanceof Error
      ? (e.name === 'AbortError' ? '요청 시간 초과 (20초)' : e.message)
      : '알 수 없는 오류'
    rows.value[idx] = { keyword, status: 'error', result: null, error: message }
  }
}

async function retryRow(idx: number) {
  const kw = rows.value[idx].keyword
  rows.value[idx] = { keyword: kw, status: 'loading', result: null, error: null }
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 20_000)
  await fetchKeyword(kw, idx, controller.signal)
  clearTimeout(timeoutId)
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
    '구좌구성',
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
      .map(s => `${circledNumber(s.order)}${s.label}${s.count != null ? s.count : ''}`)
      .join(' ')

    const countOf = (type: string) => {
      const s = r.sections.find(sec => sec.type === type)
      return s?.count ?? 0
    }

    csvLines.push([
      escape(r.keyword),
      escape(r.pc_volume),
      escape(r.mobile_volume),
      escape(r.total ?? ((r.pc_volume ?? 0) + (r.mobile_volume ?? 0))),
      escape(competitionLabel(r.competition)),
      escape(sectionText),
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

// ─── 계산된 값 ────────────────────────────────────────────────────────────────

const hasResults = computed(() => rows.value.length > 0)
const hasDoneRows = computed(() => rows.value.some(r => r.status === 'done'))
const keywordCount = computed(() => parseKeywords(inputText.value).length)
const overLimit = computed(() => keywordCount.value > 5)
</script>

<template>
  <!--
    height 체인: default 레이아웃 main(flex-1 min-h-0 overflow-y-auto p-6) → 이 div(h-full flex flex-col)
    입력 shrink-0 / 결과 표 flex-1 min-h-0 overflow-y-auto
  -->
  <div class="h-full flex flex-col gap-4">

    <!-- ── 입력 영역 (shrink-0) ──────────────────────────────────────── -->
    <div class="shrink-0 flex flex-col gap-3">
      <div class="flex items-start gap-3">
        <div class="flex-1 min-w-0 flex flex-col gap-1">
          <UTextarea
            v-model="inputText"
            placeholder="키워드를 한 줄에 하나씩 입력하세요&#10;예) 강남 치과&#10;청주 한의원"
            :rows="4"
            class="w-full text-sm"
            :disabled="isAnalyzing"
          />
          <p v-if="overLimit" class="text-xs text-amber-600">
            한 번에 5개 초과 입력 시 처리 속도가 느려질 수 있습니다 (입력: {{ keywordCount }}개).
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
        <p class="text-sm text-gray-400">키워드를 입력하고 분석하기를 누르세요.</p>
      </div>

      <!-- 결과 표 -->
      <template v-else>
        <!-- 표 상단 액션 바 -->
        <div class="shrink-0 flex items-center justify-between mb-2">
          <p class="text-xs text-gray-500">{{ rows.length }}개 키워드 분석</p>
          <UButton
            v-if="hasDoneRows"
            label="CSV 내보내기"
            size="xs"
            color="neutral"
            variant="outline"
            icon="i-heroicons-arrow-down-tray"
            @click="exportCsv"
          />
        </div>

        <!-- 표 래퍼: x-overflow 대비 + 내부 스크롤 -->
        <div class="flex-1 min-h-0 overflow-auto border border-gray-200 rounded-lg">
          <table class="w-full text-sm border-collapse">
            <thead class="sticky top-0 z-10 bg-gray-50">
              <tr class="h-11">
                <th class="px-3 text-left font-medium text-gray-600 text-xs whitespace-nowrap border-b border-gray-200 w-32">
                  키워드
                </th>
                <th class="px-3 text-right font-medium text-gray-600 text-xs whitespace-nowrap border-b border-gray-200 w-40">
                  검색량 (P+M)
                </th>
                <th class="px-3 text-left font-medium text-gray-600 text-xs whitespace-nowrap border-b border-gray-200">
                  구좌 구성
                </th>
                <th class="px-3 text-left font-medium text-gray-600 text-xs whitespace-nowrap border-b border-gray-200 w-28">
                  경쟁도 / 유형
                </th>
                <th class="px-3 text-right font-medium text-gray-600 text-xs whitespace-nowrap border-b border-gray-200 w-12">
                  상세
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(row, idx) in rows"
                :key="row.keyword + idx"
                class="border-b border-gray-100 last:border-0 hover:bg-gray-50 transition-colors"
                :class="{ 'cursor-pointer': row.status === 'done' }"
                @click="openPanel(row)"
              >
                <!-- 키워드 -->
                <td class="px-3 py-2.5 align-top font-medium text-gray-900 whitespace-nowrap">
                  {{ row.keyword }}
                </td>

                <!-- 검색량 -->
                <td class="px-3 py-2.5 align-top text-right text-gray-700 whitespace-nowrap">
                  <!-- 로딩 -->
                  <template v-if="row.status === 'loading'">
                    <USkeleton class="h-4 w-28 ml-auto" />
                  </template>
                  <!-- 에러 -->
                  <template v-else-if="row.status === 'error'">
                    <span class="text-red-500 text-xs">-</span>
                  </template>
                  <!-- 완료 -->
                  <template v-else-if="row.status === 'done' && row.result">
                    <span class="tabular-nums">
                      {{ formatNumber(row.result.pc_volume) }}
                      <span class="text-gray-400 mx-0.5">+</span>
                      {{ formatNumber(row.result.mobile_volume) }}
                    </span>
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
                        @click.stop="retryRow(idx)"
                      />
                    </div>
                  </template>
                  <!-- 완료 -->
                  <template v-else-if="row.status === 'done' && row.result">
                    <div v-if="row.result.sections.length === 0" class="text-xs text-gray-400 py-0.5">
                      구좌 정보 없음
                    </div>
                    <div v-else class="flex flex-wrap gap-1 py-0.5">
                      <span
                        v-for="section in [...row.result.sections].sort((a, b) => a.order - b.order)"
                        :key="section.order"
                        class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs font-medium leading-none"
                        :class="sectionColorClass(section.type)"
                      >
                        {{ circledNumber(section.order) }}{{ section.label }}<template v-if="section.count != null">{{ section.count }}</template>
                      </span>
                    </div>
                  </template>
                </td>

                <!-- 경쟁도 / 유형 -->
                <td class="px-3 py-2.5 align-top text-gray-700 whitespace-nowrap">
                  <template v-if="row.status === 'loading'">
                    <USkeleton class="h-4 w-16" />
                  </template>
                  <template v-else-if="row.status === 'done' && row.result">
                    <span class="text-sm">{{ competitionLabel(row.result.competition) }}</span>
                    <span class="text-xs text-gray-400 ml-1">/ 유형 -</span>
                  </template>
                  <template v-else-if="row.status === 'error'">
                    <span class="text-gray-300">-</span>
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
          <!-- 키워드 제목 -->
          <div>
            <p class="text-xs text-gray-400 mb-0.5">키워드</p>
            <h2 class="text-base font-semibold text-gray-900">{{ selectedRow.result.keyword }}</h2>
          </div>

          <!-- 검색량 수치 -->
          <div class="grid grid-cols-2 gap-3">
            <div class="bg-gray-50 rounded-lg p-3">
              <p class="text-xs text-gray-500 mb-1">PC 검색량</p>
              <p class="text-sm font-semibold tabular-nums">{{ formatNumber(selectedRow.result.pc_volume) }}</p>
            </div>
            <div class="bg-gray-50 rounded-lg p-3">
              <p class="text-xs text-gray-500 mb-1">모바일 검색량</p>
              <p class="text-sm font-semibold tabular-nums">{{ formatNumber(selectedRow.result.mobile_volume) }}</p>
            </div>
            <div class="bg-gray-50 rounded-lg p-3">
              <p class="text-xs text-gray-500 mb-1">합계</p>
              <p class="text-sm font-semibold tabular-nums">
                {{ formatNumber(selectedRow.result.total ?? ((selectedRow.result.pc_volume ?? 0) + (selectedRow.result.mobile_volume ?? 0))) }}
              </p>
            </div>
            <div class="bg-gray-50 rounded-lg p-3">
              <p class="text-xs text-gray-500 mb-1">경쟁도</p>
              <p class="text-sm font-semibold">{{ competitionLabel(selectedRow.result.competition) }}</p>
            </div>
          </div>

          <!-- 구좌 구성 세로 펼침 -->
          <div>
            <p class="text-xs text-gray-400 mb-2 font-medium">구좌 구성 (SERP 순서)</p>
            <div
              v-if="selectedRow.result.sections.length === 0"
              class="text-sm text-gray-400"
            >
              구좌 정보 없음
            </div>
            <div v-else class="flex flex-col gap-2">
              <div
                v-for="section in [...selectedRow.result.sections].sort((a, b) => a.order - b.order)"
                :key="section.order"
                class="flex items-center gap-2"
              >
                <span
                  class="inline-flex items-center gap-0.5 px-2 py-0.5 rounded text-xs font-medium leading-none shrink-0"
                  :class="sectionColorClass(section.type)"
                >
                  {{ circledNumber(section.order) }} {{ section.label }}
                </span>
                <span v-if="section.count != null" class="text-xs text-gray-500 tabular-nums">
                  {{ section.count }}개
                </span>
              </div>
            </div>
          </div>

          <!-- 연관 검색어 -->
          <div v-if="selectedRow.result.related_keywords && selectedRow.result.related_keywords.length > 0">
            <p class="text-xs text-gray-400 mb-2 font-medium">연관 검색어</p>
            <div class="flex flex-wrap gap-1.5">
              <span
                v-for="kw in selectedRow.result.related_keywords.slice(0, 10)"
                :key="kw"
                class="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-gray-100 text-gray-600 font-medium"
              >
                {{ kw }}
              </span>
            </div>
          </div>

          <!-- 하단: 순위 추적 추가 버튼 (현재 disabled) -->
          <div class="mt-auto pt-4 border-t border-gray-100">
            <UButton
              label="순위 추적 추가"
              icon="i-heroicons-plus"
              class="w-full justify-center"
              color="primary"
              disabled
              title="순위 추적 기능은 준비 중입니다"
            />
            <p class="text-xs text-gray-400 mt-1.5 text-center">순위 추적 기능 준비 중</p>
          </div>
        </div>
      </template>
    </USlideover>

  </div>
</template>
