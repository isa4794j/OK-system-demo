/**
 * 시스템 점검 — 관리자 전용
 *
 * [점검 실행] 을 누르면 서버가 검사를 돌리고 항목별로 ✅ ⚠️ ❌ 를 돌려준다.
 *
 * [읽기만 한다]
 * 이 화면에는 고치는 버튼이 없다. 이상이 보이면 사람이 보고 판단한다 —
 * 자동으로 고치면 "왜 이게 없어졌지" 를 아무도 설명할 수 없게 된다.
 *
 * [키 값은 여기 오지 않는다]
 * 환경변수는 서버가 있다/없다만 알려 준다. 값은 화면으로 절대 내려오지 않는다.
 *
 * 브라우저는 Supabase에 직접 접근하지 않는다. 항상 /api/... 를 거친다.
 */
import { get, hideState, send, showState, toast } from "./ui.js";

const MARK = { ok: "✅", warn: "⚠️", fail: "❌" };
const WORD = { ok: "정상", warn: "주의", fail: "문제" };

const state = {
  result: null,
  running: false,
  error: null,
  /** 펼친 상세: { key: rows | "loading" | error string } */
  details: {},
};

const el = {
  view: document.getElementById("view-syscheck"),
  run: document.getElementById("syscheck-run"),
  meta: document.getElementById("syscheck-meta"),
  list: document.getElementById("syscheck-list"),
  state: document.getElementById("syscheck-state"),
};

export function showSystemCheck() {
  el.view.hidden = false;
  render();
}

export function hideSystemCheck() {
  el.view.hidden = true;
}

/* ---------- 실행 ---------- */

async function run() {
  if (state.running) return;
  state.running = true;
  state.error = null;
  state.details = {};
  render();

  try {
    state.result = await send("/api/system-check", "POST", {});
    const t = state.result.tally;
    toast(`점검을 마쳤습니다 — 정상 ${t.ok} · 주의 ${t.warn} · 문제 ${t.fail}`);
  } catch (error) {
    state.error = error.message;
  } finally {
    state.running = false;
    render();
  }
}

el.run.addEventListener("click", run);

/* ---------- 그리기 ---------- */

function render() {
  el.list.replaceChildren();
  hideState(el.state);
  el.run.disabled = state.running;
  el.run.textContent = state.running ? "점검하는 중…" : "점검 실행";

  if (state.running) {
    el.meta.textContent = "";
    showState(el.state, "점검하는 중…", "기록 사이의 연결을 세고 있습니다. 몇 초 걸립니다.");
    return;
  }
  if (state.error) {
    showState(el.state, "점검을 마치지 못했습니다.", state.error, true);
    return;
  }
  if (!state.result) {
    el.meta.textContent = "";
    showState(
      el.state,
      "아직 점검하지 않았습니다.",
      "[점검 실행] 을 누르면 서버가 설정·데이터·권한을 읽고 결과를 보여 줍니다. 아무것도 고치지 않습니다.",
    );
    return;
  }

  const { ran_at: ranAt, tally, items } = state.result;
  el.meta.textContent = `${timeText(ranAt)} 실행 · 정상 ${tally.ok} · 주의 ${tally.warn} · 문제 ${tally.fail}`;

  for (const item of items) el.list.append(renderItem(item));
}

function timeText(iso) {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return iso;
  const pad = (n) => String(n).padStart(2, "0");
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ` +
    `${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}`;
}

function renderItem(item) {
  const li = document.createElement("li");
  li.className = `syscheck__item syscheck__item--${item.status}`;

  const head = document.createElement("div");
  head.className = "syscheck__head";

  const mark = document.createElement("span");
  mark.className = "syscheck__mark";
  mark.textContent = MARK[item.status];
  mark.setAttribute("aria-label", WORD[item.status]);

  const title = document.createElement("h3");
  title.className = "syscheck__title";
  title.textContent = item.title;

  const summary = document.createElement("p");
  summary.className = "syscheck__summary";
  summary.textContent = item.summary;

  head.append(mark, title, summary);
  li.append(head);

  const lines = document.createElement("ul");
  lines.className = "syscheck__lines";
  for (const line of item.lines) lines.append(renderLine(line));
  li.append(lines);

  return li;
}

function renderLine(line) {
  const li = document.createElement("li");
  li.className = "syscheck__line";

  const mark = document.createElement("span");
  mark.className = "syscheck__linemark";
  mark.textContent = MARK[line.status];
  mark.setAttribute("aria-label", WORD[line.status]);

  const text = document.createElement("span");
  text.className = "syscheck__text";
  text.textContent = line.text;

  li.append(mark, text);

  if (line.detail) {
    const open = state.details[line.detail] !== undefined;
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "linkbtn syscheck__more";
    toggle.textContent = open ? "접기" : "자세히";
    toggle.addEventListener("click", () => toggleDetail(line.detail));
    li.append(toggle);

    if (open) li.append(renderDetail(state.details[line.detail]));
  }
  return li;
}

/* ---------- 상세 ---------- */

/** 무거울 수 있어 누를 때만 받는다. 목록은 id·날짜처럼 사람을 가리키지 않는 값뿐이다. */
async function toggleDetail(key) {
  if (state.details[key] !== undefined) {
    delete state.details[key];
    render();
    return;
  }
  state.details[key] = "loading";
  render();
  try {
    const payload = await get(`/api/system-check/detail?item=${encodeURIComponent(key)}`);
    state.details[key] = payload.rows ?? [];
  } catch (error) {
    state.details[key] = error.message;
  }
  render();
}

function renderDetail(value) {
  const box = document.createElement("div");
  box.className = "syscheck__detail";

  if (value === "loading") {
    box.textContent = "불러오는 중…";
    return box;
  }
  if (typeof value === "string") {
    box.textContent = `상세를 읽지 못했습니다: ${value}`;
    return box;
  }
  if (value.length === 0) {
    box.textContent = "해당하는 줄이 없습니다.";
    return box;
  }

  const wrap = document.createElement("div");
  wrap.className = "syscheck__scroll";
  const table = document.createElement("table");
  table.className = "table";

  const columns = Object.keys(value[0]);
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const column of columns) {
    const th = document.createElement("th");
    th.className = "table__th";
    th.scope = "col";
    th.textContent = column;
    headRow.append(th);
  }
  thead.append(headRow);

  const tbody = document.createElement("tbody");
  for (const row of value) {
    const tr = document.createElement("tr");
    for (const column of columns) {
      const td = document.createElement("td");
      td.className = "table__td";
      const cell = row[column];
      // 서버가 준 값이라도 textContent 로만 넣는다
      td.textContent = cell === null || cell === undefined ? "—" : String(cell);
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(thead, tbody);
  wrap.append(table);
  box.append(wrap);

  if (value.length >= 50) {
    const more = document.createElement("p");
    more.className = "form__hint";
    more.textContent = "앞 50줄만 보여 줍니다.";
    box.append(more);
  }
  return box;
}
