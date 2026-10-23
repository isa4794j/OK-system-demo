-- =============================================================
-- OK-system 마이그레이션 007
-- 멘토·봉사자 스케줄: schedules
--
-- 001~006 이 먼저 실행돼 있어야 합니다. 여러 번 실행해도 안전합니다.
-- =============================================================


-- =============================================================
-- 1. schedules  [명단] 누가 언제 오는지
-- =============================================================
create table if not exists public.schedules (
  id         uuid        primary key default gen_random_uuid(),

  -- 누가 오는지.
  --
  -- [삭제 동작: on delete cascade]
  --   일정은 "앞으로 올 사람"에 대한 계획이지 기록이 아니다.
  --   사람이 명단에서 사라지면 그 사람의 일정도 의미가 없다.
  --   journals.author_id 를 set null 로 둔 것과 기준이 다르다.
  --     - 일지는 누가 썼는지 몰라도 내용이 남는다   -> 살린다
  --     - 일정은 누구의 일정인지 모르면 아무것도 아니다 -> 따라 지운다
  --   (앱에서 직원 삭제는 아직 열지 않았다. 그만두면 status 를 '종료'로 바꾼다)
  staff_id   uuid        not null
                         references public.staff (id)
                         on update cascade
                         on delete cascade,

  sched_date date        not null,

  -- 시작·종료 시각. 자정을 넘기는 봉사는 없다고 보고 단순하게 둔다.
  start_time time        not null,
  end_time   time        not null,

  created_at timestamptz not null default now(),

  constraint schedules_end_after_start check (end_time > start_time),

  -- 같은 사람을 같은 날 같은 시각에 두 번 넣지 못하게 한다.
  -- 여러 날을 한 번에 등록하다 보면 이미 넣은 날이 섞이기 쉽다.
  -- 코드에서도 미리 걸러 내지만, 마지막은 DB가 막는다.
  constraint schedules_no_duplicate unique (staff_id, sched_date, start_time)
);

-- 달력은 늘 "이 달의 일정 전부"를 읽는다
create index if not exists idx_schedules_date
  on public.schedules (sched_date);

-- "이 사람의 일정" 조회용
create index if not exists idx_schedules_staff
  on public.schedules (staff_id);

comment on table public.schedules is
  '멘토·봉사자가 언제 오는지. 기록이 아니라 계획이라, 사람이 지워지면 함께 지워진다.';
comment on column public.schedules.start_time is
  '시작 시각. 자정을 넘기는 일정은 다루지 않는다.';


-- =============================================================
-- 2. RLS (행 수준 보안) — 지금은 켜지 않는다
--
-- 001~006 과 같은 이유다. 접근 경로가 Deno 서버의 service_role 키 하나뿐이고,
-- service_role 은 RLS 를 우회하므로 지금 정책을 짜도 동작을 검증할 수 없다.
-- 로그인을 설계할 때 일곱 테이블을 한꺼번에 켠다.
--
--   alter table public.schedules enable row level security;
-- =============================================================


-- =============================================================
-- 3. (선택) anon / authenticated 역할의 접근 차단
--
-- 앞선 마이그레이션에서 이 두 줄을 실행하셨다면 여기서도 함께 해두세요.
-- 안 하면 새 테이블만 anon 키로 열려 있게 됩니다.
-- 실행하려면 앞의 -- 를 지우세요.
--
-- revoke all on public.schedules from anon, authenticated;
-- =============================================================


-- =============================================================
-- 4. 확인용 조회 (실행 후 결과 확인)
-- =============================================================
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'schedules'
order by ordinal_position;
