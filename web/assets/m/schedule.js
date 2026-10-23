/**
 * 일정 탭 — 달력 하나
 *
 * "내가 언제 가지" 와 "그날 누가 오지" 가 같은 화면에서 답이 나온다.
 * 목록을 따로 두면 같은 것을 두 군데서 읽게 되고, 둘이 어긋나는 날이 온다.
 *
 * 날짜를 누르면 그날만, 다시 누르면 놓여서 그 달 전체가 아래에 펼쳐진다.
 * 넣고 고치고 지우는 것도 거기서 한다 — 내 것만이다.
 * 화면에서도 내 줄에만 손댈 자리를 두지만, 실제로 막는 것은 서버다
 * (api/my.ts 의 mustOwnSchedule).
 *
 * 아동은 실리지 않는다 — 일정 표 자체가 아동과 이어진 곳이 없다.
 */
import { confirmDialog, toast } from "../ui.js";
import { send, whoAmI } from "./app.js";
import { openBody, today } from "./form.js";
import { dayLabel, loadView, refreshView, thisMonth, timeLabel } from "./view.js";
import { dotShape, mountRoleChips, rolePill } from "./role_chips.js";
import { closePicker, pickMonth } from "./month_picker.js";

const el = {
  stale: document.getElementById("sched-stale"),
  month: document.getElementById("cal-month"),
  prev: document.getElementById("cal-prev"),
  next: document.getElementById("cal-next"),
  mine: document.getElementById("cal-mine"),
  role: document.getElementById("cal-role"),
  bar: document.getElementById("cal-bar"),
  monthBtn: document.getElementById("cal-month-btn"),
  grid: document.getElementById("cal-grid"),
  dayTitle: document.getElementById("day-title"),
  dayAdd: document.getElementById("day-add"),
  dayList: document.getElementById("day-list"),
  dayEmpty: document.getElementById("day-empty"),
  state: document.getElementById("m-state"),
};

const now = thisMonth();

const state = {
  year: now.year,
  month: now.month,
  /** 켜면 달력도 아래 목록도 내 것만 남는다 */
  mineOnly: false,
  /** 역할 거르기("" = 전체). 화면에서만 거른다 — 받은 달·스냅샷은 늘 전체 */
  role: "",
  /** 고른 날짜 "YYYY-MM-DD". 놓으면 null 이고 그 달 전체가 보인다. */
  picked: null,
  rows: [],
};

/* ---------- 데이터 ---------- */

/**
 * 이 달 스케줄표. 내 것도 여기 함께 온다 — staff_id 로 가른다.
 *
 * 이번 달만 담아 둔다. 지난달·다음달을 넘겨 볼 때까지 담으면
 * 열쇠가 달마다 늘어나 폰에 쌓이기만 한다. 그때는 그냥 서버에서 받는다.
 */
function view() {
  const isThisMonth = state.year === now.year && state.month === now.month;
  return {
    name: isThisMonth ? "roster" : null,
    url: `/api/my/roster?year=${state.year}&month=${state.month}`,
    stale: el.stale,
    state: el.state,
    draw: (data) => {
      state.rows = data.schedules ?? [];
      render();
    },
  };
}

export function showSchedule() {
  loadView(view());
}

async function reload() {
  await refreshView(view());
}

function todayISO() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

function pad(n) {
  return String(n).padStart(2, "0");
}

/** 지금 화면에 보일 줄. [내 일정만]·역할 거르기를 함께 적용한다. */
function visibleRows() {
  const me = whoAmI();
  return state.rows.filter((one) =>
    (!state.mineOnly || one.staff_id === me?.id) &&
    (!state.role || one.staff_role === state.role)
  );
}

/* ---------- 그리기 ---------- */

function render() {
  el.month.textContent = `${state.year}년 ${state.month}월`;

  const me = whoAmI();
  const rows = visibleRows();

  const byDate = new Map();
  for (const one of rows) {
    const list = byDate.get(one.sched_date) ?? [];
    list.push(one);
    byDate.set(one.sched_date, list);
  }
  for (const list of byDate.values()) {
    list.sort((a, b) => String(a.start_time).localeCompare(String(b.start_time)));
  }

  drawGrid(byDate, me);
  drawList(byDate, me);
}

function drawGrid(byDate, me) {
  el.grid.replaceChildren();

  const first = new Date(state.year, state.month - 1, 1);
  const days = new Date(state.year, state.month, 0).getDate();
  const now = todayISO();

  // 1일이 무슨 요일인지만큼 앞을 비운다. 빈 칸은 누를 것이 없으므로 버튼이 아니다.
  for (let i = 0; i < first.getDay(); i++) {
    const blank = document.createElement("span");
    blank.className = "mcal__day mcal__day--blank";
    el.grid.append(blank);
  }

  for (let day = 1; day <= days; day++) {
    const date = `${state.year}-${pad(state.month)}-${pad(day)}`;
    const list = byDate.get(date) ?? [];
    const mine = list.some((one) => one.staff_id === me?.id);

    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "mcal__day";
    cell.dataset.date = date;
    if (date === now) cell.classList.add("is-today");
    if (date === state.picked) cell.classList.add("is-picked");
    if (mine) cell.classList.add("is-mine");
    // 요일과 날짜만으로는 화면 낭독기가 무엇이 잡혀 있는지 못 읽는다.
    cell.setAttribute(
      "aria-label",
      `${state.month}월 ${day}일${mine ? ", 내 일정" : ""}${
        list.length ? `, ${list.length}명` : ""
      }`,
    );
    if (date === state.picked) cell.setAttribute("aria-current", "date");

    const num = document.createElement("span");
    num.className = "mcal__num";
    num.textContent = String(day);
    cell.append(num);

    // 점 하나가 한 사람이다. 넷을 넘으면 줄이 접히므로 거기서 끊는다.
    const dots = document.createElement("span");
    dots.className = "mcal__dots";
    for (const one of list.slice(0, 4)) {
      const dot = document.createElement("span");
      dot.className = (one.staff_id === me?.id ? "mcal__dot mcal__dot--mine" : "mcal__dot") +
        dotShape(one.staff_role);
      dots.append(dot);
    }
    cell.append(dots);

    // 고른 날을 다시 누르면 놓는다. 그 달 전체로 돌아가는 길이 이것뿐이면
    // 한 번 고른 뒤로는 다른 날을 하나씩 눌러 보는 수밖에 없다.
    cell.addEventListener("click", () => {
      state.picked = state.picked === date ? null : date;
      render();
    });

    el.grid.append(cell);
  }
}

/**
 * 달력 아래 목록.
 * 날짜를 안 골랐으면 이 달 **내 일정만**(날짜순) — 남의 일정은 날짜를 눌렀을 때만 그날 것을 본다.
 * 역할 거르기는 양쪽에 다 적용된다.
 */
function drawList(byDate, me) {
  el.dayList.replaceChildren();

  const dates = state.picked ? [state.picked] : [...byDate.keys()].sort();
  const rowsOf = (date) =>
    (byDate.get(date) ?? []).filter((one) => state.picked || one.staff_id === me?.id);
  const total = dates.reduce((sum, date) => sum + rowsOf(date).length, 0);

  el.dayTitle.textContent = state.picked
    ? dayLabel(state.picked)
    : `${state.month}월 내 일정${state.role ? ` · ${state.role}` : ""}`;

  el.dayEmpty.hidden = total > 0;
  const who = state.mineOnly ? "내 " : state.role ? `${state.role} ` : "";
  el.dayEmpty.textContent = state.picked
    ? (who ? `그날 ${who}일정이 없습니다.` : "그날은 오는 사람이 없습니다.")
    : `이번 달 내${state.role ? ` ${state.role}` : ""} 일정이 없습니다. 날짜를 누르면 그날 오는 사람이 보여요.`;

  // 넣기는 늘 열려 있다. 한 번에 여러 날을 넣을 수 있어 "그날 이미 있음" 이
  // 버튼을 감출 이유가 되지 않는다.
  el.dayAdd.hidden = false;

  for (const date of dates) {
    for (const one of rowsOf(date)) {
      el.dayList.append(renderRow(one, me, !state.picked));
    }
  }
}

/** "9:00–11:00" — 앞자리 0 은 뺀다(한 줄에 들어가게) */
function shortTime(start, end) {
  const t = (v) => timeLabel(v).replace(/^0/, "");
  return `${t(start)}–${t(end)}`;
}

/** "16일(수)" — 달은 제목에 있다 */
function shortDay(date) {
  const [y, m, d] = date.split("-").map(Number);
  const week = ["일", "월", "화", "수", "목", "금", "토"][new Date(y, m - 1, d).getDay()];
  return `${d}일(${week})`;
}

/**
 * 일정 한 줄 — 날짜(또는 이름) · 나 · 시간 · 역할 알약 · 연필 · ×.
 * 고치기·지우기는 아이콘(각 44px)이라 줄이 둘로 접히지 않는다.
 */
function renderRow(one, me, withDate) {
  const li = document.createElement("li");
  li.className = "mrow mrow--line";

  const isMine = one.staff_id === me?.id;

  const main = document.createElement("span");
  main.className = "mrow__main";
  // 이름은 사용자 입력이므로 textContent 로만 넣는다
  main.textContent = withDate ? shortDay(one.sched_date) : (isMine ? "나" : (one.staff_name ?? "?"));
  if (isMine && !withDate) main.classList.add("mrow__main--mine");
  if (withDate) main.setAttribute("aria-label", dayLabel(one.sched_date));

  const sub = document.createElement("span");
  sub.className = "mrow__sub mrow__sub--line";
  const time = shortTime(one.start_time, one.end_time);
  sub.textContent = withDate ? `${isMine ? "나" : (one.staff_name ?? "?")} · ${time}` : time;
  if (isMine && withDate) sub.classList.add("mrow__main--mine");

  li.append(main, sub);
  const pill = rolePill(one.staff_role);
  if (pill) li.append(pill);

  if (isMine) {
    const acts = document.createElement("span");
    acts.className = "mrow__acts";
    acts.append(
      iconBtn("edit", "시각 수정", () => editOne(one)),
      iconBtn("remove", "일정 삭제", () => removeOne(one)),
    );
    li.append(acts);
  }

  return li;
}

const ICONS = {
  edit:
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  remove:
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};

/** 아이콘 버튼(44px). 모양은 고정 SVG 라 innerHTML 로 넣는다 — 사용자 글이 섞이지 않는다. */
function iconBtn(kind, label, run) {
  const node = document.createElement("button");
  node.type = "button";
  node.className = kind === "remove" ? "micon micon--danger" : "micon";
  node.setAttribute("aria-label", label);
  node.title = label;
  node.innerHTML = ICONS[kind];
  node.addEventListener("click", run);
  return node;
}

/* ---------- 달 넘기기·내 것만 ---------- */

function moveMonth(step) {
  let year = state.year;
  let month = state.month + step;
  if (month < 1) {
    month = 12;
    year -= 1;
  } else if (month > 12) {
    month = 1;
    year += 1;
  }
  goMonth(year, month);
}

function goMonth(year, month) {
  closePicker();
  state.year = year;
  state.month = month;
  // 다른 달로 넘어가면 고른 날짜는 뜻이 없다. 그 달 전체로 시작한다.
  state.picked = null;
  loadView(view());
}

el.prev.addEventListener("click", () => moveMonth(-1));
el.next.addEventListener("click", () => moveMonth(1));

// 달 이름(📅) — 열두 달 고르기. 다시 누르면 접힌다.
el.monthBtn.addEventListener("click", async () => {
  if (closePicker()) return;
  const picked = await pickMonth(el.bar, { year: state.year, month: state.month });
  if (picked) goMonth(picked.year, picked.month);
});

mountRoleChips(el.role, (role) => {
  state.role = role;
  render();
});

el.mine.addEventListener("click", () => {
  state.mineOnly = !state.mineOnly;
  el.mine.classList.toggle("is-on", state.mineOnly);
  el.mine.setAttribute("aria-pressed", String(state.mineOnly));
  render();
});

/* ---------- 넣기 (여러 날) ---------- */

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 날짜 줄 여러 개를 받는 시트. PC 등록 모달과 같은 방식이다 —
 * 격주로 오는 사람이 한 달치를 한 번에 넣는 것이 실제 모습이라
 * 하루씩 일곱 번 여는 것은 폰에서 특히 손이 많이 간다.
 *
 * 새 줄은 바로 위 줄을 본뜬다: 날짜는 이레 뒤, 시각은 그대로.
 * 봉사는 같은 요일 같은 시각에 오는 일이 많다.
 */
function nextWeek(date) {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + 7));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

async function addMany() {
  // 고른 날이 있으면 그 날로 시작한다. 없으면 오늘.
  const rows = [{ date: state.picked ?? today(), start: "15:00", end: "18:00" }];

  const value = await openBody({
    title: "일정 넣기",
    submitText: "넣기",
    build: (panel) => {
      const box = document.createElement("div");
      box.className = "mdates";
      panel.append(box);

      const count = document.createElement("p");
      count.className = "mfield__hint";
      panel.append(count);

      const add = document.createElement("button");
      add.type = "button";
      add.className = "mbtn mbtn--wide";
      add.textContent = "+ 날짜 더하기";
      panel.append(add);

      // [줄만 더하고 뺀다 — 통째로 다시 그리지 않는다]
      // 예전에는 줄을 더할 때마다(날짜를 바꿀 때도) 목록을 비우고 다시 그렸다. 비우는 순간
      // 초점이 있던 칸이 사라져 폰에서는 시트가 맨 위로 튀었고, 새 줄과 [+ 날짜 더하기] 는
      // 매번 화면 아래로 밀려 끝까지 내려야 했다(PC 일지 카드에서 잡았던 것과 같은 모양).
      const update = () => {
        count.textContent = `${new Set(rows.map((one) => one.date)).size}일 넣습니다.`;
        // 마지막 한 줄은 뺄 수 없다 — 줄 수가 바뀔 때마다 맞춘다
        box.querySelectorAll(".mdate").forEach((line, i) => {
          line.querySelector(".mdate__date")?.setAttribute("aria-label", `${i + 1}번째 날짜`);
          const drop = line.querySelector(".mlink--danger");
          if (drop) drop.disabled = rows.length === 1;
        });
      };

      const append = (row) => {
        const line = dateRow(row, rows, {
          onChange: update,
          onDrop: () => {
            rows.splice(rows.indexOf(row), 1);
            line.remove();
            update();
          },
        });
        box.append(line);
        return line;
      };

      add.addEventListener("click", () => {
        const last = rows[rows.length - 1];
        const row = {
          date: last ? nextWeek(last.date) : today(),
          start: last?.start ?? "15:00",
          end: last?.end ?? "18:00",
        };
        rows.push(row);
        const line = append(row);
        update();
        // 새 줄의 날짜 칸으로 초점. 스크롤은 직접 맞춘다 — 시트 끝까지 내려
        // 새 줄 · [+ 날짜 더하기] · [넣기] 가 함께 보이게(버튼이 손 닿는 자리에 남는다).
        line.querySelector(".mdate__date")?.focus({ preventScroll: true });
        panel.scrollTop = panel.scrollHeight;
      });

      for (const row of rows) append(row);
      update();
    },
    read: () => rows.map((one) => ({ ...one })),
    onValidate: (list) => {
      for (const one of list) {
        if (!DATE.test(one.date)) return "날짜를 모두 골라 주세요.";
        if (!TIME.test(one.start) || !TIME.test(one.end)) {
          return "시각을 15:00 처럼 적어 주세요.";
        }
        if (one.end <= one.start) return "종료 시각이 시작 시각보다 빠른 줄이 있습니다.";
      }
      return null;
    },
  });
  if (!value) return;

  // 시각이 같은 날들을 한 번에 보낸다. 서버가 이미 있는 날은 건너뛴다.
  const groups = new Map();
  for (const one of value) {
    const key = `${one.start} ${one.end}`;
    groups.set(key, [...(groups.get(key) ?? []), one.date]);
  }

  try {
    let created = 0;
    let skipped = 0;
    for (const [key, dates] of groups) {
      const [start, end] = key.split(" ");
      const payload = await send("/api/my/schedules", "POST", {
        dates,
        start_time: start,
        end_time: end,
      });
      created += payload.created ?? 0;
      skipped += payload.skipped ?? 0;
    }
    toast(
      created === 0
        ? "이미 들어 있는 날입니다"
        : skipped > 0
        ? `${created}일 넣었습니다 (${skipped}일은 이미 있어 건너뜀)`
        : `${created}일 넣었습니다`,
    );
    await reload();
  } catch (error) {
    toast(error.message, true);
  }
}

/** 날짜 한 줄: 날짜 · 시작 · 종료 · [빼기]. 바뀌면 onChange, [빼기] 는 onDrop(줄은 부르는 쪽이 뺀다) */
function dateRow(row, rows, { onChange, onDrop }) {
  const line = document.createElement("div");
  line.className = "mdate";

  const date = document.createElement("input");
  date.type = "date";
  date.className = "mfield__input mdate__date";
  date.value = row.date;
  date.setAttribute("aria-label", `${rows.indexOf(row) + 1}번째 날짜`);
  date.addEventListener("change", () => {
    row.date = date.value;
    onChange();
  });

  const times = document.createElement("div");
  times.className = "mdate__times";

  const start = timeInput(row, "start", "시작 시각");
  const end = timeInput(row, "end", "종료 시각");

  const tilde = document.createElement("span");
  tilde.className = "mdate__tilde";
  tilde.textContent = "~";

  times.append(start, tilde, end);

  const drop = document.createElement("button");
  drop.type = "button";
  drop.className = "mlink mlink--danger";
  drop.textContent = "빼기";
  drop.setAttribute("aria-label", "이 날짜 빼기");
  // 마지막 한 줄은 남긴다. 줄이 하나도 없는 시트는 무엇을 넣을지 알 수 없다.
  drop.disabled = rows.length === 1;
  drop.addEventListener("click", () => {
    if (rows.length > 1) onDrop();
  });
  times.append(drop);

  line.append(date, times);
  return line;
}

function timeInput(row, key, label) {
  const node = document.createElement("input");
  node.type = "time";
  node.className = "mfield__input mdate__time";
  node.value = row[key];
  node.setAttribute("aria-label", label);
  node.addEventListener("change", () => {
    row[key] = node.value;
  });
  return node;
}

el.dayAdd.addEventListener("click", addMany);

/** 환영 창의 [일정 등록] — 달력 탭의 [+ 일정 넣기] 와 같은 시트 */
export function addSchedule() {
  addMany();
}

/* ---------- 고치기·지우기 ---------- */

async function editOne(one) {
  const row = { date: one.sched_date, start: timeLabel(one.start_time), end: timeLabel(one.end_time) };

  const value = await openBody({
    title: `${dayLabel(one.sched_date)} 시각 수정`,
    build: (panel) => {
      const times = document.createElement("div");
      times.className = "mdate__times";

      const tilde = document.createElement("span");
      tilde.className = "mdate__tilde";
      tilde.textContent = "~";

      times.append(timeInput(row, "start", "시작 시각"), tilde, timeInput(row, "end", "종료 시각"));
      panel.append(times);
    },
    read: () => ({ start_time: row.start, end_time: row.end }),
    onValidate: (v) => {
      if (!TIME.test(v.start_time)) return "시작 시각을 15:00 처럼 적어 주세요.";
      if (!TIME.test(v.end_time)) return "종료 시각을 18:00 처럼 적어 주세요.";
      if (v.end_time <= v.start_time) return "종료 시각이 시작 시각보다 빠릅니다.";
      return null;
    },
  });
  if (!value) return;

  try {
    await send(`/api/my/schedules/${one.id}`, "PATCH", value);
    toast("고쳤습니다");
    await reload();
  } catch (error) {
    toast(error.message, true);
  }
}

async function removeOne(one) {
  const yes = await confirmDialog({
    title: "이 일정을 삭제할까요?",
    message: `${dayLabel(one.sched_date)} ${timeLabel(one.start_time)}–${timeLabel(one.end_time)}\n` +
      "그날 쓴 일지가 있으면 일지를 먼저 지워야 합니다.",
    confirmText: "삭제",
  });
  if (!yes) return;

  try {
    await send(`/api/my/schedules/${one.id}`, "DELETE");
    toast("삭제했습니다");
    await reload();
  } catch (error) {
    toast(error.message, true);
  }
}
