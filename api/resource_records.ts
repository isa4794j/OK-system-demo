/**
 * 자원기록 API — 일지에서 뽑은 자원 활용의 사후 수정
 *
 *   POST   /api/journals/:id/extract-resources   일지에서 자원 뽑기 (AI)
 *   GET    /api/journals/:id/resources           그 일지에서 뽑힌 자원
 *   POST   /api/journals/:id/resolve-resources   다시 분석해 갈린 것을 고른 대로 마무리
 *   GET    /api/resource-inbox                   미분류함 (카테고리 미정 + 자원 아님 + 블랙리스트)
 *   POST   /api/resource-inbox/restore           자원 아님 취소 (블랙리스트에서 빼고 검토로)
 *   PATCH  /api/resource-records/:id             이름·카테고리·상태 수정
 *   DELETE /api/resource-records/:id             삭제
 *
 * 이 파일은 Supabase를 직접 부르지 않는다. /db 와 /lib 의 함수만 사용한다.
 */
import { NotFoundError, RuleError } from "../db/client.ts";
import {
  deleteRecord,
  listByJournal,
  listPendingRecords,
  listRejectedNames,
  RECORD_STATUSES,
  recordRejectionAudit,
  type RecordStatus,
  resolveResourceExtraction,
  setStatusByName,
  updateRecord,
} from "../db/resource_records.ts";
import {
  addResource,
  addToBlacklist,
  getResourceBlacklist,
  getResourceCategories,
  listResources,
  removeFromBlacklist,
} from "../db/resources.ts";
import { extractResources } from "../lib/extract_resources.ts";
import { getJournal } from "../db/journals.ts";

const NAME_MAX = 100;
const CATEGORY_MAX = 30;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/* ---------- POST /api/journals/:id/extract-resources ---------- */

/**
 * 일지에서 자원을 뽑아 저장한다. 뽑히는 즉시 통계에 잡힌다.
 * 시간이 걸리므로 일지 저장과 분리된 호출이다.
 */
export async function handleResourceExtract(id: string): Promise<Response> {
  try {
    const result = await extractResources(id);
    return ok(result);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return serverError("POST /api/journals/:id/extract-resources", error);
    }
    // 추출이 실패해도 일지는 이미 저장돼 있다.
    // 왜 실패했는지 알아야 다시 시도할지 판단할 수 있으므로,
    // AI 게이트웨이가 만든 사람이 읽을 수 있는 메시지는 그대로 내보낸다.
    console.error("[POST /api/journals/:id/extract-resources]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "자원을 뽑지 못했습니다." },
      { status: 502, headers: JSON_HEADERS },
    );
  }
}

/* ---------- POST /api/journals/:id/resolve-resources ---------- */

/**
 * 다시 분석해서 갈린 자원기록을 사람이 고른 대로 마무리한다.
 * 관찰 쪽(/api/journals/:id/resolve)과 같은 생각이다 — 고른 값을 화면이 그대로 보내온다.
 */
export async function handleResourceResolve(req: Request, id: string): Promise<Response> {
  let body: Record<string, unknown> | null = null;
  try {
    const parsed = await req.json();
    body = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    body = null;
  }
  if (!body) return badRequest("요청 본문이 JSON이 아닙니다.");

  const replace: Array<{ id: string; category: string | null }> = [];
  if (Array.isArray(body.replace)) {
    for (const one of body.replace) {
      const target = one && typeof one === "object" ? one as Record<string, unknown> : null;
      const targetId = typeof target?.id === "string" ? target.id.trim() : "";
      if (!UUID_RE.test(targetId)) return badRequest("replace 값의 형식이 올바르지 않습니다.");

      const raw = target?.category;
      const category = raw === null || raw === undefined || raw === ""
        ? null
        : typeof raw === "string" && raw.trim().length <= CATEGORY_MAX
        ? raw.trim()
        : undefined;
      if (category === undefined) return badRequest("category 값이 올바르지 않습니다.");

      replace.push({ id: targetId, category });
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
        "POST /api/journals/:id/resolve-resources",
        new NotFoundError("그 일지를 찾지 못했습니다."),
      );
    }
    return ok({ records: await resolveResourceExtraction(id, replace, remove) });
  } catch (error) {
    return serverError("POST /api/journals/:id/resolve-resources", error);
  }
}

/* ---------- GET /api/journals/:id/resources ---------- */

export async function handleJournalResources(id: string): Promise<Response> {
  try {
    // 카테고리도 함께 준다. 검토 화면의 드롭다운이 이 목록으로 만들어진다.
    const [records, categories] = await Promise.all([
      listByJournal(id),
      getResourceCategories(),
    ]);
    return ok({ records, categories });
  } catch (error) {
    return serverError("GET /api/journals/:id/resources", error);
  }
}

/* ---------- GET /api/resource-inbox ---------- */

/**
 * 검토함 한 화면에 필요한 것을 한 번에 준다.
 *
 * 카테고리 미정과 자원 아님 목록과 블랙리스트를 따로 받으면 셋이 다른 순간의 상태가 되어
 * "블랙리스트에는 있는데 목록에는 없는" 줄이 잠깐 보인다.
 */
export async function handleResourceInbox(): Promise<Response> {
  try {
    const [pending, rejected, blacklist, categories] = await Promise.all([
      listPendingRecords(),
      listRejectedNames(),
      getResourceBlacklist(),
      getResourceCategories(),
    ]);

    // 블랙리스트에만 있고 기록이 없는 이름도 보여야 뺄 수 있다.
    // 기록으로 센 것에 블랙리스트 이름을 합쳐 한 목록으로 만든다.
    const byKey = new Map(rejected.map((item) => [item.name.trim().toLowerCase(), item]));
    for (const name of blacklist) {
      const key = name.trim().toLowerCase();
      if (!byKey.has(key)) byKey.set(key, { name: name.trim(), count: 0 });
    }
    const blocked = new Set(blacklist.map((name) => name.trim().toLowerCase()));

    const rejectedList = [...byKey.values()]
      .map((item) => ({ ...item, blacklisted: blocked.has(item.name.toLowerCase()) }))
      .sort((a, b) => a.name.localeCompare(b.name, "ko"));

    return ok({ pending, rejected: rejectedList, categories });
  } catch (error) {
    return serverError("GET /api/resource-inbox", error);
  }
}

/* ---------- POST /api/resource-inbox/restore ---------- */

/**
 * "자원 아님"을 취소한다. 블랙리스트에서 빼고, 그 이름으로 '없음'이던 기록을 'Y' 로 되돌린다.
 *
 * 'Y' 로 돌리면 바로 통계에 잡힌다. 카테고리가 비어 있던 줄은 미분류함에 나타난다.
 * 예전에는 'N'(검토 대기)로 돌렸는데, 019 이후 'N' 은 어느 화면에도 안 나와 기록이 사라진 것처럼 됐다.
 *
 * 둘을 한 번에 한다. 블랙리스트만 빼면 기록은 여전히 '없음'이라 통계에 안 들어가고,
 * 기록만 되돌리면 다음 추출에서 또 '없음'이 된다. 어느 한쪽만 하면 반쯤 취소된 상태가 남는다.
 */
export async function handleInboxRestore(req: Request): Promise<Response> {
  const body = await readJson(req);
  if (!body) return badRequest("요청 본문이 JSON이 아닙니다.");

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > NAME_MAX) return badRequest("이름이 올바르지 않습니다.");

  try {
    const blacklist = await removeFromBlacklist(name);
    const restored = await setStatusByName(name, "Y", "없음");
    await recordRejectionAudit({ kind: "restore", name, recordIds: restored });
    return ok({ restored: restored.length, blacklist });
  } catch (error) {
    return serverError("POST /api/resource-inbox/restore", error);
  }
}

/* ---------- PATCH /api/resource-records/:id ---------- */

/**
 * 기록을 고친다. 이름·카테고리 수정과 '자원 아님' 처리, 그 되돌리기가 다 여기로 온다.
 *
 * 카테고리를 채웠는데 사전에 그 이름이 없으면 사전에도 넣는다.
 * 사전에 안 남으면 다음 일지에서 같은 것이 또 새 자원으로 올라온다.
 * 물어보지 않고 넣되, 넣었다는 사실은 응답에 담아 화면이 알릴 수 있게 한다.
 */
export async function handleResourceRecordUpdate(req: Request, id: string): Promise<Response> {
  const body = await readJson(req);
  if (!body) return badRequest("요청 본문이 JSON이 아닙니다.");

  const patch: { resource_name?: string; category?: string | null; status?: RecordStatus } = {};

  if ("resource_name" in body) {
    const name = typeof body.resource_name === "string" ? body.resource_name.trim() : "";
    if (!name || name.length > NAME_MAX) {
      return badRequest(`자원명은 비어 있을 수 없고 ${NAME_MAX}자를 넘을 수 없습니다.`);
    }
    patch.resource_name = name;
  }

  if ("category" in body) {
    const raw = body.category;
    if (raw === null || raw === undefined || raw === "") {
      patch.category = null;
    } else if (typeof raw !== "string" || raw.trim().length > CATEGORY_MAX) {
      return badRequest(`카테고리는 ${CATEGORY_MAX}자를 넘을 수 없습니다.`);
    } else {
      patch.category = raw.trim();
    }
  }

  if ("status" in body) {
    if (
      typeof body.status !== "string" ||
      !(RECORD_STATUSES as readonly string[]).includes(body.status)
    ) {
      return badRequest("상태는 N, Y, 없음 중 하나여야 합니다.");
    }
    patch.status = body.status as RecordStatus;
  }

  if (Object.keys(patch).length === 0) return badRequest("바꿀 내용이 없습니다.");

  try {
    const record = await updateRecord(id, patch);

    let addedToDictionary: string | null = null;
    if (record.status === "Y" && record.category) {
      addedToDictionary = await addToDictionaryIfNew(record.resource_name, record.category);
    }

    // "자원 아님"은 이름을 블랙리스트에 남긴다. 다음 추출에서 같은 것을 또 뽑지 않으려고.
    // 되돌리면(Y) 뺀다 — 안 빼면 되돌린 뒤 다시 뽑을 때 또 '없음'이 된다.
    // 여기서 실패해도 상태 변경 자체는 끝났으므로 되돌리지 않고 알리기만 한다.
    let blacklisted: string | null = null;
    try {
      if (patch.status === "없음") {
        await addToBlacklist(record.resource_name);
        blacklisted = record.resource_name;
      } else if (patch.status === "Y") {
        await removeFromBlacklist(record.resource_name);
      }
    } catch (error) {
      console.error("[blacklist]", error);
    }

    return ok({ record, added_to_dictionary: addedToDictionary, blacklisted });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("이미 있습니다")) return badRequest(message);
    return serverError("PATCH /api/resource-records/:id", error);
  }
}

/**
 * 사전에 없는 이름이면 사전에 넣는다. 넣었으면 그 이름을, 아니면 null 을 돌려준다.
 *
 * 여기서 실패해도 수정 자체는 이미 끝났다. 사전 등록은 덤이라 수정을 되돌리지 않는다.
 */
async function addToDictionaryIfNew(name: string, category: string): Promise<string | null> {
  try {
    const dictionary = await listResources();
    const key = name.trim().toLowerCase();
    if (dictionary.some((item) => item.name.trim().toLowerCase() === key)) return null;

    await addResource(name, category, null);
    return name;
  } catch (error) {
    console.error("[addToDictionaryIfNew]", error);
    return null;
  }
}

/* ---------- DELETE /api/resource-records/:id ---------- */

export async function handleResourceRecordDelete(id: string): Promise<Response> {
  try {
    await deleteRecord(id);
    return new Response(null, { status: 204, headers: JSON_HEADERS });
  } catch (error) {
    return serverError("DELETE /api/resource-records/:id", error);
  }
}
