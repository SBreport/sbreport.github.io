interface WorkerVersion {
  id: string | null
  tag: string | null
  timestamp: string | null
}

export const useWorkerVersion = () => useState<WorkerVersion | null>('worker-version', () => null)

/**
 * 프론트엔드 배포 버전 정보를 로컬 /api/version에서 가져옴.
 * (빌드 시 nuxt.config.ts에서 주입된 git commit hash & buildTime 반환)
 */
export async function fetchWorkerVersion() {
  const state = useWorkerVersion()
  try {
    const res = await fetch('/api/version')
    if (!res.ok) return
    state.value = await res.json() as WorkerVersion
  } catch {
    state.value = null
  }
}
