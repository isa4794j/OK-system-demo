/**
 * 일지에서 뽑아낸 관찰 후보(journal_observations) 데이터 접근
 *
 * 규칙: Supabase 호출은 /db 안에서만 한다.
 *
 * 이 파일은 읽고 쓰기만 한다. AI를 부르지 않는다.
 * 뽑아내는 일(일지 읽기 → AI → 저장)은 /lib/extract_observations.ts 가 맡는다.
 * /db 는 "DB를 갈아끼울 때 여기만 고치면 되는 층"이라, 다른 것이 섞이면 안 된다.
 */
import { getClient, NotFoundError, rpcError, RuleError, writeError } from "./client.ts";
import { recordAudit, snapshotRow } from "./audit.ts";
import type { Area, Source } from "./observations.ts";
// 순수 계산만 든 잎 모듈이라 어느 층에서 불러도 층이 꼬이지 않는다.
import { similarity } from "../lib/similarity.ts";

/** 후보 아동 한 명. 아동을 못 가렸을 때 고르라고 보여 줄 최소 정보. */
export type PendingChild = { id: string; name: string };

export type JournalObservation = {
  id: string;
  journal_id: string;
  /** null 이면 아직 어느 아동인지 사람이 정하지 않았다 */
  child_id: string | null;
  /** 화면에 이름을 보여주기 위해 조인해서 함께 읽는다 */
  child_name: string | null;
  area: Area | null;
  content: string;
  /** 이미 아동 관찰(observations)로 가져갔는지. 지우거나 합칠 때 경고에 쓴다. */
  imported: boolean;
  /** child_id 가 비어 있을 때의 후보 아동들. 실재하는 아동만 담는다. */
  pending: PendingChild[];
  /** 다른 관찰에 합쳐졌는가. 그렇다면 다시 가져오면 안 된다. */
  merged: boolean;
  /** 사람이 손댔는가. 다시 분석해도 지우지 않는다는 뜻이다. */
  edited: boolean;
};

/** 저장할 때 넘기는 모양. id와 journal_id는 저장하는 쪽이 채운다. */
export type NewJournalObservation = {
  /** 누구인지 가리지 못했으면 null. 그때는 pending_child_ids 를 채운다. */
  child_id: string | null;
  area: Area | null;
  content: string;
  /** 아동을 못 가렸을 때의 후보 아동 id 들 */
  pending_child_ids?: string[] | null;
};

// 한 줄로 둔다. 이어 붙여 쓰면 supabase-js 가 select 를 타입으로 읽지 못한다.
// deno-fmt-ignore
const COLUMNS = "id, journal_id, child_id, area, content, pending_child_ids, merged_into, merged_at, edited_at, child:children_identity(name)";

// 다시 분석할 때 "사람이 손댔는가" 를 함께 본다. 이것도 한 줄이어야 타입이 읽힌다.
// deno-fmt-ignore
const COLUMNS_WITH_FLAGS = "id, journal_id, child_id, area, content, pending_child_ids, merged_into, merged_at, edited_at, child:children_identity(name)";

/**
 * 조인 결과를 화면이 쓰기 쉬운 모양으로 편다.
 *
 * pendingNames 는 후보 아동 id → 이름. pending_child_ids 에는 외래키가 없어
 * 지워진 아동의 id 가 남을 수 있는데, 그 표에 없으므로 자연히 빠진다.
 */
function flatten(
  // deno-lint-ignore no-explicit-any
  row: any,
  imported = false,
  pendingNames: Map<string, string> = new Map(),
): JournalObservation {
  const { child, pending_child_ids, merged_into, merged_at, edited_at, ...rest } = row;

  const pending: PendingChild[] = (pending_child_ids ?? [])
    .filter((id: string) => pendingNames.has(id))
    .map((id: string) => ({ id, name: pendingNames.get(id)! }));

  return {
    ...rest,
    child_name: child?.name ?? null,
    imported,
    pending,
    // merged_into 는 살아남은 후보마저 지워지면 NULL 이 된다.
    // 합쳐졌다는 사실 자체는 merged_at 이 들고 있다.
    merged: !!merged_into || !!merged_at,
    edited: !!edited_at,
  } as JournalObservation;
}

/** 행 하나를 화면용으로 편다. 후보 아동 이름까지 채운다. */
// deno-lint-ignore no-explicit-any
async function toItem(row: any, imported: boolean): Promise<JournalObservation> {
  return flatten(row, imported, await pendingChildNames([row.pending_child_ids]));
}

/** 후보 아동 id 들의 이름을 한 번에 읽는다. 없는 아동은 그냥 빠진다. */
async function pendingChildNames(
  idLists: Array<string[] | null | undefined>,
): Promise<Map<string, string>> {
  const ids = [...new Set(idLists.flatMap((list) => list ?? []))];
  if (ids.length === 0) return new Map();

  const { data, error } = await getClient()
    .from("children_identity")
    .select("id, name")
    .in("id", ids);

  if (error) {
    throw new Error(`후보 아동 조회 실패: ${error.message}`);
  }
  return new Map((data ?? []).map((row) => [row.id as string, row.name as string]));
}

/**
 * 이 후보들 중 이미 아동 관찰(observations)로 가져간 것의 id.
 *
 * 후보를 지우거나 합치거나 다시 뽑기 전에 늘 물어보는 것이라 한곳에 둔다.
 * 물어보는 곳마다 따로 쓰면 어디선가만 안 물어보는 일이 생긴다.
 */
async function takenCandidateIds(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();

  const { data, error } = await getClient()
    .from("observations")
    .select("source_journal_obs_id")
    .in("source_journal_obs_id", ids);

  if (error) {
    throw new Error(`가져온 관찰 확인 실패: ${error.message}`);
  }
  return new Set((data ?? []).map((row) => row.source_journal_obs_id as string));
}

/** 한 일지에서 뽑힌 관찰 후보를 모두 읽는다. */
export async function listByJournal(journalId: string): Promise<JournalObservation[]> {
  const { data, error } = await getClient()
    .from("journal_observations")
    .select(COLUMNS)
    .eq("journal_id", journalId)
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(`추출 관찰 조회 실패: ${error.message}`);
  }

  const rows = data ?? [];
  const [taken, names] = await Promise.all([
    takenCandidateIds(rows.map((row) => row.id)),
    pendingChildNames(rows.map((row) => row.pending_child_ids)),
  ]);
  return rows.map((row) => flatten(row, taken.has(row.id), names));
}

/** 다시 분석했을 때 사람이 골라야 하는 한 건 */
export type ChangedCandidate = {
  id: string;
  child_id: string | null;
  child_name: string | null;
  /** 지금 저장돼 있는 내용 */
  current: string;
  /** 이번 분석이 내놓은 내용 */
  proposed: string;
};

/**
 * 다시 분석한 결과와 지금 있는 것의 차이.
 *
 * 사람이 고를 것과 그냥 해도 되는 것을 갈라 둔다.
 *   added    새로 나온 것 — 그냥 넣는다. 없던 것이 생기는 데 고민할 것이 없다.
 *   changed  같은 아이의 같은 자리인데 말이 달라진 것 — 어느 쪽을 둘지 사람이 고른다.
 *   missing  이번엔 안 나온 것 — 지울지 둘지 사람이 고른다.
 *   kept     사람이 손댄 것 — 건드리지 않는다. 고를 것도 없다.
 */
export type ExtractDiff = {
  added: JournalObservation[];
  changed: ChangedCandidate[];
  missing: JournalObservation[];
  kept: number;
};

/**
 * 같은 관찰로 볼 만큼 닮았다고 인정하는 선.
 *
 * 낮추면 상관없는 두 문장이 "고쳐졌다"고 나란히 서고,
 * 높이면 말을 조금 바꿔 쓴 같은 관찰이 "지워졌다 + 새로 생겼다"로 갈라진다.
 * 말투만 다듬은 문장은 0.5~0.8, 아예 다른 내용은 0.1 아래로 나온다.
 */
const PAIR_MIN = 0.4;

/**
 * 옛 줄과 새 줄을 내용으로 짝짓는다.
 *
 * 순서대로 짝지으면 AI 가 같은 내용을 다른 차례로 내놓을 때마다
 * 멀쩡한 두 건이 서로 "바뀌었다"고 나란히 서서, 사람이 읽어도 무슨 말인지 알 수 없다.
 *
 *   1. 글자까지 똑같은 것을 먼저 뺀다. 고를 것이 없는 짝이다.
 *   2. 남은 것끼리 가장 닮은 짝부터 하나씩 맺는다.
 *   3. PAIR_MIN 에 못 미치면 짝을 맺지 않는다 —
 *      옛 줄은 "이번에 안 나옴", 새 줄은 "새로 나옴" 이 된다.
 */
export function pairByContent<O extends { content: string }, N extends { content: string }>(
  olds: O[],
  news: N[],
): { pairs: Array<[O, N]>; oldLeft: O[]; newLeft: N[] } {
  const oldLeft = [...olds];
  const newLeft = [...news];
  const pairs: Array<[O, N]> = [];

  // 1) 똑같은 것부터 맺어 없앤다. 닮은 정도를 따질 것도 없다.
  for (let i = oldLeft.length - 1; i >= 0; i -= 1) {
    const same = newLeft.findIndex((one) => one.content.trim() === oldLeft[i].content.trim());
    if (same < 0) continue;
    oldLeft.splice(i, 1);
    newLeft.splice(same, 1);
  }

  // 2) 남은 것 중 가장 닮은 짝부터. 한 줄은 한 번만 맺는다.
  for (;;) {
    let best = { score: 0, oldAt: -1, newAt: -1 };
    for (let i = 0; i < oldLeft.length; i += 1) {
      for (let j = 0; j < newLeft.length; j += 1) {
        const score = similarity(oldLeft[i].content, newLeft[j].content);
        if (score > best.score) best = { score, oldAt: i, newAt: j };
      }
    }
    if (best.score < PAIR_MIN) break;

    pairs.push([oldLeft[best.oldAt], newLeft[best.newAt]]);
    oldLeft.splice(best.oldAt, 1);
    newLeft.splice(best.newAt, 1);
  }

  return { pairs, oldLeft, newLeft };
}

/** 아동별로 줄을 모은다. 아동을 못 가린 것끼리는 한 무리로 본다. */
function groupByChild<T extends { child_id: string | null }>(rows: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = row.child_id ?? "?";
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  return groups;
}

/**
 * 다시 뽑은 결과를 지금 있는 것과 견주어, 새로 나온 것만 넣고 나머지는 알린다.
 *
 * [왜 통째로 갈아끼우지 않나]
 * 예전에는 손 안 댄 후보를 모두 지우고 새로 넣었다. 그런데 AI 는 부를 때마다
 * 말을 조금씩 다르게 쓴다. 그래서 다시 분석할 때마다 멀쩡하던 문장이 소리 없이
 * 다른 문장으로 바뀌었고, 무엇이 어떻게 바뀌었는지 사람은 알 수 없었다.
 * 지금은 달라진 것만 짚어 사람에게 묻는다.
 *
 * [짝을 어떻게 짓나]
 * 아동별로 묶어 순서대로 짝짓는다. 같은 아이의 첫 줄은 첫 줄과, 둘째는 둘째와.
 * 남는 새 줄은 added, 남는 옛 줄은 missing 이다.
 * 글자까지 같으면 아무 일도 하지 않는다 — 고를 것이 없다.
 *
 * 사람이 손댄 후보(가져옴·합쳐짐·직접 고침)가 있는 아이는 통째로 건너뛴다.
 * 그 아이의 줄은 이미 사람의 것이고, 옆에 비슷한 줄을 또 만들면 치울 일만 는다.
 */
export async function applyExtraction(
  journalId: string,
  items: NewJournalObservation[],
): Promise<ExtractDiff> {
  const client = getClient();

  const { data: existing, error: readError } = await client
    .from("journal_observations")
    .select(COLUMNS_WITH_FLAGS)
    .eq("journal_id", journalId)
    .order("created_at", { ascending: true });

  if (readError) {
    throw new Error(`이전 추출 결과 조회 실패: ${readError.message}`);
  }

  const rows = existing ?? [];
  const taken = await takenCandidateIds(rows.map((row) => row.id));

  // 사람이 손댄 줄. 다시 분석한다고 없어지거나 바뀌어서는 안 된다.
  //   가져감  지우면 그 관찰의 근거가 끊긴다
  //   합쳐짐  지우면 표시가 사라져 다시 가져올 수 있게 되고, 같은 내용이 두 번 들어간다
  //   고침    내용을 다듬거나 나누거나 아동을 정해 둔 것
  // deno-lint-ignore no-explicit-any
  const isProtected = (row: any) => isProtectedCandidate(row, taken);

  const protectedRows = rows.filter(isProtected);
  const openRows = rows.filter((row) => !isProtected(row));

  /** 사람이 손댄 줄이 있는 아이. 그 아이는 이번 결과에서 통째로 뺀다. */
  const protectedChildren = new Set(
    protectedRows.map((row) => row.child_id).filter((id): id is string => !!id),
  );

  const oldGroups = groupByChild(openRows);
  const newGroups = groupByChild(
    items.filter((item) => !(item.child_id && protectedChildren.has(item.child_id))),
  );

  const toInsert: NewJournalObservation[] = [];
  const changed: ChangedCandidate[] = [];
  const missingRows: typeof openRows = [];

  for (const [child, olds] of oldGroups) {
    const news = newGroups.get(child) ?? [];
    const { pairs, oldLeft, newLeft } = pairByContent(olds, news);

    for (const [old, fresh] of pairs) {
      changed.push({
        id: old.id,
        child_id: old.child_id,
        // 조인 결과는 타입상 배열로 잡힌다. flatten 과 같은 방식으로 읽는다.
        // deno-lint-ignore no-explicit-any
        child_name: (old.child as any)?.name ?? null,
        current: old.content,
        proposed: fresh.content,
      });
    }
    // 짝을 못 찾은 옛 줄은 이번에 안 나온 것, 남는 새 줄은 새로 나온 것이다
    missingRows.push(...oldLeft);
    toInsert.push(...newLeft);
  }

  // 옛 줄이 아예 없던 아이는 통째로 새로 나온 것이다
  for (const [child, news] of newGroups) {
    if (!oldGroups.has(child)) toInsert.push(...news);
  }

  const added = toInsert.length > 0 ? await insertCandidates(journalId, toInsert) : [];
  const names = await pendingChildNames(missingRows.map((row) => row.pending_child_ids));

  return {
    added,
    changed,
    missing: missingRows.map((row) => flatten(row, false, names)),
    kept: protectedRows.length,
  };
}

/** 새 후보를 넣고 넣은 것을 돌려준다. */
async function insertCandidates(
  journalId: string,
  items: NewJournalObservation[],
): Promise<JournalObservation[]> {
  const { data, error } = await getClient()
    .from("journal_observations")
    .insert(items.map((item) => ({
      journal_id: journalId,
      child_id: item.child_id,
      area: item.area,
      content: item.content,
      // 아동을 가린 후보에는 후보 목록을 남기지 않는다. 남으면 화면이 헷갈린다.
      pending_child_ids: item.child_id ? null : (item.pending_child_ids ?? null),
    })))
    .select(COLUMNS);

  if (error) {
    throw new Error(`추출 관찰 저장 실패: ${error.message}`);
  }

  const rows = data ?? [];
  const names = await pendingChildNames(rows.map((row) => row.pending_child_ids));
  return rows.map((row) => flatten(row, false, names));
}

/**
 * 사람이 고른 대로 마무리한다.
 *
 * replace 는 "새 것으로" 를 고른 줄이다. edited_at 을 찍지 않는다 —
 * 기계가 내놓은 말을 받아들인 것이지 사람이 고쳐 쓴 것이 아니기 때문이다.
 * 찍어 버리면 다음 분석부터 그 줄이 영영 얼어붙는다.
 *
 * remove 는 "삭제" 를 고른 줄이다. 사람이 손댄 줄은 여기 올 수 없지만,
 * 요청은 브라우저에서 오므로 한 번 더 거른다.
 */
/**
 * 사람이 손댄 후보인가 — 다시 분석해도, 고르기(resolve)로도 바뀌거나 지워지지 않는다.
 *   가져감(taken)  지우면 그 관찰의 근거가 끊긴다
 *   합쳐짐         지우면 표시가 사라져 다시 가져올 수 있게 되고, 같은 내용이 두 번 들어간다
 *   고침           내용을 다듬거나 나누거나 아동을 정해 둔 것
 */
export function isProtectedCandidate(
  row: { id: string; merged_at?: string | null; edited_at?: string | null },
  taken: Set<string>,
): boolean {
  return taken.has(row.id) || !!row.merged_at || !!row.edited_at;
}

export async function resolveExtraction(
  journalId: string,
  replace: Array<{ id: string; content: string }>,
  remove: string[],
): Promise<JournalObservation[]> {
  const client = getClient();
  const touched = [...replace.map((one) => one.id), ...remove];

  if (touched.length > 0) {
    const { data, error } = await client
      .from("journal_observations")
      .select("id, merged_at, edited_at")
      .eq("journal_id", journalId)
      .in("id", touched);

    if (error) throw new Error(`고를 후보 조회 실패: ${error.message}`);

    const rows = data ?? [];
    const taken = await takenCandidateIds(rows.map((row) => row.id));
    const allowed = new Set(
      rows.filter((row) => !isProtectedCandidate(row, taken))
        .map((row) => row.id),
    );

    for (const one of replace) {
      if (!allowed.has(one.id)) continue;
      const { error: updateError } = await client
        .from("journal_observations")
        .update({ content: one.content })
        .eq("id", one.id);
      if (updateError) throw new Error(`관찰 바꾸기 실패: ${updateError.message}`);
    }

    const removable = remove.filter((id) => allowed.has(id));
    if (removable.length > 0) {
      // 지우기 전에 값을 잡아 둔다. 삭제는 전부 감사 로그에 남긴다(원칙 8).
      const { data: gone, error: readError } = await client
        .from("journal_observations")
        .select("*")
        .in("id", removable);
      if (readError) throw new Error(`지울 관찰 읽기 실패(감사용): ${readError.message}`);

      const { error: deleteError } = await client
        .from("journal_observations")
        .delete()
        .in("id", removable);
      if (deleteError) throw new Error(`관찰 삭제 실패: ${deleteError.message}`);

      for (const row of gone ?? []) {
        await recordAudit({
          action: "delete",
          table_name: "journal_observations",
          record_id: row.id,
          summary: `다시 분석 결과 반영 — 추출 관찰 삭제: ${
            String(row.content ?? "").slice(0, 20)
          }`,
          before: row,
        });
      }
    }
  }

  return await listByJournal(journalId);
}

/* ---------- 가져오기 (후보 -> 확정 관찰) ---------- */

/** 일지 종류를 observations.source 값으로 옮긴다. */
const KIND_TO_SOURCE: Record<string, Source> = {
  "프로그램": "프로그램",
  "일상": "일상",
  // journals.kind 는 "회의록" 인데 observations.source 는 "회의" 다.
  // 두 표의 CHECK 목록이 원래 다르므로 여기서 맞춰 준다.
  "회의록": "회의",
  "봉사": "봉사",
};

export type ImportableItem = {
  id: string;
  content: string;
  journal_id: string;
  journal_date: string;
  journal_kind: string;
  journal_title: string | null;
  /** 이미 아동 관찰로 가져갔는지 */
  imported: boolean;
  /** 다른 관찰에 합쳐졌는지. 그렇다면 고를 수 없다. */
  merged: boolean;
};

/**
 * 한 아동의 관찰 후보를 원본 일지 정보와 함께 읽는다. 최신 일지부터.
 *
 * 이미 가져간 것도, 다른 관찰에 합쳐진 것도 함께 돌려주고 표시만 한다.
 * 목록에서 지워 버리면 "왜 이건 안 보이지" 가 되고,
 * 같은 내용을 또 가져오려다 막히는 이유도 알 수 없다.
 *
 * 아직 어느 아동인지 정하지 않은 후보(child_id 가 NULL)는 여기 오지 않는다.
 * 아동으로 걸러 읽기 때문이다 — 그런 후보는 일지 카드에서 아동을 먼저 정해야 한다.
 */
export async function listImportableObservations(childId: string): Promise<ImportableItem[]> {
  const client = getClient();

  const { data, error } = await client
    .from("journal_observations")
    // deno-fmt-ignore
    .select(
      "id, content, journal_id, merged_into, merged_at, journal:journals(journal_date, kind, title)",
    )
    .eq("child_id", childId);

  if (error) {
    throw new Error(`가져올 관찰 조회 실패: ${error.message}`);
  }

  const rows = data ?? [];
  if (rows.length === 0) return [];

  // 이미 가져간 후보 id 를 모은다
  const importedIds = await takenCandidateIds(rows.map((row) => row.id));

  return rows
    // deno-lint-ignore no-explicit-any
    .map((row: any) => ({
      id: row.id,
      content: row.content,
      journal_id: row.journal_id,
      journal_date: row.journal?.journal_date ?? "",
      journal_kind: row.journal?.kind ?? "",
      journal_title: row.journal?.title ?? null,
      imported: importedIds.has(row.id),
      merged: !!row.merged_into || !!row.merged_at,
    }))
    .sort((
      a,
      b,
    ) => (a.journal_date > b.journal_date ? -1 : a.journal_date < b.journal_date ? 1 : 0));
}

/**
 * 고른 후보들을 아동 관찰(observations)로 옮겨 적는다.
 *
 * 영역은 넣지 않는다. AI가 정하지 않았고, 어느 영역으로 볼지는 사람의 판단이다.
 * 가져온 뒤 아동 관찰 화면에서 미지정으로 뜨고, 거기서 사람이 고른다.
 *
 * 날짜는 원본 일지의 날짜를, 출처는 일지 종류를 쓴다.
 * 이미 가져간 후보는 조용히 건너뛴다. DB의 unique 제약이 마지막으로 막지만,
 * 여기서 먼저 걸러야 한 건 때문에 나머지가 통째로 실패하지 않는다.
 * 다른 관찰에 합쳐진 후보도 같이 건너뛴다 — 가져가면 합친 내용이 두 번 들어간다.
 */
export async function importObservations(
  childId: string,
  candidateIds: string[],
): Promise<{ imported: number; skipped: number }> {
  if (candidateIds.length === 0) return { imported: 0, skipped: 0 };

  const client = getClient();

  const { data: candidates, error } = await client
    .from("journal_observations")
    // deno-fmt-ignore
    .select(
      "id, child_id, content, merged_into, merged_at, journal:journals(id, journal_date, kind, content_updated_at)",
    )
    .eq("child_id", childId)
    .in("id", candidateIds);

  if (error) {
    throw new Error(`가져올 관찰 조회 실패: ${error.message}`);
  }

  const rows = candidates ?? [];
  if (rows.length === 0) return { imported: 0, skipped: candidateIds.length };

  const already = await takenCandidateIds(rows.map((row) => row.id));

  // deno-lint-ignore no-explicit-any
  const fresh = rows.filter((row: any) =>
    !already.has(row.id) && !row.merged_into && !row.merged_at
  );
  if (fresh.length === 0) {
    return { imported: 0, skipped: candidateIds.length };
  }

  const { data: inserted, error: insertError } = await client
    .from("observations")
    // deno-lint-ignore no-explicit-any
    .insert(fresh.map((row: any) => ({
      child_id: row.child_id,
      obs_date: row.journal?.journal_date,
      area: null,
      content: row.content,
      source: KIND_TO_SOURCE[row.journal?.kind] ?? null,
      source_journal_obs_id: row.id,
      // 근거 추적용. 일지가 지워져도 남도록 id 를 따로 적고,
      // 지금 본문 시각(content_updated_at, 028)을 함께 남겨 나중에 "그 뒤로 본문이 바뀌었는지" 를 가린다.
      // 행 전체 시각(updated_at)은 쓰지 않는다 — 분석 표시·댓글에도 올라가 거짓 "수정됨" 이 뜬다.
      source_journal_id: row.journal?.id ?? null,
      source_journal_updated_at: row.journal?.content_updated_at ?? null,
    })))
    .select("id");

  if (insertError) {
    throw new Error(`관찰 가져오기 실패: ${insertError.message}`);
  }

  const importedCount = (inserted ?? []).length;
  return { imported: importedCount, skipped: candidateIds.length - importedCount };
}

/** 그 일지에서 뽑힌 후보 중 이미 아동 관찰로 가져간 것이 몇 건인지 센다. */
export async function countImportedFromJournal(journalId: string): Promise<number> {
  const client = getClient();

  const { data: rows, error } = await client
    .from("journal_observations")
    .select("id")
    .eq("journal_id", journalId);

  if (error) {
    throw new Error(`추출 관찰 조회 실패: ${error.message}`);
  }

  const ids = (rows ?? []).map((row) => row.id);
  return (await takenCandidateIds(ids)).size;
}

/* ---------- 후보 손보기 (합치기 · 나누기 · 수정 · 삭제) ---------- */

/**
 * 관찰 후보 하나를 읽는다. 없으면 null.
 * 합치기·나누기가 아동·일지를 확인하려고 쓴다.
 */
async function getJournalObs(id: string): Promise<
  {
    id: string;
    journal_id: string;
    child_id: string | null;
    pending_child_ids: string[] | null;
    area: Area | null;
    content: string;
  } | null
> {
  const { data, error } = await getClient()
    .from("journal_observations")
    .select("id, journal_id, child_id, pending_child_ids, area, content")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    throw new Error(`관찰 후보 조회 실패: ${error.message}`);
  }
  return data ?? null;
}

/**
 * 두 후보를 하나로 합친다. keepId 가 남고 removeId 가 사라진다.
 *
 * 같은 일지에서 뽑힌 같은 아동의 후보끼리만 합친다.
 * 일지가 다르면 근거가 둘인 한 덩어리가 되고, 아동이 다르면 누구 이야기인지 뭉개진다.
 *
 * [가져간 관찰의 근거]
 * 사라지는 쪽을 가리키던 관찰이 있으면 남는 쪽으로 옮긴다.
 * 다만 남는 쪽이 이미 다른 관찰에 가져가져 있으면 옮길 수 없다(한 후보는 한 번만).
 * 그때는 옮기지 못한 채 후보가 사라지고, 그 관찰의 근거 연결만 끊긴다
 * (외래키가 set null 이라 관찰 자체는 남는다). 몇 건이 그렇게 되는지 돌려주어
 * 화면이 확인창에서 미리 알리게 한다.
 *
 * 근거 옮기기 · 남길 쪽 수정 · 지울 쪽 삭제는 DB 함수 merge_journal_obs(030) 하나 — 한 트랜잭션.
 * 규칙은 여기서 먼저 보고, 함수가 잠근 뒤 한 번 더 본다. 감사 로그는 성공한 뒤 예전 모양 그대로.
 */
export async function mergeJournalObs(
  keepId: string,
  removeId: string,
  content: string,
): Promise<{ observation: JournalObservation; moved: number; orphaned: number }> {
  if (keepId === removeId) throw new RuleError("같은 관찰끼리는 합칠 수 없습니다.");

  const client = getClient();
  const [keep, remove] = await Promise.all([getJournalObs(keepId), getJournalObs(removeId)]);

  if (!keep || !remove) throw new NotFoundError("합칠 관찰을 찾지 못했습니다.");
  if (keep.journal_id !== remove.journal_id) {
    throw new RuleError("같은 일지에서 뽑힌 관찰끼리만 합칠 수 있습니다.");
  }
  if (keep.child_id !== remove.child_id) {
    throw new RuleError("같은 아동의 관찰끼리만 합칠 수 있습니다.");
  }
  // 둘 다 아동을 못 가린 후보다. 서로 다른 아동일 수 있어 합치면 남의 기록이 섞인다.
  if (!keep.child_id) {
    throw new RuleError("아동을 먼저 정한 뒤에 합칠 수 있습니다.");
  }

  const { data: done, error: mergeError } = await client.rpc("merge_journal_obs", {
    p_keep_id: keepId,
    p_remove_id: removeId,
    p_content: content,
  });
  if (mergeError) {
    throw rpcError(mergeError, {
      notFound: "합칠 관찰을 찾지 못했습니다.",
      mismatch: "합칠 수 없는 관찰입니다. 화면을 새로 고쳐 주세요.",
    }, "관찰 후보 합치기 실패");
  }
  // moved: 가져간 관찰의 근거를 남는 쪽으로 옮겼다 / orphaned: 옮기지 못해 근거가 끊겼다
  const { keep_taken, moved, orphaned } = done as {
    keep_taken: boolean;
    moved: number;
    orphaned: number;
  };

  const { data: merged, error: readError } = await client
    .from("journal_observations")
    .select(COLUMNS)
    .eq("id", keepId)
    .single();
  if (readError || !merged) {
    throw new Error(`합친 관찰 후보 조회 실패: ${readError?.message ?? "없음"}`);
  }

  await recordAudit({
    action: "delete",
    table_name: "journal_observations",
    record_id: removeId,
    summary: `추출 관찰 병합 — ${String(remove.content).slice(0, 20)} → ${
      String(keep.content).slice(0, 20)
    }`,
    before: { keep, remove },
    after: merged,
  });

  return {
    observation: await toItem(merged, keep_taken || moved > 0),
    moved,
    orphaned,
  };
}

/**
 * 후보 하나를 둘로 나눈다. 원본은 내용만 정리하고, 같은 일지·같은 아동으로 1건을 더 만든다.
 *
 * 새로 생긴 쪽은 아직 가져오기 전 상태다 — 후보는 원래 그런 것이고,
 * 가져갈지는 사람이 아동 화면에서 정한다. 영역은 원본을 따르지만
 * 어차피 추출 단계에서 null 이라 사실상 늘 미지정이다.
 *
 * 원본 수정과 새 행 추가는 DB 함수 split_journal_obs(030) 하나 — 한 트랜잭션.
 * 감사 로그는 성공한 뒤 원본 수정분만([수정]과 같은 모양).
 */
export async function splitJournalObs(
  id: string,
  keepContent: string,
  newContent: string,
): Promise<{ original: JournalObservation; created: JournalObservation }> {
  const client = getClient();

  const before = await snapshotRow("journal_observations", id);
  if (!before) throw new NotFoundError("나눌 관찰을 찾지 못했습니다.");

  const { data, error } = await client.rpc("split_journal_obs", {
    p_id: id,
    p_keep_content: keepContent,
    p_new_content: newContent,
  });
  if (error) {
    throw rpcError(error, { notFound: "나눌 관찰을 찾지 못했습니다." }, "관찰 후보 나누기 실패");
  }
  const createdId = (data as { created_id: string }).created_id;

  await auditJournalObsEdit(id, before, keepContent);

  const { data: rows, error: readError } = await client
    .from("journal_observations")
    .select(COLUMNS)
    .in("id", [id, createdId]);
  const original = rows?.find((row) => row.id === id);
  const created = rows?.find((row) => row.id === createdId);
  if (readError || !original || !created) {
    throw new Error(`나눈 관찰 후보 조회 실패: ${readError?.message ?? "없음"}`);
  }

  const taken = await takenCandidateIds([id]);
  // 새로 생긴 쪽은 아직 가져간 적이 없다.
  return {
    original: await toItem(original, taken.has(id)),
    created: await toItem(created, false),
  };
}

/** 후보 내용 수정 기록 — 수정과 나누기(원본 쪽)가 같은 모양으로 남긴다 */
async function auditJournalObsEdit(
  id: string,
  before: Record<string, unknown> | null,
  content: string,
): Promise<void> {
  await recordAudit({
    action: "update",
    table_name: "journal_observations",
    record_id: id,
    summary: `추출 관찰 수정 — ${String(before?.content ?? "").slice(0, 20)}`.trim(),
    before,
    after: { content },
  });
}

/** 후보의 내용만 바꾼다. 아동·일지는 바꾸지 않는다 — 그건 다시 뽑는 일이다. */
export async function updateJournalObs(
  id: string,
  content: string,
): Promise<JournalObservation> {
  const before = await snapshotRow("journal_observations", id);

  const { data, error } = await getClient()
    .from("journal_observations")
    .update({ content, edited_at: new Date().toISOString() })
    .eq("id", id)
    .select(COLUMNS)
    .single();

  if (error) {
    throw writeError(
      error,
      "추출 관찰 수정 실패",
      "그 추출 관찰을 찾지 못했습니다. 이미 지워졌을 수 있어요.",
    );
  }

  await auditJournalObsEdit(id, before, content);

  const taken = await takenCandidateIds([id]);
  return await toItem(data, taken.has(id));
}

/**
 * 후보 1건을 지운다.
 *
 * 이미 가져간 관찰이 있어도 막지 않는다. 외래키가 set null 이라 관찰은 남고
 * 근거 연결만 끊긴다(아동 화면에서 "근거 바뀜"으로 뜬다).
 * 몇 건이 그렇게 되는지 돌려주어, 화면이 지우기 전에 알릴 수 있게 한다.
 */
export async function deleteJournalObs(id: string): Promise<{ orphaned: number }> {
  const before = await snapshotRow("journal_observations", id);
  if (!before) throw new NotFoundError("그 추출 관찰을 찾지 못했습니다. 이미 지워졌을 수 있어요.");
  const orphaned = (await takenCandidateIds([id])).size;

  const { error } = await getClient()
    .from("journal_observations")
    .delete()
    .eq("id", id);

  if (error) {
    throw new Error(`추출 관찰 삭제 실패: ${error.message}`);
  }

  await recordAudit({
    action: "delete",
    table_name: "journal_observations",
    record_id: id,
    summary: `추출 관찰 삭제 — ${String(before?.content ?? "").slice(0, 20)}${
      orphaned > 0 ? ` (가져간 관찰 ${orphaned}건의 근거 끊김)` : ""
    }`.trim(),
    before,
  });

  return { orphaned };
}

/* ---------- 아동 확인 필요 ---------- */

/**
 * 아동을 못 가린 후보에 아동을 정해 준다.
 *
 * 기계가 "김0준"을 김하준·김서준 중 누구인지 못 가렸을 때, 사람이 여기서 끝낸다.
 * 후보 목록에 없는 아동도 고를 수 있다 — 표기가 잘못 적혔을 수도 있고,
 * 그 판단은 일지를 쓴 사람이 하는 것이지 기계가 만든 후보 목록이 하는 것이 아니다.
 *
 * 이미 아동이 정해진 후보의 아동은 여기서 바꾸지 않는다.
 * 가져간 관찰이 딸려 있으면 그 관찰의 아동과 어긋나기 때문이다.
 * 잘못 정했으면 지우고 다시 뽑는 것이 맞다.
 */
export async function assignJournalObsChild(
  id: string,
  childId: string,
): Promise<JournalObservation> {
  const before = await getJournalObs(id);
  if (!before) throw new NotFoundError("관찰 후보를 찾지 못했습니다.");
  if (before.child_id) {
    throw new RuleError("이미 아동이 정해진 관찰입니다.");
  }

  const { data, error } = await getClient()
    .from("journal_observations")
    .update({ child_id: childId, pending_child_ids: null, edited_at: new Date().toISOString() })
    .eq("id", id)
    .select(COLUMNS)
    .single();

  if (error) {
    throw new Error(`아동 지정 실패: ${error.message}`);
  }

  await recordAudit({
    action: "update",
    table_name: "journal_observations",
    record_id: id,
    summary: `추출 관찰 아동 지정 — ${String(before.content).slice(0, 20)}`,
    before,
    after: { child_id: childId },
  });

  // 방금 정했으므로 가져간 관찰이 있을 수 없다
  return await toItem(data, false);
}
