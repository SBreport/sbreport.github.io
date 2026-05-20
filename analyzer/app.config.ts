export default defineAppConfig({
  ui: {
    // 브랜드 블루 #1684F2 기반 primary 팔레트 (Nuxt UI v3)
    // main.css @theme static 에서 --color-brand-* 팔레트 정의
    // gray 계열은 slate 사용
    colors: {
      primary: 'brand',
      neutral: 'slate',
    },
    button: {
      // 버튼 기본 크기 sm (기획서 4.7)
      defaultVariants: {
        size: 'sm',
      },
    },
  },
})
