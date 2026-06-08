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
const multiSamplesCsvLoading = ref(false)
const multiSamplesCsvProgress = ref<{ placeIndex: number; placeTotal: number; rowCount: number } | null>(null)

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
  focus: 'outcome' | 'service' | 'space' | 'price' | 'revisit' | string  // string: 구 데이터(taste/mood) 호환
  status?: 'active' | 'kept' | 'archived'
  model?: string
  provider?: string  // 이번 생성 배치의 provider (openai | anthropic | xai)
  created_at?: string
  // R2: 자연스러움 채점 (배치 추이 감시용 — 개별 합불 판단 아님)
  naturalness?: number   // 0~100 정수
  slop_hits?: number     // 감지된 slop n-gram 수
  slop_top?: string[]    // 상위 slop 표현 최대 3개
  // 환각 탐지 soft-flag (표면 정규식 조기경보 — 재생성 아님)
  hallucination?: {
    risk: 'none' | 'low' | 'high'
    flags: Array<{ type: string; text: string }>
  }
}

interface NaturalnessSummary {
  count: number
  mean: number
  median: number
  min: number
  mean_slop_hits: number
}

interface HallucinationSummary {
  high: number
  low: number
}

interface BatchDiversity {
  distinct2: number
  avgSimilarity: number
  maxSimilarity: number
  count: number
}

interface GenerateSamplesResponse {
  place_name: string
  provider: string
  model: string
  generated_at: string
  samples: ReviewSample[]
  diversity?: BatchDiversity | null
}

// 리뷰 예시 생성 상태
const sampleCount = ref(10)
const sampleProvider = ref<'openai' | 'anthropic' | 'xai'>('anthropic')
const sampleModel = ref<string>('claude-sonnet-4-6')
const sampleLength = ref<'auto' | 'short' | 'medium' | 'long'>('auto')
const sampleIncludeNames = ref(true)
const sampleHumanizeLevel = ref<'off' | 'light' | 'medium' | 'strong'>('medium')
const samples = ref<ReviewSample[]>([])
const samplesStatus = ref<'idle' | 'loading' | 'generating' | 'empty' | 'error' | 'done'>('idle')
const samplesError = ref<string | null>(null)
const samplesErrorCode = ref<string | null>(null)
const samplesGenerating = ref(false)
// R2: 배치 자연스러움 요약 (fetchSamples 응답에서)
const naturalnessSummary = ref<NaturalnessSummary | null>(null)
// 환각 탐지 배치 요약 (fetchSamples 응답에서)
const hallucinationSummary = ref<HallucinationSummary | null>(null)

// 마지막 생성 배치 provider/model 기록 (결과 헤더 표시용)
const lastGenerationInfo = ref<{ provider: string; model: string } | null>(null)
// 마지막 생성 배치 다양성 지표
const lastDiversity = ref<BatchDiversity | null>(null)

// 제공자 표시명 매핑
const providerLabel: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Claude',
  xai: 'Grok',
}

type ModelOption = { provider: 'openai' | 'anthropic' | 'xai'; model: string; label: string }
const PROVIDER_OPTIONS: ModelOption[] = [
  { provider: 'openai',    model: 'gpt-5.4-mini',            label: 'OpenAI · gpt-5.4-mini' },
  { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', label: 'Claude · Haiku 4.5' },
  { provider: 'anthropic', model: 'claude-sonnet-4-6',         label: 'Claude · Sonnet 4.6' },
  { provider: 'anthropic', model: 'claude-opus-4-8',           label: 'Claude · Opus 4.8 (느림·고비용)' },
  { provider: 'xai',       model: 'grok-4.3',                  label: 'Grok 4.3' },
]

function onModelSelect(modelValue: string) {
  const opt = PROVIDER_OPTIONS.find(o => o.model === modelValue)
  if (opt) {
    sampleModel.value = opt.model
    sampleProvider.value = opt.provider
  }
}

// 예시 관리 상태
type SampleFilter = 'all' | 'kept' | 'active'
const sampleFilter = ref<SampleFilter>('all')
const showArchived = ref(false)
const checkedSampleIds = ref<Set<string>>(new Set())
const sampleStatusUpdating = ref<Set<string>>(new Set())
const sampleDeleteLoading = ref(false)

// ─── 예시 테이블 정렬 ────────────────────────────────────────────────────────

type SampleSortKey = 'created_at' | 'length' | 'provider' | 'status'
const sampleSortKey = ref<SampleSortKey>('created_at')
const sampleSortAsc = ref(false)  // 기본: 생성시각 desc

function toggleSampleSort(key: SampleSortKey) {
  if (sampleSortKey.value === key) {
    sampleSortAsc.value = !sampleSortAsc.value
  } else {
    sampleSortKey.value = key
    sampleSortAsc.value = key !== 'created_at'  // created_at은 desc 기본, 나머지 asc 기본
  }
}

// 태그 필터 (다중 선택)
const filterLengths = ref<Set<string>>(new Set())

function toggleLengthFilter(value: string) {
  const next = new Set(filterLengths.value)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  filterLengths.value = next
}

// 본문 펼침 상태
const expandedSampleIds = ref<Set<string>>(new Set())
function toggleExpandSample(id: string) {
  const next = new Set(expandedSampleIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expandedSampleIds.value = next
}

// ─── AI 진단 (Phase 4-2) 타입 ────────────────────────────────────────────────

type HumanLabel = 'human' | 'ad' | 'ai' | 'unsure' | null

interface AiDiagnosisSuspectReview {
  review_id: string
  body: string
  ai_suspect: number
  raw_ai_suspect?: number
  flags: string[]
  sentiment: string | null
  reason: string | null
  review_date: string | null
  human_label?: HumanLabel
  human_note?: string | null
  kind?: 'ad' | 'ai' | null
}

interface AiDiagnosisAgreement {
  compared: number
  agree: number
  rate: number | null
  false_positive: number
  false_negative: number
}

interface AiDiagnosisResult {
  place_name: string
  suspect_threshold: number
  human_correction: boolean
  total_reviews: number
  total_analyzed: number
  low_quality: number
  presumed_human: number
  heuristic_suspect: number   // 휴리스틱 추정 건수 (GPT 미판정)
  gpt_judged: number          // 진짜 GPT 판정 건수 (heuristic_only 제외)
  suspect: number
  suspect_pending: number     // 휴리스틱 의심 중 GPT 미판정 건수 ("의심만" 버튼 대상)
  denominator: number
  suspect_rate: number
  pending_all: number
  distribution: Record<string, number>
  flag_breakdown: Record<string, number>
  sample_suspect: AiDiagnosisSuspectReview[]
  human_counts: { human: number; ad: number; ai: number; unsure: number }
  agreement: AiDiagnosisAgreement
}

interface AiReviewItem {
  review_id: string
  body: string
  ai_suspect: number | null
  raw_ai_suspect?: number
  flags: string[]
  sentiment: string | null
  reason: string | null
  review_date: string | null
  rule_low_quality: boolean
  heuristic_score: number | null
  human_label: HumanLabel
  human_note: string | null
  kind?: 'ad' | 'ai' | null
}

// AI 진단 상태
const aiDiagnosisStatus = ref<LoadStatus>('idle')
const aiDiagnosisError = ref<string | null>(null)
const aiDiagnosis = ref<AiDiagnosisResult | null>(null)
const aiDiagnosisThreshold = ref(60)  // 0~100, 기본 60

// AI 진단 실행 (POST) 상태 — 관리자 전용
const aiAnalyzeRunning = ref(false)
const aiAnalyzeError = ref<string | null>(null)
const aiAnalyzeSummary = ref<{
  analyzed: number
  gpt_called: number
  cost_usd: number
} | null>(null)
// GPT 재판정 상태 — 관리자 전용
const aiRejudgeRunning = ref(false)
const aiRejudgeError = ref<string | null>(null)
const aiRejudgeSummary = ref<{
  gpt_called: number
  cost_usd: number
} | null>(null)

// LLM 판별기 상태 (잠정·검증전) — 관리자 전용
const llmClassifyRunning = ref(false)
const llmClassifyError = ref<string | null>(null)
const llmClassifySummary = ref<{
  classified: number
  cost_usd: number | null
} | null>(null)
const llmClassifyModel = ref('gpt-5.4-mini')  // 기본 저가 모델

// AI 리뷰 목록 (우측 패널)
type AiBucket = 'low_quality' | 'presumed_human' | 'judged' | 'suspect' | 'all'
const aiReviewsStatus = ref<LoadStatus>('idle')
const aiReviewsError = ref<string | null>(null)
const aiReviewsItems = ref<AiReviewItem[]>([])
const aiReviewsTotal = ref(0)
const aiReviewsPage = ref(1)
const aiReviewsLoadingMore = ref(false)
// 활성 필터
const activeBucket = ref<AiBucket>('suspect')
const activeScoreMin = ref<number | null>(null)
const activeScoreMax = ref<number | null>(null)
// 사람 라벨 필터 (null=없음, 'human'|'ad'|'unsure')
const activeHumanLabel = ref<HumanLabel>(null)
// 인간 보정 토글
const humanCorrectionEnabled = ref(false)
// 라벨 저장 중 (review_id 세트)
const labelSavingIds = ref<Set<string>>(new Set())
// 라벨 메모 펼침 (review_id 세트)
const labelNoteOpenIds = ref<Set<string>>(new Set())
// 메모 임시 입력값 (review_id → 문자열)
const labelNoteInputs = ref<Record<string, string>>({})

// 리뷰 본문 펼침 상태
const expandedDiagnosisIds = ref<Set<string>>(new Set())
function toggleExpandDiagnosis(id: string) {
  const next = new Set(expandedDiagnosisIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expandedDiagnosisIds.value = next
}

// ─── AI 진단 탭 상수 & computed ──────────────────────────────────────────────

// 플래그 한글화 맵
const AI_FLAG_LABEL: Record<string, string> = {
  '격식체': '격식체 말투',
  '추상칭찬': '구체성 없는 칭찬',
  '과장': '과장 표현',
  '정갈끝이모지': '정갈한 글+끝 이모지',
  '광고체': '광고 같은 어조',
  '구체성결여': '경험 디테일 없음',
  '장점나열': '장점 나열형',
  '템플릿성': '상투적 구성',
  '업종불일치': '업종 안 맞음',
  'heuristic_only': '휴리스틱 추정',
}

function flagLabel(flag: string): string {
  return AI_FLAG_LABEL[flag] ?? flag
}

// 의심률 정성 라벨·색 (기준값 바꾸려면 여기서만)
const AI_SUSPECT_THRESHOLDS = { low: 0.10, high: 0.30 }

const aiSuspectLevel = computed(() => {
  const r = aiDiagnosis.value?.suspect_rate ?? 0
  if (r < AI_SUSPECT_THRESHOLDS.low) return 'low'
  if (r < AI_SUSPECT_THRESHOLDS.high) return 'medium'
  return 'high'
})

const aiSuspectLevelLabel: Record<string, string> = { low: '낮음', medium: '보통', high: '높음' }
const aiSuspectLevelClass: Record<string, string> = {
  low: 'text-emerald-600 dark:text-emerald-400',
  medium: 'text-amber-600 dark:text-amber-400',
  high: 'text-red-600 dark:text-red-400',
}

// 현재 필터 라벨 (우측 헤더용)
const aiReviewsFilterLabel = computed(() => {
  if (activeHumanLabel.value !== null) {
    const humanLabelMap: Record<string, string> = { human: '사람 라벨', ad: '광고 라벨', ai: 'AI 라벨', unsure: '애매 라벨' }
    return humanLabelMap[activeHumanLabel.value] ?? activeHumanLabel.value
  }
  if (activeScoreMin.value !== null || activeScoreMax.value !== null) {
    const lo = activeScoreMin.value ?? 0
    const hi = activeScoreMax.value ?? 100
    return `점수 ${lo}-${hi}`
  }
  const map: Record<AiBucket, string> = {
    low_quality: '저품질',
    presumed_human: '사람추정',
    judged: '정밀판정',
    suspect: '의심 리뷰',
    all: '전체',
  }
  return map[activeBucket.value] ?? activeBucket.value
})

// ─── 탭 상태 ─────────────────────────────────────────────────────────────────

type DetailTab = 'reviews' | 'stats' | 'collections' | 'samples' | 'ai-diagnosis' | 'sprint'
const activeTab = ref<DetailTab>('reviews')

// ─── usage(비용) 상태 ────────────────────────────────────────────────────────

interface UsageInfo {
  prompt_tokens: number
  completion_tokens: number
  cost_usd: number
}

interface PlaceUsageSummary {
  total_cost_usd: number
  total_calls: number
  by_kind: { kind: string; calls: number; cost_usd: number }[]
}

// 이번 분석 usage (POST /report 응답에서)
const reportUsage = ref<UsageInfo | null>(null)
// 이번 예시 생성 usage (POST /generate-samples 응답에서)
const samplesUsage = ref<UsageInfo | null>(null)
// 지점 누적 usage (GET /api/places/:id/usage)
const placeUsage = ref<PlaceUsageSummary | null>(null)
const placeUsageStatus = ref<LoadStatus>('idle')

// enum → 한글 매핑
const lengthLabel: Record<string, string> = { short: '한줄', medium: '중간', long: '장문' }

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
    reportUsage.value = (data.meta as unknown as { usage?: UsageInfo }).usage ?? null
    reportStatus.value = 'done'
  } catch (e: unknown) {
    reportError.value = e instanceof Error ? e.message : '알 수 없는 오류'
    reportStatus.value = 'error'
  } finally {
    reportGenerating.value = false
  }
}

// ─── 지점 누적 usage 조회 ─────────────────────────────────────────────────────

async function fetchPlaceUsage(placeId: number) {
  placeUsageStatus.value = 'loading'
  placeUsage.value = null
  try {
    const res = await fetch(`${WORKER_BASE}/api/places/${placeId}/usage`, {
      headers: authHeaders(),
    })
    if (!res.ok) {
      placeUsageStatus.value = 'error'
      return
    }
    const data = await res.json() as PlaceUsageSummary
    placeUsage.value = data
    placeUsageStatus.value = 'done'
  } catch {
    placeUsageStatus.value = 'error'
  }
}

// ─── 리뷰 예시 생성 API (Phase 4-3) ─────────────────────────────────────────

// ─── AI 진단 조회/실행 ──────────────────────────────────────────────────────

async function fetchAiDiagnosis(placeId: number) {
  aiDiagnosisStatus.value = 'loading'
  aiDiagnosisError.value = null
  aiDiagnosis.value = null
  try {
    const params = new URLSearchParams({ suspectThreshold: String(aiDiagnosisThreshold.value) })
    if (humanCorrectionEnabled.value) params.set('humanCorrection', 'true')
    const res = await fetch(`${WORKER_BASE}/api/places/${placeId}/ai-diagnosis?${params}`, {
      headers: authHeaders(),
    })
    if (!res.ok) {
      let msg = `오류 ${res.status}`
      try {
        const body = await res.json() as { message?: string }
        if (body.message) msg = body.message
      } catch { /* ignore */ }
      aiDiagnosisError.value = msg
      aiDiagnosisStatus.value = 'error'
      return
    }
    const data = await res.json() as AiDiagnosisResult
    aiDiagnosis.value = data
    aiDiagnosisStatus.value = 'done'
  } catch (e: unknown) {
    aiDiagnosisError.value = e instanceof Error ? e.message : '알 수 없는 오류'
    aiDiagnosisStatus.value = 'error'
  }
}

async function fetchAiReviews(placeId: number, { reset = true } = {}) {
  if (reset) {
    aiReviewsStatus.value = 'loading'
    aiReviewsError.value = null
    aiReviewsItems.value = []
    aiReviewsTotal.value = 0
    aiReviewsPage.value = 1
    expandedDiagnosisIds.value = new Set()
  } else {
    aiReviewsLoadingMore.value = true
  }
  try {
    const params = new URLSearchParams({
      suspectThreshold: String(aiDiagnosisThreshold.value),
      page: String(reset ? 1 : aiReviewsPage.value),
      size: '30',
    })
    if (humanCorrectionEnabled.value) params.set('humanCorrection', 'true')
    if (activeHumanLabel.value !== null) {
      params.set('humanLabel', activeHumanLabel.value)
    } else if (activeScoreMin.value !== null || activeScoreMax.value !== null) {
      if (activeScoreMin.value !== null) params.set('scoreMin', String(activeScoreMin.value))
      if (activeScoreMax.value !== null) params.set('scoreMax', String(activeScoreMax.value))
    } else {
      params.set('bucket', activeBucket.value)
    }
    const res = await fetch(`${WORKER_BASE}/api/places/${placeId}/ai-reviews?${params}`, {
      headers: authHeaders(),
    })
    if (!res.ok) {
      let msg = `오류 ${res.status}`
      try {
        const body = await res.json() as { message?: string }
        if (body.message) msg = body.message
      } catch { /* ignore */ }
      if (reset) {
        aiReviewsError.value = msg
        aiReviewsStatus.value = 'error'
      }
      return
    }
    const data = await res.json() as { total: number; page: number; size: number; items: AiReviewItem[] }
    aiReviewsTotal.value = data.total
    if (reset) {
      aiReviewsItems.value = data.items
    } else {
      aiReviewsItems.value = [...aiReviewsItems.value, ...data.items]
    }
    if (reset) aiReviewsStatus.value = 'done'
  } catch (e: unknown) {
    if (reset) {
      aiReviewsError.value = e instanceof Error ? e.message : '알 수 없는 오류'
      aiReviewsStatus.value = 'error'
    }
  } finally {
    if (!reset) aiReviewsLoadingMore.value = false
  }
}

function setAiBucket(bucket: AiBucket) {
  activeBucket.value = bucket
  activeScoreMin.value = null
  activeScoreMax.value = null
  activeHumanLabel.value = null
  if (selectedPlace.value) fetchAiReviews(selectedPlace.value.id)
}

function setAiScoreRange(min: number, max: number) {
  activeScoreMin.value = min
  activeScoreMax.value = max
  activeHumanLabel.value = null
  if (selectedPlace.value) fetchAiReviews(selectedPlace.value.id)
}

function setHumanLabelFilter(label: HumanLabel) {
  // 같은 라벨 다시 클릭 시 해제
  if (activeHumanLabel.value === label) {
    activeHumanLabel.value = null
  } else {
    activeHumanLabel.value = label
    activeScoreMin.value = null
    activeScoreMax.value = null
  }
  if (selectedPlace.value) fetchAiReviews(selectedPlace.value.id)
}

async function toggleHumanCorrection() {
  humanCorrectionEnabled.value = !humanCorrectionEnabled.value
  if (selectedPlace.value) {
    await Promise.all([
      fetchAiDiagnosis(selectedPlace.value.id),
      fetchAiReviews(selectedPlace.value.id),
    ])
  }
}

async function saveReviewLabel(reviewId: string, label: HumanLabel, note?: string) {
  if (!selectedPlace.value) return
  const saving = new Set(labelSavingIds.value)
  saving.add(reviewId)
  labelSavingIds.value = saving
  try {
    const res = await fetch(
      `${WORKER_BASE}/api/places/${selectedPlace.value.id}/reviews/${reviewId}/label`,
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ label, note: note ?? null }),
      }
    )
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { message?: string }
      collectToast.value = { type: 'error', message: body.message ?? `라벨 저장 실패 (${res.status})` }
      return
    }
    const data = await res.json() as { ok: boolean; review_id: string; human_label: HumanLabel; human_note: string | null }
    // 로컬 즉시 반영
    const item = aiReviewsItems.value.find(it => it.review_id === reviewId)
    if (item) {
      item.human_label = data.human_label
      item.human_note = data.human_note
    }
    // 닫기
    if (label === null) {
      const next = new Set(labelNoteOpenIds.value)
      next.delete(reviewId)
      labelNoteOpenIds.value = next
    }
  } catch (e: unknown) {
    collectToast.value = { type: 'error', message: e instanceof Error ? e.message : '라벨 저장 중 오류' }
  } finally {
    const s = new Set(labelSavingIds.value)
    s.delete(reviewId)
    labelSavingIds.value = s
  }
}

function toggleLabelNote(reviewId: string) {
  const next = new Set(labelNoteOpenIds.value)
  if (next.has(reviewId)) {
    next.delete(reviewId)
  } else {
    next.add(reviewId)
    // 메모 입력값 초기화 (현재 저장된 값으로)
    const item = aiReviewsItems.value.find(it => it.review_id === reviewId)
    if (item && !(reviewId in labelNoteInputs.value)) {
      labelNoteInputs.value = { ...labelNoteInputs.value, [reviewId]: item.human_note ?? '' }
    }
  }
  labelNoteOpenIds.value = next
}

function commitLabelNote(reviewId: string) {
  const item = aiReviewsItems.value.find(it => it.review_id === reviewId)
  if (!item || item.human_label === null) return
  const note = labelNoteInputs.value[reviewId] ?? ''
  saveReviewLabel(reviewId, item.human_label, note)
  const next = new Set(labelNoteOpenIds.value)
  next.delete(reviewId)
  labelNoteOpenIds.value = next
}

async function loadMoreAiReviews() {
  if (!selectedPlace.value) return
  aiReviewsPage.value += 1
  await fetchAiReviews(selectedPlace.value.id, { reset: false })
}

async function runAiAnalyze(placeId: number, scope: 'suspect' | 'all' | 'heuristic') {
  if (aiAnalyzeRunning.value) return
  // heuristic은 무료이므로 confirm 없이 바로 실행
  if (scope === 'all') {
    const pendingAll = aiDiagnosis.value?.pending_all ?? 0
    if (pendingAll > 300) {
      const ok = confirm(`약 ${pendingAll.toLocaleString('ko-KR')}건 정밀 분석 시 AI API 비용 소액 발생. 진행하시겠습니까?`)
      if (!ok) return
    }
  }
  aiAnalyzeRunning.value = true
  aiAnalyzeError.value = null
  aiAnalyzeSummary.value = null
  try {
    const res = await fetch(`${WORKER_BASE}/api/places/${placeId}/analyze-reviews`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ scope }),
    })
    if (!res.ok) {
      let msg = `분석 실패 (${res.status})`
      try {
        const errBody = await res.json() as { message?: string }
        if (errBody.message) msg = errBody.message
      } catch { /* ignore */ }
      aiAnalyzeError.value = msg
      return
    }
    const data = await res.json() as {
      analyzed?: number
      gpt_called?: number
      usage?: { cost_usd?: number }
    }
    aiAnalyzeSummary.value = {
      analyzed:   data.analyzed   ?? 0,
      gpt_called: data.gpt_called ?? 0,
      cost_usd:   data.usage?.cost_usd ?? 0,
    }
    // 완료 후 결과 자동 재조회
    await fetchAiDiagnosis(placeId)
    await fetchAiReviews(placeId)
  } catch (e: unknown) {
    aiAnalyzeError.value = e instanceof Error ? e.message : '알 수 없는 오류'
  } finally {
    aiAnalyzeRunning.value = false
  }
}

async function runAiRejudge(placeId: number) {
  if (aiRejudgeRunning.value) return
  const gptJudged = aiDiagnosis.value?.gpt_judged ?? 0
  const ok = confirm(`이미 분석된 ${gptJudged.toLocaleString('ko-KR')}건을 정밀 다시 분석합니다. AI API 비용 소액 발생. 진행하시겠습니까?`)
  if (!ok) return
  aiRejudgeRunning.value = true
  aiRejudgeError.value = null
  aiRejudgeSummary.value = null
  try {
    const res = await fetch(`${WORKER_BASE}/api/places/${placeId}/analyze-reviews`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ scope: 'rejudge' }),
    })
    if (!res.ok) {
      let msg = `재판정 실패 (${res.status})`
      try {
        const errBody = await res.json() as { message?: string }
        if (errBody.message) msg = errBody.message
      } catch { /* ignore */ }
      aiRejudgeError.value = msg
      return
    }
    const data = await res.json() as {
      gpt_called?: number
      usage?: { cost_usd?: number }
    }
    aiRejudgeSummary.value = {
      gpt_called: data.gpt_called ?? 0,
      cost_usd:   data.usage?.cost_usd ?? 0,
    }
    await fetchAiDiagnosis(placeId)
    await fetchAiReviews(placeId)
  } catch (e: unknown) {
    aiRejudgeError.value = e instanceof Error ? e.message : '알 수 없는 오류'
  } finally {
    aiRejudgeRunning.value = false
  }
}

// LLM 판별기 실행 — admin 전용, 잠정(단일 평가자 대비)
async function runLLMClassify() {
  if (llmClassifyRunning.value) return
  const ok = confirm(`사람 라벨된 리뷰 전체를 ${llmClassifyModel.value} 모델로 4분류합니다.\nAI API 비용이 소액 발생합니다. 진행하시겠습니까?`)
  if (!ok) return
  llmClassifyRunning.value = true
  llmClassifyError.value = null
  llmClassifySummary.value = null
  // 모델명 → provider 유도 (워커가 provider별 API 키로 분기)
  const m = llmClassifyModel.value
  const provider = m.startsWith('claude') ? 'anthropic'
    : m.startsWith('grok') ? 'xai'
    : 'openai'
  try {
    const res = await fetch(`${WORKER_BASE}/api/labels/llm-classify`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ model: m, provider }),
    })
    if (!res.ok) {
      let msg = `LLM 판별 실패 (${res.status})`
      try {
        const errBody = await res.json() as { message?: string }
        if (errBody.message) msg = errBody.message
      } catch { /* ignore */ }
      llmClassifyError.value = msg
      return
    }
    const data = await res.json() as {
      classified?: number
      cost_usd?: number | null
    }
    llmClassifySummary.value = {
      classified: data.classified ?? 0,
      cost_usd:   data.cost_usd ?? null,
    }
  } catch (e: unknown) {
    llmClassifyError.value = e instanceof Error ? e.message : '알 수 없는 오류'
  } finally {
    llmClassifyRunning.value = false
  }
}

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
    const data = await res.json() as { samples: ReviewSample[]; naturalness_summary?: NaturalnessSummary | null; hallucination_summary?: HallucinationSummary | null }
    samples.value = data.samples ?? []
    naturalnessSummary.value = data.naturalness_summary ?? null
    hallucinationSummary.value = data.hallucination_summary ?? null
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
      body: JSON.stringify({
        count: sampleCount.value,
        provider: sampleProvider.value,
        model: sampleModel.value,
        length: sampleLength.value,
        includeNames: sampleIncludeNames.value,
        humanizeLevel: sampleHumanizeLevel.value,
      }),
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
        } else if (res.status === 503 && code === 'no_anthropic_key') {
          msg = 'Claude API 키가 설정되지 않았습니다.'
        } else if (res.status === 503 && code === 'no_xai_key') {
          msg = 'Grok API 키가 설정되지 않았습니다.'
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
    const data = await res.json() as GenerateSamplesResponse & { usage?: UsageInfo }
    const batchProvider = data.provider ?? sampleProvider.value
    const batchModel = data.model ?? ''
    // 새 생성물에 provider 태그를 붙여 기존 이력 위에 누적
    const newItems = (data.samples ?? []).map(s => ({ ...s, provider: batchProvider }))
    samples.value = [...newItems, ...samples.value]
    samplesUsage.value = data.usage ?? null
    lastGenerationInfo.value = { provider: batchProvider, model: batchModel }
    lastDiversity.value = data.diversity ?? null
    samplesStatus.value = samples.value.length > 0 ? 'done' : 'empty'
  } catch (e: unknown) {
    samplesError.value = e instanceof Error ? e.message : '알 수 없는 오류'
    samplesStatus.value = 'error'
  } finally {
    samplesGenerating.value = false
  }
}

// ─── 예시 관리 API ────────────────────────────────────────────────────────────

async function updateSampleStatus(sampleId: string, status: 'active' | 'kept' | 'archived') {
  if (!selectedPlace.value) return
  if (sampleStatusUpdating.value.has(sampleId)) return

  // 낙관적 업데이트
  const updating = new Set(sampleStatusUpdating.value)
  updating.add(sampleId)
  sampleStatusUpdating.value = updating

  const sample = samples.value.find(s => s.id === sampleId)
  const prevStatus = sample?.status ?? 'active'
  if (sample) sample.status = status

  try {
    const res = await fetch(`${WORKER_BASE}/api/places/${selectedPlace.value.id}/samples/${sampleId}/status`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ status }),
    })
    if (!res.ok) {
      // 롤백
      if (sample) sample.status = prevStatus
      const body = await res.json().catch(() => ({})) as { message?: string }
      collectToast.value = { type: 'error', message: body.message ?? `상태 변경 실패 (${res.status})` }
    }
  } catch (e: unknown) {
    if (sample) sample.status = prevStatus
    collectToast.value = { type: 'error', message: e instanceof Error ? e.message : '상태 변경 중 오류' }
  } finally {
    const ids = new Set(sampleStatusUpdating.value)
    ids.delete(sampleId)
    sampleStatusUpdating.value = ids
  }
}

async function deleteCheckedSamples() {
  if (!selectedPlace.value || checkedSampleIds.value.size === 0) return
  if (sampleDeleteLoading.value) return

  const ids = [...checkedSampleIds.value]
  if (!confirm(`선택한 ${ids.length}개 예시를 삭제할까요? 되돌릴 수 없습니다.`)) return

  sampleDeleteLoading.value = true
  try {
    const res = await fetch(`${WORKER_BASE}/api/places/${selectedPlace.value.id}/samples/delete`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ ids }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { message?: string }
      collectToast.value = { type: 'error', message: body.message ?? `삭제 실패 (${res.status})` }
      return
    }
    // 목록에서 제거
    samples.value = samples.value.filter(s => !ids.includes(s.id))
    checkedSampleIds.value = new Set()
    if (samples.value.length === 0) samplesStatus.value = 'empty'
    collectToast.value = { type: 'success', message: `${ids.length}개 예시 삭제됨` }
  } catch (e: unknown) {
    collectToast.value = { type: 'error', message: e instanceof Error ? e.message : '삭제 중 오류' }
  } finally {
    sampleDeleteLoading.value = false
  }
}

// 필터된 samples computed
const filteredSamples = computed(() => {
  const sortOrder: Record<string, number> = { short: 0, medium: 1, long: 2 }

  return samples.value
    .filter(s => {
      const status = s.status ?? 'active'
      if (status === 'archived' && !showArchived.value) return false
      if (sampleFilter.value === 'kept') return status === 'kept'
      if (sampleFilter.value === 'active') return status === 'active'
      // 태그 필터 (다중 선택 — 각 필터 내 OR, 필터 간 AND)
      if (filterLengths.value.size > 0 && !filterLengths.value.has(s.length)) return false
      return true
    })
    .sort((a, b) => {
      let cmp = 0
      const k = sampleSortKey.value
      if (k === 'created_at') {
        cmp = (a.created_at ?? '').localeCompare(b.created_at ?? '')
      } else if (k === 'length') {
        cmp = (sortOrder[a.length] ?? 99) - (sortOrder[b.length] ?? 99)
      } else if (k === 'provider') {
        cmp = (a.provider ?? '').localeCompare(b.provider ?? '')
      } else if (k === 'status') {
        cmp = (a.status ?? 'active').localeCompare(b.status ?? 'active')
      }
      return sampleSortAsc.value ? cmp : -cmp
    })
})

function toggleSampleCheck(id: string) {
  const next = new Set(checkedSampleIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  checkedSampleIds.value = next
}

function copySampleBody(body: string) {
  navigator.clipboard.writeText(body).catch(() => { /* 무시 */ })
}

function exportSamplesCsv() {
  if (samples.value.length === 0) return
  // 선택된 것이 있으면 선택분만, 없으면 전체
  const target = checkedSampleIds.value.size > 0
    ? samples.value.filter(s => checkedSampleIds.value.has(s.id))
    : samples.value
  if (target.length === 0) return
  const headers = ['본문', '길이', '제공자', '상태', '생성시각']
  const lines = [headers.join(',')]
  for (const s of target) {
    lines.push([
      csvEscape(s.body),
      csvEscape(lengthLabel[s.length] ?? s.length),
      csvEscape(providerLabel[s.provider ?? ''] ?? s.provider ?? ''),
      csvEscape(s.status ?? 'active'),
      csvEscape(s.created_at ? new Date(s.created_at).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''),
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
  samplesUsage.value = null
  reportUsage.value = null
  placeUsage.value = null
  placeUsageStatus.value = 'idle'
  sampleFilter.value = 'all'
  showArchived.value = false
  checkedSampleIds.value = new Set()
  sampleDeleteLoading.value = false
  lastGenerationInfo.value = null
  lastDiversity.value = null
  naturalnessSummary.value = null
  hallucinationSummary.value = null
  aiDiagnosis.value = null
  aiDiagnosisStatus.value = 'idle'
  aiDiagnosisError.value = null
  aiAnalyzeRunning.value = false
  aiAnalyzeError.value = null
  aiAnalyzeSummary.value = null
  aiReviewsItems.value = []
  aiReviewsStatus.value = 'idle'
  aiReviewsError.value = null
  aiReviewsTotal.value = 0
  aiReviewsPage.value = 1
  activeBucket.value = 'suspect'
  activeScoreMin.value = null
  activeScoreMax.value = null
  activeHumanLabel.value = null
  humanCorrectionEnabled.value = false
  labelSavingIds.value = new Set()
  labelNoteOpenIds.value = new Set()
  labelNoteInputs.value = {}
  expandedDiagnosisIds.value = new Set()
  activeTab.value = 'reviews'
  fetchReviews(place.id)
  fetchCollections(place.id)
  fetchPlaceStats(place.id)
  fetchPlaceReport(place.id)
  fetchPlaceUsage(place.id)
  // tester도 예시 생성 접근 허용
  if (authStore.isResearcher || authStore.isTester) fetchSamples(place.id)
  if (authStore.isResearcher) {
    fetchAiDiagnosis(place.id)
    fetchAiReviews(place.id)
  }
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

// 다중 지점 생성 리뷰 CSV 다운로드
async function exportMultiSamplesCsv() {
  if (checkedPlaces.value.length === 0 || multiSamplesCsvLoading.value) return

  const targets = [...checkedPlaces.value]
  multiSamplesCsvLoading.value = true
  multiSamplesCsvProgress.value = { placeIndex: 0, placeTotal: targets.length, rowCount: 0 }

  const allRows: string[] = []

  try {
    for (let i = 0; i < targets.length; i++) {
      const place = targets[i]
      multiSamplesCsvProgress.value = { placeIndex: i + 1, placeTotal: targets.length, rowCount: allRows.length }

      let placeSamples: ReviewSample[]
      try {
        const res = await fetch(`${WORKER_BASE}/api/places/${place.id}/samples`, {
          headers: authHeaders(),
        })
        if (!res.ok) {
          console.warn(`[exportMultiSamplesCsv] ${placeName(place)} fetch 실패: ${res.status}`)
          continue
        }
        const data = await res.json() as { samples: ReviewSample[] }
        placeSamples = data.samples ?? []
      } catch (e: unknown) {
        console.warn(`[exportMultiSamplesCsv] ${placeName(place)} fetch 예외:`, e)
        continue
      }

      if (placeSamples.length === 0) continue

      for (const s of placeSamples) {
        allRows.push([
          csvEscape(placeName(place)),
          csvEscape(s.body),
          csvEscape(lengthLabel[s.length] ?? s.length),
          csvEscape(providerLabel[s.provider ?? ''] ?? s.provider ?? ''),
          csvEscape(s.naturalness != null ? String(s.naturalness) : ''),
          csvEscape(s.slop_hits != null ? String(s.slop_hits) : ''),
          csvEscape((s.slop_top ?? []).join(';')),
          csvEscape(s.created_at ? new Date(s.created_at).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''),
        ].join(','))
      }
    }

    if (allRows.length === 0) {
      collectToast.value = { type: 'warn', message: '생성된 리뷰가 없습니다' }
      return
    }

    const headers = ['지점명', '본문', '길이', '모델(provider)', '자연도', 'slop수', '상위slop', '생성일']
    const csvLines = [headers.join(','), ...allRows]

    const bom = '﻿'
    const blob = new Blob([bom + csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `generated_reviews_${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  } catch (e: unknown) {
    collectToast.value = {
      type: 'error',
      message: `생성 리뷰 CSV 다운로드 실패: ${e instanceof Error ? e.message : '알 수 없는 오류'}`,
    }
  } finally {
    multiSamplesCsvLoading.value = false
    multiSamplesCsvProgress.value = null
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

// ─── 라벨링 스프린트 (Phase 4 보완) ─────────────────────────────────────────

interface SprintItem {
  review_id: string
  body: string
  place_row_id: number
  place_name: string
  length_bucket: 'short' | 'medium' | 'long'
  body_length: number
  review_date: string | null
}

interface SprintStats {
  total: number
  by_label: { human: number; ad: number; ai: number; unsure: number }
  by_place: { place_row_id: number; place_name: string; labeled_count: number }[]
}

// 스프린트 상태
const sprintItems = ref<SprintItem[]>([])
const sprintStatus = ref<LoadStatus>('idle')
const sprintError = ref<string | null>(null)
const sprintIndex = ref(0)  // 현재 보고 있는 항목 인덱스 (0-based)
const sprintNote = ref('')
const sprintSavingId = ref<string | null>(null)
const sprintSaveError = ref<string | null>(null)
const sprintLimit = ref(200)

// 통계
const sprintStats = ref<SprintStats | null>(null)
const sprintStatsStatus = ref<LoadStatus>('idle')

// 현재 스프린트 항목
const sprintCurrent = computed<SprintItem | null>(() => sprintItems.value[sprintIndex.value] ?? null)
const sprintLabeledInSession = ref(0)  // 이번 세션 라벨 횟수
const sprintDoneIds = ref<Set<string>>(new Set())  // 이번 세션에 라벨한 review_id

async function fetchSprintSample() {
  sprintStatus.value = 'loading'
  sprintError.value = null
  sprintItems.value = []
  sprintIndex.value = 0
  sprintNote.value = ''
  sprintLabeledInSession.value = 0
  sprintDoneIds.value = new Set()
  try {
    const res = await fetch(`${WORKER_BASE}/api/places/review-sprint-sample?limit=${sprintLimit.value}`, {
      headers: authHeaders(),
    })
    if (!res.ok) {
      let msg = `오류 ${res.status}`
      try {
        const b = await res.json() as { message?: string }
        if (b.message) msg = b.message
      } catch { /* ignore */ }
      sprintError.value = msg
      sprintStatus.value = 'error'
      return
    }
    const data = await res.json() as { total: number; items: SprintItem[] }
    sprintItems.value = data.items
    sprintStatus.value = data.items.length > 0 ? 'done' : 'done'
  } catch (e: unknown) {
    sprintError.value = e instanceof Error ? e.message : '알 수 없는 오류'
    sprintStatus.value = 'error'
  }
}

async function fetchSprintStats() {
  sprintStatsStatus.value = 'loading'
  try {
    const res = await fetch(`${WORKER_BASE}/api/places/review-sprint-stats`, {
      headers: authHeaders(),
    })
    if (!res.ok) {
      sprintStatsStatus.value = 'error'
      return
    }
    sprintStats.value = await res.json() as SprintStats
    sprintStatsStatus.value = 'done'
  } catch {
    sprintStatsStatus.value = 'error'
  }
}

async function sprintLabel(label: HumanLabel) {
  const item = sprintCurrent.value
  if (!item || sprintSavingId.value) return
  sprintSavingId.value = item.review_id
  sprintSaveError.value = null
  try {
    const res = await fetch(
      `${WORKER_BASE}/api/places/${item.place_row_id}/reviews/${item.review_id}/label`,
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ label, note: sprintNote.value.trim() || null }),
      }
    )
    if (!res.ok) {
      const b = await res.json().catch(() => ({})) as { message?: string }
      sprintSaveError.value = b.message ?? `저장 실패 (${res.status})`
      return
    }
    // 성공: 다음으로 이동
    sprintDoneIds.value = new Set([...sprintDoneIds.value, item.review_id])
    sprintLabeledInSession.value++
    sprintNote.value = ''
    // 현재 항목을 건너뛰고 다음으로
    sprintIndex.value++
    // 통계 낙관적 반영
    if (sprintStats.value && label) {
      sprintStats.value = {
        ...sprintStats.value,
        total: sprintStats.value.total + 1,
        by_label: {
          ...sprintStats.value.by_label,
          [label]: (sprintStats.value.by_label[label] ?? 0) + 1,
        },
      }
    }
  } catch (e: unknown) {
    sprintSaveError.value = e instanceof Error ? e.message : '저장 중 오류'
  } finally {
    sprintSavingId.value = null
  }
}

function sprintSkip() {
  if (sprintIndex.value < sprintItems.value.length - 1) {
    sprintIndex.value++
    sprintNote.value = ''
    sprintSaveError.value = null
  }
}

function sprintPrev() {
  if (sprintIndex.value > 0) {
    sprintIndex.value--
    sprintNote.value = ''
    sprintSaveError.value = null
  }
}

const SPRINT_LABEL_MAP: Record<string, { text: string; short: string; cls: string }> = {
  human:  { text: '진짜손님',   short: '사람',  cls: 'bg-emerald-500 hover:bg-emerald-600 text-white' },
  ad:     { text: '사람마케팅', short: '광고',  cls: 'bg-red-500 hover:bg-red-600 text-white' },
  ai:     { text: 'AI조립',     short: 'AI',    cls: 'bg-amber-500 hover:bg-amber-600 text-white' },
  unsure: { text: '모름',       short: '?',     cls: 'bg-slate-400 hover:bg-slate-500 text-white' },
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

    <!-- ── 등록 폼 (shrink-0) — tester는 지점 등록 불가 ──────────────── -->
    <div v-if="!authStore.isTester" class="shrink-0 flex flex-col gap-1.5">
      <div class="flex items-center gap-2">
        <UInput
          v-model="urlInput"
          placeholder="플레이스 URL 또는 naver.me 단축링크 (예: https://naver.me/...)"
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
        'bg-blue-50 text-blue-700 border-blue-100 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-800': multiBackfillStatus === 'running',
        'bg-green-50 text-green-700 border-green-100 dark:bg-green-900/30 dark:text-green-300 dark:border-green-800': multiBackfillStatus === 'done',
        'bg-amber-50 text-amber-700 border-amber-100 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800': multiBackfillStatus === 'blocked',
        'bg-red-50 text-red-700 border-red-100 dark:bg-red-900/30 dark:text-red-300 dark:border-red-800': multiBackfillStatus === 'error',
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
          <div v-if="multiBackfillCurrentTotal" class="flex-1 min-w-0 h-1.5 rounded-full bg-blue-100 dark:bg-blue-800 overflow-hidden">
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
      <div class="w-60 shrink-0 flex flex-col border border-gray-200 dark:border-slate-700 rounded-lg overflow-hidden">
        <!-- 좌측 헤더 -->
        <div class="shrink-0 flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800">
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
            <span class="text-xs font-medium text-gray-600 dark:text-slate-400">플레이스 목록</span>
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

        <!-- 선택 지점 전체 수집 버튼 + 삭제 버튼 — tester는 수집/삭제 숨김 -->
        <div
          v-if="checkedPlaces.length > 0"
          class="shrink-0 px-2 py-1.5 border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800 flex flex-col gap-1"
        >
          <!-- 수집 버튼: tester 차단 -->
          <template v-if="!authStore.isTester">
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
          </template>
          <!-- CSV: tester 허용 -->
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
            :label="multiSamplesCsvLoading
              ? (multiSamplesCsvProgress ? `받는 중... (지점 ${multiSamplesCsvProgress.placeIndex}/${multiSamplesCsvProgress.placeTotal})` : '받는 중...')
              : `생성 리뷰 CSV (${checkedPlaces.length})`"
            size="xs"
            color="neutral"
            variant="outline"
            icon="i-heroicons-document-arrow-down"
            class="w-full"
            :disabled="checkedPlaces.length === 0 || multiSamplesCsvLoading || multiBackfillRunning"
            :loading="multiSamplesCsvLoading"
            @click="exportMultiSamplesCsv"
          />
          <!-- 삭제 버튼: tester 차단 -->
          <UButton
            v-if="!authStore.isTester"
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
          <UIcon name="i-heroicons-arrow-path" class="w-5 h-5 text-gray-400 dark:text-slate-500 animate-spin" />
        </div>

        <!-- Error -->
        <div v-else-if="placesStatus === 'error'" class="flex-1 flex flex-col items-center justify-center gap-2 p-4">
          <p class="text-xs text-red-500 text-center">{{ placesError }}</p>
          <UButton label="재시도" size="xs" color="neutral" variant="outline" @click="fetchPlaces" />
        </div>

        <!-- Empty -->
        <div v-else-if="placesStatus === 'done' && places.length === 0" class="flex-1 flex items-center justify-center p-4">
          <p class="text-xs text-gray-400 dark:text-slate-500 text-center">등록된 플레이스가 없습니다</p>
        </div>

        <!-- Success: 목록 -->
        <ul v-else class="flex-1 min-h-0 overflow-y-auto divide-y divide-gray-100 dark:divide-slate-700">
          <li
            v-for="place in places"
            :key="place.id"
            class="px-2 py-2.5 cursor-pointer transition-colors"
            :class="selectedPlace?.id === place.id
              ? 'bg-primary-50 text-primary-700 dark:bg-slate-700 dark:text-slate-100'
              : 'hover:bg-gray-50 dark:hover:bg-slate-800 text-gray-700 dark:text-slate-300'"
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
                class="shrink-0 text-gray-400 dark:text-slate-500 hover:text-primary-600 dark:hover:text-primary-400 transition-colors"
                title="네이버 플레이스 리뷰 보기"
                @click.stop
              >
                <UIcon name="i-heroicons-arrow-top-right-on-square" class="w-3.5 h-3.5" />
              </a>
            </div>
            <div class="flex items-center gap-2 mt-0.5 pl-5">
              <span class="text-xs text-gray-400 dark:text-slate-500 tabular-nums">
                리뷰 {{ place.total_reviews != null ? place.total_reviews.toLocaleString('ko-KR') : '—' }}
              </span>
              <span class="text-xs text-gray-300 dark:text-slate-600">·</span>
              <span class="text-xs text-gray-400 dark:text-slate-500">갱신: {{ place.last_collected_at ? formatDate(place.last_collected_at) : '전' }}</span>
              <span class="text-xs text-gray-300 dark:text-slate-600">·</span>
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
                  :class="place.auto_collect === 1 ? 'bg-primary-500' : 'bg-gray-300 dark:bg-slate-600'"
                >
                  <span
                    class="absolute top-0.5 h-2 w-2 rounded-full bg-white shadow transition-transform duration-150"
                    :class="place.auto_collect === 1 ? 'translate-x-2.5' : 'translate-x-0.5'"
                  />
                </span>
                <span
                  class="text-xs"
                  :class="place.auto_collect === 1 ? 'text-primary-600 dark:text-primary-400' : 'text-gray-400 dark:text-slate-500'"
                >{{ place.auto_collect === 1 ? '자동' : '수동' }}</span>
              </button>
            </div>
          </li>
        </ul>
      </div>

      <!-- 우측: 지점 상세 패널 (탭 3개) — h-full flex-col -->
      <div class="flex-1 min-h-0 flex flex-col border border-gray-200 dark:border-slate-700 rounded-lg overflow-hidden">

        <!-- ── 공통 헤더 (shrink-0) ────────────────────────────────── -->
        <div class="shrink-0 flex flex-col border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800">

          <!-- 헤더 행 1: 지점명 + 버튼들 -->
          <div class="flex items-center justify-between px-3 py-2">
            <span class="text-xs font-medium text-gray-600 dark:text-slate-300 min-w-0 truncate">
              <template v-if="selectedPlace">
                {{ placeName(selectedPlace) }}
                <span v-if="reviewsStatus === 'done'" class="font-normal text-gray-400 dark:text-slate-500 ml-1">
                  총 {{ selectedPlace.total_reviews != null ? selectedPlace.total_reviews.toLocaleString('ko-KR') : '—' }}건 중 {{ reviewsTotal.toLocaleString('ko-KR') }}건 보유
                </span>
              </template>
              <template v-else>리뷰</template>
            </span>
            <div class="flex items-center gap-2 shrink-0">
              <!-- 지금 수집 버튼 — tester 차단 -->
              <UButton
                v-if="selectedPlace && !authStore.isTester"
                label="지금 수집"
                size="xs"
                color="primary"
                variant="soft"
                icon="i-heroicons-arrow-down-circle"
                :loading="collectLoading"
                :disabled="backfillRunning"
                @click="collectNow"
              />
              <!-- 전체 수집(백필) 버튼 — tester 차단 -->
              <template v-if="selectedPlace && !authStore.isTester">
                <UButton
                  v-if="backfillStatus === 'done'"
                  label="전체 수집 완료"
                  size="xs"
                  color="neutral"
                  variant="outline"
                  icon="i-heroicons-check-circle"
                  disabled
                />
                <UButton
                  v-else-if="backfillRunning"
                  label="수집 중... (멈춤)"
                  size="xs"
                  color="warning"
                  variant="soft"
                  icon="i-heroicons-pause-circle"
                  @click="stopBackfill"
                />
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
              <!-- CSV 다운로드 버튼 — tester 허용 -->
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

          <!-- 헤더 행 2: 갱신 시각 + 자동 갱신 안내 -->
          <div class="flex items-center justify-between px-3 pb-1.5 gap-3">
            <div class="flex items-center gap-1.5 min-w-0">
              <template v-if="selectedPlace">
                <span class="text-xs text-gray-400 dark:text-slate-500">
                  갱신:
                  <span class="tabular-nums">{{ selectedPlace.last_collected_at ? formatDateTime(selectedPlace.last_collected_at) : '갱신 전' }}</span>
                </span>
              </template>
            </div>
            <div class="flex items-center gap-1 shrink-0 text-gray-400 dark:text-slate-500">
              <UIcon name="i-heroicons-information-circle" class="w-3.5 h-3.5 shrink-0" />
              <span class="text-xs">매일 새벽 3시(KST) 자동 수집됩니다. 지점별 on/off는 좌측 목록에서 설정.</span>
            </div>
          </div>

          <!-- 수집 결과 토스트 -->
          <div
            v-if="collectToast"
            class="px-3 py-1.5 text-xs border-t"
            :class="{
              'bg-green-50 text-green-700 border-green-100 dark:bg-green-900/30 dark:text-green-300 dark:border-green-800': collectToast.type === 'success',
              'bg-amber-50 text-amber-700 border-amber-100 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800': collectToast.type === 'warn',
              'bg-red-50 text-red-700 border-red-100 dark:bg-red-900/30 dark:text-red-300 dark:border-red-800': collectToast.type === 'error',
            }"
          >
            {{ collectToast.message }}
          </div>

          <!-- 백필 진행 상태 바 (단일) -->
          <div
            v-if="selectedPlace && backfillStatus !== 'idle'"
            class="px-3 py-1.5 border-t text-xs flex items-center gap-3"
            :class="{
              'bg-blue-50 text-blue-700 border-blue-100 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-800': backfillStatus === 'running',
              'bg-green-50 text-green-700 border-green-100 dark:bg-green-900/30 dark:text-green-300 dark:border-green-800': backfillStatus === 'done',
              'bg-amber-50 text-amber-700 border-amber-100 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800': backfillStatus === 'blocked',
              'bg-red-50 text-red-700 border-red-100 dark:bg-red-900/30 dark:text-red-300 dark:border-red-800': backfillStatus === 'error',
            }"
          >
            <template v-if="backfillStatus === 'running'">
              <UIcon name="i-heroicons-arrow-path" class="w-3.5 h-3.5 shrink-0 animate-spin" />
              <span class="font-medium whitespace-nowrap">전체 수집 중</span>
              <template v-if="backfillStoredCount !== null">
                <span class="tabular-nums whitespace-nowrap">
                  보유 {{ backfillStoredCount.toLocaleString('ko-KR') }}
                  <template v-if="backfillTotalServer">&nbsp;/&nbsp;총 {{ backfillTotalServer.toLocaleString('ko-KR') }}건
                    <span class="text-blue-500 dark:text-blue-300">({{ Math.min(100, Math.round(backfillStoredCount / backfillTotalServer * 100)) }}%)</span>
                  </template>
                </span>
                <div
                  v-if="backfillTotalServer"
                  class="flex-1 min-w-0 h-1.5 rounded-full bg-blue-100 dark:bg-blue-800 overflow-hidden"
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
            <template v-else-if="backfillStatus === 'done'">
              <UIcon name="i-heroicons-check-circle" class="w-3.5 h-3.5 shrink-0" />
              <span class="font-medium">전체 수집 완료</span>
              <span v-if="backfillStoredCount !== null" class="tabular-nums whitespace-nowrap">
                보유 {{ backfillStoredCount.toLocaleString('ko-KR') }}건
              </span>
            </template>
            <template v-else>
              <UIcon name="i-heroicons-exclamation-triangle" class="w-3.5 h-3.5 shrink-0" />
              <span>{{ backfillMessage }}</span>
            </template>
          </div>

        </div>
        <!-- ── /공통 헤더 ────────────────────────────────────────── -->

        <!-- 플레이스 미선택 안내 (스프린트 탭 활성 시 숨김) -->
        <div v-if="!selectedPlace && activeTab !== 'sprint'" class="flex-1 flex items-center justify-center bg-white dark:bg-slate-900">
          <p class="text-sm text-gray-400 dark:text-slate-500">좌측에서 플레이스를 선택하세요.</p>
        </div>

        <!-- 탭 바 + 탭 콘텐츠 (플레이스 선택 시 또는 스프린트 탭 활성 시) -->
        <template v-if="selectedPlace || activeTab === 'sprint'">

          <!-- ── 탭 바 (shrink-0) ─────────────────────────────────── -->
          <!-- tester: 리뷰 + 예시 생성만 표시 / researcher·admin: 전체 표시 -->
          <div class="shrink-0 flex border-b border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-x-auto">
            <!-- 리뷰 탭: 모두 허용 -->
            <button
              v-if="selectedPlace"
              class="px-4 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap"
              :class="activeTab === 'reviews'
                ? 'border-primary-500 text-primary-600 dark:text-primary-400'
                : 'border-transparent text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-200'"
              @click="activeTab = 'reviews'"
            >
              리뷰
            </button>
            <!-- 통계 탭: tester 차단 -->
            <button
              v-if="selectedPlace && !authStore.isTester"
              class="px-4 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap"
              :class="activeTab === 'stats'
                ? 'border-primary-500 text-primary-600 dark:text-primary-400'
                : 'border-transparent text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-200'"
              @click="activeTab = 'stats'"
            >
              통계
            </button>
            <!-- AI 진단 탭: researcher/admin만 -->
            <button
              v-if="authStore.isResearcher && selectedPlace"
              class="px-4 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap"
              :class="activeTab === 'ai-diagnosis'
                ? 'border-primary-500 text-primary-600 dark:text-primary-400'
                : 'border-transparent text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-200'"
              @click="activeTab = 'ai-diagnosis'"
            >
              AI 진단
            </button>
            <!-- 예시 생성 탭: researcher/admin/tester 허용 -->
            <button
              v-if="(authStore.isResearcher || authStore.isTester) && selectedPlace"
              class="px-4 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap"
              :class="activeTab === 'samples'
                ? 'border-primary-500 text-primary-600 dark:text-primary-400'
                : 'border-transparent text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-200'"
              @click="activeTab = 'samples'"
            >
              예시 생성
            </button>
            <!-- 수집 이력 탭: tester 차단 -->
            <button
              v-if="selectedPlace && !authStore.isTester"
              class="px-4 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap"
              :class="activeTab === 'collections'
                ? 'border-primary-500 text-primary-600 dark:text-primary-400'
                : 'border-transparent text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-200'"
              @click="activeTab = 'collections'"
            >
              수집 이력
            </button>
            <!-- 라벨링 스프린트 탭: researcher/admin만 -->
            <button
              v-if="authStore.isResearcher"
              class="px-4 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap"
              :class="activeTab === 'sprint'
                ? 'border-primary-500 text-primary-600 dark:text-primary-400'
                : 'border-transparent text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-200'"
              @click="activeTab = 'sprint'; fetchSprintStats()"
            >
              라벨링 스프린트
            </button>
          </div>
          <!-- ── /탭 바 ──────────────────────────────────────────── -->

          <!-- ══ 탭 1: 리뷰 ══════════════════════════════════════════ -->
          <div v-show="activeTab === 'reviews'" class="flex-1 min-h-0 flex flex-col">

            <!-- KPI 4카드 (shrink-0) — [통계·AI] 탭과 동일 규격 -->
            <div v-if="statsStatus === 'done' && placeStats" class="shrink-0 flex items-stretch divide-x divide-gray-100 dark:divide-slate-700 border-b border-gray-100 dark:border-slate-700 bg-white dark:bg-slate-900">
              <div class="flex flex-col items-center justify-center px-4 py-2 min-w-0 flex-1 gap-0.5">
                <span class="text-xs text-gray-400 dark:text-slate-500 whitespace-nowrap">저장 리뷰</span>
                <span class="text-base font-semibold tabular-nums text-gray-800 dark:text-slate-100">{{ placeStats.stored_count.toLocaleString('ko-KR') }}</span>
              </div>
              <div class="flex flex-col items-center justify-center px-4 py-2 min-w-0 flex-1 gap-0.5">
                <span class="text-xs text-gray-400 dark:text-slate-500 whitespace-nowrap">답글률</span>
                <span class="text-base font-semibold tabular-nums text-gray-800 dark:text-slate-100">{{ (placeStats.reply_rate * 100).toFixed(1) }}<span class="text-xs font-normal text-gray-400 dark:text-slate-500">%</span></span>
              </div>
              <div class="flex flex-col items-center justify-center px-4 py-2 min-w-0 flex-1 gap-0.5">
                <span class="text-xs text-gray-400 dark:text-slate-500 whitespace-nowrap">사진첨부율</span>
                <span class="text-base font-semibold tabular-nums text-gray-800 dark:text-slate-100">{{ (placeStats.photo_rate * 100).toFixed(1) }}<span class="text-xs font-normal text-gray-400 dark:text-slate-500">%</span></span>
              </div>
              <div class="flex flex-col items-center justify-center px-4 py-2 min-w-0 flex-1 gap-0.5">
                <span class="text-xs text-gray-400 dark:text-slate-500 whitespace-nowrap">서버 총 리뷰</span>
                <span class="text-base font-semibold tabular-nums text-gray-800 dark:text-slate-100">{{ placeStats.total_server != null ? placeStats.total_server.toLocaleString('ko-KR') : '—' }}</span>
              </div>
            </div>
            <div v-else-if="statsStatus === 'loading'" class="shrink-0 flex items-center gap-1.5 px-3 py-1.5 border-b border-gray-100 dark:border-slate-700 bg-white dark:bg-slate-900">
              <UIcon name="i-heroicons-arrow-path" class="w-3 h-3 text-gray-400 dark:text-slate-500 animate-spin shrink-0" />
              <span class="text-xs text-gray-400 dark:text-slate-500">통계 집계 중...</span>
            </div>

            <!-- 리뷰 목록 (flex-1 min-h-0 overflow-y-auto) -->
            <!-- Loading -->
            <div v-if="reviewsStatus === 'loading'" class="flex-1 flex items-center justify-center bg-white dark:bg-slate-900">
              <UIcon name="i-heroicons-arrow-path" class="w-5 h-5 text-gray-400 dark:text-slate-500 animate-spin" />
            </div>
            <!-- Error -->
            <div v-else-if="reviewsStatus === 'error'" class="flex-1 flex flex-col items-center justify-center gap-2 p-4 bg-white dark:bg-slate-900">
              <p class="text-sm text-red-500">{{ reviewsError }}</p>
              <UButton label="재시도" size="sm" color="neutral" variant="outline" @click="retryReviews" />
            </div>
            <!-- Empty -->
            <div v-else-if="reviewsStatus === 'done' && reviews.length === 0" class="flex-1 flex items-center justify-center bg-white dark:bg-slate-900">
              <p class="text-sm text-gray-400 dark:text-slate-500">수집된 리뷰가 없습니다.</p>
            </div>
            <!-- Success -->
            <template v-else>
              <div class="flex-1 min-h-0 overflow-auto bg-white dark:bg-slate-900">
                <table class="w-full text-sm border-collapse">
                  <thead class="sticky top-0 z-10 bg-gray-50 dark:bg-slate-800">
                    <tr class="h-8">
                      <th class="px-3 text-left font-medium text-gray-600 dark:text-slate-400 text-xs whitespace-nowrap border-b border-gray-200 dark:border-slate-700 w-20">작성일</th>
                      <th class="px-3 text-left font-medium text-gray-600 dark:text-slate-400 text-xs whitespace-nowrap border-b border-gray-200 dark:border-slate-700 w-28">작성자</th>
                      <th class="px-3 text-left font-medium text-gray-600 dark:text-slate-400 text-xs border-b border-gray-200 dark:border-slate-700">본문</th>
                      <th class="px-3 text-center font-medium text-gray-600 dark:text-slate-400 text-xs whitespace-nowrap border-b border-gray-200 dark:border-slate-700 w-14">답글</th>
                      <th class="px-3 text-center font-medium text-gray-600 dark:text-slate-400 text-xs whitespace-nowrap border-b border-gray-200 dark:border-slate-700 w-10">사진</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="review in reviews"
                      :key="review.id"
                      class="border-b border-gray-100 dark:border-slate-700 last:border-0 hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors"
                    >
                      <td class="px-3 py-1.5 whitespace-nowrap text-xs text-gray-500 dark:text-slate-400 tabular-nums">
                        {{ formatReviewDate(review.review_date, review.review_created_at) }}
                      </td>
                      <td class="px-3 py-1.5 text-xs text-gray-700 dark:text-slate-300 w-28 max-w-[7rem]">
                        <span class="flex items-center gap-1 min-w-0">
                          <span
                            v-if="isNewReview(review)"
                            class="inline-block shrink-0 w-2 h-2 rounded-full bg-green-500"
                            title="자동 수집으로 새로 포착된 리뷰"
                          />
                          <span class="truncate" :title="review.author_nick || ''">{{ review.author_nick || '—' }}</span>
                        </span>
                      </td>
                      <td class="px-3 py-1.5 text-xs text-gray-800 dark:text-slate-200 max-w-0">
                        <span class="block truncate" :title="review.body || ''">{{ review.body || '—' }}</span>
                      </td>
                      <td class="px-3 py-1.5 text-center text-xs text-gray-500 dark:text-slate-400 whitespace-nowrap">{{ review.owner_reply ? '있음' : '' }}</td>
                      <td class="px-3 py-1.5 text-center text-xs text-gray-500 dark:text-slate-400 whitespace-nowrap">{{ review.has_photo === 1 ? '○' : '' }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <!-- 페이지네이션 (shrink-0) -->
              <div
                v-if="reviewsTotal > LIMIT"
                class="shrink-0 flex items-center justify-between px-3 py-2 border-t border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800"
              >
                <span class="text-xs text-gray-400 dark:text-slate-500">
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
                  <span class="text-xs text-gray-600 dark:text-slate-300 tabular-nums px-1">{{ currentPage }} / {{ Math.ceil(reviewsTotal / LIMIT) }}</span>
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
          <!-- ══ /탭 1: 리뷰 ══════════════════════════════════════════ -->

          <!-- ══ 탭 2: 통계 · AI 인사이트 ════════════════════════════ -->
          <div v-show="activeTab === 'stats'" class="flex-1 min-h-0 overflow-y-auto bg-white dark:bg-slate-900">
            <div class="flex flex-col divide-y divide-gray-100 dark:divide-slate-700">

              <!-- ── 미니 통계 대시보드 ──────────────────────────── -->
              <!-- Loading -->
              <div v-if="statsStatus === 'loading'" class="flex items-center gap-1.5 px-3 py-2">
                <UIcon name="i-heroicons-arrow-path" class="w-3.5 h-3.5 text-gray-400 dark:text-slate-500 animate-spin shrink-0" />
                <span class="text-xs text-gray-400 dark:text-slate-500">통계 집계 중...</span>
              </div>
              <!-- Error -->
              <div v-else-if="statsStatus === 'error'" class="flex items-center gap-1.5 px-3 py-2">
                <UIcon name="i-heroicons-exclamation-circle" class="w-3.5 h-3.5 text-red-400 shrink-0" />
                <span class="text-xs text-red-400">통계 로드 실패 — {{ statsError }}</span>
                <button class="text-xs text-primary-600 hover:text-primary-400 hover:text-primary-800 dark:hover:text-primary-300 transition-colors ml-1" @click="selectedPlace && fetchPlaceStats(selectedPlace.id)">재시도</button>
              </div>
              <!-- Success -->
              <template v-else-if="statsStatus === 'done' && placeStats">

                <!-- KPI 4카드 -->
                <div class="flex items-stretch divide-x divide-gray-100 dark:divide-slate-700">
                  <div class="flex flex-col items-center justify-center px-4 py-2 min-w-0 flex-1 gap-0.5">
                    <span class="text-xs text-gray-400 dark:text-slate-500 whitespace-nowrap">저장 리뷰</span>
                    <span class="text-base font-semibold tabular-nums text-gray-800 dark:text-slate-100">{{ placeStats.stored_count.toLocaleString('ko-KR') }}</span>
                  </div>
                  <div class="flex flex-col items-center justify-center px-4 py-2 min-w-0 flex-1 gap-0.5">
                    <span class="text-xs text-gray-400 dark:text-slate-500 whitespace-nowrap">답글률</span>
                    <span class="text-base font-semibold tabular-nums text-gray-800 dark:text-slate-100">{{ (placeStats.reply_rate * 100).toFixed(1) }}<span class="text-xs font-normal text-gray-400 dark:text-slate-500">%</span></span>
                  </div>
                  <div class="flex flex-col items-center justify-center px-4 py-2 min-w-0 flex-1 gap-0.5">
                    <span class="text-xs text-gray-400 dark:text-slate-500 whitespace-nowrap">사진첨부율</span>
                    <span class="text-base font-semibold tabular-nums text-gray-800 dark:text-slate-100">{{ (placeStats.photo_rate * 100).toFixed(1) }}<span class="text-xs font-normal text-gray-400 dark:text-slate-500">%</span></span>
                  </div>
                  <div class="flex flex-col items-center justify-center px-4 py-2 min-w-0 flex-1 gap-0.5">
                    <span class="text-xs text-gray-400 dark:text-slate-500 whitespace-nowrap">서버 총 리뷰</span>
                    <span class="text-base font-semibold tabular-nums text-gray-800 dark:text-slate-100">{{ placeStats.total_server != null ? placeStats.total_server.toLocaleString('ko-KR') : '—' }}</span>
                  </div>
                </div>

                <!-- 키워드 + 월별 분포 + 추이 -->
                <div class="flex gap-0 divide-x divide-gray-100 dark:divide-slate-700">
                  <!-- 키워드 칩 영역 -->
                  <div v-if="placeStats.top_keywords.length > 0" class="flex-1 min-w-0 px-3 py-2 flex flex-col gap-1.5">
                    <span class="text-xs text-gray-400 dark:text-slate-500">리뷰 본문 단순 빈도 (정밀 분석 예정)</span>
                    <div class="flex flex-wrap gap-1">
                      <span
                        v-for="(kw, i) in placeStats.top_keywords"
                        :key="kw.word"
                        class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-gray-100 dark:bg-slate-700 text-gray-700 dark:text-slate-300 whitespace-nowrap"
                        :class="i < 3 ? 'font-medium text-xs' : 'font-normal text-xs text-gray-500 dark:text-slate-400'"
                        :title="`${kw.count}회`"
                      >{{ kw.word }}<span class="text-gray-400 dark:text-slate-500 text-[10px] tabular-nums">{{ kw.count }}</span></span>
                    </div>
                  </div>
                  <!-- 월별 분포 미니 바 차트 -->
                  <div v-if="placeStats.monthly.length > 0" class="w-52 shrink-0 px-3 py-2 flex flex-col gap-1.5">
                    <span class="text-xs text-gray-400 dark:text-slate-500">월별 리뷰 수 (최근 12개월)</span>
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
                    <div class="flex justify-between text-[10px] text-gray-400 dark:text-slate-500 tabular-nums">
                      <span>{{ placeStats.monthly[0]?.month?.slice(5) }}</span>
                      <span>{{ placeStats.monthly[placeStats.monthly.length - 1]?.month?.slice(5) }}</span>
                    </div>
                  </div>
                  <!-- 스냅샷 추이 -->
                  <div class="w-44 shrink-0 px-3 py-2 flex flex-col gap-1.5">
                    <span class="text-xs text-gray-400 dark:text-slate-500">저장 리뷰 추이</span>
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
                      <div class="flex justify-between text-[10px] text-gray-400 dark:text-slate-500 tabular-nums">
                        <span>{{ placeStats.snapshots[0]?.captured_at?.slice(5,10) }}</span>
                        <span>{{ placeStats.snapshots[placeStats.snapshots.length - 1]?.captured_at?.slice(5,10) }}</span>
                      </div>
                    </template>
                    <div v-else class="flex-1 flex items-center">
                      <span class="text-xs text-gray-400 dark:text-slate-500">데이터 누적 중 (며칠 뒤 표시)</span>
                    </div>
                  </div>
                </div>

              </template>

              <!-- ── AI 인사이트 리포트 ──────────────────────────── -->
              <!-- Loading -->
              <div v-if="reportStatus === 'loading' || reportGenerating" class="flex items-center gap-1.5 px-3 py-2.5">
                <UIcon name="i-heroicons-arrow-path" class="w-3.5 h-3.5 text-gray-400 dark:text-slate-500 animate-spin shrink-0" />
                <span class="text-xs text-gray-400 dark:text-slate-500">{{ reportGenerating ? 'AI 리포트 생성 중 (수 초 소요)...' : 'AI 인사이트 불러오는 중...' }}</span>
              </div>
              <!-- Empty -->
              <div v-else-if="reportStatus === 'empty'" class="flex flex-col items-center justify-center gap-3 px-4 py-8">
                <UIcon name="i-heroicons-sparkles" class="w-8 h-8 text-gray-300 dark:text-slate-600" />
                <div class="flex flex-col items-center gap-1">
                  <span class="text-sm font-medium text-gray-500 dark:text-slate-400">AI 인사이트 리포트가 없습니다</span>
                  <span class="text-xs text-gray-400 dark:text-slate-500">수집된 리뷰를 바탕으로 AI가 강점·개선점을 분석합니다</span>
                </div>
                <UButton
                  label="리포트 생성"
                  size="sm"
                  color="primary"
                  variant="solid"
                  icon="i-heroicons-sparkles"
                  :disabled="reportGenerating"
                  @click="selectedPlace && generateReport(selectedPlace.id)"
                />
              </div>
              <!-- Error -->
              <div v-else-if="reportStatus === 'error'" class="flex items-center gap-1.5 px-3 py-2.5">
                <UIcon name="i-heroicons-exclamation-circle" class="w-3.5 h-3.5 text-red-400 shrink-0" />
                <span v-if="reportErrorCode === 'no_openai_key' || reportErrorCode === 'openai_key_missing'" class="text-xs text-red-500">OpenAI API 키가 설정되지 않았습니다. 관리자에게 문의하세요.</span>
                <span v-else class="text-xs text-red-400">리포트 로드 실패 — {{ reportError }}</span>
                <button class="text-xs text-primary-600 hover:text-primary-800 dark:hover:text-primary-300 transition-colors ml-1" @click="selectedPlace && fetchPlaceReport(selectedPlace.id)">재시도</button>
              </div>
              <!-- Success -->
              <template v-else-if="reportStatus === 'done' && placeReport">

                <!-- 총평 헤더 + 다시 분석 -->
                <div class="flex items-start justify-between gap-3 px-3 py-2.5">
                  <div class="flex items-start gap-1.5 min-w-0">
                    <UIcon name="i-heroicons-sparkles" class="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />
                    <p class="text-xs text-gray-700 dark:text-slate-300 leading-relaxed">
                      <span class="font-medium text-gray-900 dark:text-slate-100">AI 인사이트</span>
                      <span v-if="placeReport.qualitative?.summary" class="text-gray-400 dark:text-slate-500 mx-1">—</span>
                      <span v-if="placeReport.qualitative?.summary">{{ placeReport.qualitative.summary }}</span>
                    </p>
                  </div>
                  <div class="flex flex-col items-end gap-1 shrink-0">
                    <div class="flex items-center gap-2">
                      <span class="text-[10px] text-gray-400 dark:text-slate-500 tabular-nums whitespace-nowrap">
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
                    <!-- 비용 표시 (옵셔널) -->
                    <span v-if="reportUsage" class="text-[10px] text-gray-400 dark:text-slate-500 tabular-nums">
                      이번 분석 ≈ ${{ reportUsage.cost_usd.toFixed(4) }} (입력 {{ (reportUsage.prompt_tokens / 1000).toFixed(1) }}k · 출력 {{ (reportUsage.completion_tokens / 1000).toFixed(1) }}k)
                    </span>
                  </div>
                </div>

                <template v-if="placeReport.qualitative">
                  <!-- 강점 / 개선점 + 감성 분포 + 테마 칩 -->
                  <div class="flex gap-0 divide-x divide-gray-100 dark:divide-slate-700">
                    <div v-if="placeReport.qualitative.strengths?.length" class="flex-1 min-w-0 px-3 py-2 flex flex-col gap-1">
                      <span class="text-[10px] font-medium text-green-700 dark:text-green-400 uppercase tracking-wide">강점</span>
                      <div class="flex flex-col gap-1">
                        <div v-for="s in placeReport.qualitative.strengths" :key="s.point" class="flex flex-col gap-0.5">
                          <span class="text-xs font-medium text-gray-800 dark:text-slate-200">{{ s.point }}</span>
                          <span class="text-[10px] text-gray-400 dark:text-slate-500 italic leading-snug line-clamp-2" :title="s.evidence">"{{ s.evidence }}"</span>
                        </div>
                      </div>
                    </div>
                    <div v-if="placeReport.qualitative.improvements?.length" class="flex-1 min-w-0 px-3 py-2 flex flex-col gap-1">
                      <span class="text-[10px] font-medium text-red-600 dark:text-red-400 uppercase tracking-wide">개선점</span>
                      <div class="flex flex-col gap-1">
                        <div v-for="imp in placeReport.qualitative.improvements" :key="imp.point" class="flex flex-col gap-0.5">
                          <span class="text-xs font-medium text-gray-800 dark:text-slate-200">{{ imp.point }}</span>
                          <span class="text-[10px] text-gray-400 dark:text-slate-500 italic leading-snug line-clamp-2" :title="imp.evidence">"{{ imp.evidence }}"</span>
                        </div>
                      </div>
                    </div>
                    <div v-if="placeReport.qualitative.sentiment" class="w-44 shrink-0 px-3 py-2 flex flex-col gap-1.5">
                      <span class="text-[10px] font-medium text-gray-500 dark:text-slate-400 uppercase tracking-wide">감성 분포</span>
                      <div class="flex h-3 rounded overflow-hidden gap-px">
                        <div v-if="placeReport.qualitative.sentiment.positive > 0" class="bg-green-400" :style="{ width: placeReport.qualitative.sentiment.positive + '%' }" :title="`긍정 ${placeReport.qualitative.sentiment.positive}%`" />
                        <div v-if="placeReport.qualitative.sentiment.neutral > 0" class="bg-gray-300 dark:bg-slate-500" :style="{ width: placeReport.qualitative.sentiment.neutral + '%' }" :title="`중립 ${placeReport.qualitative.sentiment.neutral}%`" />
                        <div v-if="placeReport.qualitative.sentiment.negative > 0" class="bg-red-300" :style="{ width: placeReport.qualitative.sentiment.negative + '%' }" :title="`부정 ${placeReport.qualitative.sentiment.negative}%`" />
                      </div>
                      <div class="flex items-center gap-2 flex-wrap">
                        <span class="flex items-center gap-1 text-[10px] text-gray-500 dark:text-slate-400"><span class="inline-block w-2 h-2 rounded-sm bg-green-400 shrink-0" />긍정 {{ placeReport.qualitative.sentiment.positive }}%</span>
                        <span class="flex items-center gap-1 text-[10px] text-gray-500 dark:text-slate-400"><span class="inline-block w-2 h-2 rounded-sm bg-gray-300 dark:bg-slate-500 shrink-0" />중립 {{ placeReport.qualitative.sentiment.neutral }}%</span>
                        <span class="flex items-center gap-1 text-[10px] text-gray-500 dark:text-slate-400"><span class="inline-block w-2 h-2 rounded-sm bg-red-300 shrink-0" />부정 {{ placeReport.qualitative.sentiment.negative }}%</span>
                      </div>
                    </div>
                    <div v-if="placeReport.qualitative.themes?.length" class="flex-1 min-w-0 px-3 py-2 flex flex-col gap-1.5">
                      <span class="text-[10px] font-medium text-gray-500 dark:text-slate-400 uppercase tracking-wide">테마 키워드</span>
                      <div class="flex flex-wrap gap-1">
                        <span
                          v-for="t in placeReport.qualitative.themes"
                          :key="t.keyword"
                          class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs whitespace-nowrap"
                          :class="{
                            'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300': t.sentiment === 'positive',
                            'bg-gray-100 text-gray-600 dark:bg-slate-700 dark:text-slate-300': t.sentiment === 'neutral',
                            'bg-red-50 text-red-600 dark:bg-red-900/30 dark:text-red-300': t.sentiment === 'negative',
                          }"
                          :title="`${t.mentions}회 언급 · ${t.sentiment === 'positive' ? '긍정' : t.sentiment === 'neutral' ? '중립' : '부정'}`"
                        >
                          {{ t.keyword }}
                          <span
                            class="tabular-nums text-[10px]"
                            :class="{
                              'text-green-500 dark:text-green-400': t.sentiment === 'positive',
                              'text-gray-400 dark:text-slate-500': t.sentiment === 'neutral',
                              'text-red-400 dark:text-red-300': t.sentiment === 'negative',
                            }"
                          >{{ t.mentions }}</span>
                        </span>
                      </div>
                    </div>
                  </div>

                  <!-- 대표 리뷰 (긍/부) -->
                  <div
                    v-if="placeReport.qualitative.representative_reviews && (placeReport.qualitative.representative_reviews.positive?.length || placeReport.qualitative.representative_reviews.negative?.length)"
                    class="flex gap-0 divide-x divide-gray-100 dark:divide-slate-700"
                  >
                    <div v-if="placeReport.qualitative.representative_reviews.positive?.length" class="flex-1 min-w-0 px-3 py-2 flex flex-col gap-1">
                      <span class="text-[10px] font-medium text-green-700 dark:text-green-400 uppercase tracking-wide">긍정 대표 리뷰</span>
                      <div class="flex flex-col gap-1">
                        <blockquote
                          v-for="(q, i) in placeReport.qualitative.representative_reviews.positive.slice(0, 2)"
                          :key="i"
                          class="border-l-2 border-green-200 dark:border-green-700 pl-2 text-[10px] text-gray-600 dark:text-slate-400 italic leading-snug line-clamp-2"
                          :title="q"
                        >{{ q }}</blockquote>
                      </div>
                    </div>
                    <div v-if="placeReport.qualitative.representative_reviews.negative?.length" class="flex-1 min-w-0 px-3 py-2 flex flex-col gap-1">
                      <span class="text-[10px] font-medium text-red-600 dark:text-red-400 uppercase tracking-wide">부정 대표 리뷰</span>
                      <div class="flex flex-col gap-1">
                        <blockquote
                          v-for="(q, i) in placeReport.qualitative.representative_reviews.negative.slice(0, 2)"
                          :key="i"
                          class="border-l-2 border-red-200 dark:border-red-700 pl-2 text-[10px] text-gray-600 dark:text-slate-400 italic leading-snug line-clamp-2"
                          :title="q"
                        >{{ q }}</blockquote>
                      </div>
                    </div>
                  </div>

                </template>
                <div v-else class="px-3 py-1.5">
                  <span class="text-[10px] text-gray-400 dark:text-slate-500">정성 분석 데이터가 없습니다 (정량 데이터만 포함된 리포트)</span>
                </div>

              </template>

              <!-- 지점 누적 usage (옵셔널) -->
              <div v-if="placeUsage" class="px-3 py-2 flex items-center gap-1.5">
                <UIcon name="i-heroicons-currency-dollar" class="w-3.5 h-3.5 text-gray-400 dark:text-slate-500 shrink-0" />
                <span class="text-[10px] text-gray-400 dark:text-slate-500 tabular-nums">
                  이 지점 누적 ≈ ${{ placeUsage.total_cost_usd.toFixed(4) }}
                  <template v-for="k in placeUsage.by_kind" :key="k.kind">
                    · {{ k.kind === 'report' ? '리포트' : k.kind === 'samples' ? '예시' : k.kind }} {{ k.calls }}회
                  </template>
                </span>
              </div>

            </div>
          </div>
          <!-- ══ /탭 2: 통계 · AI 인사이트 ════════════════════════════ -->

          <!-- ══ 탭 3: 예시 생성 (researcher/admin/tester) ════════════════ -->
          <div v-if="authStore.isResearcher || authStore.isTester" v-show="activeTab === 'samples'" class="flex-1 min-h-0 w-full flex flex-col overflow-hidden">

            <!-- 탭 상단 고정 영역 (shrink-0) -->
            <div class="shrink-0 flex flex-col divide-y divide-gray-100 dark:divide-slate-700 border-b border-gray-100 dark:border-slate-700 bg-gray-50 dark:bg-slate-800">
              <!-- 타이틀 행 + 생성 컨트롤 -->
              <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2">
                <div class="flex items-center gap-1.5 shrink-0">
                  <UIcon name="i-heroicons-beaker" class="w-3.5 h-3.5 text-gray-500 dark:text-slate-400 shrink-0" />
                  <span class="text-xs font-medium text-gray-700 dark:text-slate-300 whitespace-nowrap">리뷰 예시 생성</span>
                  <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 whitespace-nowrap">AI 합성·연구용</span>
                </div>
                <div class="flex items-center gap-2 flex-wrap">
                  <!-- 모델 선택 드롭다운 -->
                  <select
                    :value="sampleModel"
                    class="h-7 px-2 py-0 text-xs border border-gray-200 dark:border-slate-700 rounded bg-white dark:bg-slate-800 text-gray-700 dark:text-slate-300 focus:outline-none focus:border-primary-400 cursor-pointer"
                    :disabled="samplesGenerating"
                    @change="onModelSelect(($event.target as HTMLSelectElement).value)"
                  >
                    <option
                      v-for="opt in PROVIDER_OPTIONS"
                      :key="opt.model"
                      :value="opt.model"
                    >{{ opt.label }}</option>
                  </select>
                  <!-- 길이 선택 -->
                  <select
                    v-model="sampleLength"
                    class="h-7 px-2 py-0 text-xs border border-gray-200 dark:border-slate-700 rounded bg-white dark:bg-slate-800 text-gray-700 dark:text-slate-300 focus:outline-none focus:border-primary-400 cursor-pointer"
                    :disabled="samplesGenerating"
                  >
                    <option value="auto">길이 자동</option>
                    <option value="short">한줄</option>
                    <option value="medium">중간</option>
                    <option value="long">장문</option>
                  </select>
                  <!-- 이름 포함 여부 -->
                  <select
                    v-model="sampleIncludeNames"
                    class="h-7 px-2 py-0 text-xs border border-gray-200 dark:border-slate-700 rounded bg-white dark:bg-slate-800 text-gray-700 dark:text-slate-300 focus:outline-none focus:border-primary-400 cursor-pointer"
                    :disabled="samplesGenerating"
                  >
                    <option :value="true">이름 포함</option>
                    <option :value="false">이름 제외</option>
                  </select>
                  <!-- 휴머나이즈 강도 -->
                  <select
                    v-model="sampleHumanizeLevel"
                    class="h-7 px-2 py-0 text-xs border border-gray-200 dark:border-slate-700 rounded bg-white dark:bg-slate-800 text-gray-700 dark:text-slate-300 focus:outline-none focus:border-primary-400 cursor-pointer"
                    :disabled="samplesGenerating"
                  >
                    <option value="off">휴머나이즈 끔</option>
                    <option value="light">약</option>
                    <option value="medium">중</option>
                    <option value="strong">강</option>
                  </select>
                  <span class="text-xs text-gray-500 dark:text-slate-400">개수</span>
                  <input
                    v-model.number="sampleCount"
                    type="number"
                    min="1"
                    max="30"
                    class="w-14 px-2 py-1 text-sm border border-gray-200 dark:border-slate-700 rounded bg-white dark:bg-slate-800 text-gray-900 dark:text-slate-100 text-center tabular-nums focus:outline-none focus:border-primary-400"
                    :disabled="samplesGenerating"
                  />
                  <UButton
                    label="예시 생성"
                    size="xs"
                    color="primary"
                    variant="solid"
                    icon="i-heroicons-sparkles"
                    :loading="samplesGenerating"
                    :disabled="samplesGenerating"
                    @click="selectedPlace && generateSamples(selectedPlace.id)"
                  />
                  <!-- 결과 있을 때만 CSV 노출 -->
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
              <!-- 필터 + 선택삭제 (결과 있을 때) -->
              <div v-if="samples.length > 0" class="flex items-center gap-2 px-3 py-1.5 flex-wrap">
                <!-- 상태 필터 -->
                <div class="flex items-center gap-1">
                  <button
                    v-for="opt in ([{ value: 'all', label: '전체' }, { value: 'kept', label: '좋음' }, { value: 'active', label: '미분류' }] as const)"
                    :key="opt.value"
                    class="px-2 py-0.5 rounded text-xs font-medium transition-colors whitespace-nowrap"
                    :class="sampleFilter === opt.value
                      ? 'bg-primary-100 text-primary-700 dark:bg-primary-900/40 dark:text-primary-300'
                      : 'bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-slate-400 hover:bg-gray-200 dark:hover:bg-slate-600'"
                    @click="sampleFilter = opt.value"
                  >{{ opt.label }}</button>
                </div>
                <span class="text-gray-200 dark:text-slate-600 text-xs">|</span>
                <!-- 길이 태그 필터 -->
                <div class="flex items-center gap-1">
                  <button
                    v-for="[val, lbl] in [['short','한줄'],['medium','중간'],['long','장문']] as const"
                    :key="val"
                    class="px-2 py-0.5 rounded text-xs transition-colors whitespace-nowrap"
                    :class="filterLengths.has(val)
                      ? 'bg-gray-700 dark:bg-slate-500 text-white'
                      : 'bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-slate-400 hover:bg-gray-200 dark:hover:bg-slate-600'"
                    @click="toggleLengthFilter(val)"
                  >{{ lbl }}</button>
                </div>
                <span class="text-gray-200 dark:text-slate-600 text-xs">|</span>
                <button
                  class="flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-colors whitespace-nowrap"
                  :class="showArchived ? 'bg-gray-200 dark:bg-slate-600 text-gray-600 dark:text-slate-300' : 'bg-gray-100 dark:bg-slate-700 text-gray-400 dark:text-slate-500 hover:bg-gray-200 dark:hover:bg-slate-600'"
                  @click="showArchived = !showArchived"
                >
                  <UIcon name="i-heroicons-eye-slash" class="w-3 h-3" />
                  숨김
                </button>
                <template v-if="checkedSampleIds.size > 0 && !authStore.isTester">
                  <span class="text-gray-300 dark:text-slate-600 text-xs">·</span>
                  <UButton
                    :label="`선택 삭제 (${checkedSampleIds.size})`"
                    size="xs"
                    color="error"
                    variant="outline"
                    icon="i-heroicons-trash"
                    :loading="sampleDeleteLoading"
                    :disabled="sampleDeleteLoading"
                    @click="deleteCheckedSamples"
                  />
                </template>
              </div>
              <!-- 비용 표시 + 이번 생성 provider 뱃지 (옵셔널) -->
              <div v-if="samplesUsage || placeUsage || lastGenerationInfo" class="flex items-center gap-3 px-3 py-1.5 flex-wrap">
                <!-- 이번 생성 provider/model 표기 -->
                <span v-if="lastGenerationInfo" class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-indigo-50 dark:bg-indigo-900/30 text-[10px] font-medium text-indigo-700 dark:text-indigo-300 whitespace-nowrap">
                  <UIcon name="i-heroicons-cpu-chip" class="w-3 h-3 shrink-0" />
                  이번 생성: {{ providerLabel[lastGenerationInfo.provider] ?? lastGenerationInfo.provider }}
                  <span v-if="lastGenerationInfo.model" class="font-normal text-indigo-500 dark:text-indigo-400">{{ lastGenerationInfo.model }}</span>
                </span>
                <!-- 배치 다양성 지표 -->
                <UTooltip
                  v-if="lastDiversity"
                  text="낮은 유사도 = 다양한 표현. 최대유사도 55% 이상이면 모드붕괴 주의."
                  :popper="{ placement: 'top' }"
                >
                  <span
                    class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium tabular-nums cursor-default whitespace-nowrap"
                    :class="lastDiversity.maxSimilarity >= 0.55
                      ? 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
                      : 'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300'"
                  >
                    <UIcon name="i-heroicons-chart-bar" class="w-3 h-3 shrink-0" />
                    다양성 distinct-2 {{ (lastDiversity.distinct2 * 100).toFixed(0) }}%
                    · 평균유사도 {{ (lastDiversity.avgSimilarity * 100).toFixed(0) }}%
                    · 최대 {{ (lastDiversity.maxSimilarity * 100).toFixed(0) }}%
                  </span>
                </UTooltip>
                <!-- R2: 배치 자연스러움 지표 (배치 평균·추이 감시용, 개별 합불 판단 아님) -->
                <UTooltip
                  v-if="naturalnessSummary"
                  :text="`자연스러움 점수 — 배치 추이 감시용 지표 (잠정). 개별 합불 판단 아님.\n중간값 ${naturalnessSummary.median} · 최소 ${naturalnessSummary.min} · 평균 slop ${naturalnessSummary.mean_slop_hits}개/건`"
                  :popper="{ placement: 'top' }"
                >
                  <span
                    class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium tabular-nums cursor-default whitespace-nowrap"
                    :class="naturalnessSummary.mean >= 95
                      ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
                      : naturalnessSummary.mean >= 90
                        ? 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
                        : 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300'"
                  >
                    <UIcon name="i-heroicons-beaker" class="w-3 h-3 shrink-0" />
                    자연스러움 {{ naturalnessSummary.mean }}
                    <span class="font-normal opacity-70">/ min {{ naturalnessSummary.min }}</span>
                  </span>
                </UTooltip>
                <!-- 환각 탐지 배치 요약 (soft-flag 조기경보 — 재생성 아님) -->
                <UTooltip
                  v-if="hallucinationSummary && (hallucinationSummary.high + hallucinationSummary.low) > 0"
                  :text="`표면 정규식 기반 조기경보 (오탐 가능). 재생성 아님.\nhigh ${hallucinationSummary.high}건 · low ${hallucinationSummary.low}건`"
                  :popper="{ placement: 'top' }"
                >
                  <span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium cursor-default whitespace-nowrap bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
                    <UIcon name="i-heroicons-exclamation-triangle" class="w-3 h-3 shrink-0" />
                    환각 의심 {{ hallucinationSummary.high + hallucinationSummary.low }}건
                  </span>
                </UTooltip>
                <span v-if="samplesUsage" class="text-[10px] text-gray-400 dark:text-slate-500 tabular-nums">
                  ≈ ${{ samplesUsage.cost_usd.toFixed(4) }} (입력 {{ (samplesUsage.prompt_tokens / 1000).toFixed(1) }}k · 출력 {{ (samplesUsage.completion_tokens / 1000).toFixed(1) }}k)
                </span>
                <span v-if="placeUsage" class="text-[10px] text-gray-400 dark:text-slate-500 tabular-nums">
                  이 지점 누적 ≈ ${{ placeUsage.total_cost_usd.toFixed(4) }}
                  <template v-for="k in placeUsage.by_kind" :key="k.kind">
                    · {{ k.kind === 'report' ? '리포트' : k.kind === 'samples' ? '예시' : k.kind }} {{ k.calls }}회
                  </template>
                </span>
              </div>
            </div>

            <!-- 본문 스크롤 영역 (flex-1 min-h-0) -->
            <div class="flex-1 min-h-0 min-w-0 overflow-auto bg-white dark:bg-slate-900">

              <!-- 생성 중 -->
              <div v-if="samplesStatus === 'generating' || samplesGenerating" class="flex items-center gap-1.5 px-3 py-2.5">
                <UIcon name="i-heroicons-arrow-path" class="w-3.5 h-3.5 text-gray-400 dark:text-slate-500 animate-spin shrink-0" />
                <span class="text-xs text-gray-400 dark:text-slate-500">AI 예시 생성 중 (수 초 소요)...</span>
              </div>
              <!-- Loading -->
              <div v-else-if="samplesStatus === 'loading'" class="flex items-center gap-1.5 px-3 py-2.5">
                <UIcon name="i-heroicons-arrow-path" class="w-3.5 h-3.5 text-gray-400 dark:text-slate-500 animate-spin shrink-0" />
                <span class="text-xs text-gray-400 dark:text-slate-500">예시 이력 불러오는 중...</span>
              </div>
              <!-- Error -->
              <div v-else-if="samplesStatus === 'error'" class="flex items-center gap-1.5 px-3 py-2.5">
                <UIcon name="i-heroicons-exclamation-circle" class="w-3.5 h-3.5 text-red-400 shrink-0" />
                <span class="text-xs text-red-500">{{ samplesError }}</span>
                <button class="text-xs text-primary-600 hover:text-primary-800 dark:hover:text-primary-300 transition-colors ml-1" @click="selectedPlace && fetchSamples(selectedPlace.id)">재시도</button>
              </div>
              <!-- Empty: 안내 텍스트 (생성 컨트롤은 상단 고정 바에 있음) -->
              <div v-else-if="samplesStatus === 'empty' || samplesStatus === 'idle'" class="flex flex-col items-center justify-center gap-3 px-4 py-10">
                <UIcon name="i-heroicons-document-text" class="w-8 h-8 text-gray-300 dark:text-slate-600" />
                <div class="flex flex-col items-center gap-1">
                  <span class="text-sm font-medium text-gray-500 dark:text-slate-400">아직 생성된 예시가 없습니다</span>
                  <span class="text-xs text-gray-400 dark:text-slate-500">위 "예시 생성" 버튼을 눌러 이 지점의 실제 리뷰를 바탕으로 예시를 생성합니다</span>
                </div>
              </div>
              <!-- Success: 테이블 뷰 -->
              <template v-else-if="samplesStatus === 'done' && samples.length > 0">
                <!-- 필터 결과 없음 안내 -->
                <div v-if="filteredSamples.length === 0" class="flex items-center justify-center py-6">
                  <p class="text-xs text-gray-400 dark:text-slate-500">해당 필터에 맞는 예시가 없습니다</p>
                </div>
                <!-- 테이블 -->
                <table v-else class="w-full min-w-[36rem] text-xs border-collapse">
                  <thead class="sticky top-0 z-10 bg-gray-50 dark:bg-slate-800">
                    <tr class="h-8">
                      <!-- 체크박스 전체선택 -->
                      <th class="px-2 text-center border-b border-gray-200 dark:border-slate-700 w-8">
                        <input
                          type="checkbox"
                          class="w-3.5 h-3.5 cursor-pointer accent-primary-600"
                          :checked="filteredSamples.length > 0 && filteredSamples.every(s => checkedSampleIds.has(s.id))"
                          :indeterminate="filteredSamples.some(s => checkedSampleIds.has(s.id)) && !filteredSamples.every(s => checkedSampleIds.has(s.id))"
                          @change="(e) => {
                            const checked = (e.target as HTMLInputElement).checked
                            const next = new Set(checkedSampleIds)
                            filteredSamples.forEach(s => checked ? next.add(s.id) : next.delete(s.id))
                            checkedSampleIds = next
                          }"
                        />
                      </th>
                      <!-- 본문 (정렬 없음) -->
                      <th class="px-3 text-left font-medium text-gray-600 dark:text-slate-400 border-b border-gray-200 dark:border-slate-700">본문</th>
                      <!-- 생성시각 -->
                      <th
                        class="px-3 text-left font-medium text-gray-600 dark:text-slate-400 whitespace-nowrap border-b border-gray-200 dark:border-slate-700 w-32 cursor-pointer select-none hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors"
                        @click="toggleSampleSort('created_at')"
                      >
                        <span class="inline-flex items-center gap-0.5">
                          생성시각
                          <span class="text-gray-400 dark:text-slate-500">
                            <template v-if="sampleSortKey === 'created_at'">{{ sampleSortAsc ? '↑' : '↓' }}</template>
                            <template v-else>↕</template>
                          </span>
                        </span>
                      </th>
                      <!-- 길이 -->
                      <th
                        class="px-3 text-left font-medium text-gray-600 dark:text-slate-400 whitespace-nowrap border-b border-gray-200 dark:border-slate-700 w-14 cursor-pointer select-none hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors"
                        @click="toggleSampleSort('length')"
                      >
                        <span class="inline-flex items-center gap-0.5">
                          길이
                          <span class="text-gray-400 dark:text-slate-500">
                            <template v-if="sampleSortKey === 'length'">{{ sampleSortAsc ? '↑' : '↓' }}</template>
                            <template v-else>↕</template>
                          </span>
                        </span>
                      </th>
                      <!-- 제공자 -->
                      <th
                        class="px-3 text-left font-medium text-gray-600 dark:text-slate-400 whitespace-nowrap border-b border-gray-200 dark:border-slate-700 w-16 cursor-pointer select-none hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors"
                        @click="toggleSampleSort('provider')"
                      >
                        <span class="inline-flex items-center gap-0.5">
                          제공자
                          <span class="text-gray-400 dark:text-slate-500">
                            <template v-if="sampleSortKey === 'provider'">{{ sampleSortAsc ? '↑' : '↓' }}</template>
                            <template v-else>↕</template>
                          </span>
                        </span>
                      </th>
                      <!-- 상태 -->
                      <th
                        class="px-3 text-left font-medium text-gray-600 dark:text-slate-400 whitespace-nowrap border-b border-gray-200 dark:border-slate-700 w-14 cursor-pointer select-none hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors"
                        @click="toggleSampleSort('status')"
                      >
                        <span class="inline-flex items-center gap-0.5">
                          상태
                          <span class="text-gray-400 dark:text-slate-500">
                            <template v-if="sampleSortKey === 'status'">{{ sampleSortAsc ? '↑' : '↓' }}</template>
                            <template v-else>↕</template>
                          </span>
                        </span>
                      </th>
                      <!-- 자연스러움 (잠정 지표) -->
                      <th class="px-3 text-left font-medium text-gray-600 dark:text-slate-400 whitespace-nowrap border-b border-gray-200 dark:border-slate-700 w-16">
                        <UTooltip text="자연스러움 점수 (잠정·배치추이용). 개별 합불 판단 아님." :popper="{ placement: 'top' }">
                          <span class="cursor-default">자연도</span>
                        </UTooltip>
                      </th>
                      <!-- 환각 탐지 (soft-flag) -->
                      <th class="px-3 text-left font-medium text-gray-600 dark:text-slate-400 whitespace-nowrap border-b border-gray-200 dark:border-slate-700 w-10">
                        <UTooltip text="표면 정규식 조기경보 (오탐 가능). 재생성 아님." :popper="{ placement: 'top' }">
                          <span class="cursor-default">환각</span>
                        </UTooltip>
                      </th>
                      <!-- 액션 -->
                      <th class="px-3 border-b border-gray-200 dark:border-slate-700 w-20" />
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="sample in filteredSamples"
                      :key="sample.id"
                      class="border-b border-gray-100 dark:border-slate-700 last:border-0 transition-colors group"
                      :class="{
                        'opacity-40': (sample.status ?? 'active') === 'archived',
                        'border-l-2 border-emerald-400': (sample.status ?? 'active') === 'kept',
                        'hover:bg-gray-50 dark:hover:bg-slate-800': (sample.status ?? 'active') !== 'archived',
                      }"
                    >
                      <!-- 체크박스 -->
                      <td class="px-2 py-1.5 text-center align-top">
                        <input
                          type="checkbox"
                          class="mt-0.5 w-3.5 h-3.5 shrink-0 cursor-pointer accent-primary-600"
                          :checked="checkedSampleIds.has(sample.id)"
                          @change="toggleSampleCheck(sample.id)"
                        />
                      </td>
                      <!-- 본문 (클릭 토글 펼침) -->
                      <td
                        class="px-3 py-1.5 text-gray-800 dark:text-slate-200 cursor-pointer max-w-0 align-top"
                        @click="toggleExpandSample(sample.id)"
                      >
                        <span
                          v-if="expandedSampleIds.has(sample.id)"
                          class="block text-xs leading-relaxed whitespace-pre-wrap"
                        >{{ sample.body }}</span>
                        <span
                          v-else
                          class="block text-xs leading-relaxed line-clamp-2"
                          :title="sample.body"
                        >{{ sample.body }}</span>
                      </td>
                      <!-- 생성시각 -->
                      <td class="px-3 py-1.5 whitespace-nowrap text-gray-400 dark:text-slate-500 tabular-nums align-top">
                        {{ sample.created_at ? new Date(sample.created_at).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—' }}
                      </td>
                      <!-- 길이 -->
                      <td class="px-3 py-1.5 whitespace-nowrap align-top">
                        <span class="inline-flex items-center px-1.5 py-0.5 rounded bg-gray-100 dark:bg-slate-700 text-[10px] text-gray-600 dark:text-slate-300">{{ lengthLabel[sample.length] ?? sample.length }}</span>
                      </td>
                      <!-- 제공자 -->
                      <td class="px-3 py-1.5 whitespace-nowrap align-top">
                        <span
                          v-if="sample.provider"
                          class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] whitespace-nowrap"
                          :class="{
                            'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300': sample.provider === 'openai',
                            'bg-orange-50 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300': sample.provider === 'anthropic',
                            'bg-violet-50 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300': sample.provider === 'xai',
                            'bg-gray-100 text-gray-600 dark:bg-slate-700 dark:text-slate-300': !['openai','anthropic','xai'].includes(sample.provider),
                          }"
                        >{{ providerLabel[sample.provider] ?? sample.provider }}</span>
                        <span v-else class="text-gray-300 dark:text-slate-600">—</span>
                      </td>
                      <!-- 상태 -->
                      <td class="px-3 py-1.5 whitespace-nowrap align-top">
                        <span
                          v-if="(sample.status ?? 'active') === 'kept'"
                          class="inline-flex items-center px-1.5 py-0.5 rounded bg-emerald-50 dark:bg-emerald-900/30 text-[10px] text-emerald-700 dark:text-emerald-300"
                        >좋음</span>
                        <span
                          v-else-if="(sample.status ?? 'active') === 'archived'"
                          class="inline-flex items-center px-1.5 py-0.5 rounded bg-gray-100 dark:bg-slate-700 text-[10px] text-gray-500 dark:text-slate-400"
                        >숨김</span>
                      </td>
                      <!-- 자연스러움 점수 (R2: 배치 추이 감시용, 개별 합불 아님) -->
                      <td class="px-3 py-1.5 whitespace-nowrap align-top">
                        <template v-if="sample.naturalness != null">
                          <UTooltip
                            :text="sample.slop_hits && sample.slop_hits > 0
                              ? `slop ${sample.slop_hits}개: ${(sample.slop_top ?? []).join(', ')}`
                              : 'slop 없음'"
                            :popper="{ placement: 'top' }"
                          >
                            <span
                              class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium tabular-nums cursor-default"
                              :class="sample.naturalness >= 95
                                ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
                                : sample.naturalness >= 90
                                  ? 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
                                  : 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300'"
                            >{{ sample.naturalness }}</span>
                          </UTooltip>
                          <span v-if="sample.slop_hits && sample.slop_hits > 0" class="ml-1 text-[10px] text-gray-400 dark:text-slate-500 tabular-nums">s{{ sample.slop_hits }}</span>
                        </template>
                        <span v-else class="text-gray-300 dark:text-slate-600">—</span>
                      </td>
                      <!-- 환각 탐지 배지 (soft-flag 조기경보 — risk=none이면 미표시) -->
                      <td class="px-3 py-1.5 whitespace-nowrap align-top">
                        <UTooltip
                          v-if="sample.hallucination && sample.hallucination.risk !== 'none'"
                          :text="`표면 정규식 조기경보 (오탐 가능). 재생성 아님.\n` + (sample.hallucination.flags ?? []).map(f => `${f.type}: ${f.text}`).join('\n')"
                          :popper="{ placement: 'top' }"
                        >
                          <span
                            class="inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-[10px] font-medium cursor-default"
                            :class="sample.hallucination.risk === 'high'
                              ? 'bg-red-50 text-red-600 dark:bg-red-900/30 dark:text-red-400'
                              : 'bg-amber-50 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400'"
                          >
                            <UIcon name="i-heroicons-exclamation-triangle" class="w-3 h-3 shrink-0" />
                          </span>
                        </UTooltip>
                      </td>
                      <!-- 액션 버튼 (hover) -->
                      <td class="px-3 py-1.5 whitespace-nowrap align-top">
                        <div class="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                          <!-- 좋음 토글 -->
                          <button
                            class="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] transition-colors"
                            :class="(sample.status ?? 'active') === 'kept'
                              ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300'
                              : 'text-gray-400 dark:text-slate-500 hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20'"
                            :disabled="sampleStatusUpdating.has(sample.id)"
                            :title="(sample.status ?? 'active') === 'kept' ? '좋음 해제' : '좋음으로 표시'"
                            @click="updateSampleStatus(sample.id, (sample.status ?? 'active') === 'kept' ? 'active' : 'kept')"
                          >
                            <UIcon name="i-heroicons-star" class="w-3 h-3" />
                          </button>
                          <!-- 숨김 토글 -->
                          <button
                            class="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] transition-colors"
                            :class="(sample.status ?? 'active') === 'archived'
                              ? 'bg-gray-200 dark:bg-slate-600 text-gray-600 dark:text-slate-300'
                              : 'text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-700'"
                            :disabled="sampleStatusUpdating.has(sample.id)"
                            :title="(sample.status ?? 'active') === 'archived' ? '숨김 해제' : '숨김'"
                            @click="updateSampleStatus(sample.id, (sample.status ?? 'active') === 'archived' ? 'active' : 'archived')"
                          >
                            <UIcon name="i-heroicons-eye-slash" class="w-3 h-3" />
                          </button>
                          <!-- 복사 -->
                          <button
                            class="p-0.5 rounded text-gray-400 dark:text-slate-500 hover:text-gray-700 dark:hover:text-slate-200 transition-colors"
                            title="본문 복사"
                            @click="copySampleBody(sample.body)"
                          >
                            <UIcon name="i-heroicons-clipboard-document" class="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </template>

            </div>
          </div>
          <!-- ══ /탭 3: 예시 생성 ════════════════════════════════════ -->

          <!-- ══ 탭 4: AI 진단 (researcher/admin 전용) ════════════════ -->
          <div v-if="authStore.isResearcher" v-show="activeTab === 'ai-diagnosis'" class="h-full flex flex-col overflow-hidden">

            <!-- 상단 바 (shrink-0) -->
            <div class="shrink-0 flex items-center gap-3 px-3 py-2 border-b border-gray-100 dark:border-slate-700 bg-gray-50 dark:bg-slate-800 flex-wrap">
              <!-- 좌: 타이틀 + disclaimer -->
              <div class="flex items-center gap-2 min-w-0 flex-1">
                <span class="text-xs font-semibold text-gray-700 dark:text-slate-200 shrink-0">AI 진단</span>
                <UIcon name="i-heroicons-information-circle" class="w-3.5 h-3.5 text-amber-500 dark:text-amber-400 shrink-0" />
                <span class="text-[11px] text-amber-700 dark:text-amber-300 leading-snug">확률적 추정 — 근거와 함께 참고용</span>
              </div>
              <!-- 우: 의심 기준 슬라이더 -->
              <div class="flex items-center gap-2 shrink-0">
                <span class="text-[11px] text-gray-500 dark:text-slate-400 whitespace-nowrap">의심 기준</span>
                <input
                  v-model.number="aiDiagnosisThreshold"
                  type="range"
                  min="0"
                  max="100"
                  step="5"
                  class="w-20 h-1.5 accent-primary-500 cursor-pointer"
                  @change="selectedPlace && (fetchAiDiagnosis(selectedPlace.id), fetchAiReviews(selectedPlace.id))"
                />
                <span class="text-xs font-semibold tabular-nums text-gray-700 dark:text-slate-300 w-7 shrink-0">{{ aiDiagnosisThreshold }}</span>
              </div>
            </div>

            <!-- 본문: 2분할 -->
            <div class="flex-1 min-h-0 flex flex-row gap-0 overflow-hidden">

              <!-- ── 좌측 패널 (320px 고정) ── -->
              <div class="w-[320px] shrink-0 overflow-y-auto border-r border-gray-100 dark:border-slate-700 flex flex-col gap-2 p-3">

                <!-- LLM 판별기 (잠정·검증전) — 항상 표시. 사람 라벨 전체 대비 4분류 일치율 측정용 -->
                <div class="rounded border border-amber-200 dark:border-amber-900/40 px-3 py-2 flex flex-col gap-1.5 bg-amber-50/50 dark:bg-amber-900/10">
                  <div class="flex items-center gap-1.5">
                    <span class="text-[11px] font-semibold text-amber-600 dark:text-amber-400 shrink-0">LLM 판별</span>
                    <span class="text-[10px] text-gray-400 dark:text-slate-500">잠정·검증전 (사람 라벨 전체 대상)</span>
                  </div>
                  <div class="flex items-center gap-1.5">
                    <select
                      v-model="llmClassifyModel"
                      class="text-[11px] border border-gray-200 dark:border-slate-600 rounded px-1.5 py-0.5 bg-white dark:bg-slate-700 text-gray-700 dark:text-slate-200 flex-1 min-w-0"
                      :disabled="llmClassifyRunning"
                    >
                      <option value="gpt-5.4-mini">gpt-5.4-mini (저가)</option>
                      <option value="claude-haiku-4-5-20251001">claude-haiku (저가)</option>
                      <option value="claude-sonnet-4-6">claude-sonnet</option>
                      <option value="claude-opus-4-8">claude-opus</option>
                      <option value="grok-4.3">grok-4.3</option>
                    </select>
                    <UButton
                      label="실행"
                      size="xs"
                      color="warning"
                      variant="solid"
                      icon="i-heroicons-beaker"
                      :loading="llmClassifyRunning"
                      :disabled="llmClassifyRunning"
                      title="사람 라벨된 리뷰를 LLM으로 4분류 — 잠정(단일 평가자 대비), IAA 검증 전"
                      @click="runLLMClassify"
                    />
                  </div>
                  <div v-if="llmClassifySummary" class="flex items-center gap-1 text-[11px] text-gray-500 dark:text-slate-400">
                    <UIcon name="i-heroicons-check-circle" class="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                    판별 {{ llmClassifySummary.classified }}건
                    <span v-if="llmClassifySummary.cost_usd !== null"> · ${{ llmClassifySummary.cost_usd?.toFixed(4) }}</span>
                  </div>
                  <div v-if="llmClassifyError" class="flex items-center gap-1 text-[11px] text-red-500">
                    <UIcon name="i-heroicons-exclamation-circle" class="w-3 h-3 shrink-0" />{{ llmClassifyError }}
                  </div>
                </div>

                <!-- 진단 로딩 -->
                <div v-if="aiDiagnosisStatus === 'loading'" class="flex items-center justify-center py-6">
                  <UIcon name="i-heroicons-arrow-path" class="w-5 h-5 text-gray-400 dark:text-slate-500 animate-spin" />
                </div>

                <!-- 진단 에러 -->
                <div v-else-if="aiDiagnosisStatus === 'error'" class="flex flex-col items-center gap-2 py-6 px-2">
                  <UIcon name="i-heroicons-exclamation-circle" class="w-5 h-5 text-red-400 shrink-0" />
                  <p class="text-xs text-red-500 text-center">{{ aiDiagnosisError }}</p>
                  <button class="text-xs text-primary-600 hover:text-primary-800 dark:hover:text-primary-300" @click="selectedPlace && fetchAiDiagnosis(selectedPlace.id)">재시도</button>
                </div>

                <!-- 진단 결과 있을 때 -->
                <template v-else-if="aiDiagnosisStatus === 'done' && aiDiagnosis">

                  <!-- 미분석 빈 상태: 한 건도 분석되지 않았을 때 -->
                  <div v-if="aiDiagnosis.total_analyzed === 0" class="flex flex-col items-center gap-3 py-6 px-2 text-center">
                    <UIcon name="i-heroicons-beaker" class="w-8 h-8 text-gray-300 dark:text-slate-600" />
                    <p class="text-xs font-medium text-gray-600 dark:text-slate-300">아직 진단을 실행하지 않았습니다</p>
                    <p class="text-[11px] text-gray-400 dark:text-slate-500 leading-snug">
                      무료 진단으로 1차 분류를 시작하세요.<br>비용이 들지 않습니다.
                    </p>
                    <UButton
                      v-if="authStore.isAdmin"
                      label="무료 진단 시작"
                      size="sm"
                      color="primary"
                      variant="outline"
                      icon="i-heroicons-beaker"
                      :loading="aiAnalyzeRunning"
                      :disabled="aiAnalyzeRunning"
                      @click="selectedPlace && runAiAnalyze(selectedPlace.id, 'heuristic')"
                    />
                  </div>

                  <!-- 1+2: 요약 + 분석 흐름 통합 — 분석 결과 있을 때만 -->
                  <template v-if="aiDiagnosis.total_analyzed > 0">
                  <div class="rounded border border-gray-100 dark:border-slate-700 px-3 py-2 flex flex-col gap-1.5 bg-white dark:bg-slate-800">
                    <!-- 요약 행: 의심 건수 강조 + 요약 수치 -->
                    <div class="flex items-center gap-2">
                      <button class="flex items-baseline gap-1 shrink-0 hover:opacity-80" @click="setAiBucket('suspect')" title="의심 리뷰 보기">
                        <span class="text-xl font-bold tabular-nums text-red-500 dark:text-red-400">{{ aiDiagnosis.suspect }}</span>
                        <span class="text-[11px] font-semibold text-red-500 dark:text-red-400">의심</span>
                      </button>
                      <span class="text-gray-300 dark:text-slate-600">|</span>
                      <span class="text-[11px] tabular-nums font-semibold" :class="aiSuspectLevelClass[aiSuspectLevel]">{{ Math.round(aiDiagnosis.suspect_rate * 100) }}% {{ aiSuspectLevelLabel[aiSuspectLevel] }}</span>
                      <span v-if="humanCorrectionEnabled" class="text-[10px] text-primary-600 dark:text-primary-400 font-medium ml-auto shrink-0">(사람 보정)</span>
                    </div>
                    <!-- 세그먼트 바 -->
                    <div class="flex h-4 rounded overflow-hidden w-full gap-px">
                      <button
                        v-if="aiDiagnosis.presumed_human > 0"
                        class="h-full transition-opacity hover:opacity-80"
                        :style="{ width: `${Math.round(aiDiagnosis.presumed_human / aiDiagnosis.total_analyzed * 100)}%`, minWidth: '4px', background: '#94a3b8' }"
                        :class="activeBucket === 'presumed_human' && activeScoreMin === null ? 'ring-2 ring-inset ring-white' : ''"
                        :title="`사람추정 ${aiDiagnosis.presumed_human}건`"
                        @click="setAiBucket('presumed_human')"
                      />
                      <button
                        v-if="(aiDiagnosis.heuristic_suspect ?? 0) > 0"
                        class="h-full transition-opacity hover:opacity-80"
                        :style="{ width: `${Math.round((aiDiagnosis.heuristic_suspect ?? 0) / aiDiagnosis.total_analyzed * 100)}%`, minWidth: '4px', background: '#a78bfa' }"
                        :title="`휴리스틱추정 ${aiDiagnosis.heuristic_suspect ?? 0}건`"
                      />
                      <button
                        v-if="(aiDiagnosis.gpt_judged - aiDiagnosis.suspect) > 0"
                        class="h-full transition-opacity hover:opacity-80"
                        :style="{ width: `${Math.round((aiDiagnosis.gpt_judged - aiDiagnosis.suspect) / aiDiagnosis.total_analyzed * 100)}%`, minWidth: '4px', background: '#60a5fa' }"
                        :class="activeBucket === 'judged' && activeScoreMin === null ? 'ring-2 ring-inset ring-white' : ''"
                        :title="`정밀 비의심 ${aiDiagnosis.gpt_judged - aiDiagnosis.suspect}건`"
                        @click="setAiBucket('judged')"
                      />
                      <button
                        v-if="aiDiagnosis.suspect > 0"
                        class="h-full transition-opacity hover:opacity-80"
                        :style="{ width: `${Math.round(aiDiagnosis.suspect / aiDiagnosis.total_analyzed * 100)}%`, minWidth: '4px', background: '#f87171' }"
                        :class="activeBucket === 'suspect' && activeScoreMin === null ? 'ring-2 ring-inset ring-white' : ''"
                        :title="`의심 ${aiDiagnosis.suspect}건`"
                        @click="setAiBucket('suspect')"
                      />
                    </div>
                    <!-- 범례 한 줄 -->
                    <div class="flex items-center gap-x-2.5 gap-y-0.5 flex-wrap">
                      <button class="flex items-center gap-1 text-[11px] text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-200" @click="setAiBucket('all')">
                        <span class="inline-block w-1.5 h-1.5 rounded-sm bg-gray-300 dark:bg-slate-600"></span>전체 {{ aiDiagnosis.total_analyzed }}
                      </button>
                      <button class="flex items-center gap-1 text-[11px] text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-200" @click="setAiBucket('presumed_human')">
                        <span class="inline-block w-1.5 h-1.5 rounded-sm" style="background:#94a3b8"></span>사람추정 {{ aiDiagnosis.presumed_human }}
                      </button>
                      <span class="flex items-center gap-1 text-[11px] text-violet-500 dark:text-violet-400">
                        <span class="inline-block w-1.5 h-1.5 rounded-sm" style="background:#a78bfa"></span>휴리스틱추정 {{ aiDiagnosis.heuristic_suspect ?? 0 }}
                      </span>
                      <button class="flex items-center gap-1 text-[11px] text-blue-500 dark:text-blue-400 hover:opacity-80" @click="setAiBucket('judged')">
                        <span class="inline-block w-1.5 h-1.5 rounded-sm" style="background:#60a5fa"></span>정밀 {{ aiDiagnosis.gpt_judged }}
                      </button>
                      <button class="flex items-center gap-1 text-[11px] text-red-500 dark:text-red-400 font-medium hover:opacity-80" @click="setAiBucket('suspect')">
                        <span class="inline-block w-1.5 h-1.5 rounded-sm" style="background:#f87171"></span>의심 {{ aiDiagnosis.suspect }}
                      </button>
                      <button class="flex items-center gap-1 text-[11px] text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300" @click="setAiBucket('low_quality')">
                        저품질 {{ aiDiagnosis.low_quality }}
                      </button>
                    </div>
                  </div>

                  <!-- 3: 점수 분포 — 가로 1줄 압축 -->
                  <div v-if="(aiDiagnosis.gpt_judged + (aiDiagnosis.heuristic_suspect ?? 0)) > 0" class="rounded border border-gray-100 dark:border-slate-700 px-3 py-1.5 flex items-center gap-2 bg-white dark:bg-slate-800">
                    <span class="text-[11px] font-medium text-gray-400 dark:text-slate-500 shrink-0">점수 분포</span>
                    <div class="flex items-end gap-0.5 flex-1 min-w-0">
                      <div
                        v-for="(bkt, idx) in ['0-19','20-39','40-59','60-79','80-100']"
                        :key="bkt"
                        class="flex flex-col items-center gap-0.5 flex-1 min-w-0 cursor-pointer"
                        :title="`점수대 ${bkt} (${aiDiagnosis.distribution[bkt] ?? 0}건, 분석 ${aiDiagnosis.gpt_judged + (aiDiagnosis.heuristic_suspect ?? 0)}건 기준) — 클릭해서 조회`"
                        @click="setAiScoreRange(parseInt(bkt.split('-')[0]), parseInt(bkt.split('-')[1]))"
                      >
                        <span class="text-[10px] tabular-nums text-gray-500 dark:text-slate-400 leading-none">{{ aiDiagnosis.distribution[bkt] ?? 0 }}</span>
                        <div
                          class="w-full rounded-sm hover:opacity-75 transition-opacity"
                          :class="[
                            idx >= 3 ? 'bg-red-400 dark:bg-red-500' : idx === 2 ? 'bg-amber-300 dark:bg-amber-500' : 'bg-gray-200 dark:bg-slate-600',
                            activeScoreMin === parseInt(bkt.split('-')[0]) ? 'ring-2 ring-primary-400' : ''
                          ]"
                          :style="{ height: `${Math.max(4, Math.round(((aiDiagnosis.distribution[bkt] ?? 0) / (aiDiagnosis.gpt_judged + (aiDiagnosis.heuristic_suspect ?? 0))) * 28))}px` }"
                        />
                        <span class="text-[10px] text-gray-400 dark:text-slate-500 whitespace-nowrap leading-none">{{ bkt }}</span>
                      </div>
                    </div>
                  </div>

                  <!-- 4: 플래그 집계 — 한 줄 인라인 -->
                  <div v-if="Object.keys(aiDiagnosis.flag_breakdown).length > 0" class="rounded border border-gray-100 dark:border-slate-700 px-3 py-1.5 flex items-start gap-2 bg-white dark:bg-slate-800">
                    <span class="text-[11px] font-medium text-gray-400 dark:text-slate-500 shrink-0 pt-0.5">플래그</span>
                    <div class="flex flex-wrap gap-1">
                      <span
                        v-for="(cnt, flag) in Object.fromEntries(Object.entries(aiDiagnosis.flag_breakdown).sort((a,b) => (b[1] as number)-(a[1] as number)))"
                        :key="flag"
                        class="inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-[11px] bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300"
                        :title="String(flag)"
                      >
                        <span>{{ flagLabel(String(flag)) }}</span>
                        <span class="font-medium tabular-nums">{{ cnt }}</span>
                      </span>
                    </div>
                  </div>

                  <!-- 5: 사람 검수 — 한 줄 압축 -->
                  <div class="rounded border border-gray-100 dark:border-slate-700 px-3 py-1.5 flex flex-col gap-1 bg-white dark:bg-slate-800">
                    <!-- 한 줄: 라벨 + 카운트 버튼 + 토글 -->
                    <div class="flex items-center gap-1.5 flex-wrap">
                      <span class="text-[11px] font-medium text-gray-400 dark:text-slate-500 shrink-0">검수</span>
                      <button
                        class="flex items-center gap-1 text-[11px] px-1 py-0.5 rounded transition-colors"
                        :class="activeHumanLabel === 'human'
                          ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 font-medium'
                          : 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300 hover:bg-gray-200 dark:hover:bg-slate-600'"
                        :title="`사람으로 라벨된 리뷰 ${aiDiagnosis.human_counts.human}건 보기`"
                        @click="setHumanLabelFilter('human')"
                      >사람 {{ aiDiagnosis.human_counts.human }}</button>
                      <button
                        class="flex items-center gap-1 text-[11px] px-1 py-0.5 rounded transition-colors"
                        :class="activeHumanLabel === 'ad'
                          ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 font-medium'
                          : 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300 hover:bg-gray-200 dark:hover:bg-slate-600'"
                        :title="`광고로 라벨된 리뷰 ${aiDiagnosis.human_counts.ad}건 보기`"
                        @click="setHumanLabelFilter('ad')"
                      >광고 {{ aiDiagnosis.human_counts.ad }}</button>
                      <button
                        class="flex items-center gap-1 text-[11px] px-1 py-0.5 rounded transition-colors"
                        :class="activeHumanLabel === 'ai'
                          ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 font-medium'
                          : 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300 hover:bg-gray-200 dark:hover:bg-slate-600'"
                        :title="`AI로 라벨된 리뷰 ${aiDiagnosis.human_counts.ai}건 보기`"
                        @click="setHumanLabelFilter('ai')"
                      >AI {{ aiDiagnosis.human_counts.ai }}</button>
                      <button
                        class="flex items-center gap-1 text-[11px] px-1 py-0.5 rounded transition-colors"
                        :class="activeHumanLabel === 'unsure'
                          ? 'bg-slate-200 dark:bg-slate-600 text-slate-700 dark:text-slate-200 font-medium'
                          : 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300 hover:bg-gray-200 dark:hover:bg-slate-600'"
                        :title="`애매로 라벨된 리뷰 ${aiDiagnosis.human_counts.unsure}건 보기`"
                        @click="setHumanLabelFilter('unsure')"
                      >애매 {{ aiDiagnosis.human_counts.unsure }}</button>
                      <!-- 인간 보정 반영 토글 (우측) -->
                      <button
                        class="flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded transition-colors ml-auto shrink-0"
                        :class="humanCorrectionEnabled
                          ? 'bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300 font-medium'
                          : 'bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-slate-400 hover:bg-gray-200 dark:hover:bg-slate-600'"
                        :title="humanCorrectionEnabled ? '인간 보정 적용 중 — 클릭하여 순수 AI로 전환' : '사람 라벨을 suspect 분류에 반영 (클릭)'"
                        @click="toggleHumanCorrection"
                      >보정 <span class="font-bold">{{ humanCorrectionEnabled ? 'ON' : 'OFF' }}</span></button>
                    </div>
                    <!-- AI 일치율 (있을 때만) -->
                    <p v-if="aiDiagnosis.agreement.compared > 0" class="text-[11px] text-gray-400 dark:text-slate-500 tabular-nums">
                      검수 {{ aiDiagnosis.agreement.compared }}건 · AI 일치 <span class="font-semibold text-gray-600 dark:text-slate-300">{{ aiDiagnosis.agreement.rate !== null ? Math.round(aiDiagnosis.agreement.rate * 100) : '—' }}%</span>
                      <span class="text-[10px]"> · 오탐 {{ aiDiagnosis.agreement.false_positive }} · 누락 {{ aiDiagnosis.agreement.false_negative }}</span>
                    </p>
                    <p v-else class="text-[11px] text-gray-400 dark:text-slate-500">아직 검수 라벨 없음</p>
                  </div>

                  <!-- 6+7: 진단 액션 버튼 통합 (관리자 전용) — 2줄 컴팩트 -->
                  <div v-if="authStore.isAdmin" class="rounded border border-gray-100 dark:border-slate-700 px-3 py-2 flex flex-col gap-1.5 bg-white dark:bg-slate-800">
                    <!-- 1차 무료 -->
                    <div class="flex items-center gap-2">
                      <span class="text-[10px] font-medium text-gray-400 dark:text-slate-500 shrink-0 w-14">1차 무료</span>
                      <UButton
                        label="휴리스틱 진단"
                        size="xs"
                        color="primary"
                        variant="outline"
                        icon="i-heroicons-beaker"
                        class="flex-1"
                        :loading="aiAnalyzeRunning"
                        :disabled="aiAnalyzeRunning || aiRejudgeRunning"
                        :title="'미분석 리뷰를 규칙+점수로 분류 · 비용 없음'"
                        @click="selectedPlace && runAiAnalyze(selectedPlace.id, 'heuristic')"
                      />
                    </div>
                    <!-- 2차 정밀 -->
                    <div class="flex items-center gap-2">
                      <span class="text-[10px] font-medium text-amber-500 dark:text-amber-400 shrink-0 w-14">2차 정밀</span>
                      <div class="flex gap-1 flex-1 min-w-0">
                        <UButton
                          :label="`의심만 · ${(aiDiagnosis.suspect_pending ?? 0).toLocaleString('ko-KR')}`"
                          size="xs"
                          color="warning"
                          variant="solid"
                          icon="i-heroicons-cpu-chip"
                          class="flex-1"
                          :loading="aiAnalyzeRunning"
                          :disabled="aiAnalyzeRunning || aiRejudgeRunning"
                          :title="`휴리스틱 의심 ${(aiDiagnosis.suspect_pending ?? 0).toLocaleString('ko-KR')}건을 정밀 분석 (비용 적음)`"
                          @click="selectedPlace && runAiAnalyze(selectedPlace.id, 'suspect')"
                        />
                        <UButton
                          :label="`전체 · ${(aiDiagnosis.pending_all ?? 0).toLocaleString('ko-KR')}`"
                          size="xs"
                          color="neutral"
                          variant="outline"
                          icon="i-heroicons-cpu-chip"
                          class="flex-1"
                          :loading="aiAnalyzeRunning"
                          :disabled="aiAnalyzeRunning || aiRejudgeRunning"
                          :title="`미판정 전체 ${(aiDiagnosis.pending_all ?? 0).toLocaleString('ko-KR')}건 정밀 분석 (AI API 비용 발생)`"
                          @click="selectedPlace && runAiAnalyze(selectedPlace.id, 'all')"
                        />
                      </div>
                    </div>
                    <!-- 정밀 다시 분석 링크 (정밀 판정분 있을 때만 노출) -->
                    <button
                      v-if="aiDiagnosis.gpt_judged > 0"
                      class="text-left text-[11px] text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300 disabled:opacity-50 disabled:pointer-events-none"
                      :disabled="aiAnalyzeRunning || aiRejudgeRunning"
                      @click="selectedPlace && runAiRejudge(selectedPlace.id)"
                    >
                      <span v-if="aiRejudgeRunning"><UIcon name="i-heroicons-arrow-path" class="w-3 h-3 inline animate-spin mr-0.5" />재판정 중...</span>
                      <span v-else>정밀 다시 분석 · {{ aiDiagnosis.gpt_judged.toLocaleString('ko-KR') }}건 (AI API 비용 소액 발생)</span>
                    </button>
                    <!-- 결과 피드백 -->
                    <div v-if="aiAnalyzeSummary" class="flex items-center gap-1 text-[11px] text-gray-500 dark:text-slate-400">
                      <UIcon name="i-heroicons-check-circle" class="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                      분석 {{ aiAnalyzeSummary.analyzed }}건 · 정밀 {{ aiAnalyzeSummary.gpt_called }}건 · ${{ aiAnalyzeSummary.cost_usd.toFixed(4) }}
                    </div>
                    <div v-if="aiAnalyzeError" class="flex items-center gap-1 text-[11px] text-red-500">
                      <UIcon name="i-heroicons-exclamation-circle" class="w-3 h-3 shrink-0" />{{ aiAnalyzeError }}
                    </div>
                    <div v-if="aiRejudgeSummary" class="flex items-center gap-1 text-[11px] text-gray-500 dark:text-slate-400">
                      <UIcon name="i-heroicons-check-circle" class="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                      재판정 {{ aiRejudgeSummary.gpt_called }}건 · ${{ aiRejudgeSummary.cost_usd.toFixed(4) }}
                    </div>
                    <div v-if="aiRejudgeError" class="flex items-center gap-1 text-[11px] text-red-500">
                      <UIcon name="i-heroicons-exclamation-circle" class="w-3 h-3 shrink-0" />{{ aiRejudgeError }}
                    </div>
                  </div>

                  <!-- (LLM 판별 섹션은 좌측 패널 상단으로 이동 — 항상 표시) -->

                  </template><!-- /v-if total_analyzed > 0 -->

                </template>

                <!-- idle 상태 -->
                <div v-else-if="aiDiagnosisStatus === 'idle'" class="flex flex-col items-center gap-2 py-6 px-2">
                  <UIcon name="i-heroicons-magnifying-glass" class="w-6 h-6 text-gray-300 dark:text-slate-600" />
                  <p class="text-xs text-gray-500 dark:text-slate-400">진단 데이터 없음</p>
                </div>

              </div>
              <!-- /좌측 패널 -->

              <!-- ── 우측 패널 ── -->
              <div class="flex-1 min-h-0 flex flex-col overflow-hidden">

                <!-- 목록 헤더 -->
                <div class="shrink-0 flex items-center justify-between px-3 py-2 border-b border-gray-100 dark:border-slate-700 bg-gray-50 dark:bg-slate-800">
                  <span class="text-xs font-medium text-gray-600 dark:text-slate-300">
                    {{ aiReviewsFilterLabel }}
                    <span v-if="aiReviewsStatus === 'done'" class="text-gray-400 dark:text-slate-500 font-normal"> · {{ aiReviewsTotal.toLocaleString('ko-KR') }}건</span>
                  </span>
                  <UButton
                    icon="i-heroicons-arrow-path"
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    :loading="aiReviewsStatus === 'loading'"
                    aria-label="목록 새로고침"
                    @click="selectedPlace && fetchAiReviews(selectedPlace.id)"
                  />
                </div>

                <!-- 목록 본문 -->
                <div class="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-2">

                  <!-- Loading -->
                  <div v-if="aiReviewsStatus === 'loading'" class="flex items-center justify-center py-8">
                    <UIcon name="i-heroicons-arrow-path" class="w-5 h-5 text-gray-400 dark:text-slate-500 animate-spin" />
                  </div>

                  <!-- Error -->
                  <div v-else-if="aiReviewsStatus === 'error'" class="flex flex-col items-center gap-2 py-8 px-4">
                    <UIcon name="i-heroicons-exclamation-circle" class="w-5 h-5 text-red-400 shrink-0" />
                    <p class="text-xs text-red-500 text-center">{{ aiReviewsError }}</p>
                    <button class="text-xs text-primary-600 hover:text-primary-800 dark:hover:text-primary-300" @click="selectedPlace && fetchAiReviews(selectedPlace.id)">재시도</button>
                  </div>

                  <!-- Empty -->
                  <div v-else-if="aiReviewsStatus === 'done' && aiReviewsItems.length === 0" class="flex flex-col items-center gap-2 py-8 px-4">
                    <UIcon name="i-heroicons-magnifying-glass" class="w-5 h-5 text-gray-300 dark:text-slate-600" />
                    <p class="text-xs text-gray-500 dark:text-slate-400">{{ aiReviewsFilterLabel }} 분류에 해당하는 리뷰 없음</p>
                  </div>

                  <!-- Success: 리뷰 카드 목록 -->
                  <template v-else-if="aiReviewsStatus === 'done'">
                    <div
                      v-for="item in aiReviewsItems"
                      :key="item.review_id"
                      class="border border-gray-100 dark:border-slate-700 rounded p-2.5 flex flex-col gap-1.5 bg-white dark:bg-slate-800"
                      :class="item.human_label === 'human' ? 'border-l-2 border-l-emerald-400' : item.human_label === 'ad' ? 'border-l-2 border-l-red-400' : item.human_label === 'ai' ? 'border-l-2 border-l-amber-400' : item.human_label === 'unsure' ? 'border-l-2 border-l-slate-400' : ''"
                    >
                      <!-- 헤더: 점수 배지 + 플래그 + 날짜 -->
                      <div class="flex items-center gap-1.5 flex-wrap">
                        <!-- 점수 배지 -->
                        <span
                          v-if="item.ai_suspect !== null"
                          class="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-bold tabular-nums shrink-0"
                          :class="item.ai_suspect >= 80 ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300' : item.ai_suspect >= 60 ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300' : 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300'"
                        >{{ item.ai_suspect }}점</span>
                        <!-- 저품질 배지 -->
                        <span
                          v-else-if="item.rule_low_quality"
                          class="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium shrink-0 bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-slate-400"
                        >저품질</span>
                        <!-- 사람추정 배지 -->
                        <span
                          v-else
                          class="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium shrink-0 bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-slate-400"
                        >사람추정</span>
                        <!-- kind 꼬리표 (광고형/AI형) -->
                        <span
                          v-if="item.kind === 'ad'"
                          class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300"
                          title="광고형 플래그(광고체·과장) 포함"
                        >광고형</span>
                        <span
                          v-else-if="item.kind === 'ai'"
                          class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300"
                          title="AI형 플래그(격식체·템플릿성 등) 포함"
                        >AI형</span>
                        <!-- 보정 표기: 원점수와 effective가 다를 때 -->
                        <span
                          v-if="item.raw_ai_suspect !== undefined && item.ai_suspect !== null"
                          class="text-[10px] text-gray-400 dark:text-slate-500 shrink-0"
                          :title="`AI 원점수 ${item.raw_ai_suspect} → 짧은 리뷰 보정 ${item.ai_suspect}`"
                        >원 {{ item.raw_ai_suspect }}→보정 {{ item.ai_suspect }} (짧은 리뷰)</span>
                        <!-- 사람 라벨 배지 -->
                        <span
                          v-if="item.human_label"
                          class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0"
                          :class="item.human_label === 'human' ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300' : item.human_label === 'ad' ? 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300' : item.human_label === 'ai' ? 'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300' : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-400'"
                        >{{ item.human_label === 'human' ? '사람' : item.human_label === 'ad' ? '광고' : item.human_label === 'ai' ? 'AI' : '애매' }}</span>
                        <!-- 감성 -->
                        <span v-if="item.sentiment" class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300">
                          {{ item.sentiment === 'positive' ? '긍정' : item.sentiment === 'negative' ? '부정' : '중립' }}
                        </span>
                        <!-- 휴리스틱 추정 뱃지 (GPT 미정밀 표시) -->
                        <span
                          v-if="item.flags.includes('heuristic_only')"
                          class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-sky-50 dark:bg-sky-900/20 text-sky-600 dark:text-sky-300 shrink-0"
                          title="휴리스틱 추정 — 정밀 분석 전"
                        >휴리스틱 추정</span>
                        <!-- 플래그 칩 -->
                        <span
                          v-for="f in item.flags.filter((fl: string) => fl !== 'presumed_human' && fl !== 'heuristic_only')"
                          :key="f"
                          class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-300"
                          :title="f"
                        >{{ flagLabel(f) }}</span>
                        <!-- 날짜 -->
                        <span v-if="item.review_date" class="text-[10px] text-gray-400 dark:text-slate-500 ml-auto shrink-0">{{ item.review_date }}</span>
                      </div>
                      <!-- reason -->
                      <p v-if="item.reason" class="text-[11px] text-gray-500 dark:text-slate-400 italic leading-snug">{{ item.reason }}</p>
                      <!-- 본문 (클릭 펼침) -->
                      <p
                        class="text-xs text-gray-700 dark:text-slate-300 leading-relaxed cursor-pointer"
                        :class="expandedDiagnosisIds.has(item.review_id) ? '' : 'line-clamp-3'"
                        @click="toggleExpandDiagnosis(item.review_id)"
                      >{{ item.body || '(본문 없음)' }}</p>

                      <!-- 라벨 컨트롤 (researcher 이상) -->
                      <div class="flex items-center gap-1 flex-wrap pt-0.5 border-t border-gray-50 dark:border-slate-700/60">
                        <!-- 4개 버튼: 사람 / 광고 / AI / 애매 -->
                        <button
                          class="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] transition-colors disabled:opacity-50"
                          :class="item.human_label === 'human'
                            ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 font-medium'
                            : 'bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-slate-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 hover:text-emerald-700 dark:hover:text-emerald-300'"
                          :disabled="labelSavingIds.has(item.review_id)"
                          :title="item.human_label === 'human' ? '클릭하면 라벨 해제' : '사람이 작성한 진성 리뷰'"
                          @click="saveReviewLabel(item.review_id, item.human_label === 'human' ? null : 'human')"
                        >사람</button>
                        <button
                          class="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] transition-colors disabled:opacity-50"
                          :class="item.human_label === 'ad'
                            ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 font-medium'
                            : 'bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-slate-400 hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-700 dark:hover:text-red-300'"
                          :disabled="labelSavingIds.has(item.review_id)"
                          :title="item.human_label === 'ad' ? '클릭하면 라벨 해제' : '광고 목적으로 작성된 리뷰 (체험단 등)'"
                          @click="saveReviewLabel(item.review_id, item.human_label === 'ad' ? null : 'ad')"
                        >광고</button>
                        <button
                          class="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] transition-colors disabled:opacity-50"
                          :class="item.human_label === 'ai'
                            ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 font-medium'
                            : 'bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-slate-400 hover:bg-amber-50 dark:hover:bg-amber-900/20 hover:text-amber-700 dark:hover:text-amber-300'"
                          :disabled="labelSavingIds.has(item.review_id)"
                          :title="item.human_label === 'ai' ? '클릭하면 라벨 해제' : 'AI가 생성한 것으로 판단된 리뷰'"
                          @click="saveReviewLabel(item.review_id, item.human_label === 'ai' ? null : 'ai')"
                        >AI</button>
                        <button
                          class="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] transition-colors disabled:opacity-50"
                          :class="item.human_label === 'unsure'
                            ? 'bg-slate-200 dark:bg-slate-600 text-slate-700 dark:text-slate-200 font-medium'
                            : 'bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-600 hover:text-slate-700 dark:hover:text-slate-200'"
                          :disabled="labelSavingIds.has(item.review_id)"
                          :title="item.human_label === 'unsure' ? '클릭하면 라벨 해제' : '판단하기 애매한 리뷰'"
                          @click="saveReviewLabel(item.review_id, item.human_label === 'unsure' ? null : 'unsure')"
                        >애매</button>
                        <!-- 메모 토글 -->
                        <button
                          class="ml-1 flex items-center gap-0.5 px-1 py-0.5 rounded text-[10px] text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300 transition-colors"
                          :class="labelNoteOpenIds.has(item.review_id) ? 'text-gray-600 dark:text-slate-300' : ''"
                          :title="item.human_note ? `메모: ${item.human_note}` : '메모 추가'"
                          @click="toggleLabelNote(item.review_id)"
                        >
                          <UIcon name="i-heroicons-pencil-square" class="w-3 h-3" />
                          <span v-if="item.human_note && !labelNoteOpenIds.has(item.review_id)" class="max-w-[80px] truncate">{{ item.human_note }}</span>
                        </button>
                        <!-- 저장 중 스피너 -->
                        <UIcon v-if="labelSavingIds.has(item.review_id)" name="i-heroicons-arrow-path" class="w-3 h-3 text-gray-400 dark:text-slate-500 animate-spin ml-auto shrink-0" />
                      </div>
                      <!-- 메모 입력 (펼침 시) -->
                      <div v-if="labelNoteOpenIds.has(item.review_id)" class="flex items-center gap-1">
                        <input
                          v-model="labelNoteInputs[item.review_id]"
                          type="text"
                          placeholder="메모 (선택)"
                          maxlength="200"
                          class="flex-1 min-w-0 text-[11px] px-2 py-1 rounded border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-700 dark:text-slate-300 placeholder-gray-400 dark:placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-primary-400"
                          @keydown.enter="commitLabelNote(item.review_id)"
                          @keydown.escape="toggleLabelNote(item.review_id)"
                        />
                        <button
                          class="text-[10px] px-1.5 py-1 rounded bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300 hover:bg-primary-200 dark:hover:bg-primary-900/50 transition-colors"
                          @click="commitLabelNote(item.review_id)"
                        >저장</button>
                      </div>
                    </div>

                    <!-- 더 보기 -->
                    <div v-if="aiReviewsItems.length < aiReviewsTotal" class="flex justify-center pt-1">
                      <UButton
                        label="더 보기"
                        size="xs"
                        color="neutral"
                        variant="ghost"
                        :loading="aiReviewsLoadingMore"
                        @click="loadMoreAiReviews"
                      />
                    </div>
                  </template>

                </div>
                <!-- /목록 본문 -->

              </div>
              <!-- /우측 패널 -->

            </div>
            <!-- /본문 2분할 -->

          </div>
          <!-- ══ /탭 4: AI 진단 ══════════════════════════════════════ -->

          <!-- ══ 탭 5: 수집 이력 ══════════════════════════════════════ -->
          <div v-show="activeTab === 'collections'" class="flex-1 min-h-0 flex flex-col overflow-hidden">

            <!-- 탭 헤더 (shrink-0) -->
            <div class="shrink-0 flex items-center justify-between px-3 py-2 border-b border-gray-100 dark:border-slate-700 bg-gray-50 dark:bg-slate-800">
              <span class="text-xs font-medium text-gray-600 dark:text-slate-400">수집 이력 (최근 30건)</span>
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

            <!-- 본문 스크롤 -->
            <div class="flex-1 min-h-0 overflow-y-auto bg-white dark:bg-slate-900">
              <!-- Loading -->
              <div v-if="collectionsStatus === 'loading'" class="flex items-center justify-center py-6">
                <UIcon name="i-heroicons-arrow-path" class="w-5 h-5 text-gray-400 dark:text-slate-500 animate-spin" />
              </div>
              <!-- Error -->
              <div v-else-if="collectionsStatus === 'error'" class="flex items-center justify-center gap-2 py-6">
                <UIcon name="i-heroicons-exclamation-circle" class="w-4 h-4 text-red-400 shrink-0" />
                <span class="text-xs text-red-500">{{ collectionsError }}</span>
                <button class="text-xs text-primary-600 hover:text-primary-800 dark:hover:text-primary-300 transition-colors ml-1" @click="selectedPlace && fetchCollections(selectedPlace.id)">재시도</button>
              </div>
              <!-- Empty -->
              <div v-else-if="collectionsStatus === 'done' && collectionEvents.length === 0" class="flex items-center justify-center py-6">
                <p class="text-xs text-gray-400 dark:text-slate-500">아직 수집 이력이 없습니다</p>
              </div>
              <!-- Success -->
              <table v-else class="w-full text-xs border-collapse">
                <thead class="sticky top-0 z-10 bg-gray-50 dark:bg-slate-800">
                  <tr>
                    <th class="px-3 py-1.5 text-left font-medium text-gray-500 dark:text-slate-400 whitespace-nowrap border-b border-gray-200 dark:border-slate-700 w-36">수집 시각</th>
                    <th class="px-3 py-1.5 text-left font-medium text-gray-500 dark:text-slate-400 whitespace-nowrap border-b border-gray-200 dark:border-slate-700 w-16">구분</th>
                    <th class="px-3 py-1.5 text-right font-medium text-gray-500 dark:text-slate-400 whitespace-nowrap border-b border-gray-200 dark:border-slate-700 w-14">신규</th>
                    <th class="px-3 py-1.5 text-right font-medium text-gray-500 dark:text-slate-400 whitespace-nowrap border-b border-gray-200 dark:border-slate-700 w-14">스킵</th>
                    <th class="px-3 py-1.5 text-left font-medium text-gray-500 dark:text-slate-400 border-b border-gray-200 dark:border-slate-700">비고</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="ev in collectionEvents"
                    :key="ev.id"
                    class="border-b border-gray-100 dark:border-slate-700 last:border-0 hover:bg-gray-50 dark:hover:bg-slate-800"
                    :class="ev.blocked ? 'bg-red-50 dark:bg-red-900/20' : ''"
                  >
                    <td class="px-3 py-1.5 whitespace-nowrap text-gray-500 dark:text-slate-400 tabular-nums">{{ formatDateTime(ev.collected_at) }}</td>
                    <td class="px-3 py-1.5 whitespace-nowrap">
                      <span
                        class="inline-block px-1.5 py-0.5 rounded text-xs font-medium whitespace-nowrap"
                        :class="ev.source === 'cron' ? 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300' : ev.source === 'backfill' ? 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300' : 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300'"
                      >{{ ev.source === 'cron' ? '자동' : ev.source === 'backfill' ? '전체' : '수동' }}</span>
                    </td>
                    <td class="px-3 py-1.5 text-right tabular-nums text-gray-700 dark:text-slate-300">{{ ev.inserted }}</td>
                    <td class="px-3 py-1.5 text-right tabular-nums text-gray-400 dark:text-slate-500">{{ ev.skipped }}</td>
                    <td class="px-3 py-1.5">
                      <span v-if="ev.blocked" class="text-red-500 font-medium" :title="ev.error ?? ''">차단/오류</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

          </div>
          <!-- ══ /탭 5: 수집 이력 ══════════════════════════════════════ -->

          <!-- ══ 탭 6: 라벨링 스프린트 (researcher/admin 전용) ══════════ -->
          <div v-if="authStore.isResearcher" v-show="activeTab === 'sprint'" class="h-full flex flex-col overflow-hidden">

            <!-- 상단 컨트롤 바 (shrink-0) -->
            <div class="shrink-0 flex items-center gap-3 px-3 py-2 border-b border-gray-100 dark:border-slate-700 bg-gray-50 dark:bg-slate-800 flex-wrap">
              <span class="text-xs font-semibold text-gray-700 dark:text-slate-200 shrink-0">라벨링 스프린트</span>
              <span class="text-[11px] text-gray-400 dark:text-slate-500">|</span>
              <!-- 표본 크기 -->
              <div class="flex items-center gap-1.5 shrink-0">
                <span class="text-[11px] text-gray-500 dark:text-slate-400">표본</span>
                <select
                  v-model.number="sprintLimit"
                  class="text-xs rounded border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-gray-700 dark:text-slate-200 px-1.5 py-0.5 focus:outline-none"
                >
                  <option :value="100">100건</option>
                  <option :value="200">200건</option>
                  <option :value="300">300건</option>
                </select>
              </div>
              <UButton
                label="표본 불러오기"
                size="xs"
                color="primary"
                variant="outline"
                icon="i-heroicons-arrow-down-tray"
                :loading="sprintStatus === 'loading'"
                :disabled="sprintStatus === 'loading'"
                @click="fetchSprintSample(); fetchSprintStats()"
              />
              <div class="ml-auto flex items-center gap-2 shrink-0">
                <!-- 진행률 -->
                <span class="text-xs tabular-nums text-gray-500 dark:text-slate-400">
                  이번 세션 {{ sprintLabeledInSession }}건 라벨 완료
                  <template v-if="sprintItems.length > 0">
                    / 표본 {{ sprintItems.length }}건 중 {{ sprintIndex }}/{{ sprintItems.length }}
                  </template>
                </span>
              </div>
            </div>

            <!-- 본문 2분할 -->
            <div class="flex-1 min-h-0 flex flex-row gap-0 overflow-hidden">

              <!-- ── 좌측: 카드 뷰어 ── -->
              <div class="flex-1 min-h-0 flex flex-col overflow-hidden border-r border-gray-100 dark:border-slate-700">

                <!-- Loading -->
                <div v-if="sprintStatus === 'loading'" class="flex-1 flex items-center justify-center">
                  <UIcon name="i-heroicons-arrow-path" class="w-6 h-6 text-gray-400 animate-spin" />
                </div>

                <!-- Error -->
                <div v-else-if="sprintStatus === 'error'" class="flex-1 flex flex-col items-center justify-center gap-2 p-4">
                  <UIcon name="i-heroicons-exclamation-circle" class="w-6 h-6 text-red-400" />
                  <p class="text-xs text-red-500 text-center">{{ sprintError }}</p>
                  <button class="text-xs text-primary-600 hover:text-primary-800 dark:hover:text-primary-300" @click="fetchSprintSample()">재시도</button>
                </div>

                <!-- Idle/Empty -->
                <div v-else-if="sprintStatus === 'idle' || sprintItems.length === 0" class="flex-1 flex flex-col items-center justify-center gap-3 p-6 text-center">
                  <UIcon name="i-heroicons-tag" class="w-10 h-10 text-gray-200 dark:text-slate-700" />
                  <p class="text-sm font-medium text-gray-500 dark:text-slate-400">라벨링 스프린트</p>
                  <p class="text-[11px] text-gray-400 dark:text-slate-500 leading-snug max-w-xs">
                    수집된 리뷰를 층화 표본 추출하여<br>
                    4분류 라벨링을 빠르게 진행합니다.<br>
                    이미 라벨된 리뷰는 제외됩니다.
                  </p>
                  <UButton
                    label="표본 불러오기"
                    size="sm"
                    color="primary"
                    variant="outline"
                    icon="i-heroicons-arrow-down-tray"
                    :loading="(sprintStatus as string) === 'loading'"
                    @click="fetchSprintSample(); fetchSprintStats()"
                  />
                </div>

                <!-- 모두 완료 -->
                <div v-else-if="sprintStatus === 'done' && sprintIndex >= sprintItems.length" class="flex-1 flex flex-col items-center justify-center gap-3 p-6 text-center">
                  <UIcon name="i-heroicons-check-circle" class="w-10 h-10 text-emerald-400" />
                  <p class="text-sm font-semibold text-gray-700 dark:text-slate-200">표본 {{ sprintItems.length }}건 완료!</p>
                  <p class="text-xs text-gray-400 dark:text-slate-500">이번 세션에서 {{ sprintLabeledInSession }}건 라벨했습니다.</p>
                  <UButton
                    label="새 표본 불러오기"
                    size="sm"
                    color="primary"
                    variant="outline"
                    icon="i-heroicons-arrow-path"
                    @click="fetchSprintSample(); fetchSprintStats()"
                  />
                </div>

                <!-- 카드 -->
                <template v-else-if="sprintStatus === 'done' && sprintCurrent">
                  <div class="flex-1 min-h-0 overflow-y-auto p-4 flex flex-col gap-3">

                    <!-- 진행 바 -->
                    <div class="shrink-0 flex items-center gap-2">
                      <div class="flex-1 h-1.5 bg-gray-100 dark:bg-slate-700 rounded-full overflow-hidden">
                        <div
                          class="h-full bg-primary-500 rounded-full transition-all"
                          :style="{ width: `${Math.round(sprintIndex / sprintItems.length * 100)}%` }"
                        />
                      </div>
                      <span class="text-[11px] tabular-nums text-gray-400 dark:text-slate-500 shrink-0">{{ sprintIndex }}/{{ sprintItems.length }}</span>
                    </div>

                    <!-- 메타 정보 -->
                    <div class="shrink-0 flex items-center gap-2 flex-wrap">
                      <span class="text-[11px] font-medium text-gray-500 dark:text-slate-400 px-2 py-0.5 rounded bg-gray-100 dark:bg-slate-700">{{ sprintCurrent.place_name }}</span>
                      <span class="text-[11px] text-gray-400 dark:text-slate-500">{{ sprintCurrent.length_bucket === 'short' ? '단문' : sprintCurrent.length_bucket === 'medium' ? '중문' : '장문' }} ({{ sprintCurrent.body_length }}자)</span>
                      <span v-if="sprintCurrent.review_date" class="text-[11px] text-gray-400 dark:text-slate-500">{{ sprintCurrent.review_date }}</span>
                      <span v-if="sprintDoneIds.has(sprintCurrent.review_id)" class="text-[11px] text-emerald-500 font-medium">라벨 완료</span>
                    </div>

                    <!-- 본문 -->
                    <div class="rounded border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-3 text-sm text-gray-800 dark:text-slate-100 leading-relaxed min-h-[80px] whitespace-pre-wrap">{{ sprintCurrent.body }}</div>

                    <!-- 라벨 버튼 -->
                    <div class="shrink-0 flex flex-col gap-2">
                      <div class="flex gap-2 flex-wrap">
                        <button
                          v-for="(cfg, key) in SPRINT_LABEL_MAP"
                          :key="key"
                          class="px-4 py-2 rounded text-sm font-semibold transition-colors disabled:opacity-50"
                          :class="cfg.cls"
                          :disabled="!!sprintSavingId"
                          @click="sprintLabel(key as HumanLabel)"
                        >
                          <span v-if="sprintSavingId === sprintCurrent.review_id" class="flex items-center gap-1.5">
                            <UIcon name="i-heroicons-arrow-path" class="w-3.5 h-3.5 animate-spin" />
                            저장 중
                          </span>
                          <span v-else>{{ cfg.text }}</span>
                        </button>
                      </div>

                      <!-- 메모 -->
                      <input
                        v-model="sprintNote"
                        type="text"
                        placeholder="메모 (선택 사항)"
                        maxlength="200"
                        class="w-full text-xs rounded border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-gray-700 dark:text-slate-200 px-2.5 py-1.5 focus:outline-none focus:border-primary-400 placeholder-gray-300 dark:placeholder-slate-600"
                        @keydown.enter.prevent
                      />

                      <!-- 저장 오류 -->
                      <p v-if="sprintSaveError" class="text-xs text-red-500">{{ sprintSaveError }}</p>
                    </div>

                    <!-- 이전/다음 네비게이션 -->
                    <div class="shrink-0 flex items-center justify-between">
                      <button
                        class="text-xs text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300 disabled:opacity-30 transition-colors"
                        :disabled="sprintIndex === 0"
                        @click="sprintPrev"
                      >
                        이전
                      </button>
                      <button
                        class="text-xs text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300 disabled:opacity-30 transition-colors"
                        :disabled="sprintIndex >= sprintItems.length - 1"
                        @click="sprintSkip"
                      >
                        건너뛰기
                      </button>
                    </div>
                  </div>
                </template>
              </div>

              <!-- ── 우측: 진행 통계 패널 (240px) ── -->
              <div class="w-60 shrink-0 overflow-y-auto flex flex-col gap-3 p-3 bg-gray-50 dark:bg-slate-800/50">
                <!-- 통계 헤더 -->
                <div class="flex items-center justify-between">
                  <span class="text-[11px] font-semibold text-gray-600 dark:text-slate-300">전체 라벨 통계</span>
                  <button
                    class="text-[11px] text-primary-500 hover:text-primary-700 dark:hover:text-primary-300 transition-colors"
                    :class="sprintStatsStatus === 'loading' ? 'opacity-50 pointer-events-none' : ''"
                    @click="fetchSprintStats()"
                  >새로고침</button>
                </div>

                <!-- 통계 로딩 -->
                <div v-if="sprintStatsStatus === 'loading'" class="flex items-center justify-center py-4">
                  <UIcon name="i-heroicons-arrow-path" class="w-4 h-4 text-gray-400 animate-spin" />
                </div>

                <!-- 통계 결과 -->
                <template v-else-if="sprintStats">
                  <!-- 전체 합계 -->
                  <div class="rounded border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2.5 flex flex-col gap-1">
                    <div class="flex items-baseline gap-1">
                      <span class="text-2xl font-bold tabular-nums text-gray-800 dark:text-slate-100">{{ sprintStats.total.toLocaleString('ko-KR') }}</span>
                      <span class="text-xs text-gray-400 dark:text-slate-500">건 라벨 완료</span>
                    </div>

                    <!-- 분류별 바 -->
                    <div class="flex h-3 rounded overflow-hidden gap-px mt-1" v-if="sprintStats.total > 0">
                      <div
                        v-if="sprintStats.by_label.human > 0"
                        class="h-full bg-emerald-500"
                        :style="{ width: `${Math.round(sprintStats.by_label.human / sprintStats.total * 100)}%` }"
                        :title="`진짜손님 ${sprintStats.by_label.human}건`"
                      />
                      <div
                        v-if="sprintStats.by_label.ad > 0"
                        class="h-full bg-red-500"
                        :style="{ width: `${Math.round(sprintStats.by_label.ad / sprintStats.total * 100)}%` }"
                        :title="`사람마케팅 ${sprintStats.by_label.ad}건`"
                      />
                      <div
                        v-if="sprintStats.by_label.ai > 0"
                        class="h-full bg-amber-500"
                        :style="{ width: `${Math.round(sprintStats.by_label.ai / sprintStats.total * 100)}%` }"
                        :title="`AI조립 ${sprintStats.by_label.ai}건`"
                      />
                      <div
                        v-if="sprintStats.by_label.unsure > 0"
                        class="h-full bg-slate-400"
                        :style="{ width: `${Math.round(sprintStats.by_label.unsure / sprintStats.total * 100)}%` }"
                        :title="`모름 ${sprintStats.by_label.unsure}건`"
                      />
                    </div>
                  </div>

                  <!-- 분류별 수치 -->
                  <div class="flex flex-col gap-1">
                    <div v-for="([key, cfg]) in Object.entries(SPRINT_LABEL_MAP)" :key="key" class="flex items-center gap-1.5">
                      <span class="w-1.5 h-1.5 rounded-full shrink-0" :class="key === 'human' ? 'bg-emerald-500' : key === 'ad' ? 'bg-red-500' : key === 'ai' ? 'bg-amber-500' : 'bg-slate-400'" />
                      <span class="text-[11px] text-gray-600 dark:text-slate-400 flex-1">{{ cfg.text }}</span>
                      <span class="text-[11px] tabular-nums font-medium text-gray-700 dark:text-slate-300">
                        {{ ((sprintStats.by_label as Record<string, number>)[key] ?? 0).toLocaleString('ko-KR') }}
                      </span>
                      <span v-if="sprintStats.total > 0" class="text-[11px] tabular-nums text-gray-400 dark:text-slate-500 w-8 text-right">
                        {{ Math.round(((sprintStats.by_label as Record<string, number>)[key] ?? 0) / sprintStats.total * 100) }}%
                      </span>
                    </div>
                  </div>

                  <!-- 지점별 소계 (top 10) -->
                  <div class="flex flex-col gap-1 pt-1 border-t border-gray-100 dark:border-slate-700">
                    <span class="text-[11px] font-semibold text-gray-500 dark:text-slate-400 mb-1">지점별</span>
                    <div
                      v-for="p in sprintStats.by_place.filter(x => x.labeled_count > 0).slice(0, 10)"
                      :key="p.place_row_id"
                      class="flex items-center gap-1.5"
                    >
                      <span class="text-[11px] text-gray-600 dark:text-slate-400 flex-1 truncate" :title="p.place_name">{{ p.place_name }}</span>
                      <span class="text-[11px] tabular-nums font-medium text-gray-700 dark:text-slate-300">{{ p.labeled_count }}</span>
                    </div>
                    <p v-if="sprintStats.by_place.every(x => x.labeled_count === 0)" class="text-[11px] text-gray-400 dark:text-slate-500">아직 없음</p>
                  </div>
                </template>

                <!-- 통계 없음 -->
                <div v-else-if="sprintStatsStatus === 'idle'" class="flex flex-col items-center justify-center gap-2 py-4">
                  <p class="text-[11px] text-gray-400 dark:text-slate-500 text-center">표본을 불러오면<br>통계가 표시됩니다</p>
                </div>
              </div>

            </div>
          </div>
          <!-- ══ /탭 6: 라벨링 스프린트 ══════════════════════════════════ -->


        </template>
        <!-- /플레이스 선택 시 탭 구조 -->

      </div>
    </div>
  </div>

  <!-- 삭제 확인 다이얼로그 -->
  <UModal v-model:open="deleteConfirmOpen">
    <template #content>
      <div class="p-5 flex flex-col gap-4 max-w-sm w-full bg-white dark:bg-slate-800">
        <div class="flex flex-col gap-1">
          <p class="text-sm font-semibold text-gray-900 dark:text-slate-100">플레이스 삭제</p>
          <p class="text-xs text-gray-500 dark:text-slate-400">
            선택한 <span class="font-medium text-red-600 dark:text-red-400">{{ checkedPlaces.length }}개</span> 플레이스와
            <span class="font-medium dark:text-slate-200">수집된 모든 리뷰·이력이 영구 삭제</span>됩니다. 되돌릴 수 없습니다.
          </p>
        </div>
        <ul class="flex flex-col gap-0.5 max-h-32 overflow-y-auto">
          <li
            v-for="p in checkedPlaces"
            :key="p.id"
            class="text-xs text-gray-700 dark:text-slate-300 px-2 py-1 bg-gray-50 dark:bg-slate-700 rounded truncate"
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
