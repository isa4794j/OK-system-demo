/**
 * 자원통계 — 통계에 잡힌 기록을 카테고리별·자원별로 본다
 *
 * 화면 하나에 세 덩이가 있다.
 *   카테고리별  막대. 누르면 그 안의 자원 내역이 펼쳐진다.
 *   자원별      많이 쓴 순 + 지난 기간 대비 증감, 최근 사용일
 *   오래 안 쓴 자원  사전에 있는데 오래 안 나온 자원(10개씩)
 * 카테고리별은 펼친 채, 나머지 둘은 ▸ 접힘으로 시작. 자원별·오래 안 쓴 자원은 10개씩 [더 보기]. 순서는 카테고리별 → 자원별 → 오래 안 쓴 자원.
 *
 * [무엇이 들어가나]
 * 뽑힌 자원은 바로 들어간다. '자원 아님'만 빠지고, 카테고리를 못 정한 것은
 * "카테고리 미정"으로 들어간다. 그 조건은 서버(/db)가 지킨다.
 * 화면은 서버가 준 숫자를 그리기만 한다.
 *
 * 브라우저는 Supabase에 직접 접근하지 않는다. 항상 /api/... 를 거친다.
 */
import { get, hideState, pad, showState, toast } from "./ui.js";

/** 며칠 안 나오면 방치 후보로 볼지. 서버의 기본값과 같다. */
const IDLE_CUTOFF = 60;

const state = {
  /** 월 | 반기 | 연간 */
  mode: "월",
  /** 기준 날짜. 이 날이 든 달·반기·해를 본다. */
  anchor: new Date(),

  categories: [],
  resources: [],
  idle: [],

  /** 펼쳐 둔 카테고리 */
  opened: new Set(),
  /** 접어 둔 섹션 — 카테고리별은 펼친 채 시작(들어오자마자 숫자가 보이게), 나머지는 머리의 건수만 */
  folded: new Set(["resources", "idle"]),
  /** 자원별 — 몇 줄까지 보이나(10개씩 [더 보기], 많이 쓴 순 그대로) */
  resourcesShown: 10,
  /** 오래 안 쓴 자원 — 몇 개까지 보이나(10개씩 [더 보기]) */
  idleShown: 10,
  loading: false,
  error: null,
};

const el = {
  view: document.getElementById("view-resource-stats"),
  modeChips: document.querySelectorAll(".chip[data-rmode]"),
  prev: document.getElementById("rstat-prev"),
  next: document.getElementById("rstat-next"),
  label: document.getElementById("rstat-label"),
  count: document.getElementById("rstat-count"),

  categories: document.getElementById("rstat-categories"),
  resources: document.getElementById("rstat-resources"),
  idle: document.getElementById("rstat-idle"),
  state: document.getElementById("rstat-state"),
};

/* ---------- 기간 계산 ---------- */

function iso(date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/**
 * 기준 날짜가 든 기간의 시작·끝과 이름.
 *
 * 지난 기간도 함께 낸다. "지난 달"과 "지난 반기"는 길이가 다르므로
 * 날짜 수로 빼지 않고 달력으로 한 칸 뒤로 옮긴다.
 */
function periodOf(mode, anchor, shift = 0) {
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth(); // 0-11

  if (mode === "월") {
    const start = new Date(Date.UTC(year, month + shift, 1));
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
    return {
      from: iso(start),
      to: iso(end),
      label: `${start.getUTCFullYear()}년 ${start.getUTCMonth() + 1}월`,
      anchor: start,
    };
  }

  if (mode === "반기") {
    // 반기 번호를 통째로 옮긴다. 0=상반기, 1=하반기
    const half = month < 6 ? 0 : 1;
    const moved = year * 2 + half + shift;
    const y = Math.floor(moved / 2);
    const h = moved % 2;
    const start = new Date(Date.UTC(y, h * 6, 1));
    const end = new Date(Date.UTC(y, h * 6 + 6, 0));
    return {
      from: iso(start),
      to: iso(end),
      label: `${y}년 ${h === 0 ? "상반기" : "하반기"}`,
      anchor: start,
    };
  }

  const y = year + shift;
  return {
    from: `${y}-01-01`,
    to: `${y}-12-31`,
    label: `${y}년`,
    anchor: new Date(Date.UTC(y, 0, 1)),
  };
}

/* ---------- 화면 전환 (app.js가 부른다) ---------- */

export function showResourceStats() {
  el.view.hidden = false;
  syncModeChips();
  load();
}

export function hideResourceStats() {
  el.view.hidden = true;
}

/* ---------- 데이터 ---------- */

async function load() {
  state.idleShown = 10;
  state.resourcesShown = 10;
  state.loading = true;
  state.error = null;
  render();

  const now = periodOf(state.mode, state.anchor);
  const before = periodOf(state.mode, state.anchor, -1);

  const categoryParams = new URLSearchParams({ view: "category", from: now.from, to: now.to });
  const resourceParams = new URLSearchParams({
    view: "resource",
    from: now.from,
    to: now.to,
    prev_from: before.from,
    prev_to: before.to,
  });

  try {
    // 셋 다 집계라 서로 기다릴 이유가 없다. AI를 안 쓰므로 빠르다.
    const [byCategory, byResource, idle] = await Promise.all([
      get(`/api/resource-stats?${categoryParams}`),
      get(`/api/resource-stats?${resourceParams}`),
      get(`/api/resource-stats?view=idle&cutoff=${IDLE_CUTOFF}`),
    ]);
    state.categories = byCategory.categories ?? [];
    state.resources = byResource.resources ?? [];
    state.idle = idle.resources ?? [];
  } catch (error) {
    state.error = error.message;
    state.categories = [];
    state.resources = [];
    state.idle = [];
  } finally {
    state.loading = false;
    render();
  }
}

/* ---------- 그리기 ---------- */

function render() {
  el.categories.replaceChildren();
  el.resources.replaceChildren();
  el.idle.replaceChildren();
  el.idle.hidden = true;
  hideState(el.state);
  syncModeChips();

  el.label.textContent = periodOf(state.mode, state.anchor).label;

  if (state.loading) {
    el.count.textContent = "";
    showState(el.state, "불러오는 중…");
    return;
  }
  if (state.error) {
    el.count.textContent = "";
    showState(el.state, state.error, null, true);
    return;
  }

  const total = state.categories.reduce((sum, item) => sum + item.count, 0);
  el.count.textContent = total === 0 ? "" : `활용 ${total}회 · 자원 ${state.resources.length}종`;

  if (total === 0) {
    showState(
      el.state,
      "이 기간에 뽑힌 자원 기록이 없습니다.",
      "일지를 [분석하기]로 돌리면 뽑힌 자원이 바로 여기 들어옵니다.",
    );
  } else {
    renderCategories(total);
    renderResources();
  }
  renderIdle();
}

/**
 * 접는 섹션 카드 — 머리(▸ 제목 · 건수)를 누르면 펼치고 접는다. 접혀 있으면 body 는 null.
 */
function foldSection(key, titleText, countText) {
  const section = document.createElement("section");
  section.className = "card card--pad rstat__section";
  const open = !state.folded.has(key);

  const head = document.createElement("button");
  head.type = "button";
  head.className = "resgroup__head rstat__head";
  head.setAttribute("aria-expanded", String(open));
  head.addEventListener("click", () => {
    if (state.folded.has(key)) state.folded.delete(key);
    else state.folded.add(key);
    render();
  });

  const mark = document.createElement("span");
  mark.className = "resgroup__mark";
  mark.setAttribute("aria-hidden", "true");
  mark.textContent = open ? "▾" : "▸";

  const title = document.createElement("span");
  title.className = "card__title rstat__title";
  title.textContent = titleText;

  const count = document.createElement("span");
  count.className = "resgroup__count";
  count.textContent = countText;

  head.append(mark, title, count);
  section.append(head);
  return { section, open };
}

/** 지난 기간 열의 이름 — 월이면 지난달, 반기면 지난 반기, 연간이면 작년 */
function prevLabel() {
  return state.mode === "반기" ? "지난 반기" : state.mode === "연간" ? "작년" : "지난달";
}

function renderCategories(total) {
  const { section, open } = foldSection("categories", "카테고리별", `${state.categories.length}개`);
  el.categories.append(section);
  if (!open) return;

  const hint = document.createElement("p");
  hint.className = "form__hint";
  hint.textContent = "막대를 누르면 그 안의 자원 내역이 펼쳐집니다.";
  section.append(hint);

  const list = document.createElement("ul");
  list.className = "bars";

  // 가장 큰 것을 기준으로 폭을 잡는다. 전체 대비로 하면 종류가 많을 때 다 납작해진다.
  const max = Math.max(...state.categories.map((item) => item.count), 1);

  for (const item of state.categories) {
    list.append(renderBar(item, max, total));
  }
  section.append(list);
}

function renderBar(item, max, total) {
  const li = document.createElement("li");
  li.className = "bars__item";

  const open = state.opened.has(item.category);

  const row = document.createElement("button");
  row.type = "button";
  row.className = "bars__row";
  row.setAttribute("aria-expanded", String(open));
  row.addEventListener("click", () => {
    if (open) state.opened.delete(item.category);
    else state.opened.add(item.category);
    render();
  });

  const name = document.createElement("span");
  name.className = "bars__name";
  // 카테고리 이름은 사용자가 정한 값이므로 textContent로만 넣는다
  name.textContent = item.category;

  const track = document.createElement("span");
  track.className = "bars__track";

  const fill = document.createElement("span");
  fill.className = "bars__fill";
  fill.style.width = `${Math.round((item.count / max) * 100)}%`;
  track.append(fill);

  const value = document.createElement("span");
  value.className = "bars__value";
  value.textContent = `${item.count}회 (${Math.round((item.count / total) * 100)}%)`;

  row.append(name, track, value);
  li.append(row);

  if (!open) return li;

  const inner = document.createElement("ul");
  inner.className = "bars__inner";
  for (const resource of item.resources) {
    const entry = document.createElement("li");
    entry.className = "bars__entry";

    const label = document.createElement("span");
    label.textContent = resource.name;

    const count = document.createElement("span");
    count.className = "bars__value";
    count.textContent = `${resource.count}회`;

    entry.append(label, count);
    inner.append(entry);
  }
  li.append(inner);
  return li;
}

function renderResources() {
  const { section, open } = foldSection("resources", "자원별", `${state.resources.length}종`);
  el.resources.append(section);
  if (!open) return;

  const hint = document.createElement("p");
  hint.className = "form__hint";
  hint.textContent = `많이 쓴 순입니다. 화살표는 ${prevLabel()}과 견준 것입니다.`;
  section.append(hint);

  const rows = state.resources.slice(0, state.resourcesShown).map(renderResourceRow);
  section.append(statTable(["자원", "카테고리", "횟수", prevLabel(), "최근 사용"], rows));

  const left = state.resources.length - state.resourcesShown;
  if (left > 0) {
    section.append(moreButton(left, () => {
      state.resourcesShown += 10;
    }));
  }
}

/**
 * 자원별·오래 안 쓴 자원이 같이 쓰는 표 — 열 자리가 고정되고 칸 글자는 꺾지 않는다.
 * 좁은 화면에서는 표만 옆으로 민다(화면 전체가 옆으로 밀리면 안 된다).
 */
function statTable(headers, rows) {
  const table = document.createElement("table");
  table.className = "table rstat__table";
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const text of headers) {
    const th = document.createElement("th");
    th.scope = "col";
    th.className = "table__th";
    th.textContent = text;
    headRow.append(th);
  }
  head.append(headRow);
  const body = document.createElement("tbody");
  body.append(...rows);
  table.append(head, body);

  const wrap = document.createElement("div");
  wrap.className = "table-scroll";
  wrap.append(table);
  return wrap;
}

/** 10개씩 [더 보기] — 자원별·오래 안 쓴 자원이 같이 쓴다 */
function moreButton(left, grow) {
  const more = document.createElement("button");
  more.type = "button";
  more.className = "btn idle__more";
  more.textContent = `더 보기 (${left}건 남음)`;
  more.addEventListener("click", () => {
    grow();
    render();
  });
  return more;
}

function renderResourceRow(item) {
  const tr = document.createElement("tr");

  const name = document.createElement("td");
  name.className = "rstat__name";
  // 자원명은 사용자·AI가 넣은 값이므로 textContent로만 넣는다
  name.textContent = item.name;

  const category = document.createElement("td");
  category.textContent = item.category;

  const count = document.createElement("td");
  count.textContent = `${item.count}회`;

  const delta = document.createElement("td");
  delta.append(renderDelta(item));

  const last = document.createElement("td");
  last.textContent = item.last_used;

  tr.append(name, category, count, delta, last);
  return tr;
}

/** 지난 기간과의 차이. 견줄 기간이 없거나 그대로면 조용히 둔다. */
function renderDelta(item) {
  const span = document.createElement("span");

  if (item.delta === null) {
    span.className = "rstat__delta";
    span.textContent = "-";
    return span;
  }
  if (item.delta === 0) {
    span.className = "rstat__delta";
    span.textContent = `${item.prev_count}회 → 그대로`;
    return span;
  }

  const up = item.delta > 0;
  span.className = up ? "rstat__delta rstat__delta--up" : "rstat__delta rstat__delta--down";
  span.textContent = `${item.prev_count}회 ${up ? "↑" : "↓"}${Math.abs(item.delta)}`;
  return span;
}

/**
 * 오래 안 쓴 자원(예전 "확인해볼 자원").
 *
 * 판단하지 않는다. 계절을 타는 것도 있고(물놀이), 일부러 안 꺼내는 것도 있다.
 * 그래서 "안 쓰고 있습니다"가 아니라 "오래 안 보입니다"라고 적는다.
 * 기본 접힘, 펼쳐도 10개씩 [더 보기].
 */
function renderIdle() {
  if (state.idle.length === 0) return;

  const { section, open } = foldSection("idle", "오래 안 쓴 자원", `${state.idle.length}건`);
  el.idle.replaceChildren(section);
  el.idle.hidden = false;
  if (!open) return;

  const hint = document.createElement("p");
  hint.className = "form__hint";
  hint.textContent =
    `${IDLE_CUTOFF}일 넘게 기록에 안 나온 자원입니다 — 계절·보관 사정이 있을 수 있어 판단은 선생님 몫입니다.`;

  // 자원별 표와 같은 모양 — "기록에 나온 적 없음" 도 날짜 열 자리에
  const rows = state.idle.slice(0, state.idleShown).map((item) => {
    const tr = document.createElement("tr");
    const name = document.createElement("td");
    name.className = "rstat__name";
    name.textContent = item.name;
    const category = document.createElement("td");
    category.textContent = item.category ?? "카테고리 미정";
    const last = document.createElement("td");
    last.textContent = item.last_used === null ? "기록에 나온 적 없음" : item.last_used;
    const days = document.createElement("td");
    days.textContent = item.last_used === null ? "-" : `${item.days_since}일 전`;
    tr.append(name, category, last, days);
    return tr;
  });
  section.append(hint, statTable(["자원", "카테고리", "마지막 기록", "지난 날"], rows));

  const left = state.idle.length - state.idleShown;
  if (left > 0) {
    section.append(moreButton(left, () => {
      state.idleShown += 10;
    }));
  }
}

/* ---------- 이벤트 ---------- */

function syncModeChips() {
  for (const chip of el.modeChips) {
    const on = chip.dataset.rmode === state.mode;
    chip.classList.toggle("is-selected", on);
    chip.setAttribute("aria-pressed", String(on));
  }
}

// [반기]/[연간] — 기본은 월. 고른 것을 다시 누르면 월로 돌아간다
for (const chip of el.modeChips) {
  chip.addEventListener("click", () => {
    state.mode = state.mode === chip.dataset.rmode ? "월" : chip.dataset.rmode;
    state.opened.clear();
    syncModeChips();
    load();
  });
}

function shift(delta) {
  const moved = periodOf(state.mode, state.anchor, delta);
  state.anchor = moved.anchor;
  state.opened.clear();
  load();
}

el.prev.addEventListener("click", () => shift(-1));
el.next.addEventListener("click", () => {
  // 앞으로 가는 것을 막지는 않는다. 미리 등록해 둔 기록을 볼 일이 있다.
  // 다만 아무것도 없는 기간이면 화면이 비어 보이므로 한 번 알린다.
  const next = periodOf(state.mode, state.anchor, 1);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
  if (next.from > today) toast("아직 오지 않은 기간입니다.");
  shift(1);
});
