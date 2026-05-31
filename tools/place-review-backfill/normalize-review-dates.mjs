/**
 * normalize-review-dates.mjs
 * 기존 place_reviews 행의 review_created_at(네이버 상대 날짜)을 파싱해
 * review_date(ISO YYYY-MM-DD) 컬럼을 일괄 채우는 일회성 스크립트.
 *
 * 동작 방식:
 *   1) wrangler d1 execute --remote --command 로 DISTINCT review_created_at 조회
 *      (SELECT는 --command가 결과를 반환; --file은 업로드 요약만 반환)
 *   2) JS로 각 값을 파싱 → UPDATE 문 생성 후 배치 실행 (--file, 500건씩)
 *
 * 사용법:
 *   node tools/place-review-backfill/normalize-review-dates.mjs
 *   (wrangler CLI가 PATH에 있어야 하며, Workers 프로젝트 디렉토리에서 실행)
 */

import { execSync } from 'child_process';
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

// ─── wrangler 실행 위치 (Worker 디렉토리) ────────────────────────────────────
import { fileURLToPath } from 'url';
const WORKER_DIR = fileURLToPath(new URL('../../workers/naver-searchad-proxy', import.meta.url));

const DB_NAME = 'smartsupport-db';

// tmpfile 경로: 공백·한글 없는 경로 사용
const TMP_DIR = 'C:\\Temp\\normalize_reviews';
if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });

// ─── parseNaverReviewDate (Worker와 동일 로직) ────────────────────────────────
// 예시: "5.9.토" → "2026-05-09", "25.9.9.화" → "2025-09-09"
function parseNaverReviewDate(raw, refDate) {
  if (!raw || typeof raw !== 'string') return null;
  let parts = raw.split('.').map((s) => s.trim()).filter(Boolean);
  if (parts.length && /[월화수목금토일]/.test(parts[parts.length - 1])) parts.pop();
  let y, m, d;
  if (parts.length === 2) {
    m = Number(parts[0]);
    d = Number(parts[1]);
    y = refDate.getFullYear();
    if (new Date(y, m - 1, d) > refDate) y -= 1;
  } else if (parts.length === 3) {
    y = 2000 + Number(parts[0]);
    m = Number(parts[1]);
    d = Number(parts[2]);
  } else {
    return null;
  }
  if (
    !Number.isInteger(m) || !Number.isInteger(d) ||
    m < 1 || m > 12 || d < 1 || d > 31
  ) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${y}-${pad(m)}-${pad(d)}`;
}

// ─── wrangler 헬퍼 ────────────────────────────────────────────────────────────

/**
 * wrangler stdout에서 JSON 배열 부분만 추출.
 */
function extractJson(raw) {
  const idx = raw.indexOf('[');
  if (idx === -1) throw new Error(`JSON 배열 없음: ${raw.slice(0, 300)}`);
  return JSON.parse(raw.slice(idx));
}

/**
 * SELECT 전용: --command 방식 (원격에서 결과 반환됨).
 * 인자 sql은 단일 SELECT 문 (세미콜론 없이).
 */
function wranglerSelect(sql) {
  // cmd.exe를 통해 실행하므로 이중 따옴표 내부 이스케이프 필요
  const escaped = sql.replace(/"/g, '\\"').replace(/\n/g, ' ');
  const output = execSync(
    `npx wrangler d1 execute ${DB_NAME} --remote --command "${escaped}" --json`,
    { cwd: WORKER_DIR, encoding: 'utf8', shell: true }
  );
  return extractJson(output);
}

/**
 * UPDATE 전용: --file 방식 (공백·특수문자 안전).
 * tmpfile을 TMP_DIR에 생성 후 실행.
 */
function wranglerUpdate(sql, label) {
  const tmpFile = join(TMP_DIR, `batch_${label}_${Date.now()}.sql`);
  writeFileSync(tmpFile, sql, 'utf8');
  try {
    const output = execSync(
      `npx wrangler d1 execute ${DB_NAME} --remote --file="${tmpFile}" --json`,
      { cwd: WORKER_DIR, encoding: 'utf8', shell: true }
    );
    return extractJson(output);
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

// ─── 메인 ─────────────────────────────────────────────────────────────────────
async function main() {
  const refDate = new Date();
  console.log(`[normalize-review-dates] 시작. 기준일: ${refDate.toISOString()}`);
  console.log(`  Worker 디렉토리: ${WORKER_DIR}`);

  // 1) 전체 건수 + review_date NULL 건수 확인
  console.log('\n[0단계] 현황 파악...');
  try {
    const result = wranglerSelect(
      'SELECT COUNT(*) AS total, SUM(CASE WHEN review_date IS NULL THEN 1 ELSE 0 END) AS null_count FROM place_reviews'
    );
    const row = result[0]?.results?.[0];
    console.log(`  총 리뷰: ${row?.total ?? '?'}건, review_date NULL: ${row?.null_count ?? '?'}건`);
  } catch (err) {
    console.warn(`  현황 조회 실패 (무시): ${err.message}`);
  }

  // 2) DISTINCT review_created_at (review_date IS NULL) 조회
  // 고유 값 수가 많으면 LIMIT를 나눠서 처리
  console.log('\n[1단계] DISTINCT review_created_at 값 조회...');

  const DISTINCT_LIMIT = 5000; // 충분한 상한 (실제 고유 날짜 형식 수는 수백 이내)
  let distinctRows;
  try {
    const result = wranglerSelect(
      `SELECT DISTINCT review_created_at FROM place_reviews WHERE review_date IS NULL AND review_created_at IS NOT NULL ORDER BY review_created_at LIMIT ${DISTINCT_LIMIT}`
    );
    distinctRows = result[0]?.results ?? [];
  } catch (err) {
    console.error(`[오류] D1 조회 실패: ${err.message}`);
    process.exit(1);
  }

  console.log(`  → 고유 review_created_at 값: ${distinctRows.length}개`);
  if (distinctRows.length === 0) {
    console.log('  변환할 행이 없습니다. 종료.');
    return;
  }

  // 3) 파싱
  const parsedMap = new Map();
  let parseFailed = 0;
  const failedSamples = [];
  for (const row of distinctRows) {
    const raw = row.review_created_at;
    const iso = parseNaverReviewDate(raw, refDate);
    if (iso) {
      parsedMap.set(raw, iso);
    } else {
      parseFailed++;
      if (failedSamples.length < 10) failedSamples.push(raw);
    }
  }

  console.log(`  파싱 성공: ${parsedMap.size}개, 파싱 실패(null 유지): ${parseFailed}개`);
  if (failedSamples.length > 0) {
    console.log(`  실패 샘플: ${failedSamples.map((v) => `"${v}"`).join(', ')}`);
  }

  // 4) UPDATE 배치 실행
  const entries = Array.from(parsedMap.entries());
  const BATCH_SIZE = 500;
  let totalWritten = 0;

  console.log(`\n[2단계] UPDATE 배치 실행 (고유 값 ${entries.length}개, 배치 ${BATCH_SIZE}개씩)...`);

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    const sqlLines = batch.map(([raw, iso]) => {
      const safeRaw = raw.replace(/'/g, "''");
      const safeIso = iso.replace(/'/g, "''");
      return `UPDATE place_reviews SET review_date = '${safeIso}' WHERE review_created_at = '${safeRaw}' AND review_date IS NULL;`;
    });
    const sql = sqlLines.join('\n');
    const batchIdx = Math.floor(i / BATCH_SIZE) + 1;

    try {
      const result = wranglerUpdate(sql, batchIdx);
      // --file + --remote 는 rows_written을 summary로 반환
      let batchWritten = 0;
      if (Array.isArray(result)) {
        for (const r of result) {
          // meta.rows_written 또는 summary의 "Rows written"
          if (r.meta?.rows_written != null) {
            batchWritten += r.meta.rows_written;
          } else if (r.results) {
            // summary row
            for (const s of r.results) {
              if (s['Rows written'] != null) batchWritten += Number(s['Rows written']);
            }
          }
        }
      }
      totalWritten += batchWritten;
      const progress = Math.min(i + BATCH_SIZE, entries.length);
      console.log(`  배치 ${batchIdx} (${progress}/${entries.length}) → rows_written=${batchWritten} (누적 ${totalWritten})`);
    } catch (err) {
      console.error(`  [배치 오류] 배치 ${batchIdx}: ${err.message}`);
    }
  }

  // 5) 최종 검증
  console.log('\n[3단계] 최종 검증...');
  try {
    const result = wranglerSelect(
      'SELECT COUNT(*) AS remaining FROM place_reviews WHERE review_date IS NULL'
    );
    const remaining = result[0]?.results?.[0]?.remaining ?? '(알 수 없음)';
    console.log(`  review_date IS NULL 잔여: ${remaining}건`);
    if (Number(remaining) === 0) {
      console.log('  모든 행 변환 완료.');
    } else {
      console.log(`  ※ 잔여 ${remaining}건은 파싱 실패(비표준 형식) 또는 review_created_at=NULL인 행입니다.`);
    }
  } catch (err) {
    console.error(`  [검증 오류] ${err.message}`);
  }

  console.log(`\n[완료] rows_written 합산: ${totalWritten}`);
}

main().catch((err) => {
  console.error('[치명적 오류]', err.message);
  process.exit(1);
});
