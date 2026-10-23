-- =============================================================
-- OK-system 마이그레이션 013
-- 감사 로그: audit_logs
--
-- 실행 순서: 위에서 아래로 통째로 실행하면 됩니다.
-- 여러 번 실행해도 안전하도록 if not exists 를 썼습니다.
--
-- [왜 만드나]
-- 일지와 관찰이 화면 삭제로 사라졌는데 누가 언제 지웠는지, 무슨 값이었는지
-- 알 길이 없었다. 이 표는 그 질문에 답하려고 있다.
-- 지운 값(before)을 통째로 남기므로, 실수로 지웠을 때 이걸 보고 손으로 되살릴 수 있다.
--
-- [★ 관리자 전용]
-- before/after 에는 아동 이름·보호자 연락처·주소 같은 민감정보가 그대로 들어간다.
-- 감사 로그를 가리면 감사가 안 되기 때문이다. 대신 이 표 자체를 관리자만 보게 한다.
-- 로그인이 생기면 RLS 정책과 API 양쪽에서 관리자만 읽게 건다. 지금은 그 자리만 표시한다.
--
-- [지우지 않는다]
-- 감사 로그는 삭제하지 않는다. 오래된 것은 나중에 at 기준으로 다른 표나 파일로 옮긴다.
-- 그래서 at 에 인덱스를 둔다.
-- =============================================================

create table if not exists public.audit_logs (
  id          uuid        primary key default gen_random_uuid(),

  -- 언제
  at          timestamptz not null default now(),

  -- 누가. 지금은 로그인이 없어 null. 로그인이 붙으면 사용자 id 나 이름.
  actor       text,

  -- 무엇을 했나. 중요한 것만 남긴다 — 삭제 전부, 주요 수정, 아동·직원 등록.
  action      text        not null check (action in ('create', 'update', 'delete')),

  -- 어느 표의 어느 행
  table_name  text        not null,
  record_id   uuid,

  -- 사람이 읽을 한 줄. 예: "아동 테스원 삭제 — 관찰 6건, 평가 1건 함께"
  summary     text        not null,

  -- 바뀌기 전 값. 삭제·수정 때. 딸린 기록이 함께 지워졌으면 그것도 안에 담는다.
  before      jsonb,

  -- 바뀐 뒤 값. 수정·등록 때.
  after       jsonb
);

-- 최근 것부터 보는 화면과, 나중에 오래된 것을 옮기는 일 둘 다 이 인덱스를 탄다
create index if not exists idx_audit_logs_at
  on public.audit_logs (at desc);

-- 특정 행의 이력을 찾을 때
create index if not exists idx_audit_logs_record
  on public.audit_logs (table_name, record_id);

comment on table public.audit_logs is
  '감사 로그: 삭제 전부·주요 수정·아동/직원 등록. before 에 지운 값이 통째로 남는다. ★ 관리자 전용.';
comment on column public.audit_logs.actor is
  '누가. 로그인 전에는 null. 로그인이 붙으면 사용자 id 나 이름.';
comment on column public.audit_logs.before is
  '바뀌기 전 값. 민감정보가 그대로 들어간다 — 이 표 자체를 관리자만 보게 한다.';


-- =============================================================
-- RLS — 지금은 켜지 않는다. 다만 이 표는 로그인 뒤 반드시 관리자 전용으로 건다.
--
--   alter table public.audit_logs enable row level security;
--   create policy audit_admin_only on public.audit_logs
--     for select using (auth.jwt() ->> 'role' = 'admin');
--
-- 쓰기는 서버(service_role)만 한다. anon·authenticated 에 insert 를 주지 않는다.
-- 009 의 default privileges 회수가 이미 돌았다면 이 표에도 권한이 붙지 않는다.
-- =============================================================
