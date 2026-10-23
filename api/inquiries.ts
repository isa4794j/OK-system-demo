/**
 * 문의함 — 봉사자가 폰에서 보낸 불편사항을 종사자가 읽는 자리
 *
 *   GET  /api/inquiries            목록 + 안 읽은 건수
 *   POST /api/inquiries/:id/seen   [확인함]
 *
 * 보내는 쪽은 여기 없다. 봉사자는 /api/my/inquiries 로만 보낸다 —
 * 이 경로는 정책표에서 종사자 이상이라 폰에서는 열리지 않는다.
 *
 * 답장은 없다. 주고받기 시작하면 메신저를 만들게 되고, 그건 이 시스템의 일이 아니다.
 *
 * 이 파일은 Supabase 를 직접 부르지 않는다. /db 만 쓴다.
 */
import { NotFoundError, RuleError } from "../db/client.ts";
import { countUnseenInquiries, listInquiries, markInquirySeen } from "../db/inquiries.ts";
import { currentUser } from "../lib/request_context.ts";

const JSON_HEADERS = { "cache-control": "no-store" };

function ok(body: unknown): Response {
  return Response.json(body, { headers: JSON_HEADERS });
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

export async function handleInquiriesList(): Promise<Response> {
  try {
    const rows = await listInquiries();
    return ok({
      inquiries: rows.map((one) => ({
        id: one.id,
        staff_name: one.staff_name,
        content: one.content,
        created_at: one.created_at,
        seen_at: one.seen_at,
      })),
      unseen: rows.filter((one) => !one.seen_at).length,
    });
  } catch (error) {
    return serverError("GET /api/inquiries", error);
  }
}

/**
 * 뱃지만 세는 자리. 목록을 통째로 받지 않고 수만 받는다 —
 * 서브탭을 열 때마다 문의 본문을 다 내려보낼 이유가 없다.
 */
export async function handleInquiriesCount(): Promise<Response> {
  try {
    return ok({ unseen: await countUnseenInquiries() });
  } catch (error) {
    return serverError("GET /api/inquiries/count", error);
  }
}

/**
 * 봤다고 표시한다. 누가 언제 봤는지 남는다.
 *
 * 감사 로그에는 안 적는다. 지우거나 값을 바꾸는 일이 아니라
 * "읽음" 표시일 뿐이고, 그 자체가 seen_by·seen_at 으로 이미 남는다.
 */
export async function handleInquirySeen(id: string): Promise<Response> {
  const who = currentUser();
  if (!who) {
    return Response.json(
      { error: "로그인이 필요합니다." },
      { status: 401, headers: JSON_HEADERS },
    );
  }

  try {
    await markInquirySeen(id, who.id);
    return ok({ ok: true });
  } catch (error) {
    return serverError("POST /api/inquiries/:id/seen", error);
  }
}
