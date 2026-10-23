/**
 * 개인정보 동의 · 공개 문서 API (③단계)
 *
 *   GET  /api/auth/consent     지금 사람이 동의해야 하나 + 안내 문구 (공개 — 세션 없으면 needed:false)
 *   POST /api/auth/consent     { agreed: true } → 동의 시각 기록(로그인한 사람, 폰 포함)
 *   GET  /api/public/privacy   처리방침 전문 + 센터 이름 (공개 — 로그인 화면 하단 링크)
 *
 * [기존 계정은 다음 로그인 때 한 번]
 * 034 로 칸이 생기면 기존 계정은 모두 "아직" 이다. 화면 입구(main.ts)가 /login 으로 돌려보내고,
 * 로그인 화면이 이 안내를 띄운다. 034 전 DB 면 묻지 않는다(적을 칸이 없다).
 *
 * 문구는 settings(lib/documents.ts) 에서 읽는다 — 업체 이름을 코드에 두지 않는다.
 * 이 파일은 Supabase 를 직접 부르지 않는다. /db 만 쓴다.
 */
import { getPrivacyAgreedAt, markPrivacyAgreed } from "../db/accounts.ts";
import { getSetting } from "../db/settings.ts";
import {
  CENTER_NAME_KEY,
  fillCenter,
  PRIVACY_POLICY_KEY,
  type PrivacyPolicy,
  readCenterName,
  readPrivacyPolicy,
} from "../lib/documents.ts";
import { resolveSession } from "./guard.ts";

const JSON_HEADERS = { "cache-control": "no-store" };

function ok(body: unknown): Response {
  return Response.json(body, { headers: JSON_HEADERS });
}

function fail(status: number, message: string): Response {
  return Response.json({ error: message }, { status, headers: JSON_HEADERS });
}

function serverError(where: string, error: unknown): Response {
  console.error(`[${where}]`, error);
  return fail(500, "요청을 처리하지 못했습니다.");
}

/** 센터 이름을 채운 처리방침 */
export async function loadPolicy(): Promise<{ center: string; policy: PrivacyPolicy }> {
  const [centerRaw, policyRaw] = await Promise.all([
    getSetting<unknown>(CENTER_NAME_KEY, null),
    getSetting<unknown>(PRIVACY_POLICY_KEY, null),
  ]);
  const center = readCenterName(centerRaw);
  const raw = readPrivacyPolicy(policyRaw);
  const policy: PrivacyPolicy = {
    title: fillCenter(raw.title, center),
    intro: fillCenter(raw.intro, center),
    sections: raw.sections.map((one) => ({
      title: fillCenter(one.title, center),
      body: fillCenter(one.body, center),
    })),
    staff_notice: fillCenter(raw.staff_notice, center),
    staff_agree: fillCenter(raw.staff_agree, center),
  };
  return { center, policy };
}

/** 이 사람이 아직 동의 전인가. 034 전 DB 면 false. 입구(main.ts)도 쓴다. */
export async function needsConsent(staffId: string): Promise<boolean> {
  return (await getPrivacyAgreedAt(staffId)) === null;
}

export async function handleConsentState(req: Request): Promise<Response> {
  try {
    const found = await resolveSession(req);
    if (!found) return ok({ needed: false });
    if (!(await needsConsent(found.account.id))) return ok({ needed: false });
    const { policy } = await loadPolicy();
    return ok({
      needed: true,
      name: found.account.name,
      notice: policy.staff_notice,
      agree: policy.staff_agree,
    });
  } catch (error) {
    return serverError("GET /api/auth/consent", error);
  }
}

export async function handleConsentAgree(req: Request): Promise<Response> {
  let body: Record<string, unknown> | null = null;
  try {
    body = await req.json();
  } catch {
    return fail(400, "요청 본문이 JSON이 아닙니다.");
  }
  if (body?.agreed !== true) return fail(400, "안내를 읽고 동의에 체크해 주세요.");
  try {
    const found = await resolveSession(req);
    if (!found) return fail(401, "로그인이 필요합니다.");
    const at = await markPrivacyAgreed(found.account.id);
    return ok({ agreed_at: at, user: found.account });
  } catch (error) {
    return serverError("POST /api/auth/consent", error);
  }
}

export async function handlePublicPrivacy(): Promise<Response> {
  try {
    return ok(await loadPolicy());
  } catch (error) {
    return serverError("GET /api/public/privacy", error);
  }
}
