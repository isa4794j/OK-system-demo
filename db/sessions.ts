/**
 * 세션(sessions) 데이터 접근 — 로그인한 기기 하나가 한 줄
 *
 * 규칙: Supabase 호출은 /db 안에서만 한다.
 *
 * [토큰 원문은 여기 없다]
 * 쿠키에만 있고 표에는 SHA-256 만 둔다. DB 를 통째로 보더라도
 * 그것으로 남의 세션을 흉내 낼 수 없다.
 *
 * [만료를 두 가지로 본다]
 *   쉬는 시간 8시간   last_seen_at 기준. 요청할 때마다 민다.
 *   절대   30일       expires_at 기준. 아무리 써도 안 밀린다.
 * 한 칸으로 합치면 "매일 쓰면 영원히 안 끊기는" 세션이 된다.
 * 공용 PC 를 쓰는 자리라 8시간이 하루 근무와 맞는다 — 아침에 로그인하면
 * 그날은 쭉 쓰고, 다음 날 아침엔 다시 로그인한다.
 */
import { getClient } from "./client.ts";
import { hashToken, makeSessionToken } from "../lib/password.ts";

/** 쉬는 시간 만료. 이만큼 아무 요청이 없으면 끊는다. */
export const IDLE_MS = 8 * 60 * 60 * 1000;

/** 절대 만료. 계속 써도 이만큼 지나면 끊는다. */
export const ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;

export type SessionRow = {
  id: string;
  staff_id: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  user_agent: string | null;
  /** 겸직자가 이 기기에서 지금 활동 중인 역할(029). 역할이 하나면 비어 있다 */
  active_role: string | null;
};

const COLUMNS = "id, staff_id, created_at, last_seen_at, expires_at, user_agent, active_role";

/**
 * 세션을 하나 만든다. 토큰 원문을 돌려주는 것은 이때뿐이다 —
 * 부르는 쪽이 쿠키에 담고 나면 아무도 다시 볼 수 없다.
 */
export async function createSession(
  staffId: string,
  userAgent: string | null,
): Promise<{ token: string; expiresAt: Date }> {
  const token = makeSessionToken();
  const expiresAt = new Date(Date.now() + ABSOLUTE_MS);

  const { error } = await getClient()
    .from("sessions")
    .insert({
      staff_id: staffId,
      token_hash: await hashToken(token),
      expires_at: expiresAt.toISOString(),
      // 긴 문자열이 그대로 들어오는 자리라 잘라 둔다. 판단에 쓰지 않는 값이다.
      user_agent: userAgent?.slice(0, 300) ?? null,
    });

  if (error) {
    throw new Error(`세션 생성 실패: ${error.message}`);
  }
  return { token, expiresAt };
}

/**
 * 토큰으로 세션을 찾는다. 없거나 만료됐으면 null.
 *
 * 만료된 줄은 찾은 김에 지운다. 따로 청소하는 일을 만들지 않으려는 것이다.
 * 지우기에 실패해도 null 을 돌려주므로 판단은 이미 맞다 — 로그만 남긴다.
 */
export async function findSession(token: string): Promise<SessionRow | null> {
  const { data, error } = await getClient()
    .from("sessions")
    .select(COLUMNS)
    .eq("token_hash", await hashToken(token))
    .maybeSingle();

  if (error) {
    throw new Error(`세션 조회 실패: ${error.message}`);
  }
  const session = data as SessionRow | null;
  if (!session) return null;

  const now = Date.now();
  const idleOut = now - new Date(session.last_seen_at).getTime() > IDLE_MS;
  const absoluteOut = now > new Date(session.expires_at).getTime();

  if (idleOut || absoluteOut) {
    await deleteSessionById(session.id).catch((error) => console.error("[findSession]", error));
    return null;
  }
  return session;
}

/**
 * 겸직자가 고른 역할을 이 세션에 적는다. 역할이 목록 안인지는 부르는 쪽이 본다.
 * 세션에 두는 이유: 같은 사람이라도 기기마다(오늘 폰은 멘토로) 다를 수 있고,
 * URL·저장값에 두면 남이 바꿔 넣을 수 있다.
 */
export async function setActiveRole(sessionId: string, role: string): Promise<void> {
  const { error } = await getClient()
    .from("sessions")
    .update({ active_role: role })
    .eq("id", sessionId);
  if (error) throw new Error(`역할 전환 실패: ${error.message}`);
}

/**
 * 마지막으로 쓴 시각을 민다. 쉬는 시간 만료를 재는 자리다.
 *
 * 요청마다 도는 쓰기라 실패해도 요청을 막지 않는다 —
 * 최악이라도 세션이 조금 일찍 끊길 뿐이고, 그건 안전한 쪽이다.
 */
export async function touchSession(id: string): Promise<void> {
  const { error } = await getClient()
    .from("sessions")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("id", id);

  if (error) console.error("[touchSession]", error.message);
}

async function deleteSessionById(id: string): Promise<void> {
  const { error } = await getClient().from("sessions").delete().eq("id", id);
  if (error) throw new Error(`세션 삭제 실패: ${error.message}`);
}

/** 로그아웃. 토큰이 가리키는 세션 하나만 지운다 — 다른 기기는 그대로 둔다. */
export async function deleteSessionByToken(token: string): Promise<void> {
  const { error } = await getClient()
    .from("sessions")
    .delete()
    .eq("token_hash", await hashToken(token));

  if (error) throw new Error(`세션 삭제 실패: ${error.message}`);
}

/**
 * 그 사람의 세션을 전부 지운다. 계정을 정지하거나 비번을 다시 정할 때 부른다.
 * 정지시켰는데 열려 있던 창이 계속 도는 일이 없어야 한다.
 */
export async function deleteSessionsOfStaff(staffId: string): Promise<number> {
  const { data, error } = await getClient()
    .from("sessions")
    .delete()
    .eq("staff_id", staffId)
    .select("id");

  if (error) throw new Error(`세션 정리 실패: ${error.message}`);
  return (data ?? []).length;
}

/** 그 사람이 열어 둔 세션이 몇 개인지. 계정 관리 화면에 적는다. */
export async function countSessionsByStaff(): Promise<Map<string, number>> {
  const { data, error } = await getClient()
    .from("sessions")
    .select("staff_id")
    .gt("expires_at", new Date().toISOString());

  if (error) throw new Error(`세션 수 조회 실패: ${error.message}`);

  const counts = new Map<string, number>();
  for (const row of (data ?? []) as { staff_id: string }[]) {
    counts.set(row.staff_id, (counts.get(row.staff_id) ?? 0) + 1);
  }
  return counts;
}
