<script setup lang="ts">
import { fetchDeployVersions, useDeployVersions } from '~/composables/useWorkerVersion'

const versions = useDeployVersions()

onMounted(async () => {
  await fetchDeployVersions()
})

function shortId(id: string | null | undefined) {
  if (!id) return '—'
  return id.slice(0, 7)
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.floor(diff / 60000)
  const hour = Math.floor(diff / 3600000)
  const day = Math.floor(diff / 86400000)
  if (min < 1) return '방금'
  if (min < 60) return `${min}분 전`
  if (hour < 24) return `${hour}시간 전`
  if (day === 1) return '어제'
  if (day < 7) return `${day}일 전`
  return iso.slice(0, 10)
}
</script>

<template>
  <!-- 사이드바 푸터: front(웹앱) + back(워커) 두 줄 배포 버전 -->
  <div class="px-1 flex flex-col gap-0.5 text-xs text-gray-400 dark:text-slate-500">
    <div class="flex items-center gap-1.5">
      <span class="font-mono">front {{ shortId(versions.front?.id) }}</span>
      <template v-if="versions.front?.timestamp">
        <span class="text-gray-300 dark:text-slate-600">·</span>
        <span>{{ relativeTime(versions.front?.timestamp) }}</span>
      </template>
    </div>
    <div class="flex items-center gap-1.5">
      <span class="font-mono">back {{ shortId(versions.back?.id) }}</span>
      <template v-if="versions.back?.timestamp">
        <span class="text-gray-300 dark:text-slate-600">·</span>
        <span>{{ relativeTime(versions.back?.timestamp) }}</span>
      </template>
      <UButton
        icon="i-heroicons-arrow-path"
        size="xs"
        color="neutral"
        variant="ghost"
        title="다시 불러오기"
        aria-label="다시 불러오기"
        @click="fetchDeployVersions()"
      />
    </div>
  </div>
</template>
