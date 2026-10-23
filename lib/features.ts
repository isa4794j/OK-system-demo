/**
 * 기능 스위치 — 끈 기능의 입구를 한 곳에서 닫는다
 *
 * [반기별 관찰] 2026-09-17 숨김 — 데이터 보존, 복원 가능.
 *   봉사자가 반기마다 아이별 점수를 적던 기능(half_observations).
 *   닫은 것: /api/my/children · /api/my/observations/:id · /api/children/:id/growth ·
 *            설정 half_observation_open·half_observation_items(읽기·쓰기) — 404.
 *            평가 조회의 정량 참고(quant)는 늘 null.
 *   그대로인 것: half_observations 테이블·데이터·마이그레이션(023~025), 정책표 줄,
 *            아동 삭제 연쇄(027 — 반기 관찰도 함께 지움), 감사 로그, 핸들러 코드(lib/half*.ts, api/my.ts, api/growth.ts).
 *   되살리기: 이 값을 true 로 + 화면 입구 — PC web/assets/features.js(HALF_OBSERVATION),
 *            폰 web/m.html 배너·web/assets/m/app.js SCREENS·web/assets/m/journal.js 입구(주석에 적어 둠).
 */
export const HALF_OBSERVATION_ENABLED = false;

/** 닫힌 입구의 답 — 없는 주소와 같게 404 */
export function featureClosed(): Promise<Response> {
  return Promise.resolve(Response.json(
    { error: "지금은 쓰지 않는 기능입니다(반기별 관찰 — 기록은 보존되어 있습니다)." },
    { status: 404, headers: { "cache-control": "no-store" } },
  ));
}
