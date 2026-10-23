-- =============================================================
-- OK-system 마이그레이션 015
-- 봉사일지가 일정을 참조한다: journals.schedule_id
--
-- 실행 순서: 위에서 아래로 통째로 실행하면 됩니다.
-- 여러 번 실행해도 안전합니다 (if not exists / is null 조건).
--
-- [왜]
-- 지금은 봉사일지가 시각을 자기 칸(start_time/end_time)에 복사해 둔다.
-- 그래서 일정에서 시각을 고치면 일지는 옛 시각을 그대로 들고 있다.
-- 일지가 일정을 가리키게 하면 시각은 한 곳(일정)에만 있고, 고치면 바로 따라간다.
--
-- [기존 칸은 남긴다]
-- journals.start_time/end_time 을 지우지 않는다. 봉사일지는 이제 안 쓰지만,
-- 지우면 옛 값이 사라져 되돌릴 수 없다. 읽는 쪽이 일정을 먼저 보고,
-- 일정이 없을 때만 옛 칸을 본다.
--
-- [일정을 지울 때]
-- on delete restrict 다. 그 일정으로 쓴 일지가 있으면 일정이 안 지워진다.
-- 시각의 출처가 사라지면 일지가 시각을 잃기 때문이다.
-- 앱이 먼저 세어 "일지 N건이 있습니다" 라고 알린다. DB 는 마지막 방어선이다.
-- =============================================================


-- 1. 칸 추가 (제약 없이 먼저)
alter table public.journals
  add column if not exists schedule_id uuid;

comment on column public.journals.schedule_id is
  '봉사일지가 가리키는 일정. 시각은 이 일정에서 읽는다. 다른 종류의 일지는 비어 있다.';


-- 2. 기존 봉사일지를 같은 날·같은 사람 일정에 잇는다.
--    한 사람이 하루에 두 번 오면 이른 시각 쪽으로 잇는다.
--    (조인으로 쓰면 어느 쪽이 걸릴지 정해지지 않는다. 정렬해서 하나만 고른다)
update public.journals j
   set schedule_id = (
     select s.id
       from public.schedules s
      where s.sched_date = j.journal_date
        and s.staff_id = j.author_id
      order by s.start_time
      limit 1
   )
 where j.kind = '봉사'
   and j.schedule_id is null
   and j.author_id is not null;


-- 3. 외래키. 값을 다 채운 뒤에 건다 — 먼저 걸면 2번이 막힐 이유는 없지만,
--    순서를 이렇게 두면 잘못된 값이 남아 있을 때 add 에서 바로 걸린다.
alter table public.journals
  drop constraint if exists journals_schedule_id_fkey;

alter table public.journals
  add constraint journals_schedule_id_fkey
  foreign key (schedule_id) references public.schedules (id)
  on update cascade
  on delete restrict;


-- 4. 일정으로 일지를 찾는 조회 (일정을 지워도 되는지 볼 때)
create index if not exists idx_journals_schedule
  on public.journals (schedule_id)
  where schedule_id is not null;


-- =============================================================
-- 확인
--   - 봉사일지 중 일정에 이어진 것과 못 이어진 것
--   - 못 이어진 것은 그 날 그 사람의 일정이 없다는 뜻이다 (지워졌거나 애초에 없었거나)
-- =============================================================
select
  count(*) filter (where schedule_id is not null) as "일정에 이어짐",
  count(*) filter (where schedule_id is null)     as "못 이어짐",
  count(*)                                        as "봉사일지 전체"
from public.journals
where kind = '봉사';
