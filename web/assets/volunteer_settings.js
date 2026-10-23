/**
 * 봉사자 설정 — 폰 화면이 어떻게 보일지 정하는 자리
 *
 *   봉사일지 공유 범위   봉사자끼리 서로의 일지를 읽을 수 있는가
 *   반기 관찰 열림·닫힘  어느 반기에 쓸 수 있는가
 *   반기 관찰 항목       무엇을 몇 점으로 보나 (관리자만)
 *
 * 이 화면은 센터장 이상 — 읽기·바꾸기 모두(정책표). 종사자에게는 서브탭이 안 보인다.
 * 항목은 평가지표라 한 단계 더 높다 — 관리자만 고친다.
 * 그 아래 등급에게는 지금 값만 보이고 눌러도 서버가 거절한다 —
 * 화면에서도 안내하지만, 막는 것은 서버다.
 *
 * 브라우저는 Supabase에 직접 접근하지 않는다. 항상 /api/... 를 거친다.
 */
import { confirmDialog, get, hideState, send, showState, toast } from "./ui.js";
import { HALF_OBSERVATION } from "./features.js";

/** 영역. 서버(lib/half_items.ts)의 목록과 같아야 한다. */
const AREAS = ["생활", "교육", "정서"];

const state = {
  scope: null,
  choices: [],
  /** { "2026-1": true, ... } — 설정에 적힌 것만 들어 있다 */
  open: {},
  /** 화면에 늘어놓을 반기들 */
  halves: [],
  /** 반기 관찰 항목 (지운 것까지) */
  items: [],
  /** 고치는 중인 사본. null 이면 보기 모드 */
  draft: null,
  /** 항목을 고칠 수 있는 사람인가 (관리자). 막는 것은 서버다. */
  canEditItems: false,
  /** 공유 범위·반기 열림은 센터장 이상 */
  canEditScope: true,
  saving: false,
  loading: false,
  error: null,
};

const el = {
  view: document.getElementById("view-volunteer"),
  scope: document.getElementById("vol-scope"),
  halves: document.getElementById("vol-halves"),
  items: document.getElementById("vol-items"),
  itemsActions: document.getElementById("vol-items-actions"),
  state: document.getElementById("vol-state"),
};

export function showVolunteerSettings() {
  el.view.hidden = false;
  load();
}

export function hideVolunteerSettings() {
  el.view.hidden = true;
}

/* ---------- 반기 ---------- */

/** 오늘이 몇 년 몇 반기인지. 1~6월이 상반기다(서버 lib/half.ts 와 같은 기준). */
function currentHalf() {
  const now = new Date();
  return { year: now.getFullYear(), half: now.getMonth() + 1 <= 6 ? 1 : 2 };
}

function halfText(year, half) {
  return `${year}년 ${half === 1 ? "상" : "하"}반기`;
}

/**
 * 늘어놓을 반기. 올해 상·하반기 둘.
 *
 * 폰 화면에 보이는 것과 같은 둘이다. 지난해 것을 여기 두면 열어도 폰에서 안 보인다 —
 * 봉사자 쪽이 올해만 읽기 때문이다. 해가 바뀌면 지난해 반기는 저절로 닫힌다
 * ("적혀 있지 않으면 이번 반기만 열림").
 */
function listHalves() {
  const now = currentHalf();
  return [{ year: now.year, half: 2 }, { year: now.year, half: 1 }];
}

/** 이 반기가 열려 있는가. 적혀 있지 않으면 "이번 반기면 열림" (서버와 같은 규칙). */
function isOpen(year, half) {
  const saved = state.open[`${year}-${half}`];
  if (typeof saved === "boolean") return saved;
  const now = currentHalf();
  return year === now.year && half === now.half;
}

/* ---------- 데이터 ---------- */

async function load() {
  state.loading = true;
  state.error = null;
  render();

  try {
    // 반기별 관찰을 숨긴 동안은 그 두 설정을 부르지 않는다(서버도 404 — features.js)
    const [scope, open, items, me] = await Promise.all([
      get("/api/settings/volunteer_journal_scope"),
      HALF_OBSERVATION ? get("/api/settings/half_observation_open") : { value: {} },
      HALF_OBSERVATION ? get("/api/settings/half_observation_items") : { value: [] },
      get("/api/auth/me").catch(() => ({ user: null })),
    ]);
    state.scope = scope.value;
    state.choices = scope.choices ?? [];
    state.open = open.value ?? {};
    state.halves = listHalves();
    state.items = Array.isArray(items.value) ? items.value : [];
    state.canEditItems = me.user?.level === "관리자";
    // 공유 범위는 센터장 이상이 바꾼다(서버 정책표). 종사자에게는 보기만(칩 잠금)
    state.canEditScope = !me.user || ["센터장", "관리자"].includes(me.user.level);
    state.draft = null;
  } catch (error) {
    state.error = error.message;
  } finally {
    state.loading = false;
    render();
  }
}

/* ---------- 그리기 ---------- */

function render() {
  hideState(el.state);
  el.scope.replaceChildren();
  el.halves.replaceChildren();

  if (state.loading) {
    showState(el.state, "불러오는 중…");
    return;
  }
  if (state.error) {
    showState(el.state, "설정을 불러오지 못했습니다.", state.error, true);
    return;
  }

  renderScope();
  document.getElementById("vol-half-card").hidden = !HALF_OBSERVATION;
  document.getElementById("vol-items-card").hidden = !HALF_OBSERVATION;
  if (!HALF_OBSERVATION) return;
  renderHalves();
  renderItems();
}

function renderScope() {
  for (const value of state.choices) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = value === state.scope ? "chip is-selected" : "chip";
    chip.textContent = value === "전체" ? "전체 공유" : "본인 것만";
    chip.addEventListener("click", () => setScope(value));
    if (!state.canEditScope) {
      chip.disabled = true;
      chip.title = "센터장 이상이 바꿀 수 있어요";
    }
    el.scope.append(chip);
  }
  if (!state.canEditScope) {
    const lock = document.createElement("span");
    lock.className = "warn__why";
    lock.textContent = "센터장 이상이 바꿀 수 있어요.";
    el.scope.append(lock);
  }

  const why = document.createElement("span");
  why.className = "warn__why";
  why.textContent = state.scope === "본인"
    ? "봉사자는 자기가 쓴 일지만 봅니다."
    : "봉사자끼리 서로의 일지를 읽을 수 있습니다.";
  el.scope.append(why);
}

function renderHalves() {
  for (const one of state.halves) {
    const open = isOpen(one.year, one.half);

    const li = document.createElement("li");
    li.className = "warn";

    const head = document.createElement("div");
    head.className = "warn__head";

    const label = document.createElement("strong");
    label.textContent = halfText(one.year, one.half);

    const mark = document.createElement("span");
    mark.className = "warn__why";
    mark.textContent = open ? "열림 · 작성·수정 가능" : "닫힘 · 읽기만";

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = open ? "btn btn--small" : "btn btn--small btn--primary";
    toggle.textContent = open ? "닫기" : "열기";
    toggle.addEventListener("click", () => setOpen(one, !open, toggle));
    // 반기 열림·닫힘도 센터장 이상(숨김 기능 — 되살릴 때를 위해 같이 잠근다)
    toggle.disabled = !state.canEditScope;

    head.append(label, mark, toggle);
    li.append(head);
    el.halves.append(li);
  }
}

/* ---------- 바꾸기 ---------- */

async function setScope(value) {
  if (value === state.scope) return;

  const before = state.scope;
  // 낙관적 갱신 — 누르는 즉시 바뀐 것으로 그리고, 실패하면 되돌린다.
  state.scope = value;
  render();

  try {
    await send("/api/settings/volunteer_journal_scope", "PUT", { value });
    toast("바꿨습니다");
  } catch (error) {
    state.scope = before;
    render();
    toast(refused(error), true);
  }
}

async function setOpen(one, next, node) {
  const key = `${one.year}-${one.half}`;
  const before = { ...state.open };

  // 눌린 반기만 값이 적힌다. 나머지는 적히지 않은 채로 두어
  // "이번 반기면 열림" 규칙이 계속 살아 있게 한다.
  state.open = { ...state.open, [key]: next };
  node.disabled = true;
  render();

  try {
    await send("/api/settings/half_observation_open", "PUT", { value: state.open });
    toast(next ? `${halfText(one.year, one.half)}를 열었습니다` : "닫았습니다");
  } catch (error) {
    state.open = before;
    render();
    toast(refused(error), true);
  }
}

function refused(error) {
  return error.forbidden ? "이 설정은 센터장 이상만 바꿀 수 있습니다." : error.message;
}

/* ---------- 반기 관찰 항목 ---------- */

function renderItems() {
  el.items.replaceChildren();
  el.itemsActions.replaceChildren();

  if (state.draft) {
    renderItemEditor();
    return;
  }

  if (state.canEditItems) {
    const start = document.createElement("button");
    start.type = "button";
    start.className = "btn";
    start.textContent = "항목 편집";
    start.addEventListener("click", () => {
      // 사본을 고친다. [취소] 를 누르면 사본만 버리면 된다.
      state.draft = state.items.map((one) => ({ ...one }));
      renderItems();
    });
    el.itemsActions.append(start);
  } else {
    const why = document.createElement("span");
    why.className = "warn__why";
    why.textContent = "항목 수정은 관리자만 할 수 있습니다.";
    el.itemsActions.append(why);
  }

  if (state.items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "form__hint";
    empty.textContent = "항목이 없습니다. 봉사자 화면은 특이사항 칸만 보여 줍니다.";
    el.items.append(empty);
    return;
  }

  for (const area of AREAS) {
    const list = state.items.filter((one) => one.area === area && !one.deleted);
    if (list.length) el.items.append(groupHead(area), viewList(list));
  }
  const gone = state.items.filter((one) => one.deleted);
  if (gone.length) el.items.append(groupHead("삭제된 항목"), viewList(gone));
}

function groupHead(label) {
  const head = document.createElement("p");
  head.className = "items__group";
  head.textContent = label;
  return head;
}

function viewList(list) {
  const ul = document.createElement("ul");
  ul.className = "items__list";
  for (const one of list) {
    const li = document.createElement("li");
    li.className = one.deleted ? "items__view items__view--deleted" : "items__view";
    const code = document.createElement("span");
    code.className = "items__code";
    code.textContent = one.code;
    const text = document.createElement("span");
    text.textContent = one.text;
    li.append(code, text);
    ul.append(li);
  }
  return ul;
}

/** 새 항목에 붙일 코드. 지운 것까지 세어 그 다음 번호 — 서버 nextCode 와 같은 규칙. */
function nextCode(items) {
  let top = 0;
  for (const one of items) {
    const n = Number(String(one.code).slice(1));
    if (Number.isFinite(n) && n > top) top = n;
  }
  return `h${String(top + 1).padStart(2, "0")}`;
}

function areaSelect(value, onChange) {
  const select = document.createElement("select");
  select.className = "input";
  for (const area of AREAS) {
    const option = document.createElement("option");
    option.value = area;
    option.textContent = area;
    select.append(option);
  }
  select.value = value;
  select.addEventListener("change", () => onChange(select.value));
  return select;
}

function renderItemEditor() {
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn";
  cancel.textContent = "취소";
  cancel.disabled = state.saving;
  cancel.addEventListener("click", () => {
    state.draft = null;
    renderItems();
  });

  const save = document.createElement("button");
  save.type = "button";
  save.className = "btn btn--primary";
  save.textContent = state.saving ? "저장 중…" : "저장";
  save.disabled = state.saving;
  save.addEventListener("click", saveItems);

  el.itemsActions.append(cancel, save);

  const ul = document.createElement("ul");
  ul.className = "items__list";

  for (const one of state.draft) {
    const li = document.createElement("li");
    li.className = one.deleted ? "items__row items__row--deleted" : "items__row";

    const code = document.createElement("span");
    code.className = "items__code";
    code.textContent = one.code;

    const area = areaSelect(one.area, (value) => {
      one.area = value;
    });
    area.disabled = Boolean(one.deleted);

    const text = document.createElement("input");
    text.type = "text";
    text.className = "input items__text";
    text.value = one.text;
    text.maxLength = 200;
    text.disabled = Boolean(one.deleted);
    text.setAttribute("aria-label", `${one.code} 문구`);
    text.addEventListener("input", () => {
      one.text = text.value;
    });

    // 지워도 목록에서 빼지 않는다 — 지난 점수가 이 코드를 물고 있다. 되살릴 수도 있다.
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = one.deleted ? "linkbtn" : "linkbtn linkbtn--danger";
    toggle.textContent = one.deleted ? "되살리기" : "삭제";
    toggle.addEventListener("click", () => {
      one.deleted = !one.deleted;
      if (!one.deleted) delete one.deleted;
      renderItems();
    });

    li.append(code, area, text, toggle);
    ul.append(li);
  }
  el.items.append(ul);

  // 새 항목 한 줄
  const add = document.createElement("div");
  add.className = "items__add";
  let newArea = AREAS[0];
  const area = areaSelect(newArea, (value) => {
    newArea = value;
  });
  const text = document.createElement("input");
  text.type = "text";
  text.className = "input";
  text.maxLength = 200;
  text.placeholder = "새 항목 문구";
  const push = document.createElement("button");
  push.type = "button";
  push.className = "btn";
  push.textContent = "+ 추가";
  push.addEventListener("click", () => {
    if (!text.value.trim()) {
      toast("새 항목 문구를 적어 주세요.", true);
      text.focus();
      return;
    }
    state.draft.push({ code: nextCode(state.draft), area: newArea, text: text.value.trim(), max: 5 });
    renderItems();
  });
  add.append(area, text, push);
  el.items.append(add);
}

/** 무엇이 바뀌는지 센다. 확인창에 적는다. */
function diffItems(before, after) {
  const old = new Map(before.map((one) => [one.code, one]));
  let changed = 0;
  let added = 0;
  let removed = 0;
  let restored = 0;
  for (const one of after) {
    const was = old.get(one.code);
    if (!was) {
      added++;
      continue;
    }
    if (!was.deleted && one.deleted) removed++;
    else if (was.deleted && !one.deleted) restored++;
    else if (was.text !== one.text || was.area !== one.area) changed++;
  }
  return { changed, added, removed, restored };
}

async function saveItems() {
  const draft = state.draft.map((one) => ({ ...one, text: one.text.trim() }));
  const empty = draft.find((one) => !one.text);
  if (empty) {
    toast(`${empty.code} 문구가 비었습니다.`, true);
    return;
  }

  const diff = diffItems(state.items, draft);
  if (!diff.changed && !diff.added && !diff.removed && !diff.restored) {
    state.draft = null;
    renderItems();
    return;
  }

  const parts = [];
  if (diff.changed) parts.push(`문구·영역 수정 ${diff.changed}개`);
  if (diff.added) parts.push(`추가 ${diff.added}개`);
  if (diff.removed) parts.push(`삭제 ${diff.removed}개`);
  if (diff.restored) parts.push(`되살리기 ${diff.restored}개`);

  const yes = await confirmDialog({
    title: "반기 관찰 항목을 바꿀까요?",
    message: `${parts.join(" · ")}\n` +
      "고친 문구는 지난 기록에도 새 문구로 보입니다. 지운 항목의 지난 점수는 남고 '삭제된 항목' 으로 보입니다.",
    confirmText: "저장",
    danger: false,
  });
  if (!yes) return;

  state.saving = true;
  renderItems();
  try {
    const payload = await send("/api/settings/half_observation_items", "PUT", { value: draft });
    state.items = payload.value ?? draft;
    state.draft = null;
    toast("항목을 저장했습니다");
  } catch (error) {
    // 고치던 것은 그대로 둔다. 다시 고쳐 낼 수 있어야 한다.
    toast(error.forbidden ? "항목은 관리자만 고칠 수 있습니다." : error.message, true);
  } finally {
    state.saving = false;
    renderItems();
  }
}
