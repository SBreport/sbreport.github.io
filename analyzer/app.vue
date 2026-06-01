<script setup lang="ts">
// 색상 모드 라이트 강제: nuxt.config preference만으론 일부 PC의
// localStorage 이전값/시스템 다크 설정을 못 이겨 화면이 반쪽 다크로 깨지는 문제.
// 매 로드 시 preference·value를 light로 덮어써 확실히 고정 (다크 완전지원은 추후).
const colorMode = useColorMode()
colorMode.preference = 'light'
colorMode.value = 'light'
</script>

<template>
  <!-- height 체인 시작점: h-screen flex flex-col overflow-hidden (기획서 4.5) -->
  <div class="h-screen flex flex-col overflow-hidden">
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </div>
</template>
