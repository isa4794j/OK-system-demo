/**
 * 아동 API
 *
 *   GET    /api/children                    명단 (민감정보 없음)
 *   GET    /api/children/:id                상세 ★ 민감정보 포함
 *   POST   /api/children                    등록
 *   PATCH  /api/children/:id                수정
 *   GET    /api/children/:id/records-count  딸린 기록 수 (삭제 확인창용)
 *   DELETE /api/children/:id                삭제 (딸린 기록까지) — 지운 건수를 돌려준다
 *
 * ★ 민감정보
 * 상세·등록·수정은 보호자 연락처·주소·의뢰배경을 주고받는다.
 * 열람·수정은 종사자 이상이 설계다(정책표). 센터 안에서는 아이를 알아야 일한다.
 * 막는 선은 센터 밖이다 — AI·외부로 나가는 글은 가명화한다(lib/ai.ts callAISafe).
 * 명단(handleChildrenList)은 그 칸을 애초에 읽지 않는다.
 *
 * 이 파일은 Supabase를 직접 부르지 않는다. /db의 함수만 사용한다.
 */
import { NotFoundError, RuleError } from "../db/client.ts";
import { checkChildBirth, checkEnrollDate, todayInSeoul } from "../lib/dates.ts";
import {
  addChild,
  CHILD_STATUSES,
  type ChildPatch,
  type ChildStatus,
  countChildRecords,
  deleteChild,
  type Gender,
  GENDERS,
  getChild,
  listChildren,
  updateChild,
} from "../db/children.ts";
import { getSetting } from "../db/settings.ts";
import { atLeast, type Level } from "../lib/permission.ts";
import { currentUser } from "../lib/request_context.ts";

const NAME_MAX = 100;
const SHORT_MAX = 200;
const NOTE_MAX = 2000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const JSON_HEADERS = { "cache-control": "no-store" };

function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400, headers: JSON_HEADERS });
}

function notFound(): Response {
  return Response.json({ error: "아동을 찾지 못했습니다." }, {
    status: 404,
    headers: JSON_HEADERS,
  });
}

function serverError(where: string, error: unknown): Response {
  // 없는 대상은 404, 규칙에 어긋난 요청(없는 사람을 가리킴 등)은 400 — 사람이 읽을 말 그대로(db/client.ts)
  if (error instanceof NotFoundError) {
    return Response.json({ error: error.message }, { status: 404, headers: JSON_HEADERS });
  }
  if (error instanceof RuleError) {
    return Response.json({ error: error.message }, { status: 400, headers: JSON_HEADERS });
  }
  // DB 오류 원문에는 테이블/컬럼 구조가 드러날 수 있으므로
  // 서버 로그에만 남기고 브라우저에는 일반적인 메시지만 준다.
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

/** "YYYY-MM-DD" 이면서 달력에 실제로 있는 날짜인지 본다. */
function isValidDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

/** 짧은 글 칸. 없어도 된다. 빈 문자열은 null. 너무 길면 undefined(오류). */
function parseShort(value: unknown, max = SHORT_MAX): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > max ? undefined : trimmed;
}

/** 날짜 칸. 없어도 된다. 있으면 실제 날짜여야 한다. 아니면 undefined. */
function parseDate(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !isValidDate(value.trim())) return undefined;
  return value.trim();
}

/**
 * 본문을 읽어 저장할 모양으로 만든다. 등록과 수정이 같은 규칙을 쓴다.
 *
 * 필수: 이름, 생년월일, 입소일. 종결이면 종결일도 필수이고 입소일보다 앞설 수 없다.
 * 수정은 온 칸만 보되, 상태·종결일·입소일은 서로 얽혀 있어 함께 검사한다.
 * 그래서 화면은 수정할 때도 이 세 칸을 늘 함께 보낸다.
 */
function parseChild(
  body: Record<string, unknown>,
  strict: boolean,
): { patch: ChildPatch } | { error: string } {
  const patch: ChildPatch = {};

  if (strict || "name" in body) {
    const name = parseShort(body.name, NAME_MAX);
    if (!name) return { error: `이름은 비어 있을 수 없고 ${NAME_MAX}자를 넘을 수 없습니다.` };
    patch.name = name;
  }

  if (strict || "birth_date" in body) {
    const birth = parseDate(body.birth_date);
    if (birth === undefined) return { error: "생년월일은 실제 날짜여야 합니다." };
    if (strict && birth === null) return { error: "생년월일을 입력해 주세요." };
    const range = birth ? checkChildBirth(birth) : null;
    if (range) return { error: range };
    patch.birth_date = birth;
  }

  if ("gender" in body) {
    const gender = body.gender;
    if (gender === null || gender === "" || gender === undefined) {
      patch.gender = null;
    } else if (typeof gender !== "string" || !(GENDERS as readonly string[]).includes(gender)) {
      return { error: "성별은 남 또는 여여야 합니다." };
    } else {
      patch.gender = gender as Gender;
    }
  }

  for (const key of ["school", "guardian_relation", "guardian_contact", "address"] as const) {
    if (!(key in body)) continue;
    const value = parseShort(body[key]);
    if (value === undefined) return { error: `${key} 는 ${SHORT_MAX}자를 넘을 수 없습니다.` };
    patch[key] = value;
  }

  if ("referral_note" in body) {
    const note = parseShort(body.referral_note, NOTE_MAX);
    if (note === undefined) return { error: `의뢰배경은 ${NOTE_MAX}자를 넘을 수 없습니다.` };
    patch.referral_note = note;
  }

  if (strict || "enroll_date" in body) {
    const enroll = parseDate(body.enroll_date);
    if (enroll === undefined) return { error: "입소일은 실제 날짜여야 합니다." };
    if (strict && enroll === null) return { error: "입소일을 입력해 주세요." };
    const range = enroll ? checkEnrollDate(enroll) : null;
    if (range) return { error: range };
    patch.enroll_date = enroll;
  }

  // 개인정보 동의서를 받은 날(선택, 034) — 기록만 한다. 받은 날은 오늘 뒤일 수 없다.
  if ("consent_date" in body) {
    const consent = parseDate(body.consent_date);
    if (consent === undefined) return { error: "동의서 받은 날은 실제 날짜여야 합니다." };
    if (consent && consent > todayInSeoul()) {
      return { error: "동의서 받은 날은 오늘 뒤일 수 없습니다." };
    }
    if (consent && consent < "2000-01-01") return { error: "동의서 받은 날이 너무 이릅니다." };
    patch.consent_date = consent;
  }

  if (strict || "status" in body) {
    const status = body.status ?? "재원";
    if (typeof status !== "string" || !(CHILD_STATUSES as readonly string[]).includes(status)) {
      return { error: "상태는 재원 또는 종결이어야 합니다." };
    }
    patch.status = status as ChildStatus;
  }

  if ("exit_date" in body || patch.status !== undefined) {
    const exit = parseDate(body.exit_date);
    if (exit === undefined) return { error: "종결일은 실제 날짜여야 합니다." };
    patch.exit_date = exit;
  }

  // 종결과 종결일은 짝이다. 종결인데 날짜가 없으면 언제 나갔는지 모르고,
  // 재원인데 종결일이 있으면 어느 쪽이 맞는지 모른다.
  if (patch.status === "종결" && !patch.exit_date) {
    return { error: "종결 처리하려면 종결일을 입력해 주세요." };
  }
  if (patch.status === "재원") patch.exit_date = null;

  if (patch.exit_date && patch.enroll_date && patch.exit_date < patch.enroll_date) {
    return { error: "종결일은 입소일보다 앞설 수 없습니다." };
  }

  return { patch };
}

/* ---------- GET /api/children ---------- */

export async function handleChildrenList(): Promise<Response> {
  try {
    const children = await listChildren();
    return ok({ children });
  } catch (error) {
    return serverError("GET /api/children", error);
  }
}

/* ---------- GET /api/children/:id  ★ 민감정보 ---------- */

export async function handleChildGet(id: string): Promise<Response> {
  try {
    const child = await getChild(id);
    if (!child) return notFound();
    return ok({ child });
  } catch (error) {
    return serverError("GET /api/children/:id", error);
  }
}

/* ---------- POST /api/children  ★ 민감정보 ---------- */

export async function handleChildCreate(req: Request): Promise<Response> {
  const body = await readJson(req);
  if (!body) return badRequest("요청 본문이 JSON이 아닙니다.");

  const parsed = parseChild(body, true);
  if ("error" in parsed) return badRequest(parsed.error);

  try {
    const child = await addChild({ ...parsed.patch, name: parsed.patch.name as string });
    return ok({ child });
  } catch (error) {
    return serverError("POST /api/children", error);
  }
}

/* ---------- PATCH /api/children/:id  ★ 민감정보 ---------- */

export async function handleChildUpdate(req: Request, id: string): Promise<Response> {
  const body = await readJson(req);
  if (!body) return badRequest("요청 본문이 JSON이 아닙니다.");

  const parsed = parseChild(body, false);
  if ("error" in parsed) return badRequest(parsed.error);
  if (Object.keys(parsed.patch).length === 0) return badRequest("바꿀 내용이 없습니다.");

  try {
    // 종결일·입소일 중 하나만 바뀌면 나머지는 저장된 값과 견준다(DB 제약에서 500 으로 터지기 전에 안내)
    const { exit_date: exit, enroll_date: enroll } = parsed.patch;
    if ((exit && enroll === undefined) || (enroll && exit === undefined)) {
      const current = await getChild(id);
      if (!current) return notFound();
      const from = enroll ?? current.enroll_date;
      const to = exit === undefined ? current.exit_date : exit;
      if (from && to && to < from) return badRequest("종결일은 입소일보다 앞설 수 없습니다.");
    }
    const child = await updateChild(id, parsed.patch);
    return ok({ child });
  } catch (error) {
    return serverError("PATCH /api/children/:id", error);
  }
}

/* ---------- GET /api/children/:id/records-count ---------- */

/** 삭제 확인창이 "관찰 N건, 평가 M건이 함께 지워집니다"를 적기 위해 먼저 센다. */
export async function handleChildRecordsCount(id: string): Promise<Response> {
  try {
    const child = await getChild(id);
    if (!child) return notFound();
    const counts = await countChildRecords(id);
    return ok({ counts, name: child.name });
  } catch (error) {
    return serverError("GET /api/children/:id/records-count", error);
  }
}

/* ---------- DELETE /api/children/:id ---------- */

export const CHILD_DELETE_BY_STAFF_KEY = "child_delete_by_staff";

/**
 * 이 사람이 아동을 지울 수 있는가.
 *
 * [왜 정책표가 아니라 여기인가]
 * 정책표(api/policy.ts)는 DB 를 읽지 않는다 — 경로와 등급만 보는 표다.
 * 이 판단은 센터가 설정에서 켜고 끄는 값에 달려 있어 표로는 못 가른다.
 * 계정의 관리자 깃발을 요청 본문으로 가르는 api/accounts.ts 와 같은 모양이다.
 *
 * 기본은 센터장 이상이다. 아동 삭제는 딸린 관찰·평가가 한꺼번에 사라지는 일이라
 * 돌이킬 수 없다. [설정 › 봉사자·권한 설정] 에서 켜면 종사자도 지울 수 있다
 * (센터 전체에 하나다 — 사람별 허용은 아직 없다).
 */
export async function canDeleteChild(level: Level | null): Promise<boolean> {
  if (!level) return false;
  if (atLeast(level, "센터장")) return true;
  if (!atLeast(level, "종사자")) return false;
  return await getSetting<boolean>(CHILD_DELETE_BY_STAFF_KEY, false) === true;
}

/**
 * 아동과 딸린 기록을 지운다.
 *
 * 화면이 두 번 묻고(건수 안내 → 이름 입력) 온 요청이다. 서버는 다시 묻지 않는다.
 * 대신 무엇을 몇 건 지웠는지 돌려주어 화면이 그대로 알리게 한다.
 *
 * 등급은 여기서 한 번 더 본다 — 화면이 버튼을 감추는 것은 친절일 뿐이다.
 */
export async function handleChildDelete(id: string): Promise<Response> {
  try {
    const user = currentUser();
    if (!await canDeleteChild((user?.level ?? null) as Level | null)) {
      return Response.json(
        { error: "아동 삭제는 센터장 이상만 할 수 있습니다. (설정에서 종사자에게 열 수 있습니다)" },
        { status: 403, headers: JSON_HEADERS },
      );
    }
    const child = await getChild(id);
    if (!child) return notFound();
    const deleted = await deleteChild(id);
    return ok({ name: child.name, deleted });
  } catch (error) {
    return serverError("DELETE /api/children/:id", error);
  }
}
