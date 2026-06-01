<script setup lang="ts">
import { useAuthStore } from '~/stores/auth'

const authStore = useAuthStore()
</script>

<template>
  <!--
    default 레이아웃: 헤더(56px, shrink-0) + 사이드바(240↔56px, shrink-0) + 본문(flex-1 min-h-0 overflow-y-auto)
    height 체인: app.vue(h-screen flex flex-col) → 이 레이아웃(h-full flex flex-col) → 본문(flex-1 min-h-0)
    기획서 4.5, 4.8, 부록 C.1
  -->
  <div class="h-full flex flex-col overflow-hidden">
    <!-- 헤더: 56px 고정, 절대 줄어들지 않음 -->
    <AppHeader class="shrink-0 h-14" />

    <!-- 바디: 헤더 아래 남은 공간 전부 -->
    <div class="flex-1 min-h-0 flex flex-row overflow-hidden">
      <!-- 사이드바: 너비만 변함, 줄어들지 않음 -->
      <AppSidebar class="shrink-0" />

      <!-- 본문 + admin 배지 영역 -->
      <div class="flex-1 min-h-0 flex flex-col overflow-hidden">
        <!-- 본문 영역: 남은 공간 + 스크롤은 여기서만 -->
        <main class="flex-1 min-h-0 overflow-y-auto p-6 bg-white dark:bg-slate-900 text-gray-900 dark:text-slate-100">
          <slot />
        </main>
        <!-- admin 전용 배포 배지 -->
        <AppDeployBadge v-if="authStore.isAdmin" class="shrink-0" />
      </div>
    </div>
  </div>
</template>
