/**
 * 멘토·봉사자 스케줄 — 달력으로 보고 등록한다.
 *
 * 달력은 그 달 전체 일정을 보여준다. 특정한 한 사람이 아니라 모두를.
 * 누가 언제 오는지를 한눈에 보려고 만든 화면이기 때문.
 *
 * 등록은 "날짜를 하나씩 더하는" 방식이다. 사람과 시각을 위에서 고르고,
 * 아래에 날짜 줄을 더해 가며 한 번에 넣는다. 줄마다 시각을 따로 고칠 수 있다.
 * 기간+요일로 넣던 방식은 뺐다 — 실제로는 "이번 주 화·목, 다음 주는 수요일만" 처럼
 * 규칙이 없는 날들을 넣는 일이 많았다.
 *
 * 달력 위에는 이 달의 근무 요약이 한 줄로 있다. 사람별 내역은 접어 두었다 —
 * 이 화면의 주인공은 달력이고, 통계는 곁들이는 것이다.
 * "미작성 N건"을 누르면 누가 언제 안 썼는지 펼쳐지고 거기서 바로 일지를 쓴다.
 *
 * 목록·통계·미작성은 요청 하나로 함께 받는다. 셋 다 같은 두 벌에서 나온다.
 * 받은 달은 캐시에 두고 앞뒤 달을 미리 받는다 — 달 이동이 바로 보이게.
 *
 * 브라우저는 Supabase에 직접 접근하지 않는다. 항상 /api/... 를 거친다.
 */
import {
  button,
  confirmDialog,
  fillOptions,
  get,
  hideState,
  pad,
  remove,
  send,
  showState,
  toast,
  todayISO,
  personColor,
} from "./ui.js";
import { analyzeSaved, openVolunteerJournal } from "./volunteer_journal.js";
import { mountRoleFilter, roleDotClass } from "./role_filter.js";
import { closePicker, pickMonth } from "./m/month_picker.js";

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

const state = {
  month: currentMonth(), // "YYYY-MM"
  schedules: [],
  people: [],
  stats: null,
  /** 일정은 있는데 봉사일지가 없는 것 */
  missing: [],
  /** "YYYY-MM" -> { schedules, stats, missing }. 달 이동이 바로 보이게. */
  cache: new Map(),
  /** 사람별 내역을 펼쳐 두었는가 */
  peopleOpen: false,
  /** 미작성 목록을 펼쳐 두었는가 */
  missingOpen: false,
  /**
   * 역할 거르기("" = 전체). 받은 달 전체를 화면에서 거른다 — 서버는 늘 전체를 준다
   * (캐시가 역할마다 따로 생기지 않게). 주소·저장값에 남기지 않는다.
   */
  role: "",
  loading: false,
  error: null,

  selectedDate: null, // 눌러서 펼친 날
  /** 좁은 화면 달·날짜 판으로 고른 기간 { from, to } — 보고 있는 달 안으로 자른다 */
  span: null,
  editing: null, // 수정 중인 일정
  /** 등록 폼의 날짜 줄. { date, start, end } */
  rows: [],
  /** 폼을 열 때의 값. 닫을 때 바뀌었는지 보는 데 쓴다. */
  initial: "",
  pending: false,
};

const el = {
  view: document.getElementById("view-schedule"),
  count: document.getElementById("sched-count"),
  prev: document.getElementById("sched-prev"),
  next: document.getElementById("sched-next"),
  monthInput: document.getElementById("sched-month"),
  pick: document.getElementById("sched-pick"),
  cal: document.getElementById("sched-cal"),
  pickClear: document.getElementById("sched-pick-clear"),
  addOpen: document.getElementById("sched-add-open"),
  roleFilter: document.getElementById("sched-role-filter"),

  modal: document.getElementById("sched-modal"),
  backdrop: document.getElementById("sched-backdrop"),
  form: document.getElementById("sched-form"),
  formTitle: document.getElementById("sched-form-title"),
  person: document.getElementById("sched-person"),
  roleField: document.getElementById("sched-role-field"),
  role: document.getElementById("sched-role"),
  datesLabel: document.getElementById("sched-dates-label"),
  dates: document.getElementById("sched-dates"),
  addDate: document.getElementById("sched-add-date"),
  preview: document.getElementById("sched-preview"),
  submit: document.getElementById("sched-submit"),
  cancel: document.getElementById("sched-cancel"),

  statbar: document.getElementById("sched-statbar"),
  peopleToggle: document.getElementById("sched-people-toggle"),
  missing: document.getElementById("sched-missing"),
  statsPeople: document.getElementById("sched-stats-people"),
  statsState: document.getElementById("sched-stats-state"),

  calendar: document.getElementById("calendar"),
  state: document.getElementById("sched-state"),

  day: document.getElementById("sched-day"),
  dayTitle: document.getElementById("sched-day-title"),
  dayList: document.getElementById("sched-day-list"),
  dayClose: document.getElementById("sched-day-close"),
};
el.state.dataset.inline = "true";
el.statsState.dataset.inline = "true";

/* ---------- 날짜 도구 ---------- */

function currentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
}

function shiftMonth(month, delta) {
  const [year, mon] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, mon - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}`;
}

function monthLabel(month) {
  const [year, mon] = month.split("-").map(Number);
  return `${year}년 ${mon}월`;
}

function daysInMonth(month) {
  const [year, mon] = month.split("-").map(Number);
  return new Date(Date.UTC(year, mon, 0)).getUTCDate();
}

/** 그 달 1일이 무슨 요일인지 (0=일) */
function firstWeekday(month) {
  const [year, mon] = month.split("-").map(Number);
  return new Date(Date.UTC(year, mon - 1, 1)).getUTCDay();
}

function dateOf(month, day) {
  return `${month}-${pad(day)}`;
}

/** "YYYY-MM-DD" 의 요일 (0=일). UTC로 만들어야 시간대에 흔들리지 않는다. */
function weekdayOf(date) {
  const [year, mon, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, mon - 1, day)).getUTCDay();
}

function dayLabel(date) {
  const [, mon, day] = date.split("-").map(Number);
  return `${mon}월 ${day}일 (${WEEKDAYS[weekdayOf(date)]})`;
}

/** 시간을 "12.5시간" 처럼. 소수점이 0이면 뺀다. */
function hoursLabel(hours) {
  const n = Math.round(hours * 10) / 10;
  return `${Number.isInteger(n) ? n : n.toFixed(1)}시간`;
}

/* ---------- 화면 전환 (app.js가 부른다) ---------- */

export function showSchedule() {
  el.view.hidden = false;
  el.monthInput.value = state.month;
  closeForm();
  closeDay();
  loadPeople();
  loadSchedules();
}

export function hideSchedule() {
  el.view.hidden = true;
}

/* ---------- 데이터 ---------- */

async function loadPeople() {
  try {
    // 일정을 넣을 수 있는 사람은 지금 활동 중인 멘토·봉사자뿐이다.
    // 그만둔 사람의 이미 잡힌 일정은 달력에 그대로 보이지만, 새로 넣지는 않는다.
    const params = new URLSearchParams();
    params.append("role", "멘토");
    params.append("role", "봉사자");
    const payload = await get(`/api/staff?${params}`);
    state.people = payload.staff ?? [];
  } catch (error) {
    console.error("[loadPeople]", error);
    toast(error.message, true);
  }
}

/** 그 달을 서버에서 받는다. 캐시에 넣고 그대로 돌려준다. */
async function fetchMonth(month) {
  const [year, mon] = month.split("-").map(Number);
  const payload = await get(`/api/schedules?year=${year}&month=${mon}`);
  const overview = {
    schedules: payload.schedules ?? [],
    stats: payload.stats ?? null,
    missing: payload.missing ?? [],
  };
  state.cache.set(month, overview);
  return overview;
}

function applyOverview(overview) {
  state.schedules = overview.schedules;
  state.stats = overview.stats;
  state.missing = overview.missing;
}

/**
 * 앞뒤 달을 미리 받아 둔다. 실패해도 조용히 넘어간다 — 미리 받기는 덤이다.
 * 달 이동은 대개 ‹ › 로 한 칸씩이라, 이 둘만 있어도 거의 늘 바로 보인다.
 */
function prefetchNeighbors() {
  for (const delta of [-1, 1]) {
    const month = shiftMonth(state.month, delta);
    if (state.cache.has(month)) continue;
    fetchMonth(month).catch((error) => console.warn("[prefetch]", month, error.message));
  }
}

/** 목록·통계·미작성을 한 번에 읽는다. 캐시에 있으면 바로 그린다. */
async function loadSchedules() {
  const month = state.month;
  const cached = state.cache.get(month);

  if (cached) {
    // 캐시가 있으면 기다리지 않고 그린다. 달 이동이 끊기지 않게.
    applyOverview(cached);
    state.loading = false;
    state.error = null;
    render();
    prefetchNeighbors();
    return;
  }

  state.loading = true;
  state.error = null;
  state.stats = null;
  state.missing = [];
  render();

  try {
    const overview = await fetchMonth(month);
    // 기다리는 사이에 다른 달로 옮겼으면 그 달을 덮어쓰지 않는다
    if (state.month !== month) return;
    applyOverview(overview);
  } catch (error) {
    if (state.month !== month) return;
    state.error = error.message;
    state.schedules = [];
  } finally {
    if (state.month === month) {
      state.loading = false;
      render();
      prefetchNeighbors();
    }
  }
}

/**
 * 일정이나 일지가 바뀐 뒤 다시 센다.
 * 캐시를 통째로 비운다 — 어느 달이 영향을 받는지 따지느니 다시 받는 편이 단순하다.
 */
async function refreshMonth() {
  state.cache.clear();
  const month = state.month;
  try {
    const overview = await fetchMonth(month);
    if (state.month !== month) return;
    applyOverview(overview);
    render();
  } catch (error) {
    console.error("[refreshMonth]", error);
  }
}

function schedulesOn(date) {
  return visibleSchedules().filter((item) => item.sched_date === date);
}

/* ---------- 역할 거르기 ---------- */

function roleMatches(role) {
  return !state.role || role === state.role;
}

function visibleSchedules() {
  return state.schedules.filter((item) => roleMatches(item.staff_role));
}

function visibleMissing() {
  return state.missing.filter((item) => roleMatches(item.role));
}

/**
 * 거른 통계. 사람 줄은 이미 사람×역할이라 역할로 고르기만 하면 되고,
 * 합계는 고른 줄에서 다시 더한다. 전체면 서버 값 그대로.
 */
function visibleStats() {
  const stats = state.stats;
  if (!stats || !state.role) return stats;
  const people = stats.people.filter((p) => roleMatches(p.role));
  const totals = { hours: 0, schedules: 0, written: 0, missing: 0 };
  for (const p of people) {
    totals.hours += p.hours;
    totals.schedules += p.schedules;
    totals.written += p.written;
    totals.missing += p.missing;
  }
  return { totals, people, by_role: stats.by_role.filter((g) => roleMatches(g.role)) };
}

mountRoleFilter(el.roleFilter, {
  suffix: "만",
  onChange: (role) => {
    state.role = role;
    render();
  },
});

/* ---------- 달력 ---------- */

function render() {
  el.calendar.replaceChildren();
  hideState(el.state);

  el.count.textContent = `${monthLabel(state.month)} · ` +
    (state.role ? `${state.role} ` : "") + `일정 ${visibleSchedules().length}건`;
  renderStats();
  renderMissing();

  if (state.loading) {
    showState(el.state, "불러오는 중…");
    return;
  }
  if (state.error) {
    showState(el.state, state.error, null, true);
    return;
  }

  for (const name of WEEKDAYS) {
    const head = document.createElement("div");
    head.className = "calendar__weekday";
    head.textContent = name;
    el.calendar.append(head);
  }

  for (let i = 0; i < firstWeekday(state.month); i += 1) {
    const blank = document.createElement("div");
    blank.className = "calendar__cell calendar__cell--blank";
    el.calendar.append(blank);
  }

  const total = daysInMonth(state.month);
  for (let day = 1; day <= total; day += 1) {
    el.calendar.append(renderDay(dateOf(state.month, day), day));
  }

  const filled = firstWeekday(state.month) + total;
  for (let i = filled; i % 7 !== 0; i += 1) {
    const blank = document.createElement("div");
    blank.className = "calendar__cell calendar__cell--blank";
    el.calendar.append(blank);
  }

  renderDayPanel();
}

function inSpan(date) {
  return !!state.span && date >= state.span.from && date <= state.span.to;
}

/** "9월 2일" / "9월 2일~9월 5일" */
function spanLabel(from, to) {
  const day = (date) => `${Number(date.slice(5, 7))}월 ${Number(date.slice(8))}일`;
  return from === to ? day(from) : `${day(from)}~${day(to)}`;
}

/** 좁은 화면 달 버튼 — 고른 날/기간, 아니면 달. [×] 는 날짜가 걸렸을 때만 */
function syncPick() {
  const picked = state.selectedDate ?? null;
  el.pick.textContent = picked
    ? spanLabel(picked, picked)
    : state.span
    ? spanLabel(state.span.from, state.span.to)
    : monthLabel(state.month);
  el.pickClear.hidden = !picked && !state.span;
}

function renderDay(date, day) {
  const items = schedulesOn(date);

  const cell = document.createElement("button");
  cell.type = "button";
  cell.className = "calendar__cell";
  cell.dataset.date = date;
  if (state.selectedDate === date) cell.classList.add("is-selected");
  if (!state.selectedDate && inSpan(date)) cell.classList.add("is-inspan");
  if (items.length === 0) cell.classList.add("is-empty");
  cell.setAttribute("aria-pressed", String(state.selectedDate === date));

  const number = document.createElement("span");
  number.className = "calendar__day";
  if (weekdayOf(date) === 0) number.classList.add("calendar__day--sun");
  number.textContent = String(day);
  cell.append(number);

  const chips = document.createElement("span");
  chips.className = "calendar__chips";

  for (const item of items.slice(0, 3)) {
    const chip = document.createElement("span");
    chip.className = `personchip personchip--${personColor(item)}`;

    const dot = document.createElement("span");
    dot.className = "personchip__dot" + roleDotClass(item.staff_role);

    const name = document.createElement("span");
    // 이름은 사용자 입력이므로 textContent로만 넣는다
    name.textContent = item.staff_name ?? "?";
    chip.title = `${item.staff_name ?? "?"} · ${item.staff_role ?? ""}`;

    chip.append(dot, name);
    chips.append(chip);
  }
  if (items.length > 3) {
    const more = document.createElement("span");
    more.className = "calendar__more";
    more.textContent = `+${items.length - 3}`;
    chips.append(more);
  }

  cell.append(chips);
  cell.addEventListener("click", () => toggleDay(date));
  return cell;
}

/* ---------- 그날 일정 ---------- */

/** 같은 날을 다시 누르면 접힌다. 전체 달력으로 돌아간다는 뜻이다. */
function toggleDay(date) {
  closePicker();
  // 하루를 누르면 판으로 고른 기간은 풀린다
  state.span = null;
  if (state.selectedDate === date) {
    closeDay();
    render();
    return;
  }
  state.selectedDate = date;
  render();
  el.day.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function closeDay() {
  state.selectedDate = null;
  el.day.hidden = true;
}

/** 좁은 화면(/m 일정 탭 구성) — 날짜를 안 골랐을 때 그 달 목록을 달력 아래에 둔다 */
const NARROW = globalThis.matchMedia?.("(max-width: 720px)");
NARROW?.addEventListener?.("change", () => {
  placeRoleFilter();
  if (!el.view.hidden) renderDayPanel();
});

/**
 * 역할 거르기 자리 — 넓은 화면은 달력 상자 안 위쪽(작게, 범례 옆), 좁은 화면은 달 이동 아래 줄(/m 구성).
 * 버튼 줄은 한 벌이라 폭이 바뀌면 옮기기만 한다.
 */
const roleHome = { parent: el.roleFilter.parentElement, next: el.roleFilter.nextSibling };
const calHead = document.getElementById("sched-calhead");
function placeRoleFilter() {
  if (NARROW?.matches) {
    if (el.roleFilter.parentElement !== roleHome.parent) {
      roleHome.parent.insertBefore(el.roleFilter, roleHome.next);
    }
  } else if (el.roleFilter.parentElement !== calHead) {
    calHead.prepend(el.roleFilter);
  }
}
placeRoleFilter();

function renderDayPanel() {
  syncPick();
  // 좁은 화면은 늘 달(또는 고른 기간) 목록, 넓은 화면은 판으로 기간을 골랐을 때만
  const monthList = !state.selectedDate && (!!NARROW?.matches || !!state.span);
  if (!state.selectedDate && !monthList) {
    el.day.hidden = true;
    return;
  }

  el.day.hidden = false;
  // 달 목록일 때는 접을 것이 없다
  el.dayClose.hidden = monthList;
  const listName = state.span
    ? spanLabel(state.span.from, state.span.to)
    : `${monthLabel(state.month).replace(/^\d+년 /, "")} 전체`;
  el.dayTitle.textContent = monthList
    ? `${listName}${state.role ? ` · ${state.role}` : ""}`
    : dayLabel(state.selectedDate);
  el.dayList.replaceChildren();

  const items = monthList
    ? [...visibleSchedules()].filter((item) => !state.span || inSpan(item.sched_date)).sort((a, b) =>
      a.sched_date.localeCompare(b.sched_date) || String(a.start_time).localeCompare(String(b.start_time))
    )
    : schedulesOn(state.selectedDate);
  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "extract__note";
    empty.textContent = monthList
      ? state.span ? "그 기간에는 잡힌 일정이 없습니다." : "이 달에는 잡힌 일정이 없습니다."
      : "이 날은 잡힌 일정이 없습니다.";
    el.dayList.append(empty);
    return;
  }

  for (const item of items) {
    el.dayList.append(renderDayRow(item, monthList));
  }
}

const ICONS = {
  edit:
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  remove:
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};

/** 아이콘 버튼(44px, 좁은 화면 전용). 모양은 고정 SVG 라 innerHTML — 사용자 글이 섞이지 않는다 */
function iconButton(kind, label, run) {
  const node = document.createElement("button");
  node.type = "button";
  node.className = `dayicon narrow-only${kind === "remove" ? " dayicon--danger" : ""}`;
  node.setAttribute("aria-label", label);
  node.title = label;
  node.innerHTML = ICONS[kind];
  node.addEventListener("click", run);
  return node;
}

/** "16(수)" — 달은 제목에 있다 */
function shortDay(date) {
  return `${Number(date.slice(8))}(${WEEKDAYS[weekdayOf(date)]})`;
}

/**
 * 그날(또는 그 달) 일정 한 줄.
 * 좁은 화면은 /m 처럼 한 줄 — 날짜 · 이름 · 시간 · 역할 · 연필 · ×(아이콘 44px).
 * 넓은 화면은 예전 그대로 — [수정]/[삭제] 글자 버튼(날짜 칸·아이콘은 숨김).
 */
function renderDayRow(item, withDate = false) {
  const row = document.createElement("div");
  row.className = "dayplan__row";

  if (withDate) {
    const day = document.createElement("span");
    day.className = "dayplan__date";
    day.textContent = shortDay(item.sched_date);
    day.setAttribute("aria-label", dayLabel(item.sched_date));
    row.append(day);
  }

  const who = document.createElement("span");
  who.className = `personchip personchip--${personColor(item)}`;
  const dot = document.createElement("span");
  dot.className = "personchip__dot" + roleDotClass(item.staff_role);
  const name = document.createElement("span");
  name.textContent = item.staff_name ?? "?";
  who.append(dot, name);

  const role = document.createElement("span");
  role.className = "roletag";
  role.textContent = item.staff_role ?? "";

  const time = document.createElement("span");
  time.className = "dayplan__time";
  // 넓은 화면은 "14:00 ~ 16:00", 좁은 화면은 한 줄에 들도록 "14:00–16:00"
  const wide = document.createElement("span");
  wide.className = "wide-only";
  wide.textContent = `${item.start_time} ~ ${item.end_time}`;
  const narrow = document.createElement("span");
  narrow.className = "narrow-only";
  narrow.textContent = `${item.start_time}–${item.end_time}`;
  time.append(wide, narrow);

  const actions = document.createElement("span");
  actions.className = "dayplan__actions";
  actions.append(
    button("수정", "linkbtn wide-only", () => openEdit(item)),
    button("삭제", "linkbtn linkbtn--danger wide-only", () => askDelete(item)),
    iconButton("edit", "일정 수정", () => openEdit(item)),
    iconButton("remove", "일정 삭제", () => askDelete(item)),
  );

  row.append(who, role, time, actions);
  return row;
}

/* ---------- 근무 통계 ---------- */

/** 요약 바의 한 칸. onClick 을 주면 누를 수 있는 칸이 된다. */
function statItem(label, value, { onClick = null, warn = false } = {}) {
  const box = document.createElement(onClick ? "button" : "div");
  if (onClick) {
    box.type = "button";
    box.addEventListener("click", onClick);
  }
  box.className = "statbar__item" +
    (onClick ? " statbar__item--click" : "") +
    (warn ? " statbar__item--warn" : "");

  const v = document.createElement("strong");
  v.className = "statbar__value";
  v.textContent = value;

  const l = document.createElement("span");
  l.className = "statbar__label";
  l.textContent = label;

  box.append(v, l);
  return box;
}

function renderStats() {
  el.statbar.replaceChildren();
  el.statsPeople.replaceChildren();
  el.statsPeople.hidden = !state.peopleOpen;
  el.peopleToggle.setAttribute("aria-expanded", String(state.peopleOpen));
  el.peopleToggle.textContent = state.peopleOpen ? "사람별 접기 ▴" : "사람별 보기 ▾";
  hideState(el.statsState);

  const stats = visibleStats();
  if (!stats) {
    if (state.loading) showState(el.statsState, "불러오는 중…");
    return;
  }

  const t = stats.totals;
  el.statbar.append(
    statItem("총 근무", hoursLabel(t.hours)),
    statItem("일정", `${t.schedules}건`),
    statItem("일지 작성", `${t.written}건`),
    // 미작성만 누를 수 있다. 눌러서 할 일이 있는 유일한 숫자다.
    statItem(t.missing > 0 ? (state.missingOpen ? "미작성 · 접기 ▴" : "미작성 · 눌러서 보기 ▾") : "미작성", `${t.missing}건`, {
      warn: t.missing > 0,
      onClick: t.missing > 0
        ? () => {
          state.missingOpen = !state.missingOpen;
          renderMissing();
          renderStats();
        }
        : null,
    }),
  );

  // 역할이 둘 이상 섞인 달이면 접어 둔 상태에서도 역할별 소계를 한 줄로 보인다
  if (stats.by_role.length > 1) el.statbar.append(renderRoleSubtotals(stats.by_role));

  if (!state.peopleOpen) return;

  if (stats.people.length === 0) {
    showState(
      el.statsState,
      state.role ? `이 달에는 ${state.role} 일정이 없습니다.` : "이 달에는 잡힌 일정이 없습니다.",
    );
    return;
  }

  // 역할별로 묶어 소계 한 줄 + 사람 줄들
  for (const group of stats.by_role) {
    const head = document.createElement("div");
    head.className = "stats__group";
    head.textContent = `${group.role} 소계 · ${group.people}명 · ${hoursLabel(group.hours)} · ` +
      `일정 ${group.schedules}건 · 작성 ${group.written ?? 0}` +
      (group.missing ? ` · 미작성 ${group.missing}` : "");
    el.statsPeople.append(head);

    for (const person of stats.people.filter((p) => p.role === group.role)) {
      el.statsPeople.append(renderPersonStat(person));
    }
  }
}

/** 요약 바 끝의 역할별 소계 — "봉사자 12시간·5건 · 멘토 4시간·2건" */
function renderRoleSubtotals(groups) {
  const box = document.createElement("span");
  box.className = "statbar__roles";
  box.textContent = groups
    .map((g) => `${g.role} ${hoursLabel(g.hours)}·${g.schedules}건`)
    .join(" · ");
  return box;
}

/**
 * 미작성 목록. 요약 바의 "미작성"을 눌러야 펼쳐진다.
 *
 * 여기서 바로 일지를 쓸 수 있다. 날짜·사람·일정이 이미 정해져 있으니
 * 봉사일지 화면으로 건너가 다시 고를 이유가 없다.
 */
function renderMissing() {
  el.missing.replaceChildren();

  const missing = visibleMissing();
  if (!state.missingOpen || missing.length === 0) {
    el.missing.hidden = true;
    return;
  }

  const title = document.createElement("p");
  title.className = "missing__title";
  title.textContent = `일지를 안 쓴 일정 ${missing.length}건`;

  const list = document.createElement("ul");
  list.className = "missing__list";

  for (const item of missing) {
    const li = document.createElement("li");
    li.className = "missing__item";

    const who = document.createElement("span");
    who.className = `personchip personchip--${personColor(item)} missing__who`;
    const dot = document.createElement("span");
    dot.className = "personchip__dot" + roleDotClass(item.role);
    const name = document.createElement("span");
    // 이름은 사용자 입력이므로 textContent로만 넣는다
    name.textContent = item.staff_name ?? "?";
    who.append(dot, name);

    const role = document.createElement("span");
    role.className = "roletag";
    role.textContent = item.role ?? "";

    const when = document.createElement("span");
    when.textContent = `${dayLabel(item.sched_date)} ${item.start_time}~${item.end_time}`;

    li.append(who, role, when, button("일지 작성", "linkbtn", () => writeFor(item)));
    list.append(li);
  }

  el.missing.replaceChildren(title, list);
  el.missing.hidden = false;
}

/** 미작성 한 줄에서 바로 봉사일지를 쓴다. 저장되면 통계가 따라 바뀐다. */
async function writeFor(item) {
  const saved = await openVolunteerJournal({
    schedule_id: item.schedule_id,
    sched_date: item.sched_date,
    staff_id: item.staff_id,
    staff_name: item.staff_name,
    role: item.role,
    start_time: item.start_time,
    end_time: item.end_time,
  });
  if (!saved) return;
  await refreshMonth();
  // 목록에서 쓴 봉사일지와 똑같이 분석한다. AI 왕복이라 기다리지 않는다.
  analyzeSaved(saved.id);
}

function renderPersonStat(person) {
  const row = document.createElement("div");
  row.className = "stats__row";

  const who = document.createElement("span");
  who.className = `personchip personchip--${personColor(person)}`;
  const dot = document.createElement("span");
  dot.className = "personchip__dot" + roleDotClass(person.role);
  const name = document.createElement("span");
  name.textContent = person.name ?? "?";
  who.append(dot, name);

  const role = document.createElement("span");
  role.className = "roletag";
  role.textContent = person.role ?? "";

  const count = document.createElement("span");
  count.className = "stats__num";
  count.textContent = `${person.schedules}회`;

  const hours = document.createElement("span");
  hours.className = "stats__num";
  hours.textContent = hoursLabel(person.hours);

  const written = document.createElement("span");
  written.className = "stats__num";
  written.textContent = person.missing > 0
    ? `작성 ${person.written} · 미작성 ${person.missing}`
    : `작성 ${person.written}`;
  if (person.missing > 0) written.classList.add("stats__num--warn");

  row.append(who, role, count, hours, written);
  return row;
}

/* ---------- 등록 · 수정 폼 (모달) ---------- */

function fillPeople(selectedId) {
  if (state.people.length === 0) {
    fillOptions(el.person, [{ value: "", label: "활동 중인 멘토·봉사자가 없습니다" }]);
    el.person.disabled = true;
    return;
  }
  el.person.disabled = false;
  fillOptions(el.person, [
    { value: "", label: "사람을 고르세요" },
    ...state.people.map((person) => ({
      value: person.id,
      label: `${person.name} (${rolesOf(person).join("·") || "-"})`,
    })),
  ]);
  if (selectedId) el.person.value = selectedId;
  syncRoleField();
}

function rolesOf(person) {
  if (Array.isArray(person?.roles) && person.roles.length) return person.roles;
  return person?.role ? [person.role] : [];
}

/**
 * 겸직인 사람을 골랐을 때만 역할 칸을 보인다. 이 일정이 어느 역할 활동인지 사람이 고른다.
 * 역할이 하나인 사람은 칸이 없다 — 서버가 그 역할로 적는다(예전과 똑같이).
 * 고른 명단(멘토·봉사자) 밖의 역할은 목록에 넣지 않는다.
 */
function syncRoleField() {
  const person = state.people.find((one) => one.id === el.person.value);
  const roles = rolesOf(person).filter((role) => role === "멘토" || role === "봉사자");
  const multi = roles.length > 1 && !state.editing;
  // 종사자이면서 멘토인 사람처럼 봉사 역할이 하나뿐이면 고를 것 없이 그 역할로 보낸다
  // (역할이 둘 이상이라 서버는 역할을 받아야 한다).
  el.role.dataset.auto = !multi && roles.length === 1 && rolesOf(person).length > 1 ? roles[0] : "";
  el.roleField.hidden = !multi;
  if (!multi) {
    el.role.replaceChildren();
    return;
  }
  fillOptions(el.role, [
    { value: "", label: "어느 역할 활동인가요?" },
    ...roles.map((role) => ({ value: role, label: role })),
  ]);
}

/**
 * 날짜 줄 전부 — 모달을 열 때만 그린다.
 *
 * 줄을 더하거나 뺄 때는 다시 그리지 않고 그 줄만 넣고 뺀다(addDateRow·빼기).
 * 통째로 다시 그리면 줄이 많을 때 [+ 날짜 추가] 가 매번 모달 아래로 밀려 끝까지 내려야 했다.
 */
function renderDateRows() {
  el.dates.replaceChildren();
  for (const row of state.rows) el.dates.append(dateRowEl(row));
  syncDateRows();
}

/** 줄 번호(화면 낭독기)와 [✕] 잠금을 지금 줄 수에 맞춘다 — 마지막 한 줄은 뺄 수 없다 */
function syncDateRows() {
  el.dates.querySelectorAll(".daterow").forEach((line, index) => {
    line.querySelector('input[type="date"]')?.setAttribute("aria-label", `${index + 1}번째 날짜`);
    const del = line.querySelector(".daterow__remove");
    if (del) del.disabled = state.rows.length === 1;
  });
}

/** 날짜 줄 하나. 줄마다 날짜와 시각을 함께 갖는다. */
function dateRowEl(row) {
  const single = Boolean(state.editing);
  const line = document.createElement("div");
  line.className = "daterow";

  const date = document.createElement("input");
  date.type = "date";
  date.className = "input";
  date.value = row.date;
  date.required = true;
  date.addEventListener("change", () => {
    row.date = date.value;
    updatePreview();
  });

  const start = document.createElement("input");
  start.type = "time";
  start.className = "input";
  start.value = row.start;
  start.required = true;
  start.setAttribute("aria-label", "시작 시각");
  start.addEventListener("change", () => {
    row.start = start.value;
  });

  const tilde = document.createElement("span");
  tilde.className = "daterow__tilde";
  tilde.textContent = "~";

  const end = document.createElement("input");
  end.type = "time";
  end.className = "input";
  end.value = row.end;
  end.required = true;
  end.setAttribute("aria-label", "종료 시각");
  end.addEventListener("change", () => {
    row.end = end.value;
  });

  line.append(date, start, tilde, end);

  // 수정은 하루짜리라 줄을 뺄 수 없다. 등록도 마지막 한 줄은 남긴다.
  if (!single) {
    const del = button("✕", "linkbtn daterow__remove", () => {
      if (state.rows.length === 1) return;
      state.rows.splice(state.rows.indexOf(row), 1);
      line.remove();
      syncDateRows();
      updatePreview();
    });
    del.setAttribute("aria-label", "이 날짜 빼기");
    line.append(del);
  }

  return line;
}

function addDateRow() {
  // 새 줄은 바로 위 줄을 본뜬다 — 날짜는 그 다음 날, 시각은 그대로.
  // 봉사는 같은 시각에 여러 날 오는 일이 많아 이 편이 손이 덜 간다.
  const last = state.rows[state.rows.length - 1];
  let next = last ? last.date : (state.selectedDate ?? todayISO());
  if (last?.date) {
    const [y, m, d] = last.date.split("-").map(Number);
    const t = new Date(Date.UTC(y, m - 1, d + 1));
    next = `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
  }
  const row = {
    date: next,
    start: last?.start ?? "14:00",
    end: last?.end ?? "16:00",
  };
  state.rows.push(row);
  const line = dateRowEl(row);
  el.dates.append(line);
  syncDateRows();
  updatePreview();
  // 새 줄 날짜 칸으로 초점. 스크롤은 직접 — [+ 날짜 추가] 가 모달 안에 보이게 남긴다
  // (새 줄은 바로 위라 함께 보인다). 연달아 누를 수 있어야 한다.
  line.querySelector("input")?.focus({ preventScroll: true });
  const sheet = scrollerOf(el.addDate);
  if (sheet) sheet.scrollTop = sheet.scrollHeight;
}

/** 모달에서 실제로 굴러가는 칸. scrollIntoView 는 폰에서 화면 전체까지 끌어 움직여 튄다. */
function scrollerOf(node) {
  for (let p = node.parentElement; p; p = p.parentElement) {
    if (p.scrollHeight > p.clientHeight && /auto|scroll/.test(getComputedStyle(p).overflowY)) return p;
  }
  return null;
}

function updatePreview() {
  if (state.editing) {
    el.preview.textContent = "";
    return;
  }
  const valid = state.rows.filter((row) => row.date).length;
  const unique = new Set(state.rows.map((row) => `${row.date} ${row.start}`)).size;
  el.preview.textContent = valid === 0
    ? "등록할 날짜가 없습니다."
    : unique < valid
    ? `${unique}일 등록됩니다 (같은 날·같은 시각이 겹쳐 ${valid - unique}줄은 하나로 칩니다)`
    : `${valid}일 등록됩니다.`;
}

/** 폼의 지금 값을 한 줄로. 열 때와 견줘 "입력 중"인지 본다. */
function formValues() {
  return JSON.stringify([el.person.value, el.role.value, state.rows]);
}

function openCreate() {
  state.editing = null;

  el.formTitle.textContent = "일정 등록";
  el.submit.textContent = "등록";
  el.datesLabel.textContent = "날짜";
  el.addDate.hidden = false;

  fillPeople();

  // 첫 줄은 달력에서 고른 날, 없으면 오늘
  state.rows = [{ date: state.selectedDate ?? todayISO(), start: "14:00", end: "16:00" }];
  renderDateRows();
  updatePreview();

  openModal();
  el.person.focus();
}

function openEdit(item) {
  state.editing = item;

  el.formTitle.textContent = `${item.staff_name} 일정 수정`;
  el.submit.textContent = "저장";
  el.datesLabel.textContent = "날짜와 시각";
  el.addDate.hidden = true;

  // 수정은 하루짜리다. 사람은 바꾸지 않는다 — 사람이 바뀌면 다른 일정이다.
  fillPeople(item.staff_id);
  el.person.disabled = true;

  state.rows = [{ date: item.sched_date, start: item.start_time, end: item.end_time }];
  renderDateRows();
  updatePreview();

  openModal();
  el.dates.querySelector("input")?.focus();
}

function openModal() {
  el.modal.hidden = false;
  state.initial = formValues();
}

function closeForm() {
  state.editing = null;
  state.rows = [];
  el.modal.hidden = true;
  el.person.disabled = false;
  el.roleField.hidden = true;
}

/** 취소·바깥 클릭·Esc. 입력 중이면 한 번 묻는다. 저장 중에는 닫지 않는다. */
async function askClose() {
  if (state.pending || el.modal.hidden) return;
  if (formValues() !== state.initial) {
    const yes = await confirmDialog({
      title: "입력 중인 내용을 버릴까요?",
      message: "저장하지 않은 내용이 사라집니다.",
      confirmText: "버리기",
    });
    if (!yes) return;
  }
  closeForm();
}

/* ---------- 저장 (낙관적 갱신) ---------- */

function snapshot() {
  return state.schedules.map((item) => ({ ...item }));
}

function restore(saved) {
  state.schedules = saved;
  render();
}

function sortSchedules() {
  state.schedules.sort((a, b) => {
    if (a.sched_date !== b.sched_date) return a.sched_date < b.sched_date ? -1 : 1;
    return a.start_time < b.start_time ? -1 : a.start_time > b.start_time ? 1 : 0;
  });
}

/** 줄마다 날짜·시각이 맞는지. 문제가 있으면 그 이유. */
function checkRows() {
  for (const [index, row] of state.rows.entries()) {
    const n = index + 1;
    if (!row.date) return `${n}번째 줄의 날짜를 입력해 주세요.`;
    if (!row.start || !row.end) return `${n}번째 줄의 시각을 입력해 주세요.`;
    if (row.end <= row.start) return `${n}번째 줄의 종료 시각은 시작 시각보다 뒤여야 합니다.`;
  }
  return null;
}

async function submit(event) {
  event.preventDefault();
  if (state.pending) return;

  const problem = checkRows();
  if (problem) {
    toast(problem, true);
    return;
  }

  state.pending = true;
  el.submit.disabled = true;
  const saved = snapshot();

  try {
    if (state.editing) await saveEdit(saved);
    else await saveNew(saved);
  } finally {
    state.pending = false;
    el.submit.disabled = false;
  }
}

async function saveNew(saved) {
  const staffId = el.person.value;
  if (!staffId) {
    toast("사람을 골라 주세요.", true);
    return;
  }
  // 겸직이면 역할을 골라야 한다(서버도 막는다)
  const asRole = el.roleField.hidden ? (el.role.dataset.auto || null) : el.role.value;
  if (!el.roleField.hidden && !asRole) {
    toast("겸직인 사람은 어느 역할 활동인지 골라 주세요.", true);
    return;
  }

  // 같은 날·같은 시각이 두 줄이면 하나로. 서버도 거르지만 여기서 먼저.
  const seen = new Set();
  const items = [];
  for (const row of state.rows) {
    const key = `${row.date} ${row.start}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ sched_date: row.date, start_time: row.start, end_time: row.end });
  }

  try {
    const result = await send("/api/schedules", "POST", {
      staff_id: staffId,
      items,
      ...(asRole ? { as_role: asRole } : {}),
    });

    for (const item of result.created ?? []) {
      if (item.sched_date.startsWith(state.month)) state.schedules.push(item);
    }
    sortSchedules();
    closeForm();
    render();
    refreshMonth();

    const created = result.created?.length ?? 0;
    toast(
      result.skipped > 0
        ? `일정 ${created}건을 등록했습니다. 이미 있던 ${result.skipped}건은 건너뛰었습니다.`
        : `일정 ${created}건을 등록했습니다`,
    );
  } catch (error) {
    restore(saved);
    // 모달은 그대로. 입력값이 남아 있어 고쳐서 다시 낼 수 있다.
    toast(error.message, true);
  }
}

async function saveEdit(saved) {
  const target = state.editing;
  const [rowValues] = state.rows;
  const patch = {
    sched_date: rowValues.date,
    start_time: rowValues.start,
    end_time: rowValues.end,
  };

  const row = state.schedules.find((item) => item.id === target.id);
  if (row) Object.assign(row, patch);
  sortSchedules();
  closeForm();
  render();

  try {
    const payload = await send(`/api/schedules/${target.id}`, "PATCH", patch);
    const index = state.schedules.findIndex((item) => item.id === target.id);
    if (index >= 0) state.schedules[index] = payload.schedule;
    sortSchedules();
    render();
    refreshMonth();
    toast("저장되었습니다");
  } catch (error) {
    restore(saved);
    toast(error.message, true);
  }
}

/* ---------- 삭제 ---------- */

async function askDelete(item) {
  if (state.pending) return;

  const yes = await confirmDialog({
    title: "일정을 삭제할까요?",
    message: [
      `${item.staff_name} · ${dayLabel(item.sched_date)} ${item.start_time}~${item.end_time}`,
      "이 일정을 지우면 되돌릴 수 없습니다.\n" +
      "이 일정으로 쓴 봉사일지가 있으면 지워지지 않습니다 — 일지를 먼저 지워 주세요.",
    ].join("\n"),
    confirmText: "삭제",
  });
  if (!yes) return;

  const saved = snapshot();
  state.pending = true;
  state.schedules = state.schedules.filter((row) => row.id !== item.id);
  render();

  try {
    await remove(`/api/schedules/${item.id}`);
    refreshMonth();
    toast("일정을 삭제했습니다");
  } catch (error) {
    restore(saved);
    toast(error.message, true);
  } finally {
    state.pending = false;
  }
}

/* ---------- 이벤트 ---------- */

function goToMonth(month) {
  closePicker();
  state.month = month;
  state.span = null;
  el.monthInput.value = month;
  closeForm();
  closeDay();
  syncPick();
  loadSchedules();
}

/**
 * 좁은 화면 달 버튼 — 달·날짜 고르기(/m 과 같은 판).
 * 하루면 그날 목록, 기간이면 달 목록을 그 기간으로 거른다. 일정은 달 단위로 받으므로
 * 기간은 시작일의 달 안으로 자른다(달을 넘긴 끝은 그 달 마지막 날까지).
 */
async function openSchedPicker() {
  if (closePicker()) return;
  const [year, month] = state.month.split("-").map(Number);
  const picked = await pickMonth(el.pick.parentElement, {
    year,
    month,
    from: state.selectedDate ?? state.span?.from ?? null,
    to: state.selectedDate ?? state.span?.to ?? null,
    withDay: true,
  });
  if (!picked) return;
  const target = `${picked.year}-${pad(picked.month)}`;
  if (target !== state.month) goToMonth(target);
  if (!picked.from) {
    state.span = null;
    closeDay();
    render();
    return;
  }
  const monthEnd = dateOf(target, daysInMonth(target));
  const to = picked.to > monthEnd ? monthEnd : picked.to;
  if (picked.from === to) {
    state.span = null;
    state.selectedDate = picked.from;
  } else {
    closeDay();
    state.span = { from: picked.from, to };
    if (to !== picked.to) toast("일정은 달 단위로 봅니다 — 이 달 마지막 날까지만 보여요.");
  }
  render();
}
el.pick.addEventListener("click", openSchedPicker);
el.cal.addEventListener("click", openSchedPicker);

el.pickClear.addEventListener("click", () => {
  if (closePicker()) return;
  state.span = null;
  closeDay();
  render();
});

el.prev.addEventListener("click", () => goToMonth(shiftMonth(state.month, -1)));
el.next.addEventListener("click", () => goToMonth(shiftMonth(state.month, 1)));
el.monthInput.addEventListener("change", () => {
  if (!el.monthInput.value) {
    el.monthInput.value = state.month;
    return;
  }
  goToMonth(el.monthInput.value);
});

el.peopleToggle.addEventListener("click", () => {
  state.peopleOpen = !state.peopleOpen;
  renderStats();
});

el.addOpen.addEventListener("click", openCreate);
el.cancel.addEventListener("click", askClose);
el.backdrop.addEventListener("click", askClose);
el.form.addEventListener("submit", submit);
el.person.addEventListener("change", syncRoleField);
el.addDate.addEventListener("click", addDateRow);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !el.modal.hidden) askClose();
});
el.dayClose.addEventListener("click", () => {
  closeDay();
  render();
});
