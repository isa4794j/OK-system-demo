-- =============================================================
-- OK-system 마이그레이션 010
-- 자원 축의 첫 표: settings, resources
--
-- 실행 순서: 위에서 아래로 통째로 실행하면 됩니다.
--   1) settings   (카테고리 목록을 여기 담는다)
--   2) resources  (자원사전 = 센터 보유목록)
-- 여러 번 실행해도 안전하도록 if not exists / on conflict 를 썼습니다.
--
-- 001~007과 같은 규칙을 따릅니다.
--   - 기본키는 uuid
--   - updated_at은 트리거로 DB가 보장한다
--   - RLS는 로그인 설계 때 정책과 함께 켠다
--
-- [자원은 사람과 무관한 일반정보다]
-- 아동 신원(children_identity)이나 직원(staff)과 이어지지 않는다.
-- "누가 무엇을 썼는가"는 나중에 관찰·일지 쪽에서 잇는다.
-- 이 표 자체는 센터가 무엇을 가지고 있는지만 적는다.
-- =============================================================


-- =============================================================
-- 0. 공통: updated_at 자동 갱신 함수
--    앞선 마이그레이션에서 이미 만들었지만, 010만 따로 실행하는 경우를 위해 다시 둔다.
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
-- 1. settings  [설정] 이름-값 한 쌍
--
--    카테고리처럼 "코드가 아니라 센터가 정하는 목록"을 담는다.
--    코드에 박아 두면 카테고리 하나 바꾸는 데 배포가 필요하다.
--
--    값은 jsonb 다. 목록도 되고 숫자 하나도 되고 객체도 된다.
--    설정마다 표를 만들지 않으려고 한 칸에 담는다.
-- =============================================================
create table if not exists public.settings (
  -- 설정 이름. 예: 'resource_categories'
  -- uuid 를 두지 않는다. 이름 자체가 유일하고, 코드가 이름으로 찾기 때문이다.
  key         text        primary key check (length(btrim(key)) > 0),

  -- 설정 값. 모양은 설정마다 다르므로 DB로 강제하지 않는다.
  -- 어떤 모양이어야 하는지는 읽는 코드(/db)가 안다.
  value       jsonb       not null,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

drop trigger if exists trg_settings_updated_at on public.settings;
create trigger trg_settings_updated_at
  before update on public.settings
  for each row execute function public.set_updated_at();

comment on table public.settings is
  '설정: 코드가 아니라 센터가 정하는 값. 값의 모양은 설정마다 다르다.';

-- 자원 카테고리 기본값.
-- 도서는 도서관 모듈이 따로 맡으므로 여기 넣지 않는다.
--
-- on conflict do nothing 이라 이미 있으면 건드리지 않는다.
-- 센터가 고쳐 둔 목록을 마이그레이션 재실행이 되돌리면 안 된다.
insert into public.settings (key, value)
values (
  'resource_categories',
  '["기기", "보드게임", "예술", "체육", "기타"]'::jsonb
)
on conflict (key) do nothing;


-- =============================================================
-- 2. resources  [자원사전] 센터가 가진 것들
-- =============================================================
create table if not exists public.resources (
  id          uuid        primary key default gen_random_uuid(),

  -- 자원명. 필수이며 공백만 들어가는 것도 막는다.
  name        text        not null check (length(btrim(name)) > 0),

  -- 카테고리. settings 의 'resource_categories' 중 하나를 문자열로 담는다.
  --
  -- 외래키로 묶지 않는다. 카테고리는 표가 아니라 설정이고,
  -- 나중에 일지에서 자원을 뽑을 때(자-2) 목록에 없는 이름이 먼저 들어올 수 있다.
  -- 그때 저장 자체가 막히면 뽑은 것을 버려야 한다.
  -- 목록에 없는 카테고리는 화면이 따로 모아 보여준다.
  category    text,

  -- 별칭. 쉼표로 구분한 한 줄. 예: "젠가, 나무탑, 탑쌓기"
  --
  -- 표를 따로 만들지 않는다. 별칭은 자원에 딸린 표기일 뿐이고,
  -- 별칭만으로 찾을 일이 없다. 자원을 찾은 뒤 읽는 값이다.
  -- 일지에서 자원을 뽑을 때(자-2) 이름과 함께 맞춰 보는 데 쓴다.
  aliases     text,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- 같은 이름을 두 번 담지 않는다.
--
-- 자원사전은 "센터가 가진 것 한 줄에 하나"다. 같은 이름이 두 줄이면
-- 나중에 통계(자-3)에서 사용 횟수가 갈라진다.
-- 앞뒤 공백과 대소문자를 무시하고 본다. "젠가 "와 "젠가"는 같은 것이다.
--
-- 너무 빡빡하면(예: 같은 이름을 카테고리별로 두고 싶어지면) 이 줄만 지우면 된다.
--   drop index if exists public.idx_resources_name_unique;
create unique index if not exists idx_resources_name_unique
  on public.resources (lower(btrim(name)));

-- 카테고리별로 묶어 보여주는 것이 기본 화면이다
create index if not exists idx_resources_category
  on public.resources (category);

drop trigger if exists trg_resources_updated_at on public.resources;
create trigger trg_resources_updated_at
  before update on public.resources
  for each row execute function public.set_updated_at();

comment on table public.resources is
  '자원사전: 센터 보유목록. 사람과 무관한 일반정보라 아동·직원 표와 잇지 않는다.';
comment on column public.resources.category is
  'settings 의 resource_categories 중 하나. 외래키로 묶지 않는다 — 목록에 없는 값도 들어올 수 있다.';
comment on column public.resources.aliases is
  '쉼표로 구분한 별칭 한 줄. 일지에서 자원을 뽑을 때 이름과 함께 맞춰 본다.';


-- =============================================================
-- 3. RLS (행 수준 보안) — 지금은 켜지 않는다
--
-- 앞선 마이그레이션과 같은 이유다. 접근 경로는 Deno 서버의 service_role 키
-- 하나뿐이고, service_role 은 RLS 를 우회하므로 지금 정책을 짜도 검증할 수 없다.
-- 로그인(직원 계정 / 역할 구분)을 설계할 때 전체 표를 한꺼번에 켠다.
--
-- 다만 anon 권한 회수는 새 표에도 적용되어야 한다.
-- 009_lock_anon_access.sql 의 alter default privileges 두 줄이 이미 돌았다면
-- 이 두 표에도 anon 권한이 붙지 않는다.
-- 확인은 008_check_anon_access.sql 로 한다. 두 표가 "(없음 — 막혀 있음)" 이어야 한다.
-- =============================================================
