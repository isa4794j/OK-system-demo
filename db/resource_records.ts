/**
 * 자원기록(resource_records) 데이터 접근 — 일지에서 뽑은 자원 활용
 *
 * 규칙: Supabase 호출은 /db 안에서만 한다.
 *
 * 이 파일은 읽고 쓰기만 한다. AI를 부르지 않는다.
 * 뽑아내는 일(일지 읽기 → AI → 저장)은 /lib/extract_resources.ts 가 맡는다.
 * /db 는 "DB를 갈아끼울 때 여기만 고치면 되는 층"이라, 다른 것이 섞이면 안 된다.
 */
import { getClient, NotFoundError, writeError } from "./client.ts";
import { recordAudit, snapshotRow } from "./audit.ts";
import type { Kind } from "./journals.ts";

/**
 * DB의 CHECK 제약과 같은 목록이어야 한다.
 *
 *   Y     통계에 잡힌다. 카테고리가 비어 있으면 "카테고리 미정"으로 모이고 미분류함에 뜬다.
 *   없음  자원이 아니라고 판단한 것. 통계에서 빠진다.
 *   N     레거시 값 — 새로 생기지 않는다. 019 이전의 "검토 대기".
 *         뽑히면 바로 Y 로 들어가고, 못 정한 것은 Y + 카테고리 없음으로 둔다.
 *         [자원 아님] 취소도 Y 로 돌린다. 어느 화면에도 안 나오므로 시스템 점검이 센다.
 *         CHECK 에는 남겨 둔다. 지우면 옛 줄이 있는 DB 에서 마이그레이션이 막힌다.
 */
export const RECORD_STATUSES = ["N", "Y", "없음"] as const;
export type RecordStatus = (typeof RECORD_STATUSES)[number];

export type ResourceRecord = {
  id: string;
  record_date: string; // "YYYY-MM-DD"
  resource_name: string;
  /**
   * 일지에 적혀 있던 그대로의 표기. 사전 별칭을 정식 이름으로 바꾸기 전 값이다.
   * 020 이전 기록은 null — 그때는 남기지 않았다.
   */
  raw_name: string | null;
  category: string | null;
  source: Kind | null;
  journal_id: string | null;
  status: RecordStatus;
};

/** 저장할 때 넘기는 모양. 날짜·출처·일지는 저장하는 쪽이 채운다. */
export type NewResourceRecord = {
  resource_name: string;
  /** 일지에 적힌 그대로. 사전 이름과 같으면 굳이 안 넘겨도 된다. */
  raw_name?: string | null;
  category: string | null;
  /** 안 주면 'Y'. 블랙리스트에 걸린 것은 '없음'으로 바로 들어간다. */
  status?: RecordStatus;
};

/** 검토함에 보여줄 줄. 판단 근거로 원본 일지 일부를 함께 준다. */
export type PendingRecord = ResourceRecord & {
  journal_title: string | null;
  /** 일지 본문 앞부분. 전체는 일지 화면에서 본다. */
  journal_excerpt: string | null;
};

/** '자원 아님'으로 둔 이름 하나와 그렇게 둔 기록 수 */
export type RejectedName = {
  name: string;
  count: number;
};

/** 검토함에 실을 본문 길이. 판단에는 이 정도면 되고, 더 길면 목록이 글이 된다. */
const EXCERPT_LEN = 120;

const COLUMNS = "id, record_date, resource_name, raw_name, category, source, journal_id, status";

/** 같은 자원인지 볼 때 쓰는 열쇠. 앞뒤 공백과 대소문자를 무시한다. */
function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

/** 한 일지에서 뽑힌 자원기록을 모두 읽는다. 검토 화면이 쓴다. */
export async function listByJournal(journalId: string): Promise<ResourceRecord[]> {
  const { data, error } = await getClient()
    .from("resource_records")
    .select(COLUMNS)
    .eq("journal_id", journalId)
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(`자원기록 조회 실패: ${error.message}`);
  }
  return (data ?? []) as ResourceRecord[];
}

/**
 * 아직 검토하지 않은 기록. 검토함이 쓴다.
 *
 * 원본 일지의 제목과 본문 앞부분을 함께 준다.
 * "나무탑이 정말 젠가인가"는 일지를 읽어야 판단할 수 있는데,
 * 검토함은 여러 일지의 것을 한 화면에 모으므로 그 글이 옆에 있어야 한다.
 */
export async function listPendingRecords(limit = 200): Promise<PendingRecord[]> {
  const { data, error } = await getClient()
    .from("resource_records")
    .select(`${COLUMNS}, journal:journals(title, content)`)
    .eq("status", "Y")
    .is("category", null)
    .order("record_date", { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(`카테고리 미정 자원 조회 실패: ${error.message}`);
  }

  // deno-lint-ignore no-explicit-any
  return (data ?? []).map((row: any) => {
    const { journal, ...rest } = row;
    const content: string = journal?.content ?? "";
    return {
      ...rest,
      journal_title: journal?.title ?? null,
      journal_excerpt: content
        ? content.slice(0, EXCERPT_LEN) + (content.length > EXCERPT_LEN ? "…" : "")
        : null,
    } as PendingRecord;
  });
}

/** '자원 아님'으로 둔 이름들. 같은 이름은 한 줄로 모으고 몇 건인지 센다. */
export async function listRejectedNames(): Promise<RejectedName[]> {
  const { data, error } = await getClient()
    .from("resource_records")
    .select("resource_name")
    .eq("status", "없음");

  if (error) {
    throw new Error(`자원 아님 목록 조회 실패: ${error.message}`);
  }

  const counts = new Map<string, RejectedName>();
  for (const row of data ?? []) {
    const key = nameKey(row.resource_name);
    const found = counts.get(key);
    if (found) found.count += 1;
    else counts.set(key, { name: row.resource_name.trim(), count: 1 });
  }

  return [...counts.values()].sort((a, b) => a.name.localeCompare(b.name, "ko"));
}

/**
 * 그 이름의 기록 id 들. 상태를 주면 그 상태만.
 *
 * PostgREST 로는 lower(trim()) 비교를 할 수 없어 읽어 와서 앱에서 거른다.
 * 이름 하나에 딸린 기록은 많아야 수십 줄이다.
 */
async function idsByName(name: string, status?: RecordStatus): Promise<string[]> {
  let query = getClient()
    .from("resource_records")
    .select("id, resource_name");
  if (status) query = query.eq("status", status);

  const { data, error } = await query;
  if (error) {
    throw new Error(`자원기록 조회 실패: ${error.message}`);
  }

  const key = nameKey(name);
  return (data ?? [])
    .filter((row) => nameKey(row.resource_name) === key)
    .map((row) => row.id);
}

/** 그 이름의 기록이 몇 건인지. 병합·자원 아님 확인창에 적는다. */
export async function countRecordsByName(name: string): Promise<number> {
  return (await idsByName(name)).length;
}

/**
 * 한 이름의 기록을 다른 이름으로 옮긴다. 병합이 쓴다.
 * 상태는 그대로 둔다 — 잡혀 있던 것은 잡힌 채로, '자원 아님'은 그대로 옮겨 간다.
 *
 * 같은 일지에 to 이름이 이미 있으면 unique 인덱스에 걸린다.
 * 그 줄만 남기고 나머지를 옮기면 되지만, 지금은 드문 경우라 그대로 실패시킨다.
 */
export async function moveRecords(
  fromName: string,
  toName: string,
  toCategory: string | null,
): Promise<number> {
  const ids = await idsByName(fromName);
  if (ids.length === 0) return 0;

  const { error } = await getClient()
    .from("resource_records")
    .update({ resource_name: toName, category: toCategory })
    .in("id", ids);

  if (error) {
    if (/duplicate key|idx_resource_records_journal_name|23505/i.test(error.message)) {
      throw new Error(`같은 일지에 "${toName}" 기록이 이미 있어 옮기지 못했습니다.`);
    }
    throw new Error(`자원기록 이동 실패: ${error.message}`);
  }
  return ids.length;
}

/**
 * 사전 이름 아래 묶여 있던 기록 중 "그 별칭으로 적혀 있던 것"만 새 이름으로 옮긴다.
 * 별칭 분리(합치기의 역동작)가 쓴다.
 *
 * raw_name 이 비어 있는 줄은 건드리지 않는다. 020 이전에 쌓인 기록이라
 * 어느 표기로 들어왔는지 알 수 없다. 추측해 옮기면 틀린 기록을 만든다.
 */
export async function moveRecordsByRawName(
  fromName: string,
  alias: string,
  toName: string,
  toCategory: string | null,
): Promise<number> {
  const { data, error } = await getClient()
    .from("resource_records")
    .select("id, resource_name, raw_name");

  if (error) {
    throw new Error(`자원기록 조회 실패: ${error.message}`);
  }

  const from = nameKey(fromName);
  const key = nameKey(alias);
  const ids = (data ?? [])
    .filter((row) =>
      nameKey(row.resource_name) === from && row.raw_name && nameKey(row.raw_name) === key
    )
    .map((row) => row.id);
  if (ids.length === 0) return 0;

  const { error: moveError } = await getClient()
    .from("resource_records")
    .update({ resource_name: toName, category: toCategory })
    .in("id", ids);

  if (moveError) {
    if (/duplicate key|idx_resource_records_journal_name|23505/i.test(moveError.message)) {
      throw new Error(`같은 일지에 "${toName}" 기록이 이미 있어 옮기지 못했습니다.`);
    }
    throw new Error(`자원기록 이동 실패: ${moveError.message}`);
  }
  return ids.length;
}

/**
 * 그 이름의 기록 중 원래 표기를 모르는 것이 몇 건인지.
 * 분리 확인창에 "N건은 그대로 남습니다"라고 적는 데 쓴다.
 */
export async function countUnknownRawName(name: string): Promise<number> {
  const { data, error } = await getClient()
    .from("resource_records")
    .select("resource_name, raw_name");

  if (error) {
    throw new Error(`자원기록 조회 실패: ${error.message}`);
  }

  const key = nameKey(name);
  return (data ?? []).filter((row) => nameKey(row.resource_name) === key && !row.raw_name).length;
}

/** 한 이름의 기록 상태를 통째로 바꾼다. from 을 주면 그 상태인 것만. */
export async function setStatusByName(
  name: string,
  to: RecordStatus,
  from?: RecordStatus,
): Promise<string[]> {
  const ids = await idsByName(name, from);
  if (ids.length === 0) return [];

  const { error } = await getClient()
    .from("resource_records")
    .update({ status: to })
    .in("id", ids);

  if (error) {
    throw new Error(`자원기록 상태 변경 실패: ${error.message}`);
  }
  return ids;
}

/**
 * [자원 아님] 과 그 취소를 감사 로그에 한 줄로 남긴다.
 *
 * 한 번에 기록 여러 건의 상태가 바뀌고(통계에서 빠지거나 돌아온다) 블랙리스트도 바뀐다.
 * 어느 기록이 바뀌었는지 id 를 함께 적는다 — 되돌릴 때 이 줄만 보면 된다.
 */
export async function recordRejectionAudit(input: {
  kind: "reject" | "restore";
  name: string;
  recordIds: string[];
}): Promise<void> {
  const reject = input.kind === "reject";
  await recordAudit({
    action: "update",
    table_name: "resource_records",
    record_id: null,
    summary: reject
      ? `자원 아님 처리 — ${input.name} (기록 ${input.recordIds.length}건 '없음', 블랙리스트에 추가)`
      : `자원 아님 취소 — ${input.name} (기록 ${input.recordIds.length}건 'Y', 블랙리스트에서 뺌)`,
    before: {
      name: input.name,
      status: reject ? "Y 또는 N" : "없음",
      blacklisted: !reject,
      record_ids: input.recordIds,
    },
    after: {
      name: input.name,
      status: reject ? "없음" : "Y",
      blacklisted: reject,
    },
  });
}

/**
 * 그 이름으로 남은 기록의 카테고리를 통째로 바꾼다. 바꾼 건수를 돌려준다.
 *
 * 기록은 뽑힐 때의 카테고리를 제 칸에 적어 둔다. 그래서 자원사전에서 카테고리를 고쳐도
 * 이미 쌓인 기록은 옛 묶음에 그대로 남았다 — 사람이 고쳤는데 통계는 안 움직이는 셈이다.
 * 사전을 고치면 지난 기록까지 함께 옮긴다.
 *
 * "자원 아님"으로 둔 기록은 건드리지 않는다. 통계 밖에 있는 줄이라 옮길 묶음이 없다.
 */
export async function setCategoryByName(name: string, category: string | null): Promise<number> {
  const ids = await idsByName(name);
  if (ids.length === 0) return 0;

  const { data, error } = await getClient()
    .from("resource_records")
    .update({ category })
    .in("id", ids)
    .neq("status", "없음")
    .select("id");

  if (error) {
    throw new Error(`자원기록 카테고리 변경 실패: ${error.message}`);
  }
  return (data ?? []).length;
}

/**
 * 카테고리 이름이 바뀌었을 때 기록도 새 이름으로 옮긴다. 옮긴 건수를 돌려준다.
 *
 * 통계는 기록의 category 로 묶는다. 사전(resources)만 옮기면 통계에는
 * 목록에서 사라진 옛 이름이 계속 남는다. '자원 아님' 줄도 옮긴다 — 이름표일 뿐이다.
 */
export async function renameCategoryInRecords(from: string, to: string): Promise<number> {
  const { data, error } = await getClient()
    .from("resource_records")
    .update({ category: to })
    .eq("category", from)
    .select("id");

  if (error) {
    throw new Error(`자원기록 카테고리 이름 변경 실패: ${error.message}`);
  }
  return (data ?? []).length;
}

/** 다시 분석했을 때 카테고리가 갈린 한 건 */
export type ChangedRecord = {
  id: string;
  resource_name: string;
  current: string | null;
  proposed: string | null;
};

/**
 * 다시 분석한 결과와 지금 있는 것의 차이.
 * 관찰(journal_observations)의 ExtractDiff 와 같은 생각이다.
 */
export type ResourceDiff = {
  added: ResourceRecord[];
  changed: ChangedRecord[];
  missing: ResourceRecord[];
  /** 사람이 이미 손댄 줄 수 (카테고리를 채웠거나 '자원 아님') */
  kept: number;
};

/**
 * 다시 뽑은 자원을 지금 있는 것과 견주어, 새로 나온 것만 넣고 나머지는 알린다.
 *
 * 사람이 이미 판단한 줄(Y·없음)은 건드리지 않는다.
 * 카테고리를 채운 것을 지우면 통계가 사라지고, "자원이 아니다"라고 한 것을 지우면
 * 다시 뽑을 때마다 같은 것을 또 묻게 된다.
 *
 * 아직 아무도 안 본 'N' 도 조용히 갈아 끼우지 않는다.
 * 예전에는 통째로 지우고 새로 넣어서, 검토하려고 열어 둔 목록이 다시 분석 한 번에
 * 다른 것으로 바뀌어 있었다. 지금은 이름으로 짝을 지어
 * 없어진 것과 카테고리가 달라진 것만 짚어 사람에게 묻는다.
 */
export async function applyResourceExtraction(
  journalId: string,
  recordDate: string,
  source: Kind | null,
  items: NewResourceRecord[],
): Promise<ResourceDiff> {
  const client = getClient();

  const { data: existing, error: readError } = await client
    .from("resource_records")
    .select(COLUMNS)
    .eq("journal_id", journalId);

  if (readError) {
    throw new Error(`이전 추출 결과 조회 실패: ${readError.message}`);
  }

  const rows = (existing ?? []) as ResourceRecord[];
  // 사람이 판단한 것: "자원 아님" 이거나 카테고리가 정해진 것.
  // 카테고리가 비어 있는 것만 아직 아무도 안 본 줄이다.
  const decided = rows.filter((row) => row.status === "없음" || row.category !== null);
  const open = rows.filter((row) => row.status !== "없음" && row.category === null);

  const decidedNames = new Set(decided.map((row) => nameKey(row.resource_name)));
  const openByName = new Map(open.map((row) => [nameKey(row.resource_name), row]));

  const toInsert: NewResourceRecord[] = [];
  const changed: ChangedRecord[] = [];
  /** 이번 결과에 나온 이름. 여기 없는 옛 줄이 "안 나온 것" 이다. */
  const seen = new Set<string>();

  for (const item of items) {
    const key = nameKey(item.resource_name);
    // 이번 결과 안에서 같은 이름이 두 번 나오면 한 번만 본다
    if (!key || seen.has(key)) continue;
    seen.add(key);

    // 사람이 이미 판단한 이름은 손대지 않는다
    if (decidedNames.has(key)) continue;

    const old = openByName.get(key);
    if (!old) {
      toInsert.push(item);
      continue;
    }
    // 이름은 같은데 카테고리가 달라졌다 — 통계가 갈리는 자리라 사람이 고른다
    if ((old.category ?? null) !== (item.category ?? null)) {
      changed.push({
        id: old.id,
        resource_name: old.resource_name,
        current: old.category,
        proposed: item.category,
      });
    }
  }

  const missing = open.filter((row) => !seen.has(nameKey(row.resource_name)));

  let added: ResourceRecord[] = [];
  if (toInsert.length > 0) {
    const { data, error: insertError } = await client
      .from("resource_records")
      .insert(toInsert.map((item) => ({
        record_date: recordDate,
        resource_name: item.resource_name,
        // 일지에 적힌 그대로. 나중에 별칭을 다시 떼어낼 때 이 값으로 찾는다.
        raw_name: item.raw_name ?? item.resource_name,
        category: item.category,
        source,
        journal_id: journalId,
        // 확정을 기다리지 않는다. 카테고리를 못 정했으면 category 가 비어 있고,
        // 그것이 곧 "미분류" 다 — 통계에는 잡히되 미분류함에서 사람이 채운다.
        status: item.status ?? "Y",
        extracted_at: new Date().toISOString(),
      })))
      .select(COLUMNS);

    if (insertError) {
      throw new Error(`자원기록 저장 실패: ${insertError.message}`);
    }
    added = (data ?? []) as ResourceRecord[];
  }

  return { added, changed, missing, kept: decided.length };
}

/**
 * 사람이 고른 대로 마무리한다.
 *
 * replace 는 "새 것으로" 를 고른 줄의 카테고리다.
 * remove 는 "삭제" 를 고른 줄이다.
 * 사람이 이미 판단한 줄('없음'이거나 카테고리가 정해진 것)은 어느 쪽으로도 건드리지 않는다 —
 * 요청은 브라우저에서 오므로 여기서 한 번 더 거른다.
 */
export async function resolveResourceExtraction(
  journalId: string,
  replace: Array<{ id: string; category: string | null }>,
  remove: string[],
): Promise<ResourceRecord[]> {
  const client = getClient();
  const touched = [...replace.map((one) => one.id), ...remove];

  if (touched.length > 0) {
    const { data, error } = await client
      .from("resource_records")
      .select("id, status, category")
      .eq("journal_id", journalId)
      .in("id", touched);

    if (error) throw new Error(`고를 기록 조회 실패: ${error.message}`);

    const allowed = new Set(
      (data ?? []).filter((row) => row.status !== "없음" && row.category === null)
        .map((row) => row.id),
    );

    for (const one of replace) {
      if (!allowed.has(one.id)) continue;
      const { error: updateError } = await client
        .from("resource_records")
        .update({ category: one.category })
        .eq("id", one.id);
      if (updateError) throw new Error(`자원기록 바꾸기 실패: ${updateError.message}`);
    }

    const removable = remove.filter((id) => allowed.has(id));
    if (removable.length > 0) {
      // 지우기 전에 값을 잡아 둔다. 삭제는 전부 감사 로그에 남긴다(원칙 8).
      const { data: gone, error: readError } = await client
        .from("resource_records")
        .select("*")
        .in("id", removable);
      if (readError) throw new Error(`지울 자원기록 읽기 실패(감사용): ${readError.message}`);

      const { error: deleteError } = await client
        .from("resource_records")
        .delete()
        .in("id", removable);
      if (deleteError) throw new Error(`자원기록 삭제 실패: ${deleteError.message}`);

      for (const row of gone ?? []) {
        await recordAudit({
          action: "delete",
          table_name: "resource_records",
          record_id: row.id,
          summary: `다시 분석 결과 반영 — 자원기록 삭제: ${row.resource_name ?? ""}`,
          before: row,
        });
      }
    }
  }

  return await listByJournal(journalId);
}

/**
 * 기록 하나를 고친다. 이름·카테고리·상태를 넘긴 것만 바꾼다.
 *
 * '자원 아님'과 그 되돌리기도 이 함수로 한다. 상태를 바꾸는 일이고,
 * 그때 이름이나 카테고리를 함께 고치는 일이 흔하기 때문이다.
 * 따로 두면 화면이 두 번 저장해야 한다.
 */
export async function updateRecord(
  id: string,
  patch: { resource_name?: string; category?: string | null; status?: RecordStatus },
): Promise<ResourceRecord> {
  const changes: Record<string, unknown> = {};
  if (patch.resource_name !== undefined) changes.resource_name = patch.resource_name;
  if (patch.category !== undefined) changes.category = patch.category;
  if (patch.status !== undefined) changes.status = patch.status;

  if (Object.keys(changes).length === 0) {
    throw new Error("바꿀 내용이 없습니다.");
  }

  const { data, error } = await getClient()
    .from("resource_records")
    .update(changes)
    .eq("id", id)
    .select(COLUMNS)
    .single();

  if (error) {
    // 같은 일지에 같은 이름이 이미 있는 경우다. 이름을 고치다 부딪힐 수 있다.
    if (/duplicate key|idx_resource_records_journal_name|23505/i.test(error.message)) {
      throw new Error(`이 일지에는 "${patch.resource_name}" 이(가) 이미 있습니다.`);
    }
    throw writeError(
      error,
      "자원기록 수정 실패",
      "그 자원기록을 찾지 못했습니다. 이미 지워졌을 수 있어요.",
    );
  }
  return data as ResourceRecord;
}

export async function deleteRecord(id: string): Promise<void> {
  const before = await snapshotRow("resource_records", id);
  if (!before) throw new NotFoundError("그 자원기록을 찾지 못했습니다. 이미 지워졌을 수 있어요.");
  const { error } = await getClient()
    .from("resource_records")
    .delete()
    .eq("id", id);

  if (error) {
    throw new Error(`자원기록 삭제 실패: ${error.message}`);
  }
  await recordAudit({
    action: "delete",
    table_name: "resource_records",
    record_id: id,
    summary: `자원기록 삭제 — ${before?.record_date ?? ""} ${before?.resource_name ?? ""}`.trim(),
    before,
  });
}

/**
 * 그 일지에서 뽑힌 기록이 몇 건인지. 일지 삭제 확인창에 적는다.
 *
 * 상태를 가리지 않는다. 일지를 지우면 '없음'으로 둔 것까지 다 사라지므로,
 * 확인창에 적는 수도 실제로 사라질 수와 같아야 한다.
 */
export async function countRecordsFromJournal(journalId: string): Promise<number> {
  const { count, error } = await getClient()
    .from("resource_records")
    .select("id", { count: "exact", head: true })
    .eq("journal_id", journalId);

  if (error) {
    throw new Error(`자원기록 확인 실패: ${error.message}`);
  }
  return count ?? 0;
}

/**
 * 한 일지에서 뽑힌 자원기록을 모두 지운다. 일지를 지우기 직전에 부른다.
 *
 * 왜 지우는지는 db/journals.ts 의 deleteJournal 주석에 적었다.
 * 감사 로그는 일지 삭제 한 줄에 값째 담기므로 여기서는 따로 남기지 않는다 —
 * 두 줄로 나뉘면 되짚을 때 짝을 맞춰야 한다.
 */
export async function deleteRecordsByJournal(journalId: string): Promise<void> {
  const { error } = await getClient()
    .from("resource_records")
    .delete()
    .eq("journal_id", journalId);

  if (error) {
    throw new Error(`자원기록 삭제 실패: ${error.message}`);
  }
}
