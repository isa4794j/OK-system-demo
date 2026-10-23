/**
 * 아동 명단 + 아동 상세 화면
 *
 * 브라우저는 Supabase에 직접 접근하지 않는다.
 * 데이터는 항상 Deno 서버의 /api/... 를 거쳐서만 받는다.
 *
 * 관찰을 고치는 동작(추가·영역지정·수정·나누기)은 낙관적 갱신을 쓴다.
 * 화면을 먼저 바꾸고 서버에 보낸 뒤, 실패하면 바꾸기 전으로 되돌리고 알린다.
 */
import { compareChildren, gradeLabel } from "./grade.js";
import { chooseDialog, typeToConfirm } from "./danger_dialog.js";
import { initEvaluation, loadEvaluation, renderEvaluation } from "./evaluation.js";
import { loadGrowth } from "./growth.js";
import { HALF_OBSERVATION } from "./features.js";
import {
  button,
  confirmDialog,
  explain,
  fillOptions,
  formatDate,
  get,
  hideState,
  remove,
  ro,
  send,
  showState,
  toast,
  todayISO,
  toOption,
} from "./ui.js";
import {
  attachMergeDrag,
  confirmMerge,
  renderContentEditor as buildContentEditor,
  renderSplitEditor as buildSplitEditor,
} from "./obs_edit.js";
import {
  activeObsAreas,
  areaName,
  isActiveArea,
  isKnownArea,
  isOldArea,
  loadObsAreas,
  obsAreas,
  onObsAreasChange,
} from "./obs_areas.js";
import { openPrint } from "./print_link.js";
import { rosterNumber, rosterPager } from "./roster_more.js";

/** 영역 목록은 settings.observation_areas(obs_areas.js 한 벌). 여기는 출처만 고정. */
const SOURCES = ["멘토", "봉사", "프로그램", "일상", "회의"];

/** 영역이 정해지지 않은 관찰을 모아 부르는 이름 */
const UNSET = "미지정";

/**
 * 근거 일지가 바뀐 관찰에 붙이는 표시.
 * 알리기만 한다. 관찰을 자동으로 고치거나 지우지 않는다.
 */
const SOURCE_BADGE = {
  modified: {
    text: "근거 일지 수정됨",
    className: "tag tag--stale",
    title: "[관찰 가져오기] 뒤 원본 일지가 수정되었습니다. 내용이 맞는지 확인해 주세요.",
  },
  deleted: {
    text: "근거 일지 삭제됨",
    className: "tag tag--gone",
    title: "이 관찰의 근거가 된 일지가 삭제되었습니다. 관찰은 그대로 남아 있습니다.",
  },
};

/** 근거가 바뀐 관찰이면 표시를 만들어 돌려준다. 아니면 null. */
function sourceBadge(item) {
  const badge = SOURCE_BADGE[item.source_status];
  if (!badge) return null;

  const node = document.createElement("span");
  node.className = badge.className;
  node.textContent = badge.text;
  return explain(node, badge.title);
}

const state = {
  children: [],
  status: "재원", // 재원 | 종결 — 오늘 기준. classify() 가 정한다
  query: "",
  listLoading: true,
  listError: null,

  child: null,
  year: currentYear(),
  half: currentHalf(),
  observations: [],
  obsLoading: false,
  obsError: null,

  editing: null, // { id, mode: "content" | "split" }
  draft: { content: "", newContent: "", newArea: "" },
  flashId: null,
  pending: false,

  mode: "view", // view = 영역별 보기, edit = 날짜별 편집
  openAreas: new Set(), // 펼쳐 둔 영역 칸
  /** 영역별 보기 — 칸마다 몇 건까지 그렸나(15건씩 [더 보기]) */
  areaShown: new Map(),
  /** 날짜별 편집 — 몇 건까지 그렸나(10건씩, 끝에 닿으면 이어서) */
  obsShown: 10,
  /** [미지정만 보기] */
  unsetOnly: false,
  /** 영역 저장 — 관찰마다 따로(한 줄이 저장 중이어도 다른 줄을 고를 수 있다). id → 보낸 차례 */
  areaSeq: new Map(),

  // 일지에서 관찰 가져오기
  importItems: [],
  /** 아직 [관찰 가져오기] 를 안 한 후보 수(뱃지) */
  importWaiting: 0,
  importChecked: new Set(),
  importLoading: false,
  importError: null,
  importPending: false,
};

const el = {
  tbody: document.getElementById("tbody"),
  listState: document.getElementById("state"),
  count: document.getElementById("count"),
  search: document.getElementById("search"),
  statusChips: document.querySelectorAll(".chip[data-status]"),
  viewList: document.getElementById("view-list"),

  viewDetail: document.getElementById("view-detail"),
  back: document.getElementById("back"),
  detailName: document.getElementById("detail-name"),
  detailMeta: document.getElementById("detail-meta"),
  yearChips: document.getElementById("year-chips"),
  halfChips: document.querySelectorAll(".chip[data-half]"),
  areas: document.getElementById("areas"),
  areasState: document.getElementById("areas-state"),
  areaViews: document.getElementById("area-views"),
  areasExpand: document.getElementById("areas-expand"),
  areasPrint: document.getElementById("areas-print"),
  detailView: document.getElementById("detail-view"),
  detailEdit: document.getElementById("detail-edit"),
  goEdit: document.getElementById("go-edit"),
  goView: document.getElementById("go-view"),
  obs: document.getElementById("obs"),
  obsState: document.getElementById("obs-state"),
  obsUnsetOnly: document.getElementById("obs-unset-only"),
  obsCount: document.getElementById("obs-count"),
  obsMoreBox: document.getElementById("obs-more-box"),
  obsMore: document.getElementById("obs-more"),

  addOpen: document.getElementById("add-open"),
  addForm: document.getElementById("add-form"),
  addDate: document.getElementById("add-date"),
  addArea: document.getElementById("add-area"),
  addSource: document.getElementById("add-source"),
  addContent: document.getElementById("add-content"),
  addSubmit: document.getElementById("add-submit"),
  addCancel: document.getElementById("add-cancel"),

  importOpen: document.getElementById("import-open"),
  importCount: document.getElementById("import-count"),
  goEditCount: document.getElementById("go-edit-count"),
  importModal: document.getElementById("import-modal"),
  importBackdrop: document.getElementById("import-backdrop"),
  importList: document.getElementById("import-list"),
  importState: document.getElementById("import-state"),
  importAll: document.getElementById("import-all"),
  importSubmit: document.getElementById("import-submit"),
  importCancel: document.getElementById("import-cancel"),
};

// 카드 안에 들어가는 상태 박스는 여백을 줄인다
el.areasState.dataset.inline = "true";
el.obsState.dataset.inline = "true";
el.importState.dataset.inline = "true";

/* ---------- 기간 ---------- */

function currentYear() {
  return new Date().getFullYear();
}

/** 1 = 상반기(1~6월), 2 = 하반기(7~12월) */
function currentHalf() {
  return new Date().getMonth() + 1 <= 6 ? 1 : 2;
}

/** 고를 수 있는 연도 — 입소한 해부터 올해까지(입소일을 모르면 10년 전부터) */
function yearBounds() {
  const max = currentYear();
  const enrolled = Number(String(state.child?.enroll_date ?? "").slice(0, 4));
  const min = Number.isInteger(enrolled) && enrolled > 1999 ? Math.min(enrolled, max) : max - 10;
  return { min, max };
}

function rangeOf(year, half) {
  return half === 1
    ? { from: `${year}-01-01`, to: `${year}-06-30` }
    : { from: `${year}-07-01`, to: `${year}-12-31` };
}

function isInCurrentRange(date) {
  const { from, to } = rangeOf(state.year, state.half);
  return date >= from && date <= to;
}

/* ---------- 화면 전환 (app.js가 부른다) ---------- */

/** 아동 화면을 연다. 상세를 보던 중이었어도 명단으로 되돌린다. */
export function showChildren() {
  closeDetail();
  if (state.children.length === 0 && !state.listError) loadChildren();
}

/** 다른 화면으로 넘어갈 때 정리 */
export function hideChildren() {
  el.viewList.hidden = true;
  el.viewDetail.hidden = true;
  elc.viewForm.hidden = true;
}

/* ---------- 명단 ---------- */

let listPager = null;
/** 10명씩 [더 보기] — 처음 그릴 때 만든다 */
function pager() {
  listPager ??= rosterPager(el.listState, (children, start) => {
    const rows = children.map((child, i) => renderRow(child, start + i + 1));
    el.tbody.append(...rows);
    return rows[0]?.querySelector(".namebtn") ?? null;
  });
  return listPager;
}

/** 명단이 굴러가는 상자(넓은·좁은 화면 모두 .main) */
const listScroller = () => document.querySelector(".main") ?? document.scrollingElement;

/**
 * 상세를 보러 갈 때의 명단 위치. 상세에서 [←] 로 돌아오면 여기로 되돌리고 [더 보기] 도 편 채로 둔다.
 * 그 사이 명단이 바뀌었으면(등록·수정·삭제) 되돌리지 않고 처음부터(dirty).
 */
const listSpot = { top: 0, dirty: false };

async function loadChildren() {
  state.listLoading = true;
  state.listError = null;
  renderList();

  try {
    const payload = await get("/api/children");
    state.children = payload.children ?? [];
  } catch (error) {
    state.listError = error.message;
  } finally {
    state.listLoading = false;
    renderList();
  }
}

/**
 * 오늘 기준으로 재원인지 종결인지. status 와 날짜를 둘 다 본다.
 *
 * 종결 = status 가 종결이고 종결일이 오늘 이전(또는 오늘).
 * 종결로 바꿔 두었지만 종결일이 미래면 아직 다니는 아이다 — 재원으로 본다.
 * 종결일이 없는 옛 데이터는 종결로 둔다. 감추는 것보다 낫다.
 */
function classify(child, today = todayISO()) {
  if (child.status !== "종결") return "재원";
  if (!child.exit_date) return "종결";
  return child.exit_date <= today ? "종결" : "재원";
}

/** 배지 글. 재원·종결에 더해 "종결 예정"·"입소 예정"을 따로 적는다. */
function stateLabel(child, today = todayISO()) {
  if (classify(child, today) === "종결") return "종결";
  if (child.status === "종결") return "종결 예정";
  if (child.enroll_date && child.enroll_date > today) return "입소 예정";
  return "재원";
}

function visibleChildren() {
  const query = state.query.trim().toLowerCase();
  return state.children.filter((child) => {
    if (classify(child) !== state.status) return false;
    if (query && !String(child.name ?? "").toLowerCase().includes(query)) return false;
    return true;
  });
}

function renderList() {
  const rows = visibleChildren();

  el.tbody.replaceChildren();
  hideState(el.listState);
  pager().hide();

  if (state.listLoading) {
    showState(el.listState, "불러오는 중…");
    el.count.textContent = "";
    return;
  }

  if (state.listError) {
    showState(
      el.listState,
      state.listError,
      "테이블이 아직 없거나 환경변수가 비어 있을 수 있습니다. /health 를 확인해 보세요.",
      true,
    );
    el.count.textContent = "";
    return;
  }

  el.count.textContent = state.children.length === 0
    ? ""
    : `${rows.length}명`;

  if (state.children.length === 0) {
    showState(
      el.listState,
      "아직 등록된 아동이 없습니다.",
      "PC 화면의 [+ 아동 등록] 으로 추가하면 여기에 표시됩니다.",
    );
    return;
  }

  if (rows.length === 0) {
    showState(el.listState, "조건에 맞는 아동이 없습니다.", "필터를 바꾸거나 검색어를 지워 보세요.");
    return;
  }

  pager().take(rows).forEach((child, i) => el.tbody.append(renderRow(child, i + 1)));
}

function renderRow(child, no) {
  const tr = document.createElement("tr");

  const nameCell = document.createElement("td");
  nameCell.className = "roster__name";
  const nameButton = document.createElement("button");
  nameButton.type = "button";
  nameButton.className = "namebtn";
  // 이름은 사용자가 입력한 값이므로 textContent로만 넣는다 (HTML로 해석되지 않게)
  nameButton.textContent = child.name ?? "-";
  nameButton.addEventListener("click", () => openDetail(child));
  nameCell.append(rosterNumber(no), nameButton);

  const gradeCell = document.createElement("td");
  gradeCell.textContent = gradeLabel(child.birth_date);

  const genderCell = document.createElement("td");
  genderCell.textContent = child.gender ?? "-";

  const statusCell = document.createElement("td");
  statusCell.className = "roster__status";
  const badge = document.createElement("span");
  const label = stateLabel(child);
  badge.className = label === "재원" ? "badge badge--active" : "badge";
  badge.textContent = label;
  statusCell.append(badge);

  tr.append(nameCell, gradeCell, genderCell, statusCell);
  return tr;
}

/* ---------- 상세 ---------- */

function openDetail(child) {
  listSpot.top = listScroller()?.scrollTop ?? 0;
  listSpot.dirty = false;
  state.child = child;
  state.mode = "view";
  state.openAreas = new Set();
  el.detailEdit.hidden = true;
  el.detailView.hidden = false;
  // 상세를 열 때마다 현재 기간으로 되돌린다
  state.year = currentYear();
  state.half = currentHalf();
  closeEditors();
  closeAddForm();
  closeImport();

  renderDetailHead(child);
  loadChildInfo(child);

  buildYearChips();
  syncPeriodChips();

  el.viewList.hidden = true;
  el.viewDetail.hidden = false;
  // 상세는 맨 위부터 — 명단을 굴리던 자리에서 열리면 머리가 안 보인다
  const scroller = listScroller();
  if (scroller) scroller.scrollTop = 0;
  el.back.focus({ preventScroll: true });

  loadObservations();
  loadEvaluation();
  // 성장 추이는 기간 칩과 상관없이 모든 반기를 늘어놓는다. 아동이 바뀔 때만 다시 읽는다.
  // 반기별 관찰을 숨긴 동안은 카드도 부르기도 없다(features.js)
  document.getElementById("growth-card").hidden = !HALF_OBSERVATION;
  if (HALF_OBSERVATION) loadGrowth(child.id);
}

/**
 * 상세를 닫는다.
 *   restore: true — 상세의 [←]. 명단이 그대로면 보던 위치·[더 보기] 편 채로 돌아온다.
 *   그 밖(탭 이동·삭제 뒤) — 처음 10명·맨 위.
 */
function closeDetail({ restore = false } = {}) {
  const back = restore && !listSpot.dirty;
  state.child = null;
  state.observations = [];
  state.mode = "view";
  state.openAreas = new Set();
  el.detailEdit.hidden = true;
  el.detailView.hidden = false;
  closeEditors();
  closeAddForm();
  closeImport();
  el.viewDetail.hidden = true;
  if (!back) {
    showListFresh();
    return;
  }
  el.viewList.hidden = false;
  renderList();
  const scroller = listScroller();
  if (scroller) scroller.scrollTop = listSpot.top;
}

/** 명단으로 돌아올 때는 어디서 오든 처음 10명부터(칩을 바꿀 때와 같게) */
function showListFresh() {
  pager().reset();
  el.viewList.hidden = false;
  renderList();
  const scroller = listScroller();
  if (scroller) scroller.scrollTop = 0;
}

/** 연도 ‹ 2026년 › — 재원 기간 전체를 늘어놓지 않고 올해에서 한 해씩 옮긴다 */
const yearNav = {
  prev: button("‹", "btn btn--icon yearnav__btn", () => moveYear(-1)),
  label: document.createElement("span"),
  next: button("›", "btn btn--icon yearnav__btn", () => moveYear(1)),
};
yearNav.prev.setAttribute("aria-label", "지난해");
yearNav.next.setAttribute("aria-label", "다음 해");
yearNav.label.className = "yearnav__label";
yearNav.label.setAttribute("aria-live", "polite");

function buildYearChips() {
  el.yearChips.replaceChildren(yearNav.prev, yearNav.label, yearNav.next);
}

function moveYear(delta) {
  const { min, max } = yearBounds();
  const year = Math.min(max, Math.max(min, state.year + delta));
  if (year === state.year) return;
  state.year = year;
  closeEditors();
  closeAddForm();
  syncPeriodChips();
  loadObservations();
  loadEvaluation();
}

function syncPeriodChips() {
  const { min, max } = yearBounds();
  yearNav.label.textContent = `${state.year}년`;
  yearNav.prev.disabled = state.year <= min;
  yearNav.next.disabled = state.year >= max;
  for (const chip of el.halfChips) {
    chip.classList.toggle("is-selected", Number(chip.dataset.half) === state.half);
  }
}

async function loadObservations() {
  if (!state.child) return;

  state.obsLoading = true;
  state.obsError = null;
  state.obsShown = OBS_STEP;
  state.areaShown = new Map();
  renderDetail();

  const params = new URLSearchParams({
    child: state.child.id,
    year: String(state.year),
    half: String(state.half),
  });

  refreshImportCount();
  try {
    const payload = await get(`/api/observations?${params}`);
    state.observations = payload.observations ?? [];
  } catch (error) {
    state.obsError = error.message;
    state.observations = [];
  } finally {
    state.obsLoading = false;
    renderDetail();
  }
}

/**
 * 일지에서 뽑혀 아직 [관찰 가져오기] 를 안 한 후보 수 — 편집 버튼과 가져오기 버튼에 뱃지로.
 * 아동 상세만 보고는 기다리는 후보가 있는지 알 수 없었다(페르소나 리뷰).
 */
async function refreshImportCount() {
  const child = state.child;
  if (!child) return;
  // 앞 아동의 뱃지가 남아 보이지 않게 먼저 지운다
  for (const badge of [el.importCount, el.goEditCount]) badge.hidden = true;
  try {
    const payload = await get(`/api/children/${child.id}/importable`);
    if (state.child?.id !== child.id) return; // 그새 다른 아동으로 넘어갔다
    state.importWaiting = (payload.items ?? []).filter((item) => !item.imported && !item.merged).length;
  } catch {
    state.importWaiting = 0; // 뱃지 하나 때문에 화면을 막지 않는다
  }
  for (const badge of [el.importCount, el.goEditCount]) {
    badge.textContent = String(state.importWaiting);
    badge.hidden = state.importWaiting === 0;
  }
  renderAreas();
}

function renderDetail() {
  renderAreas();
  renderObservations();
  // 근거 보기와 영역별 관찰 건수가 지금 관찰을 따라가야 한다
  renderEvaluation();
}

function areaCounts() {
  const counts = new Map(obsAreas().map((area) => [area.code, 0]));
  let unset = 0;

  for (const item of state.observations) {
    if (item.area && counts.has(item.area)) {
      counts.set(item.area, counts.get(item.area) + 1);
    } else {
      unset += 1;
    }
  }
  return { counts, unset };
}

/**
 * 영역 칸 순서 — 지금 쓰는 영역, 관찰이 남아 있는 예전 영역(지운 것), 미지정.
 * 칸은 코드로 가른다(이름을 바꿔도 같은 칸).
 */
function areaSlots() {
  const { counts } = areaCounts();
  return [
    ...activeObsAreas().map((area) => area.code),
    ...obsAreas().filter((area) => area.deleted && counts.get(area.code) > 0).map((area) => area.code),
    UNSET,
  ];
}

/** 칸 이름 — 코드 → 보이는 이름 */
function slotName(code) {
  return code === UNSET ? UNSET : areaName(code);
}

/** 그 칸에 속하는 관찰. 미지정은 area가 없거나 목록에 없는 값인 것들. */
function observationsOf(name) {
  if (name === UNSET) {
    return state.observations.filter((item) => !isKnownArea(item.area));
  }
  return state.observations.filter((item) => item.area === name);
}

function renderAreas() {
  el.areas.replaceChildren();
  el.areaViews.replaceChildren();
  hideState(el.areasState);

  if (state.obsLoading || state.obsError) {
    el.areasExpand.hidden = true;
    showState(
      el.areasState,
      state.obsLoading ? "불러오는 중…" : state.obsError,
      null,
      !!state.obsError,
    );
    return;
  }

  if (state.observations.length === 0) {
    el.areasExpand.hidden = true;
    showState(
      el.areasState,
      "아직 관찰이 없어요.",
      state.importWaiting > 0
        ? `일지에서 뽑힌 관찰 후보 ${state.importWaiting}건이 기다리고 있어요 — [날짜별 · 편집 →] 의 [일지에서 관찰 가져오기] 에서 옮기세요.`
        : "[날짜별 · 편집 →] 에서 관찰을 더할 수 있습니다.",
    );
    return;
  }

  const { counts, unset } = areaCounts();
  const countOf = (name) => (name === UNSET ? unset : counts.get(name) ?? 0);
  const slots = areaSlots();

  for (const name of slots) {
    el.areas.append(renderAreaTile(name, countOf(name)));
  }

  // 관찰이 있는 칸이 하나라도 접혀 있으면 "전체 펼치기", 다 펼쳐졌으면 "전체 접기"
  const filled = slots.filter((name) => countOf(name) > 0);
  const allOpen = filled.length > 0 && filled.every((name) => state.openAreas.has(name));
  el.areasExpand.hidden = filled.length === 0;
  el.areasExpand.textContent = allOpen ? "전체 접기" : "전체 펼치기";

  for (const name of slots) {
    if (state.openAreas.has(name) && countOf(name) > 0) {
      el.areaViews.append(renderAreaView(name));
    }
  }
}

function renderAreaTile(name, count) {
  const isUnset = name === UNSET;
  const isOpen = state.openAreas.has(name);

  // 관찰이 있는 칸만 펼칠 수 있다. 0건은 펼쳐도 보여줄 게 없다.
  const tile = document.createElement(count > 0 ? "button" : "div");
  tile.className = "area";
  if (isUnset) tile.classList.add("area--unset");
  if (isOldArea(name)) tile.classList.add("area--old");
  if (count > 0) tile.classList.add("has-count");

  if (count > 0) {
    tile.type = "button";
    tile.classList.add("area--link");
    tile.setAttribute("aria-expanded", String(isOpen));
    tile.title = isOpen ? `${slotName(name)} 접기` : `${slotName(name)} 관찰 보기`;
    if (isOpen) tile.classList.add("is-open");
    tile.addEventListener("click", () => {
      if (isOpen) state.openAreas.delete(name);
      else state.openAreas.add(name);
      renderAreas();
    });
  }

  const label = document.createElement("span");
  label.className = "area__name";
  label.textContent = slotName(name);
  if (isOldArea(name)) label.append(oldTag());

  const value = document.createElement("span");
  value.className = "area__count";
  value.textContent = String(count);

  tile.append(label, value);
  return tile;
}

/** 펼친 칸의 관찰을 읽기 전용으로 보여준다. 고치는 일은 편집 화면에서. */
function renderAreaView(name) {
  const items = observationsOf(name);

  const section = document.createElement("section");
  section.className = "areaview";

  const head = document.createElement("div");
  head.className = "areaview__head";

  const title = document.createElement("span");
  title.className = "areaview__name";
  title.textContent = slotName(name);
  if (isOldArea(name)) {
    section.classList.add("areaview--old");
    title.append(oldTag());
  }

  const count = document.createElement("span");
  count.className = "areaview__count";
  count.textContent = `${items.length}건`;

  head.append(title, count);
  section.append(head);

  const list = document.createElement("ul");
  list.className = "areaview__list";

  const shown = state.areaShown.get(name) ?? AREA_STEP;
  for (const item of items.slice(0, shown)) {
    const li = document.createElement("li");
    li.className = "areaview__item";

    const date = document.createElement("div");
    date.className = "areaview__date";
    date.textContent = formatDate(item.obs_date);

    const body = document.createElement("div");

    const badge = sourceBadge(item);
    if (item.source || badge) {
      const tags = document.createElement("div");
      tags.className = "obs__tags";
      if (item.source) {
        const source = document.createElement("span");
        source.className = "tag";
        source.textContent = item.source;
        tags.append(source);
      }
      if (badge) tags.append(badge);
      body.append(tags);
    }

    const content = document.createElement("p");
    content.className = "areaview__content";
    // 관찰 내용은 사용자 입력이므로 textContent로만 넣는다
    content.textContent = item.content ?? "";
    body.append(content);

    li.append(date, body);
    list.append(li);
  }
  section.append(list);

  if (items.length > shown) {
    const more = button(`더 보기 (${items.length - shown}건 남음)`, "btn areaview__more", () => {
      state.areaShown.set(name, shown + AREA_STEP);
      renderAreas();
    });
    section.append(more);
  }

  // 미지정은 그냥 두면 안 되는 항목이라, 고치러 갈 길을 바로 옆에 둔다
  if (name === UNSET) {
    section.append(
      // 좁은 화면은 보기 전용이라 숨긴다(.areaview__goedit)
      button("편집 화면에서 영역 지정하기 →", "linkbtn areaview__goedit", goEdit),
    );
  }

  return section;
}

/* ---------- 날짜별 관찰 ---------- */

const OBS_STEP = 10;
const AREA_STEP = 15;

/** 날짜별 편집에 보일 관찰 — [미지정만 보기] 면 영역이 없는(또는 모르는 값인) 것만 */
function editableObservations() {
  return state.unsetOnly ? observationsOf(UNSET) : state.observations;
}

/** 목록 끝이 화면에 들어오면 10건 더 그린다 */
const obsEnd = typeof IntersectionObserver === "function"
  ? new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) showMoreObservations();
  }, { rootMargin: "200px 0px" })
  : null;

function showMoreObservations() {
  const rows = editableObservations();
  if (state.obsShown >= rows.length) return;
  const from = state.obsShown;
  state.obsShown += OBS_STEP;
  // 이미 그린 줄은 그대로 두고 뒤에만 붙인다 — 고르던 칸·스크롤이 흔들리지 않게
  for (const item of rows.slice(from, state.obsShown)) el.obs.append(renderObservation(item));
  syncObsMore(rows.length);
}

function syncObsMore(total) {
  const left = total - Math.min(state.obsShown, total);
  el.obsMoreBox.hidden = left <= 0;
  el.obsMore.textContent = `더 보기 (${left}건 남음)`;
  obsEnd?.disconnect();
  if (left > 0) obsEnd?.observe(el.obsMoreBox);
}

function syncUnsetToggle() {
  const unset = observationsOf(UNSET).length;
  el.obsUnsetOnly.setAttribute("aria-pressed", String(state.unsetOnly));
  el.obsUnsetOnly.classList.toggle("is-selected", state.unsetOnly);
  el.obsUnsetOnly.textContent = `미지정만 보기 ${unset}`;
  el.obsCount.textContent = state.observations.length ? `전체 ${state.observations.length}건` : "";
}

function renderObservations() {
  el.obs.replaceChildren();
  hideState(el.obsState);
  el.obsMoreBox.hidden = true;
  obsEnd?.disconnect();
  syncUnsetToggle();

  if (state.obsLoading) {
    showState(el.obsState, "불러오는 중…");
    return;
  }
  if (state.obsError) {
    showState(el.obsState, state.obsError, null, true);
    return;
  }
  if (state.observations.length === 0) {
    showState(
      el.obsState,
      "아직 관찰이 없어요.",
      "다른 기간을 선택하거나, 위의 [+ 관찰 직접 추가]로 기록할 수 있습니다.",
    );
    return;
  }

  const rows = editableObservations();
  if (rows.length === 0) {
    showState(el.obsState, "영역 미지정 관찰이 없어요.", "[미지정만 보기] 를 끄면 전체가 보입니다.");
    return;
  }
  for (const item of rows.slice(0, state.obsShown)) {
    el.obs.append(renderObservation(item));
  }
  syncObsMore(rows.length);
}

function renderObservation(item) {
  const li = document.createElement("li");
  li.className = "obs__item";
  li.dataset.id = item.id;
  if (state.flashId === item.id) li.classList.add("is-flash");

  const date = document.createElement("div");
  date.className = "obs__date";
  date.textContent = formatDate(item.obs_date);

  const main = document.createElement("div");
  main.className = "obs__main";
  main.append(renderTags(item));

  const editing = state.editing?.id === item.id ? state.editing.mode : null;
  if (editing === "content") {
    main.append(renderContentEditor(item));
  } else if (editing === "split") {
    main.append(renderSplitEditor(item));
  } else {
    const content = document.createElement("p");
    content.className = "obs__content";
    // 관찰 내용도 사용자 입력이므로 textContent로만 넣는다
    content.textContent = item.content ?? "";
    main.append(content, renderActions(item));

    // 같은 아동·같은 날짜·같은 원본 일지끼리만 합친다.
    // 직접 쓴 관찰(근거 없음)끼리도 날짜만 같으면 합칠 수 있다.
    attachMergeDrag(li, {
      id: item.id,
      key: `${item.obs_date} ${item.source_journal_id ?? "직접"}`,
      disabled: isTemp(item.id),
      onMerge: (fromId) => askMergeObservation(fromId, item),
    });
  }

  li.append(date, main);
  return li;
}

function renderTags(item) {
  const tags = document.createElement("div");
  tags.className = "obs__tags";

  // 영역은 타이핑이 아니라 고르게 한다. 지운 영역은 고를 수 없고, 그 영역인 관찰에만 회색으로 보인다.
  const select = document.createElement("select");
  select.setAttribute("aria-label", "영역");
  select.disabled = isTemp(item.id);

  fillOptions(select, areaOptions(item.area));
  select.value = isKnownArea(item.area) ? item.area : "";
  // 예전 영역은 목록 끝에 보이기만 한다(ui.fillOptions 는 disabled 를 모른다)
  if (isOldArea(item.area)) select.lastElementChild.disabled = true;
  paintAreaSelect(select, item);
  select.addEventListener("change", () => changeArea(item.id, select.value, select));
  tags.append(select);

  if (item.source) {
    const sourceTag = document.createElement("span");
    sourceTag.className = "tag";
    sourceTag.textContent = item.source;
    tags.append(sourceTag);
  }

  const badge = sourceBadge(item);
  if (badge) tags.append(badge);

  return tags;
}

function renderActions(item) {
  const actions = document.createElement("div");
  actions.className = "obs__actions";

  const edit = button("수정", "linkbtn", () => openEditor(item, "content"));
  const split = button("나누기", "linkbtn", () => openEditor(item, "split"));
  const del = button("삭제", "linkbtn linkbtn--danger", () => askDeleteObservation(item));
  edit.disabled = isTemp(item.id);
  split.disabled = isTemp(item.id);
  del.disabled = isTemp(item.id);

  actions.append(edit, split, del);
  return actions;
}

/**
 * 편집기 두 개는 일지 카드의 "추출된 관찰"과 생김새·동작이 같아야 한다.
 * 그래서 obs_edit.js 한 벌을 같이 쓰고, 여기서는 이 화면에만 있는 것
 * (새 관찰의 영역 고르기)만 얹는다.
 */
function renderContentEditor(item) {
  return buildContentEditor({
    value: state.draft.content,
    onInput: (value) => {
      state.draft.content = value;
    },
    onSave: () => saveContent(item.id),
    onCancel: closeEditorsAndRender,
  });
}

function renderSplitEditor(item) {
  const areaField = document.createElement("div");
  areaField.className = "field";

  const areaLabel = document.createElement("label");
  areaLabel.className = "field__label";
  areaLabel.textContent = "새 관찰의 영역";
  areaLabel.htmlFor = "split-area";

  const areaSelect = document.createElement("select");
  areaSelect.className = "input";
  areaSelect.id = "split-area";
  fillOptions(areaSelect, areaOptions());
  areaSelect.value = state.draft.newArea;
  areaSelect.addEventListener("change", () => {
    state.draft.newArea = areaSelect.value;
  });
  areaField.append(areaLabel, areaSelect);

  return buildSplitEditor({
    hint: "원글에서 떼어낼 부분을 잘라 아래에 붙여 넣으세요. " +
      `새 관찰은 같은 날짜(${formatDate(item.obs_date)})로 추가됩니다.`,
    keepValue: state.draft.content,
    newValue: state.draft.newContent,
    onKeepInput: (value) => {
      state.draft.content = value;
    },
    onNewInput: (value) => {
      state.draft.newContent = value;
    },
    extraField: areaField,
    onSave: () => saveSplit(item.id),
    onCancel: closeEditorsAndRender,
  });
}

/* ---------- 편집 열고 닫기 ---------- */

function openEditor(item, mode) {
  state.editing = { id: item.id, mode };
  state.draft = { content: item.content ?? "", newContent: "", newArea: "" };
  renderObservations();
}

function closeEditors() {
  state.editing = null;
  state.draft = { content: "", newContent: "", newArea: "" };
}

function closeEditorsAndRender() {
  closeEditors();
  renderObservations();
}

/* ---------- 관찰 변경 (낙관적 갱신) ---------- */

function isTemp(id) {
  return String(id).startsWith("temp-");
}

function snapshot() {
  return state.observations.map((item) => ({ ...item }));
}

function restore(saved) {
  state.observations = saved;
  renderDetail();
}

function replaceItem(next) {
  const index = state.observations.findIndex((item) => item.id === next.id);
  if (index >= 0) state.observations[index] = next;
}

/** 날짜순으로 다시 정렬한다. 같은 날짜면 원래 순서를 지킨다(정렬이 안정적임). */
function sortObservations() {
  state.observations.sort((a, b) =>
    a.obs_date < b.obs_date ? -1 : a.obs_date > b.obs_date ? 1 : 0
  );
}

/**
 * 영역 지정.
 *
 * [예전에 "미지정으로 되돌아가던" 까닭]
 * 저장 하나가 끝나기 전에는 다른 줄의 영역 고르기를 통째로 무시했다(state.pending).
 * 그런데 고르기 칸은 이미 새 값을 보여 주고 있어서, 앞 저장이 끝나 목록을 다시 그리는 순간
 * 무시된 줄이 "미지정" 으로 돌아갔다 — 위에서부터 차례로 빠르게 고를 때 늘 났다.
 * 목록을 통째로 다시 그리는 것도 줄이 많을수록 느려 저장이 굼떠 보였다.
 *
 * 이제 줄마다 따로 저장하고(같은 줄을 연달아 바꾸면 마지막 것만 반영), 목록은 다시 그리지 않는다.
 * 영역 칸 건수·평가의 근거 수만 새로 센다.
 */
async function changeArea(id, value, select) {
  const area = value || null;
  const item = state.observations.find((o) => o.id === id);
  if (!item || item.area === area) return;

  const before = item.area;
  const seq = (state.areaSeq.get(id) ?? 0) + 1;
  state.areaSeq.set(id, seq);
  item.area = area;
  paintAreaSelect(select, item);
  renderAreas();
  renderEvaluation();
  syncUnsetToggle();

  try {
    const { observation } = await send(`/api/observations/${id}/area`, "PATCH", { area });
    if (state.areaSeq.get(id) !== seq) return; // 그 사이 같은 줄을 또 바꿨다
    replaceItem(observation);
    toast(area ? `영역을 ${areaName(area)}${ro(areaName(area))} 지정했습니다` : "영역을 미지정으로 되돌렸습니다");
  } catch (error) {
    if (state.areaSeq.get(id) !== seq) return;
    const current = state.observations.find((o) => o.id === id);
    if (current) {
      current.area = before;
      if (select?.isConnected) select.value = isKnownArea(before) ? before : "";
      paintAreaSelect(select, current);
    }
    renderAreas();
    renderEvaluation();
    syncUnsetToggle();
    toast(error.message, true);
  }
}

function paintAreaSelect(select, item) {
  if (!select) return;
  select.className = isActiveArea(item.area)
    ? "areasel"
    : isOldArea(item.area)
    ? "areasel areasel--old"
    : "areasel areasel--unset";
}

/** 고르는 칸의 목록 — 미지정 + 지금 쓰는 영역. 지금 값이 예전 영역이면 그것도(고를 수는 없게) */
function areaOptions(current = null) {
  const options = [
    { value: "", label: "영역 미지정" },
    ...activeObsAreas().map((area) => ({ value: area.code, label: area.name })),
  ];
  if (isOldArea(current)) {
    options.push({ value: current, label: `${areaName(current)} (예전 영역)`, disabled: true });
  }
  return options;
}

function oldTag() {
  const tag = document.createElement("span");
  tag.className = "tag area__old";
  tag.textContent = "예전 영역";
  return tag;
}

async function saveContent(id) {
  if (state.pending) return;
  const content = state.draft.content.trim();
  if (!content) {
    toast("내용을 입력해 주세요.", true);
    return;
  }

  const item = state.observations.find((o) => o.id === id);
  if (!item) return;

  const saved = snapshot();
  state.pending = true;
  item.content = content;
  closeEditors();
  renderDetail();

  try {
    const { observation } = await send(`/api/observations/${id}/content`, "PATCH", { content });
    replaceItem(observation);
    renderDetail();
    toast("저장되었습니다");
  } catch (error) {
    restore(saved);
    toast(error.message, true);
  } finally {
    state.pending = false;
  }
}

async function saveSplit(id) {
  if (state.pending) return;
  const originalContent = state.draft.content.trim();
  const newContent = state.draft.newContent.trim();
  const newArea = state.draft.newArea || null;

  if (!originalContent || !newContent) {
    toast("원본 내용과 새 관찰 내용을 모두 입력해 주세요.", true);
    return;
  }

  const item = state.observations.find((o) => o.id === id);
  if (!item) return;

  const saved = snapshot();
  const tempId = `temp-${crypto.randomUUID()}`;

  state.pending = true;
  item.content = originalContent;
  state.observations.push({
    id: tempId,
    obs_date: item.obs_date,
    area: newArea,
    content: newContent,
    source: item.source,
  });
  sortObservations();
  closeEditors();
  renderDetail();

  try {
    const { original, created } = await send(`/api/observations/${id}/split`, "POST", {
      original_content: originalContent,
      new_content: newContent,
      new_area: newArea,
    });
    replaceItem(original);
    const index = state.observations.findIndex((o) => o.id === tempId);
    if (index >= 0) state.observations[index] = created;
    sortObservations();
    renderDetail();
    toast("관찰을 나눴습니다");
  } catch (error) {
    restore(saved);
    toast(error.message, true);
  } finally {
    state.pending = false;
  }
}

/* ---------- 관찰 합치기 (끌어서) ---------- */

/**
 * 끌어온 관찰(from)을 놓인 관찰(to)에 합친다.
 *
 * 근거(어느 후보에서 왔는지)는 하나만 남는다 — 한 후보는 한 번만 가져올 수 있어서다.
 * 둘 다 근거를 들고 있으면 사라지는 쪽의 후보는 "가져옴"이 풀려 다시 가져올 수 있게 된다.
 * 그 사실을 확인창에서 먼저 알린다. 모르고 합치면 [관찰 가져오기] 목록에 왜 다시 나타나는지 알 수 없다.
 */
async function askMergeObservation(fromId, to) {
  if (state.pending) return;

  const from = state.observations.find((item) => item.id === fromId);
  if (!from) return;

  const notes = [];
  if (from.source_status && to.source_status) {
    notes.push(
      "",
      "두 관찰 모두 [관찰 가져오기]로 들어온 것입니다. 근거는 하나만 남습니다.",
      "사라지는 쪽의 추출 관찰은 다시 가져올 수 있게 됩니다.",
    );
  } else if (from.source_status && !to.source_status) {
    notes.push("", "끌어온 관찰의 근거(원본 일지)를 합쳐진 쪽이 이어받습니다.");
  }

  const content = await confirmMerge({
    keepText: to.content,
    fromText: from.content,
    notes,
  });
  if (content) await mergeObservation(fromId, to, content);
}

async function mergeObservation(fromId, to, content) {
  const saved = snapshot();

  state.pending = true;
  state.observations = state.observations.filter((item) => item.id !== fromId);
  const keep = state.observations.find((item) => item.id === to.id);
  if (keep) keep.content = content;
  closeEditors();
  renderDetail();

  try {
    const payload = await send(`/api/observations/${to.id}/merge`, "POST", {
      from: fromId,
      content,
    });
    replaceItem(payload.observation);
    renderDetail();
    toast(
      payload.released
        ? "합쳤습니다 · 사라진 쪽의 추출 관찰은 다시 가져올 수 있습니다"
        : "두 관찰을 합쳤습니다",
    );
  } catch (error) {
    restore(saved);
    toast(error.message, true);
  } finally {
    state.pending = false;
  }
}

async function submitAdd(event) {
  event.preventDefault();
  if (state.pending || !state.child) return;

  const obsDate = el.addDate.value;
  const content = el.addContent.value.trim();
  const area = el.addArea.value || null;
  const source = el.addSource.value || null;

  if (!obsDate) {
    toast("날짜를 선택해 주세요.", true);
    return;
  }
  if (!content) {
    toast("관찰 내용을 입력해 주세요.", true);
    return;
  }

  const saved = snapshot();
  const inRange = isInCurrentRange(obsDate);
  const tempId = `temp-${crypto.randomUUID()}`;

  state.pending = true;
  el.addSubmit.disabled = true;

  // 보고 있는 기간 밖의 날짜면 목록에 넣지 않는다. 넣으면 기간 필터와 어긋난다.
  if (inRange) {
    state.observations.push({ id: tempId, obs_date: obsDate, area, content, source });
    sortObservations();
    renderDetail();
  }

  try {
    const { observation } = await send("/api/observations", "POST", {
      child_id: state.child.id,
      obs_date: obsDate,
      area,
      content,
      source,
    });

    if (inRange) {
      const index = state.observations.findIndex((o) => o.id === tempId);
      if (index >= 0) state.observations[index] = observation;
      sortObservations();
      renderDetail();
      toast("추가되었습니다");
    } else {
      toast(`추가되었습니다. ${obsDate}는 지금 보는 기간이 아니라 목록에 보이지 않습니다.`);
    }
    closeAddForm();
  } catch (error) {
    if (inRange) restore(saved);
    toast(error.message, true);
  } finally {
    state.pending = false;
    el.addSubmit.disabled = false;
  }
}

/* ---------- 관찰 추가 폼 ---------- */

function openAddForm() {
  el.addForm.hidden = false;
  el.addOpen.hidden = true;

  // 오늘이 지금 보는 기간 안이면 오늘로, 아니면 그 기간의 첫날로 맞춘다
  const { from, to } = rangeOf(state.year, state.half);
  const today = todayISO();
  el.addDate.value = isInCurrentRange(today) ? today : from;
  el.addDate.min = from;
  el.addDate.max = to;

  el.addArea.value = "";
  el.addSource.value = "";
  el.addContent.value = "";
  el.addContent.focus();
}

function closeAddForm() {
  el.addForm.hidden = true;
  el.addOpen.hidden = false;
  el.addContent.value = "";
}

/* ---------- 이벤트 ---------- */

for (const chip of el.statusChips) {
  chip.addEventListener("click", () => {
    state.status = chip.dataset.status;
    pager().reset();
    for (const other of el.statusChips) {
      other.classList.toggle("is-selected", other === chip);
    }
    renderList();
  });
}

for (const chip of el.halfChips) {
  chip.addEventListener("click", () => {
    const half = Number(chip.dataset.half);
    if (state.half === half) return;
    state.half = half;
    closeEditors();
    closeAddForm();
    syncPeriodChips();
    loadObservations();
    loadEvaluation();
  });
}

el.search.addEventListener("input", () => {
  state.query = el.search.value;
  pager().reset();
  renderList();
});

el.back.addEventListener("click", () => closeDetail({ restore: true }));
el.addOpen.addEventListener("click", openAddForm);
el.addCancel.addEventListener("click", closeAddForm);
el.addForm.addEventListener("submit", submitAdd);

fillOptions(el.addArea, areaOptions());

// 영역 목록을 받거나(처음) 관리자가 고치면 고르는 칸·영역 칸을 다시 그린다
onObsAreasChange(() => {
  const picked = el.addArea.value;
  fillOptions(el.addArea, areaOptions());
  el.addArea.value = isActiveArea(picked) ? picked : "";
  if (state.child) renderDetail();
});
loadObsAreas();
fillOptions(el.addSource, [{ value: "", label: "출처 없음" }, ...SOURCES.map(toOption)]);

/* ---------- 일지에서 관찰 가져오기 ---------- */

/**
 * 일지에서 뽑힌 관찰 후보를 골라 아동 관찰로 옮긴다.
 *
 * 이미 가져간 것도 목록에 남기고 "가져옴"으로 표시한다.
 * 목록에서 지워 버리면 왜 안 보이는지 알 수 없고,
 * 같은 내용을 또 가져오려다 막히는 이유도 알 수 없다.
 */
async function openImport() {
  if (!state.child) return;

  el.importModal.hidden = false;
  state.importItems = [];
  state.importChecked = new Set();
  state.importError = null;
  state.importLoading = true;
  renderImport();

  try {
    const payload = await get(`/api/children/${state.child.id}/importable`);
    state.importItems = payload.items ?? [];
  } catch (error) {
    state.importError = error.message;
  } finally {
    state.importLoading = false;
    renderImport();
  }
}

function closeImport() {
  el.importModal.hidden = true;
  state.importItems = [];
  state.importChecked = new Set();
  state.importError = null;
}

/**
 * 고를 수 있는 후보 — 이미 가져간 것도, 다른 관찰에 합쳐진 것도 고를 수 없다.
 * 합쳐진 것을 다시 가져오면 방금 합친 내용이 두 번 들어간다.
 */
function pickableImports() {
  return state.importItems.filter((item) => !item.imported && !item.merged);
}

function renderImport() {
  el.importList.replaceChildren();
  hideState(el.importState);

  const pickable = pickableImports();
  el.importSubmit.disabled = state.importPending || state.importChecked.size === 0;
  el.importAll.hidden = pickable.length === 0;
  // 버튼 글자는 그릴 때마다 지금 선택으로 정한다 — 누를 때만 바꾸면 창을 다시 열 때(선택은 비었는데)
  // "전체 해제" 가 남아 뒤집힌다. 고를 수 있는 것이 모두 골라졌을 때만 [전체 해제].
  const allChecked = pickable.length > 0 && pickable.every((item) => state.importChecked.has(item.id));
  el.importAll.textContent = allChecked ? "전체 해제" : "전체 선택";

  if (state.importLoading) {
    showState(el.importState, "불러오는 중…");
    return;
  }
  if (state.importError) {
    showState(el.importState, state.importError, null, true);
    return;
  }
  if (state.importItems.length === 0) {
    showState(
      el.importState,
      "가져올 새 관찰이 없어요.",
      "일지를 저장하면 그 일지에서 관찰이 뽑혀 여기에 모입니다.",
    );
    return;
  }
  if (pickable.length === 0) {
    showState(el.importState, "관찰 가져오기를 할 새 후보가 없어요.", "아래는 이미 가져온 것들입니다.");
  }

  for (const item of state.importItems) {
    el.importList.append(renderImportItem(item));
  }
}

function renderImportItem(item) {
  const row = document.createElement("label");
  const locked = item.imported || item.merged;
  row.className = locked ? "importrow is-imported" : "importrow";

  if (locked) row.title = item.merged ? "다른 관찰에 합쳐져 고를 수 없습니다" : "이미 가져온 관찰이라 고를 수 없습니다";

  const check = document.createElement("input");
  check.type = "checkbox";
  check.className = "importrow__check";
  check.checked = state.importChecked.has(item.id);
  check.disabled = locked || state.importPending;
  check.addEventListener("change", () => {
    if (check.checked) state.importChecked.add(item.id);
    else state.importChecked.delete(item.id);
    renderImport();
  });

  const body = document.createElement("div");
  body.className = "importrow__body";

  const tags = document.createElement("div");
  tags.className = "obs__tags";

  const date = document.createElement("span");
  date.className = "tag";
  date.textContent = formatDate(item.journal_date);

  const kind = document.createElement("span");
  kind.className = "tag";
  kind.textContent = `${item.journal_kind} 일지`;

  tags.append(date, kind);

  if (item.journal_title) {
    const title = document.createElement("span");
    title.className = "tag";
    // 일지 제목은 사용자 입력이므로 textContent로만 넣는다
    title.textContent = item.journal_title;
    tags.append(title);
  }
  if (item.imported) {
    const done = document.createElement("span");
    done.className = "tag tag--area";
    done.textContent = "가져옴";
    tags.append(done);
  }
  if (item.merged) {
    const merged = document.createElement("span");
    merged.className = "tag tag--gone";
    merged.textContent = "합쳐짐";
    explain(merged, "이 관찰은 다른 관찰에 합쳐졌습니다. 다시 가져오면 같은 내용이 두 번 들어갑니다.");
    tags.append(merged);
  }

  const content = document.createElement("p");
  content.className = "importrow__content";
  content.textContent = item.content ?? "";

  body.append(tags, content);
  row.append(check, body);
  return row;
}

function toggleImportAll() {
  const pickable = pickableImports();
  const allChecked = pickable.length > 0 && pickable.every((i) => state.importChecked.has(i.id));

  state.importChecked = allChecked ? new Set() : new Set(pickable.map((i) => i.id));
  renderImport();
}

async function submitImport() {
  if (state.importPending || !state.child) return;
  const ids = [...state.importChecked];
  if (ids.length === 0) return;

  state.importPending = true;
  el.importSubmit.disabled = true;

  try {
    const result = await send("/api/observations/import", "POST", {
      child_id: state.child.id,
      ids,
    });

    closeImport();
    toast(
      result.skipped > 0
        ? `관찰 가져오기 ${result.imported}건 — ${result.skipped}건은 이미 가져온 것이라 건너뛰었습니다.`
        : `관찰 가져오기 ${result.imported}건 완료`,
    );

    // 가져온 관찰은 원본 일지 날짜로 들어가므로 보고 있는 기간 밖일 수 있다.
    // (뱃지 수도 loadObservations 가 다시 센다)
    // 서버에서 다시 읽어야 지금 기간에 맞는 것만 정확히 보인다.
    await loadObservations();
  } catch (error) {
    toast(error.message, true);
  } finally {
    state.importPending = false;
    renderImport();
  }
}

el.importOpen.addEventListener("click", openImport);
el.importCancel.addEventListener("click", closeImport);
el.importAll.addEventListener("click", toggleImportAll);
el.importSubmit.addEventListener("click", submitImport);

/* ---------- 보기 / 편집 화면 전환 ---------- */

/**
 * 관찰을 만지는 일은 모두 편집 화면에서 한다.
 * 보기 화면은 읽기만 하므로, 실수로 값이 바뀌는 일이 없다.
 */
function goEdit() {
  state.mode = "edit";
  el.detailView.hidden = true;
  el.detailEdit.hidden = false;
  renderObservations();
  el.goView.focus();
}

function goView() {
  state.mode = "view";
  closeEditors();
  closeAddForm();
  el.detailEdit.hidden = true;
  el.detailView.hidden = false;
  // 편집 화면에서 바꾼 것(영역 지정 등)이 영역별 보기에 반영돼야 한다
  renderDetail();
  el.goEdit.focus();
}

/** 관찰이 있는 칸을 한꺼번에 펼치거나 접는다 */
function toggleAllAreas() {
  const { counts, unset } = areaCounts();
  const filled = areaSlots().filter((name) => (name === UNSET ? unset : counts.get(name) ?? 0) > 0);
  const allOpen = filled.length > 0 && filled.every((name) => state.openAreas.has(name));

  state.openAreas = allOpen ? new Set() : new Set(filled);
  renderAreas();
}

el.goEdit.addEventListener("click", goEdit);
el.goView.addEventListener("click", goView);
el.areasExpand.addEventListener("click", toggleAllAreas);
el.areasPrint.addEventListener("click", () => {
  if (!state.child) return;
  openPrint({ kind: "observations", child: state.child.id, year: state.year, half: state.half });
});
el.importBackdrop.addEventListener("click", closeImport);

// 모달이 열려 있을 때 Esc로 닫는다
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !el.importModal.hidden) closeImport();
});

// 연간 평가 카드는 보고 있는 아동·기간·관찰을 children.js 에서 받아 쓴다.
// 값을 넘겨 주는 대신 함수를 넘겨, 그릴 때마다 최신 상태를 읽게 한다.
initEvaluation(() => ({
  child: state.child,
  year: state.year,
  half: state.half,
  observations: state.observations,
}));

/* ---------- 관찰 삭제 ---------- */

async function askDeleteObservation(item) {
  if (state.pending) return;

  const lines = [
    item.content,
    "",
    "이 관찰을 지우면 되돌릴 수 없습니다.",
  ];
  // 가져온 관찰이면 후보가 남아 다시 가져올 수 있다는 점을 알린다.
  // 모르면 "지우면 영영 사라진다"고 생각해 지우기를 망설이게 된다.
  if (item.source_status) {
    lines.push("", "[관찰 가져오기]로 들어온 관찰입니다. 지우면 [일지에서 관찰 가져오기] 목록에 다시 나타납니다.");
  }

  const yes = await confirmDialog({
    title: "관찰을 삭제할까요?",
    message: lines.join("\n"),
    confirmText: "삭제",
  });
  if (yes) await deleteObservation(item);
}

async function deleteObservation(item) {
  const saved = snapshot();

  state.pending = true;
  state.observations = state.observations.filter((row) => row.id !== item.id);
  closeEditors();
  renderDetail();

  try {
    await remove(`/api/observations/${item.id}`);
    toast("관찰을 삭제했습니다");
  } catch (error) {
    restore(saved);
    toast(error.message, true);
  } finally {
    state.pending = false;
  }
}

/* ---------- 아동 정보 카드 · 등록 · 수정 · 삭제 ---------- */

/*
 * ★ 민감정보
 * 이 블록이 다루는 보호자 연락처·주소·의뢰배경은 명단에 없다.
 * 상세를 열 때 GET /api/children/:id 로 그때만 받고, 상세를 닫으면 버린다.
 * 로그인이 생기면 loadChildInfo 와 등록·수정 화면을 관리자만 쓰게 거는 자리다.
 */

/** 서버(/db/children.ts)의 목록과 같아야 한다. */
const CHILD_STATUSES = ["재원", "종결"];


/** 종결이 무엇을 하는지 — 남는 것·옮겨지는 것·지워지는 것(없음). 삭제 확인창과 수정 화면이 같은 글을 쓴다 */
const CLOSE_EXPLAIN = "종결 처리하면: 아동은 명단의 '종결'로 이동하고, 지금까지의 일지·관찰·평가 기록은 모두 보관됩니다. " +
  "삭제되는 것은 없습니다.";
const GENDERS = ["남", "여"];

const elc = {
  addOpen: document.getElementById("child-add-open"),

  info: document.getElementById("child-info"),
  infoToggle: document.getElementById("child-info-toggle"),
  infoBrief: document.getElementById("child-info-brief"),
  infoBriefNarrow: document.getElementById("child-info-brief-narrow"),
  infoFull: document.getElementById("child-info-full"),
  infoEdit: document.getElementById("child-info-edit"),
  infoDelete: document.getElementById("child-info-delete"),

  viewForm: document.getElementById("view-child-form"),
  formBack: document.getElementById("child-form-back"),
  heading: document.getElementById("child-form-heading"),
  sub: document.getElementById("child-form-sub"),
  closeHint: document.getElementById("child-close-hint"),
  form: document.getElementById("child-form"),
  name: document.getElementById("child-name"),
  birth: document.getElementById("child-birth"),
  gradeHint: document.getElementById("child-grade-hint"),
  gender: document.getElementById("child-gender"),
  school: document.getElementById("child-school"),
  enroll: document.getElementById("child-enroll"),
  status: document.getElementById("child-status"),
  exitField: document.getElementById("child-exit-field"),
  exit: document.getElementById("child-exit"),
  consent: document.getElementById("child-consent"),
  guardianRelation: document.getElementById("child-guardian-relation"),
  guardianContact: document.getElementById("child-guardian-contact"),
  address: document.getElementById("child-address"),
  referral: document.getElementById("child-referral"),
  submit: document.getElementById("child-submit"),
  cancel: document.getElementById("child-cancel"),
};

/** 지금 열린 아동의 전체 정보 (★ 민감). 상세를 열 때 받고, 닫으면 null. */
let childDetail = null;
let infoOpen = false;

/** 폼 상태. 돌아갈 곳(list | detail)을 기억한다. */
let formMode = null; // null | "create" | "edit"
let formReturnTo = "list";
let formPending = false;
/** 폼을 연 순간의 값 — 취소할 때 고친 것이 있는지 견준다 */
let formInitial = "";

/* ---------- 상세 머리글 ---------- */

/** 이름·학년·성별·상태 한 줄. 수정 뒤에도 다시 그린다. */
function renderDetailHead(child) {
  el.detailName.textContent = child.name ?? "-";
  const parts = [gradeLabel(child.birth_date), child.gender, child.status].filter(Boolean);
  el.detailMeta.textContent = parts.join(" · ");
}

/* ---------- 아동 정보 카드 ---------- */

async function loadChildInfo(child) {
  childDetail = null;
  infoOpen = false;
  renderChildInfo();

  try {
    const payload = await get(`/api/children/${child.id}`);
    childDetail = payload.child ?? null;
  } catch (error) {
    console.error("[loadChildInfo]", error);
    toast(error.message, true);
  }
  renderChildInfo();
}

function infoRow(label, value) {
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  // 모두 사용자 입력이므로 textContent로만 넣는다
  dd.textContent = value ?? "-";
  return [dt, dd];
}

function renderChildInfo() {
  const d = childDetail;
  elc.infoToggle.setAttribute("aria-expanded", String(infoOpen));
  elc.infoToggle.querySelector(".resgroup__mark").textContent = infoOpen ? "▾" : "▸";
  elc.infoFull.hidden = !infoOpen;
  elc.infoEdit.disabled = !d;
  elc.infoDelete.disabled = !d;

  if (!d) {
    elc.infoBrief.textContent = "불러오는 중…";
    elc.infoBriefNarrow.textContent = "불러오는 중…";
    elc.infoFull.replaceChildren();
    return;
  }

  // 접힌 한 줄: 학교 · 입소일 · 상태. 민감한 것은 여기 안 나온다.
  elc.infoBrief.textContent = [
    d.school,
    d.enroll_date ? `입소 ${d.enroll_date}` : null,
    d.status,
  ].filter(Boolean).join(" · ") || "정보 없음";
  // 좁은 화면의 접힌 한 줄은 더 짧게 — 학년 · 상태
  elc.infoBriefNarrow.textContent = [
    d.birth_date ? gradeLabel(d.birth_date) : null,
    d.status,
  ].filter(Boolean).join(" · ") || "정보 없음";

  const rows = [
    ...infoRow("생년월일", d.birth_date ? `${d.birth_date} (${gradeLabel(d.birth_date)})` : null),
    ...infoRow("성별", d.gender),
    ...infoRow("학교", d.school),
    ...infoRow("입소일", d.enroll_date),
    ...infoRow("종결일", d.exit_date),
    ...infoRow("상태", d.status),
    ...infoRow("동의서 받은 날", d.consent_date),
    ...infoRow("보호자 관계", d.guardian_relation),
    ...infoRow("보호자 연락처", d.guardian_contact),
    ...infoRow("주소", d.address),
    ...infoRow("의뢰배경", d.referral_note),
  ];
  elc.infoFull.replaceChildren(...rows);
}

elc.infoToggle.addEventListener("click", () => {
  infoOpen = !infoOpen;
  renderChildInfo();
});

/* ---------- 등록 · 수정 화면 ---------- */

function syncExitField() {
  elc.exitField.hidden = elc.status.value !== "종결";
  elc.closeHint.hidden = elc.status.value !== "종결";
}

function syncGradeHint() {
  const label = gradeLabel(elc.birth.value);
  elc.gradeHint.textContent = elc.birth.value ? `학년: ${label}` : "";
}

/**
 * 폼을 연다.
 *   create        빈 폼. 입소일은 오늘.
 *   edit + child  채운 폼. preset 이 있으면 그 값으로 덮는다 (삭제 대신 종결로 갈 때).
 */
function openChildForm(mode, child = null, preset = {}) {
  formMode = mode;
  formReturnTo = child ? "detail" : "list";

  const d = { ...(child ?? {}), ...preset };
  elc.heading.textContent = mode === "edit" ? `${child.name} 수정` : "아동 등록";
  elc.sub.textContent = mode === "edit"
    ? "보호자 연락처·주소는 명단에는 안 보이고, 이 화면과 상세 화면에서만 보입니다. 그만둔 아동은 상태를 '종결'로 바꿔 저장하세요."
    : "이름·생년월일·입소일은 꼭 넣어 주세요.";

  elc.name.value = d.name ?? "";
  elc.birth.value = d.birth_date ?? "";
  elc.gender.value = d.gender ?? "";
  elc.school.value = d.school ?? "";
  elc.enroll.value = d.enroll_date ?? todayISO();
  elc.status.value = d.status ?? "재원";
  elc.exit.value = d.exit_date ?? "";
  elc.consent.value = d.consent_date ?? "";
  elc.consent.max = todayISO();
  elc.guardianRelation.value = d.guardian_relation ?? "";
  elc.guardianContact.value = d.guardian_contact ?? "";
  elc.address.value = d.address ?? "";
  elc.referral.value = d.referral_note ?? "";
  syncExitField();
  syncGradeHint();

  el.viewList.hidden = true;
  el.viewDetail.hidden = true;
  elc.viewForm.hidden = false;
  formInitial = JSON.stringify(readChildForm());
  elc.name.focus();
}

/** [취소]·[←] — 고친 것이 있으면 버릴지 먼저 묻는다(상태만 바꾼 것도 고친 것) */
async function askCloseChildForm() {
  if (formPending) return;
  if (JSON.stringify(readChildForm()) !== formInitial) {
    const yes = await confirmDialog({
      title: "고친 내용을 버릴까요?",
      message: "저장하지 않은 입력이 사라집니다. 남기려면 [계속 작성] 후 [저장] 을 눌러 주세요.",
      confirmText: "버리기",
      cancelText: "계속 작성",
    });
    if (!yes) return;
  }
  closeChildForm();
}

/** 폼을 닫고 왔던 곳으로(저장 뒤, 또는 버리기로 정한 뒤). */
function closeChildForm() {
  formMode = null;
  elc.viewForm.hidden = true;
  if (formReturnTo === "detail" && state.child) {
    el.viewDetail.hidden = false;
  } else {
    showListFresh();
  }
}

function readChildForm() {
  const text = (node) => node.value.trim() || null;
  return {
    name: elc.name.value.trim(),
    birth_date: elc.birth.value || null,
    gender: elc.gender.value || null,
    school: text(elc.school),
    enroll_date: elc.enroll.value || null,
    status: elc.status.value,
    exit_date: elc.status.value === "종결" ? elc.exit.value || null : null,
    consent_date: elc.consent.value || null,
    guardian_relation: text(elc.guardianRelation),
    guardian_contact: text(elc.guardianContact),
    address: text(elc.address),
    referral_note: text(elc.referral),
  };
}

/** 서버도 같은 것을 본다. 여기서는 왕복 전에 빨리 알리는 것뿐이다. */
function checkChildForm(child) {
  if (!child.name) return "이름을 입력해 주세요.";
  if (!child.birth_date) return "생년월일을 입력해 주세요.";
  if (!child.enroll_date) return "입소일을 입력해 주세요.";
  if (child.status === "종결" && !child.exit_date) return "종결 처리하려면 종결일을 입력해 주세요.";
  if (child.exit_date && child.exit_date < child.enroll_date) return "종결일은 입소일보다 앞설 수 없습니다.";
  return null;
}

async function submitChildForm(event) {
  event.preventDefault();
  if (formPending) return;

  const child = readChildForm();
  const problem = checkChildForm(child);
  if (problem) {
    toast(problem, true);
    return;
  }

  formPending = true;
  elc.submit.disabled = true;

  try {
    if (formMode === "edit") {
      const target = state.child;
      const payload = await send(`/api/children/${target.id}`, "PATCH", child);
      const saved = payload.child;
      // 명단에 보이는 값이 바뀌었다 — 상세에서 돌아갈 때 처음부터(보던 위치로 되돌리지 않음)
      listSpot.dirty = true;

      // 명단·상세 머리글·정보 카드가 모두 새 값을 봐야 한다
      const index = state.children.findIndex((item) => item.id === target.id);
      if (index >= 0) {
        state.children[index] = {
          id: saved.id,
          name: saved.name,
          birth_date: saved.birth_date,
          gender: saved.gender,
          status: saved.status,
          enroll_date: saved.enroll_date,
          exit_date: saved.exit_date,
        };
      }
      state.child = index >= 0 ? state.children[index] : state.child;
      // 이름·생년월일이 바뀌면 자리도 바뀐다(학년순 → 가나다)
      state.children.sort(compareChildren);
      childDetail = saved;
      renderDetailHead(state.child);
      renderChildInfo();
      renderList();

      closeChildForm();
      toast("저장되었습니다");
    } else {
      const payload = await send("/api/children", "POST", child);
      const saved = payload.child;
      state.children.push({
        id: saved.id,
        name: saved.name,
        birth_date: saved.birth_date,
        gender: saved.gender,
        status: saved.status,
        enroll_date: saved.enroll_date,
        exit_date: saved.exit_date,
      });
      state.children.sort(compareChildren);
      renderList();

      closeChildForm();
      toast(`${saved.name} 등록되었습니다`);
    }
  } catch (error) {
    // 폼은 그대로 열려 있다. 입력값이 남아 있어 고쳐서 다시 저장할 수 있다.
    toast(error.message, true);
  } finally {
    formPending = false;
    elc.submit.disabled = false;
  }
}

/* ---------- 삭제 (여러 겹) ---------- */

/**
 * 아동 삭제. 딸린 기록이 함께 사라지므로 가장 조심한다.
 *
 *   1) 건수를 세어 보여주고, 삭제 대신 종결로 가는 길을 나란히 둔다.
 *   2) 딸린 기록이 있으면 이름을 직접 쳐야 지워진다.
 *   3) 서버가 순서대로 지우고 건수를 돌려준다.
 *
 * 딸린 기록이 없으면 2)는 건너뛴다. 잃을 것이 없는데 두 번 묻는 것은 형식이 된다.
 */
async function askDeleteChild() {
  const child = state.child;
  if (!child || !childDetail) return;

  // 건수를 못 세면 "0건"이 아니라 "모름"이다. 모르면 이름 관문을 반드시 거친다.
  let counts = null;
  try {
    counts = (await get(`/api/children/${child.id}/records-count`)).counts ?? null;
  } catch (error) {
    console.error("[askDeleteChild]", error);
  }
  const total = counts
    ? counts.observations + counts.evaluations + (counts.half_observations ?? 0) +
      counts.journal_observations
    : null;

  const lines = [
    `${child.name} 아동을 삭제할까요?`,
    counts
      ? `이 아동의 관찰 ${counts.observations}건, 연간평가 ${counts.evaluations}건, ` +
        // 반기 관찰은 숨긴 기능이지만 기록이 있으면 함께 지워진다 — 있을 때만 알린다
        (counts.half_observations ? `반기 관찰(지금은 쓰지 않는 기능) ${counts.half_observations}건, ` : "") +
        `일지에서 추출된 관찰 ${counts.journal_observations}건이 함께 삭제됩니다.`
      : "딸린 기록 수를 확인하지 못했습니다. 관찰·평가·일지관찰(과 예전 반기 관찰)이 있다면 함께 삭제됩니다.",
    "되돌릴 수 없습니다.",
  ];
  if (childDetail.status === "재원") {
    lines.push("", "※ 아동이 그만둔 경우엔 삭제 대신 [종결로 변경] 을 권합니다.", CLOSE_EXPLAIN);
  }

  const choices = [];
  if (childDetail.status === "재원") {
    choices.push({ label: "종결로 변경", value: "close", kind: "primary" });
  }
  choices.push({ label: "삭제 진행", value: "delete", kind: "danger" });

  const choice = await chooseDialog({ title: "아동 삭제", message: lines.join("\n"), choices });

  if (choice === "close") {
    // 종결로 가는 길: 수정 화면을 종결 + 오늘로 채워 연다. 저장은 사람이 한다.
    openChildForm("edit", childDetail, { status: "종결", exit_date: todayISO() });
    return;
  }
  if (choice !== "delete") return;

  if (total === null || total > 0) {
    const sure = await typeToConfirm({
      title: "정말 삭제할까요?",
      message: total === null
        ? "딸린 기록 수를 알 수 없습니다. 있다면 함께 사라집니다."
        : `관련 기록 ${total}건이 함께 사라집니다.`,
      expected: child.name,
    });
    if (!sure) return;
  }

  await deleteChild(child);
}

async function deleteChild(child) {
  elc.infoDelete.disabled = true;
  try {
    const payload = await remove(`/api/children/${child.id}`);
    const d = payload.deleted ?? {};
    const total = (d.observations ?? 0) + (d.evaluations ?? 0) + (d.half_observations ?? 0) +
      (d.journal_observations ?? 0);

    state.children = state.children.filter((item) => item.id !== child.id);
    closeDetail();
    renderList();
    toast(`${child.name} 아동과 관련 기록 ${total}건을 삭제했습니다`);
  } catch (error) {
    toast(error.message, true);
    elc.infoDelete.disabled = false;
  }
}

/* ---------- 이벤트 ---------- */

fillOptions(elc.gender, [{ value: "", label: "선택 안 함" }, ...GENDERS.map(toOption)]);
fillOptions(elc.status, CHILD_STATUSES.map(toOption));
elc.closeHint.textContent = CLOSE_EXPLAIN;

elc.addOpen.addEventListener("click", () => openChildForm("create"));
elc.infoEdit.addEventListener("click", () => {
  if (childDetail) openChildForm("edit", childDetail);
});
elc.infoDelete.addEventListener("click", askDeleteChild);
elc.form.addEventListener("submit", submitChildForm);
elc.cancel.addEventListener("click", askCloseChildForm);
elc.formBack.addEventListener("click", askCloseChildForm);
elc.status.addEventListener("change", () => {
  syncExitField();
  // 종결로 바꾸는 순간 날짜가 비어 있으면 오늘을 넣어 둔다. 대개 오늘이다.
  if (elc.status.value === "종결" && !elc.exit.value) elc.exit.value = todayISO();
});
elc.birth.addEventListener("input", syncGradeHint);

el.obsMore.addEventListener("click", showMoreObservations);
el.obsUnsetOnly.addEventListener("click", () => {
  state.unsetOnly = !state.unsetOnly;
  state.obsShown = OBS_STEP;
  renderObservations();
});
// 본문 칸이 굴러가다 [더 보기] 가까이 오면 이어서 그린다(IntersectionObserver 가 안 도는 환경의 안전망)
document.querySelector(".main")?.addEventListener("scroll", () => {
  if (el.obsMoreBox.hidden || el.detailEdit.hidden) return;
  if (el.obsMoreBox.getBoundingClientRect().top < globalThis.innerHeight + 200) showMoreObservations();
}, { passive: true });
