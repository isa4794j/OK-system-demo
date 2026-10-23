-- =============================================================
-- OK-system 마이그레이션 023
-- 봉사자 폰 화면이 쓸 두 표와 설정 두 줄.
--
-- 001~022 가 먼저 실행돼 있어야 합니다. 여러 번 실행해도 안전합니다.
--
-- [이 파일만으로는 아무것도 안 바뀐다]
-- 표와 설정만 더한다. 지금 화면은 이 표들을 아직 읽지도 쓰지도 않는다.
-- =============================================================


-- =============================================================
-- 1. half_observations — 반기 관찰
--
-- 봉사자·멘토가 반기마다 아이 하나하나를 두고 적는 것.
-- 종사자가 쓰는 yearly_evaluations(연간평가) 와 섞지 않는다 —
-- 쓰는 사람도 모양도 다르다. 그쪽은 영역별 서술문이고 이쪽은 점수 + 서술이다.
--
-- [사람마다 한 장]
-- 아동·반기당 한 장이 아니다. 멘토 둘이 같은 아이를 보면 두 장이 맞다.
-- 한 장을 여럿이 덮어쓰면 나중 사람만 남고 앞사람이 본 것은 조용히 사라진다.
--
-- [점수를 jsonb 로 두는 이유]
-- 항목 목록은 코드가 아니라 센터가 정하는 평가지표다. 컬럼으로 박아 두면
-- 항목 하나 바뀔 때마다 마이그레이션이고, 옛 기록은 사라진 항목의 빈 칸을
-- 계속 달고 다닌다. yearly_evaluations.content 가 이미 같은 이유로 jsonb 다.
-- 목록은 settings.half_observation_items 가 갖는다.
-- =============================================================

create table if not exists public.half_observations (
  id         uuid        primary key default gen_random_uuid(),

  -- 어느 아동인지. observations 와 같은 이유로 restrict —
  -- 사람이 쓴 기록이라 아동을 지운다고 조용히 함께 사라지면 안 된다.
  child_id   uuid        not null
                         references public.children_identity (id)
                         on update cascade
                         on delete restrict,

  year       integer     not null check (year between 2000 and 2100),

  -- 1 = 상반기(1~6월), 2 = 하반기(7~12월). observations 조회와 같은 기준.
  half       smallint    not null check (half in (1, 2)),

  -- 누가 봤는가. 관찰은 "그 사람이 본 것" 이라 익명이면 뜻이 반이다.
  -- 명단에서 사라져도 기록은 남는다 (journals.author_id 와 같은 판단).
  author_id  uuid        references public.staff (id)
                         on update cascade
                         on delete set null,

  -- 정량. {"h01": 4, "h02": 3}. 항목 목록은 settings 가 갖는다.
  scores     jsonb       not null default '{}'::jsonb,

  -- 서술. 점수만으로는 남지 않는 것을 적는 자리.
  note       text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 한 사람이 한 아이에 대해 한 반기에 한 장.
--
-- author_id 가 null 인 행(작성자가 명단에서 지워진 옛 기록)은 이 규칙에서 빠진다 —
-- Postgres 에서 null 은 서로 다른 값으로 본다. 그래도 문제가 없다:
-- 새로 쓰는 것은 늘 author_id 가 있고, null 이 된 옛 기록은 덮어쓸 일이 없다.
create unique index if not exists idx_half_obs_one_per_author
  on public.half_observations (child_id, year, half, author_id);

-- "이 반기에 내가 쓴 것" 을 여는 조회
create index if not exists idx_half_obs_author_period
  on public.half_observations (author_id, year, half);

-- 성장 추이가 아이 하나를 시간 축으로 읽는다
create index if not exists idx_half_obs_child_period
  on public.half_observations (child_id, year, half);

drop trigger if exists trg_half_obs_updated_at on public.half_observations;
create trigger trg_half_obs_updated_at
  before update on public.half_observations
  for each row execute function public.set_updated_at();

comment on table public.half_observations is
  '반기 관찰: 봉사자·멘토가 반기마다 아이별로 적는 점수 + 서술. 사람마다 한 장.';
comment on column public.half_observations.scores is
  '{"항목코드": 점수}. 항목 목록은 settings.half_observation_items 가 갖는다.';


-- =============================================================
-- 2. inquiries — 문의하기
--
-- 봉사자가 폰에서 불편한 점을 보내는 자리. 답장 기능은 없다 —
-- 주고받기 시작하면 메신저를 만들게 되고, 그건 이 시스템의 일이 아니다.
-- 종사자가 PC 에서 목록을 보고 [확인함] 을 누르는 것까지다.
-- =============================================================

create table if not exists public.inquiries (
  id         uuid        primary key default gen_random_uuid(),

  -- 누가 보냈는가. 사람이 명단에서 사라져도 문의는 남는다 —
  -- 아직 안 고친 불편이 사람과 함께 사라지면 안 된다.
  staff_id   uuid        references public.staff (id)
                         on update cascade
                         on delete set null,

  -- 보낸 시점의 이름. staff_id 가 null 이 되어도 누가 보냈는지 남는다.
  staff_name text,

  content    text        not null check (length(btrim(content)) > 0),

  -- 종사자가 봤는가. 답장이 아니라 "봤다" 표시일 뿐이다.
  seen_at    timestamptz,
  seen_by    uuid        references public.staff (id) on delete set null,

  created_at timestamptz not null default now()
);

-- 안 읽은 문의 수를 서브탭 뱃지에 띄운다 (미분류함과 같은 방식)
create index if not exists idx_inquiries_unseen
  on public.inquiries (created_at desc)
  where seen_at is null;

comment on table public.inquiries is
  '문의: 봉사자가 보낸 불편사항. 답장 없이 목록과 확인 표시만.';


-- =============================================================
-- 3. 설정 두 줄
--
-- 값이 없으면 코드가 기본값으로 도므로 이 줄이 없어도 안 깨진다.
-- 그래도 넣어 두는 이유: 설정 화면이 "지금 값" 을 보여 줄 수 있어야 한다.
-- on conflict do nothing 이라 이미 있으면 건드리지 않는다.
-- =============================================================

-- 반기 관찰 점수 항목. 빈 목록으로 시작한다 —
-- 항목이 정해지면 이 값 한 줄만 채우면 열린다. 배포도 마이그레이션도 필요 없다.
-- 그때까지 화면은 서술 칸만 보여 주고 "점수 항목은 준비 중" 이라고 적는다.
insert into public.settings (key, value)
values ('half_observation_items', '[]'::jsonb)
on conflict (key) do nothing;

-- 봉사일지를 서로 볼 수 있게 할지.
--   '본인'  자기가 쓴 것만 (기본값)
--   '전체'  다른 봉사자 일지도 읽기 가능
--
-- 기본을 '본인' 으로 둔다. 봉사일지 본문에는 아동 이름과 그날 있었던 일이 적힌다.
-- 열어 두는 편이 인수인계에는 낫지만, 좁은 쪽에서 시작해 필요하면 여는 것이
-- 반대보다 안전하다. PC 설정 화면에서 사람이 바꾼다.
insert into public.settings (key, value)
values ('volunteer_journal_scope', '"본인"'::jsonb)
on conflict (key) do nothing;


-- =============================================================
-- 4. 확인용 조회 (실행 후)
-- =============================================================
select
  (select count(*) from public.half_observations) as 반기관찰,
  (select count(*) from public.inquiries)         as 문의;

select key, value
from public.settings
where key in ('half_observation_items', 'volunteer_journal_scope')
order by key;
