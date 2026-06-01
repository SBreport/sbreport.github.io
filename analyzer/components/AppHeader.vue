<script setup lang="ts">
/**
 * 공통 헤더 (기획서 4.4, 부록 C.1)
 * - 좌측: 햄버거 + 로고
 * - 우측: 색상모드 토글 + 로그인 상태면 아바타+이메일+드롭다운, 아니면 로그인 링크
 * 높이 56px (h-14) — layout에서 shrink-0으로 고정
 */

const uiStore = useUiStore()
const authStore = useAuthStore()
const colorMode = useColorMode()

// 색상모드 토글: 라이트 → 다크 → 시스템 순환
const colorModeOptions = [
  { value: 'light', label: '라이트', icon: 'i-heroicons-sun' },
  { value: 'dark',  label: '다크',   icon: 'i-heroicons-moon' },
  { value: 'system', label: '시스템', icon: 'i-heroicons-computer-desktop' },
] as const

type ColorModePreference = 'light' | 'dark' | 'system'

function setColorMode(val: ColorModePreference) {
  colorMode.preference = val
}

const currentModeIcon = computed(() => {
  const found = colorModeOptions.find(o => o.value === colorMode.preference)
  return found?.icon ?? 'i-heroicons-computer-desktop'
})

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

// 드롭다운 열림 상태
const dropdownOpen = ref(false)

function handleLogout() {
  dropdownOpen.value = false
  authStore.logout()
}

// 이미지 로드 실패 시 이니셜 폴백
const avatarError = ref(false)
watch(() => authStore.user?.picture, () => {
  avatarError.value = false
})

const userInitial = computed(() => {
  const name = authStore.user?.name || authStore.user?.email || '?'
  return name.charAt(0).toUpperCase()
})

const isAdmin = computed(() => authStore.isAdmin)
const isPending = computed(() => authStore.user?.status === 'pending')
</script>

<template>
  <header class="h-14 flex items-center px-3 border-b border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 gap-2">
    <!-- 햄버거 버튼 -->
    <button
      type="button"
      class="flex items-center justify-center w-8 h-8 rounded-md text-slate-500 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-700 transition-colors shrink-0"
      :aria-label="uiStore.sidebarOpen ? '사이드바 닫기' : '사이드바 열기'"
      @click="uiStore.toggleSidebar()"
    >
      <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
      </svg>
    </button>

    <!-- 로고 -->
    <NuxtLink to="/app" class="text-sm font-semibold text-gray-900 dark:text-slate-100 hover:text-slate-700 dark:hover:text-slate-300">
      SB Analyzer
    </NuxtLink>

    <!-- 우측 여백 밀기 -->
    <div class="flex-1 min-w-0" />

    <!-- 색상모드 토글 (SSR 깜빡임 방지: ClientOnly) -->
    <ClientOnly>
      <div class="shrink-0 flex items-center gap-0.5 border border-gray-200 dark:border-slate-700 rounded-md p-0.5">
        <button
          v-for="opt in colorModeOptions"
          :key="opt.value"
          type="button"
          :title="opt.label"
          :aria-label="`${opt.label} 모드`"
          class="flex items-center justify-center w-7 h-7 rounded transition-colors"
          :class="colorMode.preference === opt.value
            ? 'bg-gray-100 dark:bg-slate-700 text-gray-900 dark:text-slate-100'
            : 'text-slate-400 dark:text-slate-500 hover:text-gray-700 dark:hover:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700/50'"
          @click="setColorMode(opt.value)"
        >
          <UIcon :name="opt.icon" class="w-4 h-4" />
        </button>
      </div>
      <!-- SSR fallback: 아이콘 하나만 표시 -->
      <template #fallback>
        <div class="shrink-0 w-8 h-8 flex items-center justify-center text-slate-400">
          <UIcon name="i-heroicons-computer-desktop" class="w-4 h-4" />
        </div>
      </template>
    </ClientOnly>

    <!-- 인증 영역 -->
    <div class="shrink-0">
      <!-- 로그인 상태 -->
      <div v-if="authStore.user" class="relative">
        <button
          type="button"
          class="flex items-center gap-2 px-2 py-1 rounded hover:bg-gray-50 dark:hover:bg-slate-700 transition-colors"
          @click="dropdownOpen = !dropdownOpen"
        >
          <!-- 아바타 -->
          <div class="w-7 h-7 rounded-full overflow-hidden bg-slate-200 dark:bg-slate-700 flex items-center justify-center shrink-0">
            <img
              v-if="authStore.user.picture && !avatarError"
              :src="authStore.user.picture"
              :alt="authStore.user.name"
              class="w-full h-full object-cover"
              referrerpolicy="no-referrer"
              @error="avatarError = true"
            >
            <span v-else class="text-xs font-medium text-slate-600 dark:text-slate-300">{{ userInitial }}</span>
          </div>
          <!-- 이메일 -->
          <span class="text-xs text-slate-600 dark:text-slate-400 max-w-36 truncate">{{ authStore.user.email }}</span>
          <!-- 관리자 배지 -->
          <span
            v-if="isAdmin"
            class="shrink-0 inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-primary-100 text-primary-700 leading-none"
          >
            Admin
          </span>
          <!-- 승인 대기 배지 -->
          <span
            v-else-if="isPending"
            class="shrink-0 inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-700 leading-none"
          >
            대기
          </span>
          <!-- 화살표 -->
          <svg
            class="w-3 h-3 text-slate-400 dark:text-slate-500 transition-transform"
            :class="dropdownOpen ? 'rotate-180' : ''"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        <!-- 드롭다운 -->
        <Transition name="fade">
          <div
            v-if="dropdownOpen"
            class="absolute right-0 top-full mt-1 w-44 bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-md py-1 z-50"
          >
            <div class="px-3 py-2 border-b border-gray-200 dark:border-slate-700">
              <p class="text-xs font-medium text-gray-900 dark:text-slate-100 truncate">{{ authStore.user.name }}</p>
              <p class="text-xs text-slate-400 dark:text-slate-500 truncate">{{ authStore.user.email }}</p>
            </div>
            <button
              type="button"
              class="w-full text-left px-3 py-2 text-xs text-slate-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700 transition-colors"
              @click="handleLogout"
            >
              로그아웃
            </button>
          </div>
        </Transition>

        <!-- 드롭다운 외부 클릭 닫기 (z-40으로 드롭다운 뒤에) -->
        <div
          v-if="dropdownOpen"
          class="fixed inset-0 z-40"
          aria-hidden="true"
          @click="dropdownOpen = false"
        />
      </div>

      <!-- 비로그인 상태 -->
      <NuxtLink
        v-else
        to="/login"
        class="text-xs text-primary-600 hover:text-primary-700 px-2 py-1"
      >
        로그인
      </NuxtLink>
    </div>
  </header>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.1s, transform 0.1s;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
