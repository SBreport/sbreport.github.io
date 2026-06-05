/**
 * parse-naver-sections.test.js
 *
 * 목적:
 *   parseNaverSections 함수의 회귀(behavior 고정) 테스트.
 *   정적 HTML 파싱 결과를 스냅샷으로 잠가,
 *   이후 파서 수정 시 의도치 않은 변화를 감지한다.
 *
 * 픽스처 출처:
 *   "청주 한의원" 키워드, 2026-05-27 저장된 네이버 결과 HTML (모바일/PC).
 *   위치: test/fixtures/cheongju-hanuiwon.{mobile,pc}.html
 *
 * 알려진 한계 / 검증 안 된 값:
 *   - place(플레이스) count=null:
 *       정적 HTML에 카드 데이터 없음(JS 렌더). 원천적 한계 —
 *       추후 헤드리스 렌더로만 복구 가능.
 *   - web(관련사이트)·news(뉴스) count=null, blog(블로그) count=1:
 *       현재 동작을 고정한 것일 뿐 실제 화면 카드 수와 일치하는지 미검증.
 *       이 값이 향후 바뀌면(테스트 실패) "개선인지 회귀인지" 사람이 판단할 것.
 *       (TODO: 라이브 화면 대조로 정답 확정)
 */

import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseNaverSections } from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const mobileHtml = readFileSync(join(__dirname, 'fixtures/cheongju-hanuiwon.mobile.html'), 'utf8');
const pcHtml     = readFileSync(join(__dirname, 'fixtures/cheongju-hanuiwon.pc.html'),     'utf8');

// ── 골든값 ───────────────────────────────────────────────────────────────────

const MOBILE_GOLDEN = [
  { order: 1, type: 'powerlink', label: '파워링크',  count: 5    },
  { order: 2, type: 'place',     label: '플레이스',  count: null },
  { order: 3, type: 'web',       label: '관련사이트', count: null },
  { order: 4, type: 'blog',      label: '블로그',    count: 1    },
  { order: 5, type: 'news',      label: '뉴스',      count: null },
  { order: 6, type: 'kin',       label: '지식인',    count: 3    },
];

const PC_GOLDEN = [
  { order: 1, type: 'powerlink', label: '파워링크',  count: 10   },
  { order: 2, type: 'place',     label: '플레이스',  count: null },
  { order: 3, type: 'web',       label: '관련사이트', count: null },
  { order: 4, type: 'blog',      label: '블로그',    count: 1    },
  { order: 5, type: 'news',      label: '뉴스',      count: null },
  { order: 6, type: 'kin',       label: '지식인',    count: 3    },
];

// ── 테스트 ───────────────────────────────────────────────────────────────────

test('mobile fixture: 청주 한의원 구좌 골든', () => {
  const result = parseNaverSections(mobileHtml, 'mobile');
  assert.deepStrictEqual(result, MOBILE_GOLDEN);
});

test('pc fixture: 청주 한의원 구좌 골든', () => {
  const result = parseNaverSections(pcHtml, 'pc');
  assert.deepStrictEqual(result, PC_GOLDEN);
});
