/**
 * 자원 통계 API
 *
 *   GET /api/resource-stats?view=category&from=&to=
 *   GET /api/resource-stats?view=resource&from=&to=&prev_from=&prev_to=
 *   GET /api/resource-stats?view=idle&cutoff=60
 *
 * 이 파일은 Supabase를 직접 부르지 않는다. /db의 함수만 사용한다.
 * AI도 부르지 않는다. 세는 일뿐이라 크레딧이 들지 않는다.
 */
import { NotFoundError, RuleError } from "../db/client.ts";
import { idleResources, statsByCategory, statsByResource } from "../db/resource_stats.ts";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 방치 기준의 상·하한. 너무 짧으면 전부 뜨고, 너무 길면 아무것도 안 뜬다. */
const CUTOFF_MIN = 7;
const CUTOFF_MAX = 365;
const CUTOFF_DEFAULT = 60;

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

/** "YYYY-MM-DD" 이면서 달력에 실제로 있는 날짜인지 본다. */
function isValidDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

/** from/to 한 쌍을 읽는다. 잘못됐으면 그 이유를 돌려준다. */
function readRange(
  params: URLSearchParams,
  fromKey: string,
  toKey: string,
): { from: string; to: string } | { error: string } | null {
  const from = params.get(fromKey)?.trim() ?? "";
  const to = params.get(toKey)?.trim() ?? "";

  if (!from && !to) return null;
  if (!isValidDate(from)) return { error: `${fromKey}는 YYYY-MM-DD 형식의 실제 날짜여야 합니다.` };
  if (!isValidDate(to)) return { error: `${toKey}는 YYYY-MM-DD 형식의 실제 날짜여야 합니다.` };
  if (from > to) return { error: `${fromKey}가 ${toKey}보다 뒤일 수 없습니다.` };
  return { from, to };
}

export async function handleResourceStats(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const view = params.get("view")?.trim() ?? "";

  if (view === "idle") {
    const raw = params.get("cutoff")?.trim();
    const cutoff = raw ? Number(raw) : CUTOFF_DEFAULT;
    if (!Number.isInteger(cutoff) || cutoff < CUTOFF_MIN || cutoff > CUTOFF_MAX) {
      return badRequest(`cutoff 는 ${CUTOFF_MIN}에서 ${CUTOFF_MAX} 사이의 정수여야 합니다.`);
    }

    try {
      const resources = await idleResources(cutoff);
      return ok({ resources, cutoff });
    } catch (error) {
      return serverError("GET /api/resource-stats?view=idle", error);
    }
  }

  if (view !== "category" && view !== "resource") {
    return badRequest("view 는 category, resource, idle 중 하나여야 합니다.");
  }

  const range = readRange(params, "from", "to");
  if (range === null) return badRequest("from 과 to 가 필요합니다.");
  if ("error" in range) return badRequest(range.error);

  if (view === "category") {
    try {
      const categories = await statsByCategory(range.from, range.to);
      return ok({ categories, range });
    } catch (error) {
      return serverError("GET /api/resource-stats?view=category", error);
    }
  }

  // 견줄 기간은 선택이다. "지난 달"과 "지난 반기"는 길이가 달라
  // 서버가 날짜 수로 빼면 어긋난다. 어느 창을 견줄지는 화면이 정해 보낸다.
  const prev = readRange(params, "prev_from", "prev_to");
  if (prev && "error" in prev) return badRequest(prev.error);

  try {
    const resources = await statsByResource(range.from, range.to, prev ?? undefined);
    return ok({ resources, range, prev: prev ?? null });
  } catch (error) {
    return serverError("GET /api/resource-stats?view=resource", error);
  }
}
