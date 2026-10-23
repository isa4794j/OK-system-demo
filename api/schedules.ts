/**
 * 스케줄 API
 *
 *   GET    /api/schedules?year=&month=   그 달 전체 — 목록 + 통계 + 미작성을 한 번에
 *   POST   /api/schedules                여러 날짜 한 번에 등록 { staff_id, items: [{sched_date, start_time, end_time}] }
 *   PATCH  /api/schedules/:id            날짜·시각 수정
 *   DELETE /api/schedules/:id            삭제
 *
 * 이 파일은 Supabase를 직접 부르지 않는다. /db의 함수만 사용한다.
 */
import { NotFoundError, RuleError } from "../db/client.ts";
import {
  addSchedules,
  deleteSchedule,
  monthOverview,
  type NewSchedule,
  updateSchedule,
} from "../db/schedules.ts";
import { getStaffRoles, type Role } from "../db/staff.ts";
import { chooseAsRole } from "../lib/permission.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 한 번에 등록할 수 있는 날짜 수. 실수로 몇 년치를 넣는 것을 막는다. */
const BULK_MAX = 200;

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

/** "YYYY-MM-DD" 이면서 달력에 실제로 있는 날짜인지 본다. */
function isValidDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

function isValidTime(value: unknown): value is string {
  return typeof value === "string" && TIME_RE.test(value);
}

/* ---------- GET /api/schedules ---------- */

export async function handleSchedulesList(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;

  const year = Number(params.get("year"));
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return badRequest("year 는 2000~2100 사이의 정수여야 합니다.");
  }
  const month = Number(params.get("month"));
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return badRequest("month 는 1~12 사이의 정수여야 합니다.");
  }

  try {
    // 목록·통계·미작성을 한 번에. 셋 다 같은 두 벌에서 나오므로 따로 부를 이유가 없다.
    return ok(await monthOverview(year, month));
  } catch (error) {
    return serverError("GET /api/schedules", error);
  }
}

/* ---------- POST /api/schedules ---------- */

/**
 * 한 사람의 여러 날짜를 한 번에 등록한다. 줄마다 시각이 다를 수 있다.
 * 화면이 "날짜 줄"을 만들어 보낸다. 여기서는 줄마다 검사만 한다.
 */
export async function handleScheduleCreate(req: Request): Promise<Response> {
  const body = await readJson(req);
  if (!body) return badRequest("요청 본문이 JSON이 아닙니다.");

  const staffId = typeof body.staff_id === "string" ? body.staff_id.trim() : "";
  if (!UUID_RE.test(staffId)) return badRequest("사람을 골라 주세요.");

  const raw = body.items;
  if (!Array.isArray(raw) || raw.length === 0) {
    return badRequest("날짜를 하나 이상 넣어야 합니다.");
  }
  if (raw.length > BULK_MAX) {
    return badRequest(`한 번에 ${BULK_MAX}일까지만 등록할 수 있습니다.`);
  }

  // 어느 역할 활동인지. 역할이 하나면 저절로, 겸직이면 화면이 고른 as_role 이 있어야 한다.
  let asRole: Role;
  try {
    const person = await getStaffRoles(staffId);
    if (!person) return badRequest("그 사람을 찾지 못했습니다.");
    const chosen = chooseAsRole(person.roles, body.as_role);
    if ("error" in chosen) return badRequest(chosen.error);
    asRole = chosen.role as Role;
  } catch (error) {
    return serverError("POST /api/schedules", error);
  }

  const items: NewSchedule[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    const n = index + 1;
    const row = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    if (!isValidDate(row.sched_date)) return badRequest(`${n}번째 줄의 날짜가 올바르지 않습니다.`);
    if (!isValidTime(row.start_time)) {
      return badRequest(`${n}번째 줄의 시작 시각이 올바르지 않습니다.`);
    }
    if (!isValidTime(row.end_time)) {
      return badRequest(`${n}번째 줄의 종료 시각이 올바르지 않습니다.`);
    }
    if (row.end_time <= row.start_time) {
      return badRequest(`${n}번째 줄의 종료 시각은 시작 시각보다 뒤여야 합니다.`);
    }
    // 같은 날·같은 시작이 두 줄이면 하나로
    const key = `${row.sched_date} ${row.start_time}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      staff_id: staffId,
      sched_date: row.sched_date,
      start_time: row.start_time,
      end_time: row.end_time,
      as_role: asRole,
    });
  }

  try {
    const result = await addSchedules(items);
    return ok(result);
  } catch (error) {
    return serverError("POST /api/schedules", error);
  }
}

/* ---------- PATCH /api/schedules/:id ---------- */

export async function handleScheduleUpdate(req: Request, id: string): Promise<Response> {
  const body = await readJson(req);
  if (!body) return badRequest("요청 본문이 JSON이 아닙니다.");

  const patch: { sched_date?: string; start_time?: string; end_time?: string } = {};

  if ("sched_date" in body) {
    if (!isValidDate(body.sched_date)) return badRequest("날짜가 올바르지 않습니다.");
    patch.sched_date = body.sched_date;
  }
  if ("start_time" in body) {
    if (!isValidTime(body.start_time)) return badRequest("시작 시각이 올바르지 않습니다.");
    patch.start_time = body.start_time;
  }
  if ("end_time" in body) {
    if (!isValidTime(body.end_time)) return badRequest("종료 시각이 올바르지 않습니다.");
    patch.end_time = body.end_time;
  }

  // 둘 다 왔을 때만 여기서 견줄 수 있다.
  // 하나만 바꾸는 경우는 DB의 CHECK 제약이 막는다.
  if (patch.start_time && patch.end_time && patch.end_time <= patch.start_time) {
    return badRequest("종료 시각은 시작 시각보다 뒤여야 합니다.");
  }

  if (Object.keys(patch).length === 0) return badRequest("바꿀 내용이 없습니다.");

  try {
    const schedule = await updateSchedule(id, patch);
    return ok({ schedule });
  } catch (error) {
    return serverError("PATCH /api/schedules/:id", error);
  }
}

/* ---------- DELETE /api/schedules/:id ---------- */

export async function handleScheduleDelete(id: string): Promise<Response> {
  try {
    await deleteSchedule(id);
    return new Response(null, { status: 204, headers: JSON_HEADERS });
  } catch (error) {
    return serverError("DELETE /api/schedules/:id", error);
  }
}
