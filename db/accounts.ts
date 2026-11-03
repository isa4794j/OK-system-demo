/**
 * 계정(staff 의 로그인 칸) 데이터 접근
 *
 * 규칙: Supabase 호출은 /db 안에서만 한다.
 *
 * 사람은 db/staff.ts 가 맡고, 그 사람의 "로그인에 필요한 것" 만 여기서 다룬다.
 * 표는 하나(staff)지만 다루는 일이 다르다 — 명단 화면은 비번 해시를 알 이유가 없고,
 * 로그인은 색 번호를 알 이유가 없다.
 *
 * [해시는 이 파일 밖으로 안 나간다]
 * password_hash 와 invite_code_hash 는 검증할 때만 읽고, 화면으로 가는 모양
 * (AccountView)에는 담지 않는다. 담을 일이 없는 값을 실어 보내면 언젠가 새어 나간다.
 */
import { getClient, NotFoundError } from "./client.ts";
import { recordAudit } from "./audit.ts";
import {
  type AccessKind,
  type AccountState,
  accountStateOf,
  guessAccessKind,
  type Level,
  levelOf,
} from "../lib/permission.ts";
import { hashSecret, makeInviteCode } from "../lib/password.ts";
import type { Role, StaffStatus } from "./staff.ts";
import { DEMO_ACCOUNTS } from "../api/demo_guard.ts";

/** 초대코드가 살아 있는 기간. 격주로 오는 봉사자도 받을 수 있게 넉넉히 둔다. */
export const INVITE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 이만큼 틀리면 잠근다. 6자리 코드는 100만 가지뿐이라 시도 제한이 곧 자물쇠다. */
export const MAX_FAILED = 5;

/** 잠기는 시간. 사람이 오타를 낸 경우를 생각하면 하루는 너무 길다. */
export const LOCK_MS = 15 * 60 * 1000;

/** 검증에 쓰는 모양. 해시가 들어 있어 절대 화면으로 내보내지 않는다. */
export type AccountSecret = {
  id: string;
  name: string;
  login_name: string;
  role: Role | null;
  roles: Role[];
  status: StaffStatus;
  password_hash: string | null;
  invite_code_hash: string | null;
  invite_code_expires_at: string | null;
  is_admin: boolean;
  access_kind: AccessKind;
  account_status: string;
  failed_attempts: number;
  locked_until: string | null;
};

/** 화면으로 나가는 모양. 해시가 없다. */
export type AccountView = {
  id: string;
  name: string;
  login_name: string;
  /** 대표 역할(호환). 새 코드는 roles */
  role: Role | null;
  /** 역할 목록 — 겸직이면 둘 이상 */
  roles: Role[];
  status: StaffStatus;
  is_admin: boolean;
  access_kind: AccessKind;
  /** 계정 자체의 정지 여부(명단 종료와 따로). 화면이 "정지" 태그·[정지 해제] 를 가를 때 쓴다 */
  account_status: string;
  level: Level;
  state: AccountState;
  invite_code_expires_at: string | null;
  password_set_at: string | null;
  last_login_at: string | null;
  locked_until: string | null;
  /** 열려 있는 세션 수. 목록을 읽는 쪽이 채워 준다. */
  sessions: number;
};

// 한 줄로 둔다. 두 줄로 이어 붙이면 supabase-js 가 select 를 타입으로 읽지 못한다.
// deno-fmt-ignore
const SECRET_COLUMNS = "id, name, login_name, role, roles, status, password_hash, invite_code_hash, invite_code_expires_at, is_admin, access_kind, account_status, failed_attempts, locked_until";

// deno-fmt-ignore
const VIEW_COLUMNS = "id, name, login_name, role, roles, status, password_hash, invite_code_hash, invite_code_expires_at, is_admin, access_kind, account_status, password_set_at, last_login_at, locked_until";

/** 화면으로 나갈 모양으로 다듬는다. 해시는 여기서 떨어져 나간다. */
function toView(row: Record<string, unknown>, sessions = 0): AccountView {
  const secret = row as unknown as AccountSecret & {
    password_set_at: string | null;
    last_login_at: string | null;
  };
  return {
    id: secret.id,
    name: secret.name,
    login_name: secret.login_name,
    role: secret.role,
    roles: secret.roles ?? [],
    status: secret.status,
    is_admin: secret.is_admin,
    access_kind: secret.access_kind,
    account_status: secret.account_status,
    level: levelOf({ roles: secret.roles ?? [], is_admin: secret.is_admin }),
    state: accountStateOf(secret),
    invite_code_expires_at: secret.invite_code_expires_at,
    password_set_at: secret.password_set_at,
    last_login_at: secret.last_login_at,
    locked_until: secret.locked_until,
    sessions,
  };
}

/* ---------- 찾기 ---------- */

/**
 * base_001, base_002 … 중 아직 아무도 안 쓰는 첫 로그인 이름.
 * 비교는 로그인과 같이 앞뒤 공백·대소문자를 가리지 않는다(유일 인덱스와 같은 기준).
 */
export async function nextFreeLoginName(base: string): Promise<string> {
  const stem = base.trim();
  const { data, error } = await getClient().from("staff").select("login_name");
  if (error) {
    throw new Error(`로그인 이름 조회 실패: ${error.message}`);
  }
  return pickFreeLoginName(stem, (data ?? []).map((row) => String(row.login_name ?? "")));
}

/** 쓰는 이름 목록에서 stem_001 부터 빈 번호를 찾는다(앞뒤 공백·대소문자 무시). 테스트가 지킨다. */
export function pickFreeLoginName(stem: string, used: string[]): string {
  const taken = new Set(used.map((one) => one.trim().toLowerCase()));
  for (let n = 1; n < 1000; n++) {
    const candidate = `${stem.trim()}_${String(n).padStart(3, "0")}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  throw new Error("비어 있는 로그인 이름 번호를 찾지 못했습니다.");
}

/**
 * 로그인 이름으로 계정을 찾는다. 앞뒤 공백과 대소문자를 가리지 않는다.
 *
 * 여러 건이 나올 수 있다 — 유일 인덱스가 막고 있지만, 그 인덱스가 없던 시절의
 * 데이터가 남아 있을 수 있고, 무엇보다 "하나뿐일 것" 을 코드가 믿으면 안 된다.
 * 부르는 쪽이 개수를 보고 판단한다(둘 이상이면 비번을 검사하지 않고 거부).
 */
export async function findByLoginName(loginName: string): Promise<AccountSecret[]> {
  const key = loginName.trim().toLowerCase();
  if (!key) return [];

  const { data, error } = await getClient()
    .from("staff")
    .select(SECRET_COLUMNS)
    .ilike("login_name", key);

  if (error) {
    throw new Error(`계정 조회 실패: ${error.message}`);
  }

  // ilike 는 % 와 _ 를 특별하게 읽는다. 이름에 그 글자가 있으면 남의 계정까지 걸린다.
  // 읽어 온 뒤 앱에서 정확히 같은 것만 남긴다.
  return ((data ?? []) as unknown as AccountSecret[])
    .filter((one) => one.login_name?.trim().toLowerCase() === key);
}

export async function getAccountSecret(id: string): Promise<AccountSecret | null> {
  const { data, error } = await getClient()
    .from("staff")
    .select(SECRET_COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    throw new Error(`계정 조회 실패: ${error.message}`);
  }
  return (data as unknown as AccountSecret | null) ?? null;
}

/**
 * 비밀번호를 정한 계정이 하나라도 있는가. 있으면 최초 부팅이 아니다.
 * 한 줄만 본다 — 명단 전체를 한 사람씩 묻지 않는다.
 */
export async function hasPasswordAccount(): Promise<boolean> {
  const { data, error } = await getClient()
    .from("staff")
    .select("id")
    .not("password_hash", "is", null)
    .limit(1);

  if (error) {
    throw new Error(`계정 존재 확인 실패: ${error.message}`);
  }
  return (data ?? []).length > 0;
}

/**
 * 관리자 깃발이 붙은 사람인가. 관리자 계정 보호(api/admin_target.ts)가 쓴다.
 * 없는 사람이면 false — "찾지 못했습니다" 는 부르는 쪽 핸들러가 알려 준다.
 */
export async function isAdminStaff(id: string): Promise<boolean> {
  const { data, error } = await getClient()
    .from("staff")
    .select("is_admin")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    throw new Error(`관리자 여부 조회 실패: ${error.message}`);
  }
  return (data as { is_admin: boolean } | null)?.is_admin === true;
}

/** 세션이 가리키는 사람. 관문과 /api/auth/me 가 쓴다. */
export async function getAccountView(id: string): Promise<AccountView | null> {
  const { data, error } = await getClient()
    .from("staff")
    .select(VIEW_COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    throw new Error(`계정 조회 실패: ${error.message}`);
  }
  return data ? toView(data as Record<string, unknown>) : null;
}

/** 계정 관리 화면이 쓰는 목록. 명단 전체를 계정 눈으로 본다. */
export async function listAccounts(sessions: Map<string, number>): Promise<AccountView[]> {
  const { data, error } = await getClient()
    .from("staff")
    .select(VIEW_COLUMNS)
    .order("name", { ascending: true });

  if (error) {
    throw new Error(`계정 목록 조회 실패: ${error.message}`);
  }
  return ((data ?? []) as Record<string, unknown>[])
    .map((row) => toView(row, sessions.get(row.id as string) ?? 0));
}

/**
 * 지금 실제로 들어올 수 있는 관리자가 몇 명인가.
 *
 * "깃발이 붙어 있는가" 만으로는 모자란다. 깃발은 붙었는데 비번을 안 정했거나
 * 정지된 계정은 계정을 발급해 줄 수 없다. 그런 사람을 믿고 마지막 한 명을
 * 풀어 주면 아무도 못 들어오는 상태가 된다 — 그때는 SQL 비상 절차뿐이다.
 *
 * except 를 주면 그 사람은 빼고 센다. "이 사람을 풀어도 남는 관리자가 있나" 를
 * 묻는 자리라, 자기 자신을 세면 늘 1 이상이 되어 뜻이 없다.
 */
export async function countUsableAdmins(except?: string): Promise<number> {
  const { data, error } = await getClient()
    .from("staff")
    .select("id")
    .eq("is_admin", true)
    .eq("account_status", "활성")
    .eq("status", "활동중")
    .not("password_hash", "is", null);

  if (error) {
    throw new Error(`관리자 수 조회 실패: ${error.message}`);
  }
  return (data ?? []).filter((one) => (one as { id: string }).id !== except).length;
}

/* ---------- 초대코드 ---------- */

/**
 * 초대코드를 발급한다. 평문은 이 함수가 돌려주는 것이 전부다 —
 * 저장하는 것은 해시라 아무도 다시 볼 수 없다.
 *
 * 이미 코드가 있으면 새것이 옛것을 덮는다. 그 순간 옛 코드는 무효다.
 * 잠금과 실패 횟수도 함께 푼다 — 재발급은 "다시 해 보세요" 라는 뜻이다.
 */
export async function issueInviteCode(
  staffId: string,
  issuedBy: string | null,
): Promise<{ code: string; expiresAt: string }> {
  const code = makeInviteCode();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();

  const { data, error } = await getClient()
    .from("staff")
    .update({
      invite_code_hash: await hashSecret(code),
      invite_code_expires_at: expiresAt,
      invite_code_issued_at: new Date().toISOString(),
      invite_code_issued_by: issuedBy,
      failed_attempts: 0,
      locked_until: null,
    })
    .eq("id", staffId)
    .select("name, login_name")
    .single();

  if (error) {
    throw new Error(`초대코드 발급 실패: ${error.message}`);
  }

  await recordAudit({
    action: "update",
    table_name: "staff",
    record_id: staffId,
    // 코드 자체는 절대 남기지 않는다. 로그를 볼 수 있으면 계정을 열 수 있게 된다.
    summary: `초대코드 발급 — ${(data as { name: string }).name}`,
    after: { invite_code_expires_at: expiresAt },
  });

  return { code, expiresAt };
}

/** 초대코드를 회수한다. 아직 안 쓴 코드를 무르는 자리. */
export async function clearInviteCode(staffId: string): Promise<void> {
  const { error, count } = await getClient()
    .from("staff")
    .update({ invite_code_hash: null, invite_code_expires_at: null }, { count: "exact" })
    .eq("id", staffId);

  if (error) {
    throw new Error(`초대코드 회수 실패: ${error.message}`);
  }
  if (count === 0) throw new NotFoundError("그 사람을 찾지 못했습니다.");
}

/* ---------- 비밀번호 ---------- */

/**
 * 비밀번호를 정한다. 초대코드는 이 순간 소진된다(1회용).
 * 잠금·실패 횟수도 함께 푼다.
 */
export async function setPassword(staffId: string, password: string): Promise<void> {
  const client = getClient();
  // 감사용으로 "처음인지 재설정인지" 와 이름만 읽는다. 해시 자체는 기록에 싣지 않는다.
  const { data: who, error: readError } = await client
    .from("staff")
    .select("name, login_name, password_set_at")
    .eq("id", staffId)
    .maybeSingle();
  if (readError) throw new Error(`계정 읽기 실패: ${readError.message}`);

  const { error } = await client
    .from("staff")
    .update({
      password_hash: await hashSecret(password),
      password_set_at: new Date().toISOString(),
      invite_code_hash: null,
      invite_code_expires_at: null,
      failed_attempts: 0,
      locked_until: null,
    })
    .eq("id", staffId);

  if (error) {
    throw new Error(`비밀번호 설정 실패: ${error.message}`);
  }

  // 초대코드로 비밀번호를 정한 일. 재발급 코드로 온 경우 곧 "비밀번호 재설정" 이다.
  // 로그인 전 요청이라 요청 컨텍스트에 사람이 없다 — 코드를 확인한 본인 이름으로 남긴다.
  const again = Boolean(who?.password_set_at);
  await recordAudit({
    action: "update",
    actor: who?.login_name ?? undefined,
    table_name: "staff",
    record_id: staffId,
    summary: `비밀번호 ${again ? "재설정" : "첫 설정"}(초대코드) — ${who?.name ?? ""}`.trim(),
    before: { password_set_at: who?.password_set_at ?? null },
    after: { password_set: true },
  });
}

/**
 * 명단에서 종료됐던 사람이 돌아올 때. 옛 비밀번호로는 못 들어오게 비운다.
 *
 * 종료는 "이 사람은 센터를 떠났다" 는 판단이다. 돌아왔다고 옛 비밀번호가 그대로 살아나면,
 * 떠나 있던 사이 그 비밀번호가 누구에게 알려졌는지 아무도 모른다.
 * 그래서 복귀는 초대코드 재발급으로만 한다 — 계정 관리 화면에서 [코드 발급].
 * 비밀번호가 없던 사람이면 아무것도 하지 않는다(false).
 */
export async function clearPasswordForReturn(staffId: string): Promise<boolean> {
  const client = getClient();
  const { data: who, error: readError } = await client
    .from("staff")
    .select("name, password_set_at")
    .eq("id", staffId)
    .maybeSingle();
  if (readError) throw new Error(`계정 읽기 실패: ${readError.message}`);
  if (!who?.password_set_at) return false;

  const { error } = await client
    .from("staff")
    .update({
      password_hash: null,
      password_set_at: null,
      invite_code_hash: null,
      invite_code_expires_at: null,
      failed_attempts: 0,
      locked_until: null,
    })
    .eq("id", staffId);
  if (error) throw new Error(`비밀번호 비우기 실패: ${error.message}`);

  await recordAudit({
    action: "update",
    table_name: "staff",
    record_id: staffId,
    summary: `복귀 — 비밀번호 비움(초대코드로 다시 시작) — ${who.name}`,
    before: { password_set_at: who.password_set_at },
    after: { password_set: false },
  });
  return true;
}

/**
 * 로그인에 성공했을 때. 실패 횟수를 지우고 마지막 로그인 시각을 남긴다.
 * rehash 가 오면 해시를 조용히 새 규칙으로 바꾼다 — 사람은 아무것도 안 한다.
 */
export async function markLoginSuccess(staffId: string, rehash?: string): Promise<void> {
  const changes: Record<string, unknown> = {
    failed_attempts: 0,
    locked_until: null,
    last_login_at: new Date().toISOString(),
  };
  if (rehash) changes.password_hash = rehash;

  const { error } = await getClient().from("staff").update(changes).eq("id", staffId);
  if (error) console.error("[markLoginSuccess]", error.message);
}

/**
 * 로그인에 실패했을 때. 한 번 세고, 다 차면 잠근다.
 * 잠긴 뒤에는 맞는 값을 넣어도 시간이 지나야 열린다 — 그게 자물쇠의 뜻이다.
 */
export async function markLoginFailure(account: AccountSecret): Promise<void> {
  const changes = failureChanges(account);
  if (!changes) return;

  const { error } = await getClient().from("staff").update(changes).eq("id", account.id);
  if (error) console.error("[markLoginFailure]", error.message);
}

/**
 * 실패 한 번에 staff 행에 쓸 값. null 이면 아무것도 쓰지 않는다.
 * 공개 데모 계정은 세지도 잠그지도 않는다 — 한 방문자의 오타로 다른 방문자가 15분간
 * 못 들어오면 안 된다. 실패 기록은 호출하는 쪽의 로그인 기록(recordLogin)이 따로 남긴다.
 */
export function failureChanges(
  account: Pick<AccountSecret, "login_name" | "failed_attempts">,
  now: number = Date.now(),
): Record<string, unknown> | null {
  if (DEMO_ACCOUNTS.includes(account.login_name)) return null;
  const failed = account.failed_attempts + 1;
  if (failed >= MAX_FAILED) {
    return { failed_attempts: 0, locked_until: new Date(now + LOCK_MS).toISOString() };
  }
  return { failed_attempts: failed };
}

/* ---------- 계정 설정 ---------- */

export type AccountPatch = {
  login_name?: string;
  is_admin?: boolean;
  access_kind?: AccessKind;
  account_status?: string;
};

/**
 * 계정 설정을 고친다. 이름·역할 같은 명단 정보는 여기서 안 만진다(db/staff.ts 의 일).
 * 무엇을 고쳤는지 감사 로그에 남긴다 — 권한이 바뀌는 자리라 조용히 지나가면 안 된다.
 */
export async function updateAccount(id: string, patch: AccountPatch): Promise<AccountView> {
  const before = await getAccountSecret(id);
  if (!before) throw new NotFoundError("그 사람을 찾지 못했습니다.");

  const { data, error } = await getClient()
    .from("staff")
    .update(patch)
    .eq("id", id)
    .select(VIEW_COLUMNS)
    .single();

  if (error) {
    if (/duplicate key|idx_staff_login_name_unique|23505/i.test(error.message)) {
      throw new Error(`"${patch.login_name}" 은(는) 이미 다른 사람이 쓰고 있습니다.`);
    }
    throw new Error(`계정 수정 실패: ${error.message}`);
  }

  const changed = Object.keys(patch).join(", ");
  await recordAudit({
    action: "update",
    table_name: "staff",
    record_id: id,
    summary: `계정 설정 변경 — ${before.name} (${changed})`,
    before: {
      login_name: before.login_name,
      is_admin: before.is_admin,
      access_kind: before.access_kind,
      account_status: before.account_status,
    },
    after: patch,
  });

  return toView(data as Record<string, unknown>);
}

/**
 * 최초 관리자. 계정이 0개일 때 딱 한 번 도는 길이다.
 *
 * 이 함수는 "계정이 0개인가" 를 확인하지 않는다 — 그건 부르는 쪽(api/auth.ts)이
 * settings 의 자리 선점으로 막는다. 여기서 또 확인하면 두 곳이 같은 판단을 하게 되고,
 * 경합은 어느 쪽도 못 막는다.
 */
export async function makeFirstAdmin(staffId: string, password: string): Promise<void> {
  const { error } = await getClient()
    .from("staff")
    .update({
      password_hash: await hashSecret(password),
      password_set_at: new Date().toISOString(),
      is_admin: true,
      account_status: "활성",
      access_kind: "PC",
      invite_code_hash: null,
      invite_code_expires_at: null,
      failed_attempts: 0,
      locked_until: null,
    })
    .eq("id", staffId);

  if (error) {
    throw new Error(`최초 관리자 설정 실패: ${error.message}`);
  }

  await recordAudit({
    action: "update",
    table_name: "staff",
    record_id: staffId,
    summary: "최초 관리자 등록",
    after: { is_admin: true },
  });
}

/** 등록할 때 직급으로 접속 권한을 추정한다. db/staff.ts 의 addStaff 가 쓴다. */
export { guessAccessKind };

/* ---------- 개인정보 처리 동의(034) ---------- */

/**
 * 034(staff.privacy_agreed_at)가 적용됐나 — 한 번 물어 기억한다(재시작하면 다시 묻는다).
 * 적용 전 DB 에서는 동의를 묻지 않는다(기록할 칸이 없는데 물으면 매번 다시 묻게 된다).
 */
let schema034: boolean | null = null;

export async function hasPrivacyColumn(): Promise<boolean> {
  if (schema034 !== null) return schema034;
  const { error } = await getClient().from("staff").select("privacy_agreed_at").limit(1);
  if (!error) schema034 = true;
  else if (error.code === "42703" || /column .* does not exist/i.test(error.message)) {
    schema034 = false;
  } else throw new Error(`직원 표 확인 실패: ${error.message}`);
  return schema034;
}

/** 동의한 때. 아직이면 null, 034 전 DB 면 undefined(묻지 않는다). */
export async function getPrivacyAgreedAt(id: string): Promise<string | null | undefined> {
  if (!(await hasPrivacyColumn())) return undefined;
  const { data, error } = await getClient()
    .from("staff")
    .select("privacy_agreed_at")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    throw new Error(`동의 기록 조회 실패: ${error.message}`);
  }
  if (!data) throw new NotFoundError("계정을 찾지 못했습니다.");
  return (data as { privacy_agreed_at: string | null }).privacy_agreed_at ?? null;
}

/**
 * 동의 시각을 적는다. 이미 적혀 있으면 그대로 둔다(처음 동의한 때가 기록이다).
 * 감사 로그에 남긴다 — 누가 언제 동의했는지가 곧 근거다.
 */
export async function markPrivacyAgreed(id: string): Promise<string | null> {
  if (!(await hasPrivacyColumn())) return null;
  const { data, error } = await getClient()
    .from("staff")
    .update({ privacy_agreed_at: new Date().toISOString() })
    .eq("id", id)
    .is("privacy_agreed_at", null)
    .select("id, name, privacy_agreed_at");
  if (error) {
    throw new Error(`동의 기록 실패: ${error.message}`);
  }
  const row = (data ?? [])[0] as
    | { id: string; name: string; privacy_agreed_at: string }
    | undefined;
  if (!row) return await getPrivacyAgreedAt(id) ?? null;
  await recordAudit({
    action: "update",
    table_name: "staff",
    record_id: row.id,
    summary: `개인정보 처리 동의 — ${row.name}`,
    before: { privacy_agreed_at: null },
    after: { privacy_agreed_at: row.privacy_agreed_at },
  });
  return row.privacy_agreed_at;
}
