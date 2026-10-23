-- =============================================================
-- OK-system 마이그레이션 026
-- 연간평가가 "무엇을 읽고 썼는지" 를 남긴다.
--
-- 001~025 가 먼저 실행돼 있어야 합니다. 여러 번 실행해도 안전합니다.
--
-- [왜 필요한가]
-- 지금까지 근거(어떤 관찰이 재료였는지)는 어디에도 저장되지 않았다.
-- 화면의 [근거 보기] 는 "지금 이 반기 이 영역의 관찰" 을 그때그때 거른 것이고,
-- AI 초안도 그때 읽고 무엇을 읽었는지 남기지 않았다.
-- 그래서 평가를 쓴 뒤 관찰이 고쳐지거나 지워져도 아무도 알 수 없었다.
--
-- 저장 시점의 근거를 찍어 두면, 다음에 열었을 때 그 사이에 무엇이 바뀌었는지
-- 서버가 견줘 알려 줄 수 있다.
-- =============================================================


-- =============================================================
-- 1. 세 컬럼
--
-- evidence_snapshot   [{"obs_id": "...", "content_hash": "..."}]
--                     저장·확인 시점의 근거 목록. 영역 미지정 관찰은 담지 않는다 —
--                     어느 칸의 근거도 아니기 때문이다. 나중에 영역이 정해지면
--                     "추가" 로 잡히는 편이 사람이 읽기에 맞다.
--
-- evidence_checked_at 사람이 [확인함] 을 누른 시각. 눌러야만 채워진다.
-- evidence_checked_by 누가 눌렀는지. 명단에서 사라져도 기록은 남는다(set null).
-- =============================================================

alter table public.yearly_evaluations
  add column if not exists evidence_snapshot   jsonb,
  add column if not exists evidence_checked_at timestamptz,
  add column if not exists evidence_checked_by uuid
                           references public.staff (id)
                           on update cascade
                           on delete set null;

comment on column public.yearly_evaluations.evidence_snapshot is
  '저장·확인 시점의 근거 목록 [{obs_id, content_hash}]. null 이면 근거 추적 이전 평가.';
comment on column public.yearly_evaluations.evidence_checked_at is
  '사람이 [확인함] 을 누른 시각. 저장만으로는 채워지지 않는다.';


-- =============================================================
-- 2. 이미 저장된 평가는 그대로 둔다 (소급 생성 안 함)
--
-- 소급할 재료가 없다. 근거가 저장된 적이 없으므로 "그때의 근거 목록" 이 어디에도 없고,
-- 지금 관찰로 채우는 것은 소급이 아니라 "지금 상태를 정답으로 선언" 하는 것이다.
-- 그러면 그 사이에 이미 바뀐 것이 영영 안 보이게 된다.
--
-- 그래서 evidence_snapshot 은 null 로 남는다. 화면은 배너 대신
-- "근거 추적 이전 평가" 라고 적고, 다음에 저장하거나 [확인함] 을 누를 때
-- 그때부터 추적이 시작된다.
-- =============================================================


-- =============================================================
-- 3. 확인용 조회 (실행 후)
-- =============================================================
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'yearly_evaluations'
  and column_name like 'evidence%'
order by ordinal_position;

select count(*) as 평가,
       count(evidence_snapshot) as 스냅샷있음
from public.yearly_evaluations;
