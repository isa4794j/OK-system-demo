-- =============================================================
-- OK-system 마이그레이션 032
-- 도서 정보를 두 단으로 — 서지 정보(조회로 채우면 잠금) / 센터 정보(등록번호·센터분류·입수경위·상태·비고)
--
-- 001~031 이 먼저 실행돼 있어야 합니다. 여러 번 실행해도 안전합니다.
-- Supabase SQL 편집기에 파일 전체를 붙여 넣고 한 번에 실행하면 됩니다(한 트랜잭션).
-- 실행 뒤 확인은 032_books_center_info_check.sql 로 합니다.
-- =============================================================


-- =============================================================
-- [바뀌는 것]
--   reg_no        등록번호(신설) — 센터가 붙이는 번호, 선택. 같은 번호 두 권 금지(빈 값은 제외)
--   center_class  센터분류(신설) — 자유 입력, 선택. 공식분류(kdc·kdc_label)와 따로 둔다
--   acquired_via  입수경위 — '구입/후원/기타' 셋 중 고르던 것을 자유 글로 푼다(비워 둘 수도 있다)
--   biblio_locked 서지 잠금 — 조회(ISBN·검색·표지)로 채운 책은 저장 뒤 서지 칸을 못 고친다.
--                 [정보 다시 불러오기] 로만 갱신. 기존 책은 조회 이력이 없어 모두 false(고칠 수 있음)
--   sort_key      정렬 열쇠(DB 가 계산) — 등록번호 있는 책 먼저(앞 숫자는 자릿수 맞춰 숫자순), 없는 책은 제목순
--
-- [옮기는 것 — 값은 지우지 않는다]
--   donor(기증자)      → acquired_via 뒤에 " — 기증자" 로 붙인다. donor 칸은 그대로 남는다(앱은 더 안 씀)
--   location(서가위치)  → note(비고) 끝에 "서가위치: …" 한 줄. location 칸도 그대로 남는다
--   call_number(청구기호) → note 끝에 "청구기호: …" 한 줄. call_number 칸도 그대로 남는다
-- 두 번 돌려도 같은 줄이 또 붙지 않게 이미 들어 있으면 건너뛴다.
--
-- [앱과의 순서]
-- 앱은 이 칸들이 없어도 목록을 보여 준다(예전 방식). 새 칸에 값을 넣는 저장은 032 뒤에만 된다.
-- =============================================================

-- 1) 새 칸
alter table public.books add column if not exists reg_no text;
alter table public.books add column if not exists center_class text;
alter table public.books add column if not exists biblio_locked boolean not null default false;

comment on column public.books.reg_no is '등록번호 — 센터가 붙이는 번호(선택). 빈 값이 아니면 겹칠 수 없다.';
comment on column public.books.center_class is '센터분류 — 센터가 정하는 자유 분류(선택). 공식분류(kdc/kdc_label)와 별개.';
comment on column public.books.biblio_locked is '조회로 채운 서지(ISBN·제목·저자·출판사·발행년·KDC)는 저장 뒤 잠근다. 갱신은 [정보 다시 불러오기].';

create unique index if not exists idx_books_reg_no_unique
  on public.books (reg_no)
  where reg_no is not null;

-- 2) 입수경위 — 고르기 제약을 풀고 자유 글로
do $$
declare
  one record;
begin
  for one in
    select c.conname
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'books'
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%acquired_via%'
  loop
    execute format('alter table public.books drop constraint %I', one.conname);
    raise notice '지움: books.%', one.conname;
  end loop;
end
$$;

alter table public.books alter column acquired_via drop not null;
alter table public.books alter column acquired_via drop default;

-- 3) 기증자 → 입수경위 (예: "후원 — 김○○ 선생님")
update public.books
set acquired_via = concat_ws(' — ', nullif(btrim(acquired_via), ''), btrim(donor))
where donor is not null
  and btrim(donor) <> ''
  and coalesce(acquired_via, '') not like '%' || btrim(donor) || '%';

-- 4) 서가위치·청구기호 → 비고 끝에 한 줄씩
update public.books
set note = concat_ws(E'\n', nullif(note, ''), '서가위치: ' || btrim(location))
where location is not null
  and btrim(location) <> ''
  and coalesce(note, '') not like '%서가위치: ' || btrim(location) || '%';

update public.books
set note = concat_ws(E'\n', nullif(note, ''), '청구기호: ' || btrim(call_number))
where call_number is not null
  and btrim(call_number) <> ''
  and coalesce(note, '') not like '%청구기호: ' || btrim(call_number) || '%';

-- 5) 정렬 열쇠 — DB 가 계산한다(앱이 따로 맞출 일 없음)
--    등록번호 있음: '0' + 앞 숫자를 12자리로 채운 것 + 등록번호 전체  → "2", "10", "A-3" 이 2 < 10 < A-3 순
--    등록번호 없음: '1' + 제목
alter table public.books
  add column if not exists sort_key text
  generated always as (
    case
      when reg_no is not null and btrim(reg_no) <> '' then
        '0' || lpad(coalesce(substring(btrim(reg_no) from '^[0-9]+'), ''), 12, '0') || btrim(reg_no)
      else
        '1' || title
    end
  ) stored;

create index if not exists idx_books_sort_key on public.books (sort_key, id);
