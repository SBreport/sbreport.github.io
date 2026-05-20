<script setup lang="ts">
// 이용권 안내 페이지: default 레이아웃 (기획서 5.2, 6.5, 부록 C.8)
definePageMeta({
  layout: 'default',
})
</script>

<template>
  <div>
    <h1 class="text-base font-semibold text-gray-900 mb-4">이용권 안내</h1>
    <!-- TODO: 다음 단계 — 유료 전환 시 플랜 비교·결제 버튼 추가 (기획서 11.2) -->
    <div class="text-sm text-gray-600">
      <p>현재 플랜: 무료 (Free)</p>
      <p class="mt-2 text-gray-400">유료 플랜은 준비 중입니다.</p>
    </div>
  </div>
</template>
