-- =============================================================
-- OK-system 마이그레이션 034
-- 개인정보 처리 동의 기록 칸 둘
--   staff.privacy_agreed_at        직원·봉사자가 로그인 화면에서 처리 안내에 동의한 때
--   children_identity.consent_date  아동 개인정보 동의서(종이)를 받은 날 — 선택, 기록만
--
-- 여러 번 실행해도 안전합니다(if not exists). 값은 채우지 않습니다 —
-- 기존 계정은 모두 "아직" 으로 남고, 다음 로그인 때 한 번 동의 화면이 뜹니다.
-- 동의 문구 자체는 settings(consent_form·privacy_policy)에 있고 화면에서 고칩니다(코드 기본값만 앱에 있음).
-- =============================================================

alter table public.staff
  add column if not exists privacy_agreed_at timestamptz;

comment on column public.staff.privacy_agreed_at is
  '개인정보 처리 안내 동의 시각(034). null = 아직 — 다음 로그인 때 묻는다';

alter table public.children_identity
  add column if not exists consent_date date;

comment on column public.children_identity.consent_date is
  '개인정보 동의서를 받은 날(034, 선택). 기록만 하며 제외 로직은 없다';
