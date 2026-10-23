/**
 * 반기 평가 API
 *
 *   GET  /api/children/:id/evaluation?year=&half=      저장된 평가 + 근거 비교 + 정량 참고
 *   POST /api/children/:id/evaluation/draft            AI 초안 생성 (저장 안 함)
 *   PUT  /api/children/:id/evaluation                  저장 (근거 스냅샷 함께 찍음)
 *   POST /api/children/:id/evaluation/evidence-check   [확인함]
 *
 * 이 파일은 Supabase도 Claude도 직접 부르지 않는다.
 * 각각 /db 와 /lib 을 거친다.
 *
 * [비교는 서버가 한다]
 * 브라우저에서 견주려면 스냅샷과 관찰 전부를 화면에 내려보내야 한다.
 * 무엇을 내려보낼지는 서버가 정한다는 원칙(4)에 어긋나고, 화면 코드가 바뀌면
 * 판단도 함께 흔들린다. 여기서 견주고 결과만 보낸다.
 *
 * [정량 점수는 참고일 뿐이다]
 * 봉사자가 매긴 점수는 AI 프롬프트에도, 근거 스냅샷에도 들어가지 않는다.
 * 평가의 근거는 관찰 기록이고, 점수는 그 옆에 놓고 보는 참고값이다.
 */
import { NotFoundError, RuleError } from "../db/client.ts";
import {
  type EvaluationContent,
  getYearlyEval,
  markEvidenceChecked,
  saveYearlyEval,
} from "../db/evaluations.ts";
import { type Half, listObservationsByChild } from "../db/observations.ts";
import { currentAreas } from "../lib/obs_areas.ts";
import { HALF_OBSERVATION_ENABLED } from "../lib/features.ts";
import { findObservationRemovals } from "../db/audit.ts";
import { listHalfObservationsByChild } from "../db/half_observations.ts";
import { getSetting } from "../db/settings.ts";
import { draftEvaluation } from "../lib/draft_evaluation.ts";
import { buildSnapshot, countChanges, diffSnapshot } from "../lib/evidence.ts";
import { areaAverages, HALF_AREAS, isComplete, readItems } from "../lib/half_items.ts";
import { currentUser } from "../lib/request_context.ts";

/** 한 영역 서술문의 길이 상한. DB의 jsonb 에는 제한이 없어 여기서 막는다. */
const TEXT_MAX = 4000;

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

/** year·half 를 검사한다. 잘못되면 안내 문구를, 맞으면 값을 돌려준다. */
function parsePeriod(
  year: unknown,
  half: unknown,
): { year: number; half: Half } | string {
  const y = Number(year);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) {
    return "year 는 2000~2100 사이의 정수여야 합니다.";
  }
  const h = Number(half);
  if (h !== 1 && h !== 2) {
    return "half 는 1(상반기) 또는 2(하반기)여야 합니다.";
  }
  return { year: y, half: h as Half };
}

/* ---------- 근거 비교 ---------- */

/**
 * 찍어 둔 근거와 지금 근거를 견준다.
 *
 * 사라진 것은 왜 사라졌는지까지 가린다.
 *   병합됨   다른 관찰에 합쳐졌다 — 내용은 남아 있다
 *   삭제됨   지워졌다
 *   영역 미지정  관찰은 그대로 있는데 영역이 풀려 근거에서 빠졌다
 * 사람이 해야 할 일이 셋 다 다르다.
 */
async function buildEvidence(
  childId: string,
  period: { year: number; half: Half },
  snapshot: Awaited<ReturnType<typeof buildSnapshot>> | null,
  checked: { at: string | null; by: string | null },
) {
  const rows = await listObservationsByChild(childId, period.year, period.half);

  // 추적 이전 평가. 견줄 것이 없으니 화면에 그렇게 적는다.
  if (!snapshot) {
    return { tracked: false, total: 0, checked_at: checked.at, checked_by_name: checked.by };
  }

  const current = await buildSnapshot(rows);
  const diff = diffSnapshot(snapshot, current);
  const byId = new Map(rows.map((one) => [one.id, one]));

  const describe = (id: string) => {
    const one = byId.get(id);
    return {
      obs_id: id,
      obs_date: one?.obs_date ?? null,
      area: one?.area ?? null,
      content: one?.content ?? "",
    };
  };

  // 아직 표에 남아 있는 것은 기록을 뒤질 필요가 없다 — 영역이 풀린 경우다.
  const gone = diff.removed.filter((id) => !byId.has(id));
  const removals = await findObservationRemovals(gone);

  return {
    tracked: true,
    total: countChanges(diff),
    checked_at: checked.at,
    checked_by_name: checked.by,
    modified: diff.modified.map(describe),
    added: diff.added.map(describe),
    removed: diff.removed.map((id) => {
      const still = byId.get(id);
      if (still) {
        return {
          obs_id: id,
          kind: "영역 미지정",
          obs_date: still.obs_date,
          content: still.content,
        };
      }
      const found = removals.get(id);
      return {
        obs_id: id,
        kind: found?.kind === "병합" ? "병합됨" : found ? "삭제됨" : "사라짐",
        obs_date: found?.obs_date ?? null,
        content: found?.content ?? "",
      };
    }),
  };
}

/* ---------- 정량 참고 ---------- */

/**
 * 그 아동·그 반기의 봉사자 정량 관찰. 없으면 null — 화면이 카드째 생략한다.
 *
 * 관찰자마다 한 장이라 사람 수만큼 장이 있다. 영역 평균은 장마다 낸 평균을
 * 다시 평균한다 — 항목을 많이 채운 사람이 더 무거워지지 않게, 사람 하나를 하나로 센다.
 */
async function buildQuant(childId: string, period: { year: number; half: Half }) {
  const [rows, raw] = await Promise.all([
    listHalfObservationsByChild(childId),
    getSetting<unknown>("half_observation_items", []),
  ]);
  const records = rows.filter((one) => one.year === period.year && one.half === period.half);
  if (records.length === 0) return null;

  const items = readItems(raw);
  const areas = HALF_AREAS.map((area) => {
    const values = records
      .map((one) => areaAverages(items, one.scores ?? {})[area])
      .filter((value): value is number => value !== null);
    return {
      area,
      avg: values.length
        ? Math.round((values.reduce((sum, v) => sum + v, 0) / values.length) * 10) / 10
        : null,
    };
  });

  return {
    areas,
    authors: records.length,
    partial: records.filter((one) => !isComplete(items, one.scores ?? {})).length,
  };
}

/* ---------- GET /api/children/:id/evaluation ---------- */

export async function handleEvaluationGet(req: Request, childId: string): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const period = parsePeriod(params.get("year"), params.get("half"));
  if (typeof period === "string") return badRequest(period);

  try {
    const evaluation = await getYearlyEval(childId, period.year, period.half);
    const [evidence, quant] = await Promise.all([
      // 저장된 평가가 없으면 견줄 것도 없다.
      evaluation
        ? buildEvidence(childId, period, evaluation.evidence_snapshot, {
          at: evaluation.evidence_checked_at,
          by: evaluation.checked_by_name,
        })
        : Promise.resolve(null),
      // 반기별 관찰을 숨긴 동안은 정량 참고도 내지 않는다(lib/features.ts)
      HALF_OBSERVATION_ENABLED ? buildQuant(childId, period) : Promise.resolve(null),
    ]);

    return ok({ evaluation, evidence, quant });
  } catch (error) {
    return serverError("GET /api/children/:id/evaluation", error);
  }
}

/* ---------- POST /api/children/:id/evaluation/draft ---------- */

/**
 * AI 초안을 만든다. 저장하지 않는다.
 * 사람이 화면에서 고치고 저장을 눌러야 기록이 된다.
 *
 * 봉사자 정량 점수는 여기 들어가지 않는다 — 초안의 근거는 관찰 기록뿐이다.
 */
export async function handleEvaluationDraft(req: Request, childId: string): Promise<Response> {
  const body = await readJson(req);
  if (!body) return badRequest("요청 본문이 JSON이 아닙니다.");

  const period = parsePeriod(body.year, body.half);
  if (typeof period === "string") return badRequest(period);

  try {
    const draft = await draftEvaluation(childId, period.year, period.half);
    return ok(draft);
  } catch (error) {
    // 초안을 못 만들어도 저장된 평가는 그대로다.
    // 왜 실패했는지 알아야 다시 시도할지 판단할 수 있으므로
    // 게이트웨이가 만든 사람이 읽을 수 있는 메시지를 그대로 내보낸다.
    console.error("[POST /api/children/:id/evaluation/draft]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "초안을 만들지 못했습니다." },
      { status: 502, headers: JSON_HEADERS },
    );
  }
}

/* ---------- PUT /api/children/:id/evaluation ---------- */

export async function handleEvaluationSave(req: Request, childId: string): Promise<Response> {
  const body = await readJson(req);
  if (!body) return badRequest("요청 본문이 JSON이 아닙니다.");

  const period = parsePeriod(body.year, body.half);
  if (typeof period === "string") return badRequest(period);

  const raw = body.content;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return badRequest("content 는 영역별 객체여야 합니다.");
  }

  // 아는 영역만 저장한다. 모르는 키가 섞여 들어오면 나중에 화면이 읽지 못한다.
  // 지운 영역(예전 영역)의 글도 받는다 — 그때 쓴 평가를 지우지 않고 남긴다.
  const known = new Set((await currentAreas()).map((one) => one.code));
  const content: EvaluationContent = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!known.has(key)) {
      return badRequest(`모르는 영역입니다: ${key}`);
    }
    if (typeof value !== "string") return badRequest(`${key} 의 값은 글이어야 합니다.`);
    if (value.length > TEXT_MAX) {
      return badRequest(`${key} 의 글이 ${TEXT_MAX}자를 넘습니다.`);
    }
    const trimmed = value.trim();
    // 빈 칸은 넣지 않는다. 영역 목록이 바뀌어도 빈 값이 남지 않게.
    if (trimmed) content[key] = trimmed;
  }

  try {
    // 무엇을 읽고 썼는지 이 순간으로 찍는다. 화면이 보낸 목록을 믿지 않는다 —
    // 근거는 서버가 보는 지금의 관찰이다.
    const rows = await listObservationsByChild(childId, period.year, period.half);
    const snapshot = await buildSnapshot(rows);

    const evaluation = await saveYearlyEval(
      childId,
      period.year,
      period.half,
      content,
      snapshot,
    );
    return ok({ evaluation });
  } catch (error) {
    return serverError("PUT /api/children/:id/evaluation", error);
  }
}

/* ---------- POST /api/children/:id/evaluation/evidence-check ---------- */

/**
 * [확인함] — 바뀐 근거를 읽고 받아들였다.
 *
 * 스냅샷을 지금 것으로 다시 찍는다. 평가 본문은 건드리지 않는다.
 * 누가 눌렀는지는 세션에서만 읽는다 — 본문으로 받으면 남의 이름으로 확인할 수 있다.
 */
export async function handleEvidenceCheck(req: Request, childId: string): Promise<Response> {
  const who = currentUser();
  if (!who) {
    return Response.json(
      { error: "로그인이 필요합니다." },
      { status: 401, headers: JSON_HEADERS },
    );
  }

  const body = await readJson(req);
  if (!body) return badRequest("요청 본문이 JSON이 아닙니다.");

  const period = parsePeriod(body.year, body.half);
  if (typeof period === "string") return badRequest(period);

  try {
    const rows = await listObservationsByChild(childId, period.year, period.half);
    const snapshot = await buildSnapshot(rows);
    const evaluation = await markEvidenceChecked(
      childId,
      period.year,
      period.half,
      snapshot,
      who.id,
    );
    return ok({ evaluation });
  } catch (error) {
    if (error instanceof Error && error.message === "저장된 평가가 없습니다.") {
      return badRequest("저장된 평가가 없습니다. 먼저 저장해 주세요.");
    }
    return serverError("POST /api/children/:id/evaluation/evidence-check", error);
  }
}
