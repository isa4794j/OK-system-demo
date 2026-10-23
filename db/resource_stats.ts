/**
 * 자원 통계 데이터 접근 — 통계에 잡힌 기록(status='Y')만 센다
 *
 * 규칙: Supabase 호출은 /db 안에서만 한다.
 *
 * [status='Y' 만 센다]
 * 019 부터 뽑힌 자원은 바로 Y 로 들어간다. 사람이 "자원이 아니다"라고 한 것('없음')만
 * 빠진다. 카테고리를 못 정한 줄도 Y 라 "카테고리 미정"으로 잡힌다 —
 * 존재를 통계에서 빠뜨리지 않으려는 것이다. 이 조건이 어느 조회에서도 빠지면 안 된다.
 *
 * [묶는 일은 여기서 한다]
 * PostgREST 로는 GROUP BY 를 할 수 없다. 줄을 읽어 와 앱에서 센다.
 * 한 기간에 수백 줄 정도라 이 편이 단순하다. 훨씬 커지면 그때 DB 함수(RPC)로 옮긴다.
 */
import { getClient } from "./client.ts";
import { listResources } from "./resources.ts";

/** 카테고리가 비어 있는 기록을 모아 두는 이름. 화면에도 이대로 나온다. */
export const NO_CATEGORY = "카테고리 미정";

export type ResourceCount = {
  name: string;
  category: string;
  count: number;
  /** 그 기간 안에서 마지막으로 쓴 날 */
  last_used: string;
};

export type CategoryStat = {
  category: string;
  count: number;
  /** 그 카테고리 안의 자원별 내역. 막대를 펼치면 보인다. */
  resources: ResourceCount[];
};

export type ResourceStat = ResourceCount & {
  /** 지난 기간의 횟수. 견줄 기간을 안 줬으면 null. */
  prev_count: number | null;
  /** 이번 - 지난. prev_count 가 null 이면 null. */
  delta: number | null;
};

export type IdleResource = {
  name: string;
  category: string | null;
  /** 마지막으로 쓴 날. 한 번도 안 썼으면 null. */
  last_used: string | null;
  /** 그 뒤로 며칠 지났는지. 한 번도 안 썼으면 null. */
  days_since: number | null;
};

type Row = { record_date: string; resource_name: string; category: string | null };

/**
 * 같은 자원인지 볼 때 쓰는 열쇠. 대소문자와 모든 공백(가운데 띄어쓰기 포함)을 무시한다.
 * "독서 기록장" 과 "독서기록장" 이 통계에서 두 줄로 갈리지 않게(1차 전수 점검 2026-09-17).
 * 표시 이름은 가장 먼저 본 줄(가장 최근 기록)의 이름을 쓴다.
 */
export function nameKey(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "");
}

/**
 * 통계에 잡힌 기록을 기간으로 읽는다. 기간을 안 주면 전부.
 *
 * 이 함수만 DB를 본다. 아래 통계들은 모두 이 결과를 세는 일만 한다.
 * status 조건을 한 곳에 두어야 어느 통계에서도 빠지지 않는다.
 */
async function readConfirmed(from?: string, to?: string): Promise<Row[]> {
  let query = getClient()
    .from("resource_records")
    .select("record_date, resource_name, category")
    .eq("status", "Y");

  if (from) query = query.gte("record_date", from);
  if (to) query = query.lte("record_date", to);

  const { data, error } = await query.order("record_date", { ascending: false });

  if (error) {
    throw new Error(`자원 통계 조회 실패: ${error.message}`);
  }
  return (data ?? []) as Row[];
}

/** 자원 이름으로 묶어 센다. 이름이 같으면 같은 자원으로 본다. */
function countByName(rows: Row[]): Map<string, ResourceCount> {
  const counts = new Map<string, ResourceCount>();

  for (const row of rows) {
    const key = nameKey(row.resource_name);
    if (!key) continue;

    const found = counts.get(key);
    if (found) {
      found.count += 1;
      // 읽어 온 순서가 날짜 내림차순이라 먼저 본 것이 더 최근이다.
      // 그래도 순서에 기대지 않고 직접 견준다.
      if (row.record_date > found.last_used) found.last_used = row.record_date;
      continue;
    }

    counts.set(key, {
      name: row.resource_name.trim(),
      category: row.category?.trim() || NO_CATEGORY,
      count: 1,
      last_used: row.record_date,
    });
  }

  return counts;
}

/**
 * 카테고리별 활용 횟수. 많이 쓴 순.
 *
 * 카테고리가 비어 있는 기록은 "카테고리 미정"으로 모은다.
 * AI가 카테고리를 못 정하면 이대로 들어오므로 드물지 않다.
 * 어느 묶음에도 못 들어가 사라지는 기록이 있으면 안 된다.
 *
 * ("이름 미상"은 생기지 않는다. 자원명은 DB가 비어 있는 것을 막고,
 *  뽑을 때도 이름이 없는 항목은 저장하지 않는다.)
 */
export async function statsByCategory(from: string, to: string): Promise<CategoryStat[]> {
  const rows = await readConfirmed(from, to);
  const byCategory = new Map<string, ResourceCount[]>();

  for (const item of countByName(rows).values()) {
    const list = byCategory.get(item.category) ?? [];
    list.push(item);
    byCategory.set(item.category, list);
  }

  const stats: CategoryStat[] = [];
  for (const [category, resources] of byCategory) {
    resources.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "ko"));
    stats.push({
      category,
      count: resources.reduce((sum, item) => sum + item.count, 0),
      resources,
    });
  }

  stats.sort((a, b) => b.count - a.count || a.category.localeCompare(b.category, "ko"));
  return stats;
}

/**
 * 자원별 활용 횟수. 많이 쓴 순.
 *
 * 견줄 기간(prev)을 주면 지난 기간 횟수와 증감을 함께 담는다.
 * 지난 기간을 여기서 계산하지 않는 이유: "지난 달"과 "지난 반기"는 길이가 다르고,
 * 날짜 수로 빼면 달마다 어긋난다. 어느 창을 견줄지는 화면이 안다.
 */
export async function statsByResource(
  from: string,
  to: string,
  prev?: { from: string; to: string },
): Promise<ResourceStat[]> {
  const [rows, prevRows] = await Promise.all([
    readConfirmed(from, to),
    prev ? readConfirmed(prev.from, prev.to) : Promise.resolve(null),
  ]);

  const prevCounts = prevRows ? countByName(prevRows) : null;

  const stats: ResourceStat[] = [];
  for (const [key, item] of countByName(rows)) {
    const before = prevCounts?.get(key)?.count ?? (prevCounts ? 0 : null);
    stats.push({
      ...item,
      prev_count: before,
      delta: before === null ? null : item.count - before,
    });
  }

  stats.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "ko"));
  return stats;
}

/**
 * 오래 안 쓴 자원. 사전에 있는데 기록에 안 나오는 것들.
 *
 * 기간을 받지 않는다. "이번 달에 안 썼다"가 아니라 "언제부터 안 썼다"를 봐야 하기 때문이다.
 * 그래서 통계에 잡힌 기록을 전부 읽어 자원마다 마지막 날짜를 찾는다.
 *
 * 판단하지 않는다. 계절을 타는 것도 있고(물놀이), 일부러 안 꺼내는 것도 있다.
 * 시스템은 "오래 안 보인다"는 사실만 알리고, 그 다음은 사람이 정한다.
 */
export async function idleResources(cutoffDays = 60, today?: string): Promise<IdleResource[]> {
  const [dictionary, rows] = await Promise.all([listResources(), readConfirmed()]);

  const lastUsed = new Map<string, string>();
  for (const row of rows) {
    const key = nameKey(row.resource_name);
    const found = lastUsed.get(key);
    if (!found || row.record_date > found) lastUsed.set(key, row.record_date);
  }

  const base = today ?? new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
  const baseTime = Date.parse(`${base}T00:00:00Z`);

  const idle: IdleResource[] = [];
  for (const item of dictionary) {
    const last = lastUsed.get(nameKey(item.name)) ?? null;

    if (last === null) {
      // 한 번도 안 나온 자원. 방금 등록한 것일 수도 있어 며칠인지는 세지 않는다.
      idle.push({ name: item.name, category: item.category, last_used: null, days_since: null });
      continue;
    }

    const days = Math.floor((baseTime - Date.parse(`${last}T00:00:00Z`)) / 86_400_000);
    if (days >= cutoffDays) {
      idle.push({
        name: item.name,
        category: item.category,
        last_used: last,
        days_since: days,
      });
    }
  }

  // 오래된 것부터. 한 번도 안 쓴 것은 맨 뒤에 둔다 — 방금 등록한 것과 구분이 안 되기 때문.
  idle.sort((a, b) => {
    if (a.days_since === null) return b.days_since === null ? 0 : 1;
    if (b.days_since === null) return -1;
    return b.days_since - a.days_since;
  });
  return idle;
}
