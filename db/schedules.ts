/**
 * 스케줄(schedules) 데이터 접근 — 멘토·봉사자가 언제 오는지
 *
 * 규칙: Supabase 호출은 /db 안에서만 한다.
 */
import { getClient, NotFoundError, RuleError, writeError } from "./client.ts";
import { recordAudit, snapshotRow } from "./audit.ts";
import type { Role } from "./staff.ts";

/* ---------- 근무 통계 ---------- */

export type PersonStat = {
  staff_id: string;
  name: string | null;
  role: Role | null;
  color_index: number | null;
  schedules: number;
  hours: number;
  written: number;
  missing: number;
};

export type ScheduleStats = {
  totals: { hours: number; schedules: number; written: number; missing: number };
  people: PersonStat[];
  by_role: Array<RoleStat>;
};

/** 역할별 소계 — 겸직자는 역할마다 한 사람으로 센다 */
export type RoleStat = {
  role: string;
  people: number;
  hours: number;
  schedules: number;
  written: number;
  missing: number;
};

/** "HH:MM" 또는 "HH:MM:SS" → 시간(소수). 자정을 넘기는 일정은 없다고 본다. */
function toHours(time: string): number {
  const [h, m] = String(time).split(":").map(Number);
  return h + (m || 0) / 60;
}

function todayInSeoul(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

/** 한 달 화면이 필요한 것 전부. 일정 목록 + 통계 + 미작성. */
export type MonthOverview = {
  schedules: ScheduleItem[];
  stats: ScheduleStats;
  missing: Array<{
    schedule_id: string;
    staff_id: string;
    staff_name: string | null;
    role: Role | null;
    color_index: number | null;
    sched_date: string;
    start_time: string;
    end_time: string;
  }>;
};

/**
 * 스케줄 화면이 한 번에 받는 것.
 *
 * 예전에는 목록·통계·미작성을 따로 읽어 Supabase 왕복이 다섯 번이었다.
 * 셋 다 같은 두 벌(그 달 일정, 그 달 봉사일지)에서 나오므로 두 번만 읽고 나눠 쓴다.
 */
export async function monthOverview(year: number, month: number): Promise<MonthOverview> {
  const { from, to } = monthRange(year, month);
  const client = getClient();

  const [schedules, journals] = await Promise.all([
    client
      .from("schedules")
      .select(COLUMNS)
      .gte("sched_date", from)
      .lte("sched_date", to)
      .order("sched_date", { ascending: true })
      .order("start_time", { ascending: true }),
    client
      .from("journals")
      .select("journal_date, author_id, schedule_id, as_role")
      .eq("kind", "봉사")
      .gte("journal_date", from)
      .lte("journal_date", to),
  ]);

  if (schedules.error) throw new Error(`일정 조회 실패: ${schedules.error.message}`);
  if (journals.error) throw new Error(`봉사일지 조회 실패: ${journals.error.message}`);

  const rows = (schedules.data ?? []).map(flatten);
  // deno-lint-ignore no-explicit-any
  const raw = (schedules.data ?? []) as any[];

  // 일지가 일정을 직접 가리키면 그 일정만 "작성"이다.
  // 아직 안 이어진 옛 일지는 같은 날·같은 사람·같은 역할로 본다(015 이전 방식 + 겸직).
  // 미작성 목록(listMissingJournals)과 같은 기준 — 역할이 하나인 사람은 예전과 똑같다.
  const byScheduleId = new Set(
    (journals.data ?? []).filter((j) => j.schedule_id).map((j) => j.schedule_id as string),
  );
  const byDayPerson = new Set(
    (journals.data ?? [])
      .filter((j) => !j.schedule_id && j.author_id)
      .map((j) => `${j.journal_date} ${j.author_id} ${j.as_role ?? "*"}`),
  );
  const hasJournal = (
    row: { id: string; sched_date: string; staff_id: string; staff_role: string | null },
  ) => {
    const day = `${row.sched_date} ${row.staff_id}`;
    return byScheduleId.has(row.id) || byDayPerson.has(`${day} ${row.staff_role}`) ||
      byDayPerson.has(`${day} *`);
  };

  const today = todayInSeoul();
  const people = new Map<string, PersonStat>();
  const missing: MonthOverview["missing"] = [];

  for (const [index, row] of rows.entries()) {
    const staff = raw[index]?.staff;
    // 사람 × 역할로 센다. 겸직자는 "멘토로 몇 시간, 봉사자로 몇 시간" 이 따로 보여야 한다.
    const personKey = `${row.staff_id}|${row.staff_role ?? ""}`;
    const stat = people.get(personKey) ?? {
      staff_id: row.staff_id,
      name: row.staff_name,
      role: row.staff_role,
      color_index: row.color_index,
      schedules: 0,
      hours: 0,
      written: 0,
      missing: 0,
    };
    stat.schedules += 1;
    stat.hours += Math.max(0, toHours(row.end_time) - toHours(row.start_time));

    if (row.sched_date <= today) {
      if (hasJournal(row)) {
        stat.written += 1;
      } else {
        stat.missing += 1;
        // 그만둔 사람은 독촉하지 않는다
        if (staff?.status === "활동중") {
          missing.push({
            schedule_id: row.id,
            staff_id: row.staff_id,
            staff_name: row.staff_name,
            role: row.staff_role,
            color_index: row.color_index,
            sched_date: row.sched_date,
            start_time: row.start_time,
            end_time: row.end_time,
          });
        }
      }
    }
    people.set(personKey, stat);
  }

  return { schedules: rows, stats: summarize(people), missing };
}

/** 사람별 집계를 요약·역할별 소계로 묶는다. */
function summarize(people: Map<string, PersonStat>): ScheduleStats {
  const list = [...people.values()].sort((a, b) =>
    String(a.role).localeCompare(String(b.role), "ko") ||
    String(a.name).localeCompare(String(b.name), "ko")
  );

  const byRole = new Map<string, RoleStat>();
  for (const p of list) {
    const key = p.role ?? "역할 없음";
    const g = byRole.get(key) ??
      { role: key, people: 0, hours: 0, schedules: 0, written: 0, missing: 0 };
    g.people += 1;
    g.hours += p.hours;
    g.schedules += p.schedules;
    g.written += p.written;
    g.missing += p.missing;
    byRole.set(key, g);
  }

  const totals = list.reduce(
    (acc, p) => ({
      hours: acc.hours + p.hours,
      schedules: acc.schedules + p.schedules,
      written: acc.written + p.written,
      missing: acc.missing + p.missing,
    }),
    { hours: 0, schedules: 0, written: 0, missing: 0 },
  );

  return { totals, people: list, by_role: [...byRole.values()] };
}

export type ScheduleItem = {
  id: string;
  staff_id: string;
  sched_date: string; // "YYYY-MM-DD"
  start_time: string; // "HH:MM"
  end_time: string;
  /** 화면에 보여주려고 조인해서 함께 읽는다 */
  staff_name: string | null;
  /** 이 일정의 역할(as_role, 029). 옛 줄에 비어 있으면 사람의 대표 역할 */
  staff_role: Role | null;
  as_role: Role | null;
  color_index: number | null;
};

export type NewSchedule = {
  staff_id: string;
  sched_date: string;
  start_time: string;
  end_time: string;
  /** 어느 역할 활동인지 — 기록할 때 박아 둔다 */
  as_role: Role | null;
};

// status 는 ScheduleItem 에 담지 않지만 함께 읽는다.
// 미작성 목록에서 그만둔 사람을 빼려면 필요하다 — 안 읽으면 그 검사가 늘 거짓이 된다.
const COLUMNS =
  "id, staff_id, sched_date, start_time, end_time, as_role, staff:staff(name, role, color_index, status)";

/** 시각은 "HH:MM:SS" 로 오는데 화면에서는 초가 필요 없다. */
function trimSeconds(time: string | null): string {
  return String(time ?? "").slice(0, 5);
}

// deno-lint-ignore no-explicit-any
function flatten(row: any): ScheduleItem {
  const { staff, ...rest } = row;
  return {
    ...rest,
    start_time: trimSeconds(row.start_time),
    end_time: trimSeconds(row.end_time),
    staff_name: staff?.name ?? null,
    staff_role: row.as_role ?? staff?.role ?? null,
    color_index: staff?.color_index ?? null,
  } as ScheduleItem;
}

/** 그 달의 첫날과 마지막날. 달력이 읽는 범위와 같아야 한다. */
export function monthRange(year: number, month: number): { from: string; to: string } {
  const pad = (n: number) => String(n).padStart(2, "0");
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from: `${year}-${pad(month)}-01`, to: `${year}-${pad(month)}-${pad(lastDay)}` };
}

/**
 * 여러 날짜를 한 번에 등록한다.
 *
 * 이미 있는 날(같은 사람·같은 날·같은 시각)은 조용히 건너뛴다.
 * 여러 날을 한 번에 넣다 보면 이미 넣은 날이 섞이기 쉬운데,
 * 그 한 건 때문에 나머지가 통째로 실패하면 쓰기 어렵다.
 * DB의 unique 제약이 마지막으로 막지만, 여기서 먼저 걸러 낸다.
 */
export async function addSchedules(
  items: NewSchedule[],
): Promise<{ created: ScheduleItem[]; skipped: number }> {
  if (items.length === 0) return { created: [], skipped: 0 };

  const client = getClient();
  const dates = items.map((item) => item.sched_date).sort();

  const { data: existing, error: readError } = await client
    .from("schedules")
    .select("staff_id, sched_date, start_time")
    .in("staff_id", [...new Set(items.map((item) => item.staff_id))])
    .gte("sched_date", dates[0])
    .lte("sched_date", dates[dates.length - 1]);

  if (readError) {
    throw new Error(`기존 일정 확인 실패: ${readError.message}`);
  }

  const key = (staffId: string, date: string, start: string) =>
    `${staffId} ${date} ${trimSeconds(start)}`;
  const taken = new Set(
    (existing ?? []).map((row) => key(row.staff_id, row.sched_date, row.start_time)),
  );

  const fresh = items.filter(
    (item) => !taken.has(key(item.staff_id, item.sched_date, item.start_time)),
  );
  if (fresh.length === 0) return { created: [], skipped: items.length };

  const { data, error } = await client
    .from("schedules")
    .insert(fresh)
    .select(COLUMNS);

  if (error) {
    throw new Error(`스케줄 등록 실패: ${error.message}`);
  }
  return { created: (data ?? []).map(flatten), skipped: items.length - fresh.length };
}

/**
 * 일정 하나. 없으면 null.
 *
 * "이 줄이 내 것인가" 를 보려고 만든 자리다(api/my.ts 의 mustOwnSchedule).
 * 그쪽에서 Supabase 를 직접 부르면 원칙 1 이 깨지므로 여기로 옮겨 둔다.
 */
export async function getSchedule(id: string): Promise<ScheduleItem | null> {
  const { data, error } = await getClient()
    .from("schedules")
    .select(COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    throw new Error(`일정 조회 실패: ${error.message}`);
  }
  return data ? flatten(data) : null;
}

/** 날짜·시각을 고친다. 사람은 바꾸지 않는다 — 사람이 바뀌면 다른 일정이다. */
export async function updateSchedule(
  id: string,
  patch: { sched_date?: string; start_time?: string; end_time?: string },
): Promise<ScheduleItem> {
  const changes: Record<string, unknown> = {};
  if (patch.sched_date !== undefined) changes.sched_date = patch.sched_date;
  if (patch.start_time !== undefined) changes.start_time = patch.start_time;
  if (patch.end_time !== undefined) changes.end_time = patch.end_time;

  if (Object.keys(changes).length === 0) {
    throw new Error("바꿀 내용이 없습니다.");
  }

  const { data, error } = await getClient()
    .from("schedules")
    .update(changes)
    .eq("id", id)
    .select(COLUMNS)
    .single();

  if (error) {
    throw writeError(
      error,
      "스케줄 수정 실패",
      "그 일정을 찾지 못했습니다. 이미 지워졌을 수 있어요.",
    );
  }
  return flatten(data);
}

export async function deleteSchedule(id: string): Promise<void> {
  // 이 일정으로 쓴 봉사일지가 있으면 지울 수 없다.
  // 일지의 시각이 일정에서 오므로, 일정이 사라지면 일지가 시각을 잃는다.
  // DB 도 on delete restrict 로 막지만, 여기서 먼저 세어야 읽을 수 있는 말로 알린다.
  const { count, error: countError } = await getClient()
    .from("journals")
    .select("id", { count: "exact", head: true })
    .eq("schedule_id", id);

  if (countError) {
    throw new Error(`딸린 일지 확인 실패: ${countError.message}`);
  }
  if ((count ?? 0) > 0) {
    throw new RuleError(
      `이 일정으로 쓴 봉사일지가 ${count}건 있습니다. 일지를 먼저 지운 뒤 일정을 지워 주세요.`,
    );
  }

  const before = await snapshotRow("schedules", id);
  if (!before) throw new NotFoundError("그 일정을 찾지 못했습니다. 이미 지워졌을 수 있어요.");
  const { error } = await getClient()
    .from("schedules")
    .delete()
    .eq("id", id);

  if (error) {
    throw new Error(`스케줄 삭제 실패: ${error.message}`);
  }
  await recordAudit({
    action: "delete",
    table_name: "schedules",
    record_id: id,
    summary: `일정 삭제 — ${before?.sched_date ?? ""} ${
      String(before?.start_time ?? "").slice(0, 5)
    }`
      .trim(),
    before,
  });
}

export type ScheduledPerson = {
  /** 이 일정의 id. 봉사일지가 이것을 가리킨다. */
  schedule_id: string;
  staff_id: string;
  name: string;
  /** 이 일정의 역할 */
  role: Role | null;
  start_time: string;
  end_time: string;
};

/**
 * 그 날짜에 일정이 잡힌 사람들. 봉사일지의 작성자 후보로 쓴다.
 *
 * 활동중인 사람만 돌려준다. 그만둔 사람의 옛 일정은 달력에는 남지만
 * 새 일지의 작성자로 고를 일은 없다.
 *
 * 한 사람이 하루에 두 번 오면 두 줄로 나온다.
 * 시각이 다르므로 고를 때 구분되어야 하기 때문.
 */
export async function listStaffScheduledOn(date: string): Promise<ScheduledPerson[]> {
  const { data, error } = await getClient()
    .from("schedules")
    .select("id, staff_id, start_time, end_time, as_role, staff:staff(name, role, status)")
    .eq("sched_date", date)
    .order("start_time", { ascending: true });

  if (error) {
    throw new Error(`그 날 일정 조회 실패: ${error.message}`);
  }

  return (data ?? [])
    // deno-lint-ignore no-explicit-any
    .filter((row: any) => row.staff?.status === "활동중")
    // deno-lint-ignore no-explicit-any
    .map((row: any) => ({
      schedule_id: row.id,
      staff_id: row.staff_id,
      name: row.staff?.name ?? "",
      role: row.as_role ?? row.staff?.role ?? null,
      start_time: trimSeconds(row.start_time),
      end_time: trimSeconds(row.end_time),
    }));
}

/* ---------- 한 사람의 한 해 ---------- */

export type Tally = { schedules: number; hours: number; written: number };

/** 달 하나. by_role 은 그 달을 일정의 역할(as_role)로 가른 것 — 겸직자 화면만 쓴다. */
export type MonthStat = Tally & { month: number; by_role: Record<string, Tally> };

/**
 * 한 사람의 한 해를 달마다 센다. 봉사자 폰의 [나] 가 쓴다.
 *
 * 예전에는 monthOverview 를 열두 번 불렀다 — 달마다 전체 봉사자의 일정과 일지를
 * 읽고 그중 한 사람만 골랐으니 Supabase 왕복 스물네 번이었다(약 0.8초).
 * 여기서는 그 사람 것만, 한 해치를 두 번에 읽는다.
 *
 * [세는 기준은 monthOverview 와 같아야 한다]
 * PC 근무 통계와 폰 [나] 의 수가 다르면 사람이 어느 쪽을 믿을지 모른다.
 *   - 일정 하나 = 1번, 시각 차이 = 시간
 *   - 오늘까지 지난 일정 중 일지가 있으면 "작성"
 *   - 일지가 일정을 가리키면 그 일정, 안 이어진 옛 일지는 같은 날·같은 사람·같은 역할
 */
export async function staffYearStats(staffId: string, year: number): Promise<MonthStat[]> {
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  const client = getClient();

  const schedules = await client
    .from("schedules")
    .select("id, sched_date, start_time, end_time, as_role")
    .eq("staff_id", staffId)
    .gte("sched_date", from)
    .lte("sched_date", to);
  if (schedules.error) throw new Error(`일정 조회 실패: ${schedules.error.message}`);

  const rows = (schedules.data ?? []) as Array<
    { id: string; sched_date: string; start_time: string; end_time: string; as_role: string | null }
  >;

  // 이 사람 일정을 가리키는 일지 + 이 사람이 쓴 안 이어진 옛 일지.
  // 일정을 가리키는 일지는 누가 썼든 "작성" 이다(monthOverview 와 같다).
  const ids = rows.map((one) => one.id);
  const filter = ids.length
    ? `author_id.eq.${staffId},schedule_id.in.(${ids.join(",")})`
    : `author_id.eq.${staffId}`;
  const journals = await client
    .from("journals")
    .select("journal_date, author_id, schedule_id, as_role")
    .eq("kind", "봉사")
    .gte("journal_date", from)
    .lte("journal_date", to)
    .or(filter);
  if (journals.error) throw new Error(`봉사일지 조회 실패: ${journals.error.message}`);

  const byScheduleId = new Set(
    (journals.data ?? []).filter((j) => j.schedule_id).map((j) => j.schedule_id as string),
  );
  // 안 이어진 옛 일지 — 같은 날·같은 역할(역할이 빈 옛 일지는 그 날 모든 역할)
  const byDay = new Set(
    (journals.data ?? [])
      .filter((j) => !j.schedule_id && j.author_id === staffId)
      .map((j) => `${j.journal_date} ${j.as_role ?? "*"}`),
  );

  const today = todayInSeoul();
  const months: MonthStat[] = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    schedules: 0,
    hours: 0,
    written: 0,
    by_role: {},
  }));

  for (const row of rows) {
    const stat = months[Number(row.sched_date.slice(5, 7)) - 1];
    const role = row.as_role ?? "역할 없음";
    const part = stat.by_role[role] ??= { schedules: 0, hours: 0, written: 0 };
    const hours = Math.max(0, toHours(row.end_time) - toHours(row.start_time));
    const written = row.sched_date <= today &&
      (byScheduleId.has(row.id) || byDay.has(`${row.sched_date} ${role}`) ||
        byDay.has(`${row.sched_date} *`));
    for (const tally of [stat, part]) {
      tally.schedules += 1;
      tally.hours += hours;
      if (written) tally.written += 1;
    }
  }
  return months;
}
