<script setup lang="ts">
// 색상 모드 강제 고정 로직 제거 — 헤더 토글(라이트/다크/시스템)로 제어
</script>

<template>
  <!-- height 체인 시작점: h-screen flex flex-col overflow-hidden (기획서 4.5) -->
  <div class="h-screen flex flex-col overflow-hidden bg-white dark:bg-slate-900">
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </div>
</template>
