/**
 * 봉사자 폰 화면이 쓰는 API — "내 것" 만 다루는 좁은 문
 *
 *   GET  /api/my/me           나 · 이번 반기 · 설정 (겸직이면 roles · 지금 역할 · 고르기 필요 여부)
 *   POST /api/my/role         겸직자의 지금 역할 고르기·전환 (이 세션만)
 *   GET  /api/my/schedules    내 일정 (기간)
 *   GET  /api/my/roster       전체 봉사자 스케줄표 (아동 없음)
 *   GET  /api/my/journals     봉사일지 목록 (설정에 따라 전체 또는 본인)  ?role=봉사자|멘토 (쓸 때의 역할로 거르기)
 *   GET  /api/my/stats        내 봉사 통계
 *   GET  /api/my/children     반기 관찰 대상 (id·이름·학년·작성 여부·반기 열림)
 *
 *   POST   /api/my/schedules       내 일정 등록
 *   PATCH  /api/my/schedules/:id   내 일정 고치기
 *   DELETE /api/my/schedules/:id   내 일정 지우기
 *   POST   /api/my/journals        내 일지 쓰기
 *   PATCH  /api/my/journals/:id    내 일지 고치기 (내용만)
 *   DELETE /api/my/journals/:id    내 일지 지우기
 *
 *   GET  /api/my/observations/:childId   이번 반기에 내가 쓴 한 장
 *   PUT  /api/my/observations/:childId   그 한 장 저장 (덮어쓰기)
 *   GET  /api/my/inquiries               내가 보낸 문의
 *   POST /api/my/inquiries               문의 보내기
 *
 * [고치고 지우는 것은 반드시 mustOwn 을 먼저 부른다]
 * 관문은 경로와 등급만 본다. "이 줄이 내 것인가" 는 행을 읽어야 안다.
 * 그 판단이 이 파일 밖으로 나가면 언젠가 한 곳을 빠뜨리게 된다.
 *
 * [왜 기존 경로를 안 쓰나]
 * /api/journals 나 /api/schedules 에 "봉사자면 본인 것만" 을 넣는 길도 있다.
 * 그러면 그 조건이 서른아홉 개 핸들러 사이에 흩어지고, 한 곳을 빠뜨리는 날
 * 봉사자가 남의 일지를 지운다. 좁은 문을 따로 내면 본인 확인이 이 파일 안에만 있다.
 *
 * [세션이 곧 신원이다]
 * staff_id·author_id 를 본문이나 쿼리로 받지 않는다. 요청 컨텍스트에서만 읽는다.
 * 받기 시작하면 남의 이름으로 쓰는 길이 열린다.
 *
 * 이 파일은 Supabase 를 직접 부르지 않는다. /db 와 /lib 만 쓴다.
 */
import { listChildrenForObservation } from "../db/children.ts";
import {
  addJournal,
  deleteJournal,
  getJournal,
  listJournalsPage,
  updateJournal,
} from "../db/journals.ts";
import {
  addSchedules,
  deleteSchedule,
  getSchedule,
  listStaffScheduledOn,
  monthOverview,
  staffYearStats,
  updateSchedule,
} from "../db/schedules.ts";
import {
  getHalfObservation,
  listHalfObservationsByAuthor,
  saveHalfObservation,
} from "../db/half_observations.ts";
import { addInquiry, listInquiriesBy } from "../db/inquiries.ts";
import { getSetting } from "../db/settings.ts";
import { getAccountView } from "../db/accounts.ts";
import { NotFoundError, RuleError } from "../db/client.ts";
import { setActiveRole } from "../db/sessions.ts";
import type { Role } from "../db/staff.ts";
import { checkJournalDate } from "../lib/dates.ts";
import { runAfterResponse } from "../lib/background.ts";
import { extractObservations } from "../lib/extract_observations.ts";
import { extractResources } from "../lib/extract_resources.ts";
import { currentUser } from "../lib/request_context.ts";
import { currentHalf, type Half, type HalfOpenMap, halvesOf, isHalfOpen } from "../lib/half.ts";
import { gradeNumber } from "../lib/roster.ts";
import {
  activeItems,
  cleanScores,
  isComplete,
  keepDeletedScores,
  readItems,
} from "../lib/half_items.ts";

const JSON_HEADERS = { "cache-control": "no-store" };

/** 한 번에 읽을 수 있는 기간 상한. 폰에서 몇 달치를 한꺼번에 받을 이유가 없다. */
const MAX_DAYS = 370;

function ok(body: unknown): Response {
  return Response.json(body, { headers: JSON_HEADERS });
}

function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400, headers: JSON_HEADERS });
}

function serverError(where: string, error: unknown): Response {
  // 없는 대상은 404, 규칙에 어긋난 요청(없는 사람을 가리킴 등)은 400 — 사람이 읽을 말 그대로(db/client.ts)
  if (error instanceof NotFoundError) {
    return Response.json({ error: error.message }, { status: 404, headers: JSON_HEADERS });
  }
  // 규칙에 어긋난 요청(잘못된 목록 위치 등)은 고장이 아니다. 사람이 읽을 문장을 400 으로.
  if (error instanceof RuleError) return badRequest(error.message);
  console.error(`[${where}]`, error);
  return Response.json(
    { error: "요청을 처리하지 못했습니다." },
    { status: 500, headers: JSON_HEADERS },
  );
}

/**
 * 지금 요청을 보낸 사람. 관문이 이미 로그인을 확인했으므로 여기 오면 있어야 한다.
 * 없으면 그건 관문이 빠진 것이므로 조용히 넘기지 않고 401 로 끊는다.
 */
function me():
  | {
    id: string;
    name: string;
    roles: string[];
    activeRole: string | null;
    sessionId: string | null;
  }
  | null {
  const user = currentUser();
  return user
    ? {
      id: user.id,
      name: user.name,
      roles: user.roles,
      activeRole: user.active_role,
      sessionId: user.session_id,
    }
    : null;
}

/**
 * 겸직자가 아직 역할을 안 골랐을 때. 새 기록을 만들 수 없다 — 어느 역할로 남길지 모른다.
 * 화면은 need_role 을 보고 역할 고르기를 띄운다. 역할이 하나인 사람에게는 오지 않는다.
 */
function needRole(): Response {
  return Response.json(
    { error: "오늘 어떤 활동인지(역할) 먼저 골라 주세요.", need_role: true },
    { status: 409, headers: JSON_HEADERS },
  );
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function needLogin(): Response {
  return Response.json(
    { error: "로그인이 필요합니다." },
    { status: 401, headers: JSON_HEADERS },
  );
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * from·to 를 읽는다. 안 주면 이번 달로 둔다 —
 * 폰에서 처음 여는 화면이 늘 "이번 달" 이라 기본값이 있는 편이 요청이 짧다.
 */
function readRange(params: URLSearchParams): { from: string; to: string } | string {
  const from = params.get("from")?.trim() ?? "";
  const to = params.get("to")?.trim() ?? "";

  if (!from && !to) {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const last = new Date(year, month, 0).getDate();
    const pad = (n: number) => String(n).padStart(2, "0");
    return { from: `${year}-${pad(month)}-01`, to: `${year}-${pad(month)}-${pad(last)}` };
  }

  if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
    return "from·to 는 YYYY-MM-DD 형식이어야 합니다.";
  }
  if (from > to) return "from 이 to 보다 늦습니다.";

  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (!Number.isFinite(days) || days > MAX_DAYS) {
    return `한 번에 볼 수 있는 기간은 ${MAX_DAYS}일까지입니다.`;
  }
  return { from, to };
}

function readMonth(params: URLSearchParams): { year: number; month: number } | string {
  const now = new Date();
  const year = Number(params.get("year") ?? now.getFullYear());
  const month = Number(params.get("month") ?? now.getMonth() + 1);

  if (!Number.isInteger(year) || year < 2000 || year > 2100) return "year 값이 올바르지 않습니다.";
  if (!Number.isInteger(month) || month < 1 || month > 12) return "month 값이 올바르지 않습니다.";
  return { year, month };
}

/**
 * 요청이 가리키는 반기. 안 주면 이번 반기다.
 *
 * 연도는 올해만 받는다. 지난해 기록을 폰에서 뒤로 고치는 길을 내지 않는다 —
 * 그 일은 닫힌 반기를 여는 것으로 하고, 여는 것은 PC 에서 사람이 누른다.
 */
function readHalf(params: URLSearchParams): { year: number; half: Half } | string {
  const now = currentHalf();
  const year = Number(params.get("year") ?? now.year);
  const half = Number(params.get("half") ?? now.half);

  if (year !== now.year) return "올해 반기만 볼 수 있습니다.";
  if (half !== 1 && half !== 2) return "반기 값이 올바르지 않습니다.";
  return { year, half: half as Half };
}

/** 지금 열려 있는 반기가 어디인지. 설정에 없는 반기는 "이번 반기면 열림" 이다. */
async function openMap(): Promise<HalfOpenMap> {
  return await getSetting<HalfOpenMap>("half_observation_open", {});
}

/* ---------- GET /api/my/me ---------- */

/**
 * 첫 화면이 한 번에 받는 것. 나 + 이번 반기 + 이 센터의 설정.
 *
 * 설정을 여기 실어 보내는 이유: 화면이 "일지를 전체로 보여 줄지" 를 알아야
 * 목록의 안내 문구를 맞게 적을 수 있다. 실제로 거르는 것은 서버다.
 */
export async function handleMyMe(): Promise<Response> {
  const who = me();
  if (!who) return needLogin();

  try {
    const [account, scope] = await Promise.all([
      getAccountView(who.id),
      getSetting<string>("volunteer_journal_scope", "전체"),
    ]);

    return ok({
      me: account && {
        id: account.id,
        name: account.name,
        role: account.role,
        // 겸직 — 역할이 둘 이상이면 화면이 고르기·전환을 보인다. 하나면 예전과 똑같다.
        roles: account.roles,
        active_role: who.activeRole,
        needs_role_choice: account.roles.length > 1 && !who.activeRole,
        level: account.level,
        access_kind: account.access_kind,
      },
      period: currentHalf(),
      journal_scope: scope === "본인" ? "본인" : "전체",
    });
  } catch (error) {
    return serverError("GET /api/my/me", error);
  }
}

/* ---------- POST /api/my/role ---------- */

/**
 * 겸직자가 지금 역할을 고른다(또는 바꾼다). 이 세션에만 적힌다 — 다른 기기는 그대로.
 * 바꾼 뒤 새로 만드는 일정·일지·문의에 이 역할이 박힌다. 지난 기록은 그대로다.
 * 역할이 하나인 사람은 부를 일이 없다(불러도 그 역할만 된다).
 */
export async function handleMyRoleSelect(req: Request): Promise<Response> {
  const who = me();
  if (!who) return needLogin();
  if (!who.sessionId) return needLogin();

  const body = await readJson(req);
  const role = typeof body?.role === "string" ? body.role.trim() : "";
  if (!who.roles.includes(role)) return badRequest("내 역할 중에서 골라 주세요.");

  try {
    await setActiveRole(who.sessionId, role);
    return ok({ active_role: role });
  } catch (error) {
    return serverError("POST /api/my/role", error);
  }
}

/* ---------- GET /api/my/schedules ---------- */

/** 내 일정만. 남의 일정은 아래 roster 에서 이름만 본다. */
export async function handleMySchedules(req: Request): Promise<Response> {
  const who = me();
  if (!who) return needLogin();

  const range = readRange(new URL(req.url).searchParams);
  if (typeof range === "string") return badRequest(range);

  try {
    const months = monthsBetween(range.from, range.to);
    const mine = [];
    for (const { year, month } of months) {
      const overview = await monthOverview(year, month);
      // 미작성 판단은 PC 스케줄 화면과 같은 곳에서 온다 —
      // 두 화면이 서로 다른 기준으로 세면 "안 썼다" 는 말이 화면마다 달라진다.
      const unwritten = new Set(
        overview.missing.filter((one) => one.staff_id === who.id).map((one) => one.schedule_id),
      );
      for (const one of overview.schedules) {
        if (one.staff_id !== who.id) continue;
        if (one.sched_date < range.from || one.sched_date > range.to) continue;
        mine.push({
          id: one.id,
          sched_date: one.sched_date,
          start_time: one.start_time,
          end_time: one.end_time,
          unwritten: unwritten.has(one.id),
        });
      }
    }
    mine.sort((a, b) => a.sched_date.localeCompare(b.sched_date));
    return ok({ schedules: mine, from: range.from, to: range.to });
  } catch (error) {
    return serverError("GET /api/my/schedules", error);
  }
}

/** 기간에 걸친 달들. monthOverview 가 달 단위로만 읽기 때문에 나눠 부른다. */
function monthsBetween(from: string, to: string): Array<{ year: number; month: number }> {
  const out: Array<{ year: number; month: number }> = [];
  let year = Number(from.slice(0, 4));
  let month = Number(from.slice(5, 7));
  const lastYear = Number(to.slice(0, 4));
  const lastMonth = Number(to.slice(5, 7));

  while (year < lastYear || (year === lastYear && month <= lastMonth)) {
    out.push({ year, month });
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return out;
}

/* ---------- GET /api/my/roster ---------- */

/**
 * 그 달 전체 봉사자 스케줄표. 누가 언제 오는지만 본다.
 *
 * 아동은 실리지 않는다 — schedules 표 자체가 아동과 이어진 곳이 없다.
 * 통계·미작성 목록도 빼고 보낸다. 봉사자가 남의 미작성을 알 이유가 없다.
 */
export async function handleMyRoster(req: Request): Promise<Response> {
  if (!me()) return needLogin();

  const when = readMonth(new URL(req.url).searchParams);
  if (typeof when === "string") return badRequest(when);

  try {
    const overview = await monthOverview(when.year, when.month);
    return ok({
      year: when.year,
      month: when.month,
      schedules: overview.schedules.map((one) => ({
        id: one.id,
        staff_id: one.staff_id,
        staff_name: one.staff_name,
        staff_role: one.staff_role,
        color_index: one.color_index,
        sched_date: one.sched_date,
        start_time: one.start_time,
        end_time: one.end_time,
      })),
    });
  } catch (error) {
    return serverError("GET /api/my/roster", error);
  }
}

/* ---------- GET /api/my/journals ---------- */

/**
 * 봉사일지 목록.
 *
 * 설정(volunteer_journal_scope)이 '전체' 면 다른 봉사자 것도 읽는다.
 * 기본은 '전체' 다(024) — 격주로 오는 사람이 지난주 일을 알아야 한다.
 * 대신 남의 일지는 올해 것만 준다. 일지 본문에는 아동 이야기가 적히므로
 * 몇 해 전 기록까지 폰에 열어 둘 이유가 없다. 내 일지는 해 무관.
 *
 * 거르는 일은 여기서 한다. 화면이 받은 값으로 거르면 본문은 이미 폰에 간 뒤다.
 */
/** 폰 일지 역할 거르기(web/assets/m/role_chips.js 와 같은 목록) */
const JOURNAL_ROLES: string[] = ["봉사자", "멘토"];

export async function handleMyJournals(req: Request): Promise<Response> {
  const who = me();
  if (!who) return needLogin();

  const range = readRange(new URL(req.url).searchParams);
  if (typeof range === "string") return badRequest(range);

  const params = new URL(req.url).searchParams;
  const cursor = params.get("cursor")?.trim() || null;
  // 화면의 [내 일지] 쪽. 거르기는 서버가 한다 — 한 쪽 15건이 "거른 결과" 기준이어야 한다.
  const wantMine = params.get("mine") === "1";
  // 역할 거르기(쓸 때의 역할 as_role). 없으면 섞어 보기.
  const role = params.get("role")?.trim() || null;
  if (role && !JOURNAL_ROLES.includes(role)) {
    return badRequest("role 은 봉사자 또는 멘토만 됩니다.");
  }

  try {
    const scope = await getSetting<string>("volunteer_journal_scope", "전체");
    const mineOnly = scope === "본인" || wantMine;

    // [공유는 올해 것만]
    // 설정이 전체 여도 남의 일지는 올해 것만 보인다. 몇 해 전 기록까지 봉사자 폰에
    // 열려 있을 이유가 없다(본문에 아이 이야기가 있다). 내 일지는 해와 상관없이 전부.
    // 종사자 PC 는 이 제한이 없다 — 업무 열람이다.
    const othersSince = `${currentHalf().year}-01-01`;
    const page = await listJournalsPage("봉사", range.from, range.to, {
      cursor,
      authorId: mineOnly ? who.id : null,
      othersSince: mineOnly ? null : othersSince,
      viewerId: who.id,
      asRole: role as Role | null,
    });
    const rows = page.journals;

    return ok({
      scope: scope === "본인" ? "본인" : "전체",
      next_cursor: page.next_cursor,
      // 지난해 달을 전체 로 보고 있다 — 화면이 "작년 일지는 본인 것만" 을 알린다
      others_hidden: !mineOnly && range.from < othersSince,
      journals: rows.map((one) => ({
        id: one.id,
        journal_date: one.journal_date,
        content: one.content,
        author_id: one.author_id,
        author_name: one.author_name,
        author_color: one.author_color,
        // 쓸 때의 역할 — 이름 옆 알약
        as_role: one.author_role,
        start_time: one.start_time,
        end_time: one.end_time,
        comment: one.comment,
        // 폰에서 고칠 수 있는 줄인지 화면이 바로 알게 한다. 막는 것은 서버다.
        mine: one.author_id === who.id,
      })),
      from: range.from,
      to: range.to,
    });
  } catch (error) {
    return serverError("GET /api/my/journals", error);
  }
}

/* ---------- GET /api/my/stats ---------- */

type Tally = { schedules: number; hours: number; written: number };

function add(into: Tally, part: Tally): void {
  into.schedules += part.schedules;
  into.hours += part.hours;
  into.written += part.written;
}

function round(tally: Tally): Tally {
  return { ...tally, hours: Math.round(tally.hours * 10) / 10 };
}

/** 역할 순서(봉사자 먼저)로 늘어놓고 시간을 자른다 */
function roundAll(byRole: Record<string, Tally>): Array<Tally & { role: string }> {
  const order = ["봉사자", "멘토", "생활복지사", "센터장"];
  const rank = (role: string) => order.includes(role) ? order.indexOf(role) : order.length;
  return Object.entries(byRole)
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([role, tally]) => ({ role, ...round(tally) }));
}

/**
 * 내 봉사 통계. 그 해 달마다 몇 번·몇 시간, 일지를 몇 건 썼는지.
 *
 * 남의 수는 안 준다. 견주는 화면이 아니라 자기 것을 돌아보는 화면이다.
 * 겸직자에게는 by_role·total_by_role(일정의 역할로 가른 것)을 더 준다.
 */
export async function handleMyStats(req: Request): Promise<Response> {
  const who = me();
  if (!who) return needLogin();

  const params = new URL(req.url).searchParams;
  const year = Number(params.get("year") ?? new Date().getFullYear());
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return badRequest("year 값이 올바르지 않습니다.");
  }

  try {
    // 한 해치를 한 번에 읽는다. 예전에는 달마다 전체를 읽어 왕복 스물네 번이었다.
    const months = await staffYearStats(who.id, year);
    const total = { schedules: 0, hours: 0, written: 0 };
    const totalByRole: Record<string, typeof total> = {};
    for (const row of months) {
      add(total, row);
      for (const [role, part] of Object.entries(row.by_role)) {
        add(totalByRole[role] ??= { schedules: 0, hours: 0, written: 0 }, part);
      }
    }

    // 역할별 가르기는 겸직자에게만 준다. 역할이 하나인 사람의 응답은 예전 모양 그대로다.
    const split = who.roles.length > 1;
    return ok({
      year,
      months: months.map(({ by_role, ...rest }) =>
        split ? { ...rest, by_role: roundAll(by_role) } : rest
      ),
      // 소수점이 길게 붙으면 화면에서 읽기 어렵다. 한 자리로 자른다.
      total: round(total),
      ...(split ? { total_by_role: roundAll(totalByRole) } : {}),
    });
  } catch (error) {
    return serverError("GET /api/my/stats", error);
  }
}

/* ---------- GET /api/my/children ---------- */

/**
 * 반기 관찰 대상. 재원 아동 전체.
 *
 * 이름과 학년만 나간다. 생년월일은 학년을 세는 데만 쓰고 응답에 담지 않는다 —
 * 학년은 이미 계산된 값이라 생년월일을 폰까지 보낼 이유가 없다.
 *
 * 미작성이 몇 명이든 아무것도 막지 않는다. 그 수는 알림이지 관문이 아니다.
 */
export async function handleMyChildren(req: Request): Promise<Response> {
  const who = me();
  if (!who) return needLogin();

  const period = readHalf(new URL(req.url).searchParams);
  if (typeof period === "string") return badRequest(period);

  try {
    const [children, written, items, open] = await Promise.all([
      listChildrenForObservation(),
      listHalfObservationsByAuthor(who.id, period.year, period.half),
      getSetting<unknown[]>("half_observation_items", []),
      openMap(),
    ]);

    // 내가 쓴 것만 센다. 다른 사람이 같은 아이를 봤는지는 이 화면의 일이 아니다 —
    // 사람마다 한 장이므로 남이 썼다고 내가 쓸 것이 없어지지 않는다.
    //
    // "썼다" 는 한 번이라도 저장했다는 뜻이다. 항목을 다 채웠는지는 따로 알린다 —
    // 적다 만 것을 이어 쓰는 것이 실제 모습이라 다 채워야만 "썼다" 로 치면
    // 수가 늘 모자라 보이고, 그 수가 사람을 재촉한다.
    const list = readItems(items);
    const mine = new Map(written.map((one) => [one.child_id, one]));

    return ok({
      period,
      // 닫힌 반기는 읽기만 된다. 화면이 [쓰기] 를 감추고, 서버도 PUT 을 거절한다.
      open: isHalfOpen(open, period.year, period.half),
      halves: halvesOf(period.year).map((one) => ({
        ...one,
        open: isHalfOpen(open, one.year, one.half),
      })),
      items: activeItems(list),
      children: children.map((one) => ({
        id: one.id,
        name: one.name,
        grade: gradeNumber(one.birth_date),
        written: mine.has(one.id),
        complete: isComplete(list, mine.get(one.id)?.scores ?? null),
      })),
      total: children.length,
      written_count: children.filter((one) => mine.has(one.id)).length,
    });
  } catch (error) {
    return serverError("GET /api/my/children", error);
  }
}

/* ---------- 내 것인가 ---------- */

/** 일지 본문 상한. PC 의 봉사일지와 같은 값이어야 한다. */
const CONTENT_MAX = 5000;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function forbidden(): Response {
  return Response.json(
    { error: "본인이 쓴 것만 고치거나 지울 수 있습니다." },
    { status: 403, headers: JSON_HEADERS },
  );
}

/**
 * 이 줄이 내 것인지 본다. 아니면 403 을 돌려준다.
 *
 * 고치거나 지우는 네 자리가 전부 여기를 먼저 부른다.
 * 한 곳이라도 빠뜨리면 봉사자가 남의 일정·일지를 지운다 — 조용히 된다.
 *
 * "없다" 와 "남의 것" 을 같은 말로 답한다. 갈라서 알리면 남의 줄이 있다는 사실이
 * 새어 나간다. 어차피 이 사람이 할 수 있는 일은 둘 다 없다.
 */
async function mustOwnSchedule(id: string, staffId: string): Promise<Response | null> {
  const one = await getSchedule(id);
  return one?.staff_id === staffId ? null : forbidden();
}

async function mustOwnJournal(id: string, staffId: string): Promise<Response | null> {
  const journal = await getJournal(id);
  if (!journal || journal.kind !== "봉사") return forbidden();
  return journal.author_id === staffId ? null : forbidden();
}

/* ---------- POST /api/my/schedules ---------- */

/**
 * 내 일정을 넣는다. 여러 날을 한 번에 받는다 — 격주로 오는 사람이
 * 한 달치를 한 번에 넣는 것이 실제 모습이다.
 *
 * staff_id 는 본문에서 읽지 않는다. 세션이 곧 신원이다 —
 * 받기 시작하면 남의 이름으로 일정을 만드는 길이 열린다.
 */
export async function handleMyScheduleCreate(req: Request): Promise<Response> {
  const who = me();
  if (!who) return needLogin();

  const body = await readJson(req);
  if (!body) return badRequest("요청 본문이 JSON이 아닙니다.");

  const raw = Array.isArray(body.dates) ? body.dates : [];
  if (raw.length === 0) return badRequest("날짜를 하나 이상 골라 주세요.");
  if (raw.length > 31) return badRequest("한 번에 31일까지만 넣을 수 있습니다.");

  const start = typeof body.start_time === "string" ? body.start_time.trim() : "";
  const end = typeof body.end_time === "string" ? body.end_time.trim() : "";
  if (!TIME_RE.test(start)) return badRequest("시작 시각이 올바르지 않습니다.");
  if (!TIME_RE.test(end)) return badRequest("종료 시각이 올바르지 않습니다.");
  if (end <= start) return badRequest("종료 시각은 시작 시각보다 뒤여야 합니다.");

  const dates: string[] = [...new Set(raw.map((one: unknown) => String(one).trim()))];
  for (const date of dates) {
    if (!DATE_ONLY.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
      return badRequest(`날짜가 올바르지 않습니다: ${date}`);
    }
  }

  // 지금 역할로 넣는다. 겸직인데 아직 안 골랐으면 막는다(어느 역할 일정인지 모른다).
  if (!who.activeRole) return needRole();
  const asRole = who.activeRole as Role;

  try {
    // addSchedules 는 이미 있는 날을 건너뛰고 몇 건이 빠졌는지 함께 준다.
    // 여러 날을 한 번에 넣다 보면 이미 넣은 날이 섞이기 쉽다.
    const result = await addSchedules(
      dates.map((date) => ({
        staff_id: who.id,
        sched_date: date,
        start_time: start,
        end_time: end,
        as_role: asRole,
      })),
    );
    return ok({ created: result.created.length, skipped: result.skipped });
  } catch (error) {
    return serverError("POST /api/my/schedules", error);
  }
}

/* ---------- PATCH /api/my/schedules/:id ---------- */

/** 시각만 고친다. 날짜를 바꾸는 것은 지우고 다시 넣는 것과 같아 헷갈리지 않게 막는다. */
export async function handleMyScheduleUpdate(req: Request, id: string): Promise<Response> {
  const who = me();
  if (!who) return needLogin();

  const body = await readJson(req);
  if (!body) return badRequest("요청 본문이 JSON이 아닙니다.");

  const start = typeof body.start_time === "string" ? body.start_time.trim() : "";
  const end = typeof body.end_time === "string" ? body.end_time.trim() : "";
  if (!TIME_RE.test(start)) return badRequest("시작 시각이 올바르지 않습니다.");
  if (!TIME_RE.test(end)) return badRequest("종료 시각이 올바르지 않습니다.");
  if (end <= start) return badRequest("종료 시각은 시작 시각보다 뒤여야 합니다.");

  try {
    const denied = await mustOwnSchedule(id, who.id);
    if (denied) return denied;

    await updateSchedule(id, { start_time: start, end_time: end });
    return ok({ ok: true });
  } catch (error) {
    return serverError("PATCH /api/my/schedules/:id", error);
  }
}

/* ---------- DELETE /api/my/schedules/:id ---------- */

export async function handleMyScheduleDelete(id: string): Promise<Response> {
  const who = me();
  if (!who) return needLogin();

  try {
    const denied = await mustOwnSchedule(id, who.id);
    if (denied) return denied;

    await deleteSchedule(id);
    return ok({ ok: true });
  } catch (error) {
    return serverError("DELETE /api/my/schedules/:id", error);
  }
}

/* ---------- POST /api/my/journals ---------- */

/**
 * 봉사일지를 쓴다. PC 와 같은 규칙이다 —
 * 일정이 있는 날만 쓸 수 있고, 시각은 그 일정에서 읽는다(일지 표에 복사하지 않는다).
 *
 * 일정 없는 날에 일지가 생기면 근무 통계와 미작성 목록이 어긋난다.
 */
export async function handleMyJournalCreate(req: Request): Promise<Response> {
  const who = me();
  if (!who) return needLogin();

  const body = await readJson(req);
  if (!body) return badRequest("요청 본문이 JSON이 아닙니다.");

  const date = typeof body.journal_date === "string" ? body.journal_date.trim() : "";
  if (!DATE_ONLY.test(date)) return badRequest("날짜가 올바르지 않습니다.");
  // 활동한 뒤에 쓴다 — 앞날 일정에 미리 달지 않는다(PC 도 같은 규칙, lib/dates.ts)
  const dateProblem = checkJournalDate("봉사", date);
  if (dateProblem) return badRequest(dateProblem);

  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (!content) return badRequest("내용을 적어 주세요.");
  if (content.length > CONTENT_MAX) {
    return badRequest(`내용은 ${CONTENT_MAX}자를 넘을 수 없습니다.`);
  }

  if (!who.activeRole) return needRole();

  try {
    // 그날 내 일정이 있어야 쓸 수 있다. 일정 id 는 서버가 찾는다 —
    // 본문으로 받으면 남의 일정에 내 일지를 매다는 길이 열린다.
    // 겸직자는 지금 역할의 일정이어야 한다 — 멘토로 들어와 봉사 일정에 일지를 다는 실수를 막는다.
    const scheduled = await listStaffScheduledOn(date);
    const minesAll = scheduled.filter((one) => one.staff_id === who.id);
    if (minesAll.length === 0) {
      return badRequest("그날은 일정이 없습니다. 일정을 먼저 넣어 주세요.");
    }
    const mine = minesAll.find((one) => (one.role ?? who.activeRole) === who.activeRole);
    if (!mine) {
      const other = minesAll[0].role ?? "다른 역할";
      return badRequest(
        `그날은 ${who.activeRole} 일정이 없습니다(${other} 일정만 있어요). ` +
          `[나]에서 ${other}(으)로 전환하거나 ${who.activeRole} 일정을 먼저 넣어 주세요.`,
      );
    }

    const journal = await addJournal("봉사", date, who.id, null, content, {
      schedule_id: mine.schedule_id,
      as_role: (mine.role ?? who.activeRole) as Role,
    });

    // 저장은 끝났다. 분석(관찰 → 자원)은 응답을 보낸 뒤 서버가 이어서 한다.
    // PC 에서 쓴 일지와 같은 흐름이다 — 폰은 기다리지 않고, 분석 여부도 보지 않는다.
    // 끊기거나 실패해도 일지는 남고 PC 의 "미분석" 표시가 받아 준다(lib/background.ts).
    runAfterResponse(`봉사일지 분석 ${journal.id}`, async () => {
      await extractObservations(journal.id);
      await extractResources(journal.id);
    });

    return ok({ journal: { id: journal.id, journal_date: journal.journal_date } });
  } catch (error) {
    return serverError("POST /api/my/journals", error);
  }
}

/* ---------- PATCH /api/my/journals/:id ---------- */

/**
 * 내용만 고친다. 날짜와 일정은 바꾸지 않는다 —
 * 그것을 바꾸는 것은 "다른 날 일지" 라는 뜻이고, 그러면 새로 쓰는 것이 맞다.
 */
export async function handleMyJournalUpdate(req: Request, id: string): Promise<Response> {
  const who = me();
  if (!who) return needLogin();

  const body = await readJson(req);
  if (!body) return badRequest("요청 본문이 JSON이 아닙니다.");

  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (!content) return badRequest("내용을 적어 주세요.");
  if (content.length > CONTENT_MAX) {
    return badRequest(`내용은 ${CONTENT_MAX}자를 넘을 수 없습니다.`);
  }

  try {
    const denied = await mustOwnJournal(id, who.id);
    if (denied) return denied;

    await updateJournal(id, { content });
    return ok({ ok: true });
  } catch (error) {
    return serverError("PATCH /api/my/journals/:id", error);
  }
}

/* ---------- DELETE /api/my/journals/:id ---------- */

export async function handleMyJournalDelete(id: string): Promise<Response> {
  const who = me();
  if (!who) return needLogin();

  try {
    const denied = await mustOwnJournal(id, who.id);
    if (denied) return denied;

    await deleteJournal(id);
    return ok({ ok: true });
  } catch (error) {
    return serverError("DELETE /api/my/journals/:id", error);
  }
}

/* ---------- GET /api/my/observations/:childId ---------- */

/**
 * 이번 반기에 내가 이 아이를 두고 쓴 한 장. 없으면 빈 장을 준다.
 *
 * 남이 쓴 장은 안 준다. 사람마다 한 장이라 남의 장은 내 화면에서 할 일이 없고,
 * 그 안에는 다른 사람이 본 아이 이야기가 그대로 적혀 있다.
 */
export async function handleMyObservationGet(req: Request, childId: string): Promise<Response> {
  const who = me();
  if (!who) return needLogin();

  const period = readHalf(new URL(req.url).searchParams);
  if (typeof period === "string") return badRequest(period);

  try {
    const [one, open, raw] = await Promise.all([
      getHalfObservation(childId, period.year, period.half, who.id),
      openMap(),
      getSetting<unknown>("half_observation_items", []),
    ]);
    const list = readItems(raw);
    const scored = new Set(Object.keys(one?.scores ?? {}));

    return ok({
      period,
      open: isHalfOpen(open, period.year, period.half),
      // 지운 항목은 새로 쓰는 화면에 안 나온다. 다만 이 장이 이미 점수를 물고 있으면
      // 읽기 화면에서 "삭제된 항목" 으로 보여야 하므로 함께 보낸다.
      items: list.filter((item) => !item.deleted || scored.has(item.code)),
      observation: one
        ? {
          note: one.note,
          scores: one.scores,
          observed_on: one.observed_on,
          updated_at: one.updated_at,
        }
        : null,
    });
  } catch (error) {
    return serverError("GET /api/my/observations/:childId", error);
  }
}

/* ---------- PUT /api/my/observations/:childId ---------- */

/** 서술 상한. 일지보다 짧다 — 한 아이를 두고 반기에 한 번 적는 글이다. */
const NOTE_MAX = 2000;

/**
 * 한 장을 저장한다. 이미 쓴 것이 있으면 덮어쓴다.
 *
 * author_id 는 세션에서만 온다. 반기는 쿼리로 받되 올해 것만이고,
 * 닫힌 반기면 거절한다 — 지난 기록을 뒤에서 고치려면 사람이 PC 에서 그 반기를 열어야 한다.
 *
 * 점수는 항목 목록(settings.half_observation_items)에 있는 코드만 받는다.
 * 빈 칸은 된다 — 적다 만 것을 저장했다가 나중에 이어 쓰는 것이 실제 모습이다.
 */
export async function handleMyObservationSave(req: Request, childId: string): Promise<Response> {
  const who = me();
  if (!who) return needLogin();

  const body = await readJson(req);
  if (!body) return badRequest("요청 본문이 JSON이 아닙니다.");

  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (note.length > NOTE_MAX) return badRequest(`특이사항은 ${NOTE_MAX}자를 넘을 수 없습니다.`);

  // 관찰일자. 저장한 날과 본 날은 다르다 — 이어 쓰기가 흔하다.
  // 반기 안으로 묶지 않는다: 하반기가 끝난 1월 초에 마저 적는 일이 있다.
  let observedOn: string | null = null;
  if (body.observed_on !== undefined && body.observed_on !== null && body.observed_on !== "") {
    const raw = String(body.observed_on).trim();
    if (!DATE_ONLY.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) {
      return badRequest("관찰일자가 올바르지 않습니다.");
    }
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
    if (raw > today) return badRequest("관찰일자가 오늘보다 뒤입니다.");
    observedOn = raw;
  }

  const period = readHalf(new URL(req.url).searchParams);
  if (typeof period === "string") return badRequest(period);

  try {
    // 닫힌 반기는 못 쓴다. 화면도 [쓰기] 를 감추지만, 막는 것은 여기다 —
    // 화면만 감추면 지난 요청을 그대로 다시 보내는 길이 남는다.
    if (!isHalfOpen(await openMap(), period.year, period.half)) {
      return Response.json(
        { error: "이 반기는 마감되었습니다. 읽기만 됩니다." },
        { status: 409, headers: JSON_HEADERS },
      );
    }

    // 재원 아동인지 본다. 명단에 없는 id 를 그대로 받으면 종결된 아이나
    // 있지도 않은 아이에게 기록이 붙는다.
    const [children, raw, before] = await Promise.all([
      listChildrenForObservation(),
      getSetting<unknown>("half_observation_items", []),
      getHalfObservation(childId, period.year, period.half, who.id),
    ]);
    if (!children.some((one) => one.id === childId)) {
      return badRequest("명단에 없는 아동입니다.");
    }

    // 점수는 지우지 않은 항목 코드만, 1~만점 정수만. 빈 칸은 된다(부분 저장).
    const list = readItems(raw);
    const cleaned = cleanScores(list, body.scores);
    if ("error" in cleaned) return badRequest(cleaned.error);

    // 아무것도 없는 장은 만들지 않는다. "썼다" 로 세어지는데 들여다보면 빈 장이다.
    if (Object.keys(cleaned.scores).length === 0 && !note && !before) {
      return badRequest("점수나 특이사항을 하나 이상 적어 주세요.");
    }

    await saveHalfObservation({
      child_id: childId,
      year: period.year,
      half: period.half,
      author_id: who.id,
      note: note || null,
      // 지운 항목의 지난 점수는 화면이 다시 보내지 않는다. 덮어쓰면서 사라지지 않게 살린다.
      scores: keepDeletedScores(list, before?.scores, cleaned.scores),
      observed_on: observedOn,
    });
    return ok({ ok: true });
  } catch (error) {
    return serverError("PUT /api/my/observations/:childId", error);
  }
}

/* ---------- 문의 ---------- */

/** 문의 상한. 길게 적을 자리가 아니다 — 답장이 없는 한 방향 전달이다. */
const INQUIRY_MAX = 1000;

/** 내가 보낸 문의만. 남이 보낸 불편은 봉사자가 읽을 것이 아니다. */
export async function handleMyInquiries(): Promise<Response> {
  const who = me();
  if (!who) return needLogin();

  try {
    const rows = await listInquiriesBy(who.id);
    return ok({
      inquiries: rows.map((one) => ({
        id: one.id,
        content: one.content,
        created_at: one.created_at,
        seen: Boolean(one.seen_at),
      })),
    });
  } catch (error) {
    return serverError("GET /api/my/inquiries", error);
  }
}

/**
 * 문의를 보낸다. 보낸 사람은 세션에서만 읽는다.
 *
 * 이름을 함께 담아 둔다 — 명단에서 사람이 사라져도 아직 안 고친 불편이
 * 누구 것인지 남아야 한다.
 */
export async function handleMyInquiryCreate(req: Request): Promise<Response> {
  const who = me();
  if (!who) return needLogin();

  const body = await readJson(req);
  if (!body) return badRequest("요청 본문이 JSON이 아닙니다.");

  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (!content) return badRequest("내용을 적어 주세요.");
  if (content.length > INQUIRY_MAX) {
    return badRequest(`내용은 ${INQUIRY_MAX}자를 넘을 수 없습니다.`);
  }

  try {
    const one = await addInquiry(who.id, who.name, content, who.activeRole);
    return ok({ inquiry: { id: one.id, created_at: one.created_at } });
  } catch (error) {
    return serverError("POST /api/my/inquiries", error);
  }
}
