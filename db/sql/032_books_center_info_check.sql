-- =============================================================
-- OK-system 032 확인(읽기만) — 032_books_center_info.sql 실행 뒤에 돌립니다. 아무것도 바꾸지 않습니다.
-- =============================================================

-- 1) 새 칸 넷이 있는가 — 4줄이면 정상
select column_name, data_type, is_nullable, is_generated
from information_schema.columns
where table_schema = 'public' and table_name = 'books'
  and column_name in ('reg_no', 'center_class', 'biblio_locked', 'sort_key')
order by column_name;

-- 2) 입수경위 고르기 제약이 풀렸는가 — 0줄이면 정상
select c.conname, pg_get_constraintdef(c.oid)
from pg_constraint c
join pg_class t on t.oid = c.conrelid
where t.relname = 'books' and c.contype = 'c'
  and pg_get_constraintdef(c.oid) ilike '%acquired_via%';

-- 3) 옮긴 값이 들어갔는가 — 옮길 것이 남아 있으면(아래 세 수 중 하나라도 0 보다 크면) 032 를 다시 돌립니다
select
  count(*) filter (where donor is not null and btrim(donor) <> ''
                   and coalesce(acquired_via, '') not like '%' || btrim(donor) || '%') as 기증자_남음,
  count(*) filter (where location is not null and btrim(location) <> ''
                   and coalesce(note, '') not like '%서가위치: ' || btrim(location) || '%') as 서가위치_남음,
  count(*) filter (where call_number is not null and btrim(call_number) <> ''
                   and coalesce(note, '') not like '%청구기호: ' || btrim(call_number) || '%') as 청구기호_남음,
  count(*) filter (where biblio_locked) as 잠긴_책,
  count(*) as 전체
from public.books;

-- 4) 정렬 모양 — 앞 10권
select reg_no, title, sort_key
from public.books
order by sort_key, id
limit 10;
