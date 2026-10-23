/**
 * 직원(staff) 데이터 접근 — 멘토 / 봉사자 / 센터장 / 생활복지사
 *
 * 규칙: Supabase 호출은 /db 안에서만 한다.
 *
 * children_identity와 달리 신원을 분리하지 않는다.
 * 성인이고, 일지의 작성자로 이름이 드러나는 게 정상이기 때문.
 */
import { getClient, NotFoundError, RuleError, writeError } from "./client.ts";
import { recordAudit, snapshotRow, snapshotRows } from "./audit.ts";
import { guessAccessKind, primaryRole } from "../lib/permission.ts";

/** DB의 CHECK 제약과 같은 목록이어야 한다 (014). */
export const ROLES = ["멘토", "봉사자", "센터장", "생활복지사"] as const;
export const STAFF_STATUSES = ["활동중", "종료"] as const;

/** 등록하려는 이름을 다른 사람이 로그인 이름으로 쥐고 있다 */
export class LoginNameTakenError extends Error {}

export type Role = (typeof ROLES)[number];
export type StaffStatus = (typeof STAFF_STATUSES)[number];

export type StaffListItem = {
  id: string;
  name: string;
  /** 대표 역할(등급이 가장 높은 것). 호환용 — 새 코드는 roles 를 본다 */
  role: Role | null;
  /** 역할 목록(겸직이면 둘 이상, 029) */
  roles: Role[];
  status: StaffStatus;
  phone: string | null;
  color_index: number | null;
  /** 화면이 관리자 행의 수정·삭제 버튼을 숨기는 데만 쓴다. 막는 것은 서버다. */
  is_admin: boolean;
};

const COLUMNS = "id, name, role, roles, status, phone, color_index, is_admin";

/**
 * 직원 목록을 이름순으로 읽어온다.
 *
 * role 은 하나 또는 여럿을 줄 수 있다. 주지 않으면 전체를 돌려준다.
 * status는 기본이 '활동중'이다. 작성자 드롭다운처럼 "지금 고를 수 있는 사람"을
 * 뽑는 용도가 대부분이기 때문. 그만둔 사람까지 필요하면 status를 넘긴다.
 * (이미 쓴 일지의 작성자 이름은 조인해서 가져오므로 여기서 빠져도 그대로 보인다)
 */
export async function listStaff(
  role?: Role | Role[] | null,
  status: StaffStatus | null = "활동중",
): Promise<StaffListItem[]> {
  let query = getClient().from("staff").select(COLUMNS);

  // 역할은 하나만 줄 수도, 여럿을 줄 수도 있다.
  // 멘토+봉사자 명단처럼 두 역할을 한 화면에서 보는 곳이 있기 때문.
  // 역할 목록(roles)과 겹치면 나온다 — 겸직자는 해당하는 명단마다 나온다.
  const wanted = Array.isArray(role) ? role : role ? [role] : [];
  if (wanted.length > 0) query = query.overlaps("roles", wanted);

  if (status) query = query.eq("status", status);

  const { data, error } = await query.order("name", { ascending: true });

  if (error) {
    throw new Error(`직원 목록 조회 실패: ${error.message}`);
  }
  return (data ?? []) as StaffListItem[];
}

/**
 * 이름에 이 글자가 들어간 직원 id(상태 무관 — 그만둔 사람의 옛 일지도 찾아야 한다).
 * 일지 목록의 "이름 검색" 이 쓴다. %·_ 는 글자 그대로 찾는다.
 */
export async function findStaffIdsByName(text: string): Promise<string[]> {
  const escaped = text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  const { data, error } = await getClient()
    .from("staff")
    .select("id")
    .ilike("name", `%${escaped}%`)
    .limit(500);

  if (error) {
    throw new Error(`이름 검색 실패: ${error.message}`);
  }
  return (data ?? []).map((row) => row.id as string);
}

/**
 * 새 직원을 등록한다. 상태는 늘 '활동중'으로 시작한다.
 *
 * 계정 칸도 함께 채운다. 로그인 이름은 이름과 같게, 접속 권한은 직급으로 추정해서.
 * 비밀번호도 초대코드도 넣지 않는다 — 계정은 사람이 [코드 발급]을 눌러야 열린다.
 * 이름이 겹치면 DB 의 유일 인덱스가 막는다. 그때는 계정 관리 화면에서 고친다.
 */
export async function addStaff(
  name: string,
  roles: Role[],
  phone: string | null,
): Promise<StaffListItem> {
  const { data, error } = await getClient()
    .from("staff")
    .insert({
      name,
      roles,
      // 호환용 대표 역할. roles 와 늘 함께 쓴다
      role: primaryRole(roles),
      phone,
      status: "활동중",
      login_name: name.trim(),
      access_kind: guessAccessKind(roles),
    })
    .select(COLUMNS)
    .single();

  if (error) {
    if (/duplicate key|idx_staff_login_name_unique|23505/i.test(error.message)) {
      throw new LoginNameTakenError(
        `"${name}" 은(는) 이미 명단에 있습니다. 다른 이름으로 등록해 주세요 ` +
          "(동명이인이면 이름 뒤에 구분 글자를 붙여 주세요).",
      );
    }
    throw new Error(`직원 등록 실패: ${error.message}`);
  }
  const created = data as StaffListItem;
  await recordAudit({
    action: "create",
    table_name: "staff",
    record_id: created.id,
    summary: `직원 등록 — ${created.name} (${created.roles.join("·") || "역할 없음"})`,
    after: created,
  });
  return created;
}

/**
 * 직원 정보를 고친다. 넘긴 항목만 바꾼다.
 *
 * 그만둔 사람은 지우지 않고 status 를 '종료'로 바꾼다.
 * 지우면 그 사람이 쓴 일지의 작성자가 비어 버린다.
 */
/**
 * 직원에 딸린 기록의 수. 삭제 확인창에 적는다.
 *
 *   journals         이 사람이 작성자인 일지
 *   linked_journals  이 사람의 일정에 매인 일지(봉사일지). 작성자가 달라도 센다
 *   schedules        이 사람의 일정
 */
export type StaffRecordCounts = { journals: number; linked_journals: number; schedules: number };

export async function countStaffRecords(staffId: string): Promise<StaffRecordCounts> {
  const client = getClient();
  const [journals, linked, schedules] = await Promise.all([
    client.from("journals").select("id", { count: "exact", head: true }).eq("author_id", staffId),
    // 일정을 거쳐 이 사람에게 매인 일지. 일정 id 목록을 주소에 싣지 않게 조인으로 센다.
    client.from("journals")
      .select("id, schedules!inner(staff_id)", { count: "exact", head: true })
      .eq("schedules.staff_id", staffId),
    client.from("schedules").select("id", { count: "exact", head: true }).eq("staff_id", staffId),
  ]);
  if (journals.error) throw new Error(`일지 건수 확인 실패: ${journals.error.message}`);
  if (linked.error) throw new Error(`일정에 매인 일지 확인 실패: ${linked.error.message}`);
  if (schedules.error) throw new Error(`일정 건수 확인 실패: ${schedules.error.message}`);
  return {
    journals: journals.count ?? 0,
    linked_journals: linked.count ?? 0,
    schedules: schedules.count ?? 0,
  };
}

/**
 * 감사 로그에 절대 싣지 않는 칸. 로그를 읽을 수 있는 사람이 계정을 열 수 있게 되면 안 된다.
 * 계정 수정 기록(db/accounts.ts)은 필요한 칸만 골라 싣는다 — 삭제 기록도 같은 선을 지킨다.
 */
const SECRET_KEYS = ["password_hash", "invite_code_hash"];

/** 직원 행에서 비밀 칸을 뺀다. 감사 로그 before 에 싣기 전에 거친다. */
export function withoutSecrets(
  row: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!row) return row;
  return Object.fromEntries(Object.entries(row).filter(([key]) => !SECRET_KEYS.includes(key)));
}

/** 한 사람의 역할 목록과 상태. 없으면 null */
export async function getStaffRoles(
  id: string,
): Promise<{ roles: Role[]; status: StaffStatus; name: string } | null> {
  const { data, error } = await getClient()
    .from("staff")
    .select("roles, status, name")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`직원 조회 실패: ${error.message}`);
  return data as { roles: Role[]; status: StaffStatus; name: string } | null;
}

/**
 * 역할마다 남긴 기록 수(일정·일지·문의의 as_role 기준).
 * 겸직에서 역할을 뺄 때 "그 역할로 남긴 기록이 N건" 을 알리는 데 쓴다. 기록은 지우지 않는다.
 */
export async function countRecordsByRole(
  staffId: string,
): Promise<Record<string, { schedules: number; journals: number; inquiries: number }>> {
  const client = getClient();
  const [schedules, journals, inquiries] = await Promise.all([
    client.from("schedules").select("as_role").eq("staff_id", staffId),
    client.from("journals").select("as_role").eq("author_id", staffId),
    client.from("inquiries").select("as_role").eq("staff_id", staffId),
  ]);
  for (const one of [schedules, journals, inquiries]) {
    if (one.error) throw new Error(`역할별 기록 수 확인 실패: ${one.error.message}`);
  }
  const out: Record<string, { schedules: number; journals: number; inquiries: number }> = {};
  const bump = (role: string | null, key: "schedules" | "journals" | "inquiries") => {
    if (!role) return;
    out[role] ??= { schedules: 0, journals: 0, inquiries: 0 };
    out[role][key] += 1;
  };
  for (const row of schedules.data ?? []) bump(row.as_role, "schedules");
  for (const row of journals.data ?? []) bump(row.as_role, "journals");
  for (const row of inquiries.data ?? []) bump(row.as_role, "inquiries");
  return out;
}

/** 일지가 한 건이라도 있으면 지울 수 없다. 화면 안내와 같은 문장이다. */
export const STAFF_HAS_JOURNALS =
  "일지가 있어 삭제할 수 없어요. 그만둔 경우 [종료로 변경]을 눌러 주세요 — 기록이 남고 로그인이 막힙니다.";

/**
 * 직원을 지운다. 지우기 전의 딸린 건수를 돌려준다.
 *
 * [일지가 있으면 지우지 않는다]
 * 봉사일지는 일정에 매여 있고(journals.schedule_id, restrict), 일정은 직원과 함께
 * 사라지려 한다(cascade). 그래서 봉사일지가 있는 사람은 DB 가 삭제를 막는다.
 * 종사자 일지는 작성자만 비고 남지만(set null), 누가 쓴 기록인지 잃는다.
 * 두 경우 모두 "지우지 말고 종료" 가 맞다 — 여기서 먼저 막아 안내와 동작을 맞춘다.
 *
 * 일지가 없으면 일정·세션은 외래키가 함께 지운다(cascade).
 */
export async function deleteStaff(staffId: string): Promise<StaffRecordCounts> {
  if (!(await getStaffRoles(staffId))) {
    throw new NotFoundError("그 사람을 찾지 못했습니다. 이미 지워졌을 수 있어요.");
  }
  const counts = await countStaffRecords(staffId);
  if (counts.journals > 0 || counts.linked_journals > 0) throw new RuleError(STAFF_HAS_JOURNALS);

  // 일정은 cascade 로 따라 사라진다. 그것도 before 에 담는다.
  const [person, schedules] = await Promise.all([
    snapshotRow("staff", staffId),
    snapshotRows("schedules", "staff_id", staffId),
  ]);

  const { error } = await getClient()
    .from("staff")
    .delete()
    .eq("id", staffId);

  if (error) {
    throw new Error(`직원 삭제 실패: ${error.message}`);
  }

  await recordAudit({
    action: "delete",
    table_name: "staff",
    record_id: staffId,
    summary: `직원 ${person?.name ?? "(이름 없음)"} 삭제 — 일정 ${counts.schedules}건 함께`,
    before: { staff: withoutSecrets(person), schedules },
  });
  return counts;
}

/**
 * 직원을 고친다.
 *
 * 역할이나 상태가 바뀌면 감사 로그에 남긴다. 역할은 곧 등급이고(센터장·종사자·봉사),
 * 종료는 로그인을 막는다 — 둘 다 "주요 수정" 이다. 이름·전화만 바꾼 것은 남기지 않는다.
 * 계정 칸(해시 등)은 읽지도 싣지도 않는다.
 */
export async function updateStaff(
  id: string,
  patch: { name?: string; roles?: Role[]; phone?: string | null; status?: StaffStatus },
): Promise<StaffListItem> {
  const changes: Record<string, unknown> = {};
  if (patch.name !== undefined) changes.name = patch.name;
  if (patch.roles !== undefined) {
    changes.roles = patch.roles;
    changes.role = primaryRole(patch.roles);
  }
  if (patch.phone !== undefined) changes.phone = patch.phone;
  if (patch.status !== undefined) changes.status = patch.status;

  if (Object.keys(changes).length === 0) {
    throw new Error("바꿀 내용이 없습니다.");
  }

  const client = getClient();
  const { data: before, error: readError } = await client
    .from("staff")
    .select(COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (readError) throw new Error(`직원 읽기 실패: ${readError.message}`);

  const { data, error } = await client
    .from("staff")
    .update(changes)
    .eq("id", id)
    .select(COLUMNS)
    .single();

  if (error) {
    throw writeError(
      error,
      "직원 수정 실패",
      "그 사람을 찾지 못했습니다. 이미 지워졌을 수 있어요.",
    );
  }
  const after = data as StaffListItem;
  const old = before as StaffListItem | null;

  const rolesText = (list: readonly string[] | undefined) => list?.join("·") || "없음";
  const roleChanged = old !== null && rolesText(old.roles) !== rolesText(after.roles);
  const statusChanged = old !== null && old.status !== after.status;
  if (roleChanged || statusChanged) {
    const what = [
      roleChanged ? `역할 ${rolesText(old?.roles)} → ${rolesText(after.roles)}` : "",
      statusChanged ? `상태 ${old?.status} → ${after.status}` : "",
    ].filter(Boolean).join(", ");
    await recordAudit({
      action: "update",
      table_name: "staff",
      record_id: id,
      summary: `직원 수정 — ${after.name} (${what})`,
      before: { name: old?.name, roles: old?.roles, status: old?.status },
      after: { name: after.name, roles: after.roles, status: after.status },
    });
  }
  return after;
}
