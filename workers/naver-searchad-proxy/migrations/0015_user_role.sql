-- users: role 컬럼 추가
-- researcher role 신설: admin이 부여한 연구원도 샘플 생성·관리 가능
-- 2026-06-01 추가

ALTER TABLE users ADD COLUMN role TEXT;
