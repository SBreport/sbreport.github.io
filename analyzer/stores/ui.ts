import { defineStore } from 'pinia'

/**
 * UI 전역 상태 스토어
 * - 사이드바 열림/접힘 상태 관리
 * - localStorage에 상태 저장 (기획서 4.8)
 */

const SIDEBAR_STORAGE_KEY = 'sb-analyzer:sidebar-open'

export const useUiStore = defineStore('ui', () => {
  // 초기 상태: localStorage에서 복원, 없으면 열림(true)
  const sidebarOpen = ref<boolean>(true)

  /**
   * localStorage에서 사이드바 상태 복원 (클라이언트 사이드에서만)
   */
  function initSidebar() {
    if (import.meta.client) {
      const stored = localStorage.getItem(SIDEBAR_STORAGE_KEY)
      if (stored !== null) {
        sidebarOpen.value = stored === 'true'
      }
    }
  }

  /**
   * 사이드바 토글 (햄버거 버튼 클릭 또는 Ctrl+B)
   */
  function toggleSidebar() {
    sidebarOpen.value = !sidebarOpen.value
    if (import.meta.client) {
      localStorage.setItem(SIDEBAR_STORAGE_KEY, String(sidebarOpen.value))
    }
  }

  /**
   * 사이드바 열기
   */
  function openSidebar() {
    sidebarOpen.value = true
    if (import.meta.client) {
      localStorage.setItem(SIDEBAR_STORAGE_KEY, 'true')
    }
  }

  /**
   * 사이드바 닫기
   */
  function closeSidebar() {
    sidebarOpen.value = false
    if (import.meta.client) {
      localStorage.setItem(SIDEBAR_STORAGE_KEY, 'false')
    }
  }

  return {
    sidebarOpen,
    initSidebar,
    toggleSidebar,
    openSidebar,
    closeSidebar,
  }
})
