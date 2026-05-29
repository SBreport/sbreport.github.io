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
  role: 'user' | 'admin'
  admin_memo: string | null
}

type LoadStatus = 'idle' | 'loading' | 'done' | 'error'

// ─── 상태 ────────────────────────────────────────────────────────────────────

const authStore = useAuthStore()
const toast = useToast()

const WORKER_BASE = 'https://naver-searchad-proxy.sbreport.workers.dev'

const users = ref<AdminUser[]>([])
const loadStatus = ref<LoadStatus>('idle')
const loadError = ref<string | null>(null)

// 행별 처리 중 상태 (userId → loading)
const actionLoading = ref<Record<string, boolean>>({})

// 메모 편집 상태 (userId → { editing: boolean, draft: string, saving: boolean })
const memoState = ref<Record<string, { editing: boolean; draft: string; saving: boolean }>>({})

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

// ─── 요약 수치 ───────────────────────────────────────────────────────────────

const totalCount = computed(() => users.value.length)
const pendingCount = computed(() => users.value.filter(u => u.status === 'pending').length)

// ─── API 호출 ─────────────────────────────────────────────────────────────────

async function fetchUsers() {
  loadStatus.value = 'loading'
  loadError.value = null
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
      loadError.value = msg
      loadStatus.value = 'error'
      return
    }
    const data = await res.json() as { users: AdminUser[] }
    users.value = data.users
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
    // 로컬 업데이트
    const idx = users.value.findIndex(u => u.id === updated.id)
    if (idx !== -1) {
      users.value = users.value.map((u, i) =>
        i === idx ? { ...u, status: updated.status } : u
      )
    }

    const statusLabel: Record<string, string> = {
      approved: '승인',
      suspended: '정지',
      pending: '대기',
    }
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
    // 로컬 업데이트
    users.value = users.value.map(u =>
      u.id === updated.id ? { ...u, admin_memo: updated.admin_memo } : u
    )

    // 편집 상태 해제
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
  fetchUsers()
})
</script>

<template>
  <!--
    height 체인: default 레이아웃 main(flex-1 min-h-0 overflow-y-auto p-6) → h-full flex flex-col
    고정 헤더 shrink-0 / 표 영역 flex-1 min-h-0 overflow-y-auto
  -->
  <div class="h-full flex flex-col gap-4 overflow-hidden">

    <!-- ── 페이지 헤더 (shrink-0) ──────────────────────────────────────── -->
    <div class="shrink-0 flex items-center justify-between">
      <div class="flex flex-col gap-0.5">
        <h1 class="text-base font-semibold text-gray-900">사용자 관리</h1>
        <p v-if="loadStatus === 'done'" class="text-xs text-gray-400">
          전체 {{ totalCount }}명
          <template v-if="pendingCount > 0">
            · <span class="text-amber-600 font-medium">대기 {{ pendingCount }}명</span>
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
        @click="fetchUsers"
      />
    </div>

    <!-- ── 본문 영역 (flex-1 min-h-0) ─────────────────────────────────── -->
    <div class="flex-1 min-h-0 flex flex-col border border-gray-200 rounded-lg overflow-hidden">

      <!-- Loading -->
      <div v-if="loadStatus === 'loading' || loadStatus === 'idle'" class="flex-1 flex items-center justify-center">
        <UIcon name="i-heroicons-arrow-path" class="w-5 h-5 text-gray-400 animate-spin" />
      </div>

      <!-- Error -->
      <div v-else-if="loadStatus === 'error'" class="flex-1 flex flex-col items-center justify-center gap-3">
        <p class="text-sm text-red-500">{{ loadError }}</p>
        <UButton label="재시도" size="sm" color="neutral" variant="outline" @click="fetchUsers" />
      </div>

      <!-- Empty -->
      <div v-else-if="loadStatus === 'done' && users.length === 0" class="flex-1 flex items-center justify-center">
        <p class="text-sm text-gray-400">등록된 사용자가 없습니다.</p>
      </div>

      <!-- Success: 표 -->
      <template v-else>
        <div class="flex-1 min-h-0 overflow-auto">
          <table class="w-full text-sm border-collapse">
            <thead class="sticky top-0 z-10 bg-gray-50">
              <tr class="h-10">
                <th class="px-3 text-left font-medium text-gray-600 text-xs whitespace-nowrap border-b border-gray-200">사용자</th>
                <th class="px-3 text-left font-medium text-gray-600 text-xs whitespace-nowrap border-b border-gray-200 w-24">상태</th>
                <th class="px-3 text-left font-medium text-gray-600 text-xs whitespace-nowrap border-b border-gray-200 w-28">가입일</th>
                <th class="px-3 text-left font-medium text-gray-600 text-xs whitespace-nowrap border-b border-gray-200 w-28">마지막 로그인</th>
                <th class="px-3 text-left font-medium text-gray-600 text-xs whitespace-nowrap border-b border-gray-200">메모</th>
                <th class="px-3 text-right font-medium text-gray-600 text-xs whitespace-nowrap border-b border-gray-200 w-28">작업</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="user in users"
                :key="user.id"
                class="border-b border-gray-100 last:border-0 hover:bg-gray-50 transition-colors"
              >
                <!-- 사용자: picture + name + email -->
                <td class="px-3 py-2.5 align-middle">
                  <div class="flex items-center gap-2.5">
                    <img
                      v-if="user.picture"
                      :src="user.picture"
                      :alt="user.name"
                      class="w-7 h-7 rounded-full shrink-0 object-cover bg-gray-100"
                    />
                    <span v-else class="w-7 h-7 rounded-full shrink-0 bg-gray-200 flex items-center justify-center">
                      <UIcon name="i-heroicons-user" class="w-4 h-4 text-gray-400" />
                    </span>
                    <div class="flex flex-col leading-snug min-w-0">
                      <span class="text-sm font-medium text-gray-900 truncate">{{ user.name || '—' }}</span>
                      <span class="text-xs text-gray-400 truncate">{{ user.email }}</span>
                    </div>
                  </div>
                </td>

                <!-- 상태 뱃지 -->
                <td class="px-3 py-2.5 align-middle whitespace-nowrap">
                  <UBadge
                    v-if="user.status === 'approved'"
                    label="승인"
                    color="success"
                    variant="subtle"
                    size="sm"
                  />
                  <UBadge
                    v-else-if="user.status === 'pending'"
                    label="대기"
                    color="warning"
                    variant="subtle"
                    size="sm"
                  />
                  <UBadge
                    v-else-if="user.status === 'suspended'"
                    label="정지"
                    color="error"
                    variant="subtle"
                    size="sm"
                  />
                </td>

                <!-- 가입일 -->
                <td class="px-3 py-2.5 align-middle text-xs text-gray-500 whitespace-nowrap">
                  {{ formatDate(user.created_at) }}
                </td>

                <!-- 마지막 로그인 -->
                <td class="px-3 py-2.5 align-middle text-xs text-gray-500 whitespace-nowrap">
                  {{ formatDate(user.last_login_at) }}
                </td>

                <!-- 메모 셀 -->
                <td class="px-3 py-2 align-middle min-w-48 max-w-xs">
                  <!-- 편집 모드 -->
                  <div v-if="getMemo(user.id).editing" class="flex items-center gap-1.5">
                    <UInput
                      :model-value="getMemo(user.id).draft"
                      size="xs"
                      placeholder="메모 입력..."
                      class="flex-1 min-w-0"
                      :disabled="getMemo(user.id).saving"
                      @update:model-value="val => memoState[user.id] = { ...getMemo(user.id), draft: String(val) }"
                      @keydown="onMemoKeydown($event, user)"
                    />
                    <UButton
                      size="xs"
                      color="neutral"
                      variant="solid"
                      label="저장"
                      :loading="getMemo(user.id).saving"
                      :disabled="getMemo(user.id).saving"
                      @click="saveMemo(user)"
                    />
                    <UButton
                      size="xs"
                      color="neutral"
                      variant="ghost"
                      icon="i-heroicons-x-mark"
                      :disabled="getMemo(user.id).saving"
                      @click="cancelEditMemo(user.id)"
                    />
                  </div>
                  <!-- 표시 모드 -->
                  <button
                    v-else
                    class="w-full text-left group"
                    @click="startEditMemo(user)"
                  >
                    <span
                      v-if="user.admin_memo"
                      class="text-xs text-gray-700 group-hover:text-gray-900 line-clamp-2"
                    >{{ user.admin_memo }}</span>
                    <span
                      v-else
                      class="text-xs text-gray-300 group-hover:text-gray-400"
                    >메모 추가</span>
                  </button>
                </td>

                <!-- 작업 버튼 -->
                <td class="px-3 py-2.5 align-middle text-right whitespace-nowrap">
                  <!-- admin 행(본인 포함): 상태 변경 불가, 뱃지만 표시 -->
                  <UBadge
                    v-if="user.role === 'admin'"
                    label="관리자"
                    color="neutral"
                    variant="outline"
                    size="sm"
                  />

                  <!-- pending: 승인 버튼 -->
                  <UButton
                    v-else-if="user.status === 'pending'"
                    label="승인"
                    size="xs"
                    color="success"
                    variant="soft"
                    :loading="actionLoading[user.id]"
                    :disabled="actionLoading[user.id]"
                    @click="changeStatus(user, 'approved')"
                  />

                  <!-- approved: 정지 버튼 -->
                  <UButton
                    v-else-if="user.status === 'approved'"
                    label="정지"
                    size="xs"
                    color="error"
                    variant="soft"
                    :loading="actionLoading[user.id]"
                    :disabled="actionLoading[user.id]"
                    @click="changeStatus(user, 'suspended')"
                  />

                  <!-- suspended: 재승인 버튼 -->
                  <UButton
                    v-else-if="user.status === 'suspended'"
                    label="재승인"
                    size="xs"
                    color="success"
                    variant="soft"
                    :loading="actionLoading[user.id]"
                    :disabled="actionLoading[user.id]"
                    @click="changeStatus(user, 'approved')"
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
