-- =============================================================
-- OK-system 마이그레이션 002
-- 일지 기능용 테이블 2개: staff, journals
--
-- 실행 순서: 이 파일을 위에서 아래로 통째로 실행하면 됩니다.
--   1) staff     (먼저 — journals가 이걸 참조하므로)
--   2) journals
-- 여러 번 실행해도 안전하도록 if not exists / or replace 를 사용했습니다.
--
-- 001(children_identity, observations)과 같은 규칙을 따릅니다.
--   - 기본키는 uuid
--   - 값이 정해진 컬럼은 CHECK로 묶어 표기 흔들림을 막는다
--   - updated_at은 트리거로 DB가 보장한다
--   - RLS는 로그인 설계 때 정책과 함께 켠다
-- =============================================================


-- =============================================================
-- 0. 공통: updated_at 자동 갱신 함수
--    001에서 이미 만들었지만, 002만 따로 실행하는 경우를 위해 다시 둔다.
--    or replace 라서 두 번 실행해도 문제 없다.
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
-- 1. staff  [명단] 직원 — 멘토 / 봉사자 / 종사자
--
--    성인이라 아동처럼 신원을 분리하지 않고 한 테이블에 둔다.
--    (아동은 기록에서 이름을 떼어내야 해서 나눴지만,
--     직원은 일지의 작성자로 이름이 드러나는 게 정상이다)
-- =============================================================
create table if not exists public.staff (
  -- 기본키. children_identity와 같은 방식(uuid)
  id           uuid        primary key default gen_random_uuid(),

  -- 이름. 필수이며 공백만 들어가는 것도 막는다
  name         text        not null check (length(btrim(name)) > 0),

  -- 역할. 값을 제한해 표기 흔들림을 막는다 (모르면 NULL)
  role         text        check (role in ('멘토', '봉사자', '종사자')),

  -- 상태. 기본값 활동중.
  -- 그만두더라도 행을 지우지 말고 이 값을 '종료'로 바꾼다.
  status       text        not null default '활동중'
                           check (status in ('활동중', '종료')),

  -- 전화번호 (선택)
  phone        text,

  -- 달력에서 멘토·봉사자를 색으로 구분하기 위한 번호 (선택).
  -- 실제 색값(#RRGGBB)이 아니라 순번만 저장한다.
  -- 색은 화면 쪽 팔레트에서 정해야 나중에 톤을 바꿀 때 DB를 안 건드린다.
  color_index  integer     check (color_index is null or color_index >= 0),

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- 이름으로 찾는 조회가 잦다
create index if not exists idx_staff_name
  on public.staff (name);

-- 활동중/종료 목록 분리 조회용
create index if not exists idx_staff_status
  on public.staff (status);

-- UPDATE 시 updated_at 자동 갱신
drop trigger if exists trg_staff_updated_at on public.staff;
create trigger trg_staff_updated_at
  before update on public.staff
  for each row execute function public.set_updated_at();

comment on table public.staff is
  '명단: 직원(멘토/봉사자/종사자). 성인이라 신원을 분리하지 않고 한 테이블에 둔다.';
comment on column public.staff.status is
  '활동중 또는 종료. 그만두면 행을 삭제하지 말고 이 값을 종료로 바꾼다.';
comment on column public.staff.color_index is
  '달력 색 구분용 순번. 실제 색값이 아니라 팔레트의 몇 번째인지만 저장한다.';


-- =============================================================
-- 2. journals  [일지] 4종 통합 (프로그램 / 일상 / 회의록 / 봉사)
--
--    종류마다 쓰는 칸이 조금씩 다르지만, 네 개로 테이블을 쪼개면
--    "이번 달 일지 전부" 같은 조회가 매번 UNION이 된다.
--    한 테이블에 kind로 구분하고, 종류별로만 쓰는 칸은 NULL로 둔다.
-- =============================================================
create table if not exists public.journals (
  id            uuid        primary key default gen_random_uuid(),

  -- 일지 종류
  kind          text        not null
                            check (kind in ('프로그램', '일상', '회의록', '봉사')),

  -- 일지 날짜 (작성한 날이 아니라 그 일지가 다루는 날)
  journal_date  date        not null default current_date,

  -- 작성자. staff.id를 참조하는 외래키.
  --
  -- [삭제 동작 추천: on delete set null]
  --   일지에 적힌 내용은 그 자체로 기록이므로, 작성자가 명단에서 빠져도
  --   일지는 남아야 한다. 그래서 작성자를 삭제하면 이 값만 NULL이 되고
  --   일지 본문은 그대로 유지된다. (author_id를 nullable로 둔 이유)
  --
  --   observations.child_id는 반대로 restrict를 썼는데, 기준이 다르다.
  --     - 관찰은 "누구에 대한 기록"인지가 사라지면 아무 의미가 없다 → 막는다
  --     - 일지는 "누가 썼는지"를 몰라도 내용이 남는다        → 살린다
  --
  --   다만 평소에는 삭제할 일이 없다. 그만둔 직원은 staff.status를
  --   '종료'로 바꿔 처리하므로, 이 동작이 실제로 걸리는 건
  --   잘못 등록한 사람을 지우는 경우 정도다.
  author_id     uuid        references public.staff (id)
                            on update cascade
                            on delete set null,

  -- 제목. 봉사일지에는 없을 수 있어 nullable.
  title         text,

  -- 내용.
  -- 001의 observations.content와 같이 빈 일지를 막는다.
  -- 시간만 기록하는 봉사일지를 허용해야 하면 아래 두 줄로 풀 수 있다.
  --   alter table public.journals alter column content drop not null;
  --   alter table public.journals drop constraint journals_content_check;
  content       text        not null check (length(btrim(content)) > 0),

  -- 봉사일지용 시작·종료 시각. 다른 종류에서는 쓰지 않는다.
  -- kind별로 어떤 칸을 쓰는지는 DB로 강제하지 않는다.
  -- 지금 묶어두면 나중에 "프로그램에도 시간을 넣자"가 됐을 때 막힌다.
  start_time    time,
  end_time      time,

  -- 수퍼비전 댓글 (봉사일지용). 나머지 종류에서는 쓰지 않는다.
  comment       text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- 종료 시각이 시작보다 앞설 수 없다 (둘 중 하나가 NULL이면 검사하지 않음).
  -- 자정을 넘기는 봉사는 없다고 보고 단순하게 둔다.
  constraint journals_end_after_start
    check (start_time is null or end_time is null or end_time >= start_time)
);

-- 가장 잦은 조회: 최근 일지부터
create index if not exists idx_journals_date
  on public.journals (journal_date desc);

-- 종류별 + 기간 조회 (예: 이번 달 봉사일지)
create index if not exists idx_journals_kind_date
  on public.journals (kind, journal_date desc);

-- 작성자별 조회 (예: 이 봉사자가 쓴 일지)
create index if not exists idx_journals_author
  on public.journals (author_id)
  where author_id is not null;

-- UPDATE 시 updated_at 자동 갱신
drop trigger if exists trg_journals_updated_at on public.journals;
create trigger trg_journals_updated_at
  before update on public.journals
  for each row execute function public.set_updated_at();

comment on table public.journals is
  '일지 4종(프로그램/일상/회의록/봉사) 통합. kind로 구분하고 안 쓰는 칸은 NULL로 둔다.';
comment on column public.journals.author_id is
  'staff.id 참조. 작성자를 삭제해도 일지는 남고 이 값만 NULL이 된다.';
comment on column public.journals.start_time is
  '봉사일지용 시작 시각. 다른 종류에서는 쓰지 않는다.';
comment on column public.journals.comment is
  '수퍼비전 댓글(봉사일지용). 다른 종류에서는 쓰지 않는다.';


-- =============================================================
-- 3. RLS (행 수준 보안) — 지금은 켜지 않는다
--
-- 001과 같은 이유다. 현재 접근 경로는 Deno 서버의 service_role 키 하나뿐이고,
-- service_role은 RLS를 우회하므로 지금 정책을 짜도 동작을 검증할 수 없다.
-- 로그인(직원 계정 / 역할 구분)을 설계할 때 네 테이블을 한꺼번에 켠다.
--
-- 그때 할 일:
--   alter table public.staff    enable row level security;
--   alter table public.journals enable row level security;
--   + 역할별 정책 작성
--     (예: 봉사자는 자기가 쓴 일지만, 종사자는 전체,
--          수퍼비전 댓글은 종사자만 쓸 수 있게)
--
-- 그때까지의 임시 방어책은 아래 4번을 참고.
-- =============================================================


-- =============================================================
-- 4. (선택) anon / authenticated 역할의 접근 차단
--
-- RLS가 꺼진 public 스키마 테이블은 Supabase의 anon 키만 있으면
-- 외부에서 REST로 읽고 쓸 수 있다. 우리 프론트는 anon 키를 쓰지 않지만
-- 키가 어딘가로 새면 그대로 뚫린다. 대시보드에도 경고가 뜬다.
--
-- service_role은 영향받지 않으므로 지금 서버 코드는 그대로 동작한다.
-- 001에서 이미 실행했다면 여기서도 같이 해두는 게 일관적이다.
-- 실행하려면 앞의 -- 를 지우세요.
--
-- revoke all on public.staff    from anon, authenticated;
-- revoke all on public.journals from anon, authenticated;
-- =============================================================


-- =============================================================
-- 5. 확인용 조회 (실행 후 결과 확인)
-- =============================================================
select table_name, column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
  and table_name in ('staff', 'journals')
order by table_name, ordinal_position;
