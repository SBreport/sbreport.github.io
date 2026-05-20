<script setup lang="ts">
// 랜딩 페이지: landing 레이아웃 (기획서 5.2)
definePageMeta({
  layout: 'landing',
})
</script>

<template>
  <div class="flex flex-col items-start justify-center min-h-64 p-6">
    <h1 class="text-2xl font-semibold text-gray-900 mb-2">SB Analyzer</h1>
    <p class="text-sm text-gray-500 mb-6">네이버 키워드 구좌 구성 · 검색량 분석</p>
    <NuxtLink to="/login" class="text-sm text-blue-600 hover:underline">
      로그인하기
    </NuxtLink>
  </div>
</template>
