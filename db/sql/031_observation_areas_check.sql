-- =============================================================
-- OK-system 031 확인(읽기만) — 영역 CHECK 제약이 풀렸는지, 기록의 영역 값이 무엇인지
-- 031_observation_areas_open.sql 실행 뒤에 돌립니다. 아무것도 바꾸지 않습니다.
-- =============================================================

-- 1) area 를 검사하는 check 제약 — 0줄이면 정상
select t.relname as 테이블, c.conname as 제약, pg_get_constraintdef(c.oid) as 정의
from pg_constraint c
join pg_class t on t.oid = c.conrelid
join pg_namespace n on n.oid = t.relnamespace
where n.nspname = 'public'
  and t.relname in ('observations', 'journal_observations')
  and c.contype = 'c'
  and pg_get_constraintdef(c.oid) ilike '%area%';

-- 2) 지금 기록에 쓰인 영역 값과 건수(바뀐 것이 없어야 한다 — 031 은 값을 건드리지 않는다)
select 'observations' as 테이블, coalesce(area, '(미지정)') as 영역, count(*) as 건수
from public.observations group by area
union all
select 'journal_observations', coalesce(area, '(미지정)'), count(*)
from public.journal_observations group by area
order by 1, 2;

-- 3) 설정에 저장된 영역 목록(없으면 0줄 — 앱이 처음 여섯 영역으로 읽는다)
select key, value from public.settings where key = 'observation_areas';
