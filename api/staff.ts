/**
 * 직원 API
 *
 *   GET   /api/staff?role=생활복지사             한 역할
 *   GET   /api/staff?role=멘토&role=봉사자        여러 역할
 *   GET   /api/staff?...&status=전체              그만둔 사람까지
 *   POST  /api/staff                              등록 (이름이 명단 종료자와 겹치면 409 + 풀 방법,
 *                                                  release_login_of 를 주면 그 종료자 로그인 이름을 이름_001 로 바꾸고 등록)
 *   PATCH /api/staff/:id                          수정 (상태 변경 포함)
 *   GET   /api/staff/:id/records-count            딸린 일지·일정 수 (삭제 확인창용) + 역할별 기록 수(겸직 해제 경고용)
 *   DELETE /api/staff/:id                         삭제 — 일지가 있으면 거절(종료로 안내), 일정은 함께 사라진다
 *   GET   /api/staff/scheduled?date=YYYY-MM-DD    그 날 일정이 있는 사람
 *
 * 이 파일은 Supabase를 직접 부르지 않는다. /db의 함수만 사용한다.
 *
 * [관리자 계정은 관리자만]
 * 명단의 사람이 곧 계정이다. 관리자인 사람의 수정(이름은 로그인 이름과 짝, 종료는
 * 로그인 차단)과 삭제는 관리자만 한다(api/admin_target.ts). 마지막 관리자를
 * 종료·삭제하는 것은 관리자라도 막는다 — 계정 화면의 정지와 같은 이유다.
 */
import {
  addStaff,
  countRecordsByRole,
  countStaffRecords,
  deleteStaff,
  listStaff,
  LoginNameTakenError,
  type Role,
  ROLES,
  STAFF_STATUSES,
  type StaffStatus,
  updateStaff,
} from "../db/staff.ts";
import { listStaffScheduledOn } from "../db/schedules.ts";
import {
  clearPasswordForReturn,
  countUsableAdmins,
  findByLoginName,
  getAccountSecret,
  isAdminStaff,
  nextFreeLoginName,
  updateAccount,
} from "../db/accounts.ts";
import { deleteSessionsOfStaff } from "../db/sessions.ts";
import { NotFoundError, RuleError } from "../db/client.ts";
import { refuseAdminTarget } from "./admin_target.ts";
import { normalizeRoles } from "../lib/permission.ts";

const LAST_ADMIN = "마지막 관리자는 종료·삭제할 수 없습니다. 다른 계정에 먼저 관리자를 지정하세요.";

/** 이 사람을 빼면 들어올 수 있는 관리자가 하나도 안 남는가 */
async function isLastAdmin(id: string): Promise<boolean> {
  return (await isAdminStaff(id)) && (await countUsableAdmins(id)) === 0;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 이름·전화 길이 상한. DB의 text 에는 제한이 없어 여기서 막는다. */
const NAME_MAX = 100;
const PHONE_MAX = 50;

const JSON_HEADERS = { "cache-control": "no-store" };

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

function ok(body: unknown): Response {
  return Response.json(body, { headers: JSON_HEADERS });
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/** 이름은 비어 있으면 안 되고 상한을 넘으면 안 된다. 잘못되면 null. */
function parseName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > NAME_MAX) return null;
  return trimmed;
}

/** 전화는 없어도 된다. 빈 문자열은 null 로 본다. 너무 길면 undefined(오류). */
function parsePhone(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > PHONE_MAX ? undefined : trimmed;
}

/**
 * 역할 목록을 읽는다. roles(배열)를 받고, 옛 화면이 보내는 role(하나)도 받는다.
 * 하나 이상, 모두 아는 역할이어야 한다. 모양이 틀리면 null.
 */
function parseRoles(body: Record<string, unknown>): Role[] | null {
  const raw = Array.isArray(body.roles) ? body.roles : "role" in body ? [body.role] : null;
  if (!raw || raw.length === 0) return null;
  if (!raw.every((one) => isRole(one))) return null;
  const roles = normalizeRoles(raw) as Role[];
  return roles.length > 0 ? roles : null;
}

const ROLES_MESSAGE = "역할(멘토/봉사자/센터장/생활복지사)을 하나 이상 골라 주세요.";

/* ---------- GET /api/staff ---------- */

export async function handleStaffList(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;

  // role 은 여러 번 올 수 있다 (?role=멘토&role=봉사자)
  const roles = params.getAll("role").map((value) => value.trim()).filter(Boolean);
  for (const role of roles) {
    if (!isRole(role)) return badRequest(`role 값이 올바르지 않습니다: ${role}`);
  }

  // status 를 주지 않으면 활동중만. 지금 고를 수 있는 사람을 뽑는 쓰임이 대부분이라
  // 그쪽을 기본으로 두고, 명단 화면처럼 전부 필요한 곳만 "전체"를 넘긴다.
  const statusParam = params.get("status")?.trim() ?? "";
  let status: StaffStatus | null = "활동중";
  if (statusParam === "전체") {
    status = null;
  } else if (statusParam) {
    if (!(STAFF_STATUSES as readonly string[]).includes(statusParam)) {
      return badRequest("status 는 활동중, 종료, 전체 중 하나여야 합니다.");
    }
    status = statusParam as StaffStatus;
  }

  try {
    const staff = await listStaff(roles as Role[], status);
    return ok({ staff });
  } catch (error) {
    return serverError("GET /api/staff", error);
  }
}

/* ---------- POST /api/staff ---------- */

export async function handleStaffCreate(req: Request): Promise<Response> {
  const body = await readJson(req);
  if (!body) return badRequest("요청 본문이 JSON이 아닙니다.");

  const name = parseName(body.name);
  if (name === null) {
    return badRequest(`이름은 비어 있을 수 없고 ${NAME_MAX}자를 넘을 수 없습니다.`);
  }

  // 역할은 반드시 하나 이상 골라야 한다(겸직이면 여럿).
  // 비워 두면 나중에 명단·스케줄에서 이 사람이 어디에도 안 잡힌다.
  const roles = parseRoles(body);
  if (!roles) return badRequest(ROLES_MESSAGE);

  const phone = parsePhone(body.phone);
  if (phone === undefined) return badRequest(`전화번호는 ${PHONE_MAX}자를 넘을 수 없습니다.`);

  // [종료자 이름 풀기] — 사람이 충돌 창에서 고른 경우에만 온다. 그 사람의 로그인 이름을
  // 이름_001(빈 번호)로 바꾸고 등록을 이어 간다. 자동으로는 절대 하지 않는다(CLAUDE.md).
  const releaseId = typeof body.release_login_of === "string" ? body.release_login_of.trim() : "";
  if (releaseId) {
    if (!UUID_RE.test(releaseId)) return badRequest("release_login_of 형식이 올바르지 않습니다.");
    const refused = await refuseAdminTarget(releaseId);
    if (refused) return refused;
    try {
      const holder = await getAccountSecret(releaseId);
      const sameKey = (a: string | null | undefined) => String(a ?? "").trim().toLowerCase();
      if (!holder || holder.status !== "종료" || sameKey(holder.login_name) !== sameKey(name)) {
        return badRequest("그 이름을 쥔 명단 종료자가 아닙니다. 화면을 새로 고쳐 주세요.");
      }
      const renamed = await nextFreeLoginName(holder.login_name);
      await updateAccount(releaseId, { login_name: renamed });
    } catch (error) {
      return serverError("POST /api/staff (종료자 이름 풀기)", error);
    }
  }

  try {
    const person = await addStaff(name, roles, phone);
    return ok({ staff: person });
  } catch (error) {
    // 같은 이름이 이미 있으면 로그인 이름이 겹쳐 DB 가 막는다.
    if (error instanceof LoginNameTakenError) return await nameConflict(name, error.message);
    return serverError("POST /api/staff", error);
  }
}

/**
 * 이름 충돌. 그 이름을 쥔 사람이 **명단 종료자**면 409 와 함께 풀 방법을 준다
 * (화면이 [종료자를 ○○_001로 바꾸고 이 이름 쓰기] / [다른 이름으로] 를 띄운다).
 * 활동중인 사람과 겹치면 예전처럼 다른 이름 안내만(400).
 */
async function nameConflict(name: string, message: string): Promise<Response> {
  try {
    const holders = await findByLoginName(name);
    const holder = holders.length === 1 ? holders[0] : null;
    if (!holder || holder.status !== "종료") return badRequest(message);
    return Response.json(
      {
        error: `"${name}" 은(는) 명단에서 종료된 사람이 로그인 이름으로 쓰고 있습니다.`,
        conflict: {
          holder_id: holder.id,
          holder_name: holder.name,
          // 관리자 계정이면 로그인 이름 바꾸기는 관리자만 — 화면이 버튼을 잠그는 데 쓴다
          holder_is_admin: holder.is_admin,
          suggested: await nextFreeLoginName(holder.login_name),
        },
      },
      { status: 409, headers: JSON_HEADERS },
    );
  } catch (error) {
    return serverError("POST /api/staff (이름 충돌 확인)", error);
  }
}

/* ---------- PATCH /api/staff/:id ---------- */

export async function handleStaffUpdate(req: Request, id: string): Promise<Response> {
  const body = await readJson(req);
  if (!body) return badRequest("요청 본문이 JSON이 아닙니다.");

  const refused = await refuseAdminTarget(id);
  if (refused) return refused;

  const patch: {
    name?: string;
    roles?: Role[];
    phone?: string | null;
    status?: StaffStatus;
  } = {};

  if ("name" in body) {
    const name = parseName(body.name);
    if (name === null) {
      return badRequest(`이름은 비어 있을 수 없고 ${NAME_MAX}자를 넘을 수 없습니다.`);
    }
    patch.name = name;
  }

  if ("roles" in body || "role" in body) {
    // 역할을 빼도 그 역할로 남긴 기록(as_role)은 지우지 않는다 — 표시만 남는다.
    // 몇 건이 남는지는 화면이 records-count 로 먼저 알린다.
    const roles = parseRoles(body);
    if (!roles) return badRequest(ROLES_MESSAGE);
    patch.roles = roles;
  }

  if ("phone" in body) {
    const phone = parsePhone(body.phone);
    if (phone === undefined) return badRequest(`전화번호는 ${PHONE_MAX}자를 넘을 수 없습니다.`);
    patch.phone = phone;
  }

  if ("status" in body) {
    if (
      typeof body.status !== "string" ||
      !(STAFF_STATUSES as readonly string[]).includes(body.status)
    ) {
      return badRequest("상태는 활동중 또는 종료여야 합니다.");
    }
    patch.status = body.status as StaffStatus;
  }

  if (Object.keys(patch).length === 0) {
    return badRequest("바꿀 내용이 없습니다.");
  }

  try {
    if (patch.status === "종료" && (await isLastAdmin(id))) return badRequest(LAST_ADMIN);
    const before = patch.status === "활동중" ? await getAccountSecret(id) : null;
    const person = await updateStaff(id, patch);

    // 종료 → 활동중: 옛 비밀번호로는 못 들어온다. 초대코드를 새로 받아 시작한다.
    let passwordCleared = false;
    if (before?.status === "종료" && person.status === "활동중") {
      passwordCleared = await clearPasswordForReturn(id);
      if (passwordCleared) await deleteSessionsOfStaff(id);
    }
    return ok({ staff: person, password_cleared: passwordCleared });
  } catch (error) {
    return serverError("PATCH /api/staff/:id", error);
  }
}

/* ---------- GET /api/staff/:id/records-count ---------- */

export async function handleStaffRecordsCount(id: string): Promise<Response> {
  try {
    const [counts, byRole] = await Promise.all([countStaffRecords(id), countRecordsByRole(id)]);
    return ok({ counts, by_role: byRole });
  } catch (error) {
    return serverError("GET /api/staff/:id/records-count", error);
  }
}

/* ---------- DELETE /api/staff/:id ---------- */

/** 화면이 건수를 보여주고 이름까지 받은 뒤 온 요청이다. 지운 건수를 그대로 돌려준다. */
export async function handleStaffDelete(id: string): Promise<Response> {
  const refused = await refuseAdminTarget(id);
  if (refused) return refused;

  try {
    if (await isLastAdmin(id)) return badRequest(LAST_ADMIN);
    const deleted = await deleteStaff(id);
    return ok({ deleted });
  } catch (error) {
    // 일지가 있는 사람 — 화면 안내와 같은 문장을 그대로 돌려준다(없는 사람은 serverError 가 404)
    if (error instanceof RuleError && !(error instanceof NotFoundError)) {
      return badRequest(error.message);
    }
    return serverError("DELETE /api/staff/:id", error);
  }
}

/* ---------- GET /api/staff/scheduled?date=YYYY-MM-DD ---------- */

/**
 * 그 날짜에 일정이 잡힌 사람들. 봉사일지의 작성자 후보다.
 *
 * 결과가 비어 있어도 오류가 아니다. 일정 없이 온 날에도 일지는 쓸 수 있어야 한다.
 * 화면이 "이 날 일정이 없습니다"를 보여주고 전체 명단에서 고르게 한다.
 */
export async function handleStaffScheduled(req: Request): Promise<Response> {
  const date = new URL(req.url).searchParams.get("date")?.trim() ?? "";
  if (!DATE_RE.test(date)) {
    return badRequest("date는 YYYY-MM-DD 형식이어야 합니다.");
  }

  try {
    const people = await listStaffScheduledOn(date);
    return ok({ scheduled: people, date });
  } catch (error) {
    return serverError("GET /api/staff/scheduled", error);
  }
}
