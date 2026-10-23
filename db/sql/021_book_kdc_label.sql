-- =============================================================
-- OK-system 마이그레이션 021
-- 책에 "서가 이름"을 둔다.
--
-- 001~020 이 먼저 실행돼 있어야 합니다. 여러 번 실행해도 안전합니다.
--
-- [왜 번호 옆에 이름을 따로 두나]
-- kdc 에는 "813.7" 같은 번호가 들어 있다. 사서가 아닌 사람에게는 아무 뜻이 없어
-- 서가에서 쓸 수가 없다. 그래서 사람이 읽는 이름("한국문학")을 따로 둔다.
--
-- 번호에서 그때그때 만들어 쓸 수도 있지만 그러면 사람이 고칠 수가 없다.
-- 그림책은 번호가 제각각으로 붙어 오고(813.8 로도 오고 아예 비어 있기도 하다),
-- 어디에 꽂을지는 센터마다 다르다. 자동은 제안이고 정하는 것은 사람이다(원칙 6).
-- 그래서 값으로 저장한다.
--
-- [기존 책은 비어 있다]
-- 채워 넣을 근거가 없다. kdc 가 있는 책만 아래에서 한 번 채우고,
-- 없는 책은 화면에서 "미분류"로 모인다. 상세에서 [조회] 로 나중에 채울 수 있다.
-- =============================================================

alter table public.books
  add column if not exists kdc_label text;

comment on column public.books.kdc_label is
  'KDC 번호를 사람이 읽는 서가 이름으로 옮긴 것(예: 813.7 → 한국문학). '
  '조회가 자동으로 채우고 사람이 고칠 수 있다. 변환표는 lib/kdc.ts.';

-- 목록의 분류 필터가 쓴다
create index if not exists idx_books_kdc_label
  on public.books (kdc_label)
  where kdc_label is not null;


-- =============================================================
-- 이미 kdc 번호가 있는 책은 한 번 채워 둔다.
--
-- lib/kdc.ts 의 표와 같은 규칙이다. 문학(8)만 둘째 자리까지 본다.
-- 이 SQL 은 여기서 한 번만 돌고, 그 뒤로는 앱이 채운다.
-- =============================================================
update public.books
set kdc_label = case substring(btrim(kdc) from '^[0-9]')
  when '0' then '총류'
  when '1' then '철학'
  when '2' then '종교'
  when '3' then '사회과학'
  when '4' then '자연과학'
  when '5' then '기술과학'
  when '6' then '예술'
  when '7' then '언어'
  when '9' then '역사'
  when '8' then case substring(btrim(kdc) from '^8([0-9])')
    when '1' then '한국문학'
    when '2' then '중국문학'
    when '3' then '일본문학'
    when '4' then '영미문학'
    when '5' then '독일문학'
    when '6' then '프랑스문학'
    when '7' then '스페인문학'
    when '8' then '이탈리아문학'
    when '9' then '기타문학'
    else '문학'
  end
end
where kdc_label is null
  and kdc is not null
  and btrim(kdc) ~ '^[0-9]';


-- =============================================================
-- 확인용 조회 (실행 후)
-- =============================================================
select coalesce(kdc_label, '(미분류)') as 분류, count(*) as 권수
from public.books
group by 1
order by 2 desc;
