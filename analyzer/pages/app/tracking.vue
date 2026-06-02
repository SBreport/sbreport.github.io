<script setup lang="ts">
// 순위 추적 페이지: default 레이아웃 (기획서 5.2, 6.3, 부록 C.6)
// 현재 이번 세션 보류 — 라우트 자리만 확보
definePageMeta({
  layout: 'default',
})
</script>

<template>
  <div>
    <h1 class="text-base font-semibold text-gray-900 dark:text-slate-100 mb-4">순위 추적</h1>
    <!-- TODO: 다음 단계 — 순위 추적 기능 이관 후 구현
         기존 로직: uni-portal/checker/place_rank.py 참조
    -->
    <p class="text-sm text-gray-400 dark:text-slate-500">순위 추적 페이지 — 다음 단계에서 구현 예정</p>
  </div>
</template>
