/**
 * 클라이언트 전용 auth 플러그인.
 * 앱 시작(브라우저 로드·새로고침) 시 localStorage에서 JWT 복원.
 * .client.ts 확장자로 서버 사이드 실행 제외.
 */
export default defineNuxtPlugin(async () => {
  const authStore = useAuthStore()
  await authStore.restore()
})
