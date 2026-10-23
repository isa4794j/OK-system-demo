-- =============================================================
-- OK-system 마이그레이션 033
-- 도서 정렬 열쇠(sort_key) 고침 — 등록번호를 "앞 글자 + 번호(자릿수 맞춤)" 로 줄 세운다
--
-- 032 가 먼저 실행돼 있어야 합니다. 여러 번 실행해도 안전합니다(칸을 지우고 같은 이름으로 다시 만든다).
-- 값을 저장하는 칸이 아니라 DB 가 계산하는 칸이라 지워도 잃는 것이 없습니다.
-- =============================================================

-- [왜]
-- 032 의 열쇠는 "맨 앞의 숫자" 만 자릿수를 맞췄다. 그래서
--   · "A-3" 처럼 글자로 시작하는 번호가 "2" 보다 앞에 섰고
--   · "EM12" 와 "EM3" 은 글자순이라 EM12 가 먼저였다.
-- 고친 열쇠(등록번호가 있으면):
--   '0' + (숫자로 시작하면 '0', 글자로 시작하면 '1' + 첫 숫자 앞의 글자) + 첫 숫자 덩어리를 12자리로 채운 것 + 등록번호 전체
--   (기호를 구분자로 쓰지 않는다 — 콜레이션에 따라 기호는 비교에서 빠지기도 한다)
--   → 숫자만인 번호(2, 10, 100)가 먼저 숫자순, 그다음 앞 글자별(A-…, EM…)로 묶여 그 안에서 숫자순.
-- 등록번호가 없으면 예전과 같이 '1' + 제목.
-- 앱(web/assets/books.js sortKey)이 같은 규칙으로 화면 순서를 맞춘다.

drop index if exists public.idx_books_sort_key;
alter table public.books drop column if exists sort_key;

alter table public.books
  add column sort_key text
  generated always as (
    case
      when reg_no is not null and btrim(reg_no) <> '' then
        '0'
        || case
             when btrim(reg_no) ~ '^[0-9]' then '0'
             else '1' || coalesce(substring(btrim(reg_no) from '^[^0-9]*'), '')
           end
        || lpad(coalesce(substring(btrim(reg_no) from '[0-9]+'), ''), 12, '0')
        || btrim(reg_no)
      else
        '1' || title
    end
  ) stored;

create index if not exists idx_books_sort_key on public.books (sort_key, id);

-- 확인(읽기만) — 등록번호 있는 책이 번호순으로, 그다음 제목순
-- select reg_no, title, sort_key from public.books order by sort_key, id limit 20;
