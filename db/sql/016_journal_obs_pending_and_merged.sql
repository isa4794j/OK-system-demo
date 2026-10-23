-- =============================================================
-- OK-system 마이그레이션 016
-- 관찰 후보에 두 가지 상태를 더한다.
--   1) 아동 확인 필요 — 표기가 여러 아동과 맞아 누구인지 못 가린 후보
--   2) 합쳐짐        — 다른 관찰에 합쳐져 다시 가져오면 안 되는 후보
--
-- 001~015 가 먼저 실행돼 있어야 합니다. 여러 번 실행해도 안전합니다.
--
-- [왜 child_id 를 비울 수 있게 하나]
-- 일지에 "김0준"이라고만 적혀 있고 명단에 김하준·김서준이 둘 다 있으면
-- 누구인지 글자만 보고는 알 수 없다. 지금까지는 그런 후보를 통째로 버렸다.
-- 버리면 사람이 손으로 찾아 넣기 전에는 그 관찰이 영영 없는 것이 된다.
-- 그래서 아동을 비운 채로 저장하고, 후보 아동 목록을 함께 남겨
-- 일지 카드에서 사람이 고르게 한다. 기계는 추측하지 않는다.
-- =============================================================


-- =============================================================
-- 1. child_id 를 비울 수 있게 한다
--
-- 비어 있는 행은 "아직 누구인지 못 정한 후보"다.
-- 아동 관찰(observations)로 가져가려면 반드시 채워져 있어야 한다 —
-- 그 조건은 코드(listImportableObservations)가 본다.
-- =============================================================
alter table public.journal_observations
  alter column child_id drop not null;

comment on column public.journal_observations.child_id is
  'children_identity.id 참조. NULL 이면 아직 어느 아동인지 사람이 정하지 않은 후보다.';


-- =============================================================
-- 2. 후보 아동 목록
--
-- child_id 가 비어 있을 때, 어느 아동들이 후보였는지 남긴다.
-- 사람이 고를 때 이 목록을 먼저 보여 주면 명단 22명을 다 훑지 않아도 된다.
--
-- 외래키를 걸 수 없는 배열이라, 아동이 지워지면 죽은 id 가 남는다.
-- 읽는 쪽에서 실제로 있는 아동만 추려 보여 준다(없는 id 는 그냥 빠진다).
-- 후보 목록은 "고르기 쉽게" 하는 거들기일 뿐 기록의 본체가 아니라, 이 정도로 충분하다.
-- =============================================================
alter table public.journal_observations
  add column if not exists pending_child_ids uuid[];

comment on column public.journal_observations.pending_child_ids is
  'child_id 가 비어 있을 때의 후보 아동 id 들. 외래키가 아니므로 읽을 때 실재하는 것만 추린다.';


-- =============================================================
-- 3. 합쳐짐 표시
--
-- 아동 관찰 둘을 합칠 때, 두 관찰이 각각 후보를 가리키고 있으면
-- 합쳐진 뒤에도 근거는 하나만 남는다(한 후보는 한 번만 가져올 수 있다).
-- 남지 못한 쪽의 후보는 "가져옴"이 풀려 가져오기 목록에 다시 나타났고,
-- 그걸 다시 가져오면 방금 합친 내용이 또 들어왔다.
--
-- 그래서 "풀린 것"이 아니라 "다른 관찰에 합쳐진 것"으로 표시해 둔다.
-- 가리키는 값은 살아남은 후보의 id 다. 어디로 갔는지 되짚을 수 있어야 하기 때문.
-- 그 후보마저 사라지면 연결만 끊고(set null) 합쳐졌다는 사실은 남긴다.
-- =============================================================
alter table public.journal_observations
  add column if not exists merged_into uuid;

alter table public.journal_observations
  add column if not exists merged_at timestamptz;

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where table_schema = 'public'
      and table_name = 'journal_observations'
      and constraint_name = 'journal_observations_merged_into_fkey'
  ) then
    alter table public.journal_observations
      add constraint journal_observations_merged_into_fkey
      foreign key (merged_into)
      references public.journal_observations (id)
      on update cascade
      on delete set null;
  end if;
end $$;

comment on column public.journal_observations.merged_into is
  '이 후보의 관찰이 합쳐져 들어간 다른 후보의 id. 살아남은 후보도 지워지면 NULL 이 된다.';
comment on column public.journal_observations.merged_at is
  '합쳐진 시각. merged_into 가 NULL 이 되어도 "합쳐졌다"는 사실은 이 값으로 남는다.';


-- =============================================================
-- 4. 확인 필요 후보를 빨리 찾기
--
-- 일지 카드가 "이 일지에 확인할 것이 있는가"를 자주 묻는다.
-- =============================================================
create index if not exists idx_journal_observations_pending
  on public.journal_observations (journal_id)
  where child_id is null;


-- =============================================================
-- 5. RLS — 001~015 와 같이 지금은 켜지 않는다. 새 테이블도 없다.
-- =============================================================


-- =============================================================
-- 6. 확인용 조회 (실행 후 결과 확인)
-- =============================================================
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'journal_observations'
order by ordinal_position;
