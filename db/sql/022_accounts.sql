-- =============================================================
-- OK-system 마이그레이션 022
-- 계정 — staff 에 로그인에 필요한 칸을 붙이고, 세션 표를 만든다.
--
-- 001~021 이 먼저 실행돼 있어야 합니다. 여러 번 실행해도 안전합니다.
--
-- [이 파일만으로는 아무것도 안 잠긴다]
-- 칸과 표만 더한다. 기존 명단 화면·봉사 스케줄·일지 작성자 연결은 그대로 돈다.
-- 새 칸은 전부 "계정 미설정" 상태로 붙는다 — 비밀번호도 초대코드도 없다.
-- 로그인은 1단계 코드가 붙은 뒤에야 생긴다.
--
-- [계정 상태를 두 값만 저장하는 이유]
-- 화면에는 미발급·대기·활성·정지 네 가지로 보이지만, 저장하는 것은 '활성'/'정지' 뿐이다.
-- 나머지는 이미 있는 값에서 나온다:
--
--   비번 없음 + 코드 없음  →  미발급 (명단에만 있는 사람)
--   비번 없음 + 코드 있음  →  대기   (코드는 나갔고 아직 안 정했다)
--   비번 있음              →  활성
--   account_status='정지'  →  정지   (위 무엇이든 이긴다)
--
-- 상태를 따로 저장하면 비번을 설정했는데 상태는 '대기'로 남는 어긋남이 생긴다.
-- account_status 는 "사람이 막았는가" 하나만 담는다.
--
-- [로그인이 되려면 네 가지가 모두 참이어야 한다]
--   1. staff.status = '활동중'   (퇴사·종료면 계정과 무관하게 거부)
--   2. account_status = '활성'
--   3. password_hash 가 있다
--   4. locked_until 이 지났거나 없다
-- =============================================================


-- =============================================================
-- 1. staff — 로그인에 필요한 칸
-- =============================================================

alter table public.staff
  -- 로그인에 쓰는 이름. 기본은 name 과 같다.
  -- 동명이인이 생기면 관리자가 여기만 "김지현(멘토)" 처럼 바꿔 푼다.
  -- name 은 화면에 나오는 이름이라 건드리지 않는다.
  add column if not exists login_name text,

  -- pbkdf2$<반복수>$<소금 b64>$<해시 b64>. null 이면 아직 비번을 안 정했다.
  add column if not exists password_hash text,
  add column if not exists password_set_at timestamptz,

  -- 초대코드도 해시로 둔다. 6자리라 평문이면 DB 를 한 번 보는 것으로 전부 털린다.
  -- 1회용 — 비번을 정하는 순간 null 이 된다. 재발급하면 새 해시가 들어가고 옛 코드는 그 자리에서 무효다.
  add column if not exists invite_code_hash text,
  add column if not exists invite_code_expires_at timestamptz,
  add column if not exists invite_code_issued_at timestamptz,
  add column if not exists invite_code_issued_by uuid references public.staff (id) on delete set null,

  -- 관리자 깃발. 직급과 무관하게 붙는다. 여럿이어도 된다.
  -- 관리자가 하나뿐이면 그 사람이 비번을 잊는 순간 아무도 계정을 못 만든다.
  add column if not exists is_admin boolean not null default false,

  -- 접속 권한. 직급·관리자 깃발과 직교하는 축이다.
  -- "생활복지사인데 모바일만" 같은 조합이 가능해야 축을 나눈 뜻이 산다.
  add column if not exists access_kind text not null default 'PC',

  -- 사람이 막았는가. 위 주석 참고 — 미발급·대기·활성은 여기 담지 않는다.
  add column if not exists account_status text not null default '활성',

  -- 초대코드 무차별 대입 막기. 6자리는 100만 가지뿐이라 시도 제한이 필수다.
  add column if not exists failed_attempts integer not null default 0,
  add column if not exists locked_until timestamptz,

  add column if not exists last_login_at timestamptz;

-- 값 제한. 컬럼을 먼저 다 붙인 뒤에 건다.
alter table public.staff
  drop constraint if exists staff_access_kind_check;
alter table public.staff
  add constraint staff_access_kind_check check (access_kind in ('PC', '모바일'));

alter table public.staff
  drop constraint if exists staff_account_status_check;
alter table public.staff
  add constraint staff_account_status_check check (account_status in ('활성', '정지'));

alter table public.staff
  drop constraint if exists staff_failed_attempts_check;
alter table public.staff
  add constraint staff_failed_attempts_check check (failed_attempts >= 0);

comment on column public.staff.login_name is
  '로그인에 쓰는 이름. 기본은 name 과 같다. 동명이인은 이 값만 바꿔 푼다.';
comment on column public.staff.password_hash is
  'pbkdf2$<반복수>$<소금 b64>$<해시 b64>. null 이면 아직 비번 미설정.';
comment on column public.staff.invite_code_hash is
  '초대코드 해시. 1회용 — 비번 설정 시 null 이 된다. 평문은 어디에도 남기지 않는다.';
comment on column public.staff.is_admin is
  '관리자 깃발. 직급과 무관. 여럿 가능.';
comment on column public.staff.access_kind is
  'PC(종사자 계정) / 모바일(봉사자 계정). 직급과 직교하는 축이다.';
comment on column public.staff.account_status is
  '사람이 막았는가만 담는다. 미발급·대기·활성은 password_hash·invite_code_hash 에서 나온다.';


-- =============================================================
-- 2. 기존 행 채우기
--
-- 지금 명단에 있는 사람들이 깨지지 않게 한다.
-- 비번도 코드도 안 넣는다 — 계정은 2단계 화면에서 사람이 발급한다.
-- =============================================================

-- login_name = name. 같은 이름이 있으면 뒤에 번호를 붙여 유일하게 만든다.
-- 코드가 사람을 고르면 안 되므로 등록 순서(created_at)를 그대로 따르고,
-- 관리자가 나중에 알아보기 좋은 이름으로 고친다.
with numbered as (
  select
    id,
    name,
    row_number() over (
      partition by lower(btrim(name))
      order by created_at, id
    ) as seq
  from public.staff
  where login_name is null
)
update public.staff s
   set login_name = case when n.seq = 1 then btrim(n.name)
                         else btrim(n.name) || ' (' || n.seq || ')'
                    end
  from numbered n
 where s.id = n.id;

-- 접속 권한을 직급으로 추정한다. 틀린 것은 2단계 계정 관리 화면에서 고친다.
-- 직급이 비어 있는 행은 기본값 'PC' 로 둔다 — 좁은 쪽이 아니라 넓은 쪽이지만,
-- 아직 아무것도 안 잠그므로 이 값으로 열리는 문은 없다.
update public.staff
   set access_kind = '모바일'
 where role in ('멘토', '봉사자');

update public.staff
   set access_kind = 'PC'
 where role in ('센터장', '생활복지사');

-- 유일 제약. 값을 다 채운 뒤에 건다.
-- 앞뒤 공백과 대소문자를 무시한다 — 로그인에서 찾는 기준과 같아야 한다.
create unique index if not exists idx_staff_login_name_unique
  on public.staff (lower(btrim(login_name)));

-- 초대코드로 계정을 찾는 일은 없다(이름으로 찾고 코드로 확인한다).
-- 대신 "대기 중인 계정" 을 세는 화면이 이 조건을 쓴다.
create index if not exists idx_staff_pending_invite
  on public.staff (invite_code_expires_at)
  where invite_code_hash is not null;


-- =============================================================
-- 3. sessions — 로그인한 기기 하나가 한 줄
--
-- JWT 를 쓰지 않는다. 정지시키면 그 자리에서 끊겨야 하는데,
-- JWT 는 만료 전까지 살아 있어서 결국 차단 목록을 따로 둬야 한다.
-- 표가 이미 있으니 표를 쓴다.
--
-- 토큰 원문은 쿠키에만 있다. 여기엔 SHA-256 만 둔다.
-- 토큰이 이미 32바이트 난수라 느린 해시(PBKDF2)가 필요 없다 —
-- 비밀번호와 달리 사람이 고른 값이 아니라 추측할 여지가 없다.
-- =============================================================

create table if not exists public.sessions (
  id           uuid        primary key default gen_random_uuid(),

  -- 사람을 지우면 세션도 함께 사라진다. 남아 있을 이유가 없다.
  staff_id     uuid        not null
                           references public.staff (id) on delete cascade,

  -- 쿠키에 든 토큰의 SHA-256(hex).
  token_hash   text        not null unique,

  -- 쉬는 시간(8시간)은 last_seen_at 으로, 절대 만료(30일)는 expires_at 으로 본다.
  -- 두 가지를 한 칸에 담으면 "요청할 때마다 30일씩 미뤄지는" 세션이 된다.
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at   timestamptz not null,

  -- 어느 기기에서 들어와 있는지. 계정 관리 화면에 적는다. 판단에는 쓰지 않는다.
  user_agent   text
);

create index if not exists idx_sessions_staff
  on public.sessions (staff_id);

-- 만료된 줄을 치울 때 쓴다
create index if not exists idx_sessions_expires
  on public.sessions (expires_at);

comment on table public.sessions is
  '세션: 로그인한 기기 하나가 한 줄. 토큰 원문은 쿠키에만, 여기엔 SHA-256 만.';
comment on column public.sessions.last_seen_at is
  '쉬는 시간 만료(8시간)를 재는 자리. 요청마다 민다.';
comment on column public.sessions.expires_at is
  '절대 만료(30일). 요청해도 안 밀린다.';


-- =============================================================
-- 4. 확인용 조회 (실행 후)
-- =============================================================

-- 열 명 전부 login_name 이 채워지고 서로 달라야 한다
select
  count(*)                                as 전체,
  count(login_name)                       as login_name_있음,
  count(distinct lower(btrim(login_name))) as 서로_다른_이름
from public.staff;

-- 직급에 맞게 추정됐는지
select role, access_kind, count(*) as 인원
from public.staff
group by role, access_kind
order by role;

-- 계정은 아직 아무도 없어야 한다 (전부 0)
select
  count(*) filter (where password_hash is not null)    as 비번_설정됨,
  count(*) filter (where invite_code_hash is not null) as 코드_대기중,
  count(*) filter (where is_admin)                     as 관리자
from public.staff;

select count(*) as 세션 from public.sessions;
