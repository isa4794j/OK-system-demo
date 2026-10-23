/**
 * 문의(inquiries) 데이터 접근 — 봉사자가 폰에서 보내는 불편사항
 *
 * 규칙: Supabase 호출은 /db 안에서만 한다.
 *
 * 답장 기능은 없다. 주고받기 시작하면 메신저를 만들게 되고, 그건 이 시스템의 일이 아니다.
 * 종사자가 PC 에서 목록을 보고 [확인함] 을 누르는 것까지다.
 *
 * 보낸 시점의 이름을 함께 담는다. 명단에서 사람이 사라져도(staff_id 가 null 이 되어도)
 * 아직 안 고친 불편이 누구 것인지 남아야 한다.
 */
import { getClient, NotFoundError } from "./client.ts";

export type Inquiry = {
  id: string;
  staff_id: string | null;
  staff_name: string | null;
  /** 보낼 때의 역할(029) */
  as_role: string | null;
  content: string;
  seen_at: string | null;
  seen_by: string | null;
  created_at: string;
};

// deno-fmt-ignore
const COLUMNS = "id, staff_id, staff_name, as_role, content, seen_at, seen_by, created_at";

/** 한 화면에 담는 상한. 문의는 많아야 수십 건이라 이 위로 갈 일이 드물다. */
const LIMIT = 200;

export async function addInquiry(
  staffId: string,
  staffName: string | null,
  content: string,
  asRole: string | null,
): Promise<Inquiry> {
  const { data, error } = await getClient()
    .from("inquiries")
    // as_role: 보낼 때의 역할(029). 겸직자가 어느 역할로 물었는지 남긴다
    .insert({ staff_id: staffId, staff_name: staffName, content, as_role: asRole })
    .select(COLUMNS)
    .single();

  if (error) {
    throw new Error(`문의 저장 실패: ${error.message}`);
  }
  return data as Inquiry;
}

/** 전체 목록. PC 의 문의함이 쓴다. 새것이 위로 온다. */
export async function listInquiries(): Promise<Inquiry[]> {
  const { data, error } = await getClient()
    .from("inquiries")
    .select(COLUMNS)
    .order("created_at", { ascending: false })
    .limit(LIMIT);

  if (error) {
    throw new Error(`문의 조회 실패: ${error.message}`);
  }
  return (data ?? []) as Inquiry[];
}

/** 내가 보낸 것만. 폰에서 "보낸 것이 읽혔나" 를 보는 자리. */
export async function listInquiriesBy(staffId: string): Promise<Inquiry[]> {
  const { data, error } = await getClient()
    .from("inquiries")
    .select(COLUMNS)
    .eq("staff_id", staffId)
    .order("created_at", { ascending: false })
    .limit(LIMIT);

  if (error) {
    throw new Error(`문의 조회 실패: ${error.message}`);
  }
  return (data ?? []) as Inquiry[];
}

/** 안 읽은 건수. 서브탭 뱃지가 쓴다(미분류함과 같은 방식). */
export async function countUnseenInquiries(): Promise<number> {
  const { count, error } = await getClient()
    .from("inquiries")
    .select("id", { count: "exact", head: true })
    .is("seen_at", null);

  if (error) {
    throw new Error(`문의 건수 조회 실패: ${error.message}`);
  }
  return count ?? 0;
}

/**
 * 봤다고 표시한다. 이미 본 것은 그대로 둔다 —
 * 처음 본 사람과 시각이 남아야 "언제부터 알고 있었나" 가 맞다.
 */
export async function markInquirySeen(id: string, byId: string): Promise<void> {
  const { count, error: findError } = await getClient()
    .from("inquiries")
    .select("id", { count: "exact", head: true })
    .eq("id", id);
  if (findError) throw new Error(`문의 확인 실패: ${findError.message}`);
  if (!count) throw new NotFoundError("그 문의를 찾지 못했습니다.");

  const { error } = await getClient()
    .from("inquiries")
    .update({ seen_at: new Date().toISOString(), seen_by: byId })
    .eq("id", id)
    .is("seen_at", null);

  if (error) {
    throw new Error(`문의 확인 표시 실패: ${error.message}`);
  }
}
