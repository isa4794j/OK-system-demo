-- =============================================================
-- OK-system 마이그레이션 005
-- 반기별 연간평가: yearly_evaluations
--
-- 001~004 가 먼저 실행돼 있어야 합니다.
-- 여러 번 실행해도 안전합니다.
-- =============================================================


-- =============================================================
-- 0. updated_at 자동 갱신 함수 (001·002에서 만든 것과 같다)
-- =============================================================
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;


-- =============================================================
-- 1. yearly_evaluations  [개인] 반기 평가
--
-- 사람이 검토하고 저장한 기록이다. AI 초안은 저장하기 전 화면에만 있고,
-- 사람이 손대고 저장을 눌러야 이 표에 들어온다.
-- =============================================================
create table if not exists public.yearly_evaluations (
  id         uuid        primary key default gen_random_uuid(),

  -- 어느 아동의 평가인지.
  -- observations 와 같은 이유로 restrict 다. 사람이 쓴 기록이라
  -- 아동을 지운다고 조용히 함께 사라지면 안 된다.
  child_id   uuid        not null
                         references public.children_identity (id)
                         on update cascade
                         on delete restrict,

  year       integer     not null check (year between 2000 and 2100),

  -- 1 = 상반기(1~6월), 2 = 하반기(7~12월). observations 조회와 같은 기준.
  half       smallint    not null check (half in (1, 2)),

  -- 영역별 서술문을 {"영역": "서술문"} 모양으로 담는다.
  --
  -- 영역마다 컬럼을 만들지 않은 이유:
  -- 영역 목록은 평가지표에 따라 바뀔 수 있다. 컬럼으로 박아 두면
  -- 영역이 하나 바뀔 때마다 마이그레이션을 해야 하고, 예전 평가는
  -- 사라진 영역의 빈 컬럼을 계속 달고 다니게 된다.
  content    jsonb       not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- 한 아동의 한 반기에 평가는 하나뿐이다.
  -- 저장은 이 조합을 기준으로 덮어쓴다(upsert).
  constraint yearly_evaluations_child_period_key unique (child_id, year, half)
);

-- "이 아동의 평가들" 조회용. unique 인덱스가 child_id로 시작하므로
-- 따로 인덱스를 더 만들 필요는 없다.

drop trigger if exists trg_yearly_evaluations_updated_at on public.yearly_evaluations;
create trigger trg_yearly_evaluations_updated_at
  before update on public.yearly_evaluations
  for each row execute function public.set_updated_at();

comment on table public.yearly_evaluations is
  '반기 평가. 사람이 검토하고 저장한 기록. AI 초안은 저장 전에는 여기 없다.';
comment on column public.yearly_evaluations.content is
  '{"영역": "서술문"} 형태. 영역 목록이 바뀔 수 있어 고정 컬럼 대신 jsonb로 둔다.';
comment on column public.yearly_evaluations.half is
  '1 = 상반기(1~6월), 2 = 하반기(7~12월).';


-- =============================================================
-- 2. RLS (행 수준 보안) — 지금은 켜지 않는다
--
-- 001~003과 같은 이유다. 접근 경로가 Deno 서버의 service_role 키 하나뿐이고,
-- service_role은 RLS를 우회하므로 지금 정책을 짜도 동작을 검증할 수 없다.
-- 로그인을 설계할 때 여섯 테이블을 한꺼번에 켠다.
--
--   alter table public.yearly_evaluations enable row level security;
-- =============================================================


-- =============================================================
-- 3. (선택) anon / authenticated 역할의 접근 차단
--
-- 앞선 마이그레이션에서 이 두 줄을 실행하셨다면 여기서도 함께 해두세요.
-- 안 하면 새 테이블만 anon 키로 열려 있게 됩니다.
-- 실행하려면 앞의 -- 를 지우세요.
--
-- revoke all on public.yearly_evaluations from anon, authenticated;
-- =============================================================


-- =============================================================
-- 4. 확인용 조회 (실행 후 결과 확인)
-- =============================================================
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'yearly_evaluations'
order by ordinal_position;
