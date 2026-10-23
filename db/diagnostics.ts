/**
 * 시스템 점검이 읽는 것 — 데이터가 서로 맞물려 있는지 센다
 *
 * 규칙: Supabase 호출은 /db 안에서만 한다.
 *
 * [읽기만 한다]
 * 이 파일에는 insert·update·delete 가 없다. 고칠 거리를 찾는 곳이지 고치는 곳이 아니다.
 * 무엇을 지울지·되돌릴지는 사람이 결과를 보고 정한다 — 자동으로 고치면
 * "왜 이게 없어졌지" 를 아무도 설명할 수 없게 된다.
 *
 * [외래키가 있어도 센다]
 * 대부분의 연결에는 외래키가 걸려 있어 정상이라면 0 이 나온다.
 * 그래도 세는 이유: SQL 로 직접 넣은 데이터, 제약을 잠시 떼었던 마이그레이션,
 * 외래키가 없는 연결(source_journal_id 처럼)이 섞여 있다. 0 이 나오는 것 자체가 확인이다.
 *
 * [아동 신원은 내려보내지 않는다]
 * 상세 목록에는 id·날짜만 담는다. 관찰 본문에는 이름이 적혀 있을 수 있어 싣지 않는다.
 */
import { getClient } from "./client.ts";

/** 상세로 보여 줄 줄 수 상한 */
const DETAIL_LIMIT = 50;

/** 한 번에 읽는 줄 수. PostgREST 기본 상한(1000)에 맞춘다. */
const PAGE = 1000;

/** 표 하나의 한 열을 전부 읽는다. 대조용 id 모음을 만들 때만 쓴다. */
async function allValues(table: string, column: string): Promise<Set<string>> {
  const out = new Set<string>();
  for (let from = 0;; from += PAGE) {
    const { data, error } = await getClient()
      .from(table)
      .select(column)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}.${column} 읽기 실패: ${error.message}`);
    const rows = (data ?? []) as unknown as Array<Record<string, string | null>>;
    for (const row of rows) {
      const value = row[column];
      if (value) out.add(value);
    }
    if (rows.length < PAGE) break;
  }
  return out;
}

/**
 * 조건에 맞는 줄 수만 센다(head: true — 줄은 안 받는다).
 * supabase-js 의 필터 사슬 타입은 표마다 달라 받는 쪽을 any 로 둔다.
 */
async function countWhere(
  table: string,
  // deno-lint-ignore no-explicit-any
  apply: (q: any) => any,
): Promise<number> {
  const base = getClient().from(table).select("id", { count: "exact", head: true });
  const { count, error } = await apply(base);
  if (error) throw new Error(`${table} 세기 실패: ${error.message}`);
  return count ?? 0;
}

/* ---------- 고아 데이터 ---------- */

export type OrphanCounts = {
  /** 일지에서 뽑혔는데 일지 id 가 비었거나 없는 일지를 가리키는 자원기록 */
  recordsWithoutJournal: number;
  /** 어디에도 안 보이는 자원기록 — status 'N' (통계는 'Y' 만, 미분류함도 'Y' 만 본다) */
  recordsInLimbo: number;
  /** 없는 아동을 가리키는 관찰·평가·반기관찰 */
  observationsNoChild: number;
  evaluationsNoChild: number;
  halfObservationsNoChild: number;
  /** 병합 잔재 — 없는 후보를 가리키는 관찰, 없는 줄에 합쳐졌다고 적힌 후보 */
  observationsBrokenCandidate: number;
  candidatesBrokenMerge: number;
  /** 원본 일지가 지워진 관찰(외래키 없음 — 설계상 남는다) */
  observationsJournalGone: number;
  /** 평가 스냅샷이 가리키는데 지금 없는 관찰 — 항목 수와 그런 평가 수 */
  snapshotMissingEntries: number;
  snapshotMissingEvaluations: number;
};

export async function countOrphans(): Promise<OrphanCounts> {
  const client = getClient();

  const [journalIds, childIds, obsIds, candidateIds] = await Promise.all([
    allValues("journals", "id"),
    allValues("children_identity", "id"),
    allValues("observations", "id"),
    allValues("journal_observations", "id"),
  ]);

  // 자원기록
  const records = await client.from("resource_records").select("journal_id, status");
  if (records.error) throw new Error(`자원기록 읽기 실패: ${records.error.message}`);
  const recordRows = (records.data ?? []) as Array<{ journal_id: string | null; status: string }>;

  // 관찰
  const obs = await client
    .from("observations")
    .select("child_id, source_journal_id, source_journal_obs_id");
  if (obs.error) throw new Error(`관찰 읽기 실패: ${obs.error.message}`);
  const obsRows = (obs.data ?? []) as Array<{
    child_id: string;
    source_journal_id: string | null;
    source_journal_obs_id: string | null;
  }>;

  const [evals, half, candidates] = await Promise.all([
    client.from("yearly_evaluations").select("child_id, evidence_snapshot"),
    client.from("half_observations").select("child_id"),
    client.from("journal_observations").select("merged_into").not("merged_into", "is", null),
  ]);
  if (evals.error) throw new Error(`평가 읽기 실패: ${evals.error.message}`);
  if (half.error) throw new Error(`반기 관찰 읽기 실패: ${half.error.message}`);
  if (candidates.error) throw new Error(`관찰 후보 읽기 실패: ${candidates.error.message}`);

  let snapshotMissingEntries = 0;
  let snapshotMissingEvaluations = 0;
  for (const row of (evals.data ?? []) as Array<{ evidence_snapshot: unknown }>) {
    if (!Array.isArray(row.evidence_snapshot)) continue;
    const missing = row.evidence_snapshot.filter((one) =>
      one && typeof one === "object" &&
      !obsIds.has(String((one as Record<string, unknown>).obs_id))
    ).length;
    snapshotMissingEntries += missing;
    if (missing > 0) snapshotMissingEvaluations += 1;
  }

  return {
    recordsWithoutJournal:
      recordRows.filter((one) => !one.journal_id || !journalIds.has(one.journal_id)).length,
    recordsInLimbo: recordRows.filter((one) => one.status === "N").length,
    observationsNoChild: obsRows.filter((one) => !childIds.has(one.child_id)).length,
    evaluationsNoChild: ((evals.data ?? []) as Array<{ child_id: string }>)
      .filter((one) => !childIds.has(one.child_id)).length,
    halfObservationsNoChild: ((half.data ?? []) as Array<{ child_id: string }>)
      .filter((one) => !childIds.has(one.child_id)).length,
    observationsBrokenCandidate:
      obsRows.filter((one) =>
        one.source_journal_obs_id && !candidateIds.has(one.source_journal_obs_id)
      ).length,
    candidatesBrokenMerge: ((candidates.data ?? []) as Array<{ merged_into: string }>)
      .filter((one) => !candidateIds.has(one.merged_into)).length,
    observationsJournalGone:
      obsRows.filter((one) => one.source_journal_id && !journalIds.has(one.source_journal_id))
        .length,
    snapshotMissingEntries,
    snapshotMissingEvaluations,
  };
}

/* ---------- 감사 로그 ---------- */

export async function auditHealth(): Promise<{
  latestAt: string | null;
  total: number;
  noActor: number;
}> {
  const client = getClient();
  const latest = await client.from("audit_logs").select("at").order("at", { ascending: false })
    .limit(1).maybeSingle();
  if (latest.error) throw new Error(`감사 로그 읽기 실패: ${latest.error.message}`);

  const [total, noActorNull, noActorEmpty] = await Promise.all([
    countWhere("audit_logs", (q) => q),
    countWhere("audit_logs", (q) => q.is("actor", null)),
    countWhere("audit_logs", (q) => q.eq("actor", "")),
  ]);
  return {
    latestAt: (latest.data as { at: string } | null)?.at ?? null,
    total,
    noActor: noActorNull + noActorEmpty,
  };
}

/* ---------- 계정 ---------- */

export async function adminCounts(): Promise<{ flagged: number; usable: number }> {
  const { data, error } = await getClient()
    .from("staff")
    .select("is_admin, account_status, status, password_hash")
    .eq("is_admin", true);
  if (error) throw new Error(`관리자 읽기 실패: ${error.message}`);
  const rows = (data ?? []) as Array<{
    account_status: string;
    status: string;
    password_hash: string | null;
  }>;
  return {
    flagged: rows.length,
    // 로그인해서 실제로 관리자 일을 할 수 있는 사람. countUsableAdmins 와 같은 기준이다.
    usable:
      rows.filter((one) =>
        one.account_status === "활성" && one.status === "활동중" && one.password_hash
      ).length,
  };
}

/* ---------- 더미 표식 ---------- */

/** 검증할 때 쓴 표식. 실사용 전에 비울 것을 가늠하는 데 쓴다. */
export const VERIFY_SESSION_AGENT = "verify-script";
export const VERIFY_TEXT_MARK = "[검증]";

export async function dummyCounts(): Promise<{
  sessions: number;
  observations: number;
  journals: number;
  halfObservations: number;
  inquiries: number;
}> {
  const like = `${VERIFY_TEXT_MARK}%`;
  const [sessions, observations, journals, halfObservations, inquiries] = await Promise.all([
    countWhere("sessions", (q) => q.eq("user_agent", VERIFY_SESSION_AGENT)),
    countWhere("observations", (q) => q.like("content", like)),
    countWhere("journals", (q) => q.like("content", like)),
    countWhere("half_observations", (q) => q.like("note", like)),
    countWhere("inquiries", (q) => q.like("content", like)),
  ]);
  return { sessions, observations, journals, halfObservations, inquiries };
}

/* ---------- 상세 ---------- */

export const DETAIL_KEYS = [
  "records_without_journal",
  "records_in_limbo",
  "observations_journal_gone",
  "snapshot_missing",
  "audit_no_actor",
] as const;
export type DetailKey = typeof DETAIL_KEYS[number];

/**
 * 항목 하나의 상세. id·날짜·이름(자원)처럼 사람을 가리키지 않는 값만 담는다.
 * 관찰 본문은 싣지 않는다 — 아동 이름이 적혀 있을 수 있다.
 */
export async function detailOf(key: DetailKey): Promise<Array<Record<string, unknown>>> {
  const client = getClient();

  if (key === "records_without_journal" || key === "records_in_limbo") {
    const journalIds = key === "records_without_journal"
      ? await allValues("journals", "id")
      : new Set<string>();
    const { data, error } = await client
      .from("resource_records")
      .select("id, record_date, resource_name, status, journal_id")
      .order("record_date", { ascending: false });
    if (error) throw new Error(`자원기록 읽기 실패: ${error.message}`);
    const rows = (data ?? []) as Array<Record<string, string | null>>;
    return rows
      .filter((one) =>
        key === "records_in_limbo"
          ? one.status === "N"
          : !one.journal_id || !journalIds.has(one.journal_id)
      )
      .slice(0, DETAIL_LIMIT);
  }

  if (key === "observations_journal_gone") {
    const journalIds = await allValues("journals", "id");
    const { data, error } = await client
      .from("observations")
      .select("id, obs_date, area, source_journal_id")
      .not("source_journal_id", "is", null)
      .order("obs_date", { ascending: false });
    if (error) throw new Error(`관찰 읽기 실패: ${error.message}`);
    return ((data ?? []) as Array<Record<string, string | null>>)
      .filter((one) => !journalIds.has(one.source_journal_id as string))
      .slice(0, DETAIL_LIMIT);
  }

  if (key === "snapshot_missing") {
    const obsIds = await allValues("observations", "id");
    const { data, error } = await client
      .from("yearly_evaluations")
      .select("id, year, half, evidence_snapshot, evidence_checked_at")
      .not("evidence_snapshot", "is", null);
    if (error) throw new Error(`평가 읽기 실패: ${error.message}`);
    return ((data ?? []) as Array<Record<string, unknown>>)
      .map((row) => {
        const snapshot = Array.isArray(row.evidence_snapshot) ? row.evidence_snapshot : [];
        const missing = snapshot.filter((one) =>
          !obsIds.has(String((one as Record<string, unknown>)?.obs_id))
        ).length;
        return {
          evaluation_id: row.id,
          year: row.year,
          half: row.half,
          snapshot_size: snapshot.length,
          missing,
          checked_at: row.evidence_checked_at,
        };
      })
      .filter((one) => one.missing > 0)
      .slice(0, DETAIL_LIMIT);
  }

  // audit_no_actor
  const { data, error } = await client
    .from("audit_logs")
    .select("at, action, table_name, summary")
    .or("actor.is.null,actor.eq.")
    .order("at", { ascending: false })
    .limit(DETAIL_LIMIT);
  if (error) throw new Error(`감사 로그 읽기 실패: ${error.message}`);
  return (data ?? []) as Array<Record<string, unknown>>;
}
