/**
 * 관문 경고 API — 잠갔으면 막혔을 요청 목록  ★ 관리자 전용
 *
 *   GET    /api/guard-warnings   최근 것부터
 *   DELETE /api/guard-warnings   비운다 (정책표를 고친 뒤 다시 세려고)
 *
 * 4단계에서만 뜻이 있다. 잠근 뒤에는 이 목록이 조용해지고, 그 조용함이
 * "정책표가 맞다" 는 뜻이다. 목록에 무언가 쌓이면 그때는 실제로 막힌 것이다.
 */
import { clearWarnings, listWarnings } from "./warnings.ts";
import { authMode, isEnforcing } from "./guard.ts";

const JSON_HEADERS = { "cache-control": "no-store" };

export async function handleWarningsList(): Promise<Response> {
  const warnings = listWarnings();
  return Response.json({
    warnings,
    // 지금 막고 있는가. 화면이 "경고만" 인지 "잠김" 인지 적는 데 쓴다.
    enforcing: await isEnforcing(),
    mode: authMode(),
    total: warnings.reduce((sum, one) => sum + one.count, 0),
  }, { headers: JSON_HEADERS });
}

export function handleWarningsClear(): Promise<Response> {
  clearWarnings();
  return Promise.resolve(Response.json({ ok: true }, { headers: JSON_HEADERS }));
}
