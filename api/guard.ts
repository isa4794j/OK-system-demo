/**
 * 관문 — 쿠키에서 "지금 누구인가" 를 알아내고, 이 요청을 받아도 되는지 본다
 *
 * [세 가지 모드 — AUTH_ENFORCE]
 *   true            막는다
 *   비었거나 false   최초 부팅이 끝나면 막는다(자동 잠금). 끝나기 전에만 경고로 남기고 통과
 *   warn            끝까지 막지 않고 경고만 — 비상 되돌리기 전용(잠근 뒤 무언가 어긋날 때)
 * 예전에는 false 가 "경고만" 이었다. 그러면 경고 모드로 부팅한 서버가 끝나고도 열린 채 남는다(2026-09-17 맨땅 점검).
 * 되돌리기 스위치는 이름을 분명히 한 warn 으로 옮겼다 — 배포를 되돌리지 않고 이 값만 바꾸면 된다.
 *
 * [무엇을 보나]
 *   1. 쿠키 → 세션 → 사람
 *   2. 정책표(api/policy.ts)가 이 경로·메서드에 무슨 등급을 요구하는가
 *   3. 그 등급이 되는가, 그리고 PC 화면을 볼 수 있는 계정인가
 *
 * [세션 하나에 조회 두 번]
 * sessions 에서 staff_id 를 얻고, staff 에서 그 사람을 읽는다.
 * PostgREST 로 한 번에 조인해 올 수도 있지만, 그러면 sessions 를 읽는 코드가
 * staff 의 컬럼 목록을 알아야 한다. 표 하나에 /db 파일 하나라는 규칙이 흐려진다.
 */
import { getAccountView } from "../db/accounts.ts";
import { findSession, touchSession } from "../db/sessions.ts";
import type { AccountView } from "../db/accounts.ts";
import type { RequestUser } from "../lib/request_context.ts";
import { atLeast, effectiveRole, type Level } from "../lib/permission.ts";
import { SESSION_COOKIE } from "./cookie.ts";
import { ANY, type Need, PUBLIC, requiredFor } from "./policy.ts";
import { recordWarning } from "./warnings.ts";
import { bootstrapClosed } from "./boot_state.ts";

/** 환경변수 이름. 없으면 안 막는다 — 붙이는 도중에 기본값이 잠그는 쪽이면 안 된다. */
export const ENFORCE_ENV = "AUTH_ENFORCE";

const JSON_HEADERS = { "cache-control": "no-store" };

export type Resolved = {
  session_id: string;
  /** 겸직자가 이 세션에 고른 역할 */
  active_role: string | null;
  account: AccountView;
};

export type AuthMode = "on" | "auto" | "warn";

/** 환경변수 글자 → 모드. 모르는 값은 auto(부팅 뒤 잠금) — 오타가 문을 열어 두지 않게. */
export function authModeOf(value: string | undefined): AuthMode {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "true") return "on";
  if (v === "warn") return "warn";
  return "auto";
}

/** 요청마다 읽는다 — 배포 중에 값을 바꿔도 바로 듣게. */
export function authMode(): AuthMode {
  return authModeOf(Deno.env.get(ENFORCE_ENV));
}

/**
 * 지금 막는가. auto 는 부팅이 끝났는지를 본다 — 확인이 실패하면 막는 쪽으로(열어 두는 쪽으로 틀리지 않게).
 */
export async function isEnforcing(): Promise<boolean> {
  const mode = authMode();
  if (mode !== "auto") return mode === "on";
  try {
    return await bootstrapClosed();
  } catch (error) {
    console.error("[관문] 부팅 상태 확인 실패 — 막는 쪽으로 판단", error);
    return true;
  }
}

/** 요청에 실려 온 세션 토큰. 없으면 null. */
export function readSessionToken(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;

  for (const piece of header.split(";")) {
    const at = piece.indexOf("=");
    if (at < 0) continue;
    if (piece.slice(0, at).trim() === SESSION_COOKIE) {
      return decodeURIComponent(piece.slice(at + 1).trim()) || null;
    }
  }
  return null;
}

/**
 * 쿠키 → 세션 → 사람. 어느 단계든 안 되면 null 이고, 그것은 오류가 아니다.
 *
 * 세션은 살아 있는데 그 사이 계정이 정지되었거나 명단에서 종료된 경우도 여기서 막는다.
 * 정지시킨 순간 열려 있던 창이 계속 도는 일이 없어야 한다.
 */
export async function resolveSession(req: Request): Promise<Resolved | null> {
  const token = readSessionToken(req);
  if (!token) return null;

  const session = await findSession(token);
  if (!session) return null;

  const account = await getAccountView(session.staff_id);
  if (!account) return null;
  if (account.state === "정지") return null;

  // 쉬는 시간 만료를 재는 자리를 민다. 실패해도 요청은 그대로 간다.
  await touchSession(session.id);

  return { session_id: session.id, active_role: session.active_role, account };
}

/** 요청 컨텍스트에 담을 모양으로. 감사 로그가 이 이름을 쓴다. */
export function toRequestUser(
  account: AccountView,
  session: { id: string; active_role: string | null } | null = null,
): RequestUser {
  return {
    id: account.id,
    name: account.name,
    login_name: account.login_name,
    level: account.level,
    access_kind: account.access_kind,
    roles: account.roles,
    active_role: effectiveRole(account.roles, session?.active_role ?? null),
    session_id: session?.id ?? null,
  };
}

/* ---------- 판단 ---------- */

type Verdict =
  | { ok: true }
  | { ok: false; status: 401 | 403; reason: "로그인 필요" | "등급 부족" | "PC 전용" };

function judge(account: AccountView | null, need: Need, pcOnly: boolean): Verdict {
  if (need === PUBLIC) return { ok: true };
  if (!account) return { ok: false, status: 401, reason: "로그인 필요" };

  // 봉사자 계정은 아직 볼 화면이 없다. 6단계에서 제 화면이 생기면 그 경로만 열린다.
  if (pcOnly && account.access_kind === "모바일") {
    return { ok: false, status: 403, reason: "PC 전용" };
  }

  if (need === ANY) return { ok: true };
  if (!atLeast(account.level as Level, need)) {
    return { ok: false, status: 403, reason: "등급 부족" };
  }
  return { ok: true };
}

/**
 * 이 요청을 받아도 되는가.
 *
 * 통과면 null 을 준다. 막아야 하면 그 응답을 준다.
 * 경고 모드에서는 막아야 할 때도 null 을 주고 기록만 남긴다.
 */
export async function checkAccess(
  req: Request,
  pathname: string,
  account: AccountView | null,
): Promise<Response | null> {
  const { need, pcOnly, fallback } = requiredFor(pathname, req.method);
  const verdict = judge(account, need, pcOnly);
  if (verdict.ok) return null;

  recordWarning({
    method: req.method,
    path: pathname,
    who: account?.login_name ?? null,
    level: account?.level ?? null,
    access_kind: account?.access_kind ?? null,
    need,
    fallback,
    reason: verdict.reason,
  });

  // 경고 모드(부팅 전 auto · warn). 막지 않고 통과시킨다.
  if (!(await isEnforcing())) return null;

  const message = verdict.status === 401
    ? "로그인이 필요합니다."
    : verdict.reason === "PC 전용"
    ? "이 계정으로는 볼 수 없는 화면입니다."
    : "권한이 없습니다.";

  return Response.json(
    { error: message, kind: verdict.reason },
    { status: verdict.status, headers: JSON_HEADERS },
  );
}
