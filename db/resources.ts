/**
 * 자원(resources) 데이터 접근 — 센터 보유목록
 *
 * 규칙: Supabase 호출은 /db 안에서만 한다.
 *
 * 자원은 사람과 무관한 일반정보다. 아동·직원 표와 잇지 않는다.
 * "누가 무엇을 썼는가"는 나중에 관찰·일지 쪽에서 잇는다.
 */
import { getClient, NotFoundError, writeError } from "./client.ts";
import { AI_ACTOR, recordAudit, snapshotRow } from "./audit.ts";
import { getSetting, saveSetting } from "./settings.ts";

export type ResourceItem = {
  id: string;
  name: string;
  category: string | null;
  /** 쉼표로 구분한 한 줄. 없으면 null. */
  aliases: string | null;
  /**
   * AI 추측으로 자동 등록된 자원인가.
   * 사람이 카테고리를 한 번이라도 만지면 false 가 된다 — 그때부터는 사람의 판단이다.
   */
  auto_added: boolean;
};

const COLUMNS = "id, name, category, aliases, auto_added";

/** 설정에 아무것도 없을 때 쓰는 값. 010 마이그레이션이 넣는 것과 같아야 한다. */
const DEFAULT_CATEGORIES = ["기기", "보드게임", "예술", "체육", "기타"];

const CATEGORIES_KEY = "resource_categories";
const BLACKLIST_KEY = "resource_blacklist";

/* ---------- 자원 ---------- */

/**
 * 자원 목록. 카테고리를 주면 그 안에서만 찾는다.
 *
 * 이름순으로 준다. 화면은 카테고리별로 묶어 보여주지만,
 * 묶는 일은 화면이 한다 — 한 벌만 읽어 여러 모양으로 보여줄 수 있어야 한다.
 */
export async function listResources(category?: string | null): Promise<ResourceItem[]> {
  let query = getClient()
    .from("resources")
    .select(COLUMNS);

  if (category) query = query.eq("category", category);

  const { data, error } = await query.order("name", { ascending: true });

  if (error) {
    throw new Error(`자원 목록 조회 실패: ${error.message}`);
  }
  return (data ?? []) as ResourceItem[];
}

/**
 * 별칭을 한 줄로 다듬는다.
 *
 * 사람이 "젠가,나무탑 , 탑쌓기" 처럼 쓴 것을 "젠가, 나무탑, 탑쌓기" 로 만든다.
 * 저장할 때 한 번 다듬어 두면 나중에 자원을 뽑을 때(자-2) 쪼개기만 하면 된다.
 * 빈 값은 null 로 둔다 — 빈 문자열과 없음을 둘 다 두면 검사할 곳이 늘어난다.
 */
export function normalizeAliases(value: string | null | undefined): string | null {
  if (!value) return null;
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join(", ") : null;
}

/** 이미 있는 이름인지 보는 데 쓴다. DB 의 unique 인덱스가 같은 기준으로 막는다. */
function isDuplicateName(message: string): boolean {
  return /duplicate key|idx_resources_name_unique|23505/i.test(message);
}

export async function addResource(
  name: string,
  category: string | null,
  aliases: string | null,
  /** 일지에서 뽑혀 자동으로 들어온 것인가. 사람이 손수 넣은 것과 가리려고 남긴다. */
  autoAdded = false,
): Promise<ResourceItem> {
  const { data, error } = await getClient()
    .from("resources")
    .insert({ name, category, aliases: normalizeAliases(aliases), auto_added: autoAdded })
    .select(COLUMNS)
    .single();

  if (error) {
    // DB 가 준 영어 메시지를 그대로 올리면 화면에서 무슨 말인지 알 수 없다
    if (isDuplicateName(error.message)) {
      throw new Error(`"${name}" 은(는) 이미 자원사전에 있습니다.`);
    }
    throw new Error(`자원 등록 실패: ${error.message}`);
  }

  // 자동 등록은 사람이 누른 적이 없는 변화다. 누가 넣었는지 남아 있어야
  // 나중에 "이건 왜 여기 있지" 를 되짚을 수 있다.
  if (autoAdded) {
    await recordAudit({
      action: "create",
      actor: AI_ACTOR,
      table_name: "resources",
      record_id: (data as ResourceItem).id,
      summary: `자원 자동 등록 — ${name} [${category ?? "카테고리 미정"}]`,
      after: data,
    });
  }
  return data as ResourceItem;
}

export async function updateResource(
  id: string,
  patch: { name?: string; category?: string | null; aliases?: string | null },
): Promise<ResourceItem> {
  const changes: Record<string, unknown> = {};
  if (patch.name !== undefined) changes.name = patch.name;
  if (patch.aliases !== undefined) changes.aliases = normalizeAliases(patch.aliases);

  if (patch.category !== undefined) {
    changes.category = patch.category;
    // 사람이 카테고리를 만졌다. 이제 AI 추측이 아니라 사람의 판단이다.
    changes.auto_added = false;
  }

  if (Object.keys(changes).length === 0) {
    throw new Error("바꿀 내용이 없습니다.");
  }

  const { data, error } = await getClient()
    .from("resources")
    .update(changes)
    .eq("id", id)
    .select(COLUMNS)
    .single();

  if (error) {
    if (isDuplicateName(error.message)) {
      throw new Error(`"${patch.name}" 은(는) 이미 자원사전에 있습니다.`);
    }
    throw writeError(
      error,
      "자원 수정 실패",
      "그 자원을 찾지 못했습니다. 이미 지워졌을 수 있어요.",
    );
  }
  return data as ResourceItem;
}

/**
 * 자원 1건을 지운다.
 *
 * 지금은 이 자원을 가리키는 곳이 없다. 나중에 사용 기록(자-3)이 붙으면
 * 그때 외래키를 어떻게 할지 정해야 한다 — 기록을 살리려면 set null 이다.
 */
export async function deleteResource(id: string): Promise<void> {
  const before = await snapshotRow("resources", id);
  if (!before) throw new NotFoundError("그 자원을 찾지 못했습니다. 이미 지워졌을 수 있어요.");
  const { error } = await getClient()
    .from("resources")
    .delete()
    .eq("id", id);

  if (error) {
    throw new Error(`자원 삭제 실패: ${error.message}`);
  }
  await recordAudit({
    action: "delete",
    table_name: "resources",
    record_id: id,
    summary: `자원 삭제 — ${before?.name ?? "(이름 없음)"}`,
    before,
  });
}

/** 그 카테고리를 쓰는 자원이 몇 건인지. 카테고리를 지워도 되는지 보는 데 쓴다. */
export async function countResourcesInCategory(category: string): Promise<number> {
  const { count, error } = await getClient()
    .from("resources")
    .select("id", { count: "exact", head: true })
    .eq("category", category);

  if (error) {
    throw new Error(`자원 수 확인 실패: ${error.message}`);
  }
  return count ?? 0;
}

/** 자원 하나를 읽는다. 없으면 null. */
export async function getResource(id: string): Promise<ResourceItem | null> {
  const { data, error } = await getClient()
    .from("resources")
    .select(COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    throw new Error(`자원 조회 실패: ${error.message}`);
  }
  return (data as ResourceItem | null) ?? null;
}

/**
 * 자원 둘을 하나로 합친다. from 이 to 에 흡수된다.
 *
 * from 의 이름과 별칭은 to 의 별칭이 된다. 그래야 다음 일지에서 그 말이 나와도
 * 사전이 to 로 이어 준다. 병합은 "같은 물건을 다르게 불렀다"는 판단이고,
 * 그 판단이 별칭에 남지 않으면 같은 것이 또 새 자원으로 올라온다.
 *
 * 기록(resource_records)을 옮기는 일은 여기서 하지 않는다.
 * 표가 다르므로 그쪽 /db 함수(moveRecords)가 맡고, 순서는 API 가 정한다.
 */
export async function mergeResource(fromId: string, toId: string): Promise<ResourceItem> {
  const [from, to] = await Promise.all([getResource(fromId), getResource(toId)]);
  if (!from) throw new NotFoundError("합칠 자원을 찾지 못했습니다.");
  if (!to) throw new NotFoundError("합쳐질 자원을 찾지 못했습니다.");

  const aliases = normalizeAliases(
    [to.aliases, from.name, from.aliases].filter(Boolean).join(", "),
  );
  // to 의 이름 자체가 별칭에 들어가면 의미가 없다. 빼 준다.
  const cleaned = aliases
    ?.split(", ")
    .filter((alias) => alias.toLowerCase() !== to.name.trim().toLowerCase())
    .join(", ") || null;

  const client = getClient();

  const { data, error } = await client
    .from("resources")
    .update({ aliases: cleaned })
    .eq("id", toId)
    .select(COLUMNS)
    .single();

  if (error) {
    throw new Error(`별칭 이어받기 실패: ${error.message}`);
  }

  const { error: deleteError } = await client
    .from("resources")
    .delete()
    .eq("id", fromId);

  if (deleteError) {
    throw new Error(`합쳐진 자원 삭제 실패: ${deleteError.message}`);
  }

  // 병합도 삭제다. from 이 사라지고 별칭으로만 남는다.
  await recordAudit({
    action: "delete",
    table_name: "resources",
    record_id: fromId,
    summary: `자원 병합 — ${from.name} → ${to.name} (별칭으로 남음)`,
    before: from,
    after: data,
  });

  return data as ResourceItem;
}

/** 자원의 별칭을 목록으로. 없으면 빈 배열. */
export function aliasList(item: ResourceItem): string[] {
  return item.aliases ? item.aliases.split(",").map((one) => one.trim()).filter(Boolean) : [];
}

/**
 * 별칭 하나를 떼어 독립된 자원으로 만든다. 합치기의 역동작이다.
 *
 * 카테고리는 원래 자원 것을 물려받는다. 별칭이었다는 것은 같은 묶음으로 세어 왔다는
 * 뜻이라, 갑자기 "카테고리 미정"이 되면 통계가 그 순간 어긋난다. 다르면 나중에 고친다.
 *
 * 자동 등록 표시는 붙이지 않는다. 떼어내기로 한 것은 사람의 판단이다.
 *
 * 기록(resource_records)을 옮기는 일은 여기서 하지 않는다.
 * 표가 다르므로 그쪽 /db 함수가 맡고, 순서는 API 가 정한다.
 */
export async function splitAlias(id: string, alias: string): Promise<{
  created: ResourceItem;
  source: ResourceItem;
}> {
  const from = await getResource(id);
  if (!from) throw new NotFoundError("분리할 자원을 찾지 못했습니다.");

  const key = alias.trim().toLowerCase();
  const aliases = aliasList(from);
  const target = aliases.find((one) => one.toLowerCase() === key);
  if (!target) throw new Error(`"${alias}" 은(는) ${from.name} 의 별칭이 아닙니다.`);

  // 먼저 새 자원을 만든다. 이름이 겹쳐 실패하면 원래 자원은 그대로 두어야 한다.
  const created = await addResource(target, from.category, null);

  const rest = aliases.filter((one) => one.toLowerCase() !== key);
  const { data, error } = await getClient()
    .from("resources")
    .update({ aliases: rest.length > 0 ? rest.join(", ") : null })
    .eq("id", id)
    .select(COLUMNS)
    .single();

  if (error) {
    // 새 자원은 이미 생겼다. 되돌려 두 자원이 같은 말을 물고 있지 않게 한다.
    await deleteResource(created.id).catch(() => {});
    throw new Error(`별칭 떼어내기 실패: ${error.message}`);
  }

  await recordAudit({
    action: "update",
    table_name: "resources",
    record_id: id,
    summary: `별칭 분리 — ${from.name} 에서 ${target} 을(를) 떼어냄`,
    before: from,
    after: data,
  });

  return { created, source: data as ResourceItem };
}

/* ---------- 블랙리스트 (설정에 담는다) ---------- */

/**
 * "자원이 아니다"라고 판단한 이름들.
 *
 * 다음에 뽑을 때 AI 에게 "이 이름은 기록하지 말라"고 함께 보내고,
 * 그래도 올라오면 저장 단계에서 '없음'으로 돌린다.
 * 같은 것을 매번 다시 판단하지 않으려는 목록이다.
 */
export async function getResourceBlacklist(): Promise<string[]> {
  const value = await getSetting<unknown>(BLACKLIST_KEY, []);
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

export async function saveResourceBlacklist(list: string[]): Promise<void> {
  await saveSetting(BLACKLIST_KEY, list);
}

/** 이름 하나를 블랙리스트에 넣는다. 이미 있으면 그대로 둔다. 바뀐 목록을 돌려준다. */
export async function addToBlacklist(name: string): Promise<string[]> {
  const trimmed = name.trim();
  const list = await getResourceBlacklist();
  const key = trimmed.toLowerCase();
  if (list.some((item) => item.trim().toLowerCase() === key)) return list;

  const next = [...list, trimmed];
  await saveResourceBlacklist(next);
  return next;
}

/** 이름 하나를 블랙리스트에서 뺀다. 없었으면 그대로 둔다. 바뀐 목록을 돌려준다. */
export async function removeFromBlacklist(name: string): Promise<string[]> {
  const key = name.trim().toLowerCase();
  const list = await getResourceBlacklist();
  const next = list.filter((item) => item.trim().toLowerCase() !== key);
  if (next.length !== list.length) await saveResourceBlacklist(next);
  return next;
}

/* ---------- 카테고리 (설정에 담는다) ---------- */

/**
 * 카테고리 목록이 바뀐 것을 감사 로그에 남긴다. 추가·삭제·순서·이름 변경을 한 줄로.
 * 이름 변경은 그 안의 자원과 기록이 통째로 옮겨 가는 일이라 몇 건이 옮겨졌는지 함께 적는다.
 * 바뀐 것이 없으면(같은 목록을 다시 저장) 남기지 않는다.
 */
export async function recordCategoryChange(input: {
  before: string[];
  after: string[];
  rename: { from: string; to: string } | null;
  moved: number;
  movedRecords: number;
}): Promise<void> {
  if (!input.rename && JSON.stringify(input.before) === JSON.stringify(input.after)) return;

  const added = input.after.filter((name) =>
    !input.before.includes(name) && name !== input.rename?.to
  );
  const removed = input.before.filter((name) =>
    !input.after.includes(name) && name !== input.rename?.from
  );
  const parts = [
    input.rename
      ? `이름 변경 ${input.rename.from} → ${input.rename.to}(자원 ${input.moved} · 기록 ${input.movedRecords} 이동)`
      : "",
    added.length ? `추가 ${added.join(", ")}` : "",
    removed.length ? `삭제 ${removed.join(", ")}` : "",
  ].filter(Boolean);

  await recordAudit({
    action: removed.length > 0 ? "delete" : "update",
    table_name: "settings",
    record_id: null,
    summary: `자원 카테고리 변경 — ${parts.length ? parts.join(" · ") : "순서"}`,
    before: { categories: input.before },
    after: {
      categories: input.after,
      rename: input.rename,
      moved_resources: input.moved,
      moved_records: input.movedRecords,
    },
  });
}

export async function getResourceCategories(): Promise<string[]> {
  const value = await getSetting<unknown>(CATEGORIES_KEY, DEFAULT_CATEGORIES);

  // 설정 값은 jsonb 라 어떤 모양이든 들어갈 수 있다.
  // 남이 손으로 고쳐 두었을 수 있으므로 읽을 때 한 번 걸러 낸다.
  if (!Array.isArray(value)) return [...DEFAULT_CATEGORIES];
  const list = value.filter((item): item is string =>
    typeof item === "string" && item.trim().length > 0
  );
  return list.length > 0 ? list : [...DEFAULT_CATEGORIES];
}

export async function saveResourceCategories(list: string[]): Promise<void> {
  await saveSetting(CATEGORIES_KEY, list);
}

/**
 * 카테고리 이름을 바꾸고, 그 카테고리를 쓰던 자원도 함께 옮긴다.
 *
 * 이름만 바꾸고 자원을 두면 그 자원들이 어느 묶음에도 안 들어간다.
 * 이름 바꾸기는 곧 "그 안의 자원을 통째로 옮기는 일"이다.
 */
export async function renameResourceCategory(from: string, to: string): Promise<number> {
  const { data, error } = await getClient()
    .from("resources")
    .update({ category: to })
    .eq("category", from)
    .select("id");

  if (error) {
    throw new Error(`카테고리 이름 변경 실패: ${error.message}`);
  }
  return (data ?? []).length;
}
