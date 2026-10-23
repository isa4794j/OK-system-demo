/**
 * 권한 등급과 계정 상태 — 저장된 값에서 계산해 낸다
 *
 * 이 파일은 아무것도 import 하지 않는다. 값을 받아 값을 돌려주는 함수만 둔다.
 * 서버(api·db)와 화면이 같은 답을 봐야 하는데 화면은 /db 를 못 부르므로,
 * 서버가 계산해서 API 응답에 실어 보낸다.
 *
 * [등급을 컬럼으로 저장하지 않는 이유]
 * 등급은 직급(role)과 관리자 깃발(is_admin)에서 나온다. 따로 저장하면
 * 직급을 바꿨는데 등급은 그대로인 어긋남이 생기고, 그 어긋남은 조용하다.
 * 계산이 한 줄이면 계산하는 편이 맞다.
 *
 * [세 축은 서로 다른 일을 한다]
 *   직급(roles)        무슨 일을 하는 사람인가 — 여러 개일 수 있다(겸직, 029)
 *   관리자 깃발(is_admin)  설정과 계정 발급을 만질 수 있는가
 *   접속 권한(access_kind) PC 화면인가 모바일 화면인가
 * 등급은 앞의 둘에서 나오고, 접속 권한은 등급과 직교한다.
 * "생활복지사인데 모바일만" 같은 조합이 가능해야 축을 나눈 뜻이 산다.
 */

/** 높을수록 많이 할 수 있다. 관문(4단계)이 이 수를 견준다. */
export const LEVELS = ["봉사", "종사자", "센터장", "관리자"] as const;
export type Level = (typeof LEVELS)[number];

export const ACCESS_KINDS = ["PC", "모바일"] as const;
export type AccessKind = (typeof ACCESS_KINDS)[number];

/** DB 에 저장하는 두 값. 사람이 막았는가만 담는다. */
export const ACCOUNT_STATUSES = ["활성", "정지"] as const;

/** 화면에 보이는 네 가지. 저장된 값에서 나온다. */
export const ACCOUNT_STATES = ["미발급", "대기", "활성", "정지"] as const;
export type AccountState = (typeof ACCOUNT_STATES)[number];

/** 역할 네 가지. 앞에 있을수록 등급이 높다(대표 역할을 고를 때 이 순서). */
export const ROLE_ORDER = ["센터장", "생활복지사", "멘토", "봉사자"] as const;
export type RoleName = (typeof ROLE_ORDER)[number];

/** 봉사자 폰에서 쓰는 역할. 겸직 전환은 이 안에서 의미가 있다. */
export const VOLUNTEER_ROLE_NAMES: readonly string[] = ["멘토", "봉사자"];

/**
 * 받은 역할 목록을 정리한다 — 모르는 값은 버리고, 겹친 것은 하나로, 등급 순서로.
 * 비면 빈 목록이다(직급 없음).
 */
export function normalizeRoles(list: readonly unknown[]): RoleName[] {
  const set = new Set(list.filter((one): one is string => typeof one === "string"));
  return ROLE_ORDER.filter((role) => set.has(role));
}

/** 대표 역할 — 등급이 가장 높은 것. 호환용 staff.role 에 쓴다. */
export function primaryRole(roles: readonly string[]): RoleName | null {
  return ROLE_ORDER.find((role) => roles.includes(role)) ?? null;
}

/**
 * 지금 활동 중인 역할.
 *   역할이 하나  → 그 역할(고를 것이 없다 — 겸직이 아닌 사람은 예전과 똑같다)
 *   겸직         → 세션에 고른 역할(목록 안에 있을 때만). 아직 안 골랐으면 null
 */
export function effectiveRole(roles: readonly string[], active: string | null): string | null {
  if (roles.length === 1) return roles[0];
  if (active && roles.includes(active)) return active;
  return null;
}

/**
 * 남이 대신 기록을 만들 때(PC 에서 일정 등록 등) 그 기록의 역할을 정한다.
 *   고른 역할이 있으면 → 그 사람의 역할 중 하나여야 한다
 *   안 골랐으면       → 역할이 하나일 때만 그 역할. 겸직이면 골라야 한다
 * 정할 수 없으면 사람이 읽을 이유를 돌려준다.
 */
export function chooseAsRole(
  roles: readonly string[],
  requested: unknown,
): { role: string } | { error: string } {
  if (typeof requested === "string" && requested.trim()) {
    const role = requested.trim();
    return roles.includes(role) ? { role } : { error: `그 사람의 역할이 아닙니다: ${role}` };
  }
  if (roles.length === 1) return { role: roles[0] };
  if (roles.length === 0) {
    return { error: "역할이 없는 사람입니다. 명단에서 역할을 먼저 정해 주세요." };
  }
  return { error: `겸직(${roles.join("·")})인 사람은 어느 역할 활동인지 골라 주세요.` };
}

/** 등급을 정하는 데 필요한 것만. staff 행의 일부다. */
export type LevelSource = {
  roles: readonly string[];
  is_admin: boolean;
};

/** 계정 상태를 정하는 데 필요한 것만. */
export type StateSource = {
  password_hash: string | null;
  invite_code_hash: string | null;
  account_status: string;
  /** 명단에서의 상태. '종료' 면 계정과 무관하게 못 들어온다. */
  status: string;
};

/**
 * 등급.
 *
 *   관리자   깃발이 붙은 사람. 직급이 무엇이든.
 *   센터장   역할에 센터장이 있으면
 *   종사자   역할에 생활복지사가 있으면
 *   봉사     멘토·봉사자, 그리고 직급을 모르는 사람
 *
 * 겸직이면 가장 높은 역할이 등급이다(멘토·봉사자는 같은 등급이라 둘을 겸해도 그대로).
 * 직급이 비어 있으면 가장 좁은 등급으로 떨어뜨린다. 모를 때는 적게 여는 쪽이 맞다.
 */
export function levelOf(staff: LevelSource): Level {
  if (staff.is_admin) return "관리자";
  if (staff.roles.includes("센터장")) return "센터장";
  if (staff.roles.includes("생활복지사")) return "종사자";
  return "봉사";
}

/** have 가 need 만큼 되는가. 관문이 쓴다. */
export function atLeast(have: Level, need: Level): boolean {
  return LEVELS.indexOf(have) >= LEVELS.indexOf(need);
}

/**
 * 화면에 보여 줄 계정 상태.
 *
 * 순서가 중요하다. '정지' 와 명단 '종료' 가 나머지를 이긴다 —
 * 비번이 있어도 못 들어오는데 "활성" 이라고 적으면 화면이 거짓말을 한다.
 */
export function accountStateOf(staff: StateSource): AccountState {
  if (staff.status === "종료") return "정지";
  if (staff.account_status === "정지") return "정지";
  if (staff.password_hash) return "활성";
  if (staff.invite_code_hash) return "대기";
  return "미발급";
}

/**
 * 지금 로그인할 수 있는 계정인가. 이유가 있으면 그 이유를, 없으면 null.
 *
 * 화면에 그대로 띄우지 않는다 — "비번을 아직 안 정했다" 같은 말은
 * 그 이름의 계정이 있다는 사실을 알려 준다. 이 값은 서버가 판단에만 쓰고,
 * 화면에는 "이름이나 비밀번호가 맞지 않습니다" 하나로 답한다.
 */
export function loginBlockedReason(
  staff: StateSource & { locked_until: string | null },
  now = new Date(),
): string | null {
  if (staff.status === "종료") return "명단에서 종료된 사람";
  if (staff.account_status === "정지") return "정지된 계정";
  if (!staff.password_hash) return "비밀번호 미설정";
  if (staff.locked_until && new Date(staff.locked_until) > now) return "잠긴 계정";
  return null;
}

/**
 * 직급으로 접속 권한을 추정한다. 등록할 때 기본값으로 쓰고, 사람이 고칠 수 있다.
 * 종사자 역할이 하나라도 있으면 PC, 멘토·봉사자뿐이면 모바일.
 */
export function guessAccessKind(roles: readonly string[]): AccessKind {
  return roles.length > 0 && roles.every((role) => VOLUNTEER_ROLE_NAMES.includes(role))
    ? "모바일"
    : "PC";
}
