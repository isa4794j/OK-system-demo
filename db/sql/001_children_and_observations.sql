-- =============================================================
-- OK-system 마이그레이션 001
-- 아동 축 핵심 테이블 2개: children_identity, observations
--
-- 실행 순서: 이 파일을 위에서 아래로 통째로 실행하면 됩니다.
--   1) children_identity  (먼저 — observations가 이걸 참조하므로)
--   2) observations
-- 여러 번 실행해도 안전하도록 if not exists / or replace 를 사용했습니다.
--
-- 설계 원칙 (3단 분리):
--   children_identity = 아동을 특정할 수 있는 신원정보 (이름, 연락처, 주소)
--   observations      = 아동에 대한 기록. 이름을 절대 넣지 않고 child_id로만 연결
--   두 테이블을 물리적으로 분리해, 기록만 다루는 화면/쿼리에서는
--   신원 테이블을 아예 조회하지 않도록 한다.
-- =============================================================


-- =============================================================
-- 0. 공통: updated_at 자동 갱신 함수
--    UPDATE가 일어날 때마다 updated_at을 현재 시각으로 바꿔준다.
--    (애플리케이션이 깜빡해도 DB가 보장)
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
-- 1. children_identity  [민감] 아동 신원
-- =============================================================
create table if not exists public.children_identity (
  -- 기본키. uuid 사용 (이유는 파일 맨 아래 [id 타입 선택] 참고)
  id                uuid        primary key default gen_random_uuid(),

  -- 이름. 필수이며 공백만 들어가는 것도 막는다
  name              text        not null check (length(btrim(name)) > 0),

  -- 생년월일
  birth_date        date,

  -- 성별. 값을 제한해 오타나 표기 흔들림을 막는다 (모르면 NULL)
  gender            text        check (gender in ('남', '여')),

  -- 재학 중인 학교
  school            text,

  -- 입소일
  enroll_date       date,

  -- 종결일. 아직 재원 중이면 NULL
  exit_date         date,

  -- 상태. 기본값 재원
  status            text        not null default '재원'
                                check (status in ('재원', '종결')),

  -- 보호자 관계 (예: 모, 부, 조모, 위탁)
  guardian_relation text,

  -- 보호자 연락처
  guardian_contact  text,

  -- 주소
  address           text,

  -- 의뢰 배경 / 입소 경위 메모
  referral_note     text,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- 종결일이 입소일보다 앞설 수 없다 (둘 중 하나가 NULL이면 검사하지 않음)
  constraint children_identity_exit_after_enroll
    check (exit_date is null or enroll_date is null or exit_date >= enroll_date)
);

-- 이름으로 아동을 찾는 조회가 잦으므로 인덱스를 둔다
create index if not exists idx_children_identity_name
  on public.children_identity (name);

-- 재원/종결 목록 분리 조회용
create index if not exists idx_children_identity_status
  on public.children_identity (status);

-- UPDATE 시 updated_at 자동 갱신
drop trigger if exists trg_children_identity_updated_at on public.children_identity;
create trigger trg_children_identity_updated_at
  before update on public.children_identity
  for each row execute function public.set_updated_at();

-- 대시보드 Table Editor에서 보이는 설명
comment on table public.children_identity is
  '민감정보: 아동 신원. 이름/연락처/주소 등 아동을 특정할 수 있는 정보만 여기 둔다.';
comment on column public.children_identity.status is
  '재원 또는 종결. 퇴소는 행을 삭제하지 말고 이 값을 종결로 바꾼다.';
comment on column public.children_identity.exit_date is
  '종결일. 재원 중이면 NULL.';


-- =============================================================
-- 2. observations  [개인] 관찰 기록 — 이름 없음
--    이 테이블에는 아동 이름을 절대 넣지 않는다. child_id로만 연결.
-- =============================================================
create table if not exists public.observations (
  id                uuid        primary key default gen_random_uuid(),

  -- 어느 아동에 대한 기록인지. children_identity.id를 참조하는 외래키.
  --
  -- [삭제 동작 추천: on delete restrict]
  --   restrict = 관찰 기록이 남아 있는 아동은 삭제 자체가 거부된다.
  --   실수로 아동 한 행을 지웠을 때 몇 년치 기록이 조용히 함께 사라지는
  --   사고를 막는 것이 이 시스템에서는 가장 중요하다고 판단했다.
  --   퇴소는 삭제가 아니라 status를 종결로 바꿔 처리하므로 평소엔 걸릴 일이 없다.
  --
  --   대안: on delete cascade
  --     아동을 지우면 관찰도 함께 삭제된다. 개인정보 파기 요청처럼
  --     흔적까지 전부 지워야 할 때는 편하지만 되돌릴 수 없다.
  --     파기가 필요하면 restrict를 유지한 채 observations를 먼저 지우고
  --     children_identity를 지우는 편이, 지운다는 판단을 명시적으로
  --     남길 수 있어 더 안전하다.
  --
  --   on update cascade는 id가 바뀌는 일이 사실상 없지만 관례상 넣어둔다.
  child_id          uuid        not null
                                references public.children_identity (id)
                                on update cascade
                                on delete restrict,

  -- 관찰한 날짜 (기록을 입력한 날이 아니라 관찰이 일어난 날)
  obs_date          date        not null default current_date,

  -- 영역. 미지정 가능(NULL)
  area              text        check (area in (
                                  '건강', '학습', '또래관계',
                                  '행동정서', '보호자요구', '연계'
                                )),

  -- 관찰 내용
  content           text        not null check (length(btrim(content)) > 0),

  -- 이 기록이 어디서 나왔는지. 미지정 가능(NULL)
  source            text        check (source in (
                                  '멘토', '봉사', '프로그램', '일상', '회의'
                                )),

  -- 원본 요약 id. 나중에 요약 테이블에서 관찰을 뽑아올 때 추적용.
  -- 요약 테이블이 아직 없으므로 지금은 외래키를 걸지 않는다.
  -- (요약 테이블을 만들 때 alter table로 FK를 추가할 것)
  source_summary_id uuid,

  created_at        timestamptz not null default now()
);

-- 가장 잦은 조회: 이 아동의 기록을 최근 순으로
create index if not exists idx_observations_child_date
  on public.observations (child_id, obs_date desc);

-- 기간별 전체 조회 (예: 이번 달 기록 전부)
create index if not exists idx_observations_obs_date
  on public.observations (obs_date desc);

-- 요약에서 생성된 기록 역추적용
create index if not exists idx_observations_source_summary
  on public.observations (source_summary_id)
  where source_summary_id is not null;

comment on table public.observations is
  '개인정보: 관찰 기록. 아동 이름을 넣지 않는다. 아동은 child_id로만 가리킨다.';
comment on column public.observations.child_id is
  'children_identity.id 참조. 이 테이블에 이름을 중복 저장하지 말 것.';
comment on column public.observations.source_summary_id is
  '원본 요약 id. 요약 테이블 생성 후 외래키를 추가할 예정.';


-- =============================================================
-- 3. RLS (행 수준 보안) — 지금은 켜지 않는다
--
-- 현재 접근 경로는 Deno 서버의 service_role 키 하나뿐이고,
-- service_role은 RLS를 우회하므로 지금 정책을 짜도 동작을 검증할 수 없다.
-- 로그인(직원 계정 / 역할 구분)을 설계할 때 정책과 함께 켠다.
--
-- 그때 할 일:
--   alter table public.children_identity enable row level security;
--   alter table public.observations      enable row level security;
--   + 역할별 select/insert/update 정책 작성
--     (예: 일반 교사는 담당 아동만, 센터장은 전체)
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
-- 아래 두 줄을 실행하면 anon/authenticated의 권한 자체를 회수한다.
-- service_role은 영향받지 않으므로 지금 서버 코드는 그대로 동작한다.
-- 로그인 붙이면서 RLS 정책을 짤 때 다시 grant 하면 된다.
-- 실행하려면 앞의 -- 를 지우세요.
--
-- revoke all on public.children_identity from anon, authenticated;
-- revoke all on public.observations      from anon, authenticated;
-- =============================================================


-- =============================================================
-- 5. 확인용 조회 (실행 후 결과 확인)
-- =============================================================
select table_name, column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
  and table_name in ('children_identity', 'observations')
order by table_name, ordinal_position;


-- =============================================================
-- [id 타입 선택] bigint 자동증가 vs uuid  ->  uuid 추천
--
--   bigint (generated always as identity)
--     장점: 짧고 사람이 읽기 쉬우며 인덱스가 조금 더 작고 빠르다.
--     단점: 1, 2, 3... 으로 이어져 /api/children/3 처럼 주소만 바꿔
--           남의 아동 기록을 넘겨볼 수 있고, 총 몇 명인지도 노출된다.
--
--   uuid (gen_random_uuid())
--     장점: 값이 예측 불가능해 URL이나 API로 다른 아동 기록을 훑을 수 없다.
--           로컬/운영 DB 데이터를 합칠 때 id가 충돌하지 않는다.
--     단점: 길어서 눈으로 읽기 불편하고, 저장 공간이 8바이트 더 든다.
--
--   -> 아동 개인정보를 다루는 시스템이라 열거(enumeration) 차단이
--      성능이나 가독성보다 중요하다고 보고 uuid를 선택했다.
--      이 규모(센터 한 곳, 수백~수천 행)에서 uuid의 성능 손해는 체감되지 않는다.
--      화면에 보여줄 관리번호가 따로 필요하면 나중에 별도 컬럼으로 추가하면 된다.
-- =============================================================
