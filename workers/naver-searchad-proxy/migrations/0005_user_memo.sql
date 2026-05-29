-- 관리자용 사용자 메모 (이 사람이 누구인지 식별 메모)
-- users 테이블에 admin_memo 컬럼 추가. 사용자당 메모 1개.
ALTER TABLE users ADD COLUMN admin_memo TEXT;
