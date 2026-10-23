-- =============================================================
-- OK-system 마이그레이션 004
-- 가져온 관찰이 "어느 후보에서 왔는지" 기록한다.
--
-- 001~003 이 먼저 실행돼 있어야 합니다.
-- 여러 번 실행해도 안전하도록 상태를 보고 건너뜁니다.
--
-- [왜 새 컬럼을 만들지 않았나]
-- 001에서 observations.source_summary_id 를 "나중에 요약에서 관찰을 가져올 때
-- 추적용" 이라며 비워 뒀다. 지금 하려는 일이 정확히 그 일이다.
-- 다만 실제로 가리키는 것은 요약이 아니라 journal_observations 의 한 행이라
-- 이름을 바꾼다. 값이 하나도 들어 있지 않아 지금이 바꿀 수 있는 마지막 때다.
-- 새 컬럼을 더하면 영영 안 쓰는 컬럼이 하나 남는다.
-- =============================================================


-- =============================================================
-- 1. source_summary_id -> source_journal_obs_id 이름 변경
-- =============================================================
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'observations'
      and column_name = 'source_summary_id'
  ) then
    alter table public.observations
      rename column source_summary_id to source_journal_obs_id;
  end if;
end $$;


-- =============================================================
-- 2. journal_observations 를 가리키는 외래키
--
-- [삭제 동작: on delete restrict]
--   가져온 관찰(observations)은 사람이 확인한 기록이다.
--   후보가 지워졌다고 그 기록의 출처가 조용히 NULL 이 되면 안 된다.
--   set null 로 두면 일지를 다시 분석할 때마다 이미 가져온 것들의
--   연결이 끊기고, 같은 내용을 또 가져올 수 있게 된다.
--   그래서 "가져간 후보는 지울 수 없다" 로 막는다.
--   대신 다시 분석할 때는 가져가지 않은 후보만 지운다(코드 쪽에서 처리).
-- =============================================================
do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where table_schema = 'public'
      and table_name = 'observations'
      and constraint_name = 'observations_source_journal_obs_fkey'
  ) then
    alter table public.observations
      add constraint observations_source_journal_obs_fkey
      foreign key (source_journal_obs_id)
      references public.journal_observations (id)
      on update cascade
      on delete restrict;
  end if;
end $$;


-- =============================================================
-- 3. 같은 후보를 두 번 가져오지 못하게 한다
--
-- 화면에서도 이미 가져온 것은 고르지 못하게 하지만,
-- 두 사람이 동시에 누르는 경우까지는 화면이 막지 못한다.
-- DB가 마지막으로 한 번 더 막는다.
-- NULL 은 여러 개여도 되므로 값이 있는 행에만 건다.
-- =============================================================
create unique index if not exists uq_observations_source_journal_obs
  on public.observations (source_journal_obs_id)
  where source_journal_obs_id is not null;

comment on column public.observations.source_journal_obs_id is
  '이 관찰이 어느 journal_observations 행에서 왔는지. 직접 쓴 관찰이면 NULL.';


-- =============================================================
-- 4. 확인용 조회 (실행 후 결과 확인)
-- =============================================================
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'observations'
  and column_name like 'source%';
