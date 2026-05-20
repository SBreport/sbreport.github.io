<script setup lang="ts">
// OAuth 콜백 페이지: blank 레이아웃 (기획서 5.2)
// TODO: 다음 단계 — Google OAuth 콜백 처리 (code → JWT 교환 → authStore 저장 → /app 리다이렉트)
definePageMeta({
  layout: 'blank',
})
</script>

<template>
  <div class="h-full flex items-center justify-center">
    <div class="text-center">
      <p class="text-sm text-gray-500">로그인 처리 중...</p>
      <!-- TODO: 다음 단계 — 실제 콜백 처리 로직 -->
    </div>
  </div>
</template>
