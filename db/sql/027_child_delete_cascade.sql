-- =============================================================
-- OK-system 마이그레이션 027
-- 아동 삭제를 한 번에(트랜잭션) 처리하는 함수
--
-- 001~026 이 먼저 실행돼 있어야 합니다. 여러 번 실행해도 안전합니다.
-- =============================================================


-- =============================================================
-- delete_child_cascade(아동 id)
--
-- [왜 필요한가]
-- 아동을 지우려면 딸린 기록을 먼저 지워야 한다(외래키 restrict):
--   observations, yearly_evaluations, half_observations.
-- 앱에서 차례로 지우면 트랜잭션이 아니라, 중간에 막히면 앞의 것만 지워진 채 남는다.
-- 실제로 half_observations 를 빠뜨려 관찰·평가만 사라지고 아동 삭제가 실패하는 길이 있었다.
--
-- 함수 하나는 트랜잭션 하나다. 어느 단계에서 실패해도 전부 되돌아간다.
-- journal_observations 는 외래키 cascade 로 함께 사라진다(여기서는 세기만 한다).
--
-- 감사 로그는 여기서 쓰지 않는다 — 기록 코드는 db/audit.ts 한 곳이다.
-- 앱이 지우기 전에 값을 잡아 두고, 이 함수가 성공한 뒤에 남긴다.
--
-- [권한]
-- 서버(service_role)만 부른다. Supabase 는 public 함수를 anon 에게도 열어 두므로 막는다.
-- =============================================================

create or replace function public.delete_child_cascade(p_child_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  n_observations int;
  n_evaluations int;
  n_half int;
  n_candidates int;
begin
  -- 없는 아동이면 아무것도 지우지 않는다. 지우는 동안 다른 요청이 건드리지 못하게 잡아 둔다.
  perform 1 from public.children_identity where id = p_child_id for update;
  if not found then
    raise exception 'child_not_found' using errcode = 'P0002';
  end if;

  select count(*) into n_candidates
  from public.journal_observations where child_id = p_child_id;

  delete from public.observations where child_id = p_child_id;
  get diagnostics n_observations = row_count;

  delete from public.yearly_evaluations where child_id = p_child_id;
  get diagnostics n_evaluations = row_count;

  delete from public.half_observations where child_id = p_child_id;
  get diagnostics n_half = row_count;

  delete from public.children_identity where id = p_child_id;

  return jsonb_build_object(
    'observations', n_observations,
    'evaluations', n_evaluations,
    'half_observations', n_half,
    'journal_observations', n_candidates
  );
end;
$$;

revoke all on function public.delete_child_cascade(uuid) from public, anon, authenticated;
grant execute on function public.delete_child_cascade(uuid) to service_role;



-- =============================================================
-- 확인 (실행 후)
--
--   select has_function_privilege('anon', 'public.delete_child_cascade(uuid)', 'execute')
--     as anon_실행가능;
--   → false 여야 한다
-- =============================================================
