/**
 * 최초 부팅 — 요청 본문을 "누구를 관리자로" 로 읽는다(저장·검사는 api/auth.ts)
 *
 * 두 갈래:
 *   pick  명단에 이미 있는 사람을 고른다        { staff_id, password }
 *   new   명단이 비었을 때 첫 종사자를 직접 넣는다 { name, role, password }
 * 어느 갈래든 서버의 부팅 이중 잠금(bootstrap_done · 비밀번호 계정)을 똑같이 지난다.
 */

/** 최초 관리자로 고를 수 있는 직급. 화면 후보·직접 입력·서버 검사가 같은 목록을 쓴다. */
export const BOOTSTRAP_ROLES = ["센터장", "생활복지사"] as const;
export type BootstrapRole = typeof BOOTSTRAP_ROLES[number];

/** 감사 로그의 "누가" — 로그인 전 부팅 화면에서 한 일 */
export const BOOT_ACTOR = "최초 부팅";

export const BOOT_NAME_MAX = 100;

export type BootstrapChoice =
  | { kind: "pick"; staffId: string }
  | { kind: "new"; name: string; role: BootstrapRole };

const clean = (value: unknown, max: number) =>
  typeof value === "string" ? value.trim().slice(0, max + 1) : "";

/** 본문 → 갈래. 모양이 틀리면 사람이 읽을 문장(string)을 돌려준다. 둘 다 오면 받지 않는다. */
export function parseBootstrapChoice(body: Record<string, unknown>): BootstrapChoice | string {
  const staffId = clean(body.staff_id, 100);
  const name = clean(body.name, BOOT_NAME_MAX);
  const role = clean(body.role, 20);

  if (staffId && (name || role)) return "명단에서 고르거나 새로 넣거나, 한 가지만 해 주세요.";
  if (staffId) return { kind: "pick", staffId };
  if (!name && !role) return "사람과 비밀번호를 골라 주세요.";
  if (!name) return "첫 종사자의 이름을 넣어 주세요.";
  if (name.length > BOOT_NAME_MAX) return `이름은 ${BOOT_NAME_MAX}자를 넘을 수 없습니다.`;
  if (!(BOOTSTRAP_ROLES as readonly string[]).includes(role)) {
    return "최초 관리자는 센터장·생활복지사 중에서 고릅니다.";
  }
  return { kind: "new", name, role: role as BootstrapRole };
}
