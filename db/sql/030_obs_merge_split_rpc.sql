-- =============================================================
-- OK-system 마이그레이션 030
-- 관찰·추출 후보의 병합/나누기를 한 번에(트랜잭션) 처리하는 함수 넷
--
-- 001~029 가 먼저 실행돼 있어야 합니다. 여러 번 실행해도 안전합니다(create or replace).
-- Supabase SQL 편집기에 파일 전체를 붙여 넣고 한 번에 실행하면 됩니다.
-- =============================================================


-- =============================================================
-- [왜 필요한가]
-- 병합은 "남길 쪽 수정 + 지울 쪽 삭제 + 근거 연결 옮기기/합쳐짐 표시" 이고,
-- 나누기는 "원본 수정 + 새 행 추가" 다. 앱에서 따로따로 부르면 트랜잭션이 아니라
-- 중간에 실패하면 반쯤 된 채 남는다. 지금까지는 실패하면 앱이 되돌려 놓았지만(보상),
-- 되돌리기마저 실패하면 막을 방법이 없었다.
--
-- 함수 하나는 트랜잭션 하나다. 어느 단계에서 실패해도 전부 되돌아간다(027 과 같은 방식).
--
-- [나눠 맡기]
-- 규칙 검사(같은 아동·같은 날짜·같은 원본 일지)는 앱이 먼저 하고 사람이 읽을 말로 거절한다.
-- 함수는 행을 잠근 뒤 같은 검사를 한 번 더 한다 — 앱이 읽은 뒤 그 사이에 바뀌었을 때를 막는 몫.
-- 감사 로그는 여기서 쓰지 않는다 — 기록 코드는 db/audit.ts 한 곳이다. 함수가 성공한 뒤 앱이 남긴다.
--
-- [오류]
--   P0002 'not_found'       — 없는 id. 아무것도 바꾸지 않는다.
--   P0001 'merge_mismatch'  — 잠근 뒤 보니 합칠 수 없는 둘. 아무것도 바꾸지 않는다.
--
-- [권한]
-- 서버(service_role)만 부른다. Supabase 는 public 함수를 anon 에게도 열어 두므로 막는다.
-- =============================================================


-- =============================================================
-- 1) merge_observations(남길 관찰, 사라질 관찰, 합친 내용)
--
-- 근거(source_journal_obs_id)는 하나만 남는다(한 후보는 한 번만 가져올 수 있다 — unique).
--   - 남는 쪽에 근거가 없고 사라지는 쪽에만 있으면 옮겨 온다(moved_trace).
--   - 둘 다 있으면 사라지는 쪽의 후보에 "합쳐짐"(merged_into = 남는 쪽 후보)을 남긴다(released).
-- =============================================================

create or replace function public.merge_observations(
  p_keep_id uuid,
  p_remove_id uuid,
  p_content text
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  k public.observations%rowtype;
  r public.observations%rowtype;
  v_move boolean;
  v_released boolean;
begin
  if p_keep_id = p_remove_id then
    raise exception 'merge_mismatch' using errcode = 'P0001';
  end if;

  -- 두 행을 잠근다. 순서를 id 로 고정해 서로 반대로 잠그다 멈추는 일을 막는다.
  perform 1 from public.observations
  where id in (p_keep_id, p_remove_id)
  order by id
  for update;

  select * into k from public.observations where id = p_keep_id;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select * into r from public.observations where id = p_remove_id;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  if k.child_id is distinct from r.child_id
     or k.obs_date is distinct from r.obs_date
     or k.source_journal_id is distinct from r.source_journal_id then
    raise exception 'merge_mismatch' using errcode = 'P0001';
  end if;

  v_move := k.source_journal_obs_id is null and r.source_journal_obs_id is not null;
  v_released := not v_move and r.source_journal_obs_id is not null;

  if v_move then
    -- unique 때문에 두 행이 같은 후보를 잠깐이라도 함께 가리킬 수 없다. 먼저 떼고 붙인다.
    update public.observations set source_journal_obs_id = null where id = p_remove_id;
    update public.observations
    set content = p_content,
        source_journal_obs_id = r.source_journal_obs_id,
        source_journal_id = r.source_journal_id,
        source_journal_updated_at = r.source_journal_updated_at
    where id = p_keep_id;
  else
    update public.observations set content = p_content where id = p_keep_id;
  end if;

  delete from public.observations where id = p_remove_id;

  -- 사라진 쪽이 물고 있던 후보를 그냥 두면 가져오기 목록에 다시 나타난다(두 번 들어간다).
  if v_released then
    update public.journal_observations
    set merged_into = k.source_journal_obs_id,
        merged_at = now()
    where id = r.source_journal_obs_id;
  end if;

  return jsonb_build_object('moved_trace', v_move, 'released', v_released);
end;
$$;


-- =============================================================
-- 2) split_observation(원본 관찰, 원본에 남길 내용, 새 관찰 내용, 새 관찰 영역)
--
-- 새 관찰은 같은 아동·같은 날짜·같은 출처(source). 근거 연결은 원본만 들고 있는다.
-- =============================================================

create or replace function public.split_observation(
  p_id uuid,
  p_original_content text,
  p_new_content text,
  p_new_area text
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  o public.observations%rowtype;
  v_new_id uuid;
begin
  select * into o from public.observations where id = p_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  update public.observations set content = p_original_content where id = p_id;

  insert into public.observations (child_id, obs_date, area, content, source)
  values (o.child_id, o.obs_date, p_new_area, p_new_content, o.source)
  returning id into v_new_id;

  return jsonb_build_object('created_id', v_new_id);
end;
$$;


-- =============================================================
-- 3) merge_journal_obs(남길 후보, 사라질 후보, 합친 내용)
--
-- 같은 일지·같은 아동(정해진 아동)끼리만.
-- 사라지는 쪽을 가져간 관찰이 있고 남는 쪽은 아직 안 가져갔으면 그 연결을 남는 쪽으로 옮긴다.
-- 둘 다 가져갔으면 옮길 수 없다 — 후보가 지워지며 외래키(set null)가 그 연결만 끊는다(orphaned).
-- =============================================================

create or replace function public.merge_journal_obs(
  p_keep_id uuid,
  p_remove_id uuid,
  p_content text
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  k public.journal_observations%rowtype;
  r public.journal_observations%rowtype;
  v_keep_taken boolean;
  v_remove_taken boolean;
  v_move boolean;
begin
  if p_keep_id = p_remove_id then
    raise exception 'merge_mismatch' using errcode = 'P0001';
  end if;

  perform 1 from public.journal_observations
  where id in (p_keep_id, p_remove_id)
  order by id
  for update;

  select * into k from public.journal_observations where id = p_keep_id;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select * into r from public.journal_observations where id = p_remove_id;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  if k.journal_id is distinct from r.journal_id
     or k.child_id is null
     or k.child_id is distinct from r.child_id then
    raise exception 'merge_mismatch' using errcode = 'P0001';
  end if;

  v_keep_taken := exists (select 1 from public.observations where source_journal_obs_id = p_keep_id);
  v_remove_taken := exists (select 1 from public.observations where source_journal_obs_id = p_remove_id);
  v_move := v_remove_taken and not v_keep_taken;

  -- 후보를 지우면 외래키가 근거를 null 로 만든다. 그 전에 옮겨 둔다.
  if v_move then
    update public.observations
    set source_journal_obs_id = p_keep_id
    where source_journal_obs_id = p_remove_id;
  end if;

  update public.journal_observations
  set content = p_content,
      edited_at = now()
  where id = p_keep_id;

  delete from public.journal_observations where id = p_remove_id;

  return jsonb_build_object(
    'keep_taken', v_keep_taken,
    'moved', case when v_move then 1 else 0 end,
    'orphaned', case when v_remove_taken and not v_move then 1 else 0 end
  );
end;
$$;


-- =============================================================
-- 4) split_journal_obs(원본 후보, 원본에 남길 내용, 새 후보 내용)
--
-- 새 후보는 같은 일지·같은 아동·같은 영역, 아직 가져가지 않은 상태.
-- 아동을 못 가린 후보면 후보 목록(pending_child_ids)을 물려준다.
-- 사람이 갈라 낸 것이라 양쪽 모두 edited_at(다시 분석해도 지우지 않음).
-- =============================================================

create or replace function public.split_journal_obs(
  p_id uuid,
  p_keep_content text,
  p_new_content text
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  o public.journal_observations%rowtype;
  v_new_id uuid;
begin
  select * into o from public.journal_observations where id = p_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  update public.journal_observations
  set content = p_keep_content,
      edited_at = now()
  where id = p_id;

  insert into public.journal_observations
    (journal_id, child_id, pending_child_ids, area, content, edited_at)
  values (
    o.journal_id,
    o.child_id,
    case when o.child_id is null then o.pending_child_ids else null end,
    o.area,
    p_new_content,
    now()
  )
  returning id into v_new_id;

  return jsonb_build_object('created_id', v_new_id);
end;
$$;


-- =============================================================
-- 권한 — 서버(service_role)만
-- =============================================================

revoke all on function public.merge_observations(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.split_observation(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.merge_journal_obs(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.split_journal_obs(uuid, text, text) from public, anon, authenticated;

grant execute on function public.merge_observations(uuid, uuid, text) to service_role;
grant execute on function public.split_observation(uuid, text, text, text) to service_role;
grant execute on function public.merge_journal_obs(uuid, uuid, text) to service_role;
grant execute on function public.split_journal_obs(uuid, text, text) to service_role;



-- =============================================================
-- 확인 (실행 후 — 따로 실행)
--
-- ① 함수 넷이 생겼는지 → 4줄
--   select proname from pg_proc
--   where pronamespace = 'public'::regnamespace
--     and proname in ('merge_observations', 'split_observation', 'merge_journal_obs', 'split_journal_obs')
--   order by proname;
--
-- ② anon·authenticated 는 못 부르고 service_role 은 부르는지 → 4줄 모두 false, false, true
--   select p.proname,
--          has_function_privilege('anon', p.oid, 'execute') as anon_실행가능,
--          has_function_privilege('authenticated', p.oid, 'execute') as authenticated_실행가능,
--          has_function_privilege('service_role', p.oid, 'execute') as service_role_실행가능
--   from pg_proc p
--   where p.pronamespace = 'public'::regnamespace
--     and p.proname in ('merge_observations', 'split_observation', 'merge_journal_obs', 'split_journal_obs')
--   order by p.proname;
-- =============================================================
