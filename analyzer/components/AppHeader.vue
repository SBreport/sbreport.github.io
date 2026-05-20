<script setup lang="ts">
import { useUiStore } from '~/stores/ui'

const uiStore = useUiStore()

// Ctrl+B 단축키: 사이드바 토글 (기획서 4.8)
onMounted(() => {
  const handler = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
      e.preventDefault()
      uiStore.toggleSidebar()
    }
  }
  window.addEventListener('keydown', handler)
  onUnmounted(() => window.removeEventListener('keydown', handler))
})
</script>

<template>
  <!--
    AppHeader: 헤더 56px, shrink-0
    좌: 햄버거(사이드바 토글) + 로고
    우: 유저 아바타 자리 (다음 단계에서 실제 구현)
    기획서 부록 C.1
  -->
  <header class="flex items-center gap-3 px-4 border-b border-slate-200 bg-white">
    <!-- 햄버거 버튼: 사이드바 여닫이 -->
    <button
      type="button"
      class="flex items-center justify-center w-8 h-8 rounded-md text-slate-500 hover:bg-slate-100 transition-colors"
      :aria-label="uiStore.sidebarOpen ? '사이드바 닫기' : '사이드바 열기'"
      @click="uiStore.toggleSidebar()"
    >
      <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
      </svg>
    </button>

    <!-- 로고 -->
    <NuxtLink to="/app" class="text-sm font-semibold text-slate-900 hover:text-slate-700">
      SB Analyzer
    </NuxtLink>

    <!-- 우측 영역: 유저 정보 자리 (다음 단계 구현) -->
    <div class="ml-auto flex items-center gap-2">
      <!-- TODO: 다음 단계 — 로그인 사용자 이메일 + 아바타 드롭다운 -->
      <span class="text-xs text-slate-400">user@… [아바타]</span>
    </div>
  </header>
</template>
