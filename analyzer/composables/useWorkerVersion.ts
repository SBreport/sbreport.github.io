const WORKER_BASE = 'https://naver-searchad-proxy.sbreport.workers.dev'

interface DeployVersion {
  id: string | null
  tag: string | null
  timestamp: string | null
}

interface DeployVersions {
  front: DeployVersion | null
  back: DeployVersion | null
}

/** front(웹앱) + back(워커) 배포 버전 상태 */
export const useDeployVersions = () =>
  useState<DeployVersions>('deploy-versions', () => ({ front: null, back: null }))

/**
 * front(웹앱 로컬 /api/version, 빌드 시 주입된 git commit) +
 * back(워커 /api/worker-version, Cloudflare 배포 버전) 둘 다 가져옴.
 */
export async function fetchDeployVersions() {
  const state = useDeployVersions()
  const [frontRes, backRes] = await Promise.allSettled([
    fetch('/api/version').then(r => (r.ok ? r.json() : null)),
    fetch(`${WORKER_BASE}/api/worker-version`).then(r => (r.ok ? r.json() : null)),
  ])
  state.value = {
    front: frontRes.status === 'fulfilled' ? (frontRes.value as DeployVersion | null) : null,
    back:  backRes.status === 'fulfilled'  ? (backRes.value  as DeployVersion | null) : null,
  }
}

// ── 후방 호환 (기존 front-only API 유지) ──────────────────────────────────────
export const useWorkerVersion = () => useState<DeployVersion | null>('worker-version', () => null)
export async function fetchWorkerVersion() {
  const state = useWorkerVersion()
  try {
    const res = await fetch('/api/version')
    if (!res.ok) return
    state.value = await res.json() as DeployVersion
  } catch {
    state.value = null
  }
}
