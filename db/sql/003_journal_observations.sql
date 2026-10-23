-- =============================================================
-- OK-system 마이그레이션 003
-- 일지에서 AI가 뽑아낸 관찰 후보: journal_observations
--
-- 실행 순서: 이 파일을 위에서 아래로 통째로 실행하면 됩니다.
-- 001(children_identity, observations)과 002(staff, journals)가
-- 먼저 실행돼 있어야 합니다. 둘 다 참조합니다.
--
-- [observations 와 무엇이 다른가]
--   observations         = 사람이 확인한 아동 관찰. 아동 기록의 본체.
--   journal_observations = 일지에서 AI가 뽑아낸 "후보". 아직 확정이 아니다.
--   둘을 한 테이블에 섞지 않는다. 섞으면 사람이 쓴 기록과
--   기계가 짐작한 것을 구분할 수 없게 된다.
--   후보를 확정 기록으로 옮기는 "가져오기"는 다음 단계에서 만든다.
-- =============================================================


-- =============================================================
-- 1. journal_observations  [개인] 일지에서 추출된 관찰 후보
-- =============================================================
create table if not exists public.journal_observations (
  id          uuid        primary key default gen_random_uuid(),

  -- 어느 일지에서 나왔는지.
  --
  -- [삭제 동작: on delete cascade]
  --   이 행은 일지에서 파생된 값이라 원본 일지가 사라지면 의미가 없다.
  --   observations.child_id 는 restrict 인데 기준이 다르다.
  --     - 관찰(확정)은 사람이 쓴 기록이라 함부로 사라지면 안 된다  -> 막는다
  --     - 관찰 후보는 언제든 다시 뽑을 수 있는 파생물이다          -> 따라 지운다
  journal_id  uuid        not null
                          references public.journals (id)
                          on update cascade
                          on delete cascade,

  -- 어느 아동에 대한 관찰인지.
  -- AI가 아동을 특정하지 못한 내용은 애초에 저장하지 않으므로 not null 이다.
  child_id    uuid        not null
                          references public.children_identity (id)
                          on update cascade
                          on delete cascade,

  -- 영역. 미지정 가능(NULL). observations 와 같은 목록을 쓴다.
  area        text        check (area in (
                            '건강', '학습', '또래관계',
                            '행동정서', '보호자요구', '연계'
                          )),

  -- 관찰 내용
  content     text        not null check (length(btrim(content)) > 0),

  created_at  timestamptz not null default now()
);

-- 재추출할 때 그 일지의 것만 지우고 다시 넣는다. 가장 잦은 조회이자 삭제 조건.
create index if not exists idx_journal_observations_journal
  on public.journal_observations (journal_id);

-- 나중에 "이 아동에 대해 뽑힌 후보" 를 볼 때 쓴다
create index if not exists idx_journal_observations_child
  on public.journal_observations (child_id);

comment on table public.journal_observations is
  '일지에서 AI가 뽑아낸 관찰 후보. 사람이 확인한 observations 와 별개다.';
comment on column public.journal_observations.journal_id is
  'journals.id 참조. 일지를 지우면 함께 지워진다. 언제든 다시 뽑을 수 있는 파생물이라서다.';
comment on column public.journal_observations.child_id is
  'children_identity.id 참조. 아동이 특정되지 않은 내용은 저장하지 않는다.';


-- =============================================================
-- 2. RLS (행 수준 보안) — 지금은 켜지 않는다
--
-- 001·002와 같은 이유다. 접근 경로가 Deno 서버의 service_role 키 하나뿐이고,
-- service_role은 RLS를 우회하므로 지금 정책을 짜도 동작을 검증할 수 없다.
-- 로그인을 설계할 때 다섯 테이블을 한꺼번에 켠다.
--
--   alter table public.journal_observations enable row level security;
-- =============================================================


-- =============================================================
-- 3. (선택) anon / authenticated 역할의 접근 차단
--
-- 001·002에서 이 두 줄을 실행하셨다면 여기서도 함께 해두세요.
-- 안 하면 새 테이블만 anon 키로 열려 있게 됩니다.
-- 실행하려면 앞의 -- 를 지우세요.
--
-- revoke all on public.journal_observations from anon, authenticated;
-- =============================================================


-- =============================================================
-- 4. 확인용 조회 (실행 후 결과 확인)
-- =============================================================
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'journal_observations'
order by ordinal_position;
