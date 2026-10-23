/**
 * 변경 기록 (감사 로그) — 설정 안  ★ 관리자 전용
 *
 * 삭제·주요 수정·등록이 시각·동작·표·요약으로 쌓인다.
 * 줄을 누르면 바뀌기 전(before)과 뒤(after) 값이 펼쳐진다.
 * 실수로 지운 것을 이 값으로 손으로 되살리는 것이 이 화면의 목적이다.
 *
 * before/after 에는 민감정보가 그대로 있다. 로그인이 생기면 관리자만 열게 건다.
 *
 * 브라우저는 Supabase에 직접 접근하지 않는다. 항상 /api/... 를 거친다.
 */
import { button, get, hideState, showState, toast } from "./ui.js";

const PAGE = 15;

/** 표 이름을 사람 말로. 서버의 table_name 과 같아야 한다. */
const TABLE_LABELS = {
  children_identity: "아동",
  staff: "직원",
  journals: "일지",
  observations: "관찰",
  yearly_evaluations: "연간평가",
  resources: "자원",
  resource_records: "자원기록",
  books: "도서",
  schedules: "일정",
};

const ACTION_LABELS = { create: "등록", update: "수정", delete: "삭제" };

const state = {
  entries: [],
  nextCursor: null,
  table: "",
  action: "",
  from: "",
  to: "",
  opened: new Set(),
  loading: false,
  error: null,
};

const el = {
  view: document.getElementById("view-audit"),
  count: document.getElementById("audit-count"),
  table: document.getElementById("audit-table"),
  actionChips: document.querySelectorAll(".chip[data-aaction]"),
  from: document.getElementById("audit-from"),
  to: document.getElementById("audit-to"),
  tbody: document.getElementById("audit-tbody"),
  more: document.getElementById("audit-more"),
  state: document.getElementById("audit-state"),
};

/* ---------- 화면 전환 (app.js가 부른다) ---------- */

export function showAudit() {
  el.view.hidden = false;
  load(true);
}

export function hideAudit() {
  el.view.hidden = true;
}

/* ---------- 데이터 ---------- */

function params(cursor) {
  const p = new URLSearchParams();
  if (state.table) p.set("table", state.table);
  if (state.action) p.set("action", state.action);
  if (state.from) p.set("from", state.from);
  if (state.to) p.set("to", state.to);
  if (cursor) p.set("cursor", cursor);
  p.set("limit", String(PAGE));
  return p;
}

/** reset 이면 처음부터, 아니면 지금 목록 뒤에 이어 붙인다(더 보기). */
async function load(reset) {
  if (reset) {
    state.entries = [];
    state.nextCursor = null;
    state.opened.clear();
  }
  state.loading = true;
  state.error = null;
  render();

  // 필터를 바꾼 사이에 늦게 온 답은 버린다 — 다른 필터의 목록에 섞이면 안 된다
  const asked = params(null).toString();
  try {
    const payload = await get(`/api/audit?${params(reset ? null : state.nextCursor)}`);
    if (params(null).toString() !== asked) return;
    state.entries = reset ? payload.entries ?? [] : [...state.entries, ...(payload.entries ?? [])];
    state.nextCursor = payload.next_cursor ?? null;
  } catch (error) {
    state.error = error.message;
  } finally {
    state.loading = false;
    render();
  }
}

/* ---------- 그리기 ---------- */

function formatAt(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${
    pad(d.getMinutes())
  }`;
}

function render() {
  el.tbody.replaceChildren();
  hideState(el.state);
  el.more.hidden = true;

  if (state.loading && state.entries.length === 0) {
    el.count.textContent = "";
    showState(el.state, "불러오는 중…");
    return;
  }
  if (state.error) {
    el.count.textContent = "";
    showState(el.state, state.error, null, true);
    return;
  }

  el.count.textContent = state.entries.length === 0 ? "" : `최근 ${state.entries.length}건`;

  if (state.entries.length === 0) {
    showState(el.state, "기록이 없습니다.", "삭제·수정·등록이 일어나면 여기에 쌓입니다.");
    return;
  }

  for (const entry of state.entries) {
    el.tbody.append(renderRow(entry));
    if (state.opened.has(entry.id)) el.tbody.append(renderDetail(entry));
  }

  el.more.hidden = !state.nextCursor;
  el.more.disabled = state.loading;
  el.more.textContent = state.loading ? "불러오는 중…" : "더 보기";
}

function renderRow(entry) {
  const tr = document.createElement("tr");
  tr.className = "audit__row";
  tr.tabIndex = 0;
  tr.setAttribute("aria-expanded", String(state.opened.has(entry.id)));

  const toggle = () => {
    if (state.opened.has(entry.id)) state.opened.delete(entry.id);
    else state.opened.add(entry.id);
    render();
  };
  tr.addEventListener("click", toggle);
  tr.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggle();
    }
  });

  const at = document.createElement("td");
  at.className = "audit__at";
  at.textContent = formatAt(entry.at);

  const action = document.createElement("td");
  const tag = document.createElement("span");
  tag.className = entry.action === "delete"
    ? "tag tag--gone"
    : entry.action === "create"
    ? "tag tag--area"
    : "tag";
  tag.textContent = ACTION_LABELS[entry.action] ?? entry.action;
  action.append(tag);

  const table = document.createElement("td");
  table.textContent = TABLE_LABELS[entry.table_name] ?? entry.table_name;

  const summary = document.createElement("td");
  summary.className = "audit__summary";
  // 요약에는 이름이 들어간다. 사용자 입력이므로 textContent로만 넣는다.
  summary.textContent = entry.summary;

  const actor = document.createElement("td");
  actor.className = "audit__actor";
  // 로그인이 붙기 전에 쌓인 줄은 누가 했는지 모른다. 빈칸 대신 그 사실을 적는다.
  actor.textContent = entry.actor ?? "(기록 전)";

  tr.append(at, action, table, summary, actor);
  return tr;
}

/** 펼친 줄. before / after 를 그대로 보여준다. 되살릴 때 베껴 쓰는 값이다. */
function renderDetail(entry) {
  const tr = document.createElement("tr");
  tr.className = "audit__detail";

  const td = document.createElement("td");
  td.colSpan = 5;

  const wrap = document.createElement("div");
  wrap.className = "audit__panes";

  const paneFor = (label, value) => {
    const pane = document.createElement("div");
    pane.className = "audit__pane";
    const h = document.createElement("p");
    h.className = "audit__pane-title";
    h.textContent = label;
    const pre = document.createElement("pre");
    pre.className = "audit__json";
    pre.textContent = value === null || value === undefined
      ? "(없음)"
      : JSON.stringify(value, null, 2);
    pane.append(h, pre);
    return pane;
  };

  if (entry.before !== null && entry.before !== undefined) {
    wrap.append(paneFor("변경 전 (before)", entry.before));
  }
  if (entry.after !== null && entry.after !== undefined) {
    wrap.append(paneFor("변경 후 (after)", entry.after));
  }
  if (wrap.children.length === 0) wrap.append(paneFor("값", null));

  const meta = document.createElement("p");
  meta.className = "audit__meta";
  meta.textContent = `${entry.table_name} · ${entry.record_id ?? "(id 없음)"} · ${entry.at}`;

  const copy = button("JSON 복사", "linkbtn", async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(
        { before: entry.before ?? null, after: entry.after ?? null },
        null,
        2,
      ));
      toast("복사했습니다");
    } catch {
      toast("복사하지 못했습니다. 직접 드래그해서 복사해 주세요.", true);
    }
  });

  td.append(wrap, meta, copy);
  tr.append(td);
  return tr;
}

/* ---------- 이벤트 ---------- */

function syncActionChips() {
  for (const chip of el.actionChips) {
    chip.classList.toggle("is-selected", chip.dataset.aaction === state.action);
  }
}

el.table.addEventListener("change", () => {
  state.table = el.table.value;
  load(true);
});

for (const chip of el.actionChips) {
  chip.addEventListener("click", () => {
    state.action = chip.dataset.aaction;
    syncActionChips();
    load(true);
  });
}

el.from.addEventListener("change", () => {
  state.from = el.from.value;
  load(true);
});
el.to.addEventListener("change", () => {
  state.to = el.to.value;
  load(true);
});

el.more.addEventListener("click", () => load(false));

// 표 고르기 목록을 채운다. 값은 서버의 table_name, 글은 사람 말.
for (const [value, label] of Object.entries(TABLE_LABELS)) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  el.table.append(option);
}
syncActionChips();
