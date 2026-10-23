-- =============================================================
-- OK-system 마이그레이션 029
-- 겸직(한 사람이 여러 역할) — 역할 목록 · 기록마다 "어느 역할로" · 세션의 지금 역할
--
-- 001~028 이 먼저 실행돼 있어야 합니다. 여러 번 실행해도 안전합니다.
--
-- [왜]
-- 봉사자이면서 멘토인 사람이 있다. 지금은 staff.role 한 칸이라 둘 중 하나만 적힌다.
-- 또 일정·일지·문의는 역할을 따로 적지 않고 "그 사람의 지금 역할" 을 그때그때 읽는다 —
-- 역할이 바뀌면 지난 기록의 역할 표시도 따라 바뀐다.
--
-- [설계]
--   staff.roles      역할 목록(배열). 역할은 네 가지로 고정이고 역할마다 붙는 속성이 없어서
--                    따로 표를 만들지 않는다. 명단 거르기는 배열 겹침(&&)으로 한다.
--                    staff.role 은 당분간 남긴다(호환). 앱은 roles 를 읽고, role 에는 대표 역할을 함께 쓴다.
--   *.as_role        그 기록이 어느 역할 활동인지 — 기록할 때 박아 둔다. 역할을 바꿔도 지난 기록은 그대로다.
--                    일정·일지·문의에 둔다. 반기 관찰은 사람 기준(역할 무관 한 장)이라 두지 않는다.
--   sessions.active_role  겸직자가 이 기기에서 지금 어떤 역할로 활동 중인지. 역할이 하나면 비워 둔다.
--
-- [소급]
-- 지금은 겸직자가 없다 — 모든 기록을 작성자의 현재 역할로 채워도 틀리지 않는다.
-- =============================================================


-- =============================================================
-- 1. staff.roles
-- =============================================================

alter table public.staff
  add column if not exists roles text[];

update public.staff
set roles = case when role is null then '{}'::text[] else array[role] end
where roles is null;

alter table public.staff
  alter column roles set default '{}'::text[],
  alter column roles set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'staff_roles_check') then
    alter table public.staff
      add constraint staff_roles_check
      check (roles <@ array['멘토', '봉사자', '센터장', '생활복지사']::text[]);
  end if;
end $$;

create index if not exists idx_staff_roles on public.staff using gin (roles);

comment on column public.staff.roles is
  '역할 목록(겸직). 앱은 이 칸을 읽는다. role 은 호환용 대표 역할.';


-- =============================================================
-- 2. 기록마다 as_role
-- =============================================================

alter table public.schedules
  add column if not exists as_role text
  check (as_role in ('멘토', '봉사자', '센터장', '생활복지사'));

alter table public.journals
  add column if not exists as_role text
  check (as_role in ('멘토', '봉사자', '센터장', '생활복지사'));

alter table public.inquiries
  add column if not exists as_role text
  check (as_role in ('멘토', '봉사자', '센터장', '생활복지사'));

comment on column public.schedules.as_role is '이 일정이 어느 역할 활동인지. 기록할 때 박아 둔다.';
comment on column public.journals.as_role is '이 일지가 어느 역할로 쓴 것인지. 봉사일지는 매인 일정의 역할.';
comment on column public.inquiries.as_role is '보낼 때의 역할.';

-- 소급: 작성자의 현재 역할(겸직자가 없으므로 안전)
update public.schedules s
set as_role = st.role
from public.staff st
where st.id = s.staff_id and s.as_role is null and st.role is not null;

-- 봉사일지는 매인 일정의 역할이 기준이다
update public.journals j
set as_role = s.as_role
from public.schedules s
where s.id = j.schedule_id and j.as_role is null and s.as_role is not null;

update public.journals j
set as_role = st.role
from public.staff st
where st.id = j.author_id and j.as_role is null and st.role is not null;

update public.inquiries i
set as_role = st.role
from public.staff st
where st.id = i.staff_id and i.as_role is null and st.role is not null;


-- =============================================================
-- 3. sessions.active_role
-- =============================================================

alter table public.sessions
  add column if not exists active_role text
  check (active_role in ('멘토', '봉사자', '센터장', '생활복지사'));

comment on column public.sessions.active_role is
  '겸직자가 이 기기에서 지금 활동 중인 역할. 역할이 하나면 비워 둔다.';


-- =============================================================
-- 확인 (실행 후)
--
--   select count(*) filter (where roles = '{}') as 역할없음,
--          count(*) filter (where cardinality(roles) = 1) as 한역할,
--          count(*) filter (where role is not null and not (role = any(roles))) as 어긋남
--   from public.staff;
--   → 어긋남 0
--
--   select 'schedules' as 표, count(*) filter (where as_role is null) as 빈칸 from public.schedules
--   union all select 'journals', count(*) filter (where as_role is null) from public.journals
--   union all select 'inquiries', count(*) filter (where as_role is null) from public.inquiries;
--   → schedules 0 (작성자가 지워진 일지·문의는 빈칸일 수 있다)
-- =============================================================
