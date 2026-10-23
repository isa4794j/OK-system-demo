-- =============================================================
-- OK-system 마이그레이션 011
-- 자원기록: 일지에서 뽑아낸 자원 활용
--
-- 실행 순서: 위에서 아래로 통째로 실행하면 됩니다.
-- 010(resources)과 002(journals)가 먼저 있어야 합니다.
--
-- [왜 자원사전(resources)과 다른 표인가]
-- resources 는 "센터가 무엇을 가지고 있는가"다. 한 물건에 한 줄.
-- resource_records 는 "언제 무엇을 썼는가"다. 쓸 때마다 한 줄.
-- 둘을 한 표에 담으면 젠가가 스무 줄이 되어 보유목록 구실을 못 한다.
--
-- [왜 이름을 문자열로 담는가 — resources 를 외래키로 걸지 않는 이유]
-- 뽑힌 시점에는 사전에 없는 자원일 수 있다. 그때 저장이 막히면 뽑은 것을 버려야 한다.
-- 그리고 확정된 기록은 그 시점에 그렇게 불렸다는 사실이다.
-- 나중에 사전에서 그 자원을 지우거나 이름을 바꿔도 기록은 그대로 남아야 한다.
-- 사전과 이어 보는 일은 병합(자-4)에서 이름으로 맞춘다.
-- =============================================================


-- =============================================================
-- 0. 공통: updated_at 자동 갱신 함수
--    앞선 마이그레이션에서 이미 만들었지만, 011만 따로 실행하는 경우를 위해 다시 둔다.
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
-- 1. resource_records  [자원기록] 일지에서 뽑은 자원 활용
-- =============================================================
create table if not exists public.resource_records (
  id             uuid        primary key default gen_random_uuid(),

  -- 그 자원을 쓴 날. 뽑아 온 일지의 날짜다(뽑은 날이 아니다).
  record_date    date        not null,

  -- 자원명. 사전에 있으면 사전의 정식 이름, 없으면 일지에 적힌 대로.
  resource_name  text        not null check (length(btrim(resource_name)) > 0),

  -- 카테고리. 사전에 있으면 사전 값, 없으면 AI 추측.
  -- 확신이 없으면 비운다. 사람이 검토할 때 고른다.
  category       text,

  -- 출처. journals.kind 와 같은 목록이다.
  -- journal_id 가 있는데도 따로 두는 이유: 일지를 지워도 통계는 남아야 하고,
  -- 그때 "어느 종류의 활동이었는가"는 통계에서 계속 쓰인다.
  source         text        check (source in ('프로그램', '일상', '회의록', '봉사')),

  -- 어느 일지에서 나왔는가.
  --
  -- [삭제 동작: on delete set null]
  --   확정된 기록(status='Y')은 사람이 검토해 남긴 사실이라 일지가 사라져도 남아야 한다.
  --   observations.source_journal_id 와 같은 판단이다.
  --
  --   다만 검토 대기(status='N')는 다르다. 검토는 일지 본문을 읽어야 할 수 있는 일이라,
  --   일지가 없으면 판단할 수가 없다. 그런 줄은 화면에도 안 나타나 영영 남는다.
  --   그래서 일지를 지울 때 그 일지의 'N' 줄은 앱이 먼저 지운다(db/journals.ts 참고).
  --   한 외래키에 두 가지 동작을 걸 수 없어 나눠 처리한다.
  journal_id     uuid        references public.journals (id)
                             on update cascade
                             on delete set null,

  -- 검토 상태.
  --   N    뽑히기만 했고 아직 사람이 안 봤다
  --   Y    사람이 확정했다 — 통계(자-3)는 이것만 센다
  --   없음 사람이 "자원이 아니다"라고 판단했다
  --
  -- '없음'을 지우지 않고 남기는 이유: 다시 뽑을 때 같은 것이 또 올라오면
  -- 같은 판단을 반복해야 한다. 남겨 두면 두 번 묻지 않는다.
  status         text        not null default 'N'
                             check (status in ('N', 'Y', '없음')),

  -- 뽑은 시각. created_at 과 거의 같지만, 나중에 다시 뽑으면 갱신된다.
  extracted_at   timestamptz not null default now(),

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- 한 일지에서 같은 자원이 두 줄이 되지 않게 한다.
--
-- 일지 하나에 젠가가 세 번 나와도 "그 날 젠가를 썼다"는 한 번이다.
-- journal_id 가 비면(일지가 지워지면) 이 규칙은 적용되지 않는다.
-- 그때는 이미 확정된 기록이라 서로 다른 사실로 봐야 한다.
create unique index if not exists idx_resource_records_journal_name
  on public.resource_records (journal_id, resource_name)
  where journal_id is not null;

-- 검토 대기함을 여는 조회 (자-4에서 쓴다)
create index if not exists idx_resource_records_status
  on public.resource_records (status);

-- 통계는 기간별로 확정된 것만 센다 (자-3)
create index if not exists idx_resource_records_date
  on public.resource_records (record_date desc)
  where status = 'Y';

drop trigger if exists trg_resource_records_updated_at on public.resource_records;
create trigger trg_resource_records_updated_at
  before update on public.resource_records
  for each row execute function public.set_updated_at();

comment on table public.resource_records is
  '자원기록: 일지에서 뽑은 자원 활용. 통계는 status=Y 인 것만 센다.';
comment on column public.resource_records.status is
  'N=검토 대기, Y=확정, 없음=자원이 아님. 없음도 지우지 않고 남겨 같은 판단을 두 번 묻지 않는다.';
comment on column public.resource_records.resource_name is
  'resources 를 외래키로 걸지 않는다. 뽑힌 시점에 사전에 없을 수 있고, 확정된 기록은 그때 그렇게 불렸다는 사실이다.';


-- =============================================================
-- 2. RLS (행 수준 보안) — 지금은 켜지 않는다
--
-- 앞선 마이그레이션과 같은 이유다. 접근 경로는 Deno 서버의 service_role 키
-- 하나뿐이고, service_role 은 RLS 를 우회하므로 지금 정책을 짜도 검증할 수 없다.
-- 로그인을 설계할 때 전체 표를 한꺼번에 켠다.
--
-- anon 권한은 009_lock_anon_access.sql 의 alter default privileges 가 이미 막고 있다.
-- 확인은 008_check_anon_access.sql 로 한다. 이 표도 "(없음 — 막혀 있음)" 이어야 한다.
-- =============================================================
