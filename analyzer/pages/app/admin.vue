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
  role: 'user' | 'researcher' | 'admin'
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

// ─── 상태 ────────────────────────────────────────────────────────────────────

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
      const order = { admin: 0, researcher: 1, user: 2 }
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

// ─── API 호출 ─────────────────────────────────────────────────────────────────

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

async function changeRole(user: AdminUser, newRole: 'user' | 'researcher' | 'admin') {
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

    const updated = await res.json() as { id: string; role: 'user' | 'researcher' | 'admin' }
    users.value = users.value.map(u => u.id === updated.id ? { ...u, role: updated.role } : u)

    const roleLabel: Record<string, string> = { user: '일반', researcher: '연구원', admin: '관리자' }
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

// ─── 초기 로드 ────────────────────────────────────────────────────────────────

onMounted(() => {
  loadAll()
})
</script>

<template>
  <!--
    height 체인: default 레이아웃 main(flex-1 min-h-0 overflow-y-auto p-6) → h-full flex flex-col
    고정 헤더/카드 shrink-0 / 표 영역 flex-1 min-h-0 overflow-y-auto
  -->
  <div class="h-full flex flex-col gap-3 overflow-hidden">

    <!-- ── 페이지 헤더 (shrink-0) ──────────────────────────────────────────── -->
    <div class="shrink-0 flex items-center justify-between">
      <div class="flex flex-col gap-0.5">
        <h1 class="text-base font-semibold text-gray-900 dark:text-slate-100">사용자 관리</h1>
        <p v-if="loadStatus === 'done'" class="text-xs text-gray-400 dark:text-slate-500">
          전체 {{ totalCount }}명
          <template v-if="pendingCount > 0">
            · <span class="text-amber-600 dark:text-amber-400 font-medium">대기 {{ pendingCount }}명</span>
          </template>
          <template v-if="searchQuery.trim()">
            · 검색 결과 {{ filteredRows.length }}명
          </template>
        </p>
      </div>
      <UButton
        icon="i-heroicons-arrow-path"
        size="sm"
        color="neutral"
        variant="outline"
        :loading="loadStatus === 'loading'"
        label="새로고침"
        @click="loadAll"
      />
    </div>

    <!-- ── 요약 카드 (shrink-0) ────────────────────────────────────────────── -->
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

    <!-- ── 검색 바 (shrink-0) ───────────────────────────────────────────────── -->
    <div v-if="loadStatus === 'done'" class="shrink-0">
      <UInput
        v-model="searchQuery"
        icon="i-heroicons-magnifying-glass"
        placeholder="이름·이메일 검색..."
        size="sm"
        class="w-72"
      />
    </div>

    <!-- ── 본문 표 영역 (flex-1 min-h-0) ──────────────────────────────────── -->
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
          <table class="w-full text-sm border-collapse">
            <thead class="sticky top-0 z-10 bg-gray-50 dark:bg-slate-900">
              <tr class="h-9">
                <!-- 사용자 -->
                <th class="px-3 text-left font-medium text-gray-600 dark:text-slate-400 text-xs whitespace-nowrap border-b border-gray-200 dark:border-slate-700">
                  <button class="flex items-center gap-1 hover:text-gray-900 dark:hover:text-slate-100 transition-colors" @click="setSort('name')">
                    사용자
                    <UIcon :name="sortIcon('name')" class="w-3 h-3" />
                  </button>
                </th>
                <!-- 상태 -->
                <th class="px-3 text-left font-medium text-gray-600 dark:text-slate-400 text-xs whitespace-nowrap border-b border-gray-200 dark:border-slate-700 w-20">
                  <button class="flex items-center gap-1 hover:text-gray-900 dark:hover:text-slate-100 transition-colors" @click="setSort('status')">
                    상태
                    <UIcon :name="sortIcon('status')" class="w-3 h-3" />
                  </button>
                </th>
                <!-- 역할 -->
                <th class="px-3 text-left font-medium text-gray-600 dark:text-slate-400 text-xs whitespace-nowrap border-b border-gray-200 dark:border-slate-700 w-44">
                  <button class="flex items-center gap-1 hover:text-gray-900 dark:hover:text-slate-100 transition-colors" @click="setSort('role')">
                    역할
                    <UIcon :name="sortIcon('role')" class="w-3 h-3" />
                  </button>
                </th>
                <!-- 수집 -->
                <th class="px-3 text-right font-medium text-gray-600 dark:text-slate-400 text-xs whitespace-nowrap border-b border-gray-200 dark:border-slate-700 w-16">
                  <button class="flex items-center justify-end gap-1 w-full hover:text-gray-900 dark:hover:text-slate-100 transition-colors" @click="setSort('collect_count')">
                    수집
                    <UIcon :name="sortIcon('collect_count')" class="w-3 h-3" />
                  </button>
                </th>
                <!-- 예시 생성 -->
                <th class="px-3 text-right font-medium text-gray-600 dark:text-slate-400 text-xs whitespace-nowrap border-b border-gray-200 dark:border-slate-700 w-16">
                  <button class="flex items-center justify-end gap-1 w-full hover:text-gray-900 dark:hover:text-slate-100 transition-colors" @click="setSort('sample_count')">
                    예시
                    <UIcon :name="sortIcon('sample_count')" class="w-3 h-3" />
                  </button>
                </th>
                <!-- 리포트 -->
                <th class="px-3 text-right font-medium text-gray-600 dark:text-slate-400 text-xs whitespace-nowrap border-b border-gray-200 dark:border-slate-700 w-16">
                  <button class="flex items-center justify-end gap-1 w-full hover:text-gray-900 dark:hover:text-slate-100 transition-colors" @click="setSort('report_count')">
                    리포트
                    <UIcon :name="sortIcon('report_count')" class="w-3 h-3" />
                  </button>
                </th>
                <!-- API 비용 -->
                <th class="px-3 text-right font-medium text-gray-600 dark:text-slate-400 text-xs whitespace-nowrap border-b border-gray-200 dark:border-slate-700 w-24">
                  <button class="flex items-center justify-end gap-1 w-full hover:text-gray-900 dark:hover:text-slate-100 transition-colors" @click="setSort('total_cost_usd')">
                    API 비용
                    <UIcon :name="sortIcon('total_cost_usd')" class="w-3 h-3" />
                  </button>
                </th>
                <!-- 메모 -->
                <th class="px-3 text-left font-medium text-gray-600 dark:text-slate-400 text-xs whitespace-nowrap border-b border-gray-200 dark:border-slate-700 w-40">메모</th>
                <!-- 작업 -->
                <th class="px-3 text-right font-medium text-gray-600 dark:text-slate-400 text-xs whitespace-nowrap border-b border-gray-200 dark:border-slate-700 w-24">작업</th>
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
                <td class="px-3 py-2 align-middle">
                  <div class="flex items-center gap-2">
                    <img
                      v-if="row.picture"
                      :src="row.picture"
                      :alt="row.name"
                      class="w-6 h-6 rounded-full shrink-0 object-cover bg-gray-100 dark:bg-slate-700"
                    />
                    <span v-else class="w-6 h-6 rounded-full shrink-0 bg-gray-200 dark:bg-slate-700 flex items-center justify-center">
                      <UIcon name="i-heroicons-user" class="w-3.5 h-3.5 text-gray-400 dark:text-slate-500" />
                    </span>
                    <div class="flex flex-col leading-snug min-w-0">
                      <span class="text-xs font-medium text-gray-900 dark:text-slate-100 truncate">{{ row.name || '—' }}</span>
                      <span class="text-[10px] text-gray-400 dark:text-slate-500 truncate">{{ row.email }}</span>
                    </div>
                  </div>
                </td>

                <!-- 상태 뱃지 -->
                <td class="px-3 py-2 align-middle whitespace-nowrap">
                  <UBadge v-if="row.status === 'approved'" label="승인" color="success" variant="subtle" size="sm" />
                  <UBadge v-else-if="row.status === 'pending'" label="대기" color="warning" variant="subtle" size="sm" />
                  <UBadge v-else-if="row.status === 'suspended'" label="정지" color="error" variant="subtle" size="sm" />
                </td>

                <!-- 역할 버튼 그룹 -->
                <td class="px-3 py-2 align-middle whitespace-nowrap">
                  <!-- 본인(admin) 행: 강등 비활성 -->
                  <div v-if="row.id === authStore.user?.id" class="flex items-center gap-1">
                    <span class="text-[10px] text-gray-400 dark:text-slate-500">(본인)</span>
                    <span class="inline-flex items-center px-1.5 py-0.5 rounded bg-amber-50 dark:bg-amber-950 text-[10px] text-amber-700 dark:text-amber-400 font-medium">관리자</span>
                  </div>
                  <!-- 다른 사용자: 역할 버튼 그룹 -->
                  <div v-else class="flex items-center gap-1">
                    <button
                      v-for="[val, lbl, lightCls, darkCls] in [
                        ['user', '일반', 'bg-gray-100 text-gray-600 border-gray-300', 'dark:bg-slate-700 dark:text-slate-300 dark:border-slate-500'],
                        ['researcher', '연구원', 'bg-blue-50 text-blue-700 border-blue-300', 'dark:bg-blue-950 dark:text-blue-400 dark:border-blue-700'],
                        ['admin', '관리자', 'bg-amber-50 text-amber-700 border-amber-300', 'dark:bg-amber-950 dark:text-amber-400 dark:border-amber-700'],
                      ] as const"
                      :key="val"
                      class="px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors whitespace-nowrap border"
                      :class="row.role === val
                        ? [lightCls, darkCls]
                        : 'bg-white dark:bg-slate-800 text-gray-400 dark:text-slate-500 border-gray-200 dark:border-slate-600 hover:border-gray-400 dark:hover:border-slate-400 hover:text-gray-600 dark:hover:text-slate-300'"
                      :disabled="roleLoading[row.id]"
                      @click="changeRole(row, val)"
                    >
                      <UIcon v-if="roleLoading[row.id] && row.role !== val" name="i-heroicons-arrow-path" class="w-2.5 h-2.5 animate-spin inline" />
                      {{ lbl }}
                    </button>
                  </div>
                </td>

                <!-- 수집 -->
                <td class="px-3 py-2 align-middle text-right text-xs tabular-nums" :class="row.has_activity ? 'text-gray-700 dark:text-slate-300' : 'text-gray-300 dark:text-slate-600'">
                  {{ row.has_activity ? row.collect_count.toLocaleString() : '—' }}
                </td>

                <!-- 예시 생성 -->
                <td class="px-3 py-2 align-middle text-right text-xs tabular-nums" :class="row.has_activity ? 'text-gray-700 dark:text-slate-300' : 'text-gray-300 dark:text-slate-600'">
                  {{ row.has_activity ? row.sample_count.toLocaleString() : '—' }}
                </td>

                <!-- 리포트 -->
                <td class="px-3 py-2 align-middle text-right text-xs tabular-nums" :class="row.has_activity ? 'text-gray-700 dark:text-slate-300' : 'text-gray-300 dark:text-slate-600'">
                  {{ row.has_activity ? row.report_count.toLocaleString() : '—' }}
                </td>

                <!-- API 비용 -->
                <td class="px-3 py-2 align-middle text-right text-xs tabular-nums font-mono whitespace-nowrap"
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
                <td class="px-3 py-1.5 align-middle min-w-36 max-w-48">
                  <!-- 편집 모드 -->
                  <div v-if="getMemo(row.id).editing" class="flex items-center gap-1">
                    <UInput
                      :model-value="getMemo(row.id).draft"
                      size="xs"
                      placeholder="메모 입력..."
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
                    <span v-if="row.admin_memo" class="text-[10px] text-gray-600 dark:text-slate-400 group-hover:text-gray-900 dark:group-hover:text-slate-100 line-clamp-2">{{ row.admin_memo }}</span>
                    <span v-else class="text-[10px] text-gray-300 dark:text-slate-600 group-hover:text-gray-400 dark:group-hover:text-slate-500">메모 추가</span>
                  </button>
                </td>

                <!-- 작업 버튼 -->
                <td class="px-3 py-2 align-middle text-right whitespace-nowrap">
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

  </div>
</template>
