<script setup lang="ts">
const uiStore = useUiStore()
const authStore = useAuthStore()
const route = useRoute()
const colorMode = useColorMode()

// ─── 네비 메뉴 ───────────────────────────────────────────────────
const menuItems = [
  { label: '홈',                 to: '/app',          icon: 'i-heroicons-home' },
  { label: '키워드 검색',        to: '/app/search',   icon: 'i-heroicons-magnifying-glass' },
  { label: '순위 추적',          to: '/app/tracking', icon: 'i-heroicons-chart-bar' },
  { label: '플레이스 리뷰 수집', to: '/app/reviews',  icon: 'i-heroicons-chat-bubble-left-right' },
] as const

const bottomMenuItems = [
  { label: '설정', to: '/app/settings', icon: 'i-heroicons-cog-6-tooth' },
] as const

const adminMenuItem = {
  label: '사용자 관리',
  to: '/app/admin',
  icon: 'i-heroicons-users',
} as const

function isActive(to: string): boolean {
  if (to === '/app') return route.path === '/app'
  return route.path.startsWith(to)
}

// ─── 색상 모드 (AppHeader에서 이동) ─────────────────────────────
const colorModeOptions = [
  { value: 'light',  label: '라이트', icon: 'i-heroicons-sun' },
  { value: 'dark',   label: '다크',   icon: 'i-heroicons-moon' },
  { value: 'system', label: '시스템', icon: 'i-heroicons-computer-desktop' },
] as const

type ColorModePreference = 'light' | 'dark' | 'system'

function setColorMode(val: ColorModePreference) {
  colorMode.preference = val
}

function cycleColorMode() {
  const idx = colorModeOptions.findIndex(o => o.value === colorMode.preference)
  colorMode.preference = colorModeOptions[(idx + 1) % colorModeOptions.length].value as ColorModePreference
}

const currentModeIcon = computed(() => {
  return colorModeOptions.find(o => o.value === colorMode.preference)?.icon ?? 'i-heroicons-computer-desktop'
})

// ─── 유저 (AppHeader에서 이동) ───────────────────────────────────
const avatarError = ref(false)
watch(() => authStore.user?.picture, () => { avatarError.value = false })

const userInitial = computed(() => {
  const name = authStore.user?.name || authStore.user?.email || '?'
  return name.charAt(0).toUpperCase()
})

const isAdmin = computed(() => authStore.isAdmin)
const isPending = computed(() => authStore.user?.status === 'pending')

function handleLogout() {
  authStore.logout()
}

// ─── Ctrl+B 사이드바 토글 (AppHeader에서 이동) ──────────────────
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
    AppSidebar: 사이드바 전체 (헤더 포함)
    펼침 w-60(240px) ↔ 접힘 w-14(56px)
    ① 헤더: 햄버거 + 브랜드명
    ② 메뉴: flex-1 overflow-y-auto
    ③ 푸터: 색상모드 + 유저카드 + 로그아웃
  -->
  <nav
    class="flex flex-col h-full border-r border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 overflow-hidden transition-[width] duration-200"
    :class="uiStore.sidebarOpen ? 'w-60' : 'w-14'"
    :aria-label="'사이드바 내비게이션'"
  >
    <!-- ① 헤더: 햄버거 + 브랜드명 (h-14 고정 — 콘텐츠 상단과 높이 일치) -->
    <div class="shrink-0 h-14 flex items-center gap-2 px-2 border-b border-gray-200 dark:border-slate-700">
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
      <span
        class="text-sm font-semibold text-gray-900 dark:text-slate-100 whitespace-nowrap overflow-hidden transition-opacity duration-200"
        :class="uiStore.sidebarOpen ? 'opacity-100' : 'opacity-0 w-0'"
      >
        SB Analyzer
      </span>
    </div>

    <!-- ② 메뉴 영역 -->
    <ul class="flex flex-col gap-1 p-2 flex-1 overflow-y-auto">
      <!-- 주 메뉴 -->
      <li v-for="item in menuItems" :key="item.to">
        <NuxtLink
          :to="item.to"
          class="flex items-center gap-3 px-2 py-2 rounded-md text-sm transition-colors"
          :class="isActive(item.to)
            ? 'bg-primary-50 dark:bg-primary-900/30 text-primary-700 dark:text-primary-400 font-medium'
            : 'text-slate-600 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-700 hover:text-gray-900 dark:hover:text-slate-100'"
        >
          <span class="shrink-0 w-5 h-5 flex items-center justify-center">
            <UIcon :name="item.icon" class="w-5 h-5" />
          </span>
          <span
            class="whitespace-nowrap overflow-hidden transition-opacity duration-200"
            :class="uiStore.sidebarOpen ? 'opacity-100' : 'opacity-0 w-0'"
          >
            {{ item.label }}
          </span>
        </NuxtLink>
      </li>

      <!-- 구분선 -->
      <li class="my-1">
        <div class="border-t border-gray-200 dark:border-slate-700" />
      </li>

      <!-- 하단 메뉴 (설정) -->
      <li v-for="item in bottomMenuItems" :key="item.to">
        <NuxtLink
          :to="item.to"
          class="flex items-center gap-3 px-2 py-2 rounded-md text-sm transition-colors"
          :class="isActive(item.to)
            ? 'bg-primary-50 dark:bg-primary-900/30 text-primary-700 dark:text-primary-400 font-medium'
            : 'text-slate-600 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-700 hover:text-gray-900 dark:hover:text-slate-100'"
        >
          <span class="shrink-0 w-5 h-5 flex items-center justify-center">
            <UIcon :name="item.icon" class="w-5 h-5" />
          </span>
          <span
            class="whitespace-nowrap overflow-hidden transition-opacity duration-200"
            :class="uiStore.sidebarOpen ? 'opacity-100' : 'opacity-0 w-0'"
          >
            {{ item.label }}
          </span>
        </NuxtLink>
      </li>

      <!-- 관리자 전용: 사용자 관리 -->
      <li v-if="authStore.isAdmin">
        <NuxtLink
          :to="adminMenuItem.to"
          class="flex items-center gap-3 px-2 py-2 rounded-md text-sm transition-colors"
          :class="isActive(adminMenuItem.to)
            ? 'bg-primary-50 dark:bg-primary-900/30 text-primary-700 dark:text-primary-400 font-medium'
            : 'text-slate-600 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-700 hover:text-gray-900 dark:hover:text-slate-100'"
        >
          <span class="shrink-0 w-5 h-5 flex items-center justify-center">
            <UIcon :name="adminMenuItem.icon" class="w-5 h-5" />
          </span>
          <span
            class="whitespace-nowrap overflow-hidden transition-opacity duration-200"
            :class="uiStore.sidebarOpen ? 'opacity-100' : 'opacity-0 w-0'"
          >
            {{ adminMenuItem.label }}
          </span>
        </NuxtLink>
      </li>
    </ul>

    <!-- ③ 푸터: 배포배지 + 색상모드 + 유저카드 -->
    <div class="shrink-0 border-t border-gray-200 dark:border-slate-700 p-2 flex flex-col gap-1">

      <!-- 배포 배지 (admin 전용, 펼침 시에만) -->
      <AppDeployBadge v-if="authStore.isAdmin && uiStore.sidebarOpen" />

      <!-- 색상모드 토글 -->
      <ClientOnly>
        <!-- 펼침: 3-버튼 그룹 -->
        <div
          v-if="uiStore.sidebarOpen"
          class="flex items-center gap-0.5 border border-gray-200 dark:border-slate-700 rounded-md p-0.5"
        >
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
        <!-- 접힘: 아이콘 하나 (클릭 → 순환) -->
        <button
          v-else
          type="button"
          title="색상모드 전환"
          aria-label="색상모드 전환"
          class="w-10 h-8 flex items-center justify-center rounded-md text-slate-400 dark:text-slate-500 hover:text-gray-700 dark:hover:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700 transition-colors mx-auto"
          @click="cycleColorMode"
        >
          <UIcon :name="currentModeIcon" class="w-4 h-4" />
        </button>
        <!-- SSR fallback -->
        <template #fallback>
          <div class="w-8 h-8 flex items-center justify-center text-slate-400 mx-auto">
            <UIcon name="i-heroicons-computer-desktop" class="w-4 h-4" />
          </div>
        </template>
      </ClientOnly>

      <!-- 유저 섹션 (로그인 상태일 때만) -->
      <div v-if="authStore.user">

        <!-- 펼침: 아바타 + 이메일 + 배지 -->
        <div v-if="uiStore.sidebarOpen" class="flex items-center gap-2 px-2 py-1.5 mt-0.5">
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
          <div class="flex-1 min-w-0">
            <p class="text-xs text-slate-600 dark:text-slate-400 truncate">{{ authStore.user.email }}</p>
            <span
              v-if="isAdmin"
              class="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-primary-100 text-primary-700 leading-none"
            >Admin</span>
            <span
              v-else-if="isPending"
              class="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-700 leading-none"
            >대기</span>
          </div>
        </div>

        <!-- 접힘: 아바타만 (중앙 정렬) -->
        <div v-else class="flex items-center justify-center py-1 mt-0.5">
          <div class="w-7 h-7 rounded-full overflow-hidden bg-slate-200 dark:bg-slate-700 flex items-center justify-center">
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
        </div>

        <!-- 로그아웃 버튼 (펼침 시 텍스트 포함, 접힘 시 아이콘만) -->
        <button
          type="button"
          class="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-slate-500 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-700 hover:text-gray-900 dark:hover:text-slate-100 transition-colors"
          :class="uiStore.sidebarOpen ? '' : 'justify-center'"
          :title="uiStore.sidebarOpen ? undefined : '로그아웃'"
          @click="handleLogout"
        >
          <UIcon name="i-heroicons-arrow-right-on-rectangle" class="w-4 h-4 shrink-0" />
          <span
            class="text-xs whitespace-nowrap overflow-hidden transition-opacity duration-200"
            :class="uiStore.sidebarOpen ? 'opacity-100' : 'opacity-0 w-0'"
          >로그아웃</span>
        </button>
      </div>
    </div>
  </nav>
</template>
