/**
 * 계정 관리 API — 초대코드 발급, 계정 설정
 *
 *   GET    /api/accounts             명단 전체를 계정 눈으로
 *   POST   /api/accounts/:id/code    초대코드 발급·재발급 (평문은 이 응답에만)
 *   DELETE /api/accounts/:id/code    아직 안 쓴 코드 회수
 *   PATCH  /api/accounts/:id         login_name · is_admin · access_kind · 정지/활성
 *                                     (is_admin 이 들어 있으면 관리자만)
 *
 * [관리자 계정은 관리자만]
 * 대상이 관리자 계정이면 코드 발급·회수·설정 변경 모두 관리자만 한다(api/admin_target.ts).
 * 코드 재발급은 곧 비밀번호 재설정이다 — 센터장이 관리자 계정을 가져갈 수 있는 길이었다.
 *
 * 이 파일은 Supabase 를 직접 부르지 않는다. /db 와 /lib 만 쓴다.
 *
 * [★ 5단계에서 관리자·센터장 전용으로 잠긴다]
 * 지금은 관문이 없어 누구나 부를 수 있다. 2단계는 "계정을 다 만드는 단계" 라
 * 잠그면 아무도 계정을 못 만든다. 정책표(4단계)에 이 경로들을 넣을 때
 * 관리자 깃발 지정만 관리자, 나머지는 센터장 이상으로 간다.
 *
 * [초대코드 평문은 여기서 한 번만 나간다]
 * 저장하는 것은 해시다. 이 응답을 놓치면 다시 볼 방법이 없고, 그것이 설계다.
 * 화면도 그 사실을 적어 두어야 한다.
 */
import { NotFoundError, RuleError } from "../db/client.ts";
import {
  countUsableAdmins,
  getAccountSecret,
  issueInviteCode,
  listAccounts,
  updateAccount,
} from "../db/accounts.ts";
import { clearInviteCode } from "../db/accounts.ts";
import { countSessionsByStaff, deleteSessionsOfStaff } from "../db/sessions.ts";
import { ACCESS_KINDS, ACCOUNT_STATUSES } from "../lib/permission.ts";
import { resolveSession } from "./guard.ts";
import { callerIsAdmin, forbidden, refuseAdminTarget } from "./admin_target.ts";

const JSON_HEADERS = { "cache-control": "no-store" };

const LOGIN_NAME_MAX = 100;

function ok(body: unknown): Response {
  return Response.json(body, { headers: JSON_HEADERS });
}

function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400, headers: JSON_HEADERS });
}

function serverError(where: string, error: unknown): Response {
  // 없는 대상은 404, 규칙에 어긋난 요청(없는 사람을 가리킴 등)은 400 — 사람이 읽을 말 그대로(db/client.ts)
  if (error instanceof NotFoundError) {
    return Response.json({ error: error.message }, { status: 404, headers: JSON_HEADERS });
  }
  if (error instanceof RuleError) {
    return Response.json({ error: error.message }, { status: 400, headers: JSON_HEADERS });
  }
  console.error(`[${where}]`, error);
  return Response.json(
    { error: "요청을 처리하지 못했습니다." },
    { status: 500, headers: JSON_HEADERS },
  );
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/* ---------- GET /api/accounts ---------- */

export async function handleAccountsList(): Promise<Response> {
  try {
    const sessions = await countSessionsByStaff();
    return ok({
      accounts: await listAccounts(sessions),
      // 화면이 "마지막 관리자" 를 알아보는 데 쓴다. 세는 기준은 서버가 갖고 있어야
      // 화면과 서버가 다른 답을 내지 않는다.
      usable_admins: await countUsableAdmins(),
    });
  } catch (error) {
    return serverError("GET /api/accounts", error);
  }
}

/* ---------- POST /api/accounts/:id/code ---------- */

/**
 * 초대코드를 발급한다. 이미 있으면 새것이 옛것을 덮고, 그 순간 옛 코드는 무효다.
 *
 * 비밀번호가 이미 있는 사람에게도 발급할 수 있다 — 비번을 잊은 경우가 그것이다.
 * 그때는 코드로 비번을 다시 정하게 되고, 새 비번이 옛 비번을 덮는다.
 * 다만 그 사람의 세션은 여기서 끊는다. 비번을 잃어버렸다는 것은
 * 남이 쓰고 있을 수 있다는 뜻이기도 하다.
 */
export async function handleIssueCode(req: Request, id: string): Promise<Response> {
  const refused = await refuseAdminTarget(id);
  if (refused) return refused;

  try {
    const account = await getAccountSecret(id);
    if (!account) {
      return Response.json({ error: "그 사람을 찾지 못했습니다." }, {
        status: 404,
        headers: JSON_HEADERS,
      });
    }
    if (account.status === "종료") {
      return badRequest("명단에서 종료된 사람에게는 발급할 수 없습니다.");
    }

    const who = await resolveSession(req);
    const { code, expiresAt } = await issueInviteCode(id, who?.account.id ?? null);

    // 비번을 다시 정하러 온 사람이면 열려 있던 창을 끊는다.
    const closed = account.password_hash ? await deleteSessionsOfStaff(id) : 0;

    return ok({
      // 평문이 나가는 유일한 자리. 화면이 한 번 보여 주고 잊는다.
      code,
      expires_at: expiresAt,
      name: account.name,
      login_name: account.login_name,
      closed_sessions: closed,
    });
  } catch (error) {
    return serverError("POST /api/accounts/:id/code", error);
  }
}

/* ---------- DELETE /api/accounts/:id/code ---------- */

/** 잘못 발급했을 때 무른다. 이미 비번을 정한 사람에게는 할 일이 없다. */
export async function handleRevokeCode(id: string): Promise<Response> {
  const refused = await refuseAdminTarget(id);
  if (refused) return refused;

  try {
    await clearInviteCode(id);
    return ok({ ok: true });
  } catch (error) {
    return serverError("DELETE /api/accounts/:id/code", error);
  }
}

/* ---------- PATCH /api/accounts/:id ---------- */

export async function handleAccountUpdate(req: Request, id: string): Promise<Response> {
  const body = await readJson(req);
  if (!body) return badRequest("요청 본문이 JSON이 아닙니다.");

  // 관리자 깃발은 관리자만 바꾼다. 이 경로 자체는 센터장에게 열려 있어서(정책표)
  // 관문으로는 못 가르고, 본문을 보는 여기서 가른다. 스스로 깃발을 붙일 수 있으면
  // 등급 구분이 뜻이 없다.
  //
  // 값을 읽기 전에, DB 를 부르기 전에 막는다 — 같은 값을 보내는 것도,
  // 마지막 관리자 검사도 권한이 없으면 볼 일이 아니다.
  // 잠금(AUTH_ENFORCE) 여부와 무관하다. 로그인이 없으면 관리자가 아니다.
  if ("is_admin" in body && !callerIsAdmin()) {
    return forbidden("관리자 지정·해제는 관리자만 할 수 있습니다.");
  }
  // 대상이 관리자 계정이면 로그인 이름·접속 권한·정지도 관리자만.
  const refused = await refuseAdminTarget(id);
  if (refused) return refused;

  const patch: {
    login_name?: string;
    is_admin?: boolean;
    access_kind?: "PC" | "모바일";
    account_status?: string;
  } = {};

  if ("login_name" in body) {
    const value = typeof body.login_name === "string" ? body.login_name.trim() : "";
    if (!value || value.length > LOGIN_NAME_MAX) {
      return badRequest(`로그인 이름은 비어 있을 수 없고 ${LOGIN_NAME_MAX}자를 넘을 수 없습니다.`);
    }
    patch.login_name = value;
  }

  if ("is_admin" in body) {
    if (typeof body.is_admin !== "boolean") return badRequest("관리자 여부가 올바르지 않습니다.");
    patch.is_admin = body.is_admin;
  }

  if ("access_kind" in body) {
    const value = body.access_kind;
    if (typeof value !== "string" || !(ACCESS_KINDS as readonly string[]).includes(value)) {
      return badRequest("접속 권한은 PC 또는 모바일이어야 합니다.");
    }
    patch.access_kind = value as "PC" | "모바일";
  }

  if ("account_status" in body) {
    const value = body.account_status;
    if (typeof value !== "string" || !(ACCOUNT_STATUSES as readonly string[]).includes(value)) {
      return badRequest("계정 상태는 활성 또는 정지여야 합니다.");
    }
    patch.account_status = value;
  }

  if (Object.keys(patch).length === 0) return badRequest("바꿀 내용이 없습니다.");

  try {
    // 마지막 관리자를 풀거나 정지하면 아무도 계정을 발급할 수 없게 된다.
    // 화면도 그 버튼을 막지만 그건 편의고, 실제로 막는 것은 여기다.
    const losesAdmin = patch.is_admin === false || patch.account_status === "정지";
    if (losesAdmin) {
      const before = await getAccountSecret(id);
      if (before?.is_admin && (await countUsableAdmins(id)) === 0) {
        return badRequest(
          "마지막 관리자는 해제/정지할 수 없습니다. 다른 계정에 먼저 관리자를 지정하세요.",
        );
      }
    }

    const account = await updateAccount(id, patch);

    // 정지시킨 순간 열려 있던 창이 계속 도는 일이 없어야 한다.
    // 세션을 안 끊으면 8시간 동안 정지가 적용되지 않은 것과 같다.
    let closed = 0;
    if (patch.account_status === "정지") closed = await deleteSessionsOfStaff(id);

    return ok({ account, closed_sessions: closed });
  } catch (error) {
    if (error instanceof NotFoundError) return serverError("PATCH /api/accounts/:id", error);
    const message = error instanceof Error ? error.message : "";
    if (message.includes("이미 다른 사람이") || message.includes("찾지 못했습니다")) {
      return badRequest(message);
    }
    return serverError("PATCH /api/accounts/:id", error);
  }
}
