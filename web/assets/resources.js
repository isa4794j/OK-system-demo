/**
 * 자원사전 — 센터가 가진 것들의 목록
 *
 * 화면이 둘이다. 서로 자리를 바꾼다.
 *   목록        — 카테고리별로 접히는 묶음 + 등록·수정 폼
 *   카테고리 관리 — 카테고리 추가·이름변경·순서·삭제
 *
 * 자원이 늘어날 것을 보고 처음부터 접어 둔다.
 * 백 개가 한 화면에 펼쳐지면 찾는 것이 아니라 훑는 화면이 된다.
 *
 * 브라우저는 Supabase에 직접 접근하지 않는다. 항상 /api/... 를 거친다.
 */
import {
  base64Bytes,
  button,
  confirmDialog,
  explain,
  fillOptions,
  get,
  hideState,
  mountPhotoSource,
  focusOnWide,
  PHOTO_MAX_BYTES,
  PHOTO_NOTICE,
  prepareImage,
  remove,
  send,
  showState,
  toast,
  toOption,
} from "./ui.js";
import { showInbox } from "./resource_inbox.js";

/** 목록에 없는 카테고리의 자원을 모아 두는 묶음 이름 */
const OTHERS_LABEL = "카테고리 없음";

const state = {
  resources: [],
  categories: [],
  query: "",
  loading: false,
  error: null,

  /** 펼쳐 둔 카테고리 이름. 기본은 모두 접힘. */
  opened: new Set(),

  /** 끌고 있는 별칭 { id, alias }. 자원 끌기(dragging)와 뜻이 반대라 따로 둔다. */
  draggingAlias: null,

  /** 이름을 고쳐 쓰는 중인 카테고리. 한 번에 하나만. */
  renaming: null,

  /** 끌고 있는 자원 id. 놓을 곳을 표시하는 데 쓴다. */
  dragging: null,

  /** 사진으로 등록 — 고른 사진과 인식 결과 */
  photo: {
    image: null, // { base64, mimeType }
    items: [],
    busy: false,
  },

  screen: "list", // list | categories
  formMode: null, // null | "create" | "edit"
  editing: null,
  pending: false,
};

const el = {
  view: document.getElementById("view-resources"),
  count: document.getElementById("resource-count"),
  search: document.getElementById("resource-search"),
  addOpen: document.getElementById("resource-add-open"),
  catOpen: document.getElementById("resource-categories-open"),

  form: document.getElementById("resource-form"),
  formTitle: document.getElementById("resource-form-title"),
  name: document.getElementById("resource-name"),
  category: document.getElementById("resource-category"),
  aliases: document.getElementById("resource-aliases"),
  submit: document.getElementById("resource-submit"),
  cancel: document.getElementById("resource-cancel"),

  groups: document.getElementById("resource-groups"),
  state: document.getElementById("resource-state"),

  photo: {
    title: document.getElementById("photo-title"),
    block: document.getElementById("photo-block"),
    modal: document.getElementById("photo-modal"),
    backdrop: document.getElementById("photo-backdrop"),
    notice: document.getElementById("photo-notice"),
    close: document.getElementById("photo-close"),
    pick: document.getElementById("photo-pick"),
    source: document.getElementById("photo-source"),
    preview: document.getElementById("photo-preview"),
    run: document.getElementById("photo-run"),
    state: document.getElementById("photo-state"),
    result: document.getElementById("photo-result"),
    summary: document.getElementById("photo-summary"),
    list: document.getElementById("photo-list"),
    register: document.getElementById("photo-register"),
    retry: document.getElementById("photo-retry"),
  },

  catView: document.getElementById("view-resource-categories"),
  catBack: document.getElementById("rescat-back"),
  catList: document.getElementById("rescat-list"),
  catAddForm: document.getElementById("rescat-add-form"),
  catNew: document.getElementById("rescat-new"),
};

/* ---------- 화면 전환 (app.js가 부른다) ---------- */

export function showResources() {
  goToList();
  loadResources();
  // 미분류함은 자원사전 맨 아래 섹션이다
  showInbox();
}

export function hideResources() {
  el.view.hidden = true;
  el.catView.hidden = true;
}

function goToList() {
  state.screen = "list";
  el.catView.hidden = true;
  el.view.hidden = false;
  closeForm();
}

function goToCategories() {
  state.screen = "categories";
  state.renaming = null;
  el.view.hidden = true;
  el.catView.hidden = false;
  el.catNew.value = "";
  renderCategories();
  el.catBack.focus();
}

/* ---------- 데이터 ---------- */

async function loadResources() {
  state.loading = true;
  state.error = null;
  render();

  try {
    // 자원과 카테고리를 한 번에 받는다. 따로 받으면 카테고리가 오기 전에
    // 자원이 먼저 그려져 잠깐 잘못된 묶음이 보인다.
    const payload = await get("/api/resources");
    state.resources = payload.resources ?? [];
    state.categories = payload.categories ?? [];
  } catch (error) {
    state.error = error.message;
    state.resources = [];
  } finally {
    state.loading = false;
    render();
  }
}

/* ---------- 목록 그리기 ---------- */

function visibleResources() {
  const query = state.query.trim().toLowerCase();

  // 별칭으로도 찾는다. "젠가"로 등록하고 "나무탑"으로 부르는 일이 흔하다.
  return state.resources.filter((item) => {
    if (!query) return true;
    const haystack = `${item.name ?? ""} ${item.aliases ?? ""}`.toLowerCase();
    return haystack.includes(query);
  });
}

/**
 * 카테고리별로 묶는다.
 *
 * 설정에 있는 카테고리를 그 순서대로 먼저 두고, 목록에 없는 카테고리를 뒤에 붙인다.
 * 목록에 없는 값이 들어올 수 있기 때문이다 — 카테고리를 지웠거나,
 * 나중에 일지에서 자원을 뽑을 때(자-2) 새 이름이 먼저 오는 경우다.
 * 어느 묶음에도 못 들어가 화면에서 사라지는 자원이 있으면 안 된다.
 */
function groupResources(rows) {
  const groups = new Map(state.categories.map((name) => [name, []]));

  for (const item of rows) {
    const key = item.category && item.category.trim() ? item.category : OTHERS_LABEL;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

function render() {
  el.groups.replaceChildren();
  hideState(el.state);

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

  const rows = visibleResources();
  el.count.textContent = state.resources.length === 0
    ? ""
    : `${rows.length}건 / 전체 ${state.resources.length}건`;

  if (state.resources.length === 0) {
    showState(
      el.state,
      "아직 등록된 자원이 없습니다.",
      "[+ 자원 등록] 으로 센터가 가진 것을 하나씩 추가해 보세요.",
    );
    return;
  }
  if (rows.length === 0) {
    showState(el.state, "찾는 자원이 없습니다.", "검색어를 지우거나 다르게 적어 보세요.");
    return;
  }

  // 검색 중에는 찾은 것이 어디 있는지 바로 보여야 하므로 묶음을 펼쳐 둔다
  const searching = state.query.trim().length > 0;

  for (const [name, items] of groupResources(rows)) {
    // 검색 중이면 빈 묶음은 감춘다. 평소에는 빈 카테고리도 보여야
    // 거기에 등록할 수 있다는 것을 안다.
    if (searching && items.length === 0) continue;
    el.groups.append(renderGroup(name, items, searching));
  }
}

function renderGroup(name, items, forceOpen) {
  const box = document.createElement("section");
  box.className = "resgroup";

  const open = forceOpen || state.opened.has(name);

  const head = document.createElement("button");
  head.type = "button";
  head.className = "resgroup__head";
  head.setAttribute("aria-expanded", String(open));
  head.addEventListener("click", () => {
    if (state.opened.has(name)) state.opened.delete(name);
    else state.opened.add(name);
    render();
  });

  const mark = document.createElement("span");
  mark.className = "resgroup__mark";
  mark.setAttribute("aria-hidden", "true");
  mark.textContent = open ? "▾" : "▸";

  const label = document.createElement("span");
  label.className = "resgroup__name";
  // 카테고리 이름은 사용자가 정한 값이므로 textContent로만 넣는다
  label.textContent = name;

  const count = document.createElement("span");
  count.className = "resgroup__count";
  count.textContent = `${items.length}건`;

  head.append(mark, label, count);
  box.append(head);

  if (!open) return box;

  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "resgroup__empty";
    empty.textContent = "이 카테고리에는 아직 자원이 없습니다.";
    box.append(empty);
    return box;
  }

  const list = document.createElement("ul");
  list.className = "reslist__items";
  for (const item of items) list.append(renderResource(item));
  box.append(list);

  return box;
}

function renderResource(item) {
  const li = document.createElement("li");
  li.className = "res";

  const main = document.createElement("div");
  main.className = "res__main";

  const name = document.createElement("span");
  name.className = "res__name";
  // 자원명은 사용자 입력이므로 textContent로만 넣는다
  name.textContent = item.name ?? "-";

  // AI 추측으로 들어온 것. 사람이 카테고리를 한 번이라도 만지면 이 표시가 없어진다.
  if (item.auto_added) {
    const auto = document.createElement("span");
    auto.className = "tag res__auto";
    auto.textContent = "자동 등록";
    explain(
      auto,
      "일지에서 뽑혀 AI 추측 카테고리로 올라온 자원입니다. 카테고리를 고치면 표시가 없어집니다.",
    );
    name.append(auto);
  }
  main.append(name);

  const aliases = aliasesOf(item);
  if (aliases.length > 0) {
    // 넓은 화면: 떼어낼 수 있는 조각 / 좁은 화면: 한 줄 글자(떼어내기·합치기는 PC 에서)
    const box = document.createElement("span");
    box.className = "res__aliases wide-only";
    for (const alias of aliases) box.append(renderAlias(item, alias));
    const plain = document.createElement("span");
    plain.className = "res__aliastext narrow-only";
    plain.textContent = aliases.join(", ");
    main.append(box, plain);
  }

  const actions = document.createElement("div");
  actions.className = "res__actions";

  const edit = iconButton("수정", "linkbtn", PENCIL_ICON, () => openEdit(item));
  const del = iconButton("삭제", "linkbtn linkbtn--danger", CROSS_ICON, () => askDelete(item));
  // "자원 아님"은 삭제와 다르다. 사전에서 빼는 데서 끝나지 않고 기록과 다음 추출까지 막는다.
  // 헷갈리지 않게 삭제 뒤에 떨어뜨려 둔다.
  const reject = iconButton("자원 아님", "linkbtn res__reject", BAN_ICON, () => askReject(item));
  edit.disabled = isTemp(item.id);
  del.disabled = isTemp(item.id);
  reject.disabled = isTemp(item.id);
  actions.append(edit, del, reject);

  li.append(main, actions);
  attachDrag(li, item);
  return li;
}

/*
 * 줄 동작 버튼 — 넓은 화면은 글자, 좁은 화면은 아이콘(44px). 이름은 늘 aria-label 로.
 */
const ICON_ATTRS =
  'viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
const PENCIL_ICON = `<svg ${ICON_ATTRS}><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>`;
const CROSS_ICON = `<svg ${ICON_ATTRS}><path d="M6 6l12 12M18 6L6 18"/></svg>`;
const BAN_ICON = `<svg ${ICON_ATTRS}><circle cx="12" cy="12" r="8"/><path d="M6.5 17.5l11-11"/></svg>`;

function iconButton(label, className, icon, onClick) {
  const node = button("", `${className} res__act`, onClick);
  node.setAttribute("aria-label", label);
  const text = document.createElement("span");
  text.className = "res__acttext";
  text.textContent = label;
  const pic = document.createElement("span");
  pic.className = "res__acticon";
  pic.innerHTML = icon; // 고정된 그림 글자(사용자 값 아님)
  node.append(text, pic);
  return node;
}

/** 별칭 떼어내기 아이콘 — 상자 밖으로 나가는 화살표 */
const SPLIT_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';

/** 별칭 한 줄을 낱개로. 저장은 "젠가, 나무탑" 처럼 쉼표로 이어 둔다. */
function aliasesOf(item) {
  return item.aliases ? item.aliases.split(",").map((one) => one.trim()).filter(Boolean) : [];
}

/**
 * 별칭 조각 하나.
 *
 * 끌어서 목록 빈 자리에 놓으면 떨어져 나온다 — 합치기의 정반대 동작이다.
 * 끌기가 안 되는 자리(터치 등)를 위해 [분리] 버튼도 같이 둔다.
 * 두 방법 중 하나만 두면 "합칠 땐 끌었는데 뗄 땐 왜 버튼이지"가 되어 손에 안 붙는다.
 */
function renderAlias(item, alias) {
  const chip = document.createElement("span");
  chip.className = "res__alias";

  const text = document.createElement("span");
  // 별칭은 사용자 입력이므로 textContent로만 넣는다
  text.textContent = alias;

  // 떼어내기 — 글자 대신 "밖으로 빼는 화살표" 아이콘(고정 SVG 라 innerHTML, 사용자 글은 안 섞인다)
  const off = button("", "res__split", () => askSplit(item, alias));
  off.innerHTML = SPLIT_ICON;
  off.setAttribute("aria-label", `"${alias}" 떼어내기`);
  off.title = `"${alias}" 을(를) 따로 떼어 자원으로 만듭니다`;
  off.disabled = isTemp(item.id);
  chip.append(text, off);

  if (isTemp(item.id)) return chip;

  chip.draggable = true;
  chip.title = "끌어서 목록 빈 자리에 놓으면 따로 떼어냅니다";
  chip.addEventListener("dragstart", (event) => {
    event.dataTransfer.setData("text/plain", alias);
    event.dataTransfer.effectAllowed = "move";
    state.draggingAlias = { id: item.id, alias };
    chip.classList.add("res--dragging");
    // 끌기가 시작되면 카드째 끌리지 않게 막는다
    event.stopPropagation();
  });
  chip.addEventListener("dragend", () => {
    state.draggingAlias = null;
    chip.classList.remove("res--dragging");
    el.groups.classList.remove("reslist--drop");
  });
  return chip;
}

/**
 * 목록 빈 자리에 놓으면 별칭이 떨어져 나온다.
 *
 * 자원 줄 위에 놓는 것은 "합치기"라 뜻이 정반대다. 그쪽에서는 받지 않고,
 * 여기(빈 자리)에서만 받는다. 한 번만 걸어 두면 되므로 시작할 때 건다.
 */
function attachAliasDropZone() {
  el.groups.addEventListener("dragover", (event) => {
    if (!state.draggingAlias) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    el.groups.classList.add("reslist--drop");
  });

  el.groups.addEventListener("dragleave", (event) => {
    if (event.target === el.groups) el.groups.classList.remove("reslist--drop");
  });

  el.groups.addEventListener("drop", (event) => {
    const dragging = state.draggingAlias;
    el.groups.classList.remove("reslist--drop");
    if (!dragging) return;
    event.preventDefault();

    const item = state.resources.find((one) => one.id === dragging.id);
    if (item) askSplit(item, dragging.alias);
  });
}

/**
 * 별칭을 떼어낼지 묻는다.
 *
 * 옮길 수 있는 기록이 몇 건인지는 서버만 안다(일지에 적혔던 표기를 봐야 한다).
 * 물어보기 전에 한 번 더 부르면 화면이 멈추므로, 여기서는 "함께 옮겨진다"까지만 말하고
 * 실제 건수는 끝난 뒤 알린다. 옛 기록이 남는 경우도 그때 함께 알린다.
 */
async function askSplit(item, alias) {
  if (state.pending) return;

  const yes = await confirmDialog({
    title: "별칭을 따로 떼어낼까요?",
    message: `「${alias}」을(를) 「${item.name}」에서 분리합니다.
` +
      `카테고리는 ${item.category ?? "카테고리 없음"} 을(를) 물려받고, 나중에 고칠 수 있습니다.
` +
      `그 표기로 들어온 기록이 함께 옮겨집니다.`,
    confirmText: "분리",
  });
  if (yes) await splitAlias(item, alias);
}

async function splitAlias(item, alias) {
  const saved = snapshot();

  state.pending = true;
  // 낙관적 갱신: 별칭을 먼저 떼어내 보인다. 새 자원은 서버가 준 값으로 넣는다.
  const row = state.resources.find((one) => one.id === item.id);
  if (row) {
    const rest = aliasesOf(row).filter((one) => one.toLowerCase() !== alias.toLowerCase());
    row.aliases = rest.length > 0 ? rest.join(", ") : null;
  }
  state.opened.add(item.category);
  render();

  try {
    const payload = await send(`/api/resources/${item.id}/split`, "POST", { alias });
    if (payload.source) {
      const index = state.resources.findIndex((one) => one.id === item.id);
      if (index >= 0) state.resources[index] = payload.source;
    }
    if (payload.resource) state.resources.push(payload.resource);
    sortResources();
    render();

    // 옛 기록은 어느 표기로 들어왔는지 남아 있지 않아 옮길 수 없다.
    // 조용히 두면 "왜 통계가 안 갈라지지"가 되므로 수를 적어 알린다.
    const lines = [`${alias} 을(를) 따로 뗐습니다`, `기록 ${payload.moved ?? 0}건 이동`];
    toast(lines.join(" · "));
    if (payload.unknown > 0) {
      toast(
        `기존 기록 ${payload.unknown}건은 원래 표기를 알 수 없어 「${item.name}」에 남습니다. ` +
          `앞으로의 기록부터 「${alias}」로 잡힙니다.`,
        true,
      );
    }
  } catch (error) {
    restore(saved);
    toast(error.message, true);
  } finally {
    state.pending = false;
  }
}

/* ---------- 끌어서 합치기 ---------- */

/**
 * 자원을 끌어 다른 자원 위에 놓으면 합친다.
 *
 * HTML5 드래그다. 마우스가 있는 데스크톱에서 쓴다는 전제고,
 * 터치에서는 동작하지 않는다. 이 화면은 종사자가 책상에서 정리하는 자리다.
 */
function attachDrag(li, item) {
  if (isTemp(item.id)) return;

  li.draggable = true;
  li.title = "끌어서 다른 자원 위에 놓으면 그 자원에 합칩니다";

  li.addEventListener("dragstart", (event) => {
    event.dataTransfer.setData("text/plain", item.id);
    event.dataTransfer.effectAllowed = "move";
    state.dragging = item.id;
    li.classList.add("res--dragging");
  });

  li.addEventListener("dragend", () => {
    state.dragging = null;
    li.classList.remove("res--dragging");
    for (const node of el.groups.querySelectorAll(".res--drop")) node.classList.remove("res--drop");
  });

  li.addEventListener("dragover", (event) => {
    // 별칭을 끌고 있으면 여기서는 안 받는다. 자원 위에 놓는 것은 뜻이 정반대다.
    if (state.draggingAlias) return;
    // 자기 자신 위에는 놓을 수 없다
    if (!state.dragging || state.dragging === item.id) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    li.classList.add("res--drop");
  });

  li.addEventListener("dragleave", () => li.classList.remove("res--drop"));

  li.addEventListener("drop", (event) => {
    if (state.draggingAlias) return;
    event.preventDefault();
    li.classList.remove("res--drop");
    const fromId = event.dataTransfer.getData("text/plain") || state.dragging;
    if (!fromId || fromId === item.id) return;
    askMerge(fromId, item);
  });
}

/** 그 자원의 기록이 몇 건인지. 못 세도 진행은 막지 않되 그 사실은 알린다. */
async function countRecords(resource) {
  try {
    const payload = await get(`/api/resources/${resource.id}/record-count`);
    return payload.count ?? 0;
  } catch (error) {
    console.error("[countRecords]", error);
    toast("기록 수를 확인하지 못했습니다. 그대로 진행합니다.", true);
    return null;
  }
}

async function askMerge(fromId, to) {
  if (state.pending) return;
  const from = state.resources.find((item) => item.id === fromId);
  if (!from) return;

  const count = await countRecords(from);
  const countLine = count === null ? "기록이 함께 옮겨집니다." : `옮겨지는 기록: ${count}건`;

  const yes = await confirmDialog({
    title: "자원을 합칠까요?",
    message: `"${from.name}" → "${to.name}"\n${countLine}\n` +
      `별칭으로 남는 이름: ${from.name}\n되돌릴 수 없습니다.`,
    confirmText: "합치기",
  });
  if (yes) await mergeResource(from, to);
}

async function mergeResource(from, to) {
  const saved = snapshot();

  state.pending = true;
  state.resources = state.resources.filter((item) => item.id !== from.id);
  state.opened.add(to.category);
  render();

  try {
    const payload = await send(`/api/resources/${from.id}/merge`, "POST", { into: to.id });
    const index = state.resources.findIndex((item) => item.id === to.id);
    if (index >= 0 && payload.resource) state.resources[index] = payload.resource;
    render();
    toast(`합쳤습니다 · 기록 ${payload.moved ?? 0}건 이동 · 별칭 추가: ${payload.absorbed}`);
  } catch (error) {
    restore(saved);
    toast(error.message, true);
  } finally {
    state.pending = false;
  }
}

/* ---------- 자원 아님 (사전에서) ---------- */

/**
 * 삭제와 다르다.
 *   삭제      사전에서만 뺀다. 기록과 다음 추출은 그대로.
 *   자원 아님  기록을 '없음'으로 돌려 통계에서 빼고, 앞으로 뽑지 않고, 사전에서 뺀다.
 * "잘못 등록했다"와 "이건 자원이 아니다"는 다른 판단이라 확인창도 다르게 적는다.
 */
async function askReject(item) {
  if (state.pending) return;

  const count = await countRecords(item);
  const countLine = count === null
    ? "이 이름의 기록이 '자원 아님'이 되어 통계에서 빠집니다."
    : `기록 ${count}건이 '자원 아님'이 되어 통계에서 빠집니다.`;

  const yes = await confirmDialog({
    title: "자원이 아닌 것으로 처리할까요?",
    message: `${item.name}\n사전에서 빠지고, ${countLine}\n` +
      `앞으로 일지에서 이 이름은 뽑지 않습니다. 미분류함에서 되돌릴 수 있습니다.`,
    confirmText: "자원 아님",
  });
  if (yes) await rejectResource(item);
}

async function rejectResource(item) {
  const saved = snapshot();

  state.pending = true;
  state.resources = state.resources.filter((row) => row.id !== item.id);
  render();

  try {
    const payload = await send(`/api/resources/${item.id}/reject`, "POST", {});
    toast(`자원 아님으로 처리했습니다 · 기록 ${payload.rejected_records ?? 0}건 제외`);
  } catch (error) {
    restore(saved);
    toast(error.message, true);
  } finally {
    state.pending = false;
  }
}

/* ---------- 등록 · 수정 폼 ---------- */

function fillCategoryOptions(current) {
  // 지금 값이 카테고리 목록에 없을 수도 있다(카테고리를 지웠거나 뽑아 온 자원).
  // 그때도 값이 말없이 바뀌지 않게 현재 값을 목록에 넣어 준다.
  const list = current && !state.categories.includes(current)
    ? [...state.categories, current]
    : state.categories;
  fillOptions(el.category, list.map(toOption));
}

function openCreate() {
  if (state.categories.length === 0) {
    toast("먼저 [카테고리 관리]에서 카테고리를 하나 만들어 주세요.", true);
    return;
  }

  state.formMode = "create";
  state.editing = null;

  el.photo.title.textContent = "자원 등록";
  el.formTitle.textContent = "직접 입력";
  el.name.value = "";
  el.aliases.value = "";
  fillCategoryOptions(null);
  el.category.value = state.categories[0];

  // 세 길(직접·찍기·갤러리)이 한 화면
  resetPhoto();
  el.photo.block.hidden = false;
  el.form.hidden = false;
  el.photo.modal.hidden = false;
  focusOnWide(el.name);
}

function openEdit(item) {
  state.formMode = "edit";
  state.editing = item;

  el.photo.title.textContent = `${item.name} 수정`;
  el.formTitle.textContent = "";
  el.name.value = item.name ?? "";
  el.aliases.value = item.aliases ?? "";
  fillCategoryOptions(item.category);
  el.category.value = item.category ?? state.categories[0] ?? "";

  // 수정은 직접 입력만
  el.photo.block.hidden = true;
  el.form.hidden = false;
  el.photo.modal.hidden = false;
  focusOnWide(el.name);
}

function closeForm() {
  state.formMode = null;
  state.editing = null;
  el.photo.modal.hidden = true;
}

/* ---------- 저장 (낙관적 갱신) ---------- */

function isTemp(id) {
  return String(id).startsWith("temp-");
}

function snapshot() {
  return state.resources.map((item) => ({ ...item }));
}

function restore(saved) {
  state.resources = saved;
  render();
}

/** 이름순. 서버가 이름순으로 주므로 화면에서도 같은 순서를 지킨다. */
function sortResources() {
  state.resources.sort((a, b) => String(a.name).localeCompare(String(b.name), "ko"));
}

async function submit(event) {
  event.preventDefault();
  if (state.pending) return;

  const name = el.name.value.trim();
  const category = el.category.value;
  const aliases = el.aliases.value.trim();

  if (!name) {
    toast("자원명을 입력해 주세요.", true);
    return;
  }
  if (!category) {
    toast("카테고리를 골라 주세요.", true);
    return;
  }

  // 낙관적으로 폼을 닫으면 closeForm() 이 수정 중이라는 표시를 지운다.
  // 실패해서 폼을 다시 열 때 그대로 되살려야 한다 — 안 그러면 다시 [저장]이 "새로 등록" 이 된다.
  const formMode = state.formMode;
  const editing = state.editing;

  const saved = snapshot();
  state.pending = true;
  el.submit.disabled = true;

  // 저장한 자원이 접힌 묶음 안으로 사라지지 않게 그 카테고리를 펼쳐 둔다
  state.opened.add(category);

  try {
    if (formMode === "edit") {
      const target = editing;
      const row = state.resources.find((item) => item.id === target.id);
      // 사람이 저장을 눌렀으니 더는 AI 추측이 아니다. 뱃지가 한 번 깜빡이지 않게 여기서 뗀다.
      if (row) Object.assign(row, { name, category, aliases: aliases || null, auto_added: false });
      sortResources();
      closeForm();
      render();

      const payload = await send(`/api/resources/${target.id}`, "PATCH", {
        name,
        category,
        aliases: aliases || null,
      });
      const index = state.resources.findIndex((item) => item.id === target.id);
      if (index >= 0) state.resources[index] = payload.resource;
      sortResources();
      render();
      // 카테고리를 바꾸면 그 이름의 기록이 통째로 따라 옮겨진다. 몇 건인지 알려야
      // "왜 옛 묶음의 수가 줄었지" 를 되짚지 않는다.
      toast(payload.moved ? `저장되었습니다 · 기록 ${payload.moved}건 이동` : "저장되었습니다");
    } else {
      const tempId = `temp-${crypto.randomUUID()}`;
      state.resources.push({ id: tempId, name, category, aliases: aliases || null });
      sortResources();
      render();
      // 창은 열어 둔다 — 여러 개를 잇달아 넣는 일이 많다(카테고리는 그대로 두고 이름만 비운다)
      el.name.value = "";
      el.aliases.value = "";
      el.name.focus();

      const payload = await send("/api/resources", "POST", {
        name,
        category,
        aliases: aliases || null,
      });
      const index = state.resources.findIndex((item) => item.id === tempId);
      if (index >= 0) state.resources[index] = payload.resource;
      sortResources();
      render();
      toast(`${name} 등록되었습니다 — 이어서 다음 자원을 넣거나 [닫기]`);
    }
  } catch (error) {
    // 목록은 되돌리되 폼은 다시 연다. 입력값이 남아 있어 다시 저장할 수 있다.
    restore(saved);
    if (formMode !== "edit") {
      el.name.value = name;
      el.aliases.value = aliases;
    }
    state.formMode = formMode;
    state.editing = editing;
    el.form.hidden = false;
    el.photo.modal.hidden = false;
    toast(error.message, true);
  } finally {
    state.pending = false;
    el.submit.disabled = false;
  }
}

/* ---------- 자원 삭제 ---------- */

async function askDelete(item) {
  if (state.pending) return;

  const yes = await confirmDialog({
    title: "자원을 삭제할까요?",
    message: `${item.name}\n사전에서만 뺍니다. 기록과 다음 추출은 그대로입니다.\n` +
      `이 자원이 아예 자원이 아니라면 [자원 아님]을 쓰세요.\n되돌릴 수 없습니다.`,
    confirmText: "삭제",
  });
  if (yes) await deleteResource(item);
}

async function deleteResource(item) {
  const saved = snapshot();

  state.pending = true;
  state.resources = state.resources.filter((row) => row.id !== item.id);
  render();

  try {
    await remove(`/api/resources/${item.id}`);
    toast("자원을 삭제했습니다");
  } catch (error) {
    restore(saved);
    toast(error.message, true);
  } finally {
    state.pending = false;
  }
}

/* ---------- 카테고리 관리 ---------- */

/** 그 카테고리를 쓰는 자원이 몇 건인지. 화면이 이미 가진 값으로 센다. */
function countIn(name) {
  return state.resources.filter((item) => item.category === name).length;
}

function renderCategories() {
  el.catList.replaceChildren();

  for (const [index, name] of state.categories.entries()) {
    const li = document.createElement("li");
    li.className = "rescat__item";

    if (state.renaming === name) {
      el.catList.append(renderRenameRow(li, name));
      continue;
    }

    const label = document.createElement("span");
    label.className = "rescat__name";
    label.textContent = name;

    const count = document.createElement("span");
    count.className = "rescat__count";
    count.textContent = `${countIn(name)}건`;

    const actions = document.createElement("div");
    actions.className = "rescat__actions";

    const up = button("↑", "btn btn--icon", () => moveCategory(index, -1));
    up.disabled = index === 0 || state.pending;
    up.setAttribute("aria-label", `${name} 위로`);

    const down = button("↓", "btn btn--icon", () => moveCategory(index, 1));
    down.disabled = index === state.categories.length - 1 || state.pending;
    down.setAttribute("aria-label", `${name} 아래로`);

    const rename = button("이름 바꾸기", "linkbtn", () => {
      state.renaming = name;
      renderCategories();
    });
    const del = button("삭제", "linkbtn linkbtn--danger", () => askDeleteCategory(name));
    rename.disabled = state.pending;
    del.disabled = state.pending;

    actions.append(up, down, rename, del);
    li.append(label, count, actions);
    el.catList.append(li);
  }
}

/**
 * 카테고리 목록을 통째로 보낸다. 추가·순서·삭제가 모두 이 한 번이다.
 *
 * 이름 변경만 rename 을 함께 보낸다. 목록만 봐서는 이름을 바꾼 것과
 * 하나 지우고 하나 만든 것을 구분할 수 없는데, 둘은 결과가 다르다.
 */
async function saveCategories(next, rename = null, successMessage = "저장되었습니다") {
  if (state.pending) return false;

  const saved = [...state.categories];
  state.pending = true;
  state.categories = next;
  renderCategories();

  try {
    const payload = await send("/api/resource-categories", "PUT", { categories: next, rename });
    state.categories = payload.categories ?? next;

    // 이름을 바꿨으면 화면이 가진 자원의 카테고리도 따라 바꾼다.
    // 서버가 이미 옮겼으므로 다시 읽지 않아도 같은 상태가 된다.
    if (rename) {
      for (const item of state.resources) {
        if (item.category === rename.from) item.category = rename.to;
      }
      if (state.opened.delete(rename.from)) state.opened.add(rename.to);
    }

    toast(successMessage);
    return true;
  } catch (error) {
    state.categories = saved;
    toast(error.message, true);
    return false;
  } finally {
    // 다시 그리는 일은 여기서 한 번만 한다.
    // try 안에서 그리면 pending 이 아직 true 라 모든 버튼이 눌리지 않는 채로 남는다.
    state.pending = false;
    renderCategories();
  }
}

function addCategory(event) {
  event.preventDefault();

  const name = el.catNew.value.trim();
  if (!name) {
    toast("카테고리 이름을 입력해 주세요.", true);
    return;
  }
  if (state.categories.includes(name)) {
    toast(`"${name}" 은(는) 이미 있습니다.`, true);
    return;
  }

  el.catNew.value = "";
  saveCategories([...state.categories, name], null, "카테고리를 추가했습니다");
}

function moveCategory(index, delta) {
  const next = [...state.categories];
  const target = index + delta;
  if (target < 0 || target >= next.length) return;

  [next[index], next[target]] = [next[target], next[index]];
  saveCategories(next, null, "순서를 바꿨습니다");
}

/** 이름을 고쳐 쓰는 줄. 그 자리에서 바꾼다 — 창을 하나 더 띄우지 않는다. */
function renderRenameRow(li, name) {
  li.classList.add("rescat__item--editing");

  const input = document.createElement("input");
  input.type = "text";
  input.className = "input rescat__input";
  input.maxLength = 30;
  input.value = name;
  input.setAttribute("aria-label", `${name} 새 이름`);

  const actions = document.createElement("div");
  actions.className = "rescat__actions";
  actions.append(
    button("저장", "btn btn--primary", () => commitRename(name, input.value)),
    button("취소", "btn", () => {
      state.renaming = null;
      renderCategories();
    }),
  );

  // Enter 로도 저장한다. 폼이 아니라 submit 이 없다.
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitRename(name, input.value);
    }
    if (event.key === "Escape") {
      state.renaming = null;
      renderCategories();
    }
  });

  li.append(input, actions);
  queueMicrotask(() => input.select());
  return li;
}

/**
 * 이름 바꾸기는 곧 그 안의 자원을 통째로 옮기는 일이다.
 * 몇 건이 따라 움직이는지 먼저 알려 준다.
 */
async function commitRename(name, value) {
  const count = countIn(name);
  const trimmed = value.trim();

  if (!trimmed || trimmed === name) {
    state.renaming = null;
    renderCategories();
    return;
  }
  if (state.categories.includes(trimmed)) {
    toast(`"${trimmed}" 은(는) 이미 있습니다.`, true);
    return;
  }

  if (count > 0) {
    const yes = await confirmDialog({
      title: "카테고리 이름을 바꿀까요?",
      message: `"${name}" → "${trimmed}"\n이 카테고리의 자원 ${count}건도 함께 옮겨집니다.`,
      confirmText: "이름 바꾸기",
      danger: false,
    });
    if (!yes) return;
  }

  state.renaming = null;
  const list = state.categories.map((item) => (item === name ? trimmed : item));
  saveCategories(list, { from: name, to: trimmed }, "이름을 바꿨습니다");
}

/**
 * 자원이 남아 있는 카테고리는 지우지 않는다.
 *
 * 지우면서 자원을 '기타'로 옮기는 방법도 있지만, 스무 개가 말없이 옮겨 가면
 * 나중에 왜 기타가 늘었는지 아무도 설명하지 못한다.
 * 옮기고 싶으면 이름 바꾸기를 쓴다. 그쪽은 하는 일이 눈에 보인다.
 * 서버도 같은 규칙으로 한 번 더 막는다.
 */
async function askDeleteCategory(name) {
  const count = countIn(name);

  if (count > 0) {
    await confirmDialog({
      title: "지울 수 없습니다",
      message: `"${name}" 에 자원 ${count}건이 있습니다.\n` +
        `이름을 바꿔 옮기거나, 자원을 하나씩 다른 카테고리로 옮긴 뒤 지워 주세요.`,
      confirmText: "알겠습니다",
      danger: false,
    });
    return;
  }

  if (state.categories.length === 1) {
    toast("카테고리는 하나 이상 있어야 합니다.", true);
    return;
  }

  const yes = await confirmDialog({
    title: "카테고리를 삭제할까요?",
    message: `${name}\n비어 있는 카테고리이므로 자원은 사라지지 않습니다.`,
    confirmText: "삭제",
  });
  if (!yes) return;

  state.opened.delete(name);
  saveCategories(
    state.categories.filter((item) => item !== name),
    null,
    "카테고리를 삭제했습니다",
  );
}

/* ---------- 사진으로 등록 ---------- */

const photoSource = mountPhotoSource(el.photo.source, (file) => onPhotoPicked(file));

/** 사진 칸을 처음 상태로 — 등록 모달을 열 때·[다른 사진] */
function resetPhoto() {
  // 사진 안내는 모든 사진 자리가 같은 말이어야 한다(ui.js 의 PHOTO_NOTICE).
  el.photo.notice.textContent = PHOTO_NOTICE;
  state.photo = { image: null, items: [], busy: false };
  photoSource.reset();
  el.photo.preview.hidden = true;
  el.photo.preview.removeAttribute("src");
  el.photo.run.disabled = true;
  el.photo.pick.hidden = false;
  el.photo.result.hidden = true;
  hideState(el.photo.state);
  // 사진 흐름이 끝나면(다른 사진) 직접 입력도 다시 보인다
  if (state.formMode === "create") el.form.hidden = false;
}

function closePhoto() {
  if (state.photo.busy) return;
  closeForm();
}

/** [📷 찍기]·[🖼 갤러리] 어느 쪽에서 골랐든 여기로 모인다 */
async function onPhotoPicked(file) {
  state.photo.image = null;
  el.photo.run.disabled = true;
  el.photo.preview.hidden = true;
  if (!file) return;

  if (!file.type.startsWith("image/")) {
    toast("사진 파일만 올릴 수 있습니다.", true);
    return;
  }

  try {
    const prepared = await prepareImage(file);
    const bytes = base64Bytes(prepared.base64);
    if (bytes > PHOTO_MAX_BYTES) {
      toast(`사진이 너무 큽니다 (${Math.round(bytes / 1024 / 1024)}MB). 5MB 이하로 올려 주세요.`, true);
      return;
    }
    state.photo.image = prepared;
    el.photo.preview.src = prepared.previewUrl;
    el.photo.preview.hidden = false;
    el.photo.run.disabled = false;
  } catch (error) {
    toast(error.message, true);
  }
}

async function runPhoto() {
  if (!state.photo.image || state.photo.busy) return;

  state.photo.busy = true;
  el.photo.run.disabled = true;
  el.photo.pick.hidden = true;
  // 사진 흐름이 시작되면 직접 입력은 접는다 — 후보 목록에 집중
  el.form.hidden = true;
  showState(el.photo.state, "인식 중…", "사진 한 장에 10~20초쯤 걸립니다.");

  try {
    const payload = await send("/api/resources/from-photo", "POST", {
      image: state.photo.image.base64,
      mime_type: state.photo.image.mimeType,
    });
    state.photo.items = (payload.items ?? []).map((item) => ({
      ...item,
      // 확신 없는 것과 이미 있는 것은 체크를 풀어 둔다. 사람이 보고 켠다.
      checked: !item.duplicate && item.confident,
    }));
    hideState(el.photo.state);
    renderPhotoResult();
  } catch (error) {
    // 사진 탓이 아니면(AI 설정·서버·연결) 같은 사진으로 다시 하거나 직접 입력하라고 안내한다
    const hint = error.payload?.ai_service
      ? "사진 문제는 아닙니다. 잠시 뒤 같은 사진으로 다시 하거나, 위 [직접 입력]으로 등록해 주세요."
      : "다른 사진으로 다시 시도해 보세요.";
    showState(el.photo.state, error.message, hint, true);
    el.photo.pick.hidden = false;
    el.photo.run.disabled = false;
    el.form.hidden = false;
  } finally {
    state.photo.busy = false;
  }
}

function renderPhotoResult() {
  const items = state.photo.items;
  el.photo.list.replaceChildren();

  const dupCount = items.filter((item) => item.duplicate).length;
  const lowCount = items.filter((item) => !item.duplicate && !item.confident).length;
  el.photo.summary.textContent = items.length === 0
    ? "알아볼 수 있는 자원이 없습니다. 더 가까이서 찍거나 다른 사진을 올려 보세요."
    : `${items.length}개 인식 · 이미 등록됨 ${dupCount}개 · 확신 낮음 ${lowCount}개. ` +
      "이름과 카테고리를 고친 뒤 등록할 것만 체크하세요.";

  for (const item of items) el.photo.list.append(renderPhotoItem(item));

  el.photo.register.disabled = items.every((item) => item.duplicate);
  el.photo.result.hidden = false;
}

function renderPhotoItem(item) {
  const li = document.createElement("li");
  li.className = item.duplicate ? "photo__item photo__item--dup" : "photo__item";

  const check = document.createElement("input");
  check.type = "checkbox";
  check.className = "photo__check";
  check.checked = item.checked;
  check.disabled = item.duplicate;
  check.setAttribute("aria-label", `${item.name} 등록`);
  check.addEventListener("change", () => {
    item.checked = check.checked;
  });

  const name = document.createElement("input");
  name.type = "text";
  name.className = "input resx__input";
  name.maxLength = 100;
  name.value = item.name;
  name.disabled = item.duplicate;
  name.setAttribute("aria-label", "자원명");
  name.addEventListener("input", () => {
    item.name = name.value;
  });

  const category = document.createElement("select");
  category.className = "input resx__select";
  category.disabled = item.duplicate;
  category.setAttribute("aria-label", "카테고리");
  fillOptions(category, [
    { value: "", label: "카테고리 미정" },
    ...state.categories.map(toOption),
  ]);
  category.value = item.category ?? "";
  category.addEventListener("change", () => {
    item.category = category.value || null;
  });

  li.append(check, name, category);

  if (item.duplicate) {
    const tag = document.createElement("span");
    tag.className = "tag tag--unset";
    tag.textContent = item.duplicate_of && item.duplicate_of !== item.name
      ? `이미 등록됨 · ${item.duplicate_of}`
      : "이미 등록됨";
    li.append(tag);
  } else if (!item.confident) {
    const tag = document.createElement("span");
    tag.className = "tag tag--stale";
    tag.textContent = "확신 낮음";
    li.append(tag);
  }

  return li;
}

/**
 * 체크한 것만 등록한다.
 *
 * 화면에는 미리 넣지 않는다. 사진 한 장에 스무 개가 들어올 수 있고,
 * 그중 몇이 서버에서 걸러질지 모른다. 결과를 받아 목록을 다시 읽는다.
 */
async function registerPhotoItems() {
  if (state.photo.busy) return;

  const picked = state.photo.items.filter((item) => item.checked && !item.duplicate);
  if (picked.length === 0) {
    toast("등록할 항목을 체크해 주세요.", true);
    return;
  }
  const missing = picked.filter((item) => !item.name.trim() || !item.category);
  if (missing.length > 0) {
    toast("체크한 항목의 이름과 카테고리를 채워 주세요.", true);
    return;
  }

  state.photo.busy = true;
  el.photo.register.disabled = true;

  try {
    const payload = await send("/api/resources/batch", "POST", {
      items: picked.map((item) => ({ name: item.name.trim(), category: item.category })),
    });
    const created = payload.created ?? [];
    const skipped = payload.skipped ?? [];
    const dupSkipped = skipped.filter((row) => row.reason === "이미 등록됨").length;

    let message = `${created.length}개 등록`;
    if (dupSkipped > 0) message += ` · ${dupSkipped}개는 이미 있어 건너뜀`;
    if (skipped.length > dupSkipped) message += ` · ${skipped.length - dupSkipped}개 실패`;
    toast(message, created.length === 0);

    // 새로 들어간 것이 접힌 묶음 안으로 사라지지 않게 그 카테고리를 펼쳐 둔다
    for (const item of created) state.opened.add(item.category);

    closeForm();
    await loadResources();
  } catch (error) {
    toast(error.message, true);
  } finally {
    state.photo.busy = false;
    el.photo.register.disabled = false;
  }
}

el.photo.close.addEventListener("click", closePhoto);
el.photo.backdrop.addEventListener("click", closePhoto);
el.photo.run.addEventListener("click", runPhoto);
el.photo.register.addEventListener("click", registerPhotoItems);
el.photo.retry.addEventListener("click", resetPhoto);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !el.photo.modal.hidden) closePhoto();
});

/* ---------- 이벤트 ---------- */

el.search.addEventListener("input", () => {
  state.query = el.search.value;
  render();
});

el.addOpen.addEventListener("click", openCreate);
el.cancel.addEventListener("click", closeForm);
el.form.addEventListener("submit", submit);

el.catOpen.addEventListener("click", goToCategories);
el.catBack.addEventListener("click", () => {
  goToList();
  // 카테고리가 바뀌었으면 묶음도 다시 그려야 한다
  render();
});
el.catAddForm.addEventListener("submit", addCategory);

// 별칭을 목록 빈 자리에 놓으면 떨어져 나온다 (합치기의 역동작).
// 목록은 다시 그려도 el.groups 자체는 그대로라 한 번만 걸면 된다.
attachAliasDropZone();
