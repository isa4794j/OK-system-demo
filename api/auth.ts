/**
 * 인증 API — 로그인·로그아웃·첫 비밀번호·최초 관리자
 *
 *   GET    /api/auth/state           로그인 화면이 무엇을 그릴지 (최초 부팅인가)
 *   GET    /api/auth/me              지금 누구인가 (세션 없으면 null)
 *   POST   /api/auth/login           이름 + 비밀번호
 *   POST   /api/auth/verify-code     이름 + 초대코드 가 맞는지만 본다
 *   POST   /api/auth/first-password  이름 + 초대코드 + 새 비밀번호 → 세션까지
 *   POST   /api/auth/bootstrap       계정이 0개일 때만 — 최초 관리자(명단에서 고르기, 또는 첫 종사자 직접 입력)
 *   POST   /api/auth/logout          이 기기의 세션만 지운다
 *
 * 이 파일은 Supabase 를 직접 부르지 않는다. /db 와 /lib 만 쓴다.
 *
 * [무엇이 틀렸는지 알려 주지 않는다]
 * 이름이 없든 비번이 틀리든 정지된 계정이든, 화면에 가는 말은 하나다.
 * "이름이나 비밀번호가 맞지 않습니다." 갈라서 알려 주면 그 이름의 계정이
 * 있다는 사실, 정지됐다는 사실이 밖으로 새어 나간다.
 * 예외는 둘 — 동명이인(사람이 관리자에게 물어야 풀린다)과 잠금(기다리면 풀린다).
 * 이 둘은 알려 주지 않으면 사람이 할 수 있는 일이 없다.
 *
 * [4단계에서 이 파일의 경로는 "공개" 로 남는다]
 * 관문이 붙어도 로그인 자체는 로그인 없이 할 수 있어야 한다.
 *
 * [첫 비밀번호는 요청 하나로 끝낸다]
 * 처음에는 코드를 맞히면 짧은 1회용 표를 주고, 그 표로 비밀번호를 정하게 했다.
 * 그 표를 서버 메모리에 두었던 것이 문제였다 — 배포에서는 인스턴스가 여럿이라
 * "코드 확인" 과 "비밀번호 설정" 이 서로 다른 인스턴스에 닿는다.
 * 그러면 표가 없어 "시간이 지났습니다" 가 뜨고, 화면은 코드 단계로 되돌아간다.
 * 실기기에서 이 증상이 실제로 나왔다.
 *
 * 그래서 표를 없앴다. 비밀번호를 정할 때 이름·코드를 함께 보내고 서버가 그 자리에서
 * 다시 확인한다. 요청 사이에 남는 상태가 없으므로 어느 인스턴스에 닿아도 같다.
 * verify-code 는 "코드가 맞는지" 를 미리 알려 주는 용도로만 남는다 —
 * 비밀번호를 다 적은 뒤에 코드가 틀렸다고 하면 사람이 두 번 일한다.
 */
import {
  findByLoginName,
  getAccountSecret,
  getAccountView,
  makeFirstAdmin,
  markLoginFailure,
  markLoginSuccess,
  markPrivacyAgreed,
  setPassword,
} from "../db/accounts.ts";
import { recordLogin } from "../db/audit.ts";
import { canDeleteChild } from "./children.ts";
import { needsConsent } from "./consent.ts";
import { createSession, deleteSessionByToken } from "../db/sessions.ts";
import { claimSetting, releaseSetting } from "../db/settings.ts";
import { BOOTSTRAP_KEY, bootstrapClosed } from "./boot_state.ts";
import { addStaff, listStaff, LoginNameTakenError } from "../db/staff.ts";
import {
  BOOT_ACTOR,
  BOOTSTRAP_ROLES,
  type BootstrapChoice,
  parseBootstrapChoice,
} from "../lib/bootstrap.ts";
import { type RequestUser, runWithUser } from "../lib/request_context.ts";
import {
  checkPassword,
  hashSecret,
  isInviteCodeShape,
  needsRehash,
  verifySecret,
} from "../lib/password.ts";
import { type Level, loginBlockedReason } from "../lib/permission.ts";
import { clearCookie, sessionCookie } from "./cookie.ts";
import { readSessionToken, resolveSession } from "./guard.ts";

const JSON_HEADERS = { "cache-control": "no-store" };

/** 이름·비번이 안 맞을 때 화면에 가는 단 하나의 말. */
const DENIED = "이름이나 비밀번호가 맞지 않습니다.";

function ok(body: unknown, headers?: HeadersInit): Response {
  return Response.json(body, { headers: { ...JSON_HEADERS, ...headers } });
}

function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400, headers: JSON_HEADERS });
}

function denied(message = DENIED): Response {
  return Response.json({ error: message }, { status: 401, headers: JSON_HEADERS });
}

function serverError(where: string, error: unknown): Response {
  console.error(`[${where}]`, error);
  return Response.json(
    { error: "요청을 처리하지 못했습니다." },
    { status: 500, headers: JSON_HEADERS },
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

function text(value: unknown, max = 200): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/* ---------- GET /api/auth/state ---------- */

/**
 * 로그인 화면이 무엇을 그릴지 정하는 데 쓴다.
 *
 * bootstrap 이 true 면 "최초 관리자 등록" 을 그린다. 이 값은 화면을 고르는 힌트일 뿐이고,
 * 실제로 막는 것은 아래 bootstrap 핸들러다 — 화면을 믿고 막으면 안 막힌 것이다.
 *
 * 후보 이름(직원 명단)은 로그인 없이 나가는 정보다. 최초 부팅일 때만 내보낸다.
 */
export async function handleAuthState(): Promise<Response> {
  try {
    if (await bootstrapClosed()) return ok({ bootstrap: false, candidates: [] });

    const staff = await listStaff(null, null);
    return ok({
      bootstrap: true,
      // 최초 관리자로 고를 수 있는 사람. 명단에 있는 종사자만 보여 준다.
      candidates: staff
        .filter((one) =>
          one.role !== null && (BOOTSTRAP_ROLES as readonly string[]).includes(one.role)
        )
        .map((one) => ({ id: one.id, name: one.name, role: one.role })),
      // 후보가 없을 때 화면이 "첫 종사자 등록" 칸에 늘어놓을 직급
      roles: BOOTSTRAP_ROLES,
    });
  } catch (error) {
    return serverError("GET /api/auth/state", error);
  }
}

/* ---------- GET /api/auth/me ---------- */

/**
 * 지금 누구인가. 세션이 없으면 user: null 이고 200 이다 — 401 이 아니다.
 * 화면이 "로그인했나" 를 묻는 자리라, 안 했다는 답도 정상적인 답이다.
 */
export async function handleAuthMe(req: Request): Promise<Response> {
  try {
    const found = await resolveSession(req);
    const account = found?.account ?? null;
    // 화면이 버튼을 감출 때 쓰는 값. 막는 것은 어차피 서버다(api/children.ts).
    // 설정에 달린 판단이라 등급만으로는 화면이 알 수 없어 함께 내려보낸다.
    return ok({
      user: account,
      can: { delete_child: await canDeleteChild((account?.level ?? null) as Level | null) },
    });
  } catch (error) {
    return serverError("GET /api/auth/me", error);
  }
}

/* ---------- POST /api/auth/login ---------- */

export async function handleLogin(req: Request): Promise<Response> {
  const body = await readJson(req);
  if (!body) return badRequest("요청 본문이 JSON이 아닙니다.");

  const name = text(body.name, 100);
  const password = text(body.password, 200);
  if (!name || !password) return badRequest("이름과 비밀번호를 입력해 주세요.");

  try {
    const found = await findByLoginName(name);

    // 동명이인. 비밀번호를 검사하지 않는다 — 한쪽이라도 맞춰 보면
    // "어느 쪽이 맞는지" 가 새어 나간다. 사람이 관리자에게 물어야 풀린다.
    if (found.length > 1) {
      await recordLogin(name, "로그인 실패 — 같은 이름의 계정이 둘 이상");
      return denied("같은 이름의 계정이 둘 이상입니다. 관리자에게 문의해 주세요.");
    }

    const account = found[0];
    if (!account) {
      // 사람에게는 갈라서 알리지 않지만(아래 denied), 기록에는 적는다 —
      // 없는 이름으로 두드리는 일이 로그에 보여야 한다. 비밀번호는 어디에도 적지 않는다.
      await recordLogin(name, "로그인 실패 — 없는 로그인 이름");
      return denied();
    }

    const blocked = loginBlockedReason(account);
    if (blocked === "잠긴 계정") {
      await recordLogin(account.login_name, "로그인 실패 — 잠긴 계정(여러 번 틀림)");
      return denied("여러 번 틀려 잠겼습니다. 15분 뒤에 다시 시도해 주세요.");
    }
    // 나머지 이유(없는 계정·정지·비번 미설정)는 갈라서 알리지 않는다.
    if (blocked) {
      await recordLogin(account.login_name, `로그인 실패 — ${blocked}`);
      return denied();
    }

    if (!(await verifySecret(password, account.password_hash))) {
      await markLoginFailure(account);
      // 몇 번째 실패인지 적는다 — 5번째면 잠긴다(db/accounts.ts MAX_FAILED)
      await recordLogin(
        account.login_name,
        `로그인 실패 — 비밀번호 불일치(${account.failed_attempts + 1}회)`,
      );
      return denied();
    }

    // 반복 횟수를 올린 뒤 처음 들어온 사람. 사람은 아무것도 안 하고 해시만 새것이 된다.
    const rehash = needsRehash(account.password_hash) ? await hashSecret(password) : undefined;
    await markLoginSuccess(account.id, rehash);

    const { token, expiresAt } = await createSession(
      account.id,
      req.headers.get("user-agent"),
    );
    await recordLogin(account.login_name, "로그인 성공");
    // 034 뒤 아직 동의 전인 기존 계정 — 화면이 들어가기 전에 한 번 묻는다(api/consent.ts)
    return ok(
      {
        user: await getAccountView(account.id),
        consent_needed: await needsConsent(account.id),
      },
      { "set-cookie": sessionCookie(req, token, expiresAt) },
    );
  } catch (error) {
    return serverError("POST /api/auth/login", error);
  }
}

/* ---------- 초대코드 확인 (두 경로가 함께 쓴다) ---------- */

/**
 * 이름 + 코드가 맞는지 본다. 맞으면 그 사람을, 아니면 화면에 보낼 응답을 준다.
 *
 * verify-code 와 first-password 가 똑같은 검사를 한다. 두 곳에 적으면
 * 한쪽만 고쳐 놓고 왜 다르게 도는지 찾게 된다.
 */
async function verifyInviteCode(
  name: string,
  code: string,
): Promise<{ account: Awaited<ReturnType<typeof findByLoginName>>[number] } | { error: Response }> {
  if (!isInviteCodeShape(code)) {
    return { error: denied("초대코드는 숫자 6자리입니다.") };
  }

  const found = await findByLoginName(name);
  if (found.length > 1) {
    return { error: denied("같은 이름의 계정이 둘 이상입니다. 관리자에게 문의해 주세요.") };
  }

  const account = found[0];
  const nope = denied("이름이나 초대코드가 맞지 않습니다.");

  if (!account) return { error: nope };
  if (account.status === "종료" || account.account_status === "정지") return { error: nope };

  if (account.locked_until && new Date(account.locked_until) > new Date()) {
    return { error: denied("여러 번 틀려 잠겼습니다. 15분 뒤에 다시 시도해 주세요.") };
  }
  if (!account.invite_code_hash) return { error: nope };

  // 만료는 알려 준다. 사람이 할 일이 있기 때문 — 관리자에게 재발급을 받으면 된다.
  if (account.invite_code_expires_at && new Date(account.invite_code_expires_at) < new Date()) {
    return { error: denied("초대코드가 만료되었습니다. 관리자에게 다시 받아 주세요.") };
  }

  if (!(await verifySecret(code, account.invite_code_hash))) {
    await markLoginFailure(account);
    return { error: nope };
  }

  return { account };
}

/* ---------- POST /api/auth/verify-code ---------- */

/**
 * 이름 + 초대코드가 맞는지만 본다. 아무것도 만들지 않는다.
 *
 * 이 단계가 있는 이유는 하나다 — 비밀번호를 다 적은 뒤에 "코드가 틀렸습니다" 를
 * 보면 사람이 두 번 일한다. 실제로 비밀번호를 정하는 것은 아래 first-password 고,
 * 거기서 코드를 다시 확인한다. 여기를 건너뛰어도 안전하다.
 */
export async function handleVerifyCode(req: Request): Promise<Response> {
  const body = await readJson(req);
  if (!body) return badRequest("요청 본문이 JSON이 아닙니다.");

  const name = text(body.name, 100);
  const code = text(body.code, 20);
  if (!name || !code) return badRequest("이름과 초대코드를 입력해 주세요.");

  try {
    const found = await verifyInviteCode(name, code);
    if ("error" in found) return found.error;
    return ok({ ok: true, name: found.account.name });
  } catch (error) {
    return serverError("POST /api/auth/verify-code", error);
  }
}

/* ---------- POST /api/auth/first-password ---------- */

/**
 * 이름 + 초대코드 + 새 비밀번호. 정하고 나면 곧바로 세션까지 준다.
 *
 * 방금 코드를 맞힌 사람에게 다시 로그인하라고 할 이유가 없다.
 *
 * 코드를 여기서 다시 확인한다. verify-code 를 지나왔다는 것을 믿지 않는다 —
 * 요청 사이에 남는 것이 없어야 어느 인스턴스에 닿아도 같게 동작한다.
 */
export async function handleFirstPassword(req: Request): Promise<Response> {
  const body = await readJson(req);
  if (!body) return badRequest("요청 본문이 JSON이 아닙니다.");

  const name = text(body.name, 100);
  const code = text(body.code, 20);
  const password = text(body.password, 200);

  if (!name || !code) return badRequest("이름과 초대코드를 다시 넣어 주세요.");
  if (!password) return badRequest("비밀번호를 입력해 주세요.");
  // 개인정보 처리 안내 동의는 필수다(③단계). 코드를 맞춰 보기 전에 막아 시도 횟수를 쓰지 않게.
  if (body.agreed !== true) return badRequest("개인정보 처리 안내를 읽고 동의에 체크해 주세요.");

  try {
    const found = await verifyInviteCode(name, code);
    if ("error" in found) return found.error;

    const problem = checkPassword(password, found.account.name);
    if (problem) return badRequest(problem);

    await setPassword(found.account.id, password);
    await markPrivacyAgreed(found.account.id);

    const { token, expiresAt } = await createSession(
      found.account.id,
      req.headers.get("user-agent"),
    );
    return ok(
      { user: await getAccountView(found.account.id) },
      { "set-cookie": sessionCookie(req, token, expiresAt) },
    );
  } catch (error) {
    return serverError("POST /api/auth/first-password", error);
  }
}

/* ---------- POST /api/auth/bootstrap ---------- */

/** 부팅 화면에서 한 일의 "누가" — 감사 로그에 "최초 부팅" 으로 남는다(로그인 전이라 사람이 없다) */
const BOOT_USER: RequestUser = {
  id: "",
  name: BOOT_ACTOR,
  login_name: BOOT_ACTOR,
  level: "",
  access_kind: "",
  roles: [],
  active_role: null,
  session_id: null,
};

function bootClosedResponse(): Response {
  return Response.json(
    { error: "이미 계정이 있습니다. 관리자에게 초대코드를 받아 주세요." },
    { status: 409, headers: JSON_HEADERS },
  );
}

/**
 * 최초 관리자. 계정이 하나도 없을 때만 도는 길이고, 한 번 돌면 영영 닫힌다.
 *
 * [두 갈래 — lib/bootstrap.ts]
 *   명단에서 고르기 { staff_id, password }
 *   첫 종사자 직접 입력 { name, role, password } — 명단이 비어 있는 새 센터. 잠금 모드에서는
 *   로그인 없이 명단에 넣을 길이 없어서(POST /api/staff 는 센터장 이상) 부팅 화면이 받는다.
 *   등록은 보통 명단 등록과 같은 함수(addStaff — 감사 로그 포함)이고, 두 갈래 모두 아래 이중 잠금을 똑같이 지난다.
 *
 * [화면이 아니라 서버가 막는다]
 * 화면이 폼을 숨기는 것으로는 아무도 못 막는다. 이 핸들러가 직접 확인한다.
 *
 * [두 사람이 동시에 누르는 경우]
 * PostgREST 에는 트랜잭션이 없다. 그래서 settings 에 자리를 먼저 잡는다 —
 * key 가 기본키라 두 번째 insert 는 DB 가 막는다. 자리를 잡은 요청만 진행한다.
 * saveSetting 은 upsert 라 이 목적에 못 쓴다(덮어써 버린다). 여기서 직접 넣는다.
 */
export async function handleBootstrap(req: Request): Promise<Response> {
  const body = await readJson(req);
  if (!body) return badRequest("요청 본문이 JSON이 아닙니다.");

  return await runWithUser(BOOT_USER, () => bootstrap(req, body));
}

async function bootstrap(req: Request, body: Record<string, unknown>): Promise<Response> {
  try {
    // 잠금을 먼저 본다 — 닫힌 뒤에는 본문 모양이 어떻든 409(어느 갈래가 열려 있었는지 흘리지 않게)
    if (await bootstrapClosed()) return bootClosedResponse();

    const choice: BootstrapChoice | string = parseBootstrapChoice(body);
    const password = text(body.password, 200);
    if (typeof choice === "string") return badRequest(choice);
    if (!password) return badRequest("사람과 비밀번호를 골라 주세요.");

    let staffId: string;
    if (choice.kind === "pick") {
      const account = await getAccountSecret(choice.staffId);
      if (!account) return badRequest("그 사람을 찾지 못했습니다.");
      if (account.status === "종료") return badRequest("종료된 사람은 고를 수 없습니다.");
      // 화면 후보와 같은 기준. 화면을 거치지 않은 요청도 같은 곳에서 막힌다.
      if (!account.role || !(BOOTSTRAP_ROLES as readonly string[]).includes(account.role)) {
        return badRequest("최초 관리자는 센터장·생활복지사 중에서 고릅니다.");
      }
      const problem = checkPassword(password, account.name);
      if (problem) return badRequest(problem);
      staffId = account.id;
    } else {
      const problem = checkPassword(password, choice.name);
      if (problem) return badRequest(problem);
      staffId = "";
    }

    // 자리 선점. 이미 있으면 다른 요청이 먼저 들어온 것이다.
    if (!(await claimSetting(BOOTSTRAP_KEY))) return bootClosedResponse();

    if (choice.kind === "new") {
      // 선점한 요청만 명단에 넣는다(동시에 둘이 넣어도 명단에 한 사람만 생긴다).
      // 넣지 못하면 자리를 돌려놓는다 — 부팅이 닫힌 채 계정 0개로 남으면 아무도 못 들어온다.
      try {
        staffId = (await addStaff(choice.name, [choice.role], null)).id;
      } catch (error) {
        await releaseSetting(BOOTSTRAP_KEY);
        if (error instanceof LoginNameTakenError) return badRequest(error.message);
        throw error;
      }
    }

    await makeFirstAdmin(staffId, password);

    const { token, expiresAt } = await createSession(staffId, req.headers.get("user-agent"));
    return ok(
      { user: await getAccountView(staffId) },
      { "set-cookie": sessionCookie(req, token, expiresAt) },
    );
  } catch (error) {
    return serverError("POST /api/auth/bootstrap", error);
  }
}

/* ---------- POST /api/auth/logout ---------- */

/**
 * 이 기기의 세션만 지운다. 다른 기기는 그대로 둔다 —
 * 폰에서 로그아웃했다고 센터 PC 가 끊기면 놀란다.
 *
 * 세션이 없어도 200 이다. "로그아웃 상태로 만들어 달라" 는 요청은
 * 이미 로그아웃이어도 이룬 것이다.
 */
export async function handleLogout(req: Request): Promise<Response> {
  const token = readSessionToken(req);
  try {
    if (token) await deleteSessionByToken(token);
    return ok({ ok: true }, { "set-cookie": clearCookie(req) });
  } catch (error) {
    return serverError("POST /api/auth/logout", error);
  }
}
