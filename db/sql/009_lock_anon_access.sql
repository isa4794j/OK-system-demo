-- =============================================================
-- OK-system 009 — anon 접근 차단 (RLS 이전의 최소 조치)
--
-- 이 파일은 주석 없이 바로 돈다. 통째로 실행하면 잠긴다.
-- 상태 확인은 008_check_anon_access.sql 로 한다.
--
-- [2026-09-03 실행 완료]
-- 이 네 줄은 이미 한 번 적용했고, 008 진단에서
-- 7개 표 모두 "(없음 — 막혀 있음)" 인 것을 확인했다.
-- 여러 번 돌려도 안전하므로 나중에 다시 돌려도 된다.
--
-- [왜 필요한가]
-- RLS 를 제대로 켜는 일은 로그인 설계와 함께 해야 한다. 시간이 걸린다.
-- 그때까지 아동 신원정보·관찰·평가가 anon 키만으로 열려 있으면 안 된다.
-- 권한 자체를 회수해 그 사이를 막는다.
--
-- [왜 이걸로 끝이 아닌가]
-- 로그인이 생겨 authenticated 에게 권한을 다시 주는 순간,
-- "누가 어떤 행을 볼 수 있는가" 는 RLS 정책만이 답할 수 있다.
-- 이건 임시 자물쇠이지 최종 설계가 아니다.
--
-- [앱은 영향받지 않는다]
-- 브라우저는 Supabase 에 직접 접근하지 않는다. 늘 Deno 서버를 거치고,
-- 서버는 service_role 키를 쓴다. service_role 은 이 회수의 대상이 아니고
-- RLS 도 우회한다. 실제로 회수 뒤에도 7개 표 읽기와 쓰기 모두 정상이었다.
-- =============================================================


-- 지금 있는 모든 표·시퀀스에서 권한을 회수한다
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- 앞으로 만들 표에도 권한이 자동으로 붙지 않게 한다.
--
-- 이 두 줄이 핵심이다. Supabase 는 public 스키마에 기본 권한을 걸어 두어서,
-- 표를 새로 만들 때마다 anon 권한이 다시 붙는다.
-- 위 두 줄만 돌리면 다음 마이그레이션에서 구멍이 다시 생긴다.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;


-- =============================================================
-- 실행한 뒤에는 008_check_anon_access.sql 을 돌려 확인한다.
--
-- 그래도 008 의 2번에 anon 이 남아 있다면, 그 기본 권한을 준 역할이
-- 지금 SQL 을 실행하는 역할과 다른 것이다.
-- 그때는 "권한을 준 역할" 칸에 나온 이름을 넣어 다시 실행한다.
--
--   alter default privileges for role <그 역할> in schema public
--     revoke all on tables from anon, authenticated;
-- =============================================================
