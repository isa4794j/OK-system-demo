-- =============================================================
-- OK-system 마이그레이션 012
-- 도서관: books
--
-- 실행 순서: 위에서 아래로 통째로 실행하면 됩니다.
-- 여러 번 실행해도 안전하도록 if not exists 를 썼습니다.
--
-- [도서는 사람과 무관한 일반정보다]
-- 자원(resources)과 같은 원칙이다. 아동·직원 표와 잇지 않는다.
-- 누가 무엇을 빌렸는지(대출)는 이 표의 일이 아니고, 지금 범위 밖이다.
--
-- [자원사전과 표를 나눈 이유]
-- 도서는 ISBN·저자·출판사·청구기호처럼 자원에는 없는 칸이 많고,
-- 나중에 외부 API(국립중앙도서관)로 채울 칸이 따로 있다.
-- 한 표에 넣으면 자원 쪽 칸 절반이 늘 비어 있게 된다.
-- =============================================================


-- =============================================================
-- 0. 공통: updated_at 자동 갱신 함수 (이미 있으면 그대로 덮는다)
-- =============================================================
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;


-- =============================================================
-- 1. books  [도서관] 센터가 가진 책
-- =============================================================
create table if not exists public.books (
  id              uuid        primary key default gen_random_uuid(),

  -- ISBN. 하이픈·공백을 뺀 숫자만 담는다 (10자리는 끝이 X 일 수 있다).
  -- 나중에 외부 API 로 서지정보를 채울 때 이 값으로 찾는다.
  -- 없어도 된다 — 오래된 책, 직접 만든 책, 기증받은 낱권은 ISBN 이 없다.
  isbn            text,

  -- 제목. 필수이며 공백만 들어가는 것도 막는다.
  title           text        not null check (length(btrim(title)) > 0),

  author          text,
  publisher       text,

  -- 발행년. 네 자리 연도만.
  published_year  integer     check (published_year is null
                                     or (published_year >= 1000 and published_year <= 2999)),

  -- 한국십진분류(KDC) 번호. 예: '813.8'
  -- 지금은 비워 둔다. 외부 API 가 붙으면 채우고, 그때 분류별 묶음 화면을 만든다.
  kdc             text,

  -- 청구기호. 서가에 붙이는 라벨. 예: '813.8 김12ㅎ'
  call_number     text,

  -- 표지 이미지 주소. 외부 API 가 붙으면 채운다. 이미지를 저장하지 않고 주소만 둔다.
  cover_url       text,

  -- 입수경위. 값을 제한해 표기 흔들림을 막는다.
  acquired_via    text        not null default '구입'
                              check (acquired_via in ('구입', '후원', '기타')),

  -- 기증자. 후원일 때만 뜻이 있다. 단체명이나 사람 이름이 들어올 수 있다.
  -- 아동·직원 표와 잇지 않는다 — 기증자는 대개 외부인이다.
  donor           text,

  -- 상태. 잃어버리거나 버려도 행을 지우지 않고 이 값을 바꾼다.
  -- 그래야 "언제 몇 권이 있었는지"가 남는다.
  status          text        not null default '보유'
                              check (status in ('보유', '분실', '폐기')),

  -- 서가 위치. 예: '교실 뒤 책장 2단'
  location        text,

  note            text,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- 같은 ISBN 을 두 번 담지 않는다. ISBN 이 없는 책은 이 검사에서 빠진다.
-- (같은 책을 두 권 갖는 일이 생기면 권수 칸을 더하는 쪽으로 간다 — 지금은 한 줄에 한 권)
create unique index if not exists idx_books_isbn_unique
  on public.books (isbn)
  where isbn is not null;

-- 제목으로 찾는 조회가 가장 잦다
create index if not exists idx_books_title
  on public.books (title);

-- 상태별 목록 (보유 도서만 보기)
create index if not exists idx_books_status
  on public.books (status);

drop trigger if exists trg_books_updated_at on public.books;
create trigger trg_books_updated_at
  before update on public.books
  for each row execute function public.set_updated_at();

comment on table public.books is
  '도서관: 센터가 가진 책. 사람과 무관한 일반정보라 아동·직원 표와 잇지 않는다. 대출은 이 표의 일이 아니다.';
comment on column public.books.isbn is
  '하이픈·공백을 뺀 값. 외부 API 로 서지정보를 채울 때의 열쇠. 없어도 된다.';
comment on column public.books.kdc is
  '한국십진분류 번호. 외부 API 가 붙으면 채운다. 그때 분류별 묶음 화면을 만든다.';
comment on column public.books.status is
  '보유/분실/폐기. 잃어버리거나 버려도 행을 지우지 말고 이 값을 바꾼다.';


-- =============================================================
-- 2. RLS (행 수준 보안) — 지금은 켜지 않는다
--
-- 앞선 마이그레이션과 같은 이유다. 로그인을 설계할 때 전체 표를 한꺼번에 켠다.
-- anon 권한 회수(009)의 alter default privileges 가 이미 돌았다면
-- 이 표에도 anon 권한이 붙지 않는다. 008 로 확인한다.
-- =============================================================
