<template>
  <!--
    landing 레이아웃: 헤더만 있는 공개 페이지 (/, /terms, /privacy)
    본문은 자연 흐름 (콘텐츠가 길어지는 공개 페이지)
  -->
  <div class="h-full flex flex-col overflow-hidden">
    <!-- 헤더: 56px 고정 -->
    <header class="shrink-0 h-14 flex items-center px-6 border-b border-gray-200 bg-white">
      <NuxtLink to="/" class="text-base font-semibold text-gray-900">
        SB Analyzer
      </NuxtLink>
    </header>

    <!-- 본문: 자연 흐름 스크롤 -->
    <main class="flex-1 min-h-0 overflow-y-auto">
      <slot />
    </main>
  </div>
</template>
