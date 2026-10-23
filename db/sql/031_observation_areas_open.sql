-- =============================================================
-- OK-system 마이그레이션 031
-- 관찰 영역 CHECK 제약 풀기 — 영역 목록을 센터가 정한다(settings.observation_areas)
--
-- 001~030 이 먼저 실행돼 있어야 합니다. 여러 번 실행해도 안전합니다(있으면 지우고, 없으면 넘어감).
-- Supabase SQL 편집기에 파일 전체를 붙여 넣고 한 번에 실행하면 됩니다.
-- 실행 뒤 확인은 031_observation_areas_check.sql 로 합니다.
-- =============================================================


-- =============================================================
-- [왜 필요한가]
-- observations.area 와 journal_observations.area 는 001·003 에서
--   check (area in ('건강','학습','또래관계','행동정서','보호자요구','연계'))
-- 로 묶여 있다. 관리자가 [영역 관리]에서 새 영역(코드 a01, a02 …)을 더하면
-- 그 코드로 지정하는 순간 DB 가 거절한다.
--
-- 어떤 코드를 받을지는 이제 앱이 정한다(lib/obs_areas.ts — 지금 쓰는 영역만 새로 지정 가능).
-- 이름 바꾸기·지우기는 settings 값만 바뀌고 기록은 그대로다(코드 불변, 지운 영역은 deleted 로 남음).
--
-- [바꾸지 않는 것]
-- 기존 행의 area 값은 한 글자도 바꾸지 않는다. 제약만 지운다.
-- settings 에 줄을 넣지도 않는다 — 값이 없으면 앱이 처음 여섯 영역으로 읽는다.
--
-- [되돌리기]
-- 새 코드(a01 …)로 지정된 행이 생기기 전이라면 001 의 check 를 그대로 다시 걸면 된다.
-- 생긴 뒤라면 그 행들을 먼저 정리해야 제약이 걸린다.
-- =============================================================

do $$
declare
  one record;
begin
  -- 이름은 보통 observations_area_check / journal_observations_area_check 지만,
  -- 만든 방식에 따라 다를 수 있어 "area 를 검사하는 check 제약" 을 찾아 지운다.
  for one in
    select c.conname, t.relname
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname in ('observations', 'journal_observations')
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%area%'
  loop
    execute format('alter table public.%I drop constraint %I', one.relname, one.conname);
    raise notice '지움: %.%', one.relname, one.conname;
  end loop;
end
$$;

comment on column public.observations.area is
  '관찰 영역 코드. 목록은 settings.observation_areas(앱이 검사). 처음 여섯은 이름 그대로, 새 영역은 a01…';
comment on column public.journal_observations.area is
  '관찰 영역 코드(observations.area 와 같은 목록). 031 이후 DB 제약 없음 — 앱이 검사';
