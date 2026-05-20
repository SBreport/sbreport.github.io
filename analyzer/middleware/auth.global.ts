/**
 * 전역 인증 미들웨어 — 골격 (기획서 5.4)
 *
 * TODO: 다음 단계 — 실제 인증 로직 구현
 *
 * 현재: 모든 요청을 통과시킴 (골격만 존재)
 *
 * 구현 예정:
 * - /app/* 진입 시 미로그인 → /login?redirect=... 으로 리다이렉트
 * - 로그인 상태로 /login 또는 / 진입 → /app 으로 리다이렉트
 * - authStore에서 JWT 토큰 확인 (localStorage 방식, MVP)
 */
export default defineNuxtRouteMiddleware((_to, _from) => {
  // TODO: authStore 연결 후 아래 로직 활성화
  //
  // const authStore = useAuthStore()
  // const isAuthed = authStore.isAuthenticated
  // const isAppRoute = to.path.startsWith('/app')
  // const isLoginRoute = to.path === '/login' || to.path === '/'
  //
  // if (isAppRoute && !isAuthed) {
  //   return navigateTo(`/login?redirect=${encodeURIComponent(to.fullPath)}`)
  // }
  //
  // if (isLoginRoute && isAuthed) {
  //   return navigateTo('/app')
  // }

  // 현재는 모두 통과 (골격)
})
