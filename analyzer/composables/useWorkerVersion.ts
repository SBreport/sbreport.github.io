import { WORKER_BASE } from './useWorkerBase'

interface WorkerVersion {
  id: string | null
  tag: string | null
  timestamp: string | null
}

export const useWorkerVersion = () => useState<WorkerVersion | null>('worker-version', () => null)

export async function fetchWorkerVersion() {
  const state = useWorkerVersion()
  try {
    const res = await fetch(`${WORKER_BASE}/api/version`)
    if (!res.ok) return
    state.value = await res.json() as WorkerVersion
  } catch {
    state.value = null
  }
}
