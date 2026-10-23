-- =============================================================
-- OK-system 마이그레이션 006
-- 가져온 관찰의 "근거가 바뀌었는지" 를 알 수 있게 한다.
--
-- 001~005 가 먼저 실행돼 있어야 합니다. 여러 번 실행해도 안전합니다.
--
-- [지금 무엇이 문제인가]
-- 가져온 관찰은 source_journal_obs_id 로 후보를 가리키고,
-- 후보는 journal_id 로 일지를 가리킨다.
-- 그런데 observations -> journal_observations 외래키가 restrict 라,
-- 가져간 후보가 하나라도 있으면 그 일지는 아예 지울 수 없다.
-- (실제로 시도해 보면 23503 으로 막힌다)
-- 지울 수 없으니 "근거 일지가 삭제됨" 이라는 상태도 생길 수 없다.
--
-- [어떻게 바꾸나]
-- 1. 외래키를 set null 로 바꿔 일지를 지울 수 있게 한다.
-- 2. 대신 일지 id 와 그때의 수정시각을 관찰 행에 따로 적어 둔다.
--    이 두 컬럼에는 외래키를 걸지 않는다. 일지가 사라져도 남아야 하기 때문이다.
--    "가리키던 것이 사라졌다" 는 사실 자체가 알려야 할 정보다.
-- =============================================================


-- =============================================================
-- 1. 근거 추적용 컬럼 두 개
-- =============================================================

-- 어느 일지에서 왔는지. 외래키를 걸지 않는다(일지가 지워져도 남아야 한다).
alter table public.observations
  add column if not exists source_journal_id uuid;

-- 가져올 당시 그 일지의 수정시각. 지금 값과 비교해 "수정됨" 을 가려낸다.
--
-- 내용을 통째로 복사해 두고 비교하는 방법도 있지만 그러지 않았다.
-- 관찰 표에 일지 본문이 통째로 들어가면 개인정보가 한 곳에 더 늘어나고,
-- 표도 무거워진다. 바뀌었는지만 알면 되므로 시각 하나로 충분하다.
-- journals 에는 updated_at 트리거가 걸려 있어 값이 저절로 최신이 된다.
alter table public.observations
  add column if not exists source_journal_updated_at timestamptz;

comment on column public.observations.source_journal_id is
  '가져온 원본 일지의 id. 외래키를 걸지 않는다. 일지가 지워져도 남아야 삭제를 알 수 있다.';
comment on column public.observations.source_journal_updated_at is
  '가져올 당시 원본 일지의 updated_at. 지금 값과 다르면 근거가 수정된 것이다.';


-- =============================================================
-- 2. 외래키를 restrict -> set null 로
--
-- 일지를 지우면 그 일지의 후보가 함께 지워지고(journal_observations 는 cascade),
-- 가져온 관찰은 남되 이 연결만 끊긴다.
-- 사람이 확인한 기록을 일지 삭제로 함께 잃으면 안 되기 때문이다.
-- 연결이 끊겨도 위 1번의 두 컬럼이 남아 무엇이 사라졌는지 알 수 있다.
-- =============================================================
do $$
begin
  if exists (
    select 1 from information_schema.table_constraints
    where table_schema = 'public'
      and table_name = 'observations'
      and constraint_name = 'observations_source_journal_obs_fkey'
  ) then
    alter table public.observations
      drop constraint observations_source_journal_obs_fkey;
  end if;

  alter table public.observations
    add constraint observations_source_journal_obs_fkey
    foreign key (source_journal_obs_id)
    references public.journal_observations (id)
    on update cascade
    on delete set null;
end $$;


-- =============================================================
-- 3. 이미 가져온 관찰 채우기
--
-- 지금 있는 값으로 채운다. 가져올 당시의 수정시각은 알 수 없으므로
-- 현재 값을 넣는다. 그래서 기존 것들은 "수정됨" 으로 뜨지 않는다.
-- 없는 사실을 지어내는 것보다 낫다.
-- =============================================================
update public.observations o
set source_journal_id = jo.journal_id,
    source_journal_updated_at = j.updated_at
from public.journal_observations jo
join public.journals j on j.id = jo.journal_id
where o.source_journal_obs_id = jo.id
  and o.source_journal_id is null;


-- =============================================================
-- 4. RLS — 001~005 와 같이 지금은 켜지 않는다. 새 테이블도 없다.
-- =============================================================


-- =============================================================
-- 5. 확인용 조회 (실행 후 결과 확인)
-- =============================================================
select
  id,
  source_journal_obs_id is not null as 후보연결,
  source_journal_id is not null     as 일지기록,
  source_journal_updated_at
from public.observations
where source_journal_id is not null
order by obs_date;
