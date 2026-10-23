/**
 * 관찰 기록(observations) 데이터 접근
 *
 * 규칙: Supabase 호출은 /db 안에서만 한다.
 *
 * 이 테이블에는 아동 이름이 없다. 아동은 child_id로만 가리킨다.
 * 따라서 이 파일이 돌려주는 값에도 이름이 섞이지 않는다.
 */
import { getClient, NotFoundError, rpcError, RuleError, writeError } from "./client.ts";
import { recordAudit, snapshotRow } from "./audit.ts";

/**
 * 처음 여섯 관찰 영역(코드 = 이름). 지금 목록은 settings.observation_areas 에 있다 — lib/obs_areas.ts.
 * 031 이후 DB 에는 영역 CHECK 제약이 없다. 어떤 코드를 받을지는 앱(api)이 정한다.
 */
export const AREAS = [
  "건강",
  "학습",
  "또래관계",
  "행동정서",
  "보호자요구",
  "연계",
] as const;

/** 관찰 출처. DB의 CHECK 제약과 같은 목록이어야 한다. */
export const SOURCES = ["멘토", "봉사", "프로그램", "일상", "회의"] as const;

/** 영역 코드 — 처음 여섯은 이름 그대로, 새로 더한 것은 a01 … */
export type Area = string;
export type Source = (typeof SOURCES)[number];

/** 반기. 1 = 상반기(1~6월), 2 = 하반기(7~12월) */
export type Half = 1 | 2;

/**
 * 가져온 관찰의 근거가 지금 어떤 상태인지.
 *
 *   null      직접 쓴 관찰. 근거랄 것이 없다.
 *   "ok"      일지에서 가져왔고, 그 뒤로 일지가 그대로다.
 *   "modified" 가져온 뒤 원본 일지가 수정됐다(또는 다시 분석돼 후보가 바뀌었다).
 *   "deleted"  원본 일지가 사라졌다.
 *
 * 어느 쪽이든 관찰 자체는 건드리지 않는다. 사실만 알린다.
 */
export type SourceStatus = "ok" | "modified" | "deleted";

export type ObservationItem = {
  id: string;
  obs_date: string; // "YYYY-MM-DD"
  area: Area | null; // null이면 영역 미지정
  content: string;
  source: Source | null;
  /** 어느 일지에서 왔는지. 직접 쓴 관찰이면 null.
   * 화면이 "합칠 수 있는 둘인가"를 가리는 데 쓴다 — 근거가 다르면 합치지 못한다.
   * 일지 id 일 뿐이라 사람 정보는 들어 있지 않다. */
  source_journal_id: string | null;
  /** 직접 쓴 관찰이면 null */
  source_status: SourceStatus | null;
};

/** 화면에 돌려줄 컬럼. 목록/추가/수정이 같은 모양을 쓰도록 한곳에 둔다. */
const COLUMNS = "id, obs_date, area, content, source";

/** 근거 상태를 가려내는 데 쓰는 컬럼 */
const TRACE_COLUMNS = "source_journal_obs_id, source_journal_id, source_journal_updated_at";

type TraceRow = {
  source_journal_obs_id: string | null;
  source_journal_id: string | null;
  source_journal_updated_at: string | null;
};

/**
 * 가져온 관찰들의 근거가 지금도 그대로인지 확인한다.
 *
 * 일지를 한 번에 모아 읽는다. 관찰마다 물어보면 관찰 수만큼 질의가 나간다.
 */
async function markSourceStatus<T extends TraceRow>(
  rows: T[],
): Promise<Array<T & { source_status: SourceStatus | null }>> {
  const journalIds = [
    ...new Set(rows.map((row) => row.source_journal_id).filter((id): id is string => !!id)),
  ];

  const alive = new Map<string, string>();
  if (journalIds.length > 0) {
    const { data, error } = await getClient()
      .from("journals")
      // 본문이 바뀐 시각만 본다(028). updated_at 은 분석 표시·수퍼비전 댓글에도 올라간다.
      .select("id, content_updated_at")
      .in("id", journalIds);

    if (error) {
      throw new Error(`근거 일지 확인 실패: ${error.message}`);
    }
    for (const journal of data ?? []) alive.set(journal.id, journal.content_updated_at);
  }

  return rows.map((row) => {
    // 직접 쓴 관찰
    if (!row.source_journal_id) return { ...row, source_status: null };

    const updatedAt = alive.get(row.source_journal_id);
    if (!updatedAt) return { ...row, source_status: "deleted" as const };

    // 후보가 사라졌다면 그 일지를 다시 분석해 근거가 갈렸다는 뜻이다
    if (!row.source_journal_obs_id) return { ...row, source_status: "modified" as const };

    // 가져올 때 적어 둔 시각보다 일지 본문(제목·내용)이 나중에 바뀌었는지.
    // 옛 기록은 가져올 때 행 전체 시각을 적었는데, 그 값은 본문 시각보다 늘 같거나 늦어서
    // 이 비교에 그대로 써도 거짓 "수정됨" 을 만들지 않는다.
    if (row.source_journal_updated_at && updatedAt > row.source_journal_updated_at) {
      return { ...row, source_status: "modified" as const };
    }
    return { ...row, source_status: "ok" as const };
  });
}

/** 반기를 날짜 범위로 바꾼다. 양끝 포함. */
export function halfYearRange(year: number, half: Half): { from: string; to: string } {
  return half === 1
    ? { from: `${year}-01-01`, to: `${year}-06-30` }
    : { from: `${year}-07-01`, to: `${year}-12-31` };
}

/**
 * 한 아동의 특정 반기 관찰을 시간순(오래된 것 먼저)으로 읽어온다.
 *
 * 같은 날짜에 여러 건이면 입력된 순서(created_at)로 이어 붙인다.
 */
export async function listObservationsByChild(
  childId: string,
  year: number,
  half: Half,
): Promise<ObservationItem[]> {
  const { from, to } = halfYearRange(year, half);

  const { data, error } = await getClient()
    .from("observations")
    .select(`${COLUMNS}, ${TRACE_COLUMNS}`)
    .eq("child_id", childId)
    .gte("obs_date", from)
    .lte("obs_date", to)
    .order("obs_date", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(`관찰 목록 조회 실패: ${error.message}`);
  }

  // deno-lint-ignore no-explicit-any
  const marked = await markSourceStatus((data ?? []) as any[]);

  // 근거 판단에만 쓴 컬럼은 화면으로 내보내지 않는다
  return marked.map((
    { id, obs_date, area, content, source, source_journal_id, source_status },
  ) => ({
    id,
    obs_date,
    area,
    content,
    source,
    source_journal_id,
    source_status,
  })) as ObservationItem[];
}

/** 한 행에 근거 상태를 붙이고, 판단에만 쓴 컬럼은 떼어 낸다. */
// deno-lint-ignore no-explicit-any
async function toItem(row: any): Promise<ObservationItem> {
  const [marked] = await markSourceStatus([row]);
  const { id, obs_date, area, content, source, source_journal_id, source_status } = marked;
  return {
    id,
    obs_date,
    area,
    content,
    source,
    source_journal_id,
    source_status,
  } as ObservationItem;
}

/**
 * 새로 더한 영역(a01 …)을 DB 가 CHECK 제약으로 거절했다 — 031 을 아직 안 돌린 DB.
 * 서버 고장이 아니라 할 일이 남은 것이라 사람이 읽을 말로 돌려준다.
 */
const AREA_CHECK_MESSAGE =
  "새로 더한 영역은 DB 마이그레이션 031(영역 제약 풀기)을 적용한 뒤에 쓸 수 있습니다. 관리자에게 알려 주세요.";

function isAreaCheck(error: { code?: string; message?: string }): boolean {
  return error.code === "23514" && /area/.test(error.message ?? "");
}

/** 관찰 1건을 추가한다. 추가된 행을 그대로 돌려준다. */
export async function addObservation(
  childId: string,
  obsDate: string,
  area: Area | null,
  content: string,
  source: Source | null,
): Promise<ObservationItem> {
  const { data, error } = await getClient()
    .from("observations")
    .insert({
      child_id: childId,
      obs_date: obsDate,
      area,
      content,
      source,
    })
    .select(`${COLUMNS}, ${TRACE_COLUMNS}`)
    .single();

  if (error) {
    if (isAreaCheck(error)) throw new RuleError(AREA_CHECK_MESSAGE);
    throw writeError(error, "관찰 추가 실패");
  }
  return await toItem(data);
}

/** 영역만 바꾼다. area가 null이면 미지정으로 되돌린다. */
export async function updateObservationArea(
  id: string,
  area: Area | null,
): Promise<ObservationItem> {
  const before = await snapshotRow("observations", id);
  const { data, error } = await getClient()
    .from("observations")
    .update({ area })
    .eq("id", id)
    .select(`${COLUMNS}, ${TRACE_COLUMNS}`)
    .single();

  if (error) {
    if (isAreaCheck(error)) throw new RuleError(AREA_CHECK_MESSAGE);
    throw writeError(
      error,
      "영역 변경 실패",
      "그 관찰을 찾지 못했습니다. 이미 지워졌을 수 있어요.",
    );
  }
  await recordAudit({
    action: "update",
    table_name: "observations",
    record_id: id,
    summary: `관찰 영역 변경 — ${before?.obs_date ?? ""} ${before?.area ?? "미지정"} → ${
      area ?? "미지정"
    }`.trim(),
    before,
    after: { area },
  });
  return await toItem(data);
}

/** 내용만 바꾼다. */
export async function updateObservationContent(
  id: string,
  content: string,
): Promise<ObservationItem> {
  const before = await snapshotRow("observations", id);
  const { data, error } = await getClient()
    .from("observations")
    .update({ content })
    .eq("id", id)
    .select(`${COLUMNS}, ${TRACE_COLUMNS}`)
    .single();

  if (error) {
    throw writeError(
      error,
      "내용 변경 실패",
      "그 관찰을 찾지 못했습니다. 이미 지워졌을 수 있어요.",
    );
  }
  await auditContentChange(id, before, content);
  return await toItem(data);
}

/** 내용 수정 기록 — 수정과 나누기(원본 쪽)가 같은 모양으로 남긴다 */
async function auditContentChange(
  id: string,
  before: Record<string, unknown> | null,
  content: string,
): Promise<void> {
  await recordAudit({
    action: "update",
    table_name: "observations",
    record_id: id,
    summary: `관찰 내용 수정 — ${before?.obs_date ?? ""} ${
      String(before?.content ?? "").slice(0, 20)
    }`
      .trim(),
    before,
    after: { content },
  });
}

/** 관찰 여러 건을 화면 모양으로 읽는다(id 순서 그대로) */
async function readItems(ids: string[]): Promise<ObservationItem[]> {
  const { data, error } = await getClient()
    .from("observations")
    .select(`${COLUMNS}, ${TRACE_COLUMNS}`)
    .in("id", ids);

  if (error) {
    throw new Error(`관찰 조회 실패: ${error.message}`);
  }
  const rows = data ?? [];
  return await Promise.all(ids.map((id) => {
    const row = rows.find((one) => one.id === id);
    if (!row) throw new Error(`관찰 조회 실패: ${id} 없음`);
    return toItem(row);
  }));
}

/**
 * 한 관찰을 둘로 나눈다.
 * 원본은 그대로 두고(내용만 정리하고), 같은 아동·같은 날짜로 새 관찰 1건을 만든다.
 * 한 관찰에 여러 영역이 섞여 들어갔을 때 갈라내기 위한 기능.
 *
 * 새 관찰은 원본의 출처(source)를 물려받는다.
 * 같은 자리에서 나온 기록이므로 출처가 끊기면 나중에 되짚을 수 없기 때문.
 *
 * 다만 source_journal_obs_id 는 물려주지 않는다.
 * 한 후보는 한 번만 가져올 수 있어(unique) 두 행이 같은 후보를 가리킬 수 없고,
 * 나눠서 새로 만든 쪽은 사람이 손으로 갈라낸 것이라 후보에서 온 것도 아니다.
 * 원본 행이 그 연결을 계속 들고 있는다.
 *
 * 원본 수정과 새 행 추가는 DB 함수 split_observation(030) 하나 — 한 트랜잭션이라
 * 어느 쪽이 실패해도 둘 다 없던 일이 된다. 감사 로그는 함수가 성공한 뒤 남긴다
 * (원본 내용 수정분, [수정]과 같은 모양).
 */
export async function splitObservation(
  id: string,
  originalContent: string,
  newContent: string,
  newArea: Area | null,
): Promise<{ original: ObservationItem; created: ObservationItem }> {
  const before = await snapshotRow("observations", id);
  if (!before) throw new NotFoundError("나눌 관찰을 찾지 못했습니다.");

  const { data, error } = await getClient().rpc("split_observation", {
    p_id: id,
    p_original_content: originalContent,
    p_new_content: newContent,
    p_new_area: newArea,
  });
  if (error) {
    if (isAreaCheck(error)) throw new RuleError(AREA_CHECK_MESSAGE);
    throw rpcError(error, { notFound: "나눌 관찰을 찾지 못했습니다." }, "관찰 나누기 실패");
  }

  await auditContentChange(id, before, originalContent);

  const [original, created] = await readItems([id, (data as { created_id: string }).created_id]);
  return { original, created };
}

/**
 * 관찰 1건을 지운다.
 *
 * 일지에서 가져온 관찰이어도 원본 후보(journal_observations)는 그대로 둔다.
 * 후보가 남아 있어야 가져오기 목록에 다시 나타나 되가져올 수 있다.
 * 즉 가져온 관찰을 지우는 것은 "가져오기 취소"에 가깝다.
 */
export async function deleteObservation(id: string): Promise<void> {
  const before = await snapshotRow("observations", id);
  if (!before) throw new NotFoundError("그 관찰을 찾지 못했습니다. 이미 지워졌을 수 있어요.");
  const { error } = await getClient()
    .from("observations")
    .delete()
    .eq("id", id);

  if (error) {
    throw new Error(`관찰 삭제 실패: ${error.message}`);
  }
  await recordAudit({
    action: "delete",
    table_name: "observations",
    record_id: id,
    summary: `관찰 삭제 — ${before?.obs_date ?? ""} ${String(before?.content ?? "").slice(0, 20)}`
      .trim(),
    before,
  });
}

/**
 * 두 관찰을 하나로 합친다. keepId 가 남고 removeId 가 사라진다.
 *
 * 같은 아동·같은 날짜·같은 원본 일지끼리만 합친다.
 * 날짜가 다르면 언제 있었던 일인지가 뭉개지고,
 * 원본 일지가 다르면 근거가 둘인 한 덩어리가 되어 되짚을 수 없다.
 * 화면에서도 그런 곳에는 놓지 못하게 막지만, 마지막 판단은 여기서 한다.
 *
 * [근거(source_journal_obs_id) 는 하나만 남는다]
 * 한 후보는 한 번만 가져올 수 있다(unique). 두 관찰이 각각 후보를 가리키고 있었다면
 * 합쳐진 뒤에도 하나만 남고, 사라진 쪽의 후보는 "가져옴" 이 풀려 다시 가져올 수 있게 된다.
 * 남는 쪽에 근거가 없고 사라지는 쪽에만 있으면 그 연결을 옮겨 온다 — 옮기지 않으면
 * 근거가 통째로 끊기기 때문이다.
 *
 * 남길 쪽 수정 · 근거 옮기기 · 지울 쪽 삭제 · 후보에 "합쳐짐" 표시는 DB 함수
 * merge_observations(030) 하나 — 한 트랜잭션이다. 규칙은 여기서 먼저 보고 사람이 읽을 말로
 * 거절한다(함수도 잠근 뒤 한 번 더 본다). 감사 로그는 함수가 성공한 뒤 예전과 같은 모양으로.
 */
export async function mergeObservations(
  keepId: string,
  removeId: string,
  content: string,
): Promise<{ observation: ObservationItem; released: boolean }> {
  if (keepId === removeId) throw new RuleError("같은 관찰끼리는 합칠 수 없습니다.");

  const client = getClient();
  const TRACE = "source_journal_obs_id, source_journal_id, source_journal_updated_at";

  const { data: rows, error: readError } = await client
    .from("observations")
    .select(`id, child_id, obs_date, area, content, source, ${TRACE}`)
    .in("id", [keepId, removeId]);

  if (readError) {
    throw new Error(`합칠 관찰 조회 실패: ${readError.message}`);
  }

  const keep = (rows ?? []).find((row) => row.id === keepId);
  const remove = (rows ?? []).find((row) => row.id === removeId);
  if (!keep || !remove) throw new NotFoundError("합칠 관찰을 찾지 못했습니다.");

  if (keep.child_id !== remove.child_id) {
    throw new RuleError("같은 아동의 관찰끼리만 합칠 수 있습니다.");
  }
  if (keep.obs_date !== remove.obs_date) {
    throw new RuleError("같은 날짜의 관찰끼리만 합칠 수 있습니다.");
  }
  if ((keep.source_journal_id ?? null) !== (remove.source_journal_id ?? null)) {
    throw new RuleError("같은 일지에서 온 관찰끼리만 합칠 수 있습니다.");
  }

  const { data: done, error: mergeError } = await client.rpc("merge_observations", {
    p_keep_id: keepId,
    p_remove_id: removeId,
    p_content: content,
  });
  if (mergeError) {
    throw rpcError(mergeError, {
      notFound: "합칠 관찰을 찾지 못했습니다.",
      mismatch: "합칠 수 없는 관찰입니다. 화면을 새로 고쳐 주세요.",
    }, "관찰 합치기 실패");
  }
  // released: 사라진 쪽의 후보에 "합쳐짐"을 남겼다(근거를 옮기지 못했을 때)
  const { released } = done as { moved_trace: boolean; released: boolean };

  const { data: merged, error: readMergedError } = await client
    .from("observations")
    .select(`${COLUMNS}, ${TRACE_COLUMNS}`)
    .eq("id", keepId)
    .single();
  if (readMergedError || !merged) {
    throw new Error(`합친 관찰 조회 실패: ${readMergedError?.message ?? "없음"}`);
  }

  // 병합도 삭제다. removeId 가 사라지고 내용만 keepId 안에 남는다.
  await recordAudit({
    action: "delete",
    table_name: "observations",
    record_id: removeId,
    summary: `관찰 병합 — ${keep.obs_date} ${String(remove.content).slice(0, 20)} → ${
      String(keep.content).slice(0, 20)
    }`,
    // 모양을 바꾸지 말 것 — 평가 근거 배너가 {keep, remove} 로 "병합됨"을 가린다(findObservationRemovals)
    before: { keep, remove },
    after: merged,
  });

  return { observation: await toItem(merged), released };
}
