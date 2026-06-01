<script setup lang="ts">
// 승인 대기 화면 (기획서 10.3, 부록 C.3)
// blank 레이아웃: 사이드바·헤더 없음
definePageMeta({
  layout: 'blank',
})

const authStore = useAuthStore()

const KAKAO_CHANNEL_URL = 'http://pf.kakao.com/_mCQGG/chat'

// 승인 완료 후 홈으로 재진입.
// window.location.href를 사용해 앱 상태(auth)를 처음부터 다시 로드.
function goHome() {
  window.location.href = '/'
}

const statusLabel = computed(() => {
  if (authStore.user?.status === 'suspended') return '계정 정지됨'
  return '승인 대기 중'
})

const statusDesc = computed(() => {
  if (authStore.user?.status === 'suspended') {
    return '계정이 정지되었습니다. 문의 채널로 연락해 주세요.'
  }
  return '계정이 운영자 검토 중입니다. 승인 완료 후 이용 가능합니다.'
})
</script>

<template>
  <!--
    blank 레이아웃 안에서 뷰포트 전체를 채우는 중앙 정렬 컨테이너.
    blank 레이아웃이 h-full overflow-y-auto이므로, 여기서 min-h-full로 높이 확보.
  -->
  <div class="min-h-full flex items-center justify-center bg-gray-50 px-4 py-12">
    <div class="w-full max-w-md border border-gray-200 rounded-lg bg-white p-8 flex flex-col items-center gap-5">

      <!-- 아이콘 -->
      <div class="w-14 h-14 rounded-full bg-amber-50 flex items-center justify-center shrink-0">
        <svg
          class="w-7 h-7 text-amber-500"
          fill="none"
          stroke="currentColor"
          stroke-width="1.75"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M12 6v6l4 2m6-2a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z"
          />
        </svg>
      </div>

      <!-- 타이틀 -->
      <div class="text-center flex flex-col gap-1.5">
        <h1 class="text-base font-semibold text-gray-900">
          {{ statusLabel }}
        </h1>
        <p class="text-sm text-gray-500 leading-relaxed">
          {{ statusDesc }}
        </p>
      </div>

      <!-- 버튼 그룹: 홈으로 가기 + 카카오톡 문의 -->
      <div class="flex flex-col items-center gap-2 w-full">
        <!-- 홈으로 가기: 승인 완료 후 앱 재진입용 (리로드로 auth 갱신) -->
        <button
          type="button"
          class="inline-flex items-center gap-2 px-4 h-9 rounded-md text-sm font-medium bg-brand-500 hover:bg-brand-600 text-white transition-colors w-full justify-center"
          @click="goHome"
        >
          <!-- 홈 아이콘 -->
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0h6" />
          </svg>
          홈으로 가기
        </button>

        <!-- 카카오톡 문의 버튼 -->
        <a
          :href="KAKAO_CHANNEL_URL"
          target="_blank"
          rel="noopener noreferrer"
          class="inline-flex items-center gap-2 px-4 h-9 rounded-md text-sm font-medium bg-amber-400 hover:bg-amber-500 text-gray-900 transition-colors w-full justify-center"
        >
          <!-- 카카오톡 말풍선 아이콘 -->
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 3C6.477 3 2 6.918 2 11.75c0 3.072 1.733 5.775 4.346 7.385L5.25 22l3.77-1.966C9.9 20.313 10.937 20.5 12 20.5c5.523 0 10-3.918 10-8.75S17.523 3 12 3Z" />
          </svg>
          카카오톡 채널 문의
        </a>
      </div>

      <!-- 구분선 -->
      <div class="w-full border-t border-gray-100" />

      <!-- 로그아웃 -->
      <button
        type="button"
        class="text-xs text-gray-400 hover:text-gray-600 transition-colors"
        @click="authStore.logout()"
      >
        다른 계정으로 로그인
      </button>
    </div>
  </div>
</template>
