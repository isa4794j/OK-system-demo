-- =============================================================
-- OK-system 034 확인(읽기만) — 034_privacy_consent.sql 실행 뒤에 돌립니다. 아무것도 바꾸지 않습니다.
-- =============================================================

-- 1) 새 칸 둘이 있는가 — 2줄이면 정상
select table_name, column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and ((table_name = 'staff' and column_name = 'privacy_agreed_at')
    or (table_name = 'children_identity' and column_name = 'consent_date'))
order by table_name;

-- 2) 동의 현황 — 실행 직후에는 동의함 0 이 정상(다음 로그인 때 채워진다)
select
  count(*) filter (where password_hash is not null) as 로그인_계정,
  count(*) filter (where password_hash is not null and privacy_agreed_at is not null) as 동의함,
  count(*) filter (where password_hash is not null and privacy_agreed_at is null) as 아직
from public.staff;

-- 3) 아동 동의서 받은 날 — 적힌 수(처음엔 0)
select count(*) filter (where consent_date is not null) as 동의일_적힘, count(*) as 전체
from public.children_identity;
