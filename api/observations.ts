/**
 * 관찰 기록 API
 *
 *   GET   /api/observations?child=<uuid>&year=<YYYY>&half=<1|2>
 *   POST  /api/observations                    추가
 *   PATCH /api/observations/:id/area           영역 변경
 *   PATCH /api/observations/:id/content        내용 변경
 *   POST  /api/observations/:id/split          나누기
 *   POST  /api/observations/:id/merge          합치기
 *   GET   /api/children/:id/importable        가져올 수 있는 관찰 후보
 *   POST  /api/observations/import            고른 후보를 관찰로 가져오기
 *
 * 이 파일은 Supabase를 직접 부르지 않는다. /db의 함수만 사용한다.
 * 형식 검증은 여기서 끝내고, 틀리면 DB까지 가지 않고 400으로 끊는다.
 */
import {
  addObservation,
  type Area,
  deleteObservation,
  type Half,
  halfYearRange,
  listObservationsByChild,
  mergeObservations,
  type Source,
  SOURCES,
  splitObservation,
  updateObservationArea,
  updateObservationContent,
} from "../db/observations.ts";
import { importObservations, listImportableObservations } from "../db/journal_observations.ts";
import { NotFoundError, RuleError } from "../db/client.ts";
import { isAssignableArea } from "../lib/obs_areas.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 관찰 내용 길이 상한. DB의 text에는 제한이 없어 여기서 막는다. */
const CONTENT_MAX = 4000;

/** 한 번에 가져올 수 있는 관찰 수 상한 */
const IMPORT_MAX = 200;

const JSON_HEADERS = { "cache-control": "no-store" };

function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400, headers: JSON_HEADERS });
}

function serverError(where: string, error: unknown): Response {
  // 없는 대상은 404, 규칙에 어긋난 요청(없는 사람을 가리킴 등)은 400 — 사람이 읽을 말 그대로(db/client.ts)
  if (error instanceof NotFoundError) {
    return Response.json({ error: error.message }, { status: 404, headers: JSON_HEADERS });
  }
  // 합칠 수 없는 둘이라는 것은 서버 고장이 아니라 요청이 틀린 것이다.
  // 사람이 읽을 메시지가 이미 담겨 있으므로 그대로 400 으로 돌려준다.
  if (error instanceof RuleError) return badRequest(error.message);

  // DB 오류 원문은 테이블 구조를 노출하므로 서버 로그에만 남긴다.
  console.error(`[${where}]`, error);
  return Response.json(
    { error: "요청을 처리하지 못했습니다." },
    { status: 500, headers: JSON_HEADERS },
  );
}

function ok(body: unknown): Response {
  return Response.json(body, { headers: JSON_HEADERS });
}

/* ---------- 값 검증 ---------- */

/** "YYYY-MM-DD" 이면서 달력에 실제로 있는 날짜인지 본다. (2026-02-31 같은 값 차단) */
function isValidDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

/**
 * 영역은 지금 쓰는 영역의 코드(settings.observation_areas, 지운 것 제외)이거나 빈값(미지정).
 * 잘못되면 undefined.
 */
async function parseArea(value: unknown): Promise<Area | null | undefined> {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return undefined;
  return (await isAssignableArea(value)) ? value : undefined;
}

/** 출처는 허용된 값이거나 빈값이어야 한다. 잘못되면 undefined. */
function parseSource(value: unknown): Source | null | undefined {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return undefined;
  return (SOURCES as readonly string[]).includes(value) ? value as Source : undefined;
}

/** 내용은 공백만 있으면 안 되고 상한을 넘으면 안 된다. 잘못되면 null. */
function parseContent(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > CONTENT_MAX) return null;
  return trimmed;
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/* ---------- GET /api/observations ---------- */

export async function handleObservationsList(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;

  const childId = params.get("child")?.trim() ?? "";
  if (!childId) return badRequest("child 파라미터가 필요합니다.");
  if (!UUID_RE.test(childId)) return badRequest("child 파라미터 형식이 올바르지 않습니다.");

  const year = Number(params.get("year"));
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return badRequest("year 파라미터는 2000~2100 사이의 정수여야 합니다.");
  }

  const halfRaw = Number(params.get("half"));
  if (halfRaw !== 1 && halfRaw !== 2) {
    return badRequest("half 파라미터는 1(상반기) 또는 2(하반기)여야 합니다.");
  }
  const half = halfRaw as Half;

  try {
    const observations = await listObservationsByChild(childId, year, half);
    return ok({ observations, range: { year, half, ...halfYearRange(year, half) } });
  } catch (error) {
    return serverError("GET /api/observations", error);
  }
}

/* ---------- POST /api/observations ---------- */

export async function handleObservationCreate(req: Request): Promise<Response> {
  const body = await readJson(req);
  if (!body) return badRequest("요청 본문이 JSON이 아닙니다.");

  const childId = typeof body.child_id === "string" ? body.child_id.trim() : "";
  if (!UUID_RE.test(childId)) return badRequest("child_id 형식이 올바르지 않습니다.");

  const obsDate = typeof body.obs_date === "string" ? body.obs_date.trim() : "";
  if (!isValidDate(obsDate)) {
    return badRequest("obs_date는 YYYY-MM-DD 형식의 실제 날짜여야 합니다.");
  }

  const area = await parseArea(body.area);
  if (area === undefined) return badRequest("area 값이 올바르지 않거나 지운 영역입니다.");

  const source = parseSource(body.source);
  if (source === undefined) return badRequest("source 값이 올바르지 않습니다.");

  const content = parseContent(body.content);
  if (content === null) {
    return badRequest(`content는 비어 있을 수 없고 ${CONTENT_MAX}자를 넘을 수 없습니다.`);
  }

  try {
    const observation = await addObservation(childId, obsDate, area, content, source);
    return ok({ observation });
  } catch (error) {
    return serverError("POST /api/observations", error);
  }
}

/* ---------- PATCH /api/observations/:id/area ---------- */

export async function handleObservationAreaUpdate(req: Request, id: string): Promise<Response> {
  const body = await readJson(req);
  if (!body) return badRequest("요청 본문이 JSON이 아닙니다.");

  const area = await parseArea(body.area);
  if (area === undefined) return badRequest("area 값이 올바르지 않거나 지운 영역입니다.");

  try {
    const observation = await updateObservationArea(id, area);
    return ok({ observation });
  } catch (error) {
    return serverError("PATCH /api/observations/:id/area", error);
  }
}

/* ---------- PATCH /api/observations/:id/content ---------- */

export async function handleObservationContentUpdate(req: Request, id: string): Promise<Response> {
  const body = await readJson(req);
  if (!body) return badRequest("요청 본문이 JSON이 아닙니다.");

  const content = parseContent(body.content);
  if (content === null) {
    return badRequest(`content는 비어 있을 수 없고 ${CONTENT_MAX}자를 넘을 수 없습니다.`);
  }

  try {
    const observation = await updateObservationContent(id, content);
    return ok({ observation });
  } catch (error) {
    return serverError("PATCH /api/observations/:id/content", error);
  }
}

/* ---------- POST /api/observations/:id/split ---------- */

export async function handleObservationSplit(req: Request, id: string): Promise<Response> {
  const body = await readJson(req);
  if (!body) return badRequest("요청 본문이 JSON이 아닙니다.");

  const originalContent = parseContent(body.original_content);
  if (originalContent === null) {
    return badRequest(`original_content는 비어 있을 수 없고 ${CONTENT_MAX}자를 넘을 수 없습니다.`);
  }

  const newContent = parseContent(body.new_content);
  if (newContent === null) {
    return badRequest(`new_content는 비어 있을 수 없고 ${CONTENT_MAX}자를 넘을 수 없습니다.`);
  }

  const newArea = await parseArea(body.new_area);
  if (newArea === undefined) return badRequest("new_area 값이 올바르지 않습니다.");

  try {
    const result = await splitObservation(id, originalContent, newContent, newArea);
    return ok(result);
  } catch (error) {
    return serverError("POST /api/observations/:id/split", error);
  }
}

/* ---------- POST /api/observations/:id/merge ---------- */

/**
 * :id 가 남고, body.from 이 사라진다.
 * 합쳐진 내용은 화면이 확인창에서 보여 준 그대로를 보낸다 —
 * 사람이 미리보기로 본 것과 저장되는 것이 달라지면 안 된다.
 */
export async function handleObservationMerge(req: Request, id: string): Promise<Response> {
  const body = await readJson(req);
  if (!body) return badRequest("요청 본문이 JSON이 아닙니다.");

  const from = typeof body.from === "string" ? body.from.trim() : "";
  if (!UUID_RE.test(from)) return badRequest("from 형식이 올바르지 않습니다.");

  const content = parseContent(body.content);
  if (content === null) {
    return badRequest(`content는 비어 있을 수 없고 ${CONTENT_MAX}자를 넘을 수 없습니다.`);
  }

  try {
    return ok(await mergeObservations(id, from, content));
  } catch (error) {
    return serverError("POST /api/observations/:id/merge", error);
  }
}

/* ---------- GET /api/children/:id/importable ---------- */

/** 그 아동의 관찰 후보(일지에서 뽑힌 것)를 가져올 수 있는지와 함께 돌려준다. */
export async function handleImportableList(childId: string): Promise<Response> {
  try {
    const items = await listImportableObservations(childId);
    return ok({ items });
  } catch (error) {
    return serverError("GET /api/children/:id/importable", error);
  }
}

/* ---------- POST /api/observations/import ---------- */

/** 고른 후보들을 아동 관찰로 가져온다. */
export async function handleObservationImport(req: Request): Promise<Response> {
  const body = await readJson(req);
  if (!body) return badRequest("요청 본문이 JSON이 아닙니다.");

  const childId = typeof body.child_id === "string" ? body.child_id.trim() : "";
  if (!UUID_RE.test(childId)) return badRequest("child_id 형식이 올바르지 않습니다.");

  const raw = body.ids;
  if (!Array.isArray(raw) || raw.length === 0) {
    return badRequest("가져올 관찰을 하나 이상 골라야 합니다.");
  }
  if (raw.length > IMPORT_MAX) {
    return badRequest(`한 번에 ${IMPORT_MAX}건까지만 가져올 수 있습니다.`);
  }

  const ids: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string" || !UUID_RE.test(value)) {
      return badRequest("ids 값의 형식이 올바르지 않습니다.");
    }
    ids.push(value);
  }

  try {
    const result = await importObservations(childId, [...new Set(ids)]);
    return ok(result);
  } catch (error) {
    return serverError("POST /api/observations/import", error);
  }
}

/* ---------- DELETE /api/observations/:id ---------- */

export async function handleObservationDelete(id: string): Promise<Response> {
  try {
    await deleteObservation(id);
    return new Response(null, { status: 204, headers: JSON_HEADERS });
  } catch (error) {
    return serverError("DELETE /api/observations/:id", error);
  }
}
