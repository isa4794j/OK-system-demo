-- =============================================================
-- OK-system 마이그레이션 035
-- 로그인 기록 — audit_logs 에 'login' 을 쓸 수 있게 한다
--
-- 001~034 가 먼저 실행돼 있어야 합니다. 여러 번 실행해도 안전합니다.
-- =============================================================


-- =============================================================
-- [왜 필요한가]
-- 013 이 action 에 CHECK 를 걸어 두었다: create / update / delete 셋뿐이다.
-- 그래서 로그인 성공·실패를 적으려면 INSERT 가 DB 에서 거부된다.
-- 지금까지 남은 것은 staff.last_login_at(마지막 한 번만 덮어쓴다)과
-- failed_attempts(카운터 — 잠기면 0 으로 돌아가 흔적이 사라진다)뿐이었다.
--
-- [왜 새 표를 만들지 않았나]
-- 로그인 기록은 사람당 하루 몇 줄이고 child_id 가 없다. 보관 기간 문제가 거의 없어
-- 감사 로그와 같은 표에 두어도 소음이 되지 않는다. 변경 기록 화면의 칩으로 가릴 수 있다.
-- (아동 개인정보 '열람' 기록은 양이 전혀 다르고 child_id 를 담는다 —
--  그것은 이 표에 넣지 않는다. README 5.4 의 남은 과제로 두었다.)
--
-- [무엇을 적나 / 적지 않나]
--   적는다      누가(로그인 이름 — 실패는 입력한 이름), 언제, 성공·실패·잠김
--   적지 않는다 비밀번호·해시·초대코드(원칙 8), 접속 IP
--   before/after 는 비운다 — 로그인에는 '전후 값' 이 없다
--
-- [이 마이그레이션을 안 돌린 DB]
-- 앱은 기록 INSERT 실패를 삼키고 서버 로그만 남긴다(api/auth.ts).
-- 035 를 안 돌려도 로그인은 그대로 된다 — 기록만 안 남는다.
-- =============================================================

alter table public.audit_logs
  drop constraint if exists audit_logs_action_check;

alter table public.audit_logs
  add constraint audit_logs_action_check
  check (action in ('create', 'update', 'delete', 'login'));

comment on column public.audit_logs.action is
  'create / update / delete 는 기록 변경, login 은 로그인 성공·실패(035).';


-- =============================================================
-- 확인 (실행 후)
--
--   -- 1) 'login' 이 통과하는가
--   insert into public.audit_logs (actor, action, table_name, record_id, summary)
--   values ('(확인)', 'login', 'staff', null, '035 확인용');
--   → 성공해야 한다. 확인했으면 그 줄을 id 로 지운다(패턴으로 지우지 않는다).
--
--   -- 2) 엉뚱한 값은 여전히 막는가
--   insert into public.audit_logs (actor, action, table_name, record_id, summary)
--   values ('(확인)', 'view', 'staff', null, '막혀야 한다');
--   → 23514(check_violation) 로 실패해야 한다
-- =============================================================
