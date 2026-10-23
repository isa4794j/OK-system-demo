/**
 * 폰 첫 화면 환영 — 로그인 뒤 한 번(이 탭이 열려 있는 동안 한 번)
 *
 *   "○○님, 어서 오세요" + [시작]
 *   할 일이 있으면 그 아래에:
 *     다음 일정이 없다(오늘 이후 일정 없음) → [일정 등록]
 *     안 쓴 일지가 있다(이번 달, 오늘까지)  → [일지 쓰러 가기]
 *   둘 다 없으면 환영만.
 *
 * PC 에는 만들지 않는다(사용자 결정 — 오늘 할 일 카드 없음).
 * 막는 창이 아니다 — [시작] 이나 바깥을 누르면 닫히고, 다음에는 뜨지 않는다.
 */
import { today } from "./form.js";

const el = {
  box: document.getElementById("m-welcome"),
  title: document.getElementById("m-welcome-title"),
  todo: document.getElementById("m-welcome-todo"),
  start: document.getElementById("m-welcome-start"),
};

const KEY = "ok-m-welcome";

function seen(id) {
  try {
    return sessionStorage.getItem(KEY) === id;
  } catch {
    return false;
  }
}

function markSeen(id) {
  try {
    sessionStorage.setItem(KEY, id);
  } catch {
    // 못 적으면 다음에 한 번 더 뜰 뿐이다
  }
}

/** 로그아웃할 때 지운다 — 같은 탭에서 다른 사람이 들어오면 그 사람도 환영을 본다 */
export function forgetWelcome() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // 없으면 그만
  }
}

function plusDays(date, days) {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

/** 지금(한국 시각) "HH:MM" */
function nowTime() {
  return new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit" });
}

/**
 * 할 일을 센다 — 내 일정 하나의 요청(이번 달 1일 ~ 반년 뒤)으로 둘 다 본다.
 * 실패하면 할 일 없이 환영만(창 하나 때문에 화면을 막지 않는다).
 */
async function countTodo(get) {
  const day = today();
  const from = `${day.slice(0, 8)}01`;
  try {
    const payload = await get(`/api/my/schedules?from=${from}&to=${plusDays(day, 180)}`);
    const list = payload.schedules ?? [];
    const now = nowTime();
    const upcoming = list.some((one) =>
      one.sched_date > day || (one.sched_date === day && String(one.end_time ?? "").slice(0, 5) > now)
    );
    const unwritten = list.filter((one) => one.unwritten && one.sched_date <= day).length;
    return { upcoming, unwritten };
  } catch {
    return { upcoming: true, unwritten: 0 };
  }
}

function todoRow(text, label, run) {
  const row = document.createElement("div");
  row.className = "mwelcome__row";
  const p = document.createElement("p");
  p.className = "mwelcome__text";
  p.textContent = text;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "mbtn mbtn--small";
  btn.textContent = label;
  btn.addEventListener("click", run);
  row.append(p, btn);
  return row;
}

/**
 * @param {{ id: string, name: string }} me
 * @param {{ get: Function, goTab: Function, addSchedule: Function }} go 화면 이동(app.js·schedule.js 가 넘긴다)
 */
export async function maybeWelcome(me, { get, goTab, addSchedule }) {
  if (!me?.id || seen(me.id)) return;
  markSeen(me.id);

  const { upcoming, unwritten } = await countTodo(get);
  const close = () => {
    el.box.hidden = true;
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (event) => {
    if (event.key === "Escape") close();
  };

  el.title.textContent = `${me.name}님, 어서 오세요`;
  el.todo.replaceChildren();
  if (!upcoming) {
    el.todo.append(todoRow("다음 일정이 없어요. 다음 일정을 등록해 주세요.", "일정 등록", () => {
      close();
      goTab("schedule");
      addSchedule();
    }));
  }
  if (unwritten > 0) {
    el.todo.append(todoRow(`안 쓴 일지 ${unwritten}건`, "일지 쓰러 가기", () => {
      close();
      goTab("journal");
    }));
  }
  el.todo.hidden = el.todo.childElementCount === 0;
  el.start.onclick = close;
  el.box.onclick = (event) => {
    if (event.target === el.box) close();
  };
  document.addEventListener("keydown", onKey);
  el.box.hidden = false;
  el.start.focus();
}
