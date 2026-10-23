/**
 * 일지 API
 *
 *   GET   /api/journals?kind=프로그램&from=YYYY-MM-DD&to=YYYY-MM-DD
 *         (&role=멘토|봉사자 — 봉사일지만, &q=통합 검색(본문·제목·작성자 이름 일부). 기간은 366일까지)
 *   POST  /api/journals                 추가
 *   PATCH /api/journals/:id             제목·내용·날짜·작성자·수퍼비전 수정
 *   GET   /api/journals/missing?year=&month=  일정은 있는데 일지가 없는 날
 *   POST  /api/journals/:id/extract     일지에서 관찰 뽑기 (AI)
 *   GET   /api/journals/:id/observations 뽑힌 관찰 조회
 *   POST  /api/journals/:id/resolve     다시 분석해 갈린 것을 고른 대로 마무리
 *
 * 이 파일은 Supabase를 직접 부르지 않는다. /db의 함수만 사용한다.
 * 형식 검증은 여기서 끝내고, 틀리면 DB까지 가지 않고 400으로 끊는다.
 */
import {
  addJournal,
  deleteJournal,
  getJournal,
  journalMonthSummary,
  type Kind,
  KINDS,
  listJournalsPage,
  listMissingJournals,
  updateJournal,
} from "../db/journals.ts";
import { NotFoundError, RuleError } from "../db/client.ts";
import { getSchedule } from "../db/schedules.ts";
import { findStaffIdsByName, getStaffRoles, type Role } from "../db/staff.ts";
import { primaryRole } from "../lib/permission.ts";
import { checkJournalDate, todayInSeoul } from "../lib/dates.ts";
import { currentUser } from "../lib/request_context.ts";
import {
  countImportedFromJournal,
  listByJournal,
  resolveExtraction,
} from "../db/journal_observations.ts";
import { countRecordsFromJournal } from "../db/resource_records.ts";
import { extractObservations } from "../lib/extract_observations.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 일지 본문 길이 상한. DB의 text에는 제한이 없어 여기서 막는다. */
const CONTENT_MAX = 20000;
const TITLE_MAX = 200;

/** 수퍼비전 댓글. 본문보다 짧게 잡는다. 길어지면 일지에 쓸 내용이다. */
const COMMENT_MAX = 2000;

/** 관찰 한 건의 길이 상한. api/observations.ts 와 같은 값이어야 한다. */
const OBSERVATION_MAX = 4000;

const JSON_HEADERS = { "cache-control": "no-store" };

function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400, headers: JSON_HEADERS });
}

function serverError(where: string, error: unknown): Response {
  // 없는 대상은 404, 규칙에 어긋난 요청(없는 사람을 가리킴 등)은 400 — 사람이 읽을 말 그대로(db/client.ts)
  if (error instanceof NotFoundError) {
    return Response.json({ error: error.message }, { status: 404, headers: JSON_HEADERS });
  }
  // 규칙에 어긋난 요청은 서버 고장이 아니다. 사람이 읽을 메시지를 그대로 400 으로.
  if (error instanceof RuleError) return badRequest(error.message);

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

/** "YYYY-MM-DD" 이면서 달력에 실제로 있는 날짜인지 본다. */
function isValidDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

function parseKind(value: unknown): Kind | null {
  if (typeof value !== "string") return null;
  return (KINDS as readonly string[]).includes(value) ? value as Kind : null;
}

/** 본문은 공백만 있으면 안 되고 상한을 넘으면 안 된다. */
function parseContent(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > CONTENT_MAX) return null;
  return trimmed;
}

/** 제목은 없어도 된다. 빈 문자열은 null로 본다. 너무 길면 undefined(오류). */
function parseTitle(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > TITLE_MAX ? undefined : trimmed;
}

/**
 * 수퍼비전 댓글. 없어도 되고, 지울 수도 있다.
 * 빈 문자열은 null 로 본다 — 댓글을 비우는 것은 지우는 것과 같다.
 */
function parseComment(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > COMMENT_MAX ? undefined : trimmed;
}

/** 관찰 한 건의 내용. 비어 있으면 안 되고 상한을 넘으면 안 된다. */
function parseShortText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > OBSERVATION_MAX) return null;
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

/* ---------- GET /api/journals ---------- */

/** 봉사일지 필터 줄의 역할 */
const FILTER_ROLES: string[] = ["멘토", "봉사자"];
const NAME_QUERY_MAX = 30;
const RANGE_MAX_DAYS = 366;

/** 두 날짜 사이 날 수(끝날 포함) */
function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
  ) + 1;
}

export async function handleJournalsList(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;

  const kind = parseKind(params.get("kind"));
  if (!kind) return badRequest("kind 값이 올바르지 않습니다.");

  const from = params.get("from")?.trim() ?? "";
  const to = params.get("to")?.trim() ?? "";
  if (!isValidDate(from)) return badRequest("from은 YYYY-MM-DD 형식의 실제 날짜여야 합니다.");
  if (!isValidDate(to)) return badRequest("to는 YYYY-MM-DD 형식의 실제 날짜여야 합니다.");
  if (from > to) return badRequest("from이 to보다 뒤일 수 없습니다.");

  // 기간을 걸면(봉사일지 필터) 한 달보다 길 수 있다. 한 해를 넘기지는 않는다.
  if (daysBetween(from, to) > RANGE_MAX_DAYS) {
    return badRequest("기간은 1년(366일)까지만 걸 수 있습니다.");
  }

  // 거르기 — 역할(as_role)·통합 검색. 목록과 건수 요약이 같은 기준으로 거른다.
  // 역할어("봉사자"·"멘토")를 검색어에서 역할로 바꾸는 일은 화면이 한다(보낼 때 role 로 나눠 보낸다).
  const roleParam = params.get("role")?.trim() || null;
  if (roleParam && !FILTER_ROLES.includes(roleParam)) {
    return badRequest("role 은 멘토 또는 봉사자만 됩니다.");
  }
  const nameParam = params.get("q")?.trim() || null;
  if (nameParam && nameParam.length > NAME_QUERY_MAX) {
    return badRequest(`검색어는 ${NAME_QUERY_MAX}자까지입니다.`);
  }

  // 목록은 15건씩(커서). 첫 쪽에는 거른 결과 전체의 건수와 미분석 목록을 함께 준다 —
  // 화면의 "N건" 과 [미분석 일괄 분석] 은 보이는 쪽이 아니라 거른 결과 전체가 기준이다.
  const cursor = params.get("cursor")?.trim() || null;

  try {
    const filter = {
      asRole: roleParam as Role | null,
      text: nameParam,
      textAuthorIds: nameParam ? await findStaffIdsByName(nameParam) : null,
    };
    const page = await listJournalsPage(kind, from, to, { cursor, ...filter });
    const summary = cursor ? null : await journalMonthSummary(kind, from, to, filter);
    return ok({
      journals: page.journals,
      next_cursor: page.next_cursor,
      ...(summary ? { total: summary.total, unanalyzed: summary.unanalyzed } : {}),
      range: { kind, from, to, role: roleParam, q: nameParam },
    });
  } catch (error) {
    return serverError("GET /api/journals", error);
  }
}

/* ---------- POST /api/journals ---------- */

export async function handleJournalCreate(req: Request): Promise<Response> {
  const body = await readJson(req);
  if (!body) return badRequest("요청 본문이 JSON이 아닙니다.");

  const kind = parseKind(body.kind);
  if (!kind) return badRequest("kind 값이 올바르지 않습니다.");

  const journalDate = typeof body.journal_date === "string" ? body.journal_date.trim() : "";
  if (!isValidDate(journalDate)) {
    return badRequest("journal_date는 YYYY-MM-DD 형식의 실제 날짜여야 합니다.");
  }
  // 봉사일지는 활동한 뒤에(오늘까지), 종사자 일지는 1년 뒤까지(lib/dates.ts)
  const dateProblem = checkJournalDate(kind, journalDate);
  if (dateProblem) return badRequest(dateProblem);

  // 작성자는 없어도 저장은 되지만(DB가 nullable), 화면은 늘 채워 보낸다.
  // 값이 왔다면 형식은 맞아야 한다.
  const authorRaw = body.author_id;
  let authorId: string | null = null;
  if (authorRaw !== null && authorRaw !== undefined && authorRaw !== "") {
    if (typeof authorRaw !== "string" || !UUID_RE.test(authorRaw)) {
      return badRequest("author_id 형식이 올바르지 않습니다.");
    }
    authorId = authorRaw;
  }
  // 종사자 일지(프로그램·일상·회의록): author_id 를 보내면 그 사람(넓은 화면의 대리 작성),
  // 안 보내면 로그인한 본인(좁은 화면은 칸이 없어 안 보낸다). 봉사일지는 일정의 사람이라 늘 받은 값.
  const me = currentUser();
  if (kind !== "봉사" && !authorId && !("author_id" in body) && me) authorId = me.id;

  const title = parseTitle(body.title);
  if (title === undefined) return badRequest(`title은 ${TITLE_MAX}자를 넘을 수 없습니다.`);

  const content = parseContent(body.content);
  if (content === null) {
    return badRequest(`content는 비어 있을 수 없고 ${CONTENT_MAX}자를 넘을 수 없습니다.`);
  }

  // 봉사일지는 일정을 가리킨다. 시각은 그 일정에서 읽으므로 따로 받지 않는다(015).
  const scheduleRaw = body.schedule_id;
  let scheduleId: string | null = null;
  if (scheduleRaw !== null && scheduleRaw !== undefined && scheduleRaw !== "") {
    if (typeof scheduleRaw !== "string" || !UUID_RE.test(scheduleRaw)) {
      return badRequest("schedule_id 형식이 올바르지 않습니다.");
    }
    scheduleId = scheduleRaw;
  }
  if (kind === "봉사" && !scheduleId) {
    return badRequest("봉사일지는 일정이 있는 날에만 쓸 수 있습니다.");
  }

  try {
    // 어느 역할로 쓴 일지인지(029).
    //   봉사일지 → 매인 일정의 역할. 일정이 그 작성자·그 날짜 것인지도 여기서 본다
    //   종사자 일지 → 작성자의 종사자 역할(센터장·생활복지사 중 높은 것), 없으면 대표 역할
    let asRole: Role | null = null;
    if (kind === "봉사") {
      const schedule = await getSchedule(scheduleId as string);
      if (!schedule) return badRequest("그 일정을 찾지 못했습니다.");
      if (schedule.staff_id !== authorId || schedule.sched_date !== journalDate) {
        return badRequest("작성자와 날짜가 그 일정과 맞지 않습니다.");
      }
      asRole = schedule.staff_role;
    } else if (authorId) {
      const author = await getStaffRoles(authorId);
      const roles = author?.roles ?? [];
      asRole = (roles.find((role) => role === "센터장" || role === "생활복지사") ??
        primaryRole(roles)) as Role | null;
    }

    const journal = await addJournal(kind, journalDate, authorId, title, content, {
      schedule_id: scheduleId,
      as_role: asRole,
    });
    return ok({ journal });
  } catch (error) {
    return serverError("POST /api/journals", error);
  }
}

/* ---------- PATCH /api/journals/:id ---------- */

export async function handleJournalUpdate(req: Request, id: string): Promise<Response> {
  const body = await readJson(req);
  if (!body) return badRequest("요청 본문이 JSON이 아닙니다.");

  const patch: {
    title?: string | null;
    content?: string;
    journal_date?: string;
    author_id?: string | null;
    comment?: string | null;
  } = {};

  if ("journal_date" in body) {
    const journalDate = typeof body.journal_date === "string" ? body.journal_date.trim() : "";
    if (!isValidDate(journalDate)) {
      return badRequest("journal_date는 YYYY-MM-DD 형식의 실제 날짜여야 합니다.");
    }
    patch.journal_date = journalDate;
  }

  if ("author_id" in body) {
    const raw = body.author_id;
    if (raw === null || raw === "") {
      patch.author_id = null;
    } else if (typeof raw !== "string" || !UUID_RE.test(raw)) {
      return badRequest("author_id 형식이 올바르지 않습니다.");
    } else {
      patch.author_id = raw;
    }
  }

  if ("title" in body) {
    const title = parseTitle(body.title);
    if (title === undefined) return badRequest(`title은 ${TITLE_MAX}자를 넘을 수 없습니다.`);
    patch.title = title;
  }

  if ("content" in body) {
    const content = parseContent(body.content);
    if (content === null) {
      return badRequest(`content는 비어 있을 수 없고 ${CONTENT_MAX}자를 넘을 수 없습니다.`);
    }
    patch.content = content;
  }

  if ("comment" in body) {
    const comment = parseComment(body.comment);
    if (comment === undefined) {
      return badRequest(`수퍼비전 댓글은 ${COMMENT_MAX}자를 넘을 수 없습니다.`);
    }
    patch.comment = comment;
  }

  if (Object.keys(patch).length === 0) {
    return badRequest("바꿀 내용이 없습니다.");
  }

  try {
    // 오늘보다 뒤로 옮길 때만 종류를 읽어 본다(봉사일지는 오늘까지, 종사자 일지는 1년 뒤까지)
    if (patch.journal_date && patch.journal_date > todayInSeoul()) {
      const current = await getJournal(id);
      if (!current) {
        return serverError(
          "PATCH /api/journals/:id",
          new NotFoundError("그 일지를 찾지 못했습니다."),
        );
      }
      const dateProblem = checkJournalDate(current.kind, patch.journal_date);
      if (dateProblem) return badRequest(dateProblem);
    }
    const journal = await updateJournal(id, patch);
    return ok({ journal });
  } catch (error) {
    return serverError("PATCH /api/journals/:id", error);
  }
}

/* ---------- GET /api/journals/missing ---------- */

/**
 * 일정은 있는데 봉사일지가 없는 날.
 *
 * 봉사일지에만 있는 개념이라 kind 를 받지 않는다.
 * 종사자 일지는 일정이 없으므로 견줄 대상 자체가 없다.
 */
export async function handleMissingJournals(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;

  const year = Number(params.get("year"));
  const month = Number(params.get("month"));
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return badRequest("year 값이 올바르지 않습니다.");
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return badRequest("month 값이 올바르지 않습니다.");
  }

  try {
    const missing = await listMissingJournals(year, month);
    return ok({ missing, year, month });
  } catch (error) {
    return serverError("GET /api/journals/missing", error);
  }
}

/* ---------- POST /api/journals/:id/extract ---------- */

/**
 * 일지에서 관찰을 뽑아 저장한다. 시간이 걸리므로 저장과 분리된 호출이다.
 * 화면은 일지를 먼저 저장해 두고, 이 요청은 이어서 보낸다.
 */
export async function handleJournalExtract(id: string): Promise<Response> {
  try {
    const result = await extractObservations(id);
    return ok(result);
  } catch (error) {
    if (error instanceof NotFoundError) return serverError("POST /api/journals/:id/extract", error);
    // 추출이 실패해도 일지는 이미 저장돼 있다.
    // 왜 실패했는지는 화면에서 알려 줘야 다시 시도할지 판단할 수 있으므로,
    // AI 게이트웨이가 만든 사람이 읽을 수 있는 메시지는 그대로 내보낸다.
    console.error("[POST /api/journals/:id/extract]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "관찰을 뽑지 못했습니다." },
      { status: 502, headers: JSON_HEADERS },
    );
  }
}

/* ---------- POST /api/journals/:id/resolve ---------- */

/**
 * 다시 분석해서 갈린 것들을 사람이 고른 대로 마무리한다.
 *
 * 고른 내용을 화면이 그대로 보내온다. 서버가 새 결과를 들고 기다리지 않는 이유는,
 * 사람이 고르는 동안 서버가 무언가를 쥐고 있으면 창을 닫거나 새로고침할 때
 * 그것이 어디에도 없는 상태로 남기 때문이다. AI 를 다시 부르지 않아도 되고,
 * 사람이 화면에서 본 그 글자가 그대로 저장된다.
 */
export async function handleJournalResolve(req: Request, id: string): Promise<Response> {
  const body = await readJson(req);
  if (!body) return badRequest("요청 본문이 JSON이 아닙니다.");

  const replace: Array<{ id: string; content: string }> = [];
  if (Array.isArray(body.replace)) {
    for (const one of body.replace) {
      const target = one && typeof one === "object" ? one as Record<string, unknown> : null;
      const targetId = typeof target?.id === "string" ? target.id.trim() : "";
      const content = parseShortText(target?.content);
      if (!UUID_RE.test(targetId) || content === null) {
        return badRequest("replace 값의 형식이 올바르지 않습니다.");
      }
      replace.push({ id: targetId, content });
    }
  }

  const remove: string[] = [];
  if (Array.isArray(body.remove)) {
    for (const value of body.remove) {
      if (typeof value !== "string" || !UUID_RE.test(value)) {
        return badRequest("remove 값의 형식이 올바르지 않습니다.");
      }
      remove.push(value);
    }
  }

  try {
    if (!(await getJournal(id))) {
      return serverError(
        "POST /api/journals/:id/resolve",
        new NotFoundError("그 일지를 찾지 못했습니다."),
      );
    }
    return ok({ observations: await resolveExtraction(id, replace, remove) });
  } catch (error) {
    return serverError("POST /api/journals/:id/resolve", error);
  }
}

/* ---------- GET /api/journals/:id/observations ---------- */

export async function handleJournalObservations(id: string): Promise<Response> {
  try {
    // 두 개수는 삭제 확인창에 쓴다.
    // "이 일지를 지우면 가져간 관찰 N건에 표시가 남는다"와
    // "뽑은 자원 N건은 함께 사라진다"를 미리 알려야 한다.
    const [observations, importedCount, resourceCount] = await Promise.all([
      listByJournal(id),
      countImportedFromJournal(id),
      countRecordsFromJournal(id),
    ]);
    return ok({
      observations,
      imported_count: importedCount,
      resource_record_count: resourceCount,
    });
  } catch (error) {
    return serverError("GET /api/journals/:id/observations", error);
  }
}

/* ---------- DELETE /api/journals/:id ---------- */

export async function handleJournalDelete(id: string): Promise<Response> {
  try {
    await deleteJournal(id);
    return new Response(null, { status: 204, headers: JSON_HEADERS });
  } catch (error) {
    return serverError("DELETE /api/journals/:id", error);
  }
}
