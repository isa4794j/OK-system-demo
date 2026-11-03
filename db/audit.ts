/**
 * 감사 로그(audit_logs) — 중요한 변경을 "누가·언제·무엇을·어떤 값"으로 남긴다
 *
 * 규칙: Supabase 호출은 /db 안에서만 한다. 그래서 기록 코드도 여기 있다.
 * 다른 /db 파일의 삭제·수정 함수가 이 파일의 recordAudit() 을 부른다.
 * 기록하는 코드가 한 곳에 있어야 "어디서는 남기고 어디서는 안 남기는" 일이 안 생긴다.
 *
 * [무엇을 남기나]
 * [누가]
 * 로그인한 사람의 로그인 이름(login_name)이 들어간다. 화면 이름이 아니다 —
 * 동명이인이 있으면 "김지현" 만으로는 누구인지 알 수 없다.
 * 기계가 한 일은 "시스템/AI", 로그인 없이 온 요청은 "(미로그인)" 이다.
 *
 *   삭제  전부. 아동·직원·일지·관찰·자원·자원기록·도서·일정. before 에 지운 값 통째로.
 *   수정  아동 신원, 연간평가, 관찰 내용·영역, 일지 내용. before/after.
 *         자원·도서 수정, 일정 시각 변경은 안 남긴다 — 가볍고 잦아서 로그가 소음이 된다.
 *   등록  아동·직원만. 나머지 등록은 안 남긴다.
 *
 * [언제 남기나]
 * PostgREST 로는 변경과 기록을 한 트랜잭션에 묶을 수 없다.
 * 그래서 값을 먼저 읽어 두고(snapshot), 변경한 뒤, 곧바로 기록한다.
 * 기록에 실패하면 변경은 이미 끝난 뒤다 — 그때는 남기려던 값을 서버 로그에
 * 통째로 찍고 오류를 던진다. 값이 어디에도 안 남는 일만은 없게.
 *
 * [★ 관리자 전용]
 * before/after 에 민감정보가 그대로 들어간다. 읽는 쪽(listAudit 과 그 API)은
 * 로그인 뒤 관리자만 쓰게 건다.
 */
import { getClient, RuleError } from "./client.ts";
import { afterCursorFilter, cutPage, decodeCursor, PAGE_SIZE, type SortKey } from "./paging.ts";
import { currentActor } from "../lib/request_context.ts";

export type AuditAction = "create" | "update" | "delete" | "login";

export type AuditEntry = {
  action: AuditAction;
  /**
   * 사람이 아니라 기계가 한 일이면 여기에 적는다(예: AI_ACTOR).
   * 안 주면 지금 로그인한 사람 — 아직 로그인이 없어 null 이다.
   */
  actor?: string;
  table_name: string;
  record_id: string | null;
  summary: string;
  before?: unknown;
  after?: unknown;
};

export type AuditRow = AuditEntry & {
  id: string;
  at: string;
  actor: string | null;
};

/**
 * 누가. 요청 컨텍스트에서 가져온다.
 *
 * 전역 변수가 아니다 — 서버는 요청을 동시에 처리하므로, 전역에 담으면
 * A 가 지운 것이 B 의 이름으로 남는다. 조용히 틀리는 종류라 제일 나쁘다.
 * AsyncLocalStorage 가 요청 하나에 값을 매어 준다(lib/request_context.ts).
 * 그게 정말 안 섞이는지는 lib/request_context.test.ts 가 지킨다.
 */

/** 사람이 아니라 시스템이 한 일에 적는 이름. 감사 로그에서 사람 손과 가리려고 쓴다. */
export const AI_ACTOR = "시스템/AI";

/**
 * 행 하나를 통째로 읽는다. 지우거나 고치기 전에 before 를 잡아 두는 용도.
 * 표마다 컬럼이 달라 select("*") 로 읽는다. 없으면 null.
 */
export async function snapshotRow(
  table: string,
  id: string,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await getClient()
    .from(table)
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    throw new Error(`${table} 읽기 실패(감사용): ${error.message}`);
  }
  return (data as Record<string, unknown> | null) ?? null;
}

/** 어떤 열이 특정 값인 행들을 통째로 읽는다. 딸린 기록을 before 에 담을 때 쓴다. */
export async function snapshotRows(
  table: string,
  column: string,
  value: string,
): Promise<Record<string, unknown>[]> {
  const { data, error } = await getClient()
    .from(table)
    .select("*")
    .eq(column, value);

  if (error) {
    throw new Error(`${table} 읽기 실패(감사용): ${error.message}`);
  }
  return (data ?? []) as Record<string, unknown>[];
}

/**
 * 기록 한 줄을 남긴다.
 *
 * 실패하면 값을 서버 로그에 통째로 찍고 던진다. 부르는 쪽은 이미 변경을 끝낸 뒤이므로
 * 이 오류로 변경이 되돌아가지는 않는다. 다만 화면에는 실패로 보이므로
 * 사람이 "기록이 안 남았다"는 것을 알 수 있다.
 */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  const { error } = await getClient()
    .from("audit_logs")
    .insert({
      actor: entry.actor ?? currentActor(),
      action: entry.action,
      table_name: entry.table_name,
      record_id: entry.record_id,
      summary: entry.summary,
      before: entry.before ?? null,
      after: entry.after ?? null,
    });

  if (error) {
    console.error("[audit] 기록 실패 — 남기려던 값:", JSON.stringify(entry));
    throw new Error(`감사 기록 실패: ${error.message}`);
  }
}

/**
 * 로그인 기록 한 줄 (035).
 *
 * [왜 따로 두나 — 실패를 삼킨다]
 * 다른 기록은 실패하면 던진다. 사람이 "기록이 안 남았다" 를 알아야 하기 때문이다.
 * 로그인은 다르다 — 035 를 안 돌린 DB 에서 던지면 **로그인 자체가 막힌다.**
 * 기록을 남기려고 사람을 못 들어오게 하는 것은 거꾸로다. 서버 로그만 남기고 넘어간다.
 *
 * [적지 않는 것]
 * 비밀번호·해시·초대코드는 어디에도 넣지 않는다(원칙 8). before/after 는 비운다 —
 * 로그인에는 '전후 값' 이 없다. actor 는 로그인 이름(실패는 사람이 입력한 이름).
 */
export async function recordLogin(actor: string, summary: string): Promise<void> {
  const { error } = await getClient()
    .from("audit_logs")
    .insert({
      actor,
      action: "login",
      table_name: "staff",
      record_id: null,
      summary,
      before: null,
      after: null,
    });

  if (error) {
    // 값은 찍지 않는다. 035 를 안 돌린 DB 면 여기로 온다 — 로그인은 그대로 된다.
    console.error(`[audit] 로그인 기록 실패 — ${error.message}`);
  }
}

/* ---------- 읽기 (★ 관리자 전용) ---------- */

export type AuditFilter = {
  table?: string | null;
  action?: AuditAction | null;
  /** "YYYY-MM-DD". 그 날 0시부터 */
  from?: string | null;
  /** "YYYY-MM-DD". 그 날 끝까지 */
  to?: string | null;
  /** 이전 쪽의 next_cursor. 더 보기(나눠 받기) 용 */
  cursor?: string | null;
  limit?: number;
};

const COLUMNS = "id, at, actor, action, table_name, record_id, summary, before, after";

/** 정렬 — 최근 것부터. 같은 시각이면 id 로 가른다(쪽 경계에서 빠지거나 겹치지 않게). */
const AUDIT_SORT: SortKey[] = [
  { column: "at", kind: "timestamp", ascending: false },
  { column: "id", kind: "uuid", ascending: false },
];

/**
 * 최근 것부터 한 쪽씩. 필터는 모두 선택이고, 한 쪽은 "필터 결과" 의 limit 건이다.
 * 커서 모양이 틀리면 RuleError — API 가 400 으로 돌려준다.
 */
export async function listAudit(
  filter: AuditFilter = {},
): Promise<{ entries: AuditRow[]; next_cursor: string | null }> {
  const limit = filter.limit ?? PAGE_SIZE;
  let query = getClient()
    .from("audit_logs")
    .select(COLUMNS);

  if (filter.table) query = query.eq("table_name", filter.table);
  if (filter.action) query = query.eq("action", filter.action);
  if (filter.from) query = query.gte("at", `${filter.from}T00:00:00+09:00`);
  if (filter.to) query = query.lte("at", `${filter.to}T23:59:59.999+09:00`);
  if (filter.cursor) {
    const values = decodeCursor(filter.cursor, AUDIT_SORT);
    if (!values) throw new RuleError("목록 위치(cursor)가 올바르지 않습니다.");
    query = query.or(afterCursorFilter(AUDIT_SORT, values));
  }

  const { data, error } = await query
    .order("at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);

  if (error) {
    throw new Error(`감사 로그 조회 실패: ${error.message}`);
  }
  const page = cutPage((data ?? []) as AuditRow[], AUDIT_SORT, limit);
  return { entries: page.items, next_cursor: page.next_cursor };
}

/* ---------- 사라진 관찰이 어떻게 사라졌나 ---------- */

export type Removal = {
  /** "병합" 이면 다른 관찰에 합쳐진 것, "삭제" 면 지워진 것 */
  kind: "병합" | "삭제";
  obs_date: string | null;
  content: string;
};

/**
 * 사라진 관찰들이 어떻게 사라졌는지 기록에서 찾는다.
 *
 * [왜 기록을 뒤지나]
 * 병합은 진짜 삭제다 — mergeObservations 가 합쳐진 쪽 행을 지운다.
 * 그래서 지금 표에는 "병합됐다" 는 흔적이 남지 않고, 감사 로그에만 남는다.
 * 근거가 사라졌을 때 "누가 지웠다" 와 "다른 관찰에 합쳐졌다" 는
 * 사람이 해야 할 일이 전혀 달라서 갈라 보여야 한다.
 *
 * 모양으로 가린다. 병합은 before 가 {keep, remove} 두 벌이고 삭제는 행 하나다 —
 * 요약 문구로 가리면 문구를 다듬는 날 조용히 틀린다.
 */
export async function findObservationRemovals(ids: string[]): Promise<Map<string, Removal>> {
  const out = new Map<string, Removal>();
  if (ids.length === 0) return out;

  const { data, error } = await getClient()
    .from("audit_logs")
    .select("record_id, before, at")
    .eq("table_name", "observations")
    .eq("action", "delete")
    .in("record_id", ids)
    .order("at", { ascending: false });

  if (error) {
    throw new Error(`사라진 근거 확인 실패: ${error.message}`);
  }

  for (const row of data ?? []) {
    const id = row.record_id as string;
    if (out.has(id)) continue; // 가장 나중 것만 본다

    const before = (row.before ?? {}) as Record<string, unknown>;
    const merged = before.remove as Record<string, unknown> | undefined;
    const one = merged ?? before;

    out.set(id, {
      kind: merged ? "병합" : "삭제",
      obs_date: (one.obs_date as string | null) ?? null,
      content: String(one.content ?? ""),
    });
  }
  return out;
}
