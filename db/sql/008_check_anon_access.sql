-- =============================================================
-- OK-system 008 — 보안 상태 진단 (읽기 전용)
--
-- 이 파일은 아무것도 바꾸지 않는다. 지금 상태를 보기만 한다.
-- 언제든 몇 번이든 돌려도 된다.
--
-- 실제로 잠그는 것은 009_lock_anon_access.sql 이다.
-- (진단과 조치를 한 파일에 두었더니 "전체 실행"이 아무것도 잠그지 않는
--  함정이 되어, 파일을 둘로 나눴다)
-- =============================================================


-- =============================================================
-- 1. 표마다 RLS 가 켜져 있는지, anon/authenticated 에게 어떤 권한이 있는지
--
-- 기대하는 상태
--   "anon/authenticated 권한" = (없음 — 막혀 있음)
--   -> 권한 자체가 없으므로 anon 키로는 표에 손도 댈 수 없다.
--
-- "RLS 켜짐" 은 true 여도 false 여도 지금은 앱에 영향이 없다.
-- 서버가 쓰는 service_role 은 RLS 를 우회하기 때문이다.
-- 다만 true 이면 권한을 다시 주더라도 정책이 없는 한 아무 행도 안 보인다.
-- 잠금이 두 겹이라는 뜻이라 나쁘지 않다.
-- =============================================================
select
  t.tablename                                      as "표",
  c.relrowsecurity                                 as "RLS 켜짐",
  coalesce(
    string_agg(distinct g.grantee || '=' || g.privilege_type, ', '
               order by g.grantee || '=' || g.privilege_type),
    '(없음 — 막혀 있음)'
  )                                                as "anon/authenticated 권한"
from pg_tables t
join pg_class c
  on c.relname = t.tablename
join pg_namespace n
  on n.oid = c.relnamespace and n.nspname = t.schemaname
left join information_schema.role_table_grants g
  on g.table_schema = t.schemaname
 and g.table_name = t.tablename
 and g.grantee in ('anon', 'authenticated')
where t.schemaname = 'public'
group by t.tablename, c.relrowsecurity
order by t.tablename;


-- =============================================================
-- 2. 앞으로 만들 표에 자동으로 붙는 기본 권한
--
-- 이게 남아 있으면 표를 새로 만들 때마다 다시 열린다.
-- 지금 있는 표만 막아 봐야 다음 마이그레이션에서 구멍이 다시 생긴다.
--
-- 기대하는 상태: 결과가 비어 있거나, anon·authenticated 가 보이지 않는다.
-- =============================================================
select
  d.defaclrole::regrole                            as "권한을 준 역할",
  d.defaclobjtype                                  as "대상 종류(r=표, S=시퀀스)",
  d.defaclacl                                      as "기본 권한"
from pg_default_acl d
join pg_namespace n on n.oid = d.defaclnamespace
where n.nspname = 'public';


-- =============================================================
-- 3. RLS 정책이 있는지
--
-- 기대하는 상태(지금): 결과가 비어 있다. 정책을 아직 안 만들었기 때문.
--
-- RLS 가 켜져 있고 정책이 없으면, 권한을 가진 역할에게는
--   SELECT        -> 오류가 아니라 "빈 결과"
--   INSERT/UPDATE -> new row violates row-level security policy
-- 가 된다. 특히 SELECT 가 조용히 비어서 오는 점을 조심해야 한다.
-- 로그인을 붙일 때 정책보다 권한을 먼저 주면 "왜 데이터가 안 보이지"로 헤맨다.
-- =============================================================
select
  tablename                                        as "표",
  policyname                                       as "정책 이름",
  cmd                                              as "대상 명령",
  roles                                            as "대상 역할"
from pg_policies
where schemaname = 'public'
order by tablename, policyname;
