/**
 * 전역 인증 미들웨어 (기획서 5.4, 10.3)
 *
 * 가드 순서:
 * 1. 서버 사이드 → 통과
 * 2. !isReady → 통과 (restore() 완료 전)
 * 3. 미인증 + /app/* → /login?redirect=...
 * 4. 인증 + (/login | /) → 승인됐으면 /app, 아니면 /pending
 * 5. 인증 + 미승인 + /app/* → /pending
 * 6. 인증 + 승인됨 + /pending → /app
 * 7. 그 외 → 통과
 */
export default defineNuxtRouteMiddleware((to) => {
  // 1. 서버 사이드에서는 가드 실행 안 함 (localStorage 접근 불가)
  if (!import.meta.client) return

  const authStore = useAuthStore()

  // 2. isReady가 false이면 아직 restore() 완료 전 → 통과
  if (!authStore.isReady) return

  const isAuthed = authStore.isAuthed
  const isApproved = authStore.isApproved
  const path = to.path

  // 3. 미인증 + /app/* → /login
  if (path.startsWith('/app')) {
    if (!isAuthed) {
      return navigateTo(`/login?redirect=${encodeURIComponent(to.fullPath)}`, { replace: true })
    }
    // 5. 인증됐지만 미승인 + /app/* → /pending
    if (!isApproved) {
      return navigateTo('/pending', { replace: true })
    }
    return // 인증 + 승인 → 통과
  }

  // 4. 인증 + (/login | /) → 승인 여부에 따라 분기
  if (isAuthed && (path === '/' || path === '/login')) {
    if (isApproved) {
      return navigateTo('/app', { replace: true })
    }
    else {
      return navigateTo('/pending', { replace: true })
    }
  }

  // 6. 인증 + 승인됨 + /pending → /app (이미 승인됐는데 대기 화면 갈 필요 없음)
  if (isAuthed && isApproved && path === '/pending') {
    return navigateTo('/app', { replace: true })
  }

  // 7. 그 외 → 통과
})
