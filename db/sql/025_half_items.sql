-- =============================================================
-- OK-system 마이그레이션 025
-- 반기 관찰 15항목과 관찰일자.
--
-- 001~024 가 먼저 실행돼 있어야 합니다. 여러 번 실행해도 안전합니다.
-- =============================================================


-- =============================================================
-- 1. half_observations.observed_on — 관찰일자
--
-- 저장한 날(updated_at)과 본 날은 다르다. 적다 만 것을 며칠 뒤에 이어 쓰면
-- updated_at 은 그날로 바뀌지만, 아이를 본 날은 처음 그날이다.
-- 비워 둘 수 있다 — 023~024 사이에 쓴 기록에는 이 값이 없다.
-- =============================================================

alter table public.half_observations
  add column if not exists observed_on date;

comment on column public.half_observations.observed_on is
  '관찰일자. 저장한 날(updated_at)과 다를 수 있다 — 이어 쓰기가 흔하다.';


-- =============================================================
-- 2. half_observation_items — 예전 시스템과 같은 15항목, 전부 5점 만점
--
-- 코드(h01~h15)는 바뀌지 않는다. scores 가 코드로 점수를 물고 있다.
-- 지운 항목도 목록에 남긴다(deleted: true) — lib/half_items.ts 참고.
--
-- 023 이 넣은 빈 목록일 때만 채운다. 이미 누가 항목을 고쳐 두었으면 덮어쓰지 않는다.
-- =============================================================

update public.settings
set value = '[
  {"code":"h01","area":"생활","max":5,"text":"의복과 몸 상태가 청결하였다."},
  {"code":"h02","area":"생활","max":5,"text":"건강상태가 연령에 따른 발달상황에 맞는다."},
  {"code":"h03","area":"생활","max":5,"text":"남을 도와주는 일이 있었다."},
  {"code":"h04","area":"생활","max":5,"text":"소극적이지 않고 맡겨진 일을 적극적으로 처리하였다."},
  {"code":"h05","area":"생활","max":5,"text":"또래를 포함한 다른 아이들과 잘 어울려 지냈다."},
  {"code":"h06","area":"교육","max":5,"text":"학습 진도를 잘 따랐다."},
  {"code":"h07","area":"교육","max":5,"text":"의도적으로 수업 시간에 늦거나 결석하는 일이 없었다."},
  {"code":"h08","area":"교육","max":5,"text":"떠들거나 장난치지 않고 자율적으로 수업에 참여하였다."},
  {"code":"h09","area":"교육","max":5,"text":"모르는 문제는 반드시 알고 넘어갔다."},
  {"code":"h10","area":"교육","max":5,"text":"독창적인 학습수행 능력을 보여주었다."},
  {"code":"h11","area":"정서","max":5,"text":"생각이 나이에 맞게 고루 발달하는 모습을 보여주었다."},
  {"code":"h12","area":"정서","max":5,"text":"이해와 수용이 필요한 대상에 대해 적절한 수준의 반응을 보였다."},
  {"code":"h13","area":"정서","max":5,"text":"감정의 조절이 잘 이루어졌다."},
  {"code":"h14","area":"정서","max":5,"text":"자신의 생각과 의사를 다른 사람에게 정확히 전달하였다."},
  {"code":"h15","area":"정서","max":5,"text":"거친 행동이 없고 언행이 부드러웠다."}
]'::jsonb
where key = 'half_observation_items'
  and value = '[]'::jsonb;


-- =============================================================
-- 3. 확인용 조회 (실행 후)
-- =============================================================
select jsonb_array_length(value) as 항목수
from public.settings
where key = 'half_observation_items';

select column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name = 'half_observations'
  and column_name = 'observed_on';
