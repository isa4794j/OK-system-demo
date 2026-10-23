/**
 * 자원 API
 *
 *   GET    /api/resources?category=보드게임   목록 (카테고리 필터는 선택)
 *   POST   /api/resources                     등록
 *   POST   /api/resources/batch               여러 건 등록 (사진 인식 결과)
 *   POST   /api/resources/from-photo          사진에서 자원 이름 읽기 (AI, 저장 안 함)
 *   PATCH  /api/resources/:id                 수정
 *   DELETE /api/resources/:id                 삭제 (사전에서만 뺀다)
 *   GET    /api/resources/:id/record-count    그 자원의 기록 수 (확인창용)
 *   POST   /api/resources/:id/merge           다른 자원에 합친다 { into: id }
 *   POST   /api/resources/:id/split           별칭 하나를 떼어낸다 { alias: "스마트올" }
 *   POST   /api/resources/:id/reject          자원 아님 (기록 '없음' + 블랙리스트 + 사전 삭제)
 *   GET    /api/resource-categories           카테고리 목록
 *   PUT    /api/resource-categories           카테고리 목록 바꾸기 (추가·순서·삭제·이름변경)
 *
 * 이 파일은 Supabase를 직접 부르지 않는다. /db의 함수만 사용한다.
 * 형식 검증은 여기서 끝내고, 틀리면 DB까지 가지 않고 400으로 끊는다.
 */
import { NotFoundError, RuleError } from "../db/client.ts";
import {
  addResource,
  addToBlacklist,
  countResourcesInCategory,
  deleteResource,
  getResource,
  getResourceCategories,
  listResources,
  mergeResource,
  recordCategoryChange,
  renameResourceCategory,
  saveResourceCategories,
  splitAlias,
  updateResource,
} from "../db/resources.ts";
import {
  countRecordsByName,
  countUnknownRawName,
  moveRecords,
  moveRecordsByRawName,
  recordRejectionAudit,
  renameCategoryInRecords,
  setCategoryByName,
  setStatusByName,
} from "../db/resource_records.ts";
import { AIServiceError, checkImageData, IMAGE_TYPES, type ImageType } from "../lib/ai.ts";
import { recognizeResources } from "../lib/recognize_resources.ts";

/**
 * 사진 크기 상한 (원본 바이트 기준). 화면이 먼저 줄여 보내므로 보통 훨씬 작다.
 * 이 값은 "실수로 원본 그대로 올린" 경우를 막는 마지막 벽이다.
 */
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** 한 번에 등록할 상한. 사진 한 장에서 나올 만한 수보다 넉넉하게. */
const BATCH_MAX = 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NAME_MAX = 100;
const CATEGORY_MAX = 30;
const ALIASES_MAX = 500;

/** 카테고리가 스무 개를 넘으면 고르는 화면이 이미 못 쓸 물건이 된다. */
const CATEGORY_COUNT_MAX = 20;

const JSON_HEADERS = { "cache-control": "no-store" };

function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400, headers: JSON_HEADERS });
}

/** 없는 자원 — 404 */
function notFoundJson(message: string): Response {
  return Response.json({ error: message }, { status: 404, headers: JSON_HEADERS });
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

/* ---------- 값 검증 ---------- */

/** 자원명. 비어 있으면 안 되고 상한을 넘으면 안 된다. 잘못되면 null. */
function parseName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > NAME_MAX) return null;
  return trimmed;
}

/**
 * 카테고리. 목록에 있는 값인지는 보지 않는다.
 *
 * 화면의 드롭다운은 목록에서 만들어지므로 사람이 아무 값이나 넣을 수 없다.
 * 그리고 나중에 일지에서 자원을 뽑을 때(자-2) 목록에 없는 이름이 먼저 올 수 있다.
 * 그때 저장이 막히면 뽑은 것을 버려야 한다. 화면이 그런 자원을 따로 모아 보여준다.
 */
function parseCategory(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > CATEGORY_MAX ? undefined : trimmed;
}

/** 별칭. 없어도 된다. 다듬는 일은 /db 가 한다. */
function parseAliases(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > ALIASES_MAX ? undefined : trimmed;
}

/* ---------- GET /api/resources ---------- */

export async function handleResourcesList(req: Request): Promise<Response> {
  const category = new URL(req.url).searchParams.get("category")?.trim() ?? "";
  if (category.length > CATEGORY_MAX) return badRequest("category 값이 너무 깁니다.");

  try {
    // 카테고리 목록도 함께 준다. 화면이 자원을 묶어 그리려면 둘 다 필요한데,
    // 요청을 두 번 보내면 목록만 먼저 와서 잠깐 잘못된 묶음이 보인다.
    const [resources, categories] = await Promise.all([
      listResources(category || null),
      getResourceCategories(),
    ]);
    return ok({ resources, categories });
  } catch (error) {
    return serverError("GET /api/resources", error);
  }
}

/* ---------- POST /api/resources ---------- */

export async function handleResourceCreate(req: Request): Promise<Response> {
  const body = await readJson(req);
  if (!body) return badRequest("요청 본문이 JSON이 아닙니다.");

  const name = parseName(body.name);
  if (name === null) {
    return badRequest(`자원명은 비어 있을 수 없고 ${NAME_MAX}자를 넘을 수 없습니다.`);
  }

  const category = parseCategory(body.category);
  if (category === undefined) return badRequest(`카테고리는 ${CATEGORY_MAX}자를 넘을 수 없습니다.`);
  if (category === null) return badRequest("카테고리를 골라 주세요.");

  const aliases = parseAliases(body.aliases);
  if (aliases === undefined) return badRequest(`별칭은 ${ALIASES_MAX}자를 넘을 수 없습니다.`);

  try {
    // 카테고리는 목록에 있는 것만 — 없는 이름이 들어가면 자원사전·통계에 떠도는 묶음이 생긴다
    if (!(await getResourceCategories()).includes(category)) {
      return badRequest(`"${category}" 은(는) 카테고리 목록에 없습니다. 목록에서 골라 주세요.`);
    }
    const resource = await addResource(name, category, aliases);
    return ok({ resource });
  } catch (error) {
    // "이미 있는 자원" 은 사람이 고칠 수 있는 일이라 그대로 알린다.
    // 그 밖의 실패는 안쪽 사정이므로 감춘다.
    const message = error instanceof Error ? error.message : "";
    if (message.includes("이미 자원사전에")) return badRequest(message);
    return serverError("POST /api/resources", error);
  }
}

/* ---------- POST /api/resources/batch ---------- */

/**
 * 여러 건을 한 번에 등록한다. 사진 인식 결과를 체크해 넘길 때 쓴다.
 *
 * 한 건이 이미 있어도 나머지는 들어간다. 사진 한 장에 스무 개가 나왔는데
 * 하나가 겹친다고 통째로 실패하면 쓸 수 없다.
 * 못 넣은 것은 이유와 함께 돌려주어 화면이 알릴 수 있게 한다.
 */
export async function handleResourceBatch(req: Request): Promise<Response> {
  const body = await readJson(req);
  if (!body) return badRequest("요청 본문이 JSON이 아닙니다.");

  const raw = body.items;
  if (!Array.isArray(raw) || raw.length === 0) return badRequest("등록할 항목이 없습니다.");
  if (raw.length > BATCH_MAX) return badRequest(`한 번에 ${BATCH_MAX}건까지 등록할 수 있습니다.`);

  const created = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  let allowed: string[];
  try {
    allowed = await getResourceCategories();
  } catch (error) {
    return serverError("POST /api/resources/batch", error);
  }

  for (const entry of raw) {
    const item = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    const name = parseName(item.name);
    if (name === null) {
      skipped.push({ name: String(item.name ?? ""), reason: "이름이 비어 있거나 너무 깁니다." });
      continue;
    }
    const category = parseCategory(item.category);
    if (!category) {
      skipped.push({ name, reason: "카테고리가 없습니다." });
      continue;
    }
    if (!allowed.includes(category)) {
      skipped.push({ name, reason: "카테고리 목록에 없는 이름입니다." });
      continue;
    }
    const aliases = parseAliases(item.aliases);

    try {
      created.push(await addResource(name, category, aliases === undefined ? null : aliases));
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      skipped.push({
        name,
        reason: message.includes("이미 자원사전에") ? "이미 등록됨" : "등록 실패",
      });
      if (!message.includes("이미 자원사전에")) console.error("[batch]", error);
    }
  }

  return ok({ created, skipped });
}

/* ---------- POST /api/resources/from-photo ---------- */

/**
 * 사진에서 자원 이름을 읽는다. 저장하지 않는다.
 *
 * 본문: { image: base64 문자열, mime_type: "image/jpeg" 등 }
 * 사진은 여기서 AI 로 갔다가 응답과 함께 버려진다. 디스크에도 DB 에도 남지 않는다.
 */
export async function handleResourcesFromPhoto(req: Request): Promise<Response> {
  const body = await readJson(req);
  if (!body) return badRequest("요청 본문이 JSON이 아닙니다.");

  const mime = typeof body.mime_type === "string" ? body.mime_type.trim().toLowerCase() : "";
  if (!(IMAGE_TYPES as readonly string[]).includes(mime)) {
    return badRequest("사진은 JPEG, PNG, WebP, GIF 만 올릴 수 있습니다.");
  }

  const image = typeof body.image === "string" ? body.image.trim() : "";
  if (!image) return badRequest("사진이 비어 있습니다.");

  // base64 는 원본의 4/3 크기다. 디코드하지 않고 길이로 어림한다.
  const bytes = Math.floor(image.length * 3 / 4);
  if (bytes > IMAGE_MAX_BYTES) {
    return badRequest(
      `사진이 너무 큽니다 (${Math.round(bytes / 1024 / 1024)}MB). 5MB 이하로 올려 주세요.`,
    );
  }

  const broken = checkImageData(image, mime as ImageType);
  if (broken) return badRequest(broken);

  try {
    const items = await recognizeResources(image, mime as ImageType);
    return ok({ items });
  } catch (error) {
    // AI 게이트웨이가 만든 사람이 읽을 수 있는 메시지는 그대로 내보낸다.
    // AI 쪽(설정·서버·연결) 실패인지도 알린다 — 그때 화면은 "다른 사진으로" 라고 하지 않는다.
    console.error("[POST /api/resources/from-photo]", error);
    return Response.json(
      {
        error: error instanceof Error ? error.message : "사진을 읽지 못했습니다.",
        ai_service: error instanceof AIServiceError,
      },
      { status: 502, headers: JSON_HEADERS },
    );
  }
}

/* ---------- PATCH /api/resources/:id ---------- */

export async function handleResourceUpdate(req: Request, id: string): Promise<Response> {
  const body = await readJson(req);
  if (!body) return badRequest("요청 본문이 JSON이 아닙니다.");

  const patch: { name?: string; category?: string | null; aliases?: string | null } = {};

  if ("name" in body) {
    const name = parseName(body.name);
    if (name === null) {
      return badRequest(`자원명은 비어 있을 수 없고 ${NAME_MAX}자를 넘을 수 없습니다.`);
    }
    patch.name = name;
  }

  if ("category" in body) {
    const category = parseCategory(body.category);
    if (category === undefined) {
      return badRequest(`카테고리는 ${CATEGORY_MAX}자를 넘을 수 없습니다.`);
    }
    if (category === null) return badRequest("카테고리를 골라 주세요.");
    try {
      if (!(await getResourceCategories()).includes(category)) {
        return badRequest(`"${category}" 은(는) 카테고리 목록에 없습니다. 목록에서 골라 주세요.`);
      }
    } catch (error) {
      return serverError("PATCH /api/resources/:id", error);
    }
    patch.category = category;
  }

  if ("aliases" in body) {
    const aliases = parseAliases(body.aliases);
    if (aliases === undefined) return badRequest(`별칭은 ${ALIASES_MAX}자를 넘을 수 없습니다.`);
    patch.aliases = aliases;
  }

  if (Object.keys(patch).length === 0) return badRequest("바꿀 내용이 없습니다.");

  try {
    // 이름을 바꾸면 기록의 이름도 따라가야 하므로 옛 이름을 먼저 잡아 둔다
    const before = await getResource(id);
    const resource = await updateResource(id, patch);

    // 카테고리를 고치면 지난 기록까지 함께 옮긴다.
    // 안 옮기면 사람이 고쳤는데 통계는 옛 묶음에 그대로 남아, 고친 뜻이 없어진다.
    let moved = 0;
    if (patch.category !== undefined && before) {
      moved = await setCategoryByName(before.name, resource.category);
    }
    return ok({ resource, moved });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("이미 자원사전에")) return badRequest(message);
    return serverError("PATCH /api/resources/:id", error);
  }
}

/* ---------- POST /api/resources/:id/split ---------- */

/**
 * 별칭 하나를 떼어 독립된 자원으로 만든다. 합치기의 역동작이다.
 *
 * 순서는 병합과 반대다. 사전을 먼저 고치고 기록을 옮긴다.
 * 기록을 먼저 옮기면 그 이름의 자원이 아직 사전에 없어, 중간에 실패했을 때
 * 사전에 없는 이름의 기록만 남는다. 사전이 먼저 있으면 중간에 멈춰도
 * "새 자원은 생겼는데 옛 기록이 아직 안 옮겨졌다"가 되어 다시 눌러 이어 갈 수 있다.
 *
 * 옮길 수 있는 것은 raw_name(일지에 적힌 표기)이 남아 있는 기록뿐이다.
 * 020 이전 기록에는 그 값이 없어 원래 자원에 그대로 남는다. 몇 건인지 함께 돌려준다.
 */
export async function handleResourceSplit(req: Request, id: string): Promise<Response> {
  const body = await readJson(req);
  if (!body) return badRequest("요청 본문이 JSON이 아닙니다.");

  const alias = typeof body.alias === "string" ? body.alias.trim() : "";
  if (!alias) return badRequest("떼어낼 별칭을 알려 주세요.");

  try {
    const from = await getResource(id);
    if (!from) return notFoundJson("분리할 자원을 찾지 못했습니다.");

    const unknown = await countUnknownRawName(from.name);
    const { created, source } = await splitAlias(id, alias);
    const moved = await moveRecordsByRawName(from.name, alias, created.name, created.category);

    return ok({ resource: created, source, moved, unknown, alias });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("이미 자원사전에") || message.includes("별칭이 아닙니다")) {
      return badRequest(message);
    }
    return serverError("POST /api/resources/:id/split", error);
  }
}

/* ---------- DELETE /api/resources/:id ---------- */

export async function handleResourceDelete(id: string): Promise<Response> {
  try {
    await deleteResource(id);
    return new Response(null, { status: 204, headers: JSON_HEADERS });
  } catch (error) {
    return serverError("DELETE /api/resources/:id", error);
  }
}

/* ---------- GET /api/resources/:id/record-count ---------- */

/** 그 자원의 기록이 몇 건인지. 병합·자원 아님 확인창에 "N건이 옮겨집니다"를 적기 위해 쓴다. */
export async function handleResourceRecordCount(id: string): Promise<Response> {
  try {
    const resource = await getResource(id);
    if (!resource) return notFoundJson("자원을 찾지 못했습니다.");

    const count = await countRecordsByName(resource.name);
    return ok({ count, name: resource.name });
  } catch (error) {
    return serverError("GET /api/resources/:id/record-count", error);
  }
}

/* ---------- POST /api/resources/:id/merge ---------- */

/**
 * from(:id) 을 into 에 합친다.
 *
 * 순서가 중요하다. 기록을 먼저 옮기고 사전을 고친다.
 * 사전을 먼저 지우면 기록 옮기기가 실패했을 때 from 이름의 기록만 사전 없이 남는다.
 * 반대 순서면 기록은 이미 to 로 갔고 from 이 사전에 남는데, 다시 병합하면 낫는다.
 */
export async function handleResourceMerge(req: Request, fromId: string): Promise<Response> {
  const body = await readJson(req);
  if (!body) return badRequest("요청 본문이 JSON이 아닙니다.");

  const toId = typeof body.into === "string" ? body.into.trim() : "";
  if (!UUID_RE.test(toId)) return badRequest("합칠 대상(into)이 올바르지 않습니다.");
  if (toId.toLowerCase() === fromId.toLowerCase()) {
    return badRequest("자기 자신에게는 합칠 수 없습니다.");
  }

  try {
    const [from, to] = await Promise.all([getResource(fromId), getResource(toId)]);
    if (!from) return notFoundJson("합칠 자원을 찾지 못했습니다.");
    if (!to) return notFoundJson("합쳐질 자원을 찾지 못했습니다.");

    const moved = await moveRecords(from.name, to.name, to.category);
    const resource = await mergeResource(fromId, toId);
    return ok({ resource, moved, absorbed: from.name });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("이미 있어")) return badRequest(message);
    return serverError("POST /api/resources/:id/merge", error);
  }
}

/* ---------- POST /api/resources/:id/reject ---------- */

/**
 * 자원 아님. 사전에서 빼는 것으로 끝나지 않는다.
 *
 *   1. 그 이름의 기록을 전부 '없음'으로 — 통계에서 빠진다
 *   2. 블랙리스트에 넣는다 — 다음 추출에서 안 올라온다
 *   3. 사전에서 지운다
 *
 * [삭제]와 다르다. 삭제는 사전에서만 빼고 기록과 다음 추출은 건드리지 않는다.
 * "잘못 등록했다"(삭제)와 "이건 자원이 아니다"(자원 아님)는 다른 판단이다.
 */
export async function handleResourceReject(id: string): Promise<Response> {
  try {
    const resource = await getResource(id);
    if (!resource) return notFoundJson("자원을 찾지 못했습니다.");

    const rejected = await setStatusByName(resource.name, "없음");
    await addToBlacklist(resource.name);
    await recordRejectionAudit({ kind: "reject", name: resource.name, recordIds: rejected });
    await deleteResource(id);
    return ok({ name: resource.name, rejected_records: rejected.length });
  } catch (error) {
    return serverError("POST /api/resources/:id/reject", error);
  }
}

/* ---------- GET /api/resource-categories ---------- */

export async function handleResourceCategoriesGet(): Promise<Response> {
  try {
    const categories = await getResourceCategories();
    return ok({ categories });
  } catch (error) {
    return serverError("GET /api/resource-categories", error);
  }
}

/* ---------- PUT /api/resource-categories ---------- */

/** 보낸 목록이 카테고리 목록으로 쓸 만한 모양인지 본다. 문제가 있으면 그 이유를 돌려준다. */
function checkCategoryList(value: unknown): { list: string[] } | { error: string } {
  if (!Array.isArray(value)) return { error: "categories 는 배열이어야 합니다." };
  if (value.length === 0) return { error: "카테고리는 하나 이상 있어야 합니다." };
  if (value.length > CATEGORY_COUNT_MAX) {
    return { error: `카테고리는 ${CATEGORY_COUNT_MAX}개를 넘을 수 없습니다.` };
  }

  const list: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return { error: "카테고리 이름은 글자여야 합니다." };
    const trimmed = item.trim();
    if (trimmed.length === 0) return { error: "카테고리 이름은 비어 있을 수 없습니다." };
    if (trimmed.length > CATEGORY_MAX) {
      return { error: `카테고리 이름은 ${CATEGORY_MAX}자를 넘을 수 없습니다.` };
    }
    if (list.includes(trimmed)) return { error: `"${trimmed}" 이(가) 두 번 있습니다.` };
    list.push(trimmed);
  }
  return { list };
}

/**
 * 카테고리 목록을 통째로 바꾼다. 추가·순서·삭제가 모두 이 한 번으로 처리된다.
 *
 * 이름 변경만 따로 rename 으로 받는다. 목록만 봐서는 "이름을 바꾼 것"과
 * "하나 지우고 하나 만든 것"을 구분할 수 없기 때문이다.
 * 둘은 결과가 다르다 — 이름 변경은 그 안의 자원이 따라가야 한다.
 *
 * [자원이 있는 카테고리는 지울 수 없다]
 * 지우면서 자원을 '기타'로 옮기는 방법도 생각했지만 그렇게 하지 않았다.
 * 자원 스무 개가 말없이 다른 묶음으로 옮겨 가면, 나중에 통계(자-3)를 볼 때
 * 왜 기타가 늘었는지 아무도 설명하지 못한다.
 * 대신 이름 바꾸기로 통째로 옮길 수 있게 해 두었다. 그쪽이 하는 일이 눈에 보인다.
 */
export async function handleResourceCategoriesSave(req: Request): Promise<Response> {
  const body = await readJson(req);
  if (!body) return badRequest("요청 본문이 JSON이 아닙니다.");

  const checked = checkCategoryList(body.categories);
  if ("error" in checked) return badRequest(checked.error);
  const next = checked.list;

  // 이름 변경은 선택이다. 있으면 { from, to } 모양이어야 한다.
  let rename: { from: string; to: string } | null = null;
  if (body.rename !== null && body.rename !== undefined) {
    const raw = body.rename as Record<string, unknown>;
    const from = typeof raw?.from === "string" ? raw.from.trim() : "";
    const to = typeof raw?.to === "string" ? raw.to.trim() : "";
    if (!from || !to) return badRequest("rename 은 from 과 to 가 모두 있어야 합니다.");
    if (from === to) return badRequest("바뀐 이름이 없습니다.");
    if (!next.includes(to)) return badRequest("바꾼 이름이 보낸 목록에 없습니다.");
    if (next.includes(from)) return badRequest("바꾸기 전 이름이 목록에 그대로 남아 있습니다.");
    rename = { from, to };
  }

  try {
    const current = await getResourceCategories();

    if (rename && !current.includes(rename.from)) {
      return badRequest(`"${rename.from}" 은(는) 지금 카테고리 목록에 없습니다.`);
    }

    // 사라진 카테고리 중 자원이 남아 있는 것이 있으면 막는다.
    // 이름을 바꾼 것은 사라진 것이 아니다.
    const removed = current.filter(
      (name) => !next.includes(name) && name !== rename?.from,
    );
    for (const name of removed) {
      const count = await countResourcesInCategory(name);
      if (count > 0) {
        return badRequest(
          `"${name}" 에 자원 ${count}건이 있어 지울 수 없습니다. ` +
            `이름을 바꿔 옮기거나, 자원을 하나씩 다른 카테고리로 옮겨 주세요.`,
        );
      }
    }

    // 자원과 기록을 먼저 옮기고 목록을 바꾼다.
    // 반대로 하면 옮기다 실패했을 때 목록에 없는 카테고리의 자원이 남는다.
    // 기록(resource_records)도 옮긴다 — 통계는 기록의 카테고리로 묶기 때문이다.
    let moved = 0;
    let movedRecords = 0;
    if (rename) {
      moved = await renameResourceCategory(rename.from, rename.to);
      movedRecords = await renameCategoryInRecords(rename.from, rename.to);
    }

    await saveResourceCategories(next);
    await recordCategoryChange({ before: current, after: next, rename, moved, movedRecords });
    return ok({ categories: next, moved, moved_records: movedRecords });
  } catch (error) {
    return serverError("PUT /api/resource-categories", error);
  }
}
