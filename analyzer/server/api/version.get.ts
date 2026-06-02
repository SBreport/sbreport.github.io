/**
 * GET /api/version
 * 빌드 시 nuxt.config.ts에서 주입된 commit hash & buildTime을 반환.
 * AppDeployBadge가 이 엔드포인트를 사용하여 프론트엔드 배포 시점을 표시.
 */
export default defineEventHandler(() => {
  const config = useRuntimeConfig()
  return {
    id: config.buildCommit as string | null,
    tag: null,
    timestamp: config.buildTime as string | null,
  }
})
