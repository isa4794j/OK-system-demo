-- =============================================================
-- OK-system 마이그레이션 028
-- 일지 "본문이 바뀐 시각" 을 따로 둔다
--
-- 001~027 이 먼저 실행돼 있어야 합니다. 여러 번 실행해도 안전합니다.
-- =============================================================


-- =============================================================
-- journals.content_updated_at
--
-- [왜 필요한가]
-- 가져온 관찰의 "근거 일지 수정됨" 은 일지의 updated_at 을 보고 있었다.
-- 그런데 updated_at 은 행의 어느 칸이 바뀌어도 올라간다 —
-- 분석 완료 표시(observations_analyzed_at), 수퍼비전 댓글, 일정 시각 같은 것까지.
-- 그래서 다시 분석하거나 댓글 하나만 달아도 가져간 관찰이 전부 "수정됨" 이 됐다.
--
-- 본문(제목·내용)이 바뀔 때만 올라가는 시각을 따로 둔다. DB 트리거가 지킨다 —
-- 앱에서 챙기면 어느 한 경로(폰 수정 등)에서 빠뜨리는 날이 온다.
-- =============================================================

alter table public.journals
  add column if not exists content_updated_at timestamptz;

comment on column public.journals.content_updated_at is
  '제목·내용이 마지막으로 바뀐 시각. 트리거가 채운다. 가져온 관찰의 "근거 수정됨" 판단에 쓴다.';

-- 이미 있는 일지 채우기 (처음 한 번만 — 비어 있는 줄만).
-- 감사 로그의 "일지 수정" 중 제목·내용이 실제로 바뀐 마지막 시각을 쓴다.
-- 그런 기록이 없으면 작성 시각. 감사 로그(013) 이전의 수정은 알 길이 없어 작성 시각으로 둔다.
update public.journals j
set content_updated_at = coalesce(
  (
    select max(a.at)
    from public.audit_logs a
    where a.table_name = 'journals'
      and a.action = 'update'
      and a.record_id = j.id
      and (
        (a.before ->> 'content') is distinct from (a.after ->> 'content')
        or (a.before ->> 'title') is distinct from (a.after ->> 'title')
      )
  ),
  j.created_at
)
where j.content_updated_at is null;

alter table public.journals
  alter column content_updated_at set default now(),
  alter column content_updated_at set not null;

create or replace function public.set_journal_content_updated_at()
returns trigger
language plpgsql
as $$
begin
  if new.title is distinct from old.title or new.content is distinct from old.content then
    new.content_updated_at = now();
  else
    -- 앱이 이 칸을 직접 바꾸지 못하게 한다. 본문이 그대로면 시각도 그대로다.
    new.content_updated_at = old.content_updated_at;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_journals_content_updated_at on public.journals;
create trigger trg_journals_content_updated_at
  before update on public.journals
  for each row execute function public.set_journal_content_updated_at();



-- =============================================================
-- 확인 (실행 후)
--
--   select count(*) filter (where content_updated_at is null) as 빈칸,
--          count(*) filter (where content_updated_at < updated_at) as 본문_말고_다른_칸이_나중에_바뀐_일지
--   from public.journals;
--   → 빈칸 0
-- =============================================================
