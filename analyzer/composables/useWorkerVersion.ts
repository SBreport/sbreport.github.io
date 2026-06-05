import { WORKER_BASE } from '~/composables/useWorkerBase'

interface VersionInfo {
  id: string | null
  tag: string | null
  timestamp: string | null
}

interface DeployVersions {
  front: VersionInfo | null
  back: VersionInfo | null
}

export const useDeployVersions = () =>
  useState<DeployVersions>('deploy-versions', () => ({ front: null, back: null }))

/**
 * @deprecated useDeployVersions() を使用してください
 * 後方互換用エイリアス — 既存コードが参照する場合に備えて残す
 */
export const useWorkerVersion = () => {
  const state = useDeployVersions()
  return computed(() => state.value.front)
}

/**
 * 프런트(로컬 /api/version)와 백엔드(Worker /api/worker-version)를 동시에 fetch.
 */
export async function fetchWorkerVersion() {
  const state = useDeployVersions()

  const [frontRes, backRes] = await Promise.allSettled([
    fetch('/api/version'),
    fetch(`${WORKER_BASE}/api/worker-version`),
  ])

  state.value = {
    front: frontRes.status === 'fulfilled' && frontRes.value.ok
      ? (await frontRes.value.json() as VersionInfo)
      : null,
    back: backRes.status === 'fulfilled' && backRes.value.ok
      ? (await backRes.value.json() as VersionInfo)
      : null,
  }
}
