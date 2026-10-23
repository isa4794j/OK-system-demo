-- =============================================================
-- OK-system 마이그레이션 019
-- 자원은 확정을 기다리지 않고 바로 반영한다.
--
-- 001~018 이 먼저 실행돼 있어야 합니다. 여러 번 실행해도 안전합니다.
--
-- [무엇이 바뀌나]
-- 지금까지 뽑힌 자원은 'N'(검토 대기)으로 들어가 사람이 [확정]을 눌러야 통계에 잡혔다.
-- 그런데 대부분은 눌러 주기만 하는 일이었고, 안 누르면 통계가 조용히 비었다.
-- 이제 뽑히면 바로 잡힌다. 사람은 틀린 것만 나중에 고친다.
--
--   Y      통계에 잡힌다. 카테고리가 비어 있으면 "카테고리 미정"으로 모인다.
--   없음   자원이 아니라고 판단한 것. 통계에서 빠진다.
--   N      이제 쓰지 않는다. 남아 있던 것은 아래에서 Y 로 옮긴다.
--
-- 카테고리를 못 정한 것은 Y + 카테고리 NULL 로 둔다.
-- 존재는 통계에 잡히고("카테고리 미정"), 미분류함에서 사람이 나중에 채운다.
-- =============================================================


-- =============================================================
-- 1. 자원사전에 "자동 등록" 표시
--
-- AI 추측으로 들어온 것과 사람이 손수 넣은 것을 가릴 수 있어야 한다.
-- 사람이 카테고리를 한 번이라도 만지면 코드가 이 값을 false 로 되돌린다.
-- =============================================================
alter table public.resources
  add column if not exists auto_added boolean not null default false;

comment on column public.resources.auto_added is
  'AI 추측으로 자동 등록된 자원. 사람이 카테고리를 고치면 false 가 된다.';

-- 자동 등록분만 모아 훑는 화면이 쓴다
create index if not exists idx_resources_auto_added
  on public.resources (auto_added)
  where auto_added;


-- =============================================================
-- 2. 검토 대기(N) 를 반영 상태로 옮긴다
--
-- 카테고리가 있든 없든 Y 로 옮긴다.
-- 카테고리가 있는 것은 곧바로 그 묶음에 잡히고,
-- 비어 있는 것은 "카테고리 미정"으로 잡히며 미분류함에 그대로 남는다.
-- 사람이 이미 "자원 아님"이라고 한 것(없음)은 건드리지 않는다.
-- =============================================================
update public.resource_records
set status = 'Y'
where status = 'N';


-- =============================================================
-- 3. 확인용 조회 (실행 후 결과 확인)
--
-- 앞뒤 숫자가 맞는지 보려면 실행 전에 아래를 먼저 돌려 적어 두세요.
--   select status, count(*) from public.resource_records group by status;
-- =============================================================
select status, count(*) as 건수
from public.resource_records
group by status
order by status;

select
  count(*) filter (where category is null) as 카테고리_미정,
  count(*) filter (where category is not null) as 카테고리_있음
from public.resource_records
where status = 'Y';

select count(*) filter (where auto_added) as 자동등록, count(*) as 전체
from public.resources;
