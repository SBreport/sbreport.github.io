import { defineStore } from 'pinia'
import { WORKER_BASE } from '~/composables/useWorkerBase'

const TOKEN_KEY = 'sba-auth-token'

interface User {
  id?: string
  sub: string
  email: string
  name: string
  picture: string
  status?: 'pending' | 'approved' | 'suspended'
  plan?: string
  plan_expires_at?: string | null
  role?: 'user' | 'researcher' | 'admin' | 'tester'
}

export const useAuthStore = defineStore('auth', () => {
  const token = ref<string | null>(null)
  const user = ref<User | null>(null)
  const isReady = ref<boolean>(false)

  const isAuthed = computed(() => !!token.value && !!user.value)

  /** status === 'approved' 일 때만 true */
  const isApproved = computed(() => user.value?.status === 'approved')

  /** role === 'admin' 일 때만 true */
  const isAdmin = computed(() => user.value?.role === 'admin')

  /** role === 'researcher' 또는 'admin' 일 때 true (admin은 researcher 권한 포함) */
  const isResearcher = computed(() => user.value?.role === 'researcher' || user.value?.role === 'admin')

  /** role === 'tester' 일 때 true (예시 생성 전용 제한 등급) */
  const isTester = computed(() => user.value?.role === 'tester')

  /**
   * /api/me 호출하여 user 정보 갱신.
   * 실패 시 null 반환 (호출측에서 처리).
   */
  async function fetchUser(jwt: string): Promise<User | null> {
    try {
      const res = await fetch(`${WORKER_BASE}/api/me`, {
        headers: { Authorization: `Bearer ${jwt}` },
      })
      if (!res.ok) return null
      return (await res.json()) as User
    }
    catch {
      return null
    }
  }

  /**
   * OAuth 콜백에서 token을 받은 뒤 호출.
   * localStorage 저장 + /api/me 호출.
   */
  async function setToken(jwt: string): Promise<boolean> {
    const fetched = await fetchUser(jwt)
    if (!fetched) return false

    token.value = jwt
    user.value = fetched
    if (import.meta.client) {
      localStorage.setItem(TOKEN_KEY, jwt)
    }
    return true
  }

  /**
   * 로그아웃: localStorage 클리어 + 상태 초기화 + /login 이동.
   */
  function logout() {
    token.value = null
    user.value = null
    if (import.meta.client) {
      localStorage.removeItem(TOKEN_KEY)
    }
    navigateTo('/login')
  }

  /**
   * 페이지 로드 시 localStorage에서 token 복원 + /api/me 재호출.
   * 실패하면 로컬 데이터 제거 (조용히, logout() redirect 없이).
   */
  async function restore(): Promise<void> {
    if (!import.meta.client) {
      isReady.value = true
      return
    }

    const stored = localStorage.getItem(TOKEN_KEY)
    if (!stored) {
      isReady.value = true
      return
    }

    const fetched = await fetchUser(stored)
    if (fetched) {
      token.value = stored
      user.value = fetched
    }
    else {
      localStorage.removeItem(TOKEN_KEY)
    }

    isReady.value = true
  }

  return {
    token,
    user,
    isReady,
    isAuthed,
    isApproved,
    isAdmin,
    isResearcher,
    isTester,
    setToken,
    logout,
    restore,
  }
})
