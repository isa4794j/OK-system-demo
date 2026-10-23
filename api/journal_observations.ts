/**
 * 추출된 관찰(후보) 손보기 API
 *
 *   POST   /api/journal-observations/:id/merge   다른 후보를 이 후보에 합치기
 *   POST   /api/journal-observations/:id/split   둘로 나누기
 *   PATCH  /api/journal-observations/:id         내용 수정 · 아동 지정
 *   DELETE /api/journal-observations/:id         삭제
 *
 * 후보를 읽는 길은 일지 쪽에 있다(GET /api/journals/:id/observations).
 * 여기는 사람이 후보를 손보는 네 가지만 맡는다.
 *
 * 이 파일은 Supabase를 직접 부르지 않는다. /db의 함수만 사용한다.
 * 합칠 수 있는 둘인지(같은 일지·같은 아동)는 /db 가 마지막으로 판단하고,
 * 어긋나면 RuleError 로 알려 온다. 그건 서버 오류가 아니라 400 이다.
 */
import {
  assignJournalObsChild,
  deleteJournalObs,
  mergeJournalObs,
  splitJournalObs,
  updateJournalObs,
} from "../db/journal_observations.ts";
import { NotFoundError, RuleError } from "../db/client.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 관찰 내용 길이 상한. observations 와 같은 값을 쓴다. */
const CONTENT_MAX = 4000;

const JSON_HEADERS = { "cache-control": "no-store" };

function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400, headers: JSON_HEADERS });
}

function ok(body: unknown): Response {
  return Response.json(body, { headers: JSON_HEADERS });
}

/**
 * 합치기 규칙 위반은 사람이 읽을 메시지 그대로 400 으로.
 * 그 밖의 오류는 DB 구조를 노출하므로 서버 로그에만 남기고 500.
 */
function fail(where: string, error: unknown): Response {
  // 없는 대상은 404, 규칙에 어긋난 요청(없는 사람을 가리킴 등)은 400 — 사람이 읽을 말 그대로(db/client.ts)
  if (error instanceof NotFoundError) {
    return Response.json({ error: error.message }, { status: 404, headers: JSON_HEADERS });
  }
  if (error instanceof RuleError) return badRequest(error.message);
  console.error(`[${where}]`, error);
  return Response.json(
    { error: "요청을 처리하지 못했습니다." },
    { status: 500, headers: JSON_HEADERS },
  );
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

/* ---------- POST /api/journal-observations/:id/merge ---------- */

/**
 * :id 가 남고, body.from 이 사라진다.
 * 합쳐진 내용은 화면이 확인창에서 보여 준 그대로를 보낸다 —
 * 사람이 미리보기로 본 것과 저장되는 것이 달라지면 안 된다.
 */
export async function handleJournalObsMerge(req: Request, id: string): Promise<Response> {
  const body = await readJson(req);
  if (!body) return badRequest("요청 본문이 JSON이 아닙니다.");

  const from = typeof body.from === "string" ? body.from.trim() : "";
  if (!UUID_RE.test(from)) return badRequest("from 형식이 올바르지 않습니다.");

  const content = parseContent(body.content);
  if (content === null) {
    return badRequest(`content는 비어 있을 수 없고 ${CONTENT_MAX}자를 넘을 수 없습니다.`);
  }

  try {
    return ok(await mergeJournalObs(id, from, content));
  } catch (error) {
    return fail("POST /api/journal-observations/:id/merge", error);
  }
}

/* ---------- POST /api/journal-observations/:id/split ---------- */

export async function handleJournalObsSplit(req: Request, id: string): Promise<Response> {
  const body = await readJson(req);
  if (!body) return badRequest("요청 본문이 JSON이 아닙니다.");

  const keepContent = parseContent(body.keep_content);
  if (keepContent === null) {
    return badRequest(`keep_content는 비어 있을 수 없고 ${CONTENT_MAX}자를 넘을 수 없습니다.`);
  }

  const newContent = parseContent(body.new_content);
  if (newContent === null) {
    return badRequest(`new_content는 비어 있을 수 없고 ${CONTENT_MAX}자를 넘을 수 없습니다.`);
  }

  try {
    return ok(await splitJournalObs(id, keepContent, newContent));
  } catch (error) {
    return fail("POST /api/journal-observations/:id/split", error);
  }
}

/* ---------- PATCH /api/journal-observations/:id ---------- */

/**
 * 내용을 고치거나, 아동을 못 가린 후보에 아동을 정한다.
 *
 * 둘을 한 번에 받지 않는다. 화면에서도 서로 다른 자리에서 하는 일이고,
 * 섞어 받으면 "무엇을 바꿨는지"가 감사 로그에서 흐려진다.
 */
export async function handleJournalObsUpdate(req: Request, id: string): Promise<Response> {
  const body = await readJson(req);
  if (!body) return badRequest("요청 본문이 JSON이 아닙니다.");

  if ("child_id" in body) {
    const childId = typeof body.child_id === "string" ? body.child_id.trim() : "";
    if (!UUID_RE.test(childId)) return badRequest("child_id 형식이 올바르지 않습니다.");

    try {
      return ok({ observation: await assignJournalObsChild(id, childId) });
    } catch (error) {
      return fail("PATCH /api/journal-observations/:id (child_id)", error);
    }
  }

  const content = parseContent(body.content);
  if (content === null) {
    return badRequest(`content는 비어 있을 수 없고 ${CONTENT_MAX}자를 넘을 수 없습니다.`);
  }

  try {
    return ok({ observation: await updateJournalObs(id, content) });
  } catch (error) {
    return fail("PATCH /api/journal-observations/:id", error);
  }
}

/* ---------- DELETE /api/journal-observations/:id ---------- */

/**
 * 204 가 아니라 본문을 돌려준다.
 * 이 후보를 가져간 관찰이 몇 건 근거를 잃었는지 화면이 알려야 하기 때문이다.
 */
export async function handleJournalObsDelete(id: string): Promise<Response> {
  try {
    return ok(await deleteJournalObs(id));
  } catch (error) {
    return fail("DELETE /api/journal-observations/:id", error);
  }
}
