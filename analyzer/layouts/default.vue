<script setup lang="ts">
import { useAuthStore } from '~/stores/auth'
const authStore = useAuthStore()
</script>

<template>
  <!--
    default 레이아웃: 사이드바(shrink-0) + 본문(flex-1 min-h-0)
    헤더 제거 — 브랜드·색상모드·유저 전부 AppSidebar로 이동
    height 체인: app.vue(h-screen flex flex-col) → 이 레이아웃(h-full flex flex-row) → 본문(flex-1 min-h-0)
  -->
  <div class="h-full flex flex-row overflow-hidden">
    <AppSidebar class="shrink-0" />
    <div class="flex-1 min-h-0 flex flex-col overflow-hidden">
      <main class="flex-1 min-h-0 overflow-y-auto p-6 bg-white dark:bg-slate-900 text-gray-900 dark:text-slate-100">
        <slot />
      </main>
      <AppDeployBadge v-if="authStore.isAdmin" class="shrink-0" />
    </div>
  </div>
</template>
