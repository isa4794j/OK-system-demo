/**
 * 아동(children_identity) 데이터 접근
 *
 * 규칙: Supabase 호출은 /db 안에서만 한다.
 *       /api 와 /web 은 이 파일이 내보낸 함수만 사용한다.
 *
 * ★ 민감정보
 * 이 표에는 보호자 연락처·주소·의뢰배경이 있다. 명단(listChildren)은 그 칸을
 * 읽지 않고, 상세(getChild)만 읽는다.
 *
 * 열람 권한은 종사자 이상이 설계다(정책표 /api/children). 센터 안의 사람은 아이를
 * 알아야 일한다. 막는 선은 "센터 밖" 이다 — AI·외부로 나가는 글은 가명화한다(lib/ai.ts).
 */
import { getClient, RuleError, writeError } from "./client.ts";
import { recordAudit, snapshotRow, snapshotRows } from "./audit.ts";
import { sortChildren } from "../lib/child_order.ts";

/** DB의 CHECK 제약과 같은 목록이어야 한다. */
export const CHILD_STATUSES = ["재원", "종결"] as const;
export const GENDERS = ["남", "여"] as const;

export type ChildStatus = (typeof CHILD_STATUSES)[number];
export type Gender = (typeof GENDERS)[number];

/** 명단 화면에 필요한 최소 필드. 이름 외 민감정보는 여기서 내보내지 않는다. */
export type ChildListItem = {
  id: string;
  name: string;
  birth_date: string | null; // "YYYY-MM-DD"
  gender: Gender | null;
  status: ChildStatus;
  /** 명단이 "오늘 기준 재원인지"를 가리려면 날짜가 필요하다. 민감정보는 아니다. */
  enroll_date: string | null;
  exit_date: string | null;
};

/**
 * 상세·수정 화면이 쓰는 전체 필드.
 * ★ guardian_contact·address·referral_note 는 민감정보다. 명단에는 절대 싣지 않는다.
 */
export type ChildDetail = ChildListItem & {
  school: string | null;
  enroll_date: string | null;
  exit_date: string | null;
  guardian_relation: string | null;
  guardian_contact: string | null;
  address: string | null;
  referral_note: string | null;
  /** 개인정보 동의서를 받은 날(034) — 기록만 한다. 034 전 DB 에서는 칸이 없다 */
  consent_date?: string | null;
};

/** 고칠 수 있는 칸. id 는 뺀다. */
export type ChildPatch = Partial<Omit<ChildDetail, "id">>;

/** ★ 민감정보 칸. 로그인 뒤 권한을 나눌 때 이 목록을 기준으로 가린다. */
export const SENSITIVE_COLUMNS = ["guardian_contact", "address", "referral_note"] as const;

const LIST_COLUMNS = "id, name, birth_date, gender, status, enroll_date, exit_date";

/** 상세는 전부 읽는다. 민감 칸이 포함되므로 getChild 만 이 목록을 쓴다. */
const DETAIL_COLUMNS =
  "id, name, birth_date, gender, status, school, enroll_date, exit_date, guardian_relation, guardian_contact, address, referral_note";

/**
 * 034(children_identity.consent_date)가 적용됐나 — 한 번 물어 기억한다.
 * 적용 전 DB 에서도 상세·등록·수정이 예전처럼 돈다. 동의일에 값을 넣는 저장만 "034 필요" 로 막는다.
 */
let schema034: boolean | null = null;

export async function hasConsentDate(): Promise<boolean> {
  if (schema034 !== null) return schema034;
  const { error } = await getClient().from("children_identity").select("consent_date").limit(1);
  if (!error) schema034 = true;
  else if (error.code === "42703" || /column .* does not exist/i.test(error.message)) {
    schema034 = false;
  } else throw new Error(`아동 표 확인 실패: ${error.message}`);
  return schema034;
}

export const NEED_034 =
  "동의서 받은 날은 DB 마이그레이션 034 를 적용한 뒤에 적을 수 있습니다. 관리자에게 알려 주세요.";

async function detailColumns(): Promise<string> {
  return (await hasConsentDate()) ? `${DETAIL_COLUMNS}, consent_date` : DETAIL_COLUMNS;
}

/** 034 전 DB 면 동의일 칸을 빼고 보낸다 — 값이 있으면 말없이 버리지 않고 막는다 */
async function fitPatch<T extends ChildPatch>(patch: T): Promise<T> {
  if (!("consent_date" in patch) || (await hasConsentDate())) return patch;
  if (patch.consent_date) throw new RuleError(NEED_034);
  const { consent_date: _drop, ...rest } = patch;
  return rest as T;
}

/**
 * 아동 목록을 학년순(같은 학년 안 가나다)으로 읽어온다 — lib/child_order.ts.
 * 학년은 생년월일에서 세는 값이라 DB 정렬로는 못 한다. 명단은 나눠 받지 않으므로(전체 한 번) 여기서 정렬해도 경계가 없다.
 *
 * 주소·연락처·의뢰배경 같은 민감 컬럼은 select에 넣지 않는다.
 * 명단 화면에 필요 없는 정보는 서버 밖으로 나가지 않게 한다.
 */
export async function listChildren(): Promise<ChildListItem[]> {
  const { data, error } = await getClient()
    .from("children_identity")
    .select(LIST_COLUMNS)
    .order("name", { ascending: true });

  if (error) {
    throw new Error(`아동 목록 조회 실패: ${error.message}`);
  }
  return sortChildren((data ?? []) as ChildListItem[]);
}

/** ★ 민감정보 포함. 아동 하나를 전부 읽는다. 없으면 null. */
export async function getChild(id: string): Promise<ChildDetail | null> {
  const { data, error } = await getClient()
    .from("children_identity")
    .select(await detailColumns())
    .eq("id", id)
    .maybeSingle();

  if (error) {
    throw new Error(`아동 조회 실패: ${error.message}`);
  }
  return (data as unknown as ChildDetail | null) ?? null;
}

export async function addChild(child: ChildPatch & { name: string }): Promise<ChildDetail> {
  const { data, error } = await getClient()
    .from("children_identity")
    .insert(await fitPatch(child))
    .select(await detailColumns())
    .single();

  if (error) {
    throw writeError(error, "아동 등록 실패");
  }
  const created = data as unknown as ChildDetail;
  await recordAudit({
    action: "create",
    table_name: "children_identity",
    record_id: created.id,
    summary: `아동 등록 — ${created.name}`,
    after: created,
  });
  return created;
}

export async function updateChild(id: string, patch: ChildPatch): Promise<ChildDetail> {
  if (Object.keys(patch).length === 0) {
    throw new Error("바꿀 내용이 없습니다.");
  }
  patch = await fitPatch(patch);
  if (Object.keys(patch).length === 0) {
    throw new RuleError("바꿀 내용이 없습니다.");
  }

  // ★ 민감정보 수정은 전후 값을 남긴다
  const before = await snapshotRow("children_identity", id);

  const { data, error } = await getClient()
    .from("children_identity")
    .update(patch)
    .eq("id", id)
    .select(await detailColumns())
    .single();

  if (error) {
    throw writeError(
      error,
      "아동 수정 실패",
      "그 아동을 찾지 못했습니다. 이미 지워졌을 수 있어요.",
    );
  }
  const updated = data as unknown as ChildDetail;
  await recordAudit({
    action: "update",
    table_name: "children_identity",
    record_id: id,
    summary: `아동 수정 — ${updated.name} (${Object.keys(patch).join(", ")})`,
    before,
    after: updated,
  });
  return updated;
}

/** 아동에 딸린 기록의 수. 삭제 확인창에 "N건이 함께 지워집니다"를 적는 데 쓴다. */
export type ChildRecordCounts = {
  observations: number;
  evaluations: number;
  /** 봉사자가 폰에서 쓴 반기 관찰 */
  half_observations: number;
  journal_observations: number;
};

async function countRows(table: string, childId: string): Promise<number> {
  const { count, error } = await getClient()
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("child_id", childId);

  if (error) {
    throw new Error(`${table} 건수 확인 실패: ${error.message}`);
  }
  return count ?? 0;
}

export async function countChildRecords(childId: string): Promise<ChildRecordCounts> {
  const [observations, evaluations, halfObservations, journalObservations] = await Promise.all([
    countRows("observations", childId),
    countRows("yearly_evaluations", childId),
    countRows("half_observations", childId),
    countRows("journal_observations", childId),
  ]);
  return {
    observations,
    evaluations,
    half_observations: halfObservations,
    journal_observations: journalObservations,
  };
}

/**
 * 아동과 딸린 기록을 지운다. 지운 건수를 돌려준다.
 *
 * 외래키가 표마다 다르다.
 *   observations, yearly_evaluations, half_observations → restrict. 먼저 지워야 한다.
 *   journal_observations                                 → cascade. 아동과 함께 사라진다.
 *
 * [한 번에 지운다]
 * 앱에서 차례로 지우면 트랜잭션이 아니라 중간에 막힐 때 앞의 것만 사라진다
 * (반기 관찰을 빠뜨려 관찰·평가만 지워지고 아동 삭제가 실패한 길이 있었다).
 * 그래서 DB 함수 delete_child_cascade(027) 하나로 지운다 — 함수 하나가 트랜잭션 하나다.
 * 실패하면 아무것도 지워지지 않고, 감사 로그도 남기지 않는다(지운 게 없으므로).
 */
export async function deleteChild(childId: string): Promise<ChildRecordCounts> {
  // 지우기 전에 아동과 딸린 기록을 전부 잡아 둔다. 감사 로그 한 줄에 통째로 담는다.
  // 되살릴 때 이 한 줄만 보면 되게 — 관찰이 여기, 평가가 저기 흩어져 있으면 못 찾는다.
  const [child, observations, evaluations, halfObservations, journalObservations] = await Promise
    .all([
      snapshotRow("children_identity", childId),
      snapshotRows("observations", "child_id", childId),
      snapshotRows("yearly_evaluations", "child_id", childId),
      snapshotRows("half_observations", "child_id", childId),
      snapshotRows("journal_observations", "child_id", childId),
    ]);

  const { data, error } = await getClient().rpc("delete_child_cascade", {
    p_child_id: childId,
  });
  if (error) {
    throw new Error(`아동 삭제 실패(아무것도 지우지 않음): ${error.message}`);
  }
  const counts = data as ChildRecordCounts;

  await recordAudit({
    action: "delete",
    table_name: "children_identity",
    record_id: childId,
    summary: `아동 ${child?.name ?? "(이름 없음)"} 삭제 — 관찰 ${counts.observations}건, ` +
      `평가 ${counts.evaluations}건, 반기 관찰 ${counts.half_observations}건, ` +
      `일지관찰 ${counts.journal_observations}건 함께`,
    before: {
      child,
      observations,
      evaluations,
      half_observations: halfObservations,
      journal_observations: journalObservations,
    },
  });
  return counts;
}

/**
 * 반기 관찰 대상. 봉사자 폰 화면이 쓰는 유일한 아동 목록이다.
 *
 * [이름과 생년월일만 나간다]
 * 생년월일은 학년을 세는 데만 쓰고, 성별·학교·보호자·주소·의뢰 사유는 실리지 않는다.
 * 목록 함수(listChildren)를 재활용하지 않고 따로 두는 이유가 여기 있다 —
 * 그쪽에 컬럼이 하나 늘면 폰으로 조용히 새어 나간다.
 * 3단 분리(원칙 5)에서 🔴 을 🟡 쪽으로 흘리지 않으려면 통로가 좁아야 한다.
 *
 * 재원 중인 아이만 준다. 종결일이 아직 안 온 아이는 다니는 것으로 본다
 * (lib/roster.ts 의 isEnrolled 와 같은 규칙).
 */
export async function listChildrenForObservation(): Promise<
  Array<{ id: string; name: string; birth_date: string | null }>
> {
  const { data, error } = await getClient()
    .from("children_identity")
    .select("id, name, birth_date, status, exit_date")
    .order("name", { ascending: true });

  if (error) {
    throw new Error(`아동 목록 조회 실패: ${error.message}`);
  }

  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
  // 폰 반기 명단도 PC 명단과 같은 순서(학년순 → 가나다)
  type Row = {
    id: string;
    name: string;
    birth_date: string | null;
    status: string;
    exit_date: string | null;
  };
  return sortChildren((data ?? []) as unknown as Row[])
    .filter((row) => {
      const one = row as { status: string; exit_date: string | null };
      if (one.status !== "종결") return true;
      return one.exit_date ? one.exit_date > today : false;
    })
    .map((row) => {
      const one = row as { id: string; name: string; birth_date: string | null };
      return { id: one.id, name: one.name, birth_date: one.birth_date };
    });
}
