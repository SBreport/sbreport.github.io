// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2024-11-01',

  devtools: { enabled: true },

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

  // 색상 모드: MVP는 라이트 고정 (시스템 다크 따라가지 않음).
  // Nuxt UI 컴포넌트만 다크 변형을 갖고 직접 짠 컴포넌트는 라이트 고정이라
  // 화면이 어정쩡하게 섞이는 문제 회피. 다크 완전 지원은 추후 별도 작업.
  colorMode: {
    preference: 'light',
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
