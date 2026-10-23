/**
 * 관리자 계정 보호 — "관리자 계정에 대한 모든 변경은 관리자만"
 *
 * [왜 핸들러에서 보나]
 * 계정·명단 경로(/api/accounts/:id, /api/staff/:id)는 정책표에서 센터장에게 열려 있다.
 * 센터장이 일반 직원의 계정을 발급·정지하는 것은 맞는 일이다. 막아야 하는 것은
 * "대상이 관리자일 때" 뿐인데, 그건 경로가 아니라 대상 행을 봐야 알 수 있다.
 * 그래서 관문(정책표)이 아니라 핸들러가 판단한다 — 관리자 깃발(is_admin) 검사와 같은 자리.
 *
 * [순서]
 *   1. 본문 읽기
 *   2. 권한 — 깃발 필드 검사, 그리고 이 검사(대상이 관리자인가)
 *   3. 값 모양 검사
 *   4. 마지막 관리자 보호
 *   5. 실제 변경
 * 권한이 먼저다. 권한이 없는 사람에게 "마지막 관리자라 안 된다" 나 "값이 틀렸다" 를
 * 먼저 알려 줄 이유가 없다.
 *
 * [안 되면 막는 쪽으로]
 * 대상 조회가 실패하면 통과시키지 않고 500 을 준다. 모를 때 여는 것이 가장 나쁘다.
 */
import { isAdminStaff } from "../db/accounts.ts";
import { currentUser } from "../lib/request_context.ts";

const JSON_HEADERS = { "cache-control": "no-store" };

export const ADMIN_TARGET_MESSAGE = "관리자 계정은 관리자만 바꿀 수 있습니다.";

/**
 * 대상 조회. 테스트가 DB 없이 갈래를 확인하려고 바꿔 끼운다 — 그 외에는 건드리지 않는다.
 */
export const targetLookup = { isAdmin: isAdminStaff };

/** 지금 요청을 보낸 사람이 관리자인가. 로그인이 없으면 아니다(잠금 설정과 무관). */
export function callerIsAdmin(): boolean {
  return currentUser()?.level === "관리자";
}

export function forbidden(message: string): Response {
  return Response.json({ error: message }, { status: 403, headers: JSON_HEADERS });
}

/**
 * 대상이 관리자 계정이고 부른 사람이 관리자가 아니면 403 응답을 준다. 통과면 null.
 *
 * 부른 사람이 관리자면 DB 를 부르지 않는다. 없는 id 는 통과시킨다 —
 * "찾지 못했습니다" 는 원래 핸들러가 알려 준다.
 */
export async function refuseAdminTarget(id: string): Promise<Response | null> {
  if (callerIsAdmin()) return null;
  try {
    if (!(await targetLookup.isAdmin(id))) return null;
  } catch (error) {
    console.error("[admin-target] 대상 조회 실패 — 막는다", error);
    return Response.json(
      { error: "요청을 처리하지 못했습니다." },
      { status: 500, headers: JSON_HEADERS },
    );
  }
  return forbidden(ADMIN_TARGET_MESSAGE);
}
