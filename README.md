# 스마트브랜딩 페이지 모음 — 유지보수 가이드

이 문서는 `sbreport.github.io` 리포지토리를 처음 맡은 사람도 새 페이지를 추가하고 운영할 수 있도록 작성된 실무 가이드입니다.

---

## 목차

1. [빠른 시작](#1-빠른-시작)
2. [저장소 구조](#2-저장소-구조)
3. [카테고리 시스템](#3-카테고리-시스템)
4. [새 페이지 추가하기](#4-새-페이지-추가하기)
5. [카테고리 추가·변경하기](#5-카테고리-추가변경하기)
6. [기존 페이지 수정하기](#6-기존-페이지-수정하기)
7. [보안 / 마스킹 정책](#7-보안--마스킹-정책)
8. [로컬 테스트 & 배포](#8-로컬-테스트--배포)
9. [자주 묻는 질문 (FAQ)](#9-자주-묻는-질문-faq)
10. [디자인 원칙 참고](#10-디자인-원칙-참고)
11. [향후 작업 메모 (TBD)](#11-향후-작업-메모-tbd)

---

## 1. 빠른 시작

**이 리포지토리는** 스마트브랜딩에서 만든 마케팅 실무 자료·도구를 한 곳에 모아 공개하는 정적 웹사이트입니다. 별도 서버나 백엔드 없이 GitHub Pages로 자동 배포됩니다.

- **배포 URL:** https://sbreport.github.io/
- **관리 방식:** `main` 브랜치에 push하면 1~2분 안에 사이트에 자동 반영됩니다.

### 담당자 (TBD)

| 역할 | 담당 | 비고 |
|------|------|------|
| 전체 관리 | _(미정)_ | 리포 권한 보유자 |
| 콘텐츠 추가 | _(미정)_ | 이 가이드 참고 |
| GitHub Pages 설정 | _(미정)_ | Settings → Pages |

### 로컬에서 미리보기

파일을 열어 확인할 때 `file://` 경로로 직접 열면 마크다운 렌더링이 깨집니다. 반드시 로컬 서버를 사용하세요.

```powershell
cd "C:\path\to\sbreport.github.io"
python -m http.server 8000
```

브라우저에서 `http://localhost:8000` 접속 → 수정한 내용이 페이지에 반영되는지 확인.

---

## 2. 저장소 구조

```
sbreport.github.io/
│
├── index.html          ← 허브 페이지 (카드 목록 + 검색·정렬)
├── style.css           ← 허브 전용 스타일 (카테고리 색상 시스템 포함)
├── .gitignore          ← 원본 백업 폴더 push 차단
│
├── docu/               ← 장기 문서·강의 자료
│   └── naverlogic2605/ ← 네이버 AI 검색 대응 강의 메모
│       ├── index.html  ← 챕터 선택 허브
│       ├── lecture.md / lecture-easy.md / playbook.md ← 본문 마크다운
│       ├── viewer.js   ← 마크다운 → HTML 렌더러
│       ├── style.css
│       └── playbook/   ← 세부 챕터 (각각 index.html)
│           ├── index.html
│           ├── principle/index.html
│           └── pro/index.html
│
├── extensions/         ← Chrome 확장 소개·다운로드 페이지
│   ├── style.css       ← 확장 뷰어 공용 스타일
│   ├── viewer.js       ← 확장 뷰어 공용 렌더러
│   ├── naver-blog-cleaner/
│   │   ├── index.html  ← 소개 페이지
│   │   ├── README.md
│   │   ├── manifest.json
│   │   ├── content.js / background.js
│   │   └── icons/
│   └── youtube-script-copier/
│       ├── index.html
│       ├── README.md
│       ├── manifest.json
│       └── content.js / styles.css
│
├── onboarding/         ← 신규 직원 온보딩 슬라이드
│   ├── index.html      ← 슬라이드 뷰어 (16:9 + 사이드바)
│   ├── css/ js/        ← 뷰어 자산
│   ├── sections/       ← 섹션별 마크다운
│   └── _source/ src/   ← 원본 소스 (빌드용)
│
├── youtube-report/     ← 유튜브 월간 보고서 생성기 (SPA)
│   ├── index.html
│   ├── app.js / youtube-api.js / ai-analysis.js ...
│   └── style.css
│
└── help/               ← (예약) 이 가이드를 사이트에서 보는 페이지
```

### 각 폴더의 역할 요약

| 폴더 | 성격 | 추가 기준 |
|------|------|-----------|
| `docu/` | 마크다운 기반 문서·강의 | 글 위주 콘텐츠 |
| `extensions/` | Chrome 확장 소개 페이지 | 확장 배포 시 |
| `onboarding/` | 사내 슬라이드형 문서 | 내부 교육용 |
| `youtube-report/` | 인터랙티브 웹 도구 | 복잡한 JS 도구 |
| `help/` | 가이드·안내 페이지 | 운영 문서 공개 필요 시 |

---

## 3. 카테고리 시스템

허브의 모든 카드는 **플랫폼(platform)** 과 **유형(type)**, 두 가지 축으로 분류됩니다.

### 현재 카테고리 목록

**플랫폼 (`data-platform`)**

| 값 | 의미 | 색상 (라이트 기준) |
|---|---|---|
| `naver` | 네이버 관련 | `#4caf6e` (톤다운 녹색) |
| `youtube` | 유튜브 관련 | `#e57373` (톤다운 빨강) |
| `onboarding` | 사내 내부 자료 | `#5b9bd5` (톤다운 파랑) |

**유형 (`data-type`)**

| 값 | 의미 | 색상 (라이트 기준) |
|---|---|---|
| `doc` | 문서·강의·슬라이드 | `#d4b86c` (머스타드) |
| `tool` | 인터랙티브 도구·확장 | `#9b87cb` (라벤더) |

### 카드 좌측 그라데이션의 원리

카드 왼쪽에 6px짜리 세로 스트라이프가 표시됩니다. 위쪽은 `data-platform` 색, 아래쪽은 `data-type` 색으로 그라데이션 처리됩니다. `data-platform`이나 `data-type`을 지정하지 않으면 회색(`#9da7b1`)으로 표시됩니다.

### 카테고리 선택 원칙

새 페이지를 추가할 때는 **기존 카테고리를 최대한 재사용**하세요. 기존 플랫폼·유형으로 표현이 불가능한 경우에만 새 카테고리를 추가합니다 (추가 방법은 [5장](#5-카테고리-추가변경하기) 참조).

---

## 4. 새 페이지 추가하기

이 섹션이 가장 중요합니다. 케이스별로 단계를 따라 하면 됩니다.

### 4-1. 페이지 종류 4가지

| 종류 | 예시 | 특징 |
|------|------|------|
| 단순 마크다운 문서 | `docu/naverlogic2605/lecture.md` | 가장 간단. 마크다운 작성 후 viewer.js로 렌더링 |
| 마크다운 + 멀티 탭 | `docu/naverlogic2605/playbook/` | 챕터가 여러 개인 강의·플레이북 |
| 인터랙티브 도구 | `youtube-report/` | JavaScript SPA. 별도 폴더에 자체 index.html |
| Chrome 확장 | `extensions/naver-blog-cleaner/` | 확장 파일 + 소개 index.html |

---

### 4-2. 단순 문서 추가 (가장 흔한 경우)

#### 1단계: 폴더 만들기

콘텐츠 성격에 맞는 위치에 새 폴더를 만듭니다.

```powershell
# 예: 새 강의 자료 추가
mkdir "docu\instagram2606"

# 또는 확장이 아닌 일반 도구라면
mkdir "ig-tool"
```

#### 2단계: 콘텐츠 파일 배치

마크다운 문서라면 `content.md` 또는 원하는 이름으로 작성합니다. 기존 `docu/naverlogic2605/` 구조를 참고해 `viewer.js`, `style.css`를 복사해서 쓸 수 있습니다.

#### 3단계: 허브 index.html에 카드 추가

`index.html`의 `<section class="cards">` 안에 아래 스니펫을 복사·붙여넣기하고 내용을 수정합니다.

```html
<a class="card" href="./docu/instagram2606/" target="_self"
   data-platform="naver" data-type="doc"
   data-tags="네이버 인스타그램 강의 문서">
  <div class="card-tags">
    <span class="tag tag-naver">#네이버</span>
    <span class="tag tag-doc">#문서</span>
    <span class="tag tag-doc">#강의</span>
  </div>
  <h2 class="card-title">카드 제목을 여기에 쓰세요</h2>
  <p class="card-desc">
    카드에 표시될 짧은 설명. 2-3줄 이내로 작성하세요.
  </p>
  <div class="card-footer">
    <span class="card-meta">분량 정보 (예: 5 PART · 부록 2종)</span>
    <span class="card-cta">열기 →</span>
  </div>
</a>
```

#### 4단계: data-platform, data-type 지정

스니펫에서 아래 두 속성을 실제 카테고리로 교체합니다.

```html
data-platform="naver"    ← naver / youtube / onboarding 중 선택
data-type="doc"          ← doc / tool 중 선택
```

#### 5단계: 태그 클래스 적용

`<span class="tag tag-???">` 부분도 플랫폼·유형에 맞게 변경합니다.

- 플랫폼 태그: `tag-naver`, `tag-youtube`, `tag-onboarding`
- 유형 태그: `tag-doc`, `tag-tool`

태그는 2~4개 정도가 적당합니다. 플랫폼 + 유형 + 핵심 키워드 1-2개.

#### 6단계: 검색용 data-tags 설정

`data-tags` 속성에 검색어로 쓸 한국어 키워드를 공백으로 구분해 넣습니다. 제목·설명과 중복되어도 괜찮습니다.

```html
data-tags="네이버 SEO 블로그 검색 강의 문서"
```

#### 7단계: 로컬 테스트

```powershell
cd "C:\path\to\sbreport.github.io"
python -m http.server 8000
```

`http://localhost:8000` 에서 확인:
- 카드가 허브에 보이는가
- 카드를 클릭했을 때 페이지가 열리는가 (404 아닌지)
- 좌측 그라데이션 색이 올바른가
- 검색창에 키워드 입력 시 카드가 나타나는가

#### 8단계: git commit + push

```bash
git add .
git commit -m "Add: 인스타그램 강의 메모 카드 추가"
git push
```

1~2분 후 https://sbreport.github.io/ 에서 반영 확인.

---

### 4-3. Chrome 확장 추가

1. `extensions/<확장이름>/` 폴더를 만들고 확장 파일 배치:
   - `manifest.json`, `content.js` (또는 `background.js`), `icons/`
   - `README.md` — 확장 설명 마크다운
   - `index.html` — 소개 페이지 (기존 `naver-blog-cleaner/index.html` 구조 참고)

2. `extensions/viewer.js`와 `extensions/style.css`를 소개 페이지에서 불러와 쓸 수 있습니다.

3. 허브 카드 추가 (4-2의 3~8단계와 동일):

```html
<a class="card" href="./extensions/my-extension/" target="_self"
   data-platform="naver" data-type="tool"
   data-tags="확장 크롬 네이버 도구">
  <div class="card-tags">
    <span class="tag tag-naver">#네이버</span>
    <span class="tag tag-tool">#도구</span>
    <span class="tag tag-tool">#확장</span>
  </div>
  <h2 class="card-title">확장 이름</h2>
  <p class="card-desc">한 줄 설명.</p>
  <div class="card-footer">
    <span class="card-meta">README + ZIP</span>
    <span class="card-cta">열기 →</span>
  </div>
</a>
```

---

### 4-4. 인터랙티브 도구 추가

JavaScript가 중심인 도구(예: API를 호출하거나 데이터를 가공하는 웹앱)는 별도 폴더를 루트 또는 적절한 위치에 만듭니다.

1. `my-tool/` 폴더 생성
2. 자체 `index.html`, JS 파일, CSS 파일 배치
3. 허브 카드 추가 (`data-type="tool"` 지정)

외부 API 키가 필요한 경우, `index.html` 내에 입력창을 두고 사용자가 직접 입력하도록 합니다 (유튜브 보고서 생성기 방식 참고). API 키를 소스에 직접 넣지 마세요.

---

## 5. 카테고리 추가·변경하기

새 플랫폼이나 유형이 생길 때만 이 절차를 따릅니다. **기존 카테고리로 해결 가능하면 추가하지 마세요.**

### 5-1. 새 플랫폼 추가 (예: instagram)

총 4곳을 수정해야 합니다.

#### [1] style.css — `:root` 블록에 색상 변수 2개 추가

`:root { ... }` 안의 플랫폼 색상 변수 묶음에 다음을 추가합니다.

```css
/* 기존 코드 (참조용, 수정 X) */
--plat-naver: #4caf6e;
--plat-youtube: #e57373;
--plat-onboarding: #5b9bd5;

/* 여기에 추가 */
--plat-instagram: #c96a9d;   /* 인스타그램 — 톤다운 핑크 */
```

`[data-theme="dark"] { ... }` 블록에도 동일하게 다크모드 색을 추가합니다.

```css
/* 기존 다크모드 색 (참조용) */
--plat-naver: #58c777;
--plat-youtube: #ff9b94;

/* 여기에 추가 */
--plat-instagram: #e091bb;   /* 다크모드에서는 살짝 밝게 */
```

#### [2] style.css — 카드 플랫폼 컬러 매핑 1줄 추가

`/* 플랫폼 컬러 매핑 */` 주석 아래 블록에 한 줄 추가합니다.

```css
/* 기존 */
.card[data-platform="naver"]     { --card-plat: var(--plat-naver); }
.card[data-platform="youtube"]   { --card-plat: var(--plat-youtube); }
.card[data-platform="onboarding"]{ --card-plat: var(--plat-onboarding); }

/* 추가할 줄 */
.card[data-platform="instagram"] { --card-plat: var(--plat-instagram); }
```

#### [3] style.css — 태그 색상 변수 + 태그 클래스 추가

`:root` 안의 태그 색상 변수 묶음에 추가합니다.

```css
/* 기존 */
--tag-naver-bg: #dafbe1;    --tag-naver-fg: #1a7f37;

/* 추가 */
--tag-instagram-bg: #fce4f3; --tag-instagram-fg: #9b2c6e;
```

`[data-theme="dark"]` 블록에도 추가합니다.

```css
--tag-instagram-bg: #3a1a2e; --tag-instagram-fg: #e091bb;
```

그리고 `/* 태그 컬러 — 플랫폼/유형 매핑 */` 아래에 클래스 한 줄 추가합니다.

```css
.tag-instagram { background: var(--tag-instagram-bg); color: var(--tag-instagram-fg); }
```

#### [4] index.html — PLATFORM_ORDER 객체에 추가

`<script>` 안의 `PLATFORM_ORDER` 객체에 새 플랫폼과 순서를 추가합니다.

```js
// 기존
const PLATFORM_ORDER = { naver: 1, youtube: 2, onboarding: 3 };

// 수정 후
const PLATFORM_ORDER = { naver: 1, youtube: 2, onboarding: 3, instagram: 4 };
```

숫자가 작을수록 "플랫폼순" 정렬에서 앞에 나옵니다.

---

### 5-2. 새 유형 추가 (예: guide)

플랫폼 추가와 동일한 패턴입니다.

#### [1] style.css — `:root`에 유형 색상 변수 추가

```css
/* 기존 */
--type-doc: #d4b86c;
--type-tool: #9b87cb;

/* 추가 */
--type-guide: #7ab5a0;   /* 가이드 — 톤다운 민트 */
```

`[data-theme="dark"]`에도 동일 추가.

#### [2] style.css — 카드 유형 컬러 매핑 추가

```css
/* 기존 */
.card[data-type="doc"]  { --card-type: var(--type-doc); }
.card[data-type="tool"] { --card-type: var(--type-tool); }

/* 추가 */
.card[data-type="guide"] { --card-type: var(--type-guide); }
```

#### [3] style.css — 태그 색상 + 클래스 추가

```css
/* :root 안 */
--tag-guide-bg: #d8f3ec; --tag-guide-fg: #1a6b55;

/* [data-theme="dark"] 안 */
--tag-guide-bg: #1a3a32; --tag-guide-fg: #5fd1b0;

/* 태그 클래스 */
.tag-guide { background: var(--tag-guide-bg); color: var(--tag-guide-fg); }
```

#### [4] index.html — TYPE_ORDER 객체에 추가

```js
// 기존
const TYPE_ORDER = { doc: 1, tool: 2 };

// 수정 후
const TYPE_ORDER = { doc: 1, tool: 2, guide: 3 };
```

---

## 6. 기존 페이지 수정하기

### 콘텐츠 파일 직접 편집

마크다운 기반 페이지라면 해당 `.md` 파일을 텍스트 편집기로 열어 수정합니다. 저장 후 로컬 서버에서 새로고침하면 바로 반영됩니다.

### 허브 카드 정보 변경

`index.html`에서 해당 카드의 `<a class="card">` 블록을 찾아 제목, 설명, 태그, `data-tags` 등을 수정합니다.

### footer 날짜 업데이트

`index.html` 하단의 `<footer>` 안 날짜를 수정합니다.

```html
<span>최종 업데이트 2026-05-11</span>  ← 날짜 수정
```

### 마크다운 페이지의 캐시 우회

수정했는데 브라우저에 반영이 안 될 때: 브라우저에서 **Ctrl + Shift + R** (강력 새로고침)을 누르면 캐시를 무시하고 최신 파일을 불러옵니다.

---

## 7. 보안 / 마스킹 정책

이 리포지토리는 **Public**입니다. 누구나 소스를 볼 수 있으므로 민감 정보를 절대 포함하지 마세요.

### 금지 항목

- 직원 실명 (이름)
- 비밀번호, API 키, 토큰
- 내부 전용 URL (사내 Notion 링크 등)
- 클라이언트 실제 수치 (매출, 광고비 등)

### 마스킹 방법

| 원본 | 마스킹 후 |
|------|-----------|
| 홍길동 | 홍OO |
| 비밀번호: abc123 | 비밀번호: 노션에서 확인 |
| 월 광고비 3,247만 원 | 월 광고비 3,000만 원대 |
| https://notion.so/internal/xxx | (링크 제거) |

### 원본 보관 방법

마스킹 전 원본은 `.gitignore`에 등록된 `원본 백업/` 폴더에 보관합니다. 이 폴더는 `git push` 해도 GitHub에 올라가지 않습니다.

```
# .gitignore 내용 (수정 불필요)
원본 백업/
**/원본 백업/
```

⚠ `원본 백업/` 폴더 이름을 바꾸거나, `.gitignore` 규칙을 제거하지 마세요. 원본이 공개될 수 있습니다.

---

## 8. 로컬 테스트 & 배포

### 8-1. 로컬 서버 띄우기

```powershell
cd "C:\Users\TUF A15 FA507RM\OneDrive\바탕 화면\claude code\sbreport.github.io"
python -m http.server 8000
```

브라우저에서 `http://localhost:8000` 접속. 서버를 종료하려면 터미널에서 `Ctrl + C`.

Python이 없다면 VS Code의 Live Server 확장도 사용 가능합니다.

### 8-2. git으로 push → 자동 배포

```bash
git add .
git commit -m "Add: 새 강의 페이지 추가"
git push
```

push 후 1~2분 대기 → https://sbreport.github.io/ 접속 → **Ctrl + Shift + R** 강력 새로고침으로 확인.

### 8-3. 커밋 메시지 규칙 (권장)

```
Add: 새 항목 추가
Update: 기존 내용 수정
Fix: 오류 수정
Remove: 삭제
```

예: `Add: 유튜브 쇼츠 가이드 카드 추가`, `Update: 온보딩 슬라이드 3장 수정`

---

## 9. 자주 묻는 질문 (FAQ)

**Q. push했는데 사이트에 반영이 안 돼요.**

GitHub Pages 빌드에 1~2분이 걸립니다. 기다린 후 브라우저에서 **Ctrl + Shift + R** (강력 새로고침)을 눌러주세요. 브라우저 캐시가 남아 있으면 이전 버전이 보입니다.

---

**Q. 카드를 클릭했는데 404 오류가 떠요.**

카드의 `href` 경로와 실제 폴더 경로가 맞지 않는 경우입니다.

- `href="./docu/mypage/"` 라면 `docu/mypage/index.html` 파일이 반드시 있어야 합니다.
- 경로의 대소문자, 슬래시 방향(`/`) 을 확인하세요.

---

**Q. 검색해도 내 카드가 안 나와요.**

카드의 `data-tags` 속성에 검색 키워드가 없는 경우입니다. 예를 들어 "블로그"로 검색하려면:

```html
data-tags="네이버 블로그 ..."
```

제목과 설명도 검색 대상이지만, `data-tags`에 명시적으로 넣는 것이 가장 확실합니다.

---

**Q. 카드 좌측 그라데이션이 회색으로 떠요.**

`data-platform` 또는 `data-type` 속성이 없거나, 지원하지 않는 값이 들어간 경우입니다.

```html
data-platform="naver"   ← naver / youtube / onboarding 중 하나인지 확인
data-type="doc"         ← doc / tool 중 하나인지 확인
```

새로운 값을 쓰려면 5장의 카테고리 추가 절차를 먼저 완료해야 합니다.

---

**Q. 마크다운이 렌더링되지 않고 텍스트 그대로 보여요.**

`file://` 로 직접 파일을 열면 브라우저 보안 정책 때문에 fetch가 차단되어 마크다운을 불러오지 못합니다. 로컬 서버(`python -m http.server 8000`)를 띄운 뒤 `http://localhost:8000`으로 접속하세요.

---

**Q. 다크모드에서 카드 색이 이상해요 (흰 배경이 남아 있거나 태그가 안 보여요).**

`style.css`의 `[data-theme="dark"]` 블록에 해당 카테고리의 색상 변수가 없는 경우입니다. 새 카테고리를 추가할 때 라이트모드 `:root`와 다크모드 `[data-theme="dark"]` 양쪽 모두에 변수를 추가했는지 확인하세요.

---

**Q. 정렬에서 새 플랫폼이 맨 뒤로 밀려요.**

`index.html`의 `PLATFORM_ORDER` 객체에 새 플랫폼이 등록되지 않은 경우입니다. 등록되지 않은 값은 우선순위 99로 처리되어 맨 뒤로 밀립니다. 5-1의 4번 단계를 확인하세요.

---

**Q. Chrome 확장 설치 방법을 페이지에 어떻게 적으면 되나요?**

기존 `extensions/naver-blog-cleaner/README.md` 를 참고하세요. `크롬://확장 프로그램` → 개발자 모드 → 압축해제된 확장 로드 흐름이 이미 문서화되어 있습니다.

---

## 10. 디자인 원칙 참고

이 허브의 디자인은 다음 원칙을 따릅니다. 새 페이지를 추가할 때 톤을 맞추세요.

- **5열 컴팩트 카드 그리드** — 화면 너비에 따라 자동 조정 (`auto-fit, minmax(280px, 1fr)`)
- **정보 밀도 우선** — 여백은 목적이 있을 때만. 과한 padding, 큰 max-width 지양
- **AI Slop 회피** — 그라데이션 장식, 이모지 UI, 보라 강조, 3열 feature grid 금지  
  (단, 카드 좌측 카테고리 식별용 그라데이션은 의도적 예외)
- **한 카드 = 한 가지 콘텐츠** — 여러 콘텐츠를 한 카드에 묶지 말 것
- **링크 대상** — 허브 내부 링크는 `target="_self"`, 외부 URL이면 `target="_blank"` + `rel="noopener"`

---

## 11. 향후 작업 메모 (TBD)

미해결 사항과 검토 중인 항목을 기록합니다. 완료되면 이 목록에서 제거하세요.

### 우선순위 — 정해진 다음 작업

- [ ] **폴더 구조 재분류** — 현재 프로젝트별 폴더(`docu/`, `extensions/`, `onboarding/`, `youtube-report/`)가 일관되지 않은 분류 양식으로 나뉘어 있음. 향후 **`문서/`, `도구/`** 같은 상위 카테고리 폴더를 만들고 하위에 정렬하는 방식으로 통합 고려.
  - 예상 구조 (안):
    ```
    문서/
      naverlogic2605/
      onboarding/
    도구/
      youtube-report/
      naver-blog-cleaner/
      youtube-script-copier/
    ```
  - 단점: URL 변경 → 외부 공유 링크 끊김. 마이그레이션 시점에 주의.
  - **후순위**: 카드 가시성·검색이 현재 충분히 동작하므로 폴더 구조는 콘텐츠가 더 쌓인 후 진행.

- [ ] **문서 전용 보기 모드 (필터 뷰)** — 문서가 여럿 쌓이면 허브에 "문서만 보기" 또는 "도구만 보기" 토글 추가 검토.
  - 현재도 검색창에 `문서` 입력 시 필터링은 작동함 (`data-tags`에 "문서" 포함)
  - 명시적 UI 토글 추가 시: 정렬 드롭다운 옆에 카테고리 칩 버튼 (`[전체] [문서] [도구]`) 형태가 자연스러움.
  - 구현 난이도: 낮음 (기존 검색 로직 + 칩 UI 추가, ~30줄)

- [ ] **로그인 기반 정보 층위 (마스킹 우회용)** — 깃허브 외 플랫폼으로 일부 자료(마스킹 안 된 원본)를 옮기고, 로그인한 사람만 보도록 분리할 수 있는지 검토.
  - **GitHub Pages**는 로그인 기능 없음 → 별도 호스팅 필요.
  - 검토 후보:
    1. **Cloudflare Pages + Cloudflare Access** — 무료, Google/이메일 OTP 로그인, 최대 50명까지 무료 (추천)
    2. **Vercel + Vercel Auth** — 비슷, 팀 플랜 필요할 수 있음
    3. **Netlify Identity** — Netlify 기본 제공, 기본 무료 1,000명
    4. **Notion** — 페이지 단위 공유 권한 (단, 코드/JS 동작 불가)
  - 시나리오 예: 온보딩 자료의 마스킹 원본을 Cloudflare Pages에 별도 배포 + 회사 이메일로만 접근 제한.
  - 현재 깃 리포는 그대로 두고 **민감 자료만 별도 호스팅**하는 방식 권장.

### 기타 미정 사항

- [ ] 옛 `sbreport.github.io/Report` 리포지토리 archive 처리 여부 검토
- [ ] 새 카테고리 필요성 검토: `instagram`, `blog` 등 플랫폼 확장 가능성
- [ ] Chrome 확장 ZIP 배포 자동화 (빌드 스크립트 추가 여부)
- [ ] footer 날짜 자동 업데이트 방안 검토
- [ ] `원본 백업/` 폴더의 영구 보관 위치 결정 (현재 .gitignore로만 차단)

---

*최종 업데이트: 2026-05-11*
