# 스마트브랜딩 신규 직원 온보딩 웹페이지

## 실행 방법

### 가장 간단한 방법 — 더블클릭
`index.html` 파일을 더블클릭하면 브라우저에서 바로 열립니다.
별도 서버 설치 없이 `file://` 프로토콜로 완전히 동작합니다.

### 로컬 서버로 실행 (선택)
더블클릭과 동작 차이는 없으나, 개발 편의를 위해 아래 중 하나를 사용할 수 있습니다.
```
# Python 3
python -m http.server 8080

# Node.js (npx)
npx serve .
```
실행 후 브라우저에서 `http://localhost:8080` 접속.

---

## 파일 구조

```
onboarding_web/
├── index.html              — 빌드 결과물 (generated, 직접 수정 금지)
├── index.html.bak          — 원본 백업
├── css/
│   └── styles.css          — 블루 팔레트, 16:9 비율, 표 스타일, 좌석 배치 grid
├── js/
│   └── app.js              — 탭 전환 로직, 섹션 렌더링
├── src/
│   └── shell.html          — 쉘 뼈대 (head, 사이드바, 메인 영역, 네비게이션 바)
├── sections/
│   ├── 01_welcome.html     — tpl-welcome-1
│   ├── 02_industry.html    — tpl-industry-1, tpl-industry-2, tpl-industry-3
│   ├── 03_company.html     — tpl-company-1, tpl-company-2, tpl-company-3
│   ├── 04_organization.html— tpl-org-1, tpl-org-2
│   ├── 05_culture.html     — tpl-culture-1, tpl-culture-2
│   ├── 06_meetings.html    — tpl-meetings-1, tpl-meetings-2
│   └── 07_operations.html  — tpl-ops-1 ~ tpl-ops-5
├── build.bat               — Windows용 빌드 스크립트
├── build.sh                — macOS/Linux용 빌드 스크립트
└── README.md
```

---

## 편집 워크플로우

콘텐츠를 수정할 때는 `index.html`을 직접 편집하지 않습니다.
해당 섹션 파일을 수정한 뒤 빌드 스크립트로 `index.html`을 재생성합니다.

1. `sections/XX_*.html` 중 수정할 파일 열기
2. `<template>` 블록 내부 편집 후 저장
3. `build.bat` 더블클릭 (Windows) 또는 터미널에서 `bash build.sh` 실행
4. `index.html` 더블클릭으로 결과 확인

---

## 빌드 스크립트 실행 방법

### Windows
터미널(CMD 또는 PowerShell)에서 프로젝트 폴더로 이동 후:
```
build.bat
```
또는 탐색기에서 `build.bat` 파일을 더블클릭합니다.

### macOS / Linux
터미널에서 프로젝트 폴더로 이동 후:
```bash
bash build.sh
```
처음 한 번만 실행 권한 부여가 필요한 경우:
```bash
chmod +x build.sh
./build.sh
```

### 빌드 동작 방식
- `src/shell.html`을 읽어 기본 HTML 골격으로 사용합니다.
- `sections/` 폴더의 `*.html` 파일을 **파일명 이름 순(01_, 02_, ...)으로** 모두 읽어 연결합니다.
- `shell.html` 안의 `<!-- {{SECTIONS}} -->` 마커를 연결된 섹션 내용으로 치환합니다.
- 결과를 `index.html`에 UTF-8로 저장합니다.

---

## 공통 스타일 / JS 수정

`css/styles.css`와 `js/app.js`는 빌드와 무관하게 수정 즉시 반영됩니다.
`index.html`이 이 파일들을 링크로 로드하므로 빌드 없이 저장 후 브라우저 새로고침만 하면 됩니다.

---

## 섹션별 Template ID 목록

| 파일 | Template ID |
|---|---|
| 01_welcome.html | `tpl-welcome-1` |
| 02_industry.html | `tpl-industry-1`, `tpl-industry-2`, `tpl-industry-3` |
| 03_company.html | `tpl-company-1`, `tpl-company-2`, `tpl-company-3` |
| 04_organization.html | `tpl-org-1`, `tpl-org-2` |
| 05_culture.html | `tpl-culture-1`, `tpl-culture-2` |
| 06_meetings.html | `tpl-meetings-1`, `tpl-meetings-2` |
| 07_operations.html | `tpl-ops-1`, `tpl-ops-2`, `tpl-ops-3`, `tpl-ops-4`, `tpl-ops-5` |

---

## 디자인 커스터마이징

- 컬러 팔레트: `css/styles.css` 상단의 색상값 (`#4A9EFF`, `#0A3D91`, `#051E4F`) 변경
- 좌석 배치도: `sections/04_organization.html` → `tpl-org-2` 블록 수정
- 탭 추가: `src/shell.html`에 `<button class="tab-btn" data-tab="newtab">` 추가 + 새 섹션 파일 생성 + `js/app.js`의 `TABS` 배열에 항목 추가 + 빌드 실행

---

## 섹션 로드 방식 선택 이유

**채택 방식: `<template>` 태그 인라인 방식 (빌드 시 병합)**

`fetch()`를 사용해 `sections/*.html` 파일을 동적으로 불러오는 방식은
`file://` 프로토콜에서 CORS 정책으로 인해 동작하지 않습니다.

대신 빌드 스크립트가 모든 섹션을 `index.html` 내 `<template>` 태그로 병합하고,
JS에서 `cloneNode()`로 꺼내 렌더링하는 방식을 채택했습니다.

이 방식의 장점:
- 더블클릭 실행으로 즉시 동작 (서버 불필요)
- 편집은 섹션별 파일에서 분리하여 진행 가능
- `<template>` 내 콘텐츠는 초기 렌더링에 영향을 주지 않으므로 성능 문제 없음
