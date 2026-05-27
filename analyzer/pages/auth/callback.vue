<script setup lang="ts">
// OAuth 콜백 페이지: blank 레이아웃 (기획서 5.2, 10.1)
// URL fragment #token=<JWT> 파싱 → authStore.setToken → /app 이동
definePageMeta({
  layout: 'blank',
})

const authStore = useAuthStore()

onMounted(async () => {
  // URL fragment 파싱: #token=<JWT>
  const hash = window.location.hash // '#token=eyJ...'
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash)
  const token = params.get('token')

  if (!token) {
    // token 없음 → 로그인 페이지로
    await navigateTo('/login', { replace: true })
    return
  }

  const ok = await authStore.setToken(token)
  if (ok) {
    // 히스토리에 콜백 URL이 남지 않도록 replace
    await navigateTo('/app', { replace: true })
  }
  else {
    // /api/me 실패 (JWT 불량 or 서버 오류)
    await navigateTo('/login', { replace: true })
  }
})
</script>

<template>
  <div class="h-full flex items-center justify-center">
    <div class="text-center">
      <!-- 로딩 스피너 -->
      <div class="inline-block w-6 h-6 border-2 border-gray-300 border-t-primary-500 rounded-full animate-spin mb-3" />
      <p class="text-sm text-gray-500">로그인 처리 중...</p>
    </div>
  </div>
</template>
