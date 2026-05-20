<script setup lang="ts">
// 404 페이지: blank 레이아웃 (기획서 5.2)
definePageMeta({
  layout: 'blank',
})
</script>

<template>
  <div class="h-full flex items-center justify-center">
    <div class="text-center">
      <p class="text-4xl font-bold text-gray-200 mb-2">404</p>
      <p class="text-sm text-gray-500 mb-4">페이지를 찾을 수 없습니다.</p>
      <NuxtLink to="/" class="text-sm text-blue-600 hover:underline">
        홈으로 돌아가기
      </NuxtLink>
    </div>
  </div>
</template>
