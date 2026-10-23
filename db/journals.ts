/**
 * 일지(journals) 데이터 접근
 *
 * 규칙: Supabase 호출은 /db 안에서만 한다.
 *
 * 일지 4종을 한 테이블에 담고 kind로 구분한다.
 * 작성자 이름은 staff와 조인해서 함께 가져온다.
 */
import { getClient, NotFoundError, RuleError, writeError } from "./client.ts";
import { deleteRecordsByJournal } from "./resource_records.ts";
import { recordAudit, snapshotRow, snapshotRows } from "./audit.ts";
import { monthRange } from "./schedules.ts";
import {
  afterCursorFilter,
  containsPattern,
  cutPage,
  decodeCursor,
  PAGE_SIZE,
  quote,
  type SortKey,
} from "./paging.ts";
import type { Role } from "./staff.ts";

/** DB의 CHECK 제약과 같은 목록이어야 한다. */
export const KINDS = ["프로그램", "일상", "회의록", "봉사"] as const;

export type Kind = (typeof KINDS)[number];

export type JournalItem = {
  id: string;
  kind: Kind;
  journal_date: string; // "YYYY-MM-DD"
  author_id: string | null;
  author_name: string | null; // staff 조인 결과
  /**
   * 작성자 역할. 카드에 이름 옆 태그로 쓴다.
   * 이 일지를 쓸 때의 역할(as_role, 029)이다 — 겸직자가 나중에 역할을 바꿔도 그대로.
   * 옛 줄에 비어 있으면 작성자의 대표 역할.
   */
  author_role: string | null;
  as_role: string | null;
  /** 작성자 색 번호(0~5). 카드 이름 앞 점에 쓴다. 스케줄 달력과 같은 색이다. */
  author_color: number | null;
  title: string | null;
  content: string;
  /**
   * 봉사일지가 가리키는 일정. 시각은 여기서 읽는다.
   * 다른 종류의 일지는 null.
   */
  schedule_id: string | null;
  /**
   * 봉사일지에서만 쓴다. 일정에서 읽어 온 값이다 — 일지 표에 저장하지 않는다.
   * (015 이전에 저장해 둔 옛 값은 일정이 없을 때만 쓴다)
   */
  start_time: string | null;
  end_time: string | null;
  /** 수퍼비전 댓글. 봉사일지에서만 쓴다. */
  comment: string | null;
  /**
   * 쓴 시각. 같은 날짜에 여러 건일 때 나중에 쓴 것을 위로 올리는 데 쓴다.
   * 화면에 보여주지는 않는다 — 정렬에만 쓴다.
   */
  created_at: string;
  /**
   * 그 일지에서 뽑힌 개수. 카드를 펼치지 않아도 보이게 목록에 함께 실어 보낸다.
   *
   * 0 과 "아직 분석 안 함" 은 다른 말이다. 앞은 그냥 두면 되고 뒤는 눌러야 한다.
   * 그래서 개수와 별개로 analyzed 를 둔다 — 개수가 0 이어도 analyzed 면 "0건" 이다.
   */
  observation_count: number;
  resource_count: number;
  observations_analyzed: boolean;
  resources_analyzed: boolean;
};

/**
 * staff를 함께 읽어온다.
 * journals.author_id → staff.id 외래키가 하나뿐이라 테이블 이름만으로 이어진다.
 *
 * 뽑힌 개수는 PostgREST 의 묻어 세기(journal_observations(count))로 한 번에 가져온다.
 * 카드마다 따로 물으면 한 달 치를 여는 데 요청이 서른 번 나간다.
 */
// deno-fmt-ignore
const COLUMNS = "id, kind, journal_date, author_id, title, content, start_time, end_time, comment, schedule_id, as_role, created_at, observations_analyzed_at, resources_analyzed_at, author:staff(name, role, color_index), schedule:schedules(start_time, end_time), journal_observations(count), resource_records(count)";

/** 묻어 세기 결과는 [{ count: 3 }] 모양으로 온다. 없으면 0. */
// deno-lint-ignore no-explicit-any
function embeddedCount(value: any): number {
  return Array.isArray(value) ? Number(value[0]?.count ?? 0) : 0;
}

/** 조인 결과({ author: { name } })를 화면이 쓰기 쉬운 평평한 모양으로 바꾼다. */
// deno-lint-ignore no-explicit-any
function flatten(row: any): JournalItem {
  const {
    author,
    schedule,
    journal_observations,
    resource_records,
    observations_analyzed_at,
    resources_analyzed_at,
    ...rest
  } = row;
  // 시각은 일정이 먼저다. 일정에서 고치면 일지 표시도 따라간다.
  // 일정이 없는 옛 일지는 자기 칸에 남아 있는 값을 쓴다.
  const start = schedule?.start_time ?? row.start_time;
  const end = schedule?.end_time ?? row.end_time;
  return {
    ...rest,
    // 시각은 "HH:MM:SS" 로 오는데 화면에서는 초가 필요 없다
    start_time: start ? String(start).slice(0, 5) : null,
    end_time: end ? String(end).slice(0, 5) : null,
    author_name: author?.name ?? null,
    author_role: row.as_role ?? author?.role ?? null,
    author_color: author?.color_index ?? null,
    observation_count: embeddedCount(journal_observations),
    resource_count: embeddedCount(resource_records),
    observations_analyzed: !!observations_analyzed_at,
    resources_analyzed: !!resources_analyzed_at,
  } as JournalItem;
}

/**
 * 그 일지를 분석했다고 표시한다. 뽑은 것이 0건이어도 남긴다 —
 * "분석했는데 없었다" 와 "아직 안 했다" 를 가리는 것이 이 값의 일이다.
 *
 * 실패해도 예외를 올리지 않는다. 표시가 늦는 것보다 뽑은 결과가 사라지는 것이 나쁘다.
 * (부르는 쪽은 이미 저장을 끝낸 뒤다)
 */
export async function markAnalyzed(id: string, what: "observations" | "resources"): Promise<void> {
  const column = what === "observations" ? "observations_analyzed_at" : "resources_analyzed_at";

  const { error } = await getClient()
    .from("journals")
    .update({ [column]: new Date().toISOString() })
    .eq("id", id);

  if (error) console.error(`[markAnalyzed] ${id} ${column}: ${error.message}`);
}

/** 목록 정렬 — 날짜 내림차순, 같은 날이면 나중에 쓴 것 위, 마지막으로 id(동률 없게) */
export const JOURNAL_SORT: SortKey[] = [
  { column: "journal_date", kind: "date", ascending: false },
  { column: "created_at", kind: "timestamp", ascending: false },
  { column: "id", kind: "uuid", ascending: false },
];

/**
 * 목록 거르기(PC 일지 통합 검색). 목록과 요약이 똑같이 거른다 — 건수가 목록과 맞아야 한다.
 *   asRole     이 역할로 쓴 일지만(as_role)
 *   authorIds  이 사람들이 쓴 것만. 빈 배열이면 결과도 없다
 *   text       본문·제목에 이 글자가 있거나, 작성자가 textAuthorIds 중 하나(이름이 맞은 사람)
 */
export type JournalFilter = {
  asRole?: Role | null;
  authorIds?: string[] | null;
  text?: string | null;
  textAuthorIds?: string[] | null;
};

/** 통합 검색 한 덩어리 — 본문 OR 제목 OR 작성자(이름이 맞은 사람) */
export function textFilter(text: string, authorIds: string[] = []): string {
  const pattern = containsPattern(text);
  const parts = [`content.ilike.${pattern}`, `title.ilike.${pattern}`];
  if (authorIds.length) parts.push(`author_id.in.(${authorIds.map(quote).join(",")})`);
  return parts.join(",");
}

// deno-lint-ignore no-explicit-any
function applyFilter<Q extends { eq: any; in: any; or: any }>(query: Q, filter: JournalFilter): Q {
  let next = query;
  if (filter.asRole) next = next.eq("as_role", filter.asRole);
  if (filter.authorIds) next = next.in("author_id", filter.authorIds);
  if (filter.text) next = next.or(textFilter(filter.text, filter.textAuthorIds ?? []));
  return next;
}

export type JournalPageOptions = JournalFilter & {
  /** 이전 쪽의 next_cursor. 없으면 첫 쪽 */
  cursor?: string | null;
  limit?: number;
  /** 이 사람이 쓴 것만 */
  authorId?: string | null;
  /**
   * 남이 쓴 일지는 이 날짜 이후 것만(본인 것 = viewerId 는 날짜 무관).
   * 봉사자 폰의 "공유는 올해 것만" 규칙이다. 둘은 함께 준다.
   */
  othersSince?: string | null;
  viewerId?: string | null;
};

export class BadCursorError extends RuleError {}

/**
 * 종류별 + 기간별 일지 목록을 한 쪽씩. 정렬은 JOURNAL_SORT.
 * 거르는 일(작성자·공유 연도)은 모두 DB 에서 한다 — 한 쪽이 늘 "거른 결과" 의 15건이다.
 */
export async function listJournalsPage(
  kind: Kind,
  from: string,
  to: string,
  options: JournalPageOptions = {},
): Promise<{ journals: JournalItem[]; next_cursor: string | null }> {
  const limit = options.limit ?? PAGE_SIZE;
  if (options.authorIds?.length === 0) return { journals: [], next_cursor: null };
  let query = getClient()
    .from("journals")
    .select(COLUMNS)
    .eq("kind", kind)
    .gte("journal_date", from)
    .lte("journal_date", to);

  if (options.authorId) query = query.eq("author_id", options.authorId);
  query = applyFilter(query, options);
  if (options.othersSince && options.viewerId) {
    query = query.or(
      `author_id.eq.${quote(options.viewerId)},journal_date.gte.${quote(options.othersSince)}`,
    );
  }
  if (options.cursor) {
    const values = decodeCursor(options.cursor, JOURNAL_SORT);
    if (!values) throw new BadCursorError("목록 위치(cursor)가 올바르지 않습니다.");
    query = query.or(afterCursorFilter(JOURNAL_SORT, values));
  }

  for (const key of JOURNAL_SORT) query = query.order(key.column, { ascending: key.ascending });
  const { data, error } = await query.limit(limit + 1);

  if (error) {
    throw new Error(`일지 목록 조회 실패: ${error.message}`);
  }
  const page = cutPage((data ?? []) as Record<string, unknown>[], JOURNAL_SORT, limit);
  return { journals: page.items.map(flatten), next_cursor: page.next_cursor };
}

/**
 * 분석이 덜 된 봉사일지 — 서버 안전망(Deno.cron)이 쓴다.
 * created_at 이 [since, until) 인 것 중 오래된 순으로 limit 건. 무거운 칸은 읽지 않는다.
 */
export async function listUnanalyzedVolunteerJournals(
  since: string,
  until: string,
  limit: number,
): Promise<Array<{ id: string; observations_analyzed: boolean; resources_analyzed: boolean }>> {
  const { data, error } = await getClient()
    .from("journals")
    .select("id, observations_analyzed_at, resources_analyzed_at")
    .eq("kind", "봉사")
    .gte("created_at", since)
    .lt("created_at", until)
    .or("observations_analyzed_at.is.null,resources_analyzed_at.is.null")
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) {
    throw new Error(`미분석 봉사일지 조회 실패: ${error.message}`);
  }
  return (data ?? []).map((row) => ({
    id: row.id,
    observations_analyzed: !!row.observations_analyzed_at,
    resources_analyzed: !!row.resources_analyzed_at,
  }));
}

/**
 * 한 달(또는 걸어 둔 기간) 치의 가벼운 요약 — 건수와 아직 분석 안 된 일지. 거르기는 목록과 같다.
 *
 * 목록을 나눠 받으면 화면은 한 달 전체를 모른다. 그런데 [미분석 일괄 분석 N] 은
 * 한 달 전체가 대상이어야 한다(보이는 15건만이 아니라). 그래서 id 와 분석 표시만 따로 준다.
 */
export async function journalMonthSummary(
  kind: Kind,
  from: string,
  to: string,
  filter: JournalFilter = {},
): Promise<{
  total: number;
  unanalyzed: Array<{ id: string; observations_analyzed: boolean; resources_analyzed: boolean }>;
}> {
  if (filter.authorIds?.length === 0) return { total: 0, unanalyzed: [] };
  const { data, error } = await applyFilter(
    getClient()
      .from("journals")
      .select("id, observations_analyzed_at, resources_analyzed_at")
      .eq("kind", kind)
      .gte("journal_date", from)
      .lte("journal_date", to),
    filter,
  );

  if (error) {
    throw new Error(`일지 요약 조회 실패: ${error.message}`);
  }
  const rows = data ?? [];
  return {
    total: rows.length,
    unanalyzed: rows
      .filter((row) => !row.observations_analyzed_at || !row.resources_analyzed_at)
      .map((row) => ({
        id: row.id,
        observations_analyzed: !!row.observations_analyzed_at,
        resources_analyzed: !!row.resources_analyzed_at,
      })),
  };
}

/** 일지 1건을 읽는다. 없으면 null. */
export async function getJournal(id: string): Promise<JournalItem | null> {
  const { data, error } = await getClient()
    .from("journals")
    .select(COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    throw new Error(`일지 조회 실패: ${error.message}`);
  }
  return data ? flatten(data) : null;
}

/** 일지 1건을 추가한다. 추가된 행을 작성자 이름과 함께 돌려준다. */
export async function addJournal(
  kind: Kind,
  journalDate: string,
  authorId: string | null,
  title: string | null,
  content: string,
  extra: { schedule_id?: string | null; as_role: Role | null },
): Promise<JournalItem> {
  const { data, error } = await getClient()
    .from("journals")
    .insert({
      kind,
      journal_date: journalDate,
      author_id: authorId,
      title,
      content,
      // 시각은 일정에서 읽는다. 일지 표에 복사해 두지 않는다(015).
      schedule_id: extra.schedule_id ?? null,
      // 어느 역할로 쓴 일지인지. 봉사일지는 매인 일정의 역할이다.
      as_role: extra.as_role,
    })
    .select(COLUMNS)
    .single();

  if (error) {
    throw writeError(error, "일지 추가 실패");
  }
  return flatten(data);
}

/**
 * 일지를 고친다. 넘긴 항목만 바꾼다.
 *
 * 종류(kind)는 바꾸지 않는다. 종류가 바뀌면 그 일지에서 뽑은 관찰의 출처도 달라지는데,
 * 이미 가져간 관찰의 출처까지 따라 고칠 방법이 없다. 종류를 잘못 골랐으면 다시 쓴다.
 *
 * 일정 연결(schedule_id)도 바꾸지 않는다. 봉사일지의 날짜·작성자·시각은 일정이 정하는 값이라,
 * 연결을 바꾸는 것은 "다른 날의 일지로 만드는 것"이지 고치는 것이 아니다.
 * 그래서 봉사일지에서는 날짜·작성자를 넘기지 않는다(api 가 막는다).
 */
export async function updateJournal(
  id: string,
  patch: {
    title?: string | null;
    content?: string;
    journal_date?: string;
    author_id?: string | null;
    start_time?: string | null;
    end_time?: string | null;
    comment?: string | null;
  },
): Promise<JournalItem> {
  const changes: Record<string, unknown> = {};
  if (patch.title !== undefined) changes.title = patch.title;
  if (patch.content !== undefined) changes.content = patch.content;
  if (patch.journal_date !== undefined) changes.journal_date = patch.journal_date;
  if (patch.author_id !== undefined) changes.author_id = patch.author_id;

  // 제목·본문·날짜·작성자가 바뀌면 남긴다. 시각·수퍼비전만 바뀌는 것은 가벼워 안 남긴다.
  const contentChanged = patch.title !== undefined || patch.content !== undefined ||
    patch.journal_date !== undefined || patch.author_id !== undefined;
  const before = contentChanged ? await snapshotRow("journals", id) : null;

  // 일정에 매인 일지(봉사)의 날짜·작성자는 일정이 정한다.
  // 여기서 바꾸면 일지와 일정이 서로 다른 날·다른 사람을 가리키게 된다.
  // 바꿔야 한다면 스케줄에서 일정을 고치는 것이 맞다.
  if (before?.schedule_id && (patch.journal_date !== undefined || patch.author_id !== undefined)) {
    throw new RuleError("일정에 매인 일지입니다. 날짜와 작성자는 스케줄에서 바꿔 주세요.");
  }
  if (patch.start_time !== undefined) changes.start_time = patch.start_time;
  if (patch.end_time !== undefined) changes.end_time = patch.end_time;
  if (patch.comment !== undefined) changes.comment = patch.comment;

  if (Object.keys(changes).length === 0) {
    throw new Error("바꿀 내용이 없습니다.");
  }

  const { data, error } = await getClient()
    .from("journals")
    .update(changes)
    .eq("id", id)
    .select(COLUMNS)
    .single();

  if (error) {
    throw writeError(
      error,
      "일지 수정 실패",
      "그 일지를 찾지 못했습니다. 이미 지워졌을 수 있어요.",
    );
  }
  const item = flatten(data);
  if (contentChanged) {
    await recordAudit({
      action: "update",
      table_name: "journals",
      record_id: id,
      summary: `일지 수정 — ${before?.journal_date ?? ""} ${before?.title ?? before?.kind ?? ""}`
        .trim(),
      before,
      after: {
        title: item.title,
        content: item.content,
        journal_date: item.journal_date,
        author_id: item.author_id,
      },
    });
  }
  return item;
}

/**
 * 일지 1건을 지운다.
 *
 * 그 일지에서 뽑힌 관찰 후보(journal_observations)는 외래키가 cascade 라 함께 사라진다.
 * 다만 이미 아동 관찰로 가져간 것은 지워지지 않는다.
 * observations 쪽 외래키가 set null 이라 연결만 끊기고 기록은 남는다.
 * 그 관찰에는 "근거 일지 삭제됨" 표시가 붙는다(006 참고).
 *
 * 자원기록(resource_records)은 함께 지운다.
 *
 * 외래키가 set null 이라 그냥 두면 남지만, 일부러 먼저 치운다.
 * 자원기록은 관찰과 달리 사람이 손본 흔적이 거의 없는 자동 집계다.
 * 근거가 된 일지가 사라진 뒤에도 수만 남으면 되짚을 방법이 없고,
 * 같은 내용을 다시 써서 분석하면 옛 줄 옆에 새 줄이 또 쌓인다
 * (일지가 지워지면서 journal_id 가 비어 중복 방지 색인도 안 먹는다).
 * 근거 없는 수가 남는 것보다 함께 사라지는 편이 앞뒤가 맞는다.
 *
 * 그 일지 때문에 자동 등록된 자원사전 항목은 지우지 않는다.
 * 사전은 "센터가 무엇을 가졌나"라는 누적 자산이고, 정말 안 쓰는 것이면
 * 방치 후보에 저절로 드러난다. 다만 지워진 기록은 감사 로그에 값째 남긴다.
 */
export async function deleteJournal(id: string): Promise<void> {
  // 뽑힌 관찰 후보와 자원기록도 따라 사라진다. 지우기 전에 값째 담는다.
  const [journal, candidates, records] = await Promise.all([
    snapshotRow("journals", id),
    snapshotRows("journal_observations", "journal_id", id),
    snapshotRows("resource_records", "journal_id", id),
  ]);
  if (!journal) throw new NotFoundError("그 일지를 찾지 못했습니다. 이미 지워졌을 수 있어요.");

  // 일지를 먼저 지우면 journal_id 가 null 이 되어 어느 줄이 이 일지 것이었는지 알 수 없다.
  await deleteRecordsByJournal(id);

  const { error } = await getClient()
    .from("journals")
    .delete()
    .eq("id", id);

  if (error) {
    throw new Error(`일지 삭제 실패: ${error.message}`);
  }

  await recordAudit({
    action: "delete",
    table_name: "journals",
    record_id: id,
    summary:
      `일지 삭제 — ${journal?.journal_date ?? ""} ${journal?.kind ?? ""} ${journal?.title ?? ""}`
        .replace(/\s+/g, " ").trim() +
      ` (뽑힌 관찰 ${candidates.length}건 · 자원기록 ${records.length}건 함께)`,
    before: { journal, journal_observations: candidates, resource_records: records },
  });
}

/* ---------- 미작성 탐지 (봉사일지) ---------- */

export type MissingJournal = {
  staff_id: string;
  staff_name: string | null;
  role: Role | null;
  sched_date: string; // "YYYY-MM-DD"
  start_time: string;
  end_time: string;
};

/**
 * 오늘 날짜. 센터가 한국에 있으므로 한국 시각으로 센다.
 *
 * 서버는 Deno Deploy 라 UTC 로 돈다. 그냥 두면 한국 시각으로 아침 9시 이전에
 * 어제가 오늘이 되어, 어제 온 봉사자의 미작성이 하루 늦게 뜬다.
 */
function todayInSeoul(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

/**
 * 그 달의 일정 중 봉사일지가 없는 것.
 *
 * schedules 와 journals 를 각각 읽어 앱에서 맞춘다.
 * PostgREST 로는 서로 관계가 없는 두 표를 LEFT JOIN 할 수 없고,
 * 한 달치는 많아야 수십 줄이라 여기서 맞추는 편이 단순하다.
 *
 * 맞추는 기준은 "같은 날 + 같은 사람 + 같은 역할(029)" 이다.
 * 하루에 두 번 온 사람이 일지를 하나만 썼다면 그 날은 쓴 것으로 본다.
 * 일지는 방문 단위가 아니라 그 날 있었던 일을 적는 것이기 때문이다.
 *
 * 아직 오지 않은 날은 세지 않는다. 이번 달 남은 일정까지 미작성으로 뜨면
 * 숫자가 늘 커져 있어 아무도 안 보게 된다.
 */
export async function listMissingJournals(
  year: number,
  month: number,
): Promise<MissingJournal[]> {
  const { from, to } = monthRange(year, month);
  const client = getClient();

  const [schedules, journals] = await Promise.all([
    client
      .from("schedules")
      .select(
        "staff_id, sched_date, start_time, end_time, as_role, staff:staff(name, role, status)",
      )
      .gte("sched_date", from)
      .lte("sched_date", to)
      .order("sched_date", { ascending: true })
      .order("start_time", { ascending: true }),
    client
      .from("journals")
      .select("journal_date, author_id, as_role")
      .eq("kind", "봉사")
      .gte("journal_date", from)
      .lte("journal_date", to),
  ]);

  if (schedules.error) {
    throw new Error(`일정 조회 실패: ${schedules.error.message}`);
  }
  if (journals.error) {
    throw new Error(`봉사일지 조회 실패: ${journals.error.message}`);
  }

  // 같은 날 · 같은 사람 · 같은 역할이면 쓴 것이다. 역할이 하나인 사람은 예전 기준과 똑같다.
  // 겸직자가 같은 날 멘토·봉사 일정이 둘이면 역할마다 따로 센다(멘토 일지가 봉사 날을 채우지 않는다).
  // 역할이 비어 있는 옛 일지는 그 날 그 사람의 모든 역할을 채운다.
  const written = new Set(
    (journals.data ?? [])
      .filter((row) => row.author_id)
      .map((row) => `${row.journal_date} ${row.author_id} ${row.as_role ?? "*"}`),
  );

  const today = todayInSeoul();
  const seen = new Set<string>();
  const missing: MissingJournal[] = [];

  for (
    const row of (schedules.data ?? []) as unknown as Array<{
      staff_id: string;
      sched_date: string;
      start_time: string;
      end_time: string;
      as_role: Role | null;
      staff: { name: string; role: Role | null; status: string } | null;
    }>
  ) {
    // 그만둔 사람의 옛 일정까지 독촉하지 않는다
    if (row.staff?.status !== "활동중") continue;
    if (row.sched_date > today) continue;

    const day = `${row.sched_date} ${row.staff_id}`;
    const key = `${day} ${row.as_role ?? "*"}`;
    if (written.has(key) || written.has(`${day} *`) || seen.has(key)) continue;
    seen.add(key);

    missing.push({
      staff_id: row.staff_id,
      staff_name: row.staff?.name ?? null,
      role: row.as_role ?? row.staff?.role ?? null,
      sched_date: row.sched_date,
      start_time: String(row.start_time ?? "").slice(0, 5),
      end_time: String(row.end_time ?? "").slice(0, 5),
    });
  }

  return missing;
}
