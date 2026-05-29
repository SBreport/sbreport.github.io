<script setup lang="ts">
const uiStore = useUiStore()
const authStore = useAuthStore()
const route = useRoute()

// 사이드바 메뉴 정의 (기획서 5.1)
const menuItems = [
  {
    label: '홈',
    to: '/app',
    icon: 'i-heroicons-home',
  },
  {
    label: '키워드 검색',
    to: '/app/search',
    icon: 'i-heroicons-magnifying-glass',
  },
  {
    label: '순위 추적',
    to: '/app/tracking',
    icon: 'i-heroicons-chart-bar',
  },
  {
    label: '플레이스 리뷰 수집',
    to: '/app/reviews',
    icon: 'i-heroicons-chat-bubble-left-right',
  },
] as const

// 구분선 이후 메뉴
// '이용권 안내'는 유료 출시 시점에 노출. 초기엔 메뉴에서 숨김.
// /app/plan 라우트와 페이지 코드는 유지 — 메뉴 한 줄만 다시 추가하면 노출됨.
const bottomMenuItems = [
  {
    label: '설정',
    to: '/app/settings',
    icon: 'i-heroicons-cog-6-tooth',
  },
] as const

// 관리자 전용 메뉴 항목 (authStore.isAdmin이 true일 때만 렌더)
const adminMenuItem = {
  label: '사용자 관리',
  to: '/app/admin',
  icon: 'i-heroicons-users',
} as const

/**
 * 현재 라우트와 메뉴 아이템이 일치하는지 확인
 * /app은 정확히 일치해야 하고, 나머지는 startsWith
 */
function isActive(to: string): boolean {
  if (to === '/app') {
    return route.path === '/app'
  }
  return route.path.startsWith(to)
}
</script>

<template>
  <!--
    AppSidebar: 사이드바
    펼침 w-60(240px, 아이콘+라벨) ↔ 접힘 w-14(56px, 아이콘만)
    transition-[width] 200ms (기획서 4.8)
  -->
  <nav
    class="flex flex-col h-full border-r border-slate-200 bg-white overflow-hidden transition-[width] duration-200"
    :class="uiStore.sidebarOpen ? 'w-60' : 'w-14'"
    :aria-label="'사이드바 내비게이션'"
  >
    <!-- 상단 메뉴 -->
    <ul class="flex flex-col gap-1 p-2 flex-1">
      <!-- 주 메뉴 3개 -->
      <li v-for="item in menuItems" :key="item.to">
        <NuxtLink
          :to="item.to"
          class="flex items-center gap-3 px-2 py-2 rounded-md text-sm transition-colors"
          :class="isActive(item.to)
            ? 'bg-primary-50 text-primary-700 font-medium'
            : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'"
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
        <div class="border-t border-slate-200" />
      </li>

      <!-- 하단 메뉴 (설정, 이용권) -->
      <li v-for="item in bottomMenuItems" :key="item.to">
        <NuxtLink
          :to="item.to"
          class="flex items-center gap-3 px-2 py-2 rounded-md text-sm transition-colors"
          :class="isActive(item.to)
            ? 'bg-primary-50 text-primary-700 font-medium'
            : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'"
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

      <!-- 관리자 전용: 사용자 관리 (isAdmin일 때만 노출, 설정 아래 배치) -->
      <li v-if="authStore.isAdmin">
        <NuxtLink
          :to="adminMenuItem.to"
          class="flex items-center gap-3 px-2 py-2 rounded-md text-sm transition-colors"
          :class="isActive(adminMenuItem.to)
            ? 'bg-primary-50 text-primary-700 font-medium'
            : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'"
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

    <!-- 하단: 유저 정보 (로그인 상태일 때만 표시) -->
    <div v-if="authStore.user" class="shrink-0 border-t border-slate-200 p-2">
      <div class="flex items-center gap-3 px-2 py-2 text-xs text-slate-500">
        <span class="shrink-0 w-5 h-5 flex items-center justify-center">
          <UIcon name="i-heroicons-user-circle" class="w-5 h-5" />
        </span>
        <span
          class="whitespace-nowrap overflow-hidden transition-opacity duration-200 truncate"
          :class="uiStore.sidebarOpen ? 'opacity-100' : 'opacity-0 w-0'"
        >
          {{ authStore.user.email }}
        </span>
      </div>
    </div>
  </nav>
</template>
