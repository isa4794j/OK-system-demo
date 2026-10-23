-- =============================================================
-- OK-system 마이그레이션 018
-- 그 일지를 분석한 적이 있는지 남긴다.
--
-- 001~017 이 먼저 실행돼 있어야 합니다. 여러 번 실행해도 안전합니다.
--
-- [왜 필요한가]
-- 일지 카드에 뽑힌 개수를 늘 보여 주려는데, 개수가 0 인 것이 두 가지 뜻이다.
--   ㄱ. 분석했는데 뽑을 것이 없었다        → "관찰 0"
--   ㄴ. 아직 한 번도 분석하지 않았다        → "미분석"
-- 둘은 사람이 할 일이 다르다. ㄱ은 그냥 두면 되고, ㄴ은 분석을 눌러야 한다.
-- 그런데 표에는 뽑힌 줄만 있어서, 줄이 없다는 것만으로는 둘을 가릴 수 없었다.
--
-- 관찰과 자원을 따로 남긴다. 한쪽만 돌 수도 있고(한쪽이 실패), 다시 분석도 따로 한다.
-- =============================================================


-- =============================================================
-- 1. 분석한 시각 두 개
--
-- 참/거짓이 아니라 시각으로 남긴다.
-- "언제 뽑은 결과인지" 가 나중에 "그 뒤로 일지가 바뀌었는지" 를 가리는 데 쓰인다.
-- (observations.source_journal_updated_at 과 같은 생각)
-- =============================================================
alter table public.journals
  add column if not exists observations_analyzed_at timestamptz;

alter table public.journals
  add column if not exists resources_analyzed_at timestamptz;

comment on column public.journals.observations_analyzed_at is
  '관찰을 뽑아 본 마지막 시각. NULL 이면 한 번도 분석하지 않은 일지다(뽑힌 것이 0건인 것과 다르다).';
comment on column public.journals.resources_analyzed_at is
  '자원을 뽑아 본 마지막 시각. NULL 이면 한 번도 분석하지 않은 일지다.';


-- =============================================================
-- 2. 이미 분석된 일지 채우기
--
-- 뽑힌 줄이 하나라도 있으면 분석한 적이 있는 것이다.
-- 언제였는지는 알 수 없으므로 그 줄들이 만들어진 때를 쓴다.
-- 줄이 하나도 없는 일지는 NULL 로 남는다 —
-- 실제로 분석했는데 0건이었을 수도 있지만, 그건 알 방법이 없다.
-- 미분석으로 두면 사람이 한 번 더 눌러 볼 뿐이라 손해가 작다.
-- =============================================================
update public.journals j
set observations_analyzed_at = sub.at
from (
  select journal_id, max(created_at) as at
  from public.journal_observations
  group by journal_id
) as sub
where j.id = sub.journal_id
  and j.observations_analyzed_at is null;

update public.journals j
set resources_analyzed_at = sub.at
from (
  select journal_id, max(created_at) as at
  from public.resource_records
  where journal_id is not null
  group by journal_id
) as sub
where j.id = sub.journal_id
  and j.resources_analyzed_at is null;


-- =============================================================
-- 3. RLS — 001~017 과 같이 지금은 켜지 않는다. 새 테이블도 없다.
-- =============================================================


-- =============================================================
-- 4. 확인용 조회 (실행 후 결과 확인)
-- =============================================================
select
  count(*)                                              as 전체,
  count(observations_analyzed_at)                       as 관찰_분석함,
  count(*) - count(observations_analyzed_at)            as 관찰_미분석,
  count(resources_analyzed_at)                          as 자원_분석함,
  count(*) - count(resources_analyzed_at)               as 자원_미분석
from public.journals;
