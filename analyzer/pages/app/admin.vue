<script setup lang="ts">
// 사용자 관리 페이지: admin 전용, default 레이아웃
definePageMeta({
  layout: 'default',
})

// ─── 타입 ────────────────────────────────────────────────────────────────────

interface AdminUser {
  id: string
  email: string
  name: string
  picture: string
  status: 'pending' | 'approved' | 'suspended'
  plan: string | null
  created_at: string
  last_login_at: string | null
  approved_at: string | null
  role: 'user' | 'researcher' | 'admin' | 'tester'
  admin_memo: string | null
}

interface ResearcherActivity {
  user_id: string
  name: string
  email: string
  role: 'researcher' | 'admin'
  collect_count: number
  sample_count: number
  report_count: number
  total_cost_usd: number
}

// 통합 행 타입 (users + activities merge)
interface MergedRow extends AdminUser {
  collect_count: number
  sample_count: number
  report_count: number
  total_cost_usd: number
  has_activity: boolean
}

type LoadStatus = 'idle' | 'loading' | 'done' | 'error'
type SortKey = 'name' | 'role' | 'status' | 'collect_count' | 'sample_count' | 'report_count' | 'total_cost_usd' | 'created_at'
type SortDir = 'asc' | 'desc'

// ─── 블라인드 평가 타입 ───────────────────────────────────────────────────────

interface BlindPoolResult {
  pool: string
  n_real: number
  n_gen: number
  total: number
}

interface BlindPoolListItem {
  pool: string
  created_at: string
  n_real: number
  n_gen: number
  total_items: number
  total_ratings: number
  raters: number
}

interface BlindDistribution {
  1?: number; 2?: number; 3?: number; 4?: number; 5?: number
}

interface BlindGroupStats {
  n: number
  mean: number
  dist: BlindDistribution
}

interface BlindMannWhitney {
  U: number
  z: number
  p_approx: number
  note?: string
}

interface BlindResultData {
  pool: string
  real: BlindGroupStats
  gen: BlindGroupStats
  mean_diff: number
  raters: number
  mann_whitney: BlindMannWhitney
}

// ─── 서브탭 상태 ─────────────────────────────────────────────────────────────

type AdminSubTab = 'users' | 'blind-test'
const activeSubTab = ref<AdminSubTab>('users')

// ─── 사용자 섹션 상태 ─────────────────────────────────────────────────────────

const authStore = useAuthStore()
const toast = useToast()

const WORKER_BASE = 'https://naver-searchad-proxy.sbreport.workers.dev'

const users = ref<AdminUser[]>([])
const activities = ref<ResearcherActivity[]>([])

// 두 API 로드 상태를 하나로 관리 (둘 다 완료 시 'done')
const loadStatus = ref<LoadStatus>('idle')
const loadError = ref<string | null>(null)

// 행별 처리 중 상태
const actionLoading = ref<Record<string, boolean>>({})
const roleLoading = ref<Record<string, boolean>>({})

// 메모 편집 상태 (userId → { editing: boolean, draft: string, saving: boolean })
const memoState = ref<Record<string, { editing: boolean; draft: string; saving: boolean }>>({})

// 정렬
const sortKey = ref<SortKey>('total_cost_usd')
const sortDir = ref<SortDir>('desc')

// 검색
const searchQuery = ref('')

// ─── merge 로직 ───────────────────────────────────────────────────────────────

const mergedRows = computed<MergedRow[]>(() => {
  const actMap = new Map<string, ResearcherActivity>()
  for (const a of activities.value) {
    actMap.set(a.email, a)
  }

  return users.value.map(u => {
    const act = actMap.get(u.email)
    return {
      ...u,
      collect_count: act?.collect_count ?? 0,
      sample_count: act?.sample_count ?? 0,
      report_count: act?.report_count ?? 0,
      total_cost_usd: act?.total_cost_usd ?? 0,
      has_activity: !!act,
    }
  })
})

// ─── 검색 + 정렬 적용 ─────────────────────────────────────────────────────────

const filteredRows = computed<MergedRow[]>(() => {
  const q = searchQuery.value.trim().toLowerCase()
  let rows = mergedRows.value

  if (q) {
    rows = rows.filter(r =>
      r.name?.toLowerCase().includes(q) || r.email.toLowerCase().includes(q)
    )
  }

  return [...rows].sort((a, b) => {
    const k = sortKey.value
    let va: string | number
    let vb: string | number

    if (k === 'name') {
      va = (a.name || a.email).toLowerCase()
      vb = (b.name || b.email).toLowerCase()
    } else if (k === 'role') {
      const order: Record<string, number> = { admin: 0, researcher: 1, tester: 2, user: 3 }
      va = order[a.role] ?? 99
      vb = order[b.role] ?? 99
    } else if (k === 'status') {
      const order = { pending: 0, approved: 1, suspended: 2 }
      va = order[a.status] ?? 99
      vb = order[b.status] ?? 99
    } else if (k === 'created_at') {
      va = a.created_at ?? ''
      vb = b.created_at ?? ''
    } else {
      va = (a as Record<string, unknown>)[k] as number ?? 0
      vb = (b as Record<string, unknown>)[k] as number ?? 0
    }

    if (va < vb) return sortDir.value === 'asc' ? -1 : 1
    if (va > vb) return sortDir.value === 'asc' ? 1 : -1
    return 0
  })
})

function setSort(key: SortKey) {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  } else {
    sortKey.value = key
    sortDir.value = key === 'name' || key === 'role' || key === 'status' ? 'asc' : 'desc'
  }
}

function sortIcon(key: SortKey) {
  if (sortKey.value !== key) return 'i-heroicons-chevron-up-down'
  return sortDir.value === 'asc' ? 'i-heroicons-chevron-up' : 'i-heroicons-chevron-down'
}

// ─── 요약 카드 computed ───────────────────────────────────────────────────────

const totalCount = computed(() => users.value.length)
const pendingCount = computed(() => users.value.filter(u => u.status === 'pending').length)
const researcherCount = computed(() => users.value.filter(u => u.role === 'researcher' || u.role === 'admin').length)
const totalCollect = computed(() => activities.value.reduce((s, r) => s + r.collect_count, 0))
const totalSample = computed(() => activities.value.reduce((s, r) => s + r.sample_count, 0))
const totalReport = computed(() => activities.value.reduce((s, r) => s + r.report_count, 0))
const totalCostUsd = computed(() => activities.value.reduce((s, r) => s + r.total_cost_usd, 0))

// isHighCost: 활동 있는 행만 비교, 전체 평균 1.5배 이상
const costHighThreshold = computed(() => {
  const actRows = activities.value
  if (actRows.length === 0) return Infinity
  const avg = totalCostUsd.value / actRows.length
  return Math.max(avg * 1.5, 0.01)
})

function isHighCost(row: MergedRow) {
  return row.has_activity && row.total_cost_usd >= costHighThreshold.value
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

function formatCostUsd(usd: number): string {
  if (usd === 0) return '$0'
  if (usd < 0.001) return `$${usd.toFixed(6)}`
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(4)}`
}

function getMemo(userId: string) {
  return memoState.value[userId] ?? { editing: false, draft: '', saving: false }
}

function startEditMemo(user: AdminUser) {
  memoState.value = {
    ...memoState.value,
    [user.id]: { editing: true, draft: user.admin_memo ?? '', saving: false },
  }
}

function cancelEditMemo(userId: string) {
  const next = { ...memoState.value }
  delete next[userId]
  memoState.value = next
}

function onMemoKeydown(e: KeyboardEvent, user: AdminUser) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    saveMemo(user)
  } else if (e.key === 'Escape') {
    cancelEditMemo(user.id)
  }
}

// ─── 사용자 API 호출 ──────────────────────────────────────────────────────────

async function fetchUsers() {
  try {
    const res = await fetch(`${WORKER_BASE}/api/admin/users`, {
      headers: authHeaders(),
    })
    if (!res.ok) {
      let msg = `오류 ${res.status}`
      try {
        const body = await res.json() as { error?: string }
        if (body.error === 'forbidden') msg = '관리자 권한이 필요합니다'
      } catch { /* ignore */ }
      throw new Error(msg)
    }
    const data = await res.json() as { users: AdminUser[] }
    users.value = data.users
  } catch (e: unknown) {
    throw e
  }
}

async function fetchActivities() {
  try {
    const res = await fetch(`${WORKER_BASE}/api/admin/research-activity`, {
      headers: authHeaders(),
    })
    if (!res.ok) {
      let msg = `오류 ${res.status}`
      try {
        const body = await res.json() as { error?: string }
        if (body.error === 'forbidden') msg = '관리자 권한이 필요합니다'
      } catch { /* ignore */ }
      throw new Error(msg)
    }
    const data = await res.json() as { researchers: ResearcherActivity[] }
    activities.value = data.researchers
  } catch (e: unknown) {
    throw e
  }
}

async function loadAll() {
  loadStatus.value = 'loading'
  loadError.value = null
  try {
    await Promise.all([fetchUsers(), fetchActivities()])
    loadStatus.value = 'done'
  } catch (e: unknown) {
    loadError.value = e instanceof Error ? e.message : '알 수 없는 오류'
    loadStatus.value = 'error'
  }
}

async function changeStatus(user: AdminUser, newStatus: 'approved' | 'suspended' | 'pending') {
  if (actionLoading.value[user.id]) return
  actionLoading.value = { ...actionLoading.value, [user.id]: true }

  try {
    const res = await fetch(`${WORKER_BASE}/api/admin/users/${user.id}/status`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ status: newStatus }),
    })

    if (!res.ok) {
      let errorCode = ''
      try {
        const body = await res.json() as { error?: string }
        errorCode = body.error ?? ''
      } catch { /* ignore */ }

      let msg = `상태 변경 실패 (${res.status})`
      if (errorCode === 'cannot_demote_self') msg = '자신의 상태는 변경할 수 없습니다'
      else if (errorCode === 'forbidden') msg = '관리자 권한이 필요합니다'
      else if (errorCode === 'user_not_found') msg = '사용자를 찾을 수 없습니다'
      else if (errorCode === 'invalid_status') msg = '유효하지 않은 상태값입니다'

      toast.add({ title: '오류', description: msg, color: 'error' })
      return
    }

    const updated = await res.json() as { id: string; status: 'pending' | 'approved' | 'suspended' }
    const idx = users.value.findIndex(u => u.id === updated.id)
    if (idx !== -1) {
      users.value = users.value.map((u, i) =>
        i === idx ? { ...u, status: updated.status } : u
      )
    }

    const statusLabel: Record<string, string> = { approved: '승인', suspended: '정지', pending: '대기' }
    toast.add({
      title: '상태 변경 완료',
      description: `${user.name || user.email} → ${statusLabel[updated.status] ?? updated.status}`,
      color: 'success',
    })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : '알 수 없는 오류'
    toast.add({ title: '오류', description: msg, color: 'error' })
  } finally {
    const next = { ...actionLoading.value }
    delete next[user.id]
    actionLoading.value = next
  }
}

async function changeRole(user: AdminUser, newRole: 'user' | 'researcher' | 'admin' | 'tester') {
  if (roleLoading.value[user.id]) return
  if (newRole === user.role) return

  roleLoading.value = { ...roleLoading.value, [user.id]: true }

  const prevRole = user.role
  users.value = users.value.map(u => u.id === user.id ? { ...u, role: newRole } : u)

  try {
    const res = await fetch(`${WORKER_BASE}/api/admin/users/${user.id}/role`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ role: newRole }),
    })

    if (!res.ok) {
      users.value = users.value.map(u => u.id === user.id ? { ...u, role: prevRole } : u)
      let msg = `역할 변경 실패 (${res.status})`
      try {
        const body = await res.json() as { error?: string }
        if (body.error === 'cannot_demote_self') msg = '자신의 역할은 변경할 수 없습니다'
        else if (body.error === 'forbidden') msg = '관리자 권한이 필요합니다'
        else if (body.error === 'user_not_found') msg = '사용자를 찾을 수 없습니다'
        else if (body.error === 'invalid_role') msg = '유효하지 않은 역할값입니다'
      } catch { /* ignore */ }
      toast.add({ title: '오류', description: msg, color: 'error' })
      return
    }

    const updated = await res.json() as { id: string; role: 'user' | 'researcher' | 'admin' | 'tester' }
    users.value = users.value.map(u => u.id === updated.id ? { ...u, role: updated.role } : u)

    const roleLabel: Record<string, string> = { user: '일반', researcher: '연구원', admin: '관리자', tester: '테스터' }
    toast.add({
      title: '역할 변경 완료',
      description: `${user.name || user.email} → ${roleLabel[updated.role] ?? updated.role}`,
      color: 'success',
    })
  } catch (e: unknown) {
    users.value = users.value.map(u => u.id === user.id ? { ...u, role: prevRole } : u)
    const msg = e instanceof Error ? e.message : '알 수 없는 오류'
    toast.add({ title: '오류', description: msg, color: 'error' })
  } finally {
    const next = { ...roleLoading.value }
    delete next[user.id]
    roleLoading.value = next
  }
}

async function saveMemo(user: AdminUser) {
  const state = getMemo(user.id)
  if (state.saving) return

  memoState.value = {
    ...memoState.value,
    [user.id]: { ...state, saving: true },
  }

  try {
    const res = await fetch(`${WORKER_BASE}/api/admin/users/${user.id}/memo`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ memo: state.draft }),
    })

    if (!res.ok) {
      let msg = `메모 저장 실패 (${res.status})`
      try {
        const body = await res.json() as { error?: string }
        if (body.error === 'forbidden') msg = '관리자 권한이 필요합니다'
        else if (body.error === 'user_not_found') msg = '사용자를 찾을 수 없습니다'
      } catch { /* ignore */ }
      toast.add({ title: '오류', description: msg, color: 'error' })
      memoState.value = {
        ...memoState.value,
        [user.id]: { ...state, saving: false },
      }
      return
    }

    const updated = await res.json() as { id: string; admin_memo: string | null }
    users.value = users.value.map(u =>
      u.id === updated.id ? { ...u, admin_memo: updated.admin_memo } : u
    )

    const next = { ...memoState.value }
    delete next[user.id]
    memoState.value = next

    toast.add({ title: '메모 저장', description: updated.admin_memo ? '메모가 저장되었습니다' : '메모가 삭제되었습니다', color: 'success' })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : '알 수 없는 오류'
    toast.add({ title: '오류', description: msg, color: 'error' })
    memoState.value = {
      ...memoState.value,
      [user.id]: { ...state, saving: false },
    }
  }
}

// ─── 블라인드 평가 상태 ───────────────────────────────────────────────────────

// 풀 구성
const blindNReal = ref(15)
const blindNGen = ref(15)
const blindPoolStatus = ref<'idle' | 'loading' | 'done' | 'error'>('idle')
const blindPoolError = ref<string | null>(null)
const blindPoolResult = ref<BlindPoolResult | null>(null)

// 풀 목록
const blindPoolsStatus = ref<'idle' | 'loading' | 'done' | 'error'>('idle')
const blindPoolsError = ref<string | null>(null)
const blindPools = ref<BlindPoolListItem[]>([])

// 결과 패널
const blindResultStatus = ref<'idle' | 'loading' | 'done' | 'error'>('idle')
const blindResultError = ref<string | null>(null)
const blindResult = ref<BlindResultData | null>(null)
const blindResultPool = ref<string | null>(null)  // 현재 결과를 보고 있는 pool id

// ─── 블라인드 평가 API ────────────────────────────────────────────────────────

async function createBlindPool() {
  blindPoolStatus.value = 'loading'
  blindPoolError.value = null
  blindPoolResult.value = null
  try {
    const body: Record<string, unknown> = {
      n_real: blindNReal.value,
      n_gen: blindNGen.value,
    }
    // 글로벌(전체) 컨텍스트: place_row_id 미전송
    const res = await fetch(`${WORKER_BASE}/api/blind-test/pool`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      let msg = `오류 ${res.status}`
      try {
        const b = await res.json() as { error?: string; message?: string }
        if (b.message) msg = b.message
        else if (b.error) msg = b.error
      } catch { /* ignore */ }
      blindPoolError.value = msg
      blindPoolStatus.value = 'error'
      return
    }
    const data = await res.json() as BlindPoolResult
    blindPoolResult.value = data
    blindPoolStatus.value = 'done'
    // 풀 목록 갱신
    await fetchBlindPools()
  } catch (e: unknown) {
    blindPoolError.value = e instanceof Error ? e.message : '알 수 없는 오류'
    blindPoolStatus.value = 'error'
  }
}

async function fetchBlindPools() {
  blindPoolsStatus.value = 'loading'
  blindPoolsError.value = null
  try {
    const res = await fetch(`${WORKER_BASE}/api/blind-test/pools`, {
      headers: authHeaders(),
    })
    if (!res.ok) {
      let msg = `오류 ${res.status}`
      try {
        const b = await res.json() as { error?: string; message?: string }
        if (b.message) msg = b.message
        else if (b.error) msg = b.error
      } catch { /* ignore */ }
      blindPoolsError.value = msg
      blindPoolsStatus.value = 'error'
      return
    }
    const data = await res.json() as { pools: BlindPoolListItem[] }
    blindPools.value = data.pools
    blindPoolsStatus.value = 'done'
  } catch (e: unknown) {
    blindPoolsError.value = e instanceof Error ? e.message : '알 수 없는 오류'
    blindPoolsStatus.value = 'error'
  }
}

async function fetchBlindResults(poolId: string) {
  blindResultStatus.value = 'loading'
  blindResultError.value = null
  blindResult.value = null
  blindResultPool.value = poolId
  try {
    const params = new URLSearchParams()
    if (poolId.trim()) params.set('pool', poolId.trim())
    const res = await fetch(`${WORKER_BASE}/api/blind-test/results?${params}`, {
      headers: authHeaders(),
    })
    if (!res.ok) {
      let msg = `오류 ${res.status}`
      try {
        const b = await res.json() as { error?: string; message?: string }
        if (b.message) msg = b.message
        else if (b.error) msg = b.error
      } catch { /* ignore */ }
      blindResultError.value = msg
      blindResultStatus.value = 'error'
      return
    }
    const data = await res.json() as BlindResultData
    blindResult.value = data
    blindResultStatus.value = 'done'
  } catch (e: unknown) {
    blindResultError.value = e instanceof Error ? e.message : '알 수 없는 오류'
    blindResultStatus.value = 'error'
  }
}

// 블라인드 분포 막대 너비 계산
function blindDistPct(count: number | undefined, total: number): number {
  if (!count || !total) return 0
  return Math.round((count / total) * 100)
}

function formatBlindDate(s: string): string {
  const d = new Date(s)
  if (isNaN(d.getTime())) return s
  return d.toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

// 서브탭 전환 시 블라인드 탭 데이터 로드
function switchToBlindTab() {
  activeSubTab.value = 'blind-test'
  if (blindPoolsStatus.value === 'idle') {
    fetchBlindPools()
  }
}

// ─── 초기 로드 ────────────────────────────────────────────────────────────────

onMounted(() => {
  loadAll()
})
</script>

<template>
  <!--
    height 체인: default 레이아웃 main(flex-1 min-h-0 overflow-y-auto p-6) → h-full flex flex-col
    고정 헤더/서브탭/카드 shrink-0 / 본문 영역 flex-1 min-h-0 overflow-y-auto
  -->
  <div class="h-full flex flex-col gap-3 overflow-hidden max-w-7xl">

    <!-- ── 페이지 헤더 (shrink-0) ──────────────────────────────────────────── -->
    <div class="shrink-0 flex items-center justify-between">
      <h1 class="text-base font-semibold text-gray-900 dark:text-slate-100">사용자 관리</h1>
      <UButton
        v-if="activeSubTab === 'users'"
        icon="i-heroicons-arrow-path"
        size="sm"
        color="neutral"
        variant="outline"
        :loading="loadStatus === 'loading'"
        label="새로고침"
        @click="loadAll"
      />
      <UButton
        v-else
        icon="i-heroicons-arrow-path"
        size="sm"
        color="neutral"
        variant="outline"
        :loading="blindPoolsStatus === 'loading'"
        label="새로고침"
        @click="fetchBlindPools"
      />
    </div>

    <!-- ── 서브탭 바 (shrink-0) ────────────────────────────────────────────── -->
    <div class="shrink-0 flex border-b border-gray-200 dark:border-slate-700">
      <button
        class="px-4 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap"
        :class="activeSubTab === 'users'
          ? 'border-primary-500 text-primary-600 dark:text-primary-400'
          : 'border-transparent text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-200'"
        @click="activeSubTab = 'users'"
      >
        사용자
      </button>
      <button
        class="px-4 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap"
        :class="activeSubTab === 'blind-test'
          ? 'border-primary-500 text-primary-600 dark:text-primary-400'
          : 'border-transparent text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-200'"
        @click="switchToBlindTab"
      >
        블라인드 평가
      </button>
    </div>

    <!-- ════════════════════════════════════════════════════════════════════════ -->
    <!-- 섹션 1: 사용자 -->
    <!-- ════════════════════════════════════════════════════════════════════════ -->
    <template v-if="activeSubTab === 'users'">

      <!-- ── 요약 서브헤더 ────────────────────────────────────────────────── -->
      <p v-if="loadStatus === 'done'" class="shrink-0 text-xs text-gray-400 dark:text-slate-500">
        전체 {{ totalCount }}명
        <template v-if="pendingCount > 0">
          · <span class="text-amber-600 dark:text-amber-400 font-medium">대기 {{ pendingCount }}명</span>
        </template>
        <template v-if="searchQuery.trim()">
          · 검색 결과 {{ filteredRows.length }}명
        </template>
      </p>

      <!-- ── 요약 카드 (shrink-0) ────────────────────────────────────────── -->
      <div
        v-if="loadStatus === 'done'"
        class="shrink-0 grid grid-cols-6 gap-2"
      >
        <!-- 전체 사용자 -->
        <div class="bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg px-3 py-2 flex flex-col gap-0.5">
          <span class="text-[10px] text-gray-400 dark:text-slate-500 whitespace-nowrap">전체 사용자</span>
          <span class="text-lg font-semibold text-gray-900 dark:text-slate-100 tabular-nums leading-tight">{{ totalCount }}</span>
          <span class="text-[10px] text-gray-400 dark:text-slate-500">명</span>
        </div>
        <!-- 연구원/관리자 -->
        <div class="bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg px-3 py-2 flex flex-col gap-0.5">
          <span class="text-[10px] text-gray-400 dark:text-slate-500 whitespace-nowrap">연구원+관리자</span>
          <span class="text-lg font-semibold text-blue-700 dark:text-blue-400 tabular-nums leading-tight">{{ researcherCount }}</span>
          <span class="text-[10px] text-gray-400 dark:text-slate-500">명</span>
        </div>
        <!-- 총 수집 -->
        <div class="bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg px-3 py-2 flex flex-col gap-0.5">
          <span class="text-[10px] text-gray-400 dark:text-slate-500">총 수집</span>
          <span class="text-lg font-semibold text-gray-900 dark:text-slate-100 tabular-nums leading-tight">{{ totalCollect.toLocaleString() }}</span>
          <span class="text-[10px] text-gray-400 dark:text-slate-500">건</span>
        </div>
        <!-- 총 예시 생성 -->
        <div class="bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg px-3 py-2 flex flex-col gap-0.5">
          <span class="text-[10px] text-gray-400 dark:text-slate-500">총 예시 생성</span>
          <span class="text-lg font-semibold text-gray-900 dark:text-slate-100 tabular-nums leading-tight">{{ totalSample.toLocaleString() }}</span>
          <span class="text-[10px] text-gray-400 dark:text-slate-500">건</span>
        </div>
        <!-- 총 리포트 -->
        <div class="bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg px-3 py-2 flex flex-col gap-0.5">
          <span class="text-[10px] text-gray-400 dark:text-slate-500">총 리포트</span>
          <span class="text-lg font-semibold text-gray-900 dark:text-slate-100 tabular-nums leading-tight">{{ totalReport.toLocaleString() }}</span>
          <span class="text-[10px] text-gray-400 dark:text-slate-500">건</span>
        </div>
        <!-- 총 API 비용 -->
        <div class="bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg px-3 py-2 flex flex-col gap-0.5">
          <span class="text-[10px] text-gray-400 dark:text-slate-500">총 API 비용</span>
          <span class="text-lg font-semibold text-orange-600 dark:text-orange-400 tabular-nums leading-tight font-mono">{{ formatCostUsd(totalCostUsd) }}</span>
          <span class="text-[10px] text-gray-400 dark:text-slate-500">USD</span>
        </div>
      </div>

      <!-- ── 검색 바 (shrink-0) ─────────────────────────────────────────── -->
      <div v-if="loadStatus === 'done'" class="shrink-0">
        <UInput
          v-model="searchQuery"
          icon="i-heroicons-magnifying-glass"
          placeholder="이름·이메일 검색..."
          size="sm"
          class="w-72"
        />
      </div>

      <!-- ── 본문 표 영역 (flex-1 min-h-0) ─────────────────────────────── -->
      <div class="flex-1 min-h-0 flex flex-col border border-gray-200 dark:border-slate-700 rounded-lg overflow-hidden">

        <!-- Loading / Idle -->
        <div v-if="loadStatus === 'loading' || loadStatus === 'idle'" class="flex-1 flex items-center justify-center">
          <UIcon name="i-heroicons-arrow-path" class="w-5 h-5 text-gray-400 dark:text-slate-500 animate-spin" />
        </div>

        <!-- Error -->
        <div v-else-if="loadStatus === 'error'" class="flex-1 flex flex-col items-center justify-center gap-3">
          <p class="text-sm text-red-500 dark:text-red-400">{{ loadError }}</p>
          <UButton label="재시도" size="sm" color="neutral" variant="outline" @click="loadAll" />
        </div>

        <!-- Empty (users 없음) -->
        <div v-else-if="loadStatus === 'done' && users.length === 0" class="flex-1 flex items-center justify-center">
          <p class="text-sm text-gray-400 dark:text-slate-500">등록된 사용자가 없습니다.</p>
        </div>

        <!-- Empty (검색 결과 없음) -->
        <div v-else-if="loadStatus === 'done' && filteredRows.length === 0" class="flex-1 flex items-center justify-center">
          <p class="text-sm text-gray-400 dark:text-slate-500">"{{ searchQuery }}"에 해당하는 사용자가 없습니다.</p>
        </div>

        <!-- Success: 통합 표 -->
        <template v-else>
          <div class="flex-1 min-h-0 overflow-auto">
            <table class="w-full text-xs border-collapse">
              <thead class="sticky top-0 z-10 bg-gray-50 dark:bg-slate-900">
                <tr class="h-8">
                  <!-- 사용자: 남은 공간 차지 -->
                  <th class="px-2 text-left font-medium text-gray-600 dark:text-slate-400 whitespace-nowrap border-b border-gray-200 dark:border-slate-700 min-w-0">
                    <button class="flex items-center gap-1 hover:text-gray-900 dark:hover:text-slate-100 transition-colors" @click="setSort('name')">
                      사용자
                      <UIcon :name="sortIcon('name')" class="w-3 h-3" />
                    </button>
                  </th>
                  <!-- 상태 -->
                  <th class="px-2 text-left font-medium text-gray-600 dark:text-slate-400 whitespace-nowrap border-b border-gray-200 dark:border-slate-700 w-14">
                    <button class="flex items-center gap-1 hover:text-gray-900 dark:hover:text-slate-100 transition-colors" @click="setSort('status')">
                      상태
                      <UIcon :name="sortIcon('status')" class="w-3 h-3" />
                    </button>
                  </th>
                  <!-- 역할 (select로 변경, 정렬 버튼 유지) -->
                  <th class="px-2 text-left font-medium text-gray-600 dark:text-slate-400 whitespace-nowrap border-b border-gray-200 dark:border-slate-700 w-24">
                    <button class="flex items-center gap-1 hover:text-gray-900 dark:hover:text-slate-100 transition-colors" @click="setSort('role')">
                      역할
                      <UIcon :name="sortIcon('role')" class="w-3 h-3" />
                    </button>
                  </th>
                  <!-- 수집 -->
                  <th class="px-2 text-right font-medium text-gray-600 dark:text-slate-400 whitespace-nowrap border-b border-gray-200 dark:border-slate-700 w-12">
                    <button class="flex items-center justify-end gap-1 w-full hover:text-gray-900 dark:hover:text-slate-100 transition-colors" @click="setSort('collect_count')">
                      수집
                      <UIcon :name="sortIcon('collect_count')" class="w-3 h-3" />
                    </button>
                  </th>
                  <!-- 예시 -->
                  <th class="px-2 text-right font-medium text-gray-600 dark:text-slate-400 whitespace-nowrap border-b border-gray-200 dark:border-slate-700 w-12">
                    <button class="flex items-center justify-end gap-1 w-full hover:text-gray-900 dark:hover:text-slate-100 transition-colors" @click="setSort('sample_count')">
                      예시
                      <UIcon :name="sortIcon('sample_count')" class="w-3 h-3" />
                    </button>
                  </th>
                  <!-- 리포트 -->
                  <th class="px-2 text-right font-medium text-gray-600 dark:text-slate-400 whitespace-nowrap border-b border-gray-200 dark:border-slate-700 w-14">
                    <button class="flex items-center justify-end gap-1 w-full hover:text-gray-900 dark:hover:text-slate-100 transition-colors" @click="setSort('report_count')">
                      리포트
                      <UIcon :name="sortIcon('report_count')" class="w-3 h-3" />
                    </button>
                  </th>
                  <!-- API 비용 -->
                  <th class="px-2 text-right font-medium text-gray-600 dark:text-slate-400 whitespace-nowrap border-b border-gray-200 dark:border-slate-700 w-20">
                    <button class="flex items-center justify-end gap-1 w-full hover:text-gray-900 dark:hover:text-slate-100 transition-colors" @click="setSort('total_cost_usd')">
                      API비용
                      <UIcon :name="sortIcon('total_cost_usd')" class="w-3 h-3" />
                    </button>
                  </th>
                  <!-- 메모 -->
                  <th class="px-2 text-left font-medium text-gray-600 dark:text-slate-400 whitespace-nowrap border-b border-gray-200 dark:border-slate-700 w-32">메모</th>
                  <!-- 작업 -->
                  <th class="px-2 text-right font-medium text-gray-600 dark:text-slate-400 whitespace-nowrap border-b border-gray-200 dark:border-slate-700 w-14">작업</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="row in filteredRows"
                  :key="row.id"
                  class="border-b border-gray-100 dark:border-slate-700 last:border-0 hover:bg-gray-50 dark:hover:bg-slate-700 transition-colors"
                  :class="isHighCost(row) ? 'bg-orange-50/40 dark:bg-orange-950/20' : ''"
                >
                  <!-- 사용자: picture + name + email -->
                  <td class="px-2 py-1.5 align-middle max-w-0">
                    <div class="flex items-center gap-1.5">
                      <img
                        v-if="row.picture"
                        :src="row.picture"
                        :alt="row.name"
                        class="w-6 h-6 rounded-full shrink-0 object-cover bg-gray-100 dark:bg-slate-700"
                      />
                      <span v-else class="w-6 h-6 rounded-full shrink-0 bg-gray-200 dark:bg-slate-700 flex items-center justify-center">
                        <UIcon name="i-heroicons-user" class="w-3 h-3 text-gray-400 dark:text-slate-500" />
                      </span>
                      <div class="flex flex-col leading-snug min-w-0">
                        <span class="text-xs font-medium text-gray-900 dark:text-slate-100 truncate">{{ row.name || '—' }}</span>
                        <span class="text-[10px] text-gray-400 dark:text-slate-500 truncate">{{ row.email }}</span>
                      </div>
                    </div>
                  </td>

                  <!-- 상태 뱃지 -->
                  <td class="px-2 py-1.5 align-middle whitespace-nowrap">
                    <UBadge v-if="row.status === 'approved'" label="승인" color="success" variant="subtle" size="sm" />
                    <UBadge v-else-if="row.status === 'pending'" label="대기" color="warning" variant="subtle" size="sm" />
                    <UBadge v-else-if="row.status === 'suspended'" label="정지" color="error" variant="subtle" size="sm" />
                  </td>

                  <!-- 역할: select 드롭다운 -->
                  <td class="px-2 py-1.5 align-middle">
                    <!-- 본인(admin) 행: 변경 불가 표시 -->
                    <span v-if="row.id === authStore.user?.id" class="inline-flex items-center gap-1 text-[10px] text-amber-700 dark:text-amber-400">
                      <span>관리자</span><span class="text-gray-300 dark:text-slate-600">(본인)</span>
                    </span>
                    <!-- 다른 사용자: select -->
                    <div v-else class="relative">
                      <select
                        :value="row.role"
                        :disabled="roleLoading[row.id]"
                        class="h-7 w-full rounded border text-[11px] px-1.5 pr-5 appearance-none cursor-pointer bg-white dark:bg-slate-800 border-gray-200 dark:border-slate-600 text-gray-700 dark:text-slate-300 hover:border-gray-400 dark:hover:border-slate-400 focus:outline-none focus:ring-1 focus:ring-blue-400 disabled:opacity-50 disabled:cursor-not-allowed"
                        @change="(e) => changeRole(row, (e.target as HTMLSelectElement).value as 'user' | 'researcher' | 'admin' | 'tester')"
                      >
                        <option value="user">일반</option>
                        <option value="tester">테스터</option>
                        <option value="researcher">연구원</option>
                        <option value="admin">관리자</option>
                      </select>
                      <UIcon
                        v-if="roleLoading[row.id]"
                        name="i-heroicons-arrow-path"
                        class="w-3 h-3 animate-spin absolute right-1 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none"
                      />
                    </div>
                  </td>

                  <!-- 수집 -->
                  <td class="px-2 py-1.5 align-middle text-right tabular-nums" :class="row.has_activity ? 'text-gray-700 dark:text-slate-300' : 'text-gray-300 dark:text-slate-600'">
                    {{ row.has_activity ? row.collect_count.toLocaleString() : '—' }}
                  </td>

                  <!-- 예시 생성 -->
                  <td class="px-2 py-1.5 align-middle text-right tabular-nums" :class="row.has_activity ? 'text-gray-700 dark:text-slate-300' : 'text-gray-300 dark:text-slate-600'">
                    {{ row.has_activity ? row.sample_count.toLocaleString() : '—' }}
                  </td>

                  <!-- 리포트 -->
                  <td class="px-2 py-1.5 align-middle text-right tabular-nums" :class="row.has_activity ? 'text-gray-700 dark:text-slate-300' : 'text-gray-300 dark:text-slate-600'">
                    {{ row.has_activity ? row.report_count.toLocaleString() : '—' }}
                  </td>

                  <!-- API 비용 -->
                  <td class="px-2 py-1.5 align-middle text-right tabular-nums font-mono whitespace-nowrap"
                    :class="isHighCost(row)
                      ? 'text-orange-600 dark:text-orange-400 font-semibold'
                      : row.has_activity
                        ? 'text-gray-700 dark:text-slate-300'
                        : 'text-gray-300 dark:text-slate-600'"
                  >
                    <template v-if="row.has_activity">
                      {{ formatCostUsd(row.total_cost_usd) }}
                      <UIcon
                        v-if="isHighCost(row)"
                        name="i-heroicons-exclamation-triangle"
                        class="w-3 h-3 text-orange-500 dark:text-orange-400 inline-block ml-0.5 align-middle"
                      />
                    </template>
                    <template v-else>—</template>
                  </td>

                  <!-- 메모 셀 -->
                  <td class="px-2 py-1.5 align-middle w-32 max-w-32">
                    <!-- 편집 모드 -->
                    <div v-if="getMemo(row.id).editing" class="flex items-center gap-1">
                      <UInput
                        :model-value="getMemo(row.id).draft"
                        size="xs"
                        placeholder="메모..."
                        class="flex-1 min-w-0"
                        :disabled="getMemo(row.id).saving"
                        @update:model-value="val => memoState[row.id] = { ...getMemo(row.id), draft: String(val) }"
                        @keydown="onMemoKeydown($event, row)"
                      />
                      <UButton size="xs" color="neutral" variant="solid" label="저장" :loading="getMemo(row.id).saving" :disabled="getMemo(row.id).saving" @click="saveMemo(row)" />
                      <UButton size="xs" color="neutral" variant="ghost" icon="i-heroicons-x-mark" :disabled="getMemo(row.id).saving" @click="cancelEditMemo(row.id)" />
                    </div>
                    <!-- 표시 모드 -->
                    <button v-else class="w-full text-left group" @click="startEditMemo(row)">
                      <span v-if="row.admin_memo" class="text-[10px] text-gray-600 dark:text-slate-400 group-hover:text-gray-900 dark:group-hover:text-slate-100 truncate block">{{ row.admin_memo }}</span>
                      <span v-else class="text-[10px] text-gray-300 dark:text-slate-600 group-hover:text-gray-400 dark:group-hover:text-slate-500">메모 추가</span>
                    </button>
                  </td>

                  <!-- 작업 버튼 -->
                  <td class="px-2 py-1.5 align-middle text-right whitespace-nowrap">
                    <UBadge v-if="row.role === 'admin'" label="관리자" color="neutral" variant="outline" size="sm" />
                    <UButton
                      v-else-if="row.status === 'pending'"
                      label="승인"
                      size="xs"
                      color="success"
                      variant="soft"
                      :loading="actionLoading[row.id]"
                      :disabled="actionLoading[row.id]"
                      @click="changeStatus(row, 'approved')"
                    />
                    <UButton
                      v-else-if="row.status === 'approved'"
                      label="정지"
                      size="xs"
                      color="error"
                      variant="soft"
                      :loading="actionLoading[row.id]"
                      :disabled="actionLoading[row.id]"
                      @click="changeStatus(row, 'suspended')"
                    />
                    <UButton
                      v-else-if="row.status === 'suspended'"
                      label="재승인"
                      size="xs"
                      color="success"
                      variant="soft"
                      :loading="actionLoading[row.id]"
                      :disabled="actionLoading[row.id]"
                      @click="changeStatus(row, 'approved')"
                    />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </div>

    </template>
    <!-- /섹션 1: 사용자 -->

    <!-- ════════════════════════════════════════════════════════════════════════ -->
    <!-- 섹션 2: 블라인드 평가 -->
    <!-- ════════════════════════════════════════════════════════════════════════ -->
    <template v-else-if="activeSubTab === 'blind-test'">

      <!-- 전체 영역을 스크롤 가능하게 -->
      <div class="flex-1 min-h-0 overflow-y-auto flex flex-col gap-4">

        <!-- 안내 배너 -->
        <div class="shrink-0 text-xs text-gray-500 dark:text-slate-400 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded px-3 py-2">
          평가 페이지: <code class="font-mono text-amber-700 dark:text-amber-400">/rate</code>
          &nbsp;—&nbsp;접근코드는 연구실에 별도 공유 (코드 자체는 여기 노출되지 않습니다)
        </div>

        <!-- ─ 풀 만들기 카드 ─ -->
        <div class="shrink-0 bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg p-4 flex flex-col gap-3">
          <h3 class="text-sm font-semibold text-gray-800 dark:text-slate-100">풀 만들기</h3>
          <p class="text-[11px] text-gray-400 dark:text-slate-500">전체(글로벌) 리뷰 풀에서 무작위 샘플링합니다. 지점 필터 없음.</p>

          <!-- n_real / n_gen 입력 -->
          <div class="flex gap-4 flex-wrap">
            <div class="flex flex-col gap-1">
              <label class="text-xs text-gray-500 dark:text-slate-400">진짜 후기 수</label>
              <input
                v-model.number="blindNReal"
                type="number"
                min="1"
                max="100"
                class="w-24 border border-gray-300 dark:border-slate-600 rounded px-2.5 py-1.5 text-sm bg-white dark:bg-slate-700 text-gray-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
            <div class="flex flex-col gap-1">
              <label class="text-xs text-gray-500 dark:text-slate-400">생성 후기 수</label>
              <input
                v-model.number="blindNGen"
                type="number"
                min="1"
                max="100"
                class="w-24 border border-gray-300 dark:border-slate-600 rounded px-2.5 py-1.5 text-sm bg-white dark:bg-slate-700 text-gray-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
          </div>

          <p v-if="blindPoolError" class="text-xs text-red-500 dark:text-red-400">{{ blindPoolError }}</p>

          <div class="flex items-center gap-3">
            <UButton
              label="풀 만들기"
              size="sm"
              color="primary"
              variant="solid"
              icon="i-heroicons-squares-plus"
              :loading="blindPoolStatus === 'loading'"
              :disabled="blindPoolStatus === 'loading'"
              @click="createBlindPool"
            />
          </div>

          <!-- 풀 생성 성공 -->
          <div v-if="blindPoolStatus === 'done' && blindPoolResult" class="flex items-center gap-3 text-xs bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded px-3 py-2">
            <UIcon name="i-heroicons-check-circle" class="w-4 h-4 text-green-600 dark:text-green-400 shrink-0" />
            <div class="flex flex-col gap-0.5">
              <span class="font-medium text-green-700 dark:text-green-300">풀 생성 완료</span>
              <span class="text-green-600 dark:text-green-400 font-mono text-[11px]">{{ blindPoolResult.pool }}</span>
              <span class="text-green-600 dark:text-green-400">
                진짜 {{ blindPoolResult.n_real }}건 · 생성 {{ blindPoolResult.n_gen }}건 · 합계 {{ blindPoolResult.total }}건
              </span>
            </div>
          </div>
        </div>

        <!-- ─ 풀 목록 ─ -->
        <div class="shrink-0 bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg overflow-hidden flex flex-col">
          <div class="px-4 py-3 border-b border-gray-200 dark:border-slate-700 flex items-center justify-between">
            <h3 class="text-sm font-semibold text-gray-800 dark:text-slate-100">풀 목록</h3>
            <UButton
              icon="i-heroicons-arrow-path"
              size="xs"
              color="neutral"
              variant="ghost"
              :loading="blindPoolsStatus === 'loading'"
              @click="fetchBlindPools"
            />
          </div>

          <!-- Loading -->
          <div v-if="blindPoolsStatus === 'loading' || blindPoolsStatus === 'idle'" class="flex items-center justify-center py-6">
            <UIcon name="i-heroicons-arrow-path" class="w-4 h-4 text-gray-400 dark:text-slate-500 animate-spin" />
          </div>

          <!-- Error -->
          <div v-else-if="blindPoolsStatus === 'error'" class="flex flex-col items-center gap-2 py-6">
            <p class="text-xs text-red-500 dark:text-red-400">{{ blindPoolsError }}</p>
            <UButton label="재시도" size="xs" color="neutral" variant="outline" @click="fetchBlindPools" />
          </div>

          <!-- Empty -->
          <div v-else-if="blindPools.length === 0" class="flex items-center justify-center py-6">
            <p class="text-xs text-gray-400 dark:text-slate-500">생성된 풀이 없습니다.</p>
          </div>

          <!-- 풀 표 -->
          <div v-else class="overflow-x-auto">
            <table class="w-full text-xs border-collapse">
              <thead class="bg-gray-50 dark:bg-slate-900">
                <tr class="h-7">
                  <th class="px-3 text-left font-medium text-gray-600 dark:text-slate-400 whitespace-nowrap border-b border-gray-200 dark:border-slate-700">Pool ID</th>
                  <th class="px-3 text-left font-medium text-gray-600 dark:text-slate-400 whitespace-nowrap border-b border-gray-200 dark:border-slate-700">생성일</th>
                  <th class="px-3 text-right font-medium text-gray-600 dark:text-slate-400 whitespace-nowrap border-b border-gray-200 dark:border-slate-700 w-12">진짜</th>
                  <th class="px-3 text-right font-medium text-gray-600 dark:text-slate-400 whitespace-nowrap border-b border-gray-200 dark:border-slate-700 w-12">생성</th>
                  <th class="px-3 text-right font-medium text-gray-600 dark:text-slate-400 whitespace-nowrap border-b border-gray-200 dark:border-slate-700 w-14">평가수</th>
                  <th class="px-3 text-right font-medium text-gray-600 dark:text-slate-400 whitespace-nowrap border-b border-gray-200 dark:border-slate-700 w-14">평가자</th>
                  <th class="px-3 text-right font-medium text-gray-600 dark:text-slate-400 whitespace-nowrap border-b border-gray-200 dark:border-slate-700 w-20"></th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="p in blindPools"
                  :key="p.pool"
                  class="border-b border-gray-100 dark:border-slate-700 last:border-0 hover:bg-gray-50 dark:hover:bg-slate-700/50 transition-colors"
                  :class="blindResultPool === p.pool ? 'bg-blue-50/40 dark:bg-blue-900/10' : ''"
                >
                  <td class="px-3 py-1.5 align-middle font-mono text-[11px] text-gray-600 dark:text-slate-300 whitespace-nowrap">{{ p.pool }}</td>
                  <td class="px-3 py-1.5 align-middle text-gray-500 dark:text-slate-400 whitespace-nowrap">{{ formatBlindDate(p.created_at) }}</td>
                  <td class="px-3 py-1.5 align-middle text-right tabular-nums text-gray-700 dark:text-slate-300">{{ p.n_real }}</td>
                  <td class="px-3 py-1.5 align-middle text-right tabular-nums text-gray-700 dark:text-slate-300">{{ p.n_gen }}</td>
                  <td class="px-3 py-1.5 align-middle text-right tabular-nums text-gray-700 dark:text-slate-300">{{ p.total_ratings }}</td>
                  <td class="px-3 py-1.5 align-middle text-right tabular-nums text-gray-700 dark:text-slate-300">{{ p.raters }}</td>
                  <td class="px-3 py-1.5 align-middle text-right">
                    <UButton
                      label="결과보기"
                      size="xs"
                      color="neutral"
                      variant="outline"
                      :loading="blindResultStatus === 'loading' && blindResultPool === p.pool"
                      @click="fetchBlindResults(p.pool)"
                    />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- ─ 결과 패널 ─ -->
        <div v-if="blindResultStatus !== 'idle'" class="shrink-0 bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg p-4 flex flex-col gap-3">
          <h3 class="text-sm font-semibold text-gray-800 dark:text-slate-100">
            결과
            <span v-if="blindResultPool" class="text-[11px] font-mono font-normal text-gray-400 dark:text-slate-500 ml-2">{{ blindResultPool }}</span>
          </h3>

          <!-- Loading -->
          <div v-if="blindResultStatus === 'loading'" class="flex items-center gap-2 py-2">
            <UIcon name="i-heroicons-arrow-path" class="w-4 h-4 animate-spin text-gray-400 dark:text-slate-500" />
            <span class="text-xs text-gray-400 dark:text-slate-500">불러오는 중...</span>
          </div>

          <!-- Error -->
          <p v-else-if="blindResultStatus === 'error'" class="text-xs text-red-500 dark:text-red-400">{{ blindResultError }}</p>

          <!-- Done -->
          <template v-else-if="blindResultStatus === 'done' && blindResult">
            <!-- 평가자 수 -->
            <div class="flex items-center gap-1.5 text-xs text-gray-500 dark:text-slate-400">
              <UIcon name="i-heroicons-users" class="w-3.5 h-3.5 shrink-0" />
              <span>평가자 {{ blindResult.raters }}명</span>
            </div>

            <!-- 아직 평가가 0건인 풀 -->
            <p v-if="(blindResult.real.n + blindResult.gen.n) === 0" class="text-xs text-amber-600 dark:text-amber-400">
              아직 제출된 평가가 없습니다. <code class="font-mono">/rate</code> 에서 이 풀을 평가하면 결과가 집계됩니다.
            </p>

            <!-- 진짜 vs 생성 비교 -->
            <div class="grid grid-cols-2 gap-3">
              <!-- 진짜 -->
              <div class="flex flex-col gap-2 p-3 bg-gray-50 dark:bg-slate-700/50 rounded">
                <div class="flex items-center gap-1.5">
                  <span class="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
                  <span class="text-xs font-semibold text-gray-700 dark:text-slate-300">진짜 후기</span>
                  <span class="text-xs text-gray-400 dark:text-slate-500 ml-auto tabular-nums">n={{ blindResult.real.n }}</span>
                </div>
                <div class="text-2xl font-bold tabular-nums text-gray-800 dark:text-slate-100">
                  {{ blindResult.real.mean != null ? blindResult.real.mean.toFixed(2) : '—' }}<span class="text-sm font-normal text-gray-400 dark:text-slate-500">/5</span>
                </div>
                <!-- 1~5 분포 바 -->
                <div class="flex flex-col gap-1">
                  <div v-for="s in [1,2,3,4,5]" :key="s" class="flex items-center gap-1.5">
                    <span class="text-[11px] tabular-nums text-gray-400 dark:text-slate-500 w-3 shrink-0">{{ s }}</span>
                    <div class="flex-1 h-2 bg-gray-200 dark:bg-slate-600 rounded-full overflow-hidden">
                      <div
                        class="h-full bg-emerald-400 rounded-full"
                        :style="{ width: blindDistPct((blindResult.real.dist as BlindDistribution)[s as 1|2|3|4|5], blindResult.real.n) + '%' }"
                      />
                    </div>
                    <span class="text-[11px] tabular-nums text-gray-400 dark:text-slate-500 w-5 text-right shrink-0">
                      {{ (blindResult.real.dist as BlindDistribution)[s as 1|2|3|4|5] ?? 0 }}
                    </span>
                  </div>
                </div>
              </div>

              <!-- 생성 -->
              <div class="flex flex-col gap-2 p-3 bg-gray-50 dark:bg-slate-700/50 rounded">
                <div class="flex items-center gap-1.5">
                  <span class="w-2 h-2 rounded-full bg-amber-500 shrink-0" />
                  <span class="text-xs font-semibold text-gray-700 dark:text-slate-300">생성 후기</span>
                  <span class="text-xs text-gray-400 dark:text-slate-500 ml-auto tabular-nums">n={{ blindResult.gen.n }}</span>
                </div>
                <div class="text-2xl font-bold tabular-nums text-gray-800 dark:text-slate-100">
                  {{ blindResult.gen.mean != null ? blindResult.gen.mean.toFixed(2) : '—' }}<span class="text-sm font-normal text-gray-400 dark:text-slate-500">/5</span>
                </div>
                <!-- 1~5 분포 바 -->
                <div class="flex flex-col gap-1">
                  <div v-for="s in [1,2,3,4,5]" :key="s" class="flex items-center gap-1.5">
                    <span class="text-[11px] tabular-nums text-gray-400 dark:text-slate-500 w-3 shrink-0">{{ s }}</span>
                    <div class="flex-1 h-2 bg-gray-200 dark:bg-slate-600 rounded-full overflow-hidden">
                      <div
                        class="h-full bg-amber-400 rounded-full"
                        :style="{ width: blindDistPct((blindResult.gen.dist as BlindDistribution)[s as 1|2|3|4|5], blindResult.gen.n) + '%' }"
                      />
                    </div>
                    <span class="text-[11px] tabular-nums text-gray-400 dark:text-slate-500 w-5 text-right shrink-0">
                      {{ (blindResult.gen.dist as BlindDistribution)[s as 1|2|3|4|5] ?? 0 }}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <!-- 평균 차이 -->
            <div class="flex items-center gap-2 text-xs">
              <span class="text-gray-500 dark:text-slate-400">평균 차이 (진짜 - 생성):</span>
              <span
                class="font-semibold tabular-nums"
                :class="blindResult.mean_diff > 0 ? 'text-emerald-600 dark:text-emerald-400' : blindResult.mean_diff < 0 ? 'text-amber-600 dark:text-amber-400' : 'text-gray-600 dark:text-slate-300'"
              >
                {{ blindResult.mean_diff == null ? '—' : (blindResult.mean_diff >= 0 ? '+' : '') + blindResult.mean_diff.toFixed(2) }}
              </span>
            </div>

            <!-- Mann-Whitney -->
            <div class="border-t border-gray-100 dark:border-slate-700 pt-3 flex flex-col gap-1.5">
              <span class="text-xs font-semibold text-gray-700 dark:text-slate-300">Mann-Whitney U 검정</span>
              <div v-if="blindResult.mann_whitney.z != null" class="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-gray-600 dark:text-slate-400">
                <span>U = <span class="tabular-nums font-medium text-gray-800 dark:text-slate-200">{{ blindResult.mann_whitney.U }}</span></span>
                <span>z = <span class="tabular-nums font-medium text-gray-800 dark:text-slate-200">{{ blindResult.mann_whitney.z.toFixed(3) }}</span></span>
                <span>p ≈ <span class="tabular-nums font-medium" :class="blindResult.mann_whitney.p_approx < 0.05 ? 'text-emerald-600 dark:text-emerald-400' : 'text-gray-800 dark:text-slate-200'">{{ blindResult.mann_whitney.p_approx.toFixed(3) }}</span></span>
              </div>
              <p v-if="blindResult.mann_whitney.note" class="text-[11px] text-amber-600 dark:text-amber-400">{{ blindResult.mann_whitney.note }}</p>
              <p class="text-[11px] text-gray-400 dark:text-slate-500 leading-relaxed">
                이 검정은 두 그룹의 평점 분포가 같은지 비교합니다.
                "구분불가(p &gt; 0.05)"는 좋음이 아니라 표본 미달이거나 실제로 차이가 없다는 뜻입니다.
              </p>
            </div>
          </template>
        </div>

      </div>
    </template>
    <!-- /섹션 2: 블라인드 평가 -->

  </div>
</template>
