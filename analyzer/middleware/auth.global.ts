/**
 * 전역 인증 미들웨어 (기획서 5.4)
 *
 * 가드 규칙:
 * - /app/* 진입 시 미로그인 → /login?redirect=<원래 URL>
 * - 로그인 상태로 /login 또는 / 진입 → /app
 * - 공개 라우트 (/login, /auth/callback, /terms, /privacy, 404) → 통과
 * - 서버 사이드 / isReady 전 → 통과 (클라이언트에서만 가드 실행)
 */
export default defineNuxtRouteMiddleware((to) => {
  // 서버 사이드에서는 가드 실행 안 함 (localStorage 접근 불가)
  if (!import.meta.client) return

  const authStore = useAuthStore()

  // isReady가 false이면 아직 restore() 완료 전.
  // plugin이 await로 restore()를 완료한 뒤 라우팅이 시작되지만,
  // 혹시 타이밍 이슈가 있을 경우를 위해 isReady 확인.
  if (!authStore.isReady) return

  const isAuthed = authStore.isAuthed
  const path = to.path

  // 공개 라우트: 인증 여부와 무관하게 통과
  const publicRoutes = ['/login', '/auth/callback', '/terms', '/privacy']
  const isPublic = publicRoutes.includes(path) || path === '/'

  // /app/* 보호 라우트
  if (path.startsWith('/app')) {
    if (!isAuthed) {
      return navigateTo(`/login?redirect=${encodeURIComponent(to.fullPath)}`, { replace: true })
    }
    return // 인증됨 → 통과
  }

  // 로그인 상태로 / 또는 /login 진입 → /app 리다이렉트 (기획서 Q1 결정)
  if (isAuthed && (path === '/' || path === '/login')) {
    return navigateTo('/app', { replace: true })
  }

  // 나머지 공개 라우트 → 통과
  void isPublic // 사용됨 표시 (lint)
})
