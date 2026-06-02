<script setup lang="ts">
import { fetchWorkerVersion, useWorkerVersion } from '~/composables/useWorkerVersion'

const version = useWorkerVersion()

onMounted(async () => {
  await fetchWorkerVersion()
})

function shortId(id: string | null) {
  if (!id) return '—'
  return id.slice(0, 7)
}

function relativeTime(iso: string | null): string {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.floor(diff / (1000 * 60))
  const hour = Math.floor(diff / (1000 * 60 * 60))
  const day = Math.floor(diff / (1000 * 60 * 60 * 24))
  if (min < 1) return '방금 배포'
  if (min < 60) return `${min}분 전 배포`
  if (hour < 24) return `${hour}시간 전 배포`
  if (day === 1) return '어제 배포'
  if (day < 7) return `${day}일 전 배포`
  return iso.slice(0, 10) + ' 배포'
}
</script>

<template>
  <!-- 사이드바 푸터용 콤팩트 배지 (좁은 폭에서 줄바꿈) -->
  <div class="px-1 flex items-center flex-wrap gap-x-1.5 gap-y-0.5 text-xs text-gray-400 dark:text-slate-500">
    <span class="font-mono">worker {{ shortId(version?.id ?? null) }}</span>
    <span v-if="version?.timestamp" class="text-gray-300 dark:text-slate-600">·</span>
    <span v-if="version?.timestamp">{{ relativeTime(version.timestamp) }}</span>
    <UButton
      icon="i-heroicons-arrow-path"
      size="xs"
      color="neutral"
      variant="ghost"
      :title="'다시 불러오기'"
      aria-label="다시 불러오기"
      @click="fetchWorkerVersion()"
    />
  </div>
</template>
