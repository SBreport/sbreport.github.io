<script setup lang="ts">
// 키워드 검색 페이지: default 레이아웃 (기획서 5.2, 6.2, 부록 C.5)
definePageMeta({
  layout: 'default',
})
</script>

<template>
  <div>
    <h1 class="text-base font-semibold text-gray-900 mb-4">키워드 검색</h1>
    <!-- TODO: 다음 단계 — 키워드 검색 구현
         - 입력: 페이지 상단 인라인, 줄바꿈으로 여러 키워드
         - 처리: Worker /api/search 호출 (병렬), 진행 상태 스트리밍
         - 결과: 5컬럼 표 (키워드/검색량/구좌구성/경쟁도/상세)
         - 행 클릭: 우측 슬라이드 패널
         - CSV 내보내기
    -->
    <p class="text-sm text-gray-400">키워드 검색 페이지 — 다음 단계에서 구현 예정</p>
  </div>
</template>
