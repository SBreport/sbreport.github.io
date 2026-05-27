<script setup lang="ts">
import { WORKER_BASE } from '~/composables/useWorkerBase'

// 로그인 페이지: blank 레이아웃 (기획서 5.2, 부록 C.2)
definePageMeta({
  layout: 'blank',
})

function handleGoogleLogin() {
  window.location.href = `${WORKER_BASE}/api/auth/google`
}
</script>

<template>
  <!-- h-screen: blank 레이아웃 + app.vue h-screen 체인에서 h-full로 받음 -->
  <div class="h-full flex items-center justify-center bg-gray-50">
    <div class="w-full max-w-sm p-8 bg-white border border-gray-200 rounded-lg">
      <!-- 타이틀 -->
      <div class="text-center mb-6">
        <h1 class="text-xl font-semibold text-gray-900 mb-1">SB Analyzer</h1>
        <p class="text-sm text-gray-500">네이버 키워드 분석</p>
      </div>

      <!-- 구글 로그인 버튼 -->
      <button
        type="button"
        class="w-full flex items-center justify-center gap-2 h-9 px-4 border border-gray-300 rounded-md text-sm text-gray-700 bg-white hover:bg-gray-50 transition-colors cursor-pointer"
        @click="handleGoogleLogin"
      >
        <!-- Google G 로고 -->
        <svg class="w-4 h-4 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
          <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
          <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
          <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
          <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
        </svg>
        구글로 로그인
      </button>

      <!-- 약관 동의 안내 -->
      <p class="mt-4 text-xs text-center text-gray-400">
        로그인 시
        <NuxtLink to="/terms" class="underline hover:text-gray-600">이용약관</NuxtLink>에
        동의하는 것으로 간주합니다.
      </p>
    </div>
  </div>
</template>
