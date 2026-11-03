/**
 * 감사 로그 API  ★ 관리자 전용
 *
 *   GET /api/audit?table=&action=&from=&to=&cursor=&limit=
 *
 * before/after 에 민감정보가 그대로 들어간다. 정책표가 관리자만 연다.
 * 목록은 15건씩(커서). 필터를 걸면 필터 결과 기준으로 15건이다.
 *
 * 쓰기 API 는 없다. 기록은 서버 안(/db)에서만 일어난다.
 *
 * 이 파일은 Supabase를 직접 부르지 않는다. /db의 함수만 사용한다.
 */
import { type AuditAction, listAudit } from "../db/audit.ts";
import { RuleError } from "../db/client.ts";

const ACTIONS = ["create", "update", "delete", "login"] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LIMIT_DEFAULT = 15;
const LIMIT_MAX = 100;

const JSON_HEADERS = { "cache-control": "no-store" };

function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400, headers: JSON_HEADERS });
}

export async function handleAuditList(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;

  const table = params.get("table")?.trim() || null;
  if (table && table.length > 60) return badRequest("table 값이 너무 깁니다.");

  const actionRaw = params.get("action")?.trim() || null;
  if (actionRaw && !(ACTIONS as readonly string[]).includes(actionRaw)) {
    return badRequest("action 은 create, update, delete, login 중 하나여야 합니다.");
  }

  const from = params.get("from")?.trim() || null;
  const to = params.get("to")?.trim() || null;
  if (from && !DATE_RE.test(from)) return badRequest("from 은 YYYY-MM-DD 여야 합니다.");
  if (to && !DATE_RE.test(to)) return badRequest("to 는 YYYY-MM-DD 여야 합니다.");
  if (from && to && from > to) return badRequest("from 이 to 보다 뒤일 수 없습니다.");

  const cursor = params.get("cursor")?.trim() || null;

  const limitRaw = params.get("limit")?.trim();
  const limit = limitRaw ? Number(limitRaw) : LIMIT_DEFAULT;
  if (!Number.isInteger(limit) || limit < 1 || limit > LIMIT_MAX) {
    return badRequest(`limit 은 1에서 ${LIMIT_MAX} 사이여야 합니다.`);
  }

  try {
    const page = await listAudit({
      table,
      action: actionRaw as AuditAction | null,
      from,
      to,
      cursor,
      limit,
    });
    return Response.json(page, { headers: JSON_HEADERS });
  } catch (error) {
    if (error instanceof RuleError) return badRequest(error.message);
    console.error("[GET /api/audit]", error);
    return Response.json(
      { error: "요청을 처리하지 못했습니다." },
      { status: 500, headers: JSON_HEADERS },
    );
  }
}
