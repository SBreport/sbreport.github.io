// https://nuxt.com/docs/api/configuration/nuxt-config
import { execSync } from 'node:child_process'

function getBuildCommit(): string {
  try { return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim() }
  catch { return 'unknown' }
}

export default defineNuxtConfig({
  compatibilityDate: '2024-11-01',

  devtools: { enabled: true },

  // 빌드 시 git commit hash & 빌드 시각 주입 → server/api/version.get.ts에서 사용
  runtimeConfig: {
    buildCommit: getBuildCommit(),
    buildTime: new Date().toISOString(),
  },

  modules: [
    '@nuxt/ui',
    '@pinia/nuxt',
  ],

  // Nuxt UI v3 색상 토큰 커스터마이즈는 app.config.ts에서 처리
  // Tailwind v4 커스텀 팔레트는 assets/css/main.css의 @theme static 블록에서 정의
  // (Tailwind v4는 tailwind.config.ts를 사용하지 않음)

  css: ['~/assets/css/main.css'],

  app: {
    head: {
      title: 'SB Analyzer — 네이버 키워드 분석기',
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'description', content: '네이버 키워드 구좌 구성 · 검색량 분석 웹앱' },
      ],
      link: [
        {
          rel: 'stylesheet',
          href: 'https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css',
        },
      ],
    },
  },

  // TypeScript 엄격 모드
  typescript: {
    strict: true,
  },

  // 색상 모드: 라이트/다크/시스템 토글 지원 (헤더 토글 버튼으로 제어).
  // 초기 기본값은 시스템 설정을 따름. 사용자 선택은 localStorage에 저장됨.
  colorMode: {
    preference: 'system',
    fallback: 'light',
  },

  // Cloudflare Workers (Static Assets) 배포용 Nitro preset
  // wrangler deploy 명령과 호환되는 cloudflare_module preset 사용
  nitro: {
    preset: 'cloudflare_module',
    cloudflare: {
      deployConfig: true,  // 빌드 시 .output/wrangler.json 자동 생성
    },
  },
})
