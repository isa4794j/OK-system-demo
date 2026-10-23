/**
 * 일지 (프로그램 / 일상 / 회의록 / 봉사 공용)
 *
 * 화면이 둘이다. 명단↔상세와 같은 방식으로 갈아 끼운다.
 *   목록      — 기간 선택 + 일지 카드 목록
 *   작성/수정 — 목록 대신 뜨는 넓은 입력 화면
 *
 * 네 종류는 구조가 같으므로 화면 코드를 나누지 않는다.
 * kind만 바꿔 같은 코드를 다시 쓰고, 다른 점(작성자 후보·시각)만 config()에서 갈라 낸다.
 *
 * 브라우저는 Supabase에 직접 접근하지 않는다. 항상 /api/... 를 거친다.
 */
import {
  button,
  confirmDialog,
  explain,
  fillOptions,
  formatDate,
  get,
  hideState,
  pad,
  personColor,
  remove,
  ro,
  send,
  showState,
  toast,
  todayISO,
} from "./ui.js";
import {
  checkPatch,
  closeRowEditor,
  deleteRecordPrompt,
  patchMessage,
  renderReviewRow,
} from "./resource_review.js";
import { refreshInboxBadge } from "./resource_inbox.js";
import { gradeLabel } from "./grade.js";
import {
  attachMergeDrag,
  confirmMerge,
  renderContentEditor,
  renderSplitEditor,
} from "./obs_edit.js";
import { editVolunteerJournal, openVolunteerJournal } from "./volunteer_journal.js";
import { loadMe } from "./me.js";
import { closePicker, pickMonth } from "./m/month_picker.js";
import { foldBody } from "./m/fold.js";

const NARROW = globalThis.matchMedia?.("(max-width: 720px)") ?? { matches: false };

loadMe().then((user) => {
  state.me = user;
});

/**
 * 종류마다 다른 것만 여기 모은다. 나머지 화면 코드는 하나를 같이 쓴다.
 *
 *   roles    작성자로 고를 수 있는 사람의 역할
 *   modal    작성·수정을 모달로 하는가 (봉사일지. 일정에 매여 있고 칸이 적다)
 *   comment  수퍼비전 댓글을 다는가
 *   missing  일정은 있는데 일지가 없는 날을 알리는가
 */
function config(kind) {
  return kind === "봉사"
    ? {
      title: "봉사일지",
      roles: ["멘토", "봉사자"],
      modal: true,
      comment: true,
      missing: true,
      filter: true,
    }
    : {
      title: `${kind} 일지`,
      roles: ["센터장", "생활복지사"],
      modal: false,
      comment: false,
      missing: false,
      filter: false,
    };
}

const state = {
  kind: null, // 프로그램 / 일상 / 회의록 / 봉사
  me: null, // 로그인한 사람 — 새 종사자 일지의 작성자
  month: currentMonth(), // "YYYY-MM"
  journals: [],
  loading: false,
  error: null,

  staff: [],
  /** 아동 명단. "아동 확인 필요" 후보에서 사람을 고를 때만 쓴다. */
  children: [],
  /** 일정은 있는데 일지가 없는 날 (봉사일지) */
  missing: [],
  /** 수퍼비전 댓글을 고쳐 쓰는 중인 일지 id */
  commentEditing: new Set(),

  screen: "list", // list | form
  formMode: "create", // create | edit
  editing: null, // 수정 중인 일지
  /** 일지 id -> { status, items, skipped, message } 관찰 추출 결과 */
  extracts: new Map(),
  /** 일지 id -> { status, items, categories, skipped, message } 자원 추출 결과 */
  resources: new Map(),
  /** 일지 id -> "obs" | "res". 카드에서 펼쳐 둔 탭 */
  openTab: new Map(),
  /** 지금 인라인으로 손보는 추출 관찰. { id, mode: "content" | "split" } — 한 번에 하나만 */
  obsEditing: null,
  /** 그 편집기가 들고 있는 입력값. 다시 그려도 살아남아야 해서 state 에 둔다. */
  obsDraft: { keep: "", fresh: "" },
  /** 일괄 분석 진행 상황. null 이면 안 돌고 있다. */
  batch: null,
  pending: false,

  /**
   * [나눠 받기] 목록은 15건씩 온다(서버 커서). 다음 쪽 위치와 한 달 전체의 요약.
   * 건수와 [미분석 일괄 분석] 은 보이는 쪽이 아니라 한 달 전체가 기준이다 —
   * 그래서 서버가 첫 쪽에 total·unanalyzed 를 따로 실어 준다.
   */
  nextCursor: null,
  loadingMore: false,
  total: 0,
  /** [{ id, observations_analyzed, resources_analyzed }] — 한 달 중 분석이 덜 된 일지 */
  unanalyzed: [],

  /**
   * [검색·기간] 통합 검색어(q)와 달·날짜 판으로 고른 기간. 서버가 거른다.
   * 기간(from~to, 둘 다 있어야)을 걸면 달 대신 그 범위를 본다.
   * 봉사일지에서 검색어의 "봉사자"·"멘토" 는 역할로 거른다(parsedSearch).
   * 화면 안에만 둔다 — 주소·저장값에 남기지 않는다. 다른 종류로 가면 풀린다.
   */
  filter: { q: "", from: "", to: "" },
};

const el = {
  // 목록 화면
  listView: document.getElementById("view-journal-list"),
  title: document.getElementById("journal-title"),
  count: document.getElementById("journal-count"),
  monthPrev: document.getElementById("month-prev"),
  monthNext: document.getElementById("month-next"),
  monthInput: document.getElementById("month-input"),
  monthPick: document.getElementById("month-pick"),
  monthPickClear: document.getElementById("month-pick-clear"),
  period: document.getElementById("journal-period"),
  monthCal: document.getElementById("month-cal"),
  rangeWide: document.getElementById("journal-range-wide"),
  rangeLabel: document.getElementById("journal-range-label"),
  q: document.getElementById("journal-q"),
  rangeClear: document.getElementById("journal-range-clear"),
  addOpen: document.getElementById("journal-add-open"),
  addOpenNarrow: document.getElementById("journal-add-open-narrow"),
  rangeNarrow: document.getElementById("journal-range-narrow"),
  authorField: document.getElementById("journal-author-field"),
  batch: document.getElementById("journal-batch"),
  batchState: document.getElementById("journal-batch-state"),
  list: document.getElementById("journal-list"),
  moreBox: document.getElementById("journal-more-box"),
  more: document.getElementById("journal-more"),
  missing: document.getElementById("journal-missing"),
  state: document.getElementById("journal-state"),

  // 작성/수정 화면
  formView: document.getElementById("view-journal-form"),
  back: document.getElementById("journal-back"),
  heading: document.getElementById("journal-form-heading"),
  sub: document.getElementById("journal-form-sub"),
  form: document.getElementById("journal-form"),
  date: document.getElementById("journal-date"),
  author: document.getElementById("journal-author"),
  formTitle: document.getElementById("journal-form-title"),
  formContent: document.getElementById("journal-form-content"),
  submit: document.getElementById("journal-submit"),
  cancel: document.getElementById("journal-cancel"),
};

/* ---------- 달 계산 ---------- */

function currentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
}

/** "YYYY-MM" → 그 달의 첫날과 마지막날 */
function monthRange(month) {
  const [year, mon] = month.split("-").map(Number);
  // 다음 달의 0일 = 이번 달의 마지막 날
  const lastDay = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${pad(lastDay)}` };
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

/* ---------- 검색·기간 ---------- */

/**
 * 기간이 걸려 있는가 — 시작·끝이 다 있고 순서가 맞을 때만.
 * 거는 곳은 달·날짜 고르기 판 하나(넓은 화면은 달력 아이콘, 좁은 화면은 달 이름).
 */
function rangeActive() {
  const { from, to } = state.filter;
  return !!from && !!to && from <= to;
}

/** "9월 2일" / "9월 2일~9월 5일" — 좁은 화면 달 버튼 */
function spanLabel(from, to) {
  const day = (date) => `${Number(date.slice(5, 7))}월 ${Number(date.slice(8))}일`;
  return from === to ? day(from) : `${day(from)}~${day(to)}`;
}

/** 좁은 화면 달 버튼: 기간이 걸렸으면 기간, 아니면 달. [×] 는 기간이 걸렸을 때만 */
function syncMonthPick() {
  const on = rangeActive();
  // 넓은 화면은 기간을 옆 알약(#journal-range-wide)이 보여 주므로 달만
  const showSpan = on && NARROW.matches;
  el.monthPick.textContent = showSpan ? spanLabel(state.filter.from, state.filter.to) : monthLabel(state.month);
  el.monthPickClear.hidden = !on;
}

/** 지금 보는 범위. 기간이 걸렸으면 그 범위, 아니면 보고 있는 달. */
function viewRange() {
  return rangeActive() ? { from: state.filter.from, to: state.filter.to } : monthRange(state.month);
}

/** "2026. 7. 1 ~ 9. 30" 또는 "2026년 9월" */
function viewLabel() {
  if (!rangeActive()) return monthLabel(state.month);
  const [fy, fm, fd] = state.filter.from.split("-").map(Number);
  const [ty, tm, td] = state.filter.to.split("-").map(Number);
  return `${fy}. ${fm}. ${fd} ~ ${ty === fy ? "" : `${ty}. `}${tm}. ${td}`;
}

/**
 * 검색어 → { role, text }. 봉사일지에서 "봉사자"·"멘토" 낱말은 역할 거르기로 바꾸고,
 * 나머지 글자는 통합 검색(작성자 이름·본문·제목)으로 보낸다.
 */
function parsedSearch() {
  const cfg = config(state.kind);
  let role = "";
  const rest = [];
  for (const word of state.filter.q.split(/\s+/).filter(Boolean)) {
    if (cfg.filter && !role && cfg.roles.includes(word)) role = word;
    else rest.push(word);
  }
  return { role, text: rest.join(" ") };
}

function filtering() {
  const { role, text } = parsedSearch();
  return !!role || !!text || rangeActive();
}

/** 서버에 보낼 조회 조건. 같은 값이면 같은 글자 — 늦게 온 답을 가려낼 때도 쓴다. */
function listParams(cursor = null) {
  const { from, to } = viewRange();
  const params = new URLSearchParams({ kind: state.kind, from, to });
  const { role, text } = parsedSearch();
  if (role) params.set("role", role);
  if (text) params.set("q", text);
  if (cursor) params.set("cursor", cursor);
  return params;
}

/** 지금 목록을 가리키는 열쇠(커서 빼고) */
function viewKey() {
  return listParams().toString();
}

/** 이 일지가 지금 거른 목록에 들어가는가 — 방금 쓴 일지를 목록에 넣을지 정한다 */
function matchesView(journal) {
  const { from, to } = viewRange();
  if (journal.journal_date < from || journal.journal_date > to) return false;
  const { role, text } = parsedSearch();
  if (role && (journal.as_role ?? journal.author_role) !== role) return false;
  if (text) {
    const needle = text.toLowerCase();
    const hay = [journal.author_name, journal.title, journal.content].map((v) => String(v ?? "").toLowerCase());
    if (!hay.some((v) => v.includes(needle))) return false;
  }
  return true;
}

function syncFilterBar() {
  syncMonthPick();
  // 넓은 화면: 고른 날짜·기간을 달 옆에 알약으로(× 는 달 전체로)
  const on = rangeActive();
  el.rangeWide.hidden = !on;
  el.rangeLabel.textContent = on ? spanLabel(state.filter.from, state.filter.to) : "";
  el.q.placeholder = config(state.kind).filter
    ? "작성자·내용·역할(봉사자/멘토) 검색"
    : "작성자·내용 검색";
}

function resetFilter() {
  state.filter = { q: "", from: "", to: "" };
  el.q.value = "";
  syncFilterBar();
}

/** 필터가 바뀌면 첫 쪽부터 다시 받는다 */
function applyFilter() {
  syncFilterBar();
  goToList();
  loadJournals();
}

let searchTimer = 0;
function readSearch() {
  clearTimeout(searchTimer);
  const q = el.q.value.trim();
  if (q === state.filter.q) return;
  state.filter.q = q;
  applyFilter();
}

/* ---------- 화면 전환 ---------- */

/** app.js가 부른다. 일지 화면을 열고 목록부터 보여준다. */
export function showJournals(kind) {
  const kindChanged = state.kind !== kind;
  state.kind = kind;

  if (kindChanged) {
    state.extracts.clear();
    state.resources.clear();
    state.openTab.clear();
    state.commentEditing.clear();
    closeObsEditor();
    closeRowEditor();
    state.journals = [];
    state.missing = [];
    state.nextCursor = null;
    state.total = 0;
    state.unanalyzed = [];
    resetFilter();
  }

  el.title.textContent = config(kind).title;
  syncFilterBar();
  el.monthInput.value = state.month;

  // 다른 종류로 넘어오면 쓰던 폼은 버리고 목록부터 본다
  goToList();

  loadStaff();
  loadChildren();
  loadJournals();
}

export function hideJournals() {
  el.listView.hidden = true;
  el.formView.hidden = true;
}

function goToList() {
  state.screen = "list";
  state.editing = null;
  el.formView.hidden = true;
  placeForm();
}

function goToForm() {
  state.screen = "form";
  el.formView.hidden = false;
  if (!placeForm()) el.back.focus();
}

/*
 * 좁은 화면 — 종사자 일지 작성·수정도 봉사일지처럼 모달로 띄운다.
 * 작성 화면(section)을 통째로 모달 안에 옮겼다가 닫으면 제자리로 돌린다. 목록은 뒤에 그대로 있다.
 * 넓은 화면은 예전대로 목록 대신 작성 화면.
 */
const formHome = { parent: el.formView.parentElement, next: el.formView.nextSibling };
const formModal = document.createElement("div");
formModal.className = "modal jmodal";
formModal.hidden = true;
const formBackdrop = document.createElement("div");
formBackdrop.className = "modal__backdrop";
formModal.append(formBackdrop);
document.body.append(formModal);

/** 지금 화면 폭에 맞게 작성 화면을 둔다. 모달이면 true */
function placeForm() {
  const modal = state.screen === "form" && NARROW.matches;
  if (modal && el.formView.parentElement !== formModal) formModal.append(el.formView);
  if (!modal && el.formView.parentElement === formModal) {
    formHome.parent.insertBefore(el.formView, formHome.next);
  }
  el.formView.classList.toggle("modal__dialog", modal);
  el.formView.classList.toggle("modal__dialog--write", modal);
  el.formView.classList.toggle("jmodal__dialog", modal);
  el.formView.setAttribute("role", modal ? "dialog" : "region");
  el.formView.toggleAttribute("aria-modal", modal);
  formModal.hidden = !modal;
  el.listView.hidden = state.screen === "form" && !modal;
  return modal;
}

function journalFormValues() {
  return JSON.stringify([el.date.value, el.author.value, el.formTitle.value, el.formContent.value]);
}

/** 모달 바깥·Esc — 쓰던 글이 있으면 한 번 묻는다([취소] 버튼은 예전처럼 묻지 않고 닫는다) */
async function askCloseForm() {
  if (state.pending || formModal.hidden) return;
  if (journalFormValues() !== state.formInitial) {
    const yes = await confirmDialog({
      title: "쓰던 내용을 버릴까요?",
      message: "저장하지 않은 내용이 사라집니다.",
      confirmText: "버리기",
    });
    if (!yes) return;
  }
  backToList();
}

formBackdrop.addEventListener("click", askCloseForm);
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || formModal.hidden) return;
  // 확인창이 떠 있으면 그쪽 Esc 다
  if (!formModal.contains(document.activeElement) && document.activeElement !== document.body) return;
  askCloseForm();
});

NARROW.addEventListener?.("change", () => {
  closePicker();
  if (state.kind) syncFilterBar();
  placeForm();
});

/* ---------- 스크롤 자리 지키기 ---------- */

/**
 * 실제로 굴러가는 칸. 창이 아니라 본문 칸이 스크롤한다.
 * 없으면(마크업이 바뀌면) 자리 지키기를 조용히 포기한다 — 화면이 멈추는 것보다 낫다.
 */
function scroller() {
  return document.querySelector(".main");
}

/** 목록을 떠날 때의 스크롤 자리 */
let listScrollTop = 0;

/**
 * 작성 화면으로 갈 때 목록의 자리를 적어 둔다.
 *
 * 작성 화면은 목록보다 짧다. 그리로 넘어가는 순간 굴러갈 높이가 줄어
 * 브라우저가 스크롤을 위로 깎아 버린다. 돌아와도 깎인 자리 그대로다.
 * 그래서 떠나기 전에 적어 두었다가 돌아온 뒤 되돌린다.
 */
function leaveList() {
  listScrollTop = scroller()?.scrollTop ?? 0;
  goToForm();
}

/**
 * 작성 화면에서 목록으로 돌아온다. 보던 자리까지 되돌린다.
 *
 * 목록을 다시 보이게 한 뒤 높이를 한 번 읽는다.
 * 읽지 않고 바로 넣으면 브라우저가 아직 짧은 높이로 알고 있어 자리가 위로 깎인다.
 * (다음 프레임으로 미루는 것도 안 된다 — 그때도 아직 계산 전이다)
 */
function backToList() {
  goToList();
  const node = scroller();
  if (!node) return;

  void node.scrollHeight;
  node.scrollTop = listScrollTop;
}

/**
 * 그 카드의 발 한 줄과 펼친 칸만 갈아 끼운다. 목록은 건드리지 않는다.
 *
 * 예전에는 목록을 통째로 다시 그리고 스크롤을 되돌려 놓았다. 그 방법은 끝까지 안 맞았다 —
 * 목록을 비우는 순간 굴러갈 높이가 0 이 되어 브라우저가 자리를 깎고, 되돌려 넣은 값도
 * 목록 끝 쪽에서는 다시 깎인다. 깎인 만큼이 매번 남아 [관찰]·[자원]을 누를수록
 * 조금씩 위로 밀렸다.
 *
 * 바뀌는 것은 발 한 줄과 그 아래 칸뿐이다. 누른 버튼보다 위는 높이가 변하지 않으니
 * 보던 자리도 움직이지 않는다. 보정할 것이 없어야 어긋날 것도 없다.
 */
function renderFoot(journalId) {
  const old = el.list.querySelector(`.jfootwrap[data-id="${journalId}"]`);
  const journal = state.journals.find((one) => one.id === journalId);

  // 카드가 화면에 없다(달을 옮겼거나 목록을 다시 읽는 중). 통째로 그리는 수밖에 없다.
  if (!old || !journal) {
    render();
    return;
  }

  // 누른 버튼이 사라지면 초점이 문서로 떨어진다. 키보드로 연달아 누를 수 없게 되므로
  // 같은 자리의 버튼으로 되돌려 준다.
  const focusedTab = old.contains(document.activeElement)
    ? document.activeElement.dataset.tab ?? null
    : null;

  const fresh = renderFooter(journal);
  old.replaceWith(fresh);
  if (focusedTab) fresh.querySelector(`[data-tab="${focusedTab}"]`)?.focus();

  // 일괄 분석 버튼은 "미분석이 몇 건인가"를 보고 켜지고 꺼진다.
  // 방금 분석한 일지가 있으면 여기서도 다시 맞춰야 한다.
  syncBatchButton();
}

/* ---------- 데이터 ---------- */

/**
 * 작성자로 고를 수 있는 사람을 읽어온다.
 *
 * 한 번 읽고 캐시하지 않는다. 바로 옆 "종사자 명단"에서 사람을 등록하고
 * 곧장 일지를 쓰는 흐름이 있어서, 캐시가 남으면 방금 등록한 사람이 안 보인다.
 * 요청 하나가 더 나가는 것보다 그게 더 곤란하다.
 */
async function loadStaff() {
  try {
    // 종류에 따라 후보가 다르다. 종사자 일지는 센터장·생활복지사, 봉사일지는 멘토·봉사자.
    const params = new URLSearchParams();
    for (const role of config(state.kind).roles) params.append("role", role);
    const payload = await get(`/api/staff?${params}`);
    state.staff = payload.staff ?? [];
  } catch (error) {
    // 목록을 못 불러와도 일지 조회는 되어야 하므로 화면 전체를 막지 않는다
    console.error("[loadStaff]", error);
    toast(error.message, true);
  }
}

/**
 * 아동 명단을 읽어온다. "아동 확인 필요" 후보에서 고를 때만 쓴다.
 *
 * 못 읽어도 일지 목록은 보여야 하므로 조용히 비운다.
 * 그때는 후보 버튼만 남고 [명단에서 고르기]가 비는데, 후보만으로도 대개 끝난다.
 */
async function loadChildren() {
  try {
    const payload = await get("/api/children");
    state.children = payload.children ?? [];
  } catch (error) {
    console.error("[loadChildren]", error);
    state.children = [];
  }
}

async function loadJournals() {
  state.loading = true;
  state.error = null;
  render();

  const params = listParams();
  const asked = params.toString();
  try {
    const payload = await get(`/api/journals?${params}`);
    // 달·종류·필터를 빠르게 바꾸면 앞서 부른 답이 나중에 올 수 있다 — 지금 보는 목록의 답만 쓴다
    if (viewKey() !== asked) return;
    state.journals = payload.journals ?? [];
    state.nextCursor = payload.next_cursor ?? null;
    state.total = payload.total ?? state.journals.length;
    state.unanalyzed = payload.unanalyzed ?? [];
  } catch (error) {
    if (viewKey() !== asked) return;
    state.error = error.message;
    state.journals = [];
    state.nextCursor = null;
    state.total = 0;
    state.unanalyzed = [];
  } finally {
    if (viewKey() === asked) {
      state.loading = false;
      render();
    }
  }

  if (viewKey() === asked) loadMissing();
}

/**
 * 다음 15건. 받은 것은 뒤에 붙인다.
 *
 * 그 사이 달이나 종류를 바꿨으면 늦게 온 답을 버린다 — 다른 목록에 섞이면 안 된다.
 * 이미 목록에 있는 줄(방금 쓴 일지 등)은 두 번 넣지 않는다.
 */
async function loadMore() {
  if (!state.nextCursor || state.loadingMore) return;

  const asked = { view: viewKey(), cursor: state.nextCursor };
  const params = listParams(asked.cursor);

  state.loadingMore = true;
  syncMore();
  try {
    const payload = await get(`/api/journals?${params}`);
    if (viewKey() !== asked.view) return;
    if (state.nextCursor !== asked.cursor) return;

    const have = new Set(state.journals.map((one) => one.id));
    for (const one of payload.journals ?? []) {
      if (!have.has(one.id)) state.journals.push(one);
    }
    state.nextCursor = payload.next_cursor ?? null;
    render();
  } catch (error) {
    toast(error.message, true);
  } finally {
    state.loadingMore = false;
    syncMore();
  }
}

function syncMore() {
  const show = !state.loading && !state.error && !!state.nextCursor;
  el.moreBox.hidden = !show;
  el.more.disabled = state.loadingMore;
  el.more.textContent = state.loadingMore
    ? "불러오는 중…"
    : `더 보기 (${Math.max(state.total - state.journals.length, 0)}건 남음)`;
}

/** 한 달 요약을 손으로 맞춘다 — 쓰기·지우기·분석 결과를 목록을 다시 읽지 않고 반영 */
function trackNew(journal) {
  state.total += 1;
  state.unanalyzed.push({
    id: journal.id,
    observations_analyzed: !!journal.observations_analyzed,
    resources_analyzed: !!journal.resources_analyzed,
  });
}

function trackGone(journalId) {
  state.total = Math.max(state.total - 1, 0);
  state.unanalyzed = state.unanalyzed.filter((one) => one.id !== journalId);
}

/**
 * 일정은 있는데 일지가 없는 날을 읽는다 (봉사일지).
 *
 * 목록과 따로 읽는다. 이걸 못 읽어도 일지 목록은 보여야 하기 때문이다.
 * 실패하면 조용히 비운다. 알림이 안 뜨는 것보다 목록이 안 뜨는 게 나쁘다.
 */
async function loadMissing() {
  if (!config(state.kind).missing) {
    state.missing = [];
    return;
  }

  // 미작성은 달 단위 알림이다. 기간을 걸어 둔 동안은 띄우지 않는다.
  if (rangeActive()) {
    state.missing = [];
    render();
    return;
  }

  const [year, mon] = state.month.split("-").map(Number);
  const asked = viewKey();

  try {
    const payload = await get(`/api/journals/missing?year=${year}&month=${mon}`);
    if (viewKey() !== asked) return;
    state.missing = payload.missing ?? [];
  } catch (error) {
    console.error("[loadMissing]", error);
    state.missing = [];
  }
  render();
}

/* ---------- 목록 그리기 ---------- */

function render() {
  el.list.replaceChildren();
  hideState(el.state);
  renderMissing();
  // 아래에서 일찍 빠져나가는 갈래가 있어 맨 앞에서 맞춰 둔다
  syncBatchButton();
  syncMore();

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

  // 좁은 화면은 건수도 검색창도 없다. 넓은 화면에서 건 검색이 남아 있으면 무엇을 보는지만 적는다.
  const search = parsedSearch();
  const searchBits = [search.role, search.text && `"${search.text}"`].filter(Boolean);
  el.rangeNarrow.hidden = searchBits.length === 0;
  el.rangeNarrow.textContent = searchBits.join(" · ");
  el.count.textContent = [
    viewLabel(),
    ...searchBits,
    `${Math.max(state.total, state.journals.length)}건`,
  ].join(" · ");

  if (state.journals.length === 0) {
    if (filtering()) {
      showState(
        el.state,
        `조건에 맞는 ${config(state.kind).title}가 없어요.`,
        "검색어를 지우거나 날짜 옆 [×] 로 달 전체를 볼 수 있습니다.",
      );
      return;
    }
    showState(
      el.state,
      `아직 ${config(state.kind).title}가 없어요.`,
      "[+ 일지 작성] 버튼으로 첫 일지를 남겨보세요.",
    );
    return;
  }

  for (const journal of state.journals) {
    el.list.append(renderCard(journal));
  }
}

/**
 * 일정은 있는데 일지가 없는 날을 알린다.
 *
 * 경고가 아니라 알림이다. 늦게 쓰는 날도 있고, 안 쓰기로 한 날도 있다.
 * 그래서 빨강이 아니라 주의 색을 쓰고, 지울 방법은 일지를 쓰는 것뿐이다.
 */
function renderMissing() {
  const cfg = config(state.kind);

  if (!cfg.missing || state.loading || state.error || state.missing.length === 0) {
    el.missing.replaceChildren();
    el.missing.hidden = true;
    return;
  }

  // 역할·검색어를 걸었으면 미작성도 같은 조건으로 좁힌다(글자는 사람 이름에만 견준다)
  const f = parsedSearch();
  const items = state.missing.filter((item) =>
    (!f.role || item.role === f.role) &&
    (!f.text || String(item.staff_name ?? "").toLowerCase().includes(f.text.toLowerCase()))
  );
  if (items.length === 0) {
    el.missing.replaceChildren();
    el.missing.hidden = true;
    return;
  }

  const title = document.createElement("p");
  title.className = "missing__title";
  title.textContent = `일정은 있는데 일지를 안 쓴 날 ${items.length}건`;

  const list = document.createElement("ul");
  list.className = "missing__list";

  for (const item of items) {
    const li = document.createElement("li");
    li.className = "missing__item";

    const who = document.createElement("span");
    who.className = "missing__who";
    // 이름은 사용자 입력이므로 textContent로만 넣는다
    who.textContent = `${item.staff_name ?? "이름 없음"} · ${formatDate(item.sched_date)}`;

    const time = document.createElement("span");
    time.textContent = `${item.start_time}–${item.end_time}`;

    li.append(who, time, button("일지 작성", "linkbtn", () => openCreate(item)));
    list.append(li);
  }

  el.missing.replaceChildren(title, list);
  el.missing.hidden = false;
}

/**
 * 일지 카드 한 장.
 *
 * 옛 시스템의 밀도로 돌아왔다 — 머리 한 줄, 본문, 작은 링크 한 줄.
 * 수퍼비전·관찰·자원이 저마다 제목과 구분선을 차지하니 카드가 길어져
 * 정작 읽어야 할 일지 본문이 묻혔다. 곁가지는 아래 한 줄로 접어 둔다.
 */
/**
 * 글을 넣으며 검색어와 맞는 곳에 표시(<mark>)를 단다. 대소문자는 가리지 않는다.
 * 사용자 글이라 조각마다 텍스트 노드로만 넣는다(innerHTML 안 씀).
 */
function markText(node, text, needle) {
  node.replaceChildren();
  if (!needle) {
    node.textContent = text;
    return;
  }
  const lower = text.toLowerCase();
  const find = needle.toLowerCase();
  let from = 0;
  for (let at = lower.indexOf(find); at >= 0; at = lower.indexOf(find, from)) {
    if (at > from) node.append(text.slice(from, at));
    const mark = document.createElement("mark");
    mark.className = "jmark";
    mark.textContent = text.slice(at, at + find.length);
    node.append(mark);
    from = at + find.length;
  }
  node.append(text.slice(from));
}

function renderCard(journal) {
  const card = document.createElement("article");
  card.className = "card card--pad jcard";
  card.dataset.id = journal.id;

  const cfg = config(state.kind);
  const usable = !isTemp(journal.id);

  /* 1) 머리 한 줄 */
  const head = document.createElement("div");
  head.className = "jcard__head";

  const date = document.createElement("span");
  date.className = "jcard__date";
  date.textContent = formatDate(journal.journal_date);

  const who = document.createElement("span");
  who.className = `personchip personchip--${
    personColor({ color_index: journal.author_color, staff_id: journal.author_id })
  }`;
  const dot = document.createElement("span");
  dot.className = "personchip__dot";
  const name = document.createElement("span");
  // 작성자 이름은 사용자 입력이므로 textContent로만 넣는다
  const needle = parsedSearch().text;
  markText(name, journal.author_name ?? "작성자 없음", needle);
  who.append(dot, name);

  const role = document.createElement("span");
  role.className = "roletag";
  role.textContent = journal.author_role ?? "";

  head.append(date, who, role);

  // 시각은 봉사일지에만 있다. 값이 없으면 칸도 만들지 않는다.
  if (journal.start_time || journal.end_time) {
    const time = document.createElement("span");
    time.className = "jcard__time";
    time.textContent = `${journal.start_time ?? "?"}–${journal.end_time ?? "?"}`;
    head.append(time);
  }

  const actions = document.createElement("div");
  actions.className = "jcard__actions";
  const edit = button("수정", "linkbtn", () => openEdit(journal));
  edit.disabled = !usable;
  const del = button("삭제", "linkbtn linkbtn--danger", () => askDeleteJournal(journal));
  del.disabled = !usable;
  actions.append(edit, del);
  head.append(actions);
  card.append(head);

  /* 2) 본문 — 카드의 주인공. 4줄(좁은 화면 2줄)까지 보이고 [더 보기 ▾] 로 편다. */
  if (journal.title) {
    const title = document.createElement("h4");
    title.className = "jcard__title";
    markText(title, journal.title, needle);
    card.append(title);
  }

  const content = document.createElement("p");
  content.className = "jcard__content";
  markText(content, journal.content ?? "", needle);
  card.append(content, foldBody(content, "linkbtn"));

  /* 3) 수퍼비전 — 있으면 인용 한 줄, 고치는 중이면 입력칸 */
  if (cfg.comment && usable) {
    if (state.commentEditing.has(journal.id)) card.append(renderCommentEditor(journal));
    else if (journal.comment) card.append(renderCommentQuote(journal));
  }

  /* 4) 발 한 줄 — 작은 링크들. 누르면 그 아래가 펼쳐진다. */
  if (usable) card.append(renderFooter(journal));

  return card;
}

/** 수퍼비전 댓글 한 줄. 눌러서 바로 고칠 수 있다. */
function renderCommentQuote(journal) {
  const quote = document.createElement("blockquote");
  quote.className = "jquote";
  // 댓글은 사용자 입력이므로 textContent로만 넣는다
  quote.textContent = journal.comment;
  return quote;
}

/** 수퍼비전 댓글 입력칸. 발 한 줄의 [수퍼비전]을 누르면 열린다. */
function renderCommentEditor(journal) {
  const wrap = document.createElement("div");
  wrap.className = "jedit";

  const area = document.createElement("textarea");
  area.className = "input textarea";
  area.rows = 3;
  area.maxLength = 2000;
  area.value = journal.comment ?? "";
  area.setAttribute("aria-label", "수퍼비전 댓글");

  const actions = document.createElement("div");
  actions.className = "jedit__actions";
  actions.append(
    button("저장", "btn btn--primary", () => saveComment(journal, area.value)),
    button("취소", "btn", () => {
      state.commentEditing.delete(journal.id);
      render();
    }),
  );
  if (journal.comment) {
    actions.append(button("댓글 삭제", "linkbtn linkbtn--danger", () => askDeleteComment(journal)));
  }

  wrap.append(area, actions);

  // 이 시점에는 아직 화면에 붙기 전이라 focus가 듣지 않는다. render 뒤로 미룬다.
  queueMicrotask(() => area.focus());
  return wrap;
}

/**
 * 카드 발 한 줄: 수퍼비전 · 관찰 N · 자원 N
 *
 * 셋 다 곁가지라 같은 크기·같은 회색으로 나란히 둔다.
 * 관찰·자원은 누르면 아래가 펼쳐지고, 누른 것만 진해진다. 기본은 둘 다 접힘.
 */
function renderFooter(journal) {
  const wrap = document.createElement("div");
  // renderFoot 이 이 표를 보고 이 덩어리만 갈아 끼운다
  wrap.className = "jfootwrap";
  wrap.dataset.id = journal.id;
  const open = state.openTab.get(journal.id) ?? null;

  const foot = document.createElement("div");
  foot.className = "jfoot";

  if (config(state.kind).comment) {
    foot.append(
      button(journal.comment ? "수퍼비전" : "수퍼비전 달기", "jfoot__link", () => {
        state.commentEditing.add(journal.id);
        render();
      }),
    );
  }

  // 펼치고 접을 때 그 카드가 눈에서 움직이지 않게 한다
  const toggle = (tab, load) => () => {
    if (state.openTab.get(journal.id) === tab) state.openTab.delete(journal.id);
    else {
      state.openTab.set(journal.id, tab);
      load();
    }
    renderFoot(journal.id);
  };

  foot.append(
    footLink("관찰", tabState(journal, "obs"), open === "obs", toggle("obs", () => {
      if (!state.extracts.has(journal.id)) loadExtract(journal.id);
    })),
    footLink("자원", tabState(journal, "res"), open === "res", toggle("res", () => {
      if (!state.resources.has(journal.id)) loadResourceRecords(journal.id);
    })),
  );
  wrap.append(foot);

  if (open) {
    const panel = document.createElement("div");
    panel.className = "jpanel";
    panel.append(open === "obs" ? renderExtract(journal) : renderResources(journal));
    wrap.append(panel);
  }
  return wrap;
}

/**
 * 그 탭에 무엇을 적을지 정한다.
 *
 *   { busy: true }        분석 중 — 개수 대신 점 세 개
 *   { count: 3 }          분석했고 3건
 *   { count: 0 }          분석했는데 없었다
 *   { unanalyzed: true }  아직 한 번도 분석하지 않았다
 *
 * 개수는 목록을 읽을 때 함께 받아 둔다(서버가 세어 준다). 그래서 펼치지 않아도 보인다.
 * 열어 본 뒤에는 그 자리에서 고치고 지운 것이 개수에 바로 비쳐야 하므로,
 * 불러온 목록이 있으면 그쪽을 먼저 본다.
 */
function tabState(journal, tab) {
  const entry = (tab === "obs" ? state.extracts : state.resources).get(journal.id);
  if (entry?.status === "loading") return { busy: true };

  const analyzed = tab === "obs" ? journal.observations_analyzed : journal.resources_analyzed;
  // 펼쳐서 저장된 목록을 읽기만 한 것(ran:false)은 분석이 아니다 — 미분석이면 미분석 그대로
  if (entry?.status === "done" && (entry.ran || analyzed)) return { count: entry.items.length };
  if (!analyzed) return { unanalyzed: true };
  return { count: tab === "obs" ? journal.observation_count : journal.resource_count };
}

/**
 * 발 한 줄의 링크.
 *
 * "0" 과 "미분석" 을 다르게 적는다. 앞은 그냥 두면 되고 뒤는 눌러야 하는 일이라,
 * 같은 모양으로 보이면 안 된다.
 */
function footLink(label, info, active, onClick) {
  const node = document.createElement("button");
  node.type = "button";
  node.dataset.tab = label;
  node.className = active ? "jfoot__link is-open" : "jfoot__link";
  node.setAttribute("aria-expanded", String(active));

  if (info.busy) {
    node.textContent = `${label} …`;
    node.title = "분석 중입니다";
  } else if (info.unanalyzed) {
    node.textContent = `${label} 미분석`;
    node.classList.add("jfoot__link--unanalyzed");
    node.title = "아직 분석하지 않은 일지입니다";
  } else {
    node.textContent = `${label} ${info.count}`;
  }

  node.addEventListener("click", onClick);
  return node;
}

/* ---------- 이 일지에서 추출된 자원 ---------- */

/**
 * 뽑힌 자원은 바로 통계에 들어간다. 사람은 틀린 것만 고친다.
 *
 * 검토를 일지 카드 안에 둔 이유: "나무탑이 정말 젠가인가"는 일지 본문을 읽어야
 * 판단할 수 있다. 따로 모아 둔 미분류함에서는 그 글이 안 보인다.
 * 여러 일지를 한꺼번에 훑는 화면은 병합(자-4) 때 만든다.
 */
function renderResources(journal) {
  const box = document.createElement("div");
  box.className = "extract resx";

  const entry = state.resources.get(journal.id);

  // 탭을 누르면 곧바로 불러오므로 여기 오는 일은 드물다
  if (!entry) {
    const note = document.createElement("p");
    note.className = "extract__note";
    note.textContent = "불러오는 중…";
    box.append(note);
    return box;
  }

  if (entry.status === "loading") {
    const p = document.createElement("p");
    p.className = "extract__note";
    p.textContent = entry.message ?? "자원 분석 중…";
    box.append(p);
    return box;
  }

  if (entry.status === "error") {
    const p = document.createElement("p");
    p.className = "extract__note extract__note--error";
    p.textContent = `자원 분석에 실패했습니다. ${entry.message}`;
    box.append(p, button("다시 분석", "linkbtn", () => runResourceExtract(journal.id)));
    return box;
  }

  if (entry.items.length === 0) {
    const p = document.createElement("p");
    p.className = "extract__note";
    // 저장된 것이 없다는 것과 AI 가 못 찾았다는 것은 다르다.
    // 직접 넣은 일지는 분석을 한 번도 안 돌렸을 수 있다.
    p.textContent = entry.ran
      ? "이 일지에서는 활용한 자원을 찾지 못했습니다."
      : "아직 분석하지 않은 일지입니다. 저장된 자원 기록이 없습니다.";
    box.append(
      p,
      button(entry.ran ? "다시 분석" : "분석하기", "linkbtn", () => runResourceExtract(journal.id)),
    );
    return box;
  }

  // 갈린 것이 있으면 먼저 고르게 한다. 검토 목록은 그 아래에 그대로 둔다.
  if (entry.diff) {
    box.append(
      renderDiff(
        journal.id,
        resourceDiffRows(entry.diff),
        entry.choices,
        () => applyResourceDiff(journal.id),
      ),
    );
  }

  // 카테고리를 못 정한 줄만 손이 필요하다. 나머지는 이미 통계에 잡혀 있다.
  const unsorted = entry.items.filter((item) =>
    item.status !== "없음" && !item.category
  ).length;
  if (unsorted > 0) {
    const note = document.createElement("p");
    note.className = "extract__note";
    note.textContent = `카테고리 미정 ${unsorted}건. 통계에는 "카테고리 미정"으로 잡힙니다. ` +
      "골라 주면 그 묶음으로 옮겨집니다.";
    box.append(note);
  }

  const list = document.createElement("ul");
  list.className = "resx__list";
  for (const item of entry.items) list.append(renderResourceRecord(journal.id, item, entry));
  box.append(list);

  if (entry.skipped?.length) {
    const note = document.createElement("p");
    note.className = "extract__note";
    note.textContent = `저장하지 않은 항목 ${entry.skipped.length}건: ${entry.skipped.join(" / ")}`;
    box.append(note);
  }

  box.append(button("다시 분석", "linkbtn", () => runResourceExtract(journal.id)));
  return box;
}

/**
 * 검토 줄은 미분류함과 같은 모양이어야 한다. 그리는 코드는 resource_review.js 에 있고,
 * 여기서는 저장할 곳(이 일지의 목록)만 잇는다.
 */
function renderResourceRecord(journalId, item, entry) {
  return renderReviewRow(item, entry.categories, {
    onPatch: (record, patch) => patchRecord(journalId, record.id, patch),
    onDelete: (record) => askDeleteRecord(journalId, record),
    onRerender: () => renderFoot(journalId),
  });
}

/** 이미 저장된 추출 결과를 불러온다 (AI를 부르지 않는다) */
async function loadResourceRecords(journalId) {
  closeRowEditor(); // 목록이 통째로 갈리므로 손보던 줄은 닫는다
  state.resources.set(journalId, { status: "loading", message: "불러오는 중…" });
  render();

  try {
    const payload = await get(`/api/journals/${journalId}/resources`);
    state.resources.set(journalId, {
      status: "done",
      ran: false, // 저장된 것을 읽었을 뿐, AI 를 돌린 것은 아니다
      items: payload.records ?? [],
      categories: payload.categories ?? [],
      skipped: [],
    });
  } catch (error) {
    state.resources.set(journalId, { status: "error", message: error.message });
  }
  render();
}

/** AI로 다시 뽑는다. 크레딧을 쓰므로 누를 때와 일지를 저장할 때만 돈다. */
async function runResourceExtract(journalId) {
  if (state.resources.get(journalId)?.status === "loading") return;

  closeRowEditor();
  state.resources.set(journalId, { status: "loading", message: "자원 분석 중…" });
  renderFoot(journalId);

  try {
    const payload = await send(`/api/journals/${journalId}/extract-resources`, "POST", {});
    // 카테고리 목록은 추출 응답에 없다. 검토 드롭다운을 만들려면 필요하다.
    const categories = await get("/api/resource-categories")
      .then((res) => res.categories ?? [])
      .catch(() => []);

    const listed = await get(`/api/journals/${journalId}/resources`)
      .then((res) => res.records ?? [])
      .catch(() => []);

    const changed = payload.changed ?? [];
    const missing = payload.missing ?? [];
    const hasDiff = changed.length > 0 || missing.length > 0;

    state.resources.set(journalId, {
      status: "done",
      ran: true,
      items: listed,
      categories,
      skipped: payload.skipped ?? [],
      diff: hasDiff ? { changed, missing } : null,
      choices: new Map(),
    });
    markCounted(journalId, "res", listed.length);

    const lines = [];
    if (payload.added?.length) lines.push(`새로 ${payload.added.length}건`);
    if (hasDiff) lines.push(`고를 것 ${changed.length + missing.length}건`);
    if (payload.registered?.length) lines.push(`사전 등록 ${payload.registered.length}건`);
    if (payload.kept > 0) lines.push(`사람이 정한 것 ${payload.kept}건 유지`);
    toast(lines.length === 0 ? "변경 없음" : `자원 · ${lines.join(" · ")}`, hasDiff);
  } catch (error) {
    state.resources.set(journalId, { status: "error", message: error.message });
  }
  renderFoot(journalId);
}

/**
 * 목록이 들고 있는 그 일지의 개수·분석 여부를 맞춘다.
 *
 * 개수는 원래 목록 조회가 세어 준다. 방금 분석한 것까지 맞추려고 목록을 다시 읽으면
 * 요청이 한 번 더 나가고 화면이 깜빡인다. 방금 받은 결과로 그 자리에서 고친다.
 */
function markCounted(journalId, tab, count) {
  // 한 달 요약(미분석 목록)도 함께 맞춘다. 둘 다 끝나면 목록에서 뺀다.
  const pending = state.unanalyzed.find((one) => one.id === journalId);
  if (pending) {
    if (tab === "obs") pending.observations_analyzed = true;
    else pending.resources_analyzed = true;
    if (pending.observations_analyzed && pending.resources_analyzed) {
      state.unanalyzed = state.unanalyzed.filter((one) => one.id !== journalId);
    }
    syncBatchButton();
  }

  const journal = state.journals.find((one) => one.id === journalId);
  if (!journal) return;

  if (tab === "obs") {
    journal.observation_count = count;
    journal.observations_analyzed = true;
  } else {
    journal.resource_count = count;
    journal.resources_analyzed = true;
  }
}

/** 기록 한 줄을 고친다. */
async function patchRecord(journalId, recordId, patch) {
  const entry = state.resources.get(journalId);
  if (!entry || entry.status !== "done") return;

  const problem = checkPatch(patch);
  if (problem) {
    toast(problem, true);
    return;
  }

  const saved = entry.items.map((item) => ({ ...item }));
  const row = entry.items.find((item) => item.id === recordId);
  if (row) Object.assign(row, patch);
  render();

  try {
    const payload = await send(`/api/resource-records/${recordId}`, "PATCH", patch);
    const index = entry.items.findIndex((item) => item.id === recordId);
    if (index >= 0) entry.items[index] = payload.record;
    render();

    toast(patchMessage(patch, payload));
    // 카테고리 미정 수가 바뀌었다. 자원 쪽 서브탭의 뱃지가 같이 움직여야 한다.
    refreshInboxBadge();
  } catch (error) {
    entry.items = saved;
    render();
    toast(error.message, true);
  }
}

async function askDeleteRecord(journalId, item) {
  const yes = await confirmDialog(deleteRecordPrompt(item));
  if (!yes) return;

  const entry = state.resources.get(journalId);
  if (!entry || entry.status !== "done") return;

  const saved = entry.items.map((row) => ({ ...row }));
  entry.items = entry.items.filter((row) => row.id !== item.id);
  render();

  try {
    await remove(`/api/resource-records/${item.id}`);
    toast("자원 기록을 삭제했습니다");
    refreshInboxBadge();
  } catch (error) {
    entry.items = saved;
    render();
    toast(error.message, true);
  }
}

/* ---------- 수퍼비전 댓글 ---------- */

/**
 * 봉사일지에 종사자가 남기는 답이다.
 *
 * 누가 썼는지는 적지 않는다. 지금 로그인이 없어 이름을 알 수 없기도 하지만,
 * 로그인이 생겨도 적지 않을 생각이다. 종사자 개인이 아니라 센터가 하는 답이고,
 * 이름이 붙으면 받는 쪽이 사람을 보고 읽게 된다.
 */
/** 댓글을 저장한다. 빈 값이면 지우는 것과 같다. */
async function saveComment(journal, text) {
  if (state.pending) return;

  const comment = text.trim() || null;
  const saved = snapshot();
  const target = state.journals.find((item) => item.id === journal.id);
  if (!target) return;

  state.pending = true;
  target.comment = comment;
  state.commentEditing.delete(journal.id);
  render();

  try {
    const payload = await send(`/api/journals/${journal.id}`, "PATCH", { comment });
    const index = state.journals.findIndex((item) => item.id === journal.id);
    if (index >= 0) state.journals[index] = payload.journal;
    render();
    toast(comment ? "수퍼비전을 저장했습니다" : "수퍼비전 댓글을 지웠습니다");
  } catch (error) {
    // 쓰던 글을 잃지 않도록 편집 상태로 되돌린다
    restore(saved);
    state.commentEditing.add(journal.id);
    render();
    toast(error.message, true);
  } finally {
    state.pending = false;
  }
}

async function askDeleteComment(journal) {
  const yes = await confirmDialog({
    title: "수퍼비전 댓글을 지울까요?",
    message: "이 댓글을 지우면 되돌릴 수 없습니다.",
    confirmText: "삭제",
  });
  if (yes) await saveComment(journal, "");
}

/* ---------- 이 일지에서 추출된 관찰 ---------- */

/**
 * 추출 결과는 일지마다 따로 불러온다.
 * 목록을 열 때 전부 불러오면 일지 수만큼 요청이 나가므로,
 * 보겠다고 누른 것만 가져온다. 방금 저장한 일지는 자동으로 펼쳐 둔다.
 */
/* ---------- 봉사일지 (모달) ---------- */

/**
 * 봉사일지를 새로 쓴다. 모달이 저장까지 끝내고 만들어진 일지를 준다.
 * preset 은 미작성 목록에서 왔을 때만 온다 — 날짜·사람이 정해진 채로 열린다.
 */
async function writeVolunteerJournal(preset) {
  const journal = await openVolunteerJournal(preset);
  if (!journal) return;

  // 지금 거른 목록(달·기간·역할·이름)에 드는 것만 넣는다. 안 들면 저장만 알린다.
  if (matchesView(journal)) {
    state.journals.push(journal);
    trackNew(journal);
    sortJournals();
    render();
  } else {
    toast("저장했습니다 — 지금 걸어 둔 조건 밖이라 목록에는 안 보입니다.");
  }
  loadMissing();

  // 저장은 끝났다. 분석은 AI 왕복이라 기다리지 않고 이어서 돌린다.
  analyzeAfterSave(journal.id);
}

/**
 * 저장 직후 분석 — 관찰 먼저, 자원 다음. 둘 중 하나라도 실패하면 스낵바로도 알린다
 * (저장 알림만 보고 지나치지 않게). 실패 내용은 카드에 남는다(PC 만 — 봉사자 폰은 분석을 보이지 않는다).
 */
async function analyzeAfterSave(journalId) {
  await runExtract(journalId);
  await runResourceExtract(journalId);
  const failed = state.extracts.get(journalId)?.status === "error" ||
    state.resources.get(journalId)?.status === "error";
  if (failed) {
    toast("일지는 저장했지만 AI 분석은 하지 못했습니다 — 카드 아래 '미분석'을 눌러 다시 시도해 주세요.", true);
  }
}

/** 이미 쓴 봉사일지의 내용을 고친다. 날짜·작성자·시각은 일정이 정한다. */
async function reviseVolunteerJournal(journal) {
  const saved = await editVolunteerJournal(journal);
  if (!saved) return;

  const index = state.journals.findIndex((item) => item.id === journal.id);
  if (index >= 0) state.journals[index] = saved;
  render();
}

function renderExtract(journal) {
  const box = document.createElement("div");
  box.className = "extract";

  const entry = state.extracts.get(journal.id);

  // 탭을 누르면 곧바로 불러오므로 여기 오는 일은 드물다
  if (!entry) {
    const note = document.createElement("p");
    note.className = "extract__note";
    note.textContent = "불러오는 중…";
    box.append(note);
    return box;
  }

  // 분석 중. 이 카드만 잠근다 — 다른 일지는 그동안에도 분석을 걸 수 있다.
  if (entry.status === "loading") {
    const p = document.createElement("p");
    p.className = "extract__note";
    p.textContent = entry.message ?? "관찰 분석 중…";

    const running = button("분석 중…", "linkbtn", () => {});
    running.disabled = true;

    box.append(p, running);
    // 이전에 뽑아 둔 것이 있으면 그대로 보여 준다. 기다리는 동안 화면이 비지 않게.
    if (entry.items?.length) box.append(renderExtractList(journal, entry));
    return box;
  }

  // 실패. 카드에 남겨 둔다 — 스낵바는 곧 사라지고, 여러 개를 함께 돌리면
  // 어느 일지가 실패했는지 알 수 없다.
  if (entry.status === "error") {
    const p = document.createElement("p");
    p.className = "extract__note extract__note--error";
    p.textContent = `관찰 분석에 실패했습니다. ${entry.message}`;

    box.append(p, button("다시 시도", "linkbtn", () => runExtract(journal.id)));
    // 이미 뽑아 둔 것은 그대로다. 실패했다고 지워 버리지 않는다.
    if (entry.items?.length) box.append(renderExtractList(journal, entry));
    return box;
  }

  if (entry.items.length === 0) {
    const p = document.createElement("p");
    p.className = "extract__note";
    // 저장된 것이 없다는 것과 AI 가 못 찾았다는 것은 다르다.
    // 직접 넣은 일지는 분석을 한 번도 안 돌렸을 수 있다.
    p.textContent = entry.ran
      ? "이 일지에서는 특정 아동에 대한 관찰을 찾지 못했습니다."
      : "아직 분석하지 않은 일지입니다. 저장된 관찰이 없습니다.";
    box.append(
      p,
      button(entry.ran ? "다시 분석" : "분석하기", "linkbtn", () => runExtract(journal.id)),
    );
    return box;
  }

  // 갈린 것이 있으면 먼저 고르게 한다. 목록은 그 아래에 그대로 둔다.
  if (entry.diff) {
    box.append(
      renderDiff(journal.id, observationDiffRows(entry.diff), entry.choices, () => applyDiff(journal.id)),
    );
  }

  box.append(renderExtractList(journal, entry));
  box.append(button("다시 분석", "linkbtn", () => runExtract(journal.id)));
  return box;
}

/**
 * 뽑힌 관찰 목록. 분석 중·실패했을 때도 이미 있던 것을 그대로 보여주려고 따로 뒀다.
 */
function renderExtractList(journal, entry) {
  const wrap = document.createElement("div");

  const list = document.createElement("ul");
  list.className = "extract__list";
  for (const item of entry.items) {
    list.append(renderExtractItem(journal, item));
  }
  wrap.append(list);

  // 합치는 방법은 보이지 않는 조작이라 한 줄로 알린다.
  // 끌어 놓기는 마우스로만 된다 — 터치 화면에서는 조용히 안 되는 대신 PC 에서 하라고 알린다.
  if (entry.items.length > 1) {
    const how = document.createElement("p");
    how.className = "extract__note mouse-only";
    how.textContent = "관찰을 끌어 같은 아동의 다른 관찰 위에 놓으면 합칩니다.";
    const pc = document.createElement("p");
    pc.className = "extract__note touch-only";
    pc.textContent = "관찰 합치기는 PC에서 할 수 있어요. 수정·나누기·삭제는 여기서도 됩니다.";
    wrap.append(how, pc);
  }

  // 여기 있는 것은 아직 후보다 — 어디서 관찰로 옮기는지 알린다(페르소나 리뷰: 화면만으로 몰랐다)
  const waiting = entry.items.filter((item) => !item.imported).length;
  if (waiting > 0) {
    const where = document.createElement("p");
    where.className = "extract__note";
    where.textContent = `"가져옴" 표시가 없는 ${waiting}건은 아직 관찰 후보입니다. ` +
      "아동 상세 › [날짜별 · 편집 →] › [일지에서 관찰 가져오기] 에서 그 아동의 관찰로 옮깁니다.";
    wrap.append(where);
  }

  // 저장하지 못한 항목이 있으면 왜 그런지 알린다
  if (entry.skipped?.length) {
    const note = document.createElement("p");
    note.className = "extract__note";
    note.textContent = `저장하지 않은 항목 ${entry.skipped.length}건: ${
      entry.skipped.join(" / ")
    }`;
    wrap.append(note);
  }
  return wrap;
}

/**
 * 추출된 관찰 한 줄.
 *
 * 보기 상태에서는 끌어서 합칠 수 있고 [수정] [나누기] [삭제] 가 붙는다.
 * 손보는 중이면 그 자리에 편집기가 대신 들어간다 — 목록과 편집을 겹쳐 두지 않는다.
 */
function renderExtractItem(journal, item) {
  const li = document.createElement("li");
  li.className = "extract__item";

  const pending = !item.child_id;
  if (pending) li.classList.add("extract__item--pending");

  const who = document.createElement("span");
  // "아동 확인 필요"는 영역 미지정과 같은 종류의 일이다 — 사람이 정해 줘야 끝난다.
  // 같은 뜻이면 같은 색을 쓴다.
  who.className = pending ? "tag tag--unset" : "tag tag--area";
  // 아동 이름은 사용자 입력이므로 textContent로만 넣는다
  who.textContent = pending ? "아동 확인 필요" : (item.child_name ?? "아동");

  // 영역은 여기서 보여주지 않는다. AI가 정하지 않기 때문.
  // 아동 쪽으로 가져온 뒤 사람이 지정한다.
  const tags = document.createElement("div");
  tags.className = "obs__tags";
  tags.append(who);

  // 이미 가져간 후보라는 것은 지우거나 합치기 전에 알아야 할 사실이다
  if (item.imported) {
    const taken = document.createElement("span");
    taken.className = "tag";
    taken.textContent = "가져옴";
    tags.append(taken);
  }

  // 사람이 손댄 후보. 다시 분석해도 이 줄은 그대로 남는다는 뜻이다.
  if (item.edited && !item.merged) {
    const edited = document.createElement("span");
    edited.className = "tag";
    edited.textContent = "직접 고침";
    explain(edited, "사람이 손댄 관찰입니다. 다시 분석해도 그대로 남습니다.");
    tags.append(edited);
  }

  // 다른 관찰에 합쳐진 후보. 다시 가져오면 같은 내용이 두 번 들어간다.
  if (item.merged) {
    const merged = document.createElement("span");
    merged.className = "tag tag--gone";
    merged.textContent = "합쳐짐";
    explain(merged, "이 관찰은 다른 관찰에 합쳐졌습니다. 다시 가져올 수 없습니다.");
    tags.append(merged);
  }

  const mode = state.obsEditing?.id === item.id ? state.obsEditing.mode : null;

  if (mode === "content") {
    li.append(
      tags,
      renderContentEditor({
        value: state.obsDraft.keep,
        onInput: (value) => {
          state.obsDraft.keep = value;
        },
        onSave: () => saveExtractContent(journal.id, item.id),
        onCancel: closeObsEditorAndRender,
      }),
    );
    return li;
  }

  if (mode === "split") {
    li.append(
      tags,
      renderSplitEditor({
        hint: "원글에서 떼어낼 부분을 잘라 아래에 붙여 넣으세요. " +
          "새 후보는 같은 일지·같은 아동으로 추가되고, 아직 [관찰 가져오기] 전 상태입니다.",
        keepValue: state.obsDraft.keep,
        newValue: state.obsDraft.fresh,
        onKeepInput: (value) => {
          state.obsDraft.keep = value;
        },
        onNewInput: (value) => {
          state.obsDraft.fresh = value;
        },
        onSave: () => saveExtractSplit(journal.id, item.id),
        onCancel: closeObsEditorAndRender,
      }),
    );
    return li;
  }

  const text = document.createElement("p");
  text.className = "extract__content";
  text.textContent = item.content ?? "";

  const actions = document.createElement("div");
  actions.className = "obs__actions";
  actions.append(
    button("수정", "linkbtn", () => openObsEditor(item, "content")),
    button("나누기", "linkbtn", () => openObsEditor(item, "split")),
    button("삭제", "linkbtn linkbtn--danger", () => askDeleteExtract(journal.id, item)),
  );

  li.append(tags, text);
  if (pending) li.append(renderChildPicker(journal, item));
  li.append(actions);

  // 아동을 아직 못 정한 후보는 끌 수 없다. 서로 다른 아이일 수 있어서다.
  // 같은 일지 안이므로 날짜는 저절로 같다. 아동만 같으면 합칠 수 있다.
  attachMergeDrag(li, {
    id: item.id,
    key: `${journal.id} ${item.child_id}`,
    disabled: pending,
    onMerge: (fromId) => askMergeExtract(journal.id, fromId, item),
  });

  return li;
}

/**
 * 아동을 못 가린 후보에 아동을 고르는 줄.
 *
 * 후보를 먼저 버튼으로 보여 준다. 대개 둘 중 하나라 한 번에 끝난다.
 * 그래도 아니면 명단 전체에서 고른다 — 표기가 잘못 적혔을 수도 있고,
 * 그 판단은 일지를 쓴 사람의 몫이지 기계가 만든 후보 목록의 몫이 아니다.
 */
/**
 * "이름 (학년)". 같은 이름을 쓰는 아이가 둘이면 이름만으로는 고를 수 없다.
 * 명단을 못 읽었으면 이름만 쓴다 — 없는 학년을 지어내지 않는다.
 */
function childLabel(id, name) {
  const child = state.children.find((one) => one.id === id);
  const grade = child ? gradeLabel(child.birth_date) : "-";
  return grade === "-" ? name : `${name} (${grade})`;
}

/** 후보를 버튼으로 늘어놓을 최대 인원. 넘으면 드롭다운만 준다. */
const PENDING_BUTTON_MAX = 5;

function renderChildPicker(journal, item) {
  const wrap = document.createElement("div");
  wrap.className = "pending";

  // 이름이 통째로 가려진 표기("00이가")는 후보가 반 전체가 된다.
  // 그걸 버튼으로 늘어놓으면 고르기가 더 어려워지므로, 몇 명 안 될 때만 버튼을 준다.
  const few = item.pending.length > 0 && item.pending.length <= PENDING_BUTTON_MAX;

  const note = document.createElement("p");
  note.className = "pending__note";
  note.textContent = few
    ? "일지에 적힌 표기가 아래 아동과 모두 맞습니다. 누구인지 골라 주세요."
    : "어느 아동인지 가리지 못했습니다. 명단에서 골라 주세요.";
  wrap.append(note);

  const row = document.createElement("div");
  row.className = "pending__row";

  // 동명이인이 후보면 이름만으로는 고를 수 없다. 학년을 함께 적어 갈라 준다.
  if (few) {
    for (const child of item.pending) {
      row.append(
        button(childLabel(child.id, child.name), "btn btn--small", () =>
          assignChild(journal.id, item.id, child)),
      );
    }
  }

  // 명단 전체. 후보가 아닌 아이를 골라야 할 때 쓴다.
  const select = document.createElement("select");
  select.className = "input pending__select";
  select.setAttribute("aria-label", "명단에서 아동 고르기");
  fillOptions(select, [
    { value: "", label: "명단에서 고르기…" },
    ...state.children.map((child) => ({
      value: child.id,
      label: childLabel(child.id, child.name),
    })),
  ]);
  select.addEventListener("change", () => {
    const child = state.children.find((one) => one.id === select.value);
    select.value = "";
    if (child) assignChild(journal.id, item.id, child);
  });

  row.append(select);
  wrap.append(row);
  return wrap;
}

/* ---------- 추출된 관찰 손보기 ---------- */

function openObsEditor(item, mode) {
  state.obsEditing = { id: item.id, mode };
  state.obsDraft = { keep: item.content ?? "", fresh: "" };
  render();
}

function closeObsEditor() {
  state.obsEditing = null;
  state.obsDraft = { keep: "", fresh: "" };
}

function closeObsEditorAndRender() {
  closeObsEditor();
  render();
}

/** 그 일지의 추출 결과를 통째로 복사해 둔다. 실패하면 이 값으로 되돌린다. */
function snapshotExtract(journalId) {
  const entry = state.extracts.get(journalId);
  return entry ? { ...entry, items: entry.items.map((item) => ({ ...item })) } : null;
}

function restoreExtract(journalId, saved) {
  if (saved) state.extracts.set(journalId, saved);
  renderFoot(journalId);
}

/** 그 일지의 추출 목록에서 한 건을 갈아 끼운다. */
function replaceExtractItem(journalId, next) {
  const entry = state.extracts.get(journalId);
  if (!entry) return;
  const index = entry.items.findIndex((item) => item.id === next.id);
  if (index >= 0) entry.items[index] = next;
}

/** 아동을 못 가린 후보에 아동을 정한다. */
async function assignChild(journalId, id, child) {
  if (state.pending) return;

  const entry = state.extracts.get(journalId);
  const item = entry?.items.find((row) => row.id === id);
  if (!item) return;

  const saved = snapshotExtract(journalId);
  state.pending = true;
  item.child_id = child.id;
  item.child_name = child.name;
  item.pending = [];
  renderFoot(journalId);

  try {
    const payload = await send(`/api/journal-observations/${id}`, "PATCH", {
      child_id: child.id,
    });
    replaceExtractItem(journalId, payload.observation);
    renderFoot(journalId);
    toast(`${child.name}${ro(child.name)} 정했습니다`);
  } catch (error) {
    restoreExtract(journalId, saved);
    toast(error.message, true);
  } finally {
    state.pending = false;
  }
}

async function saveExtractContent(journalId, id) {
  if (state.pending) return;

  const content = state.obsDraft.keep.trim();
  if (!content) {
    toast("내용을 입력해 주세요.", true);
    return;
  }

  const entry = state.extracts.get(journalId);
  const item = entry?.items.find((row) => row.id === id);
  if (!item) return;

  const saved = snapshotExtract(journalId);
  state.pending = true;
  item.content = content;
  closeObsEditor();
  renderFoot(journalId);

  try {
    const payload = await send(`/api/journal-observations/${id}`, "PATCH", { content });
    replaceExtractItem(journalId, payload.observation);
    renderFoot(journalId);
    toast("저장되었습니다");
  } catch (error) {
    restoreExtract(journalId, saved);
    toast(error.message, true);
  } finally {
    state.pending = false;
  }
}

async function saveExtractSplit(journalId, id) {
  if (state.pending) return;

  const keepContent = state.obsDraft.keep.trim();
  const newContent = state.obsDraft.fresh.trim();
  if (!keepContent || !newContent) {
    toast("원글과 새 관찰 내용을 모두 입력해 주세요.", true);
    return;
  }

  const entry = state.extracts.get(journalId);
  const item = entry?.items.find((row) => row.id === id);
  if (!item) return;

  const saved = snapshotExtract(journalId);
  const tempId = `temp-${crypto.randomUUID()}`;

  state.pending = true;
  item.content = keepContent;
  entry.items.push({
    id: tempId,
    journal_id: journalId,
    child_id: item.child_id,
    child_name: item.child_name,
    area: item.area,
    content: newContent,
    imported: false,
    // 아동을 못 가린 후보를 나누면 새로 생긴 쪽도 똑같이 못 가린 상태다
    pending: item.pending ?? [],
    merged: false,
  });
  closeObsEditor();
  renderFoot(journalId);

  try {
    const { original, created } = await send(
      `/api/journal-observations/${id}/split`,
      "POST",
      { keep_content: keepContent, new_content: newContent },
    );
    replaceExtractItem(journalId, original);
    const index = entry.items.findIndex((row) => row.id === tempId);
    if (index >= 0) entry.items[index] = created;
    renderFoot(journalId);
    toast("관찰을 나눴습니다");
  } catch (error) {
    restoreExtract(journalId, saved);
    toast(error.message, true);
  } finally {
    state.pending = false;
  }
}

/**
 * 끌어온 관찰(from)을 놓인 관찰(to)에 합친다.
 *
 * 둘 다 이미 가져간 후보면 근거를 옮길 수 없다 — 한 후보는 한 번만 가져올 수 있어서다.
 * 그때는 가져간 관찰의 근거가 끊기므로 미리 알린다.
 */
async function askMergeExtract(journalId, fromId, to) {
  if (state.pending) return;

  const entry = state.extracts.get(journalId);
  const from = entry?.items.find((item) => item.id === fromId);
  if (!from) return;

  const notes = [];
  if (from.imported && to.imported) {
    notes.push(
      "",
      "두 관찰 모두 이미 아동 관찰로 가져갔습니다.",
      "가져간 관찰 1건은 남지만, 그 근거가 끊겨 \"근거 바뀜\"으로 표시됩니다.",
    );
  } else if (from.imported) {
    notes.push("", "가져간 관찰 1건의 근거는 합쳐진 쪽으로 옮겨집니다.");
  }

  const content = await confirmMerge({
    keepText: to.content,
    fromText: from.content,
    notes,
  });
  if (content) await mergeExtract(journalId, fromId, to.id, content);
}

async function mergeExtract(journalId, fromId, toId, content) {
  const entry = state.extracts.get(journalId);
  const saved = snapshotExtract(journalId);

  state.pending = true;
  entry.items = entry.items.filter((item) => item.id !== fromId);
  const keep = entry.items.find((item) => item.id === toId);
  if (keep) keep.content = content;
  renderFoot(journalId);

  try {
    const payload = await send(`/api/journal-observations/${toId}/merge`, "POST", {
      from: fromId,
      content,
    });
    replaceExtractItem(journalId, payload.observation);
    renderFoot(journalId);
    toast(
      payload.orphaned > 0
        ? `합쳤습니다 · 가져간 관찰 ${payload.orphaned}건의 근거가 끊겼습니다`
        : "두 관찰을 합쳤습니다",
      payload.orphaned > 0,
    );
  } catch (error) {
    restoreExtract(journalId, saved);
    toast(error.message, true);
  } finally {
    state.pending = false;
  }
}

/**
 * 지우기 전에 묻는다.
 *
 * 이미 가져간 후보면 그 관찰은 남고 근거만 없어진다.
 * 모르고 지우면 나중에 왜 "근거 바뀜" 표시가 붙었는지 알 수 없다.
 */
async function askDeleteExtract(journalId, item) {
  if (state.pending) return;

  const lines = [
    item.content.length > 40 ? `${item.content.slice(0, 40)}…` : item.content,
    "이 추출 관찰을 지웁니다. 되돌릴 수 없습니다.",
  ];
  if (item.imported) {
    lines.push(
      "",
      "이미 가져간 관찰 1건의 근거가 없어집니다.",
      "그 관찰은 지워지지 않고 남지만 \"근거 바뀜\" 표시가 붙습니다.",
    );
  }

  const yes = await confirmDialog({
    title: "추출 관찰을 삭제할까요?",
    message: lines.join("\n"),
    confirmText: "삭제",
  });
  if (yes) await deleteExtract(journalId, item);
}

async function deleteExtract(journalId, item) {
  const entry = state.extracts.get(journalId);
  const saved = snapshotExtract(journalId);

  state.pending = true;
  entry.items = entry.items.filter((row) => row.id !== item.id);
  renderFoot(journalId);

  try {
    const payload = await remove(`/api/journal-observations/${item.id}`);
    toast(
      payload.orphaned > 0
        ? `삭제했습니다 · 가져간 관찰 ${payload.orphaned}건의 근거가 없어졌습니다`
        : "추출 관찰을 삭제했습니다",
      payload.orphaned > 0,
    );
  } catch (error) {
    restoreExtract(journalId, saved);
    toast(error.message, true);
  } finally {
    state.pending = false;
  }
}

/** 이미 저장돼 있는 추출 결과를 불러온다 (AI를 부르지 않는다) */
async function loadExtract(journalId) {
  closeObsEditor(); // 목록이 통째로 갈리므로 손보던 편집기는 닫는다
  state.extracts.set(journalId, { status: "loading", message: "불러오는 중…" });
  renderFoot(journalId);

  try {
    const payload = await get(`/api/journals/${journalId}/observations`);
    state.extracts.set(journalId, {
      status: "done",
      ran: false, // 저장된 것을 읽었을 뿐, AI 를 돌린 것은 아니다
      items: payload.observations ?? [],
      skipped: [],
    });
  } catch (error) {
    // 불러오기가 실패해도 [다시 시도] 를 눌러 다시 읽을 수 있다.
    // 이 자리에서 [다시 시도] 는 AI 를 부르므로 크레딧을 쓴다는 점만 다르다.
    state.extracts.set(journalId, { status: "error", message: error.message, items: [] });
  }
  renderFoot(journalId);
}

/** AI로 다시 뽑는다. 크레딧을 쓰므로 누를 때만 돈다. */
async function runExtract(journalId) {
  const before = state.extracts.get(journalId);

  // 같은 일지에 두 번 걸지 않는다. 다른 일지는 얼마든지 함께 돌 수 있다 —
  // 결과는 일지마다 따로 담기고(state.extracts), 끝나는 대로 그 카드만 갱신된다.
  if (before?.status === "loading") return;

  // 이 일지의 편집기만 닫는다. 다른 카드에서 고쳐 쓰던 것을 건드리지 않게.
  if (state.obsEditing && before?.items?.some((item) => item.id === state.obsEditing.id)) {
    closeObsEditor();
  }

  state.extracts.set(journalId, {
    status: "loading",
    message: "관찰 분석 중…",
    // 다시 분석이 끝날 때까지 이전 결과를 들고 있는다.
    // 실패하면 그대로 되돌려, 보고 있던 것이 조용히 사라지지 않게 한다.
    items: before?.items ?? [],
    ran: before?.ran,
  });
  renderFoot(journalId);

  try {
    const payload = await send(`/api/journals/${journalId}/extract`, "POST", {});

    // 서버는 새로 나온 것만 넣고, 갈린 것(changed·missing)은 손대지 않은 채 알려 준다.
    // 그래서 목록을 다시 읽어야 지금 저장된 그대로가 보인다.
    const listed = await get(`/api/journals/${journalId}/observations`)
      .then((res) => res.observations ?? [])
      .catch(() => []);

    const changed = payload.changed ?? [];
    const missing = payload.missing ?? [];
    const hasDiff = changed.length > 0 || missing.length > 0;

    state.extracts.set(journalId, {
      status: "done",
      ran: true,
      items: listed,
      skipped: payload.skipped ?? [],
      diff: hasDiff ? { changed, missing } : null,
      choices: new Map(),
    });
    markCounted(journalId, "obs", listed.length);

    // 아동을 못 가린 건이 있으면 그냥 두면 안 된다. 사람이 골라야 끝난다.
    // 손대 둔 것을 남겨 두었다면 그것도 알린다 — 그 아이의 관찰이 안 바뀐 이유다.
    const lines = [];
    if (payload.added?.length) lines.push(`새로 ${payload.added.length}건`);
    if (hasDiff) lines.push(`고를 것 ${changed.length + missing.length}건`);
    if (payload.kept > 0) lines.push(`남겨 둔 것 ${payload.kept}건`);
    if (payload.pending > 0) lines.push(`아동 확인 필요 ${payload.pending}건`);

    toast(
      lines.length === 0 ? "변경 없음" : lines.join(" · "),
      hasDiff || payload.pending > 0,
    );
  } catch (error) {
    // 분석만 실패했다. 일지도, 이미 뽑아 둔 관찰도 그대로다.
    // 그 사실을 카드에 남겨 둔다 — 스낵바는 곧 사라지고, 여러 개를 함께 돌리면
    // 어느 일지가 실패했는지 알 수 없게 된다.
    state.extracts.set(journalId, {
      status: "error",
      message: error.message,
      items: before?.items ?? [],
      ran: before?.ran,
    });
  }
  renderFoot(journalId);
}

/* ---------- 다시 분석한 결과 고르기 ---------- */

/**
 * 다시 분석해 갈린 것들을 카드 안에서 고르게 한다.
 *
 * 예전에는 조용히 갈아 끼웠다. AI 는 부를 때마다 말을 조금씩 다르게 쓰기 때문에,
 * 멀쩡하던 문장이 소리 없이 다른 문장이 되었고 무엇이 바뀌었는지 알 수 없었다.
 * 이제 달라진 것만 나란히 놓고 건별로 고른다.
 *
 * 고르지 않고 두면 아무 일도 일어나지 않는다 — 지금 저장된 것이 그대로 남는다.
 * 그래서 창을 닫거나 새로고침해도 잃는 것이 없다.
 *
 * 관찰과 자원이 같은 모양을 쓴다. 무엇을 견주는지(문장이냐 카테고리냐)만 다르고
 * 사람이 하는 일은 같아서, 화면 조각을 두 벌 두지 않는다.
 * rows 는 [{ id, tag, note, sides: [{ key, label, text }] }] 모양이다.
 */
function renderDiff(journalId, rows, choices, onApply) {
  const box = document.createElement("div");
  box.className = "diff";

  const head = document.createElement("p");
  head.className = "diff__head";
  head.textContent = "다시 분석한 결과가 지금과 다릅니다. 어느 쪽을 둘지 골라 주세요.";
  box.append(head);

  for (const row of rows) box.append(renderDiffRow(journalId, row, choices));

  const actions = document.createElement("div");
  actions.className = "form__actions";
  actions.append(
    button("고른 대로 저장", "btn btn--primary", () => onApply()),
    button("모두 기존 유지", "btn", () => {
      // 아무것도 안 바꾸고 비교만 닫는다. 고르기 전 상태가 곧 "기존 유지" 다.
      for (const row of rows) choices.set(row.id, row.sides[0].key);
      onApply();
    }),
  );
  box.append(actions);
  return box;
}

/** 이름표 한 개 */
function diffTag(text, className = "tag") {
  const node = document.createElement("span");
  node.className = className;
  node.textContent = text;
  return node;
}

/** 한 건. 고를 것들을 나란히 놓는다. 좁은 화면에서는 위아래로 접힌다(CSS). */
function renderDiffRow(journalId, row, choices) {
  const node = document.createElement("div");
  node.className = "diff__row";

  const tags = document.createElement("div");
  tags.className = "obs__tags";
  tags.append(diffTag(row.tag, "tag tag--area"), diffTag(row.note, "tag tag--stale"));
  node.append(tags);

  if (row.subject) {
    const subject = document.createElement("p");
    subject.className = "extract__content";
    subject.textContent = row.subject;
    node.append(subject);
  }

  const pair = document.createElement("div");
  pair.className = "diff__pair";

  const picked = choices.get(row.id) ?? row.sides[0].key;
  for (const side of row.sides) {
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = picked === side.key ? "diff__side is-picked" : "diff__side";
    cell.setAttribute("aria-pressed", String(picked === side.key));

    const label = document.createElement("span");
    label.className = "diff__label";
    label.textContent = side.label;
    cell.append(label);

    if (side.text !== undefined) {
      const text = document.createElement("span");
      text.className = "diff__text";
      // 내용은 사용자·AI 가 쓴 글이므로 textContent 로만 넣는다
      text.textContent = side.text;
      cell.append(text);
    }

    cell.addEventListener("click", () => {
      choices.set(row.id, side.key);
      renderFoot(journalId);
    });
    pair.append(cell);
  }

  node.append(pair);
  return node;
}

/** 관찰 비교를 화면 조각이 읽을 수 있는 줄로 바꾼다. */
function observationDiffRows(diff) {
  return [
    ...diff.changed.map((one) => ({
      id: one.id,
      tag: one.child_name ?? "아동 확인 필요",
      note: "내용이 달라짐",
      sides: [
        { key: "current", label: "기존 유지", text: one.current },
        { key: "proposed", label: "새 것으로", text: one.proposed },
      ],
    })),
    ...diff.missing.map((one) => ({
      id: one.id,
      tag: one.child_name ?? "아동 확인 필요",
      note: "이번 분석에선 안 나옴",
      subject: one.content,
      sides: [
        { key: "current", label: "유지" },
        { key: "remove", label: "삭제" },
      ],
    })),
  ];
}

/** 자원 비교를 화면 조각이 읽을 수 있는 줄로 바꾼다. */
function resourceDiffRows(diff) {
  const label = (value) => value ?? "카테고리 없음";
  return [
    ...diff.changed.map((one) => ({
      id: one.id,
      tag: one.resource_name,
      note: "카테고리가 달라짐",
      sides: [
        { key: "current", label: "기존 유지", text: label(one.current) },
        { key: "proposed", label: "새 것으로", text: label(one.proposed) },
      ],
    })),
    ...diff.missing.map((one) => ({
      id: one.id,
      tag: one.resource_name,
      note: "이번 분석에선 안 나옴",
      sides: [
        { key: "current", label: "유지" },
        { key: "remove", label: "삭제" },
      ],
    })),
  ];
}

/** 고른 대로 서버에 보낸다. 아무것도 안 고른 것은 "기존 유지" 다. */
async function applyDiff(journalId) {
  if (state.pending) return;

  const entry = state.extracts.get(journalId);
  if (!entry?.diff) return;

  const replace = entry.diff.changed
    .filter((one) => entry.choices.get(one.id) === "proposed")
    .map((one) => ({ id: one.id, content: one.proposed }));

  const remove = entry.diff.missing
    .filter((one) => entry.choices.get(one.id) === "remove")
    .map((one) => one.id);

  if (replace.length === 0 && remove.length === 0) {
    entry.diff = null;
    renderFoot(journalId);
    toast("기존 내용을 그대로 두었습니다");
    return;
  }

  const saved = snapshotExtract(journalId);
  state.pending = true;

  try {
    const payload = await send(`/api/journals/${journalId}/resolve`, "POST", { replace, remove });
    state.extracts.set(journalId, {
      status: "done",
      ran: true,
      items: payload.observations ?? [],
      skipped: [],
      diff: null,
      choices: new Map(),
    });
    markCounted(journalId, "obs", payload.observations?.length ?? 0);
    renderFoot(journalId);
    toast(`${replace.length}건 교체 · ${remove.length}건 삭제`);
  } catch (error) {
    restoreExtract(journalId, saved);
    toast(error.message, true);
  } finally {
    state.pending = false;
  }
}

/** 자원 쪽 고르기 결과를 보낸다. 관찰과 같은 흐름이고 보내는 값만 카테고리다. */
async function applyResourceDiff(journalId) {
  if (state.pending) return;

  const entry = state.resources.get(journalId);
  if (!entry?.diff) return;

  const replace = entry.diff.changed
    .filter((one) => entry.choices.get(one.id) === "proposed")
    .map((one) => ({ id: one.id, category: one.proposed }));

  const remove = entry.diff.missing
    .filter((one) => entry.choices.get(one.id) === "remove")
    .map((one) => one.id);

  if (replace.length === 0 && remove.length === 0) {
    entry.diff = null;
    renderFoot(journalId);
    toast("기존 내용을 그대로 두었습니다");
    return;
  }

  state.pending = true;
  try {
    const payload = await send(`/api/journals/${journalId}/resolve-resources`, "POST", {
      replace,
      remove,
    });
    state.resources.set(journalId, {
      ...entry,
      status: "done",
      items: payload.records ?? [],
      diff: null,
      choices: new Map(),
    });
    markCounted(journalId, "res", payload.records?.length ?? 0);
    renderFoot(journalId);
    toast(`${replace.length}건 교체 · ${remove.length}건 삭제`);
  } catch (error) {
    toast(error.message, true);
  } finally {
    state.pending = false;
  }
}

/* ---------- 미분석 일괄 분석 ---------- */

/**
 * 한 번에 몇 개까지 함께 돌릴지.
 *
 * 한꺼번에 다 보내면 AI 쪽에 몰려 요청 제한에 걸리고, 실패가 무더기로 난다.
 * 하나씩 보내면 서른 건에 십 분이 걸린다. 그 사이를 잡는다.
 */
const BATCH_AT_ONCE = 2;

/**
 * 보고 있는 달에서 아직 분석하지 않은 일지. 관찰이든 자원이든 하나라도 안 됐으면 대상.
 * 화면에 불러온 쪽이 아니라 한 달 전체(서버 요약)가 기준이다.
 */
function unanalyzedJournals() {
  return state.unanalyzed.filter((journal) =>
    !isTemp(journal.id) && (!journal.observations_analyzed || !journal.resources_analyzed)
  );
}

function syncBatchButton() {
  const targets = unanalyzedJournals();
  const running = !!state.batch;

  el.batch.disabled = running || targets.length === 0;
  el.batch.textContent = running
    ? `분석 중… ${state.batch.done}/${state.batch.total}`
    : targets.length === 0
    ? "모두 분석됨"
    : `미분석 일괄 분석 ${targets.length}`;

  if (!running) {
    el.batchState.hidden = true;
    return;
  }
  el.batchState.hidden = false;
  el.batchState.textContent = `${state.batch.done}/${state.batch.total} 분석 중…` +
    (state.batch.failed > 0 ? ` (실패 ${state.batch.failed}건)` : "");
}

/**
 * 안 돌린 일지를 차례로 분석한다. 관찰과 자원을 함께 돌린다 —
 * 일지를 저장할 때도 둘 다 도는 파이프라인이라 따로 나눌 이유가 없다.
 *
 * 중간에 실패해도 멈추지 않는다. 그 카드에 실패가 남고([다시 시도]가 붙는다),
 * 끝에 몇 건이 되고 안 됐는지 한 줄로 알린다.
 */
async function runBatch() {
  if (state.batch) return;

  const targets = unanalyzedJournals();
  if (targets.length === 0) return;

  const yes = await confirmDialog({
    title: "미분석 일지를 모두 분석할까요?",
    message: `${viewLabel()} · ${targets.length}건\n` +
      "일지 한 건마다 AI 를 두 번 부릅니다(관찰·자원). 시간과 크레딧이 듭니다.",
    confirmText: "분석 시작",
    danger: false,
  });
  if (!yes) return;

  state.batch = { total: targets.length, done: 0, failed: 0 };
  syncBatchButton();

  const queue = [...targets];

  /** 한 줄 일꾼. 큐가 빌 때까지 하나씩 꺼내 돌린다. */
  const worker = async () => {
    for (;;) {
      const journal = queue.shift();
      if (!journal) return;

      // 이미 된 쪽은 다시 돌리지 않는다. 크레딧을 아끼고, 사람이 손본 것도 건드리지 않는다.
      const jobs = [];
      if (!journal.observations_analyzed) jobs.push(runExtract(journal.id));
      if (!journal.resources_analyzed) jobs.push(runResourceExtract(journal.id));

      const results = await Promise.allSettled(jobs);
      const failed = results.some((one) =>
        one.status === "rejected" ||
        state.extracts.get(journal.id)?.status === "error" ||
        state.resources.get(journal.id)?.status === "error"
      );

      if (state.batch) {
        state.batch.done += 1;
        if (failed) state.batch.failed += 1;
        syncBatchButton();
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(BATCH_AT_ONCE, targets.length) }, worker),
  );

  const { total, failed } = state.batch;
  state.batch = null;

  // 개수 표시는 목록에서 온다. 다 돌린 뒤 한 번 다시 읽어 카드의 숫자를 맞춘다.
  await loadJournals();

  toast(
    failed === 0
      ? `${total}건을 모두 분석했습니다`
      : `${total}건 중 ${total - failed}건 완료 · ${failed}건 실패`,
    failed > 0,
  );
}

/* ---------- 작성 / 수정 화면 ---------- */

/**
 * 작성 화면을 연다.
 *
 * preset 은 미작성 알림에서 넘어올 때만 온다.
 * 그 날짜·그 사람으로 미리 채워 두어, 누가 언제 온 날인지 다시 고르지 않게 한다.
 */
function openCreate(preset = null) {
  // 봉사일지는 일정에 매여 있어 규칙이 다르다. 전용 모달이 맡는다.
  if (config(state.kind).modal) {
    writeVolunteerJournal(preset);
    return;
  }

  state.formMode = "create";
  state.editing = null;

  el.heading.textContent = `${config(state.kind).title} 작성`;
  el.sub.textContent = monthLabel(state.month);

  // 이번 달을 보고 있으면 오늘, 아니면 그 달의 첫날
  const { from, to } = monthRange(state.month);
  const today = todayISO();
  el.date.value = preset?.sched_date ?? (today >= from && today <= to ? today : from);
  el.date.min = from;
  el.date.max = to;
  el.date.disabled = false;

  el.formTitle.value = "";
  el.formContent.value = "";
  fillAuthorOptions();
  // 작성자 — 넓은 화면은 고른다(대리 작성 가능, 처음 값은 본인). 좁은 화면은 칸 없이 본인:
  // author_id 를 안 보내면 서버가 세션으로 정한다.
  state.authorFixed = NARROW.matches;
  el.authorField.hidden = state.authorFixed;
  if (state.me && state.staff.some((person) => person.id === state.me.id)) el.author.value = state.me.id;
  state.formInitial = journalFormValues();

  leaveList();
  focusContent();
}

/**
 * 본문 칸에 초점. 좁은 화면에서는 하지 않는다 — 들어오자마자 키보드가 올라와
 * 위(날짜·안내)가 가려진다. 사람이 위에서부터 보고 고른다.
 */
function focusContent() {
  if (!NARROW.matches) el.formContent.focus();
}

function openEdit(journal) {
  if (config(state.kind).modal) {
    reviseVolunteerJournal(journal);
    return;
  }

  state.formMode = "edit";
  state.editing = journal;

  el.heading.textContent = `${config(state.kind).title} 수정`;
  // 날짜·작성자까지 모두 고칠 수 있다. 잘못 고른 채로 저장한 것을 되돌릴 길이 있어야 한다.
  el.sub.textContent = "날짜·작성자·제목·내용을 모두 고칠 수 있습니다.";

  el.date.value = journal.journal_date;
  el.date.disabled = false;

  fillAuthorOptions();
  el.author.value = journal.author_id ?? "";
  state.authorFixed = false;
  el.authorField.hidden = false;

  el.formTitle.value = journal.title ?? "";
  el.formContent.value = journal.content ?? "";
  state.formInitial = journalFormValues();

  leaveList();
  focusContent();
}

/**
 * 작성자 후보를 채운다.
 *
 * 봉사일지에서 그 날 일정이 있으면 그 사람들만 보여준다. 대개 그 중 하나다.
 * 한 사람이 하루에 두 번 오면 두 줄이 되므로 시각을 함께 적어 구분한다.
 * 일정이 없는 날이면 전체 명단으로 넘어간다.
 */
function fillAuthorOptions() {
  if (state.staff.length === 0) {
    fillOptions(el.author, [{ value: "", label: "등록된 사람이 없습니다" }]);
    el.author.disabled = true;
    return;
  }

  el.author.disabled = false;
  fillOptions(
    el.author,
    state.staff.map((person) => ({ value: person.id, label: person.name })),
  );
}

/** 지금 작성자. 좁은 화면 새 작성은 본인(서버가 정한다), 그 밖에는 명단에서 고른 사람. */
function selectedAuthor() {
  if (state.formMode === "create" && state.authorFixed) {
    return { id: state.me?.id ?? null, name: state.me?.name ?? null };
  }
  const value = el.author.value;
  const person = state.staff.find((item) => item.id === value);
  return { id: value || null, name: person?.name ?? null };
}

/* ---------- 저장 (낙관적 갱신) ---------- */

function isTemp(id) {
  return String(id).startsWith("temp-");
}

function snapshot() {
  return state.journals.map((journal) => ({ ...journal }));
}

function restore(saved) {
  state.journals = saved;
  render();
}

/**
 * 최신순(날짜 내림차순). 같은 날짜면 나중에 쓴 것이 위로 온다.
 *
 * 날짜만으로 정렬하면 그 날 방금 쓴 일지가 먼저 쓴 것들 아래로 밀려
 * "내가 방금 쓴 게 어디 갔지"가 된다. 서버도 같은 순서로 준다.
 * 아직 저장 전이라 created_at 이 없는 임시 줄은 가장 최근으로 본다.
 */
function sortJournals() {
  const writtenAt = (item) => item.created_at ?? "9999";
  state.journals.sort((a, b) => {
    if (a.journal_date !== b.journal_date) return a.journal_date > b.journal_date ? -1 : 1;
    const [x, y] = [writtenAt(a), writtenAt(b)];
    return x > y ? -1 : x < y ? 1 : 0;
  });
}

function submit(event) {
  event.preventDefault();
  if (state.pending) return;
  return state.formMode === "edit" ? saveEdit() : saveNew();
}

async function saveNew() {
  const journalDate = el.date.value;
  const author = selectedAuthor();
  const authorId = author.id;
  const title = el.formTitle.value.trim();
  const content = el.formContent.value.trim();

  if (!journalDate) {
    toast("날짜를 선택해 주세요.", true);
    return;
  }
  if (!content) {
    toast("내용을 입력해 주세요.", true);
    return;
  }

  const saved = snapshot();
  const tempId = `temp-${crypto.randomUUID()}`;
  const authorName = author.name;

  state.pending = true;
  el.submit.disabled = true;

  state.journals.push({
    id: tempId,
    kind: state.kind,
    journal_date: journalDate,
    author_id: authorId,
    author_name: authorName,
    title: title || null,
    content,
  });
  sortJournals();
  // 목록을 먼저 그려 두어야 돌아갈 때 자리가 남아 있다
  render();
  backToList();

  try {
    const { journal } = await send("/api/journals", "POST", {
      kind: state.kind,
      journal_date: journalDate,
      // 좁은 화면은 보내지 않는다 — 서버가 세션 본인으로 정한다
      ...(state.authorFixed ? {} : { author_id: authorId }),
      title: title || null,
      content,
    });
    const index = state.journals.findIndex((item) => item.id === tempId);
    if (index >= 0) state.journals[index] = journal;
    trackNew(journal);
    sortJournals();
    render();
    toast("저장되었습니다");

    // 방금 쓴 날은 미작성에서 빠져야 한다
    loadMissing();

    // 저장은 여기서 끝났다. 분석은 AI 왕복이라 시간이 걸리므로
    // 기다리지 않고 이어서 돌린다. 실패해도 일지는 이미 저장돼 있다.
    //
    // 관찰을 먼저, 자원을 그 다음에 돌린다. 관찰이 이 시스템의 본래 일이고,
    // 한꺼번에 보내면 화면에 분석 중 표시가 둘 떠서 무엇을 기다리는지 흐려진다.
    // AI 호출이 일지 하나에 두 번이라는 뜻이기도 하다. 자동 추출을 끄고
    // [추출된 자원 보기] 옆의 [다시 분석]으로만 돌리려면 아래 한 줄을 지우면 된다.
    analyzeAfterSave(journal.id);
  } catch (error) {
    // 목록은 되돌리되 작성 화면으로 되돌아간다.
    // 입력칸의 값은 그대로 남아 있으므로 쓰던 글을 잃지 않고 다시 저장할 수 있다.
    restore(saved);
    goToForm();
    toast(error.message, true);
  } finally {
    state.pending = false;
    el.submit.disabled = false;
  }
}

async function saveEdit() {
  const target = state.editing;
  if (!target) return;

  const journalDate = el.date.value;
  const author = selectedAuthor();
  const title = el.formTitle.value.trim();
  const content = el.formContent.value.trim();

  if (!journalDate) {
    toast("날짜를 선택해 주세요.", true);
    return;
  }
  if (!content) {
    toast("내용을 입력해 주세요.", true);
    return;
  }
  const saved = snapshot();
  const journal = state.journals.find((item) => item.id === target.id);
  if (!journal) return;

  state.pending = true;
  el.submit.disabled = true;

  journal.title = title || null;
  journal.content = content;
  journal.journal_date = journalDate;
  journal.author_id = author.id;
  journal.author_name = author.name;
  sortJournals();
  // 목록을 먼저 그려 두어야 돌아갈 때 자리가 남아 있다
  render();
  backToList();

  try {
    const payload = await send(`/api/journals/${target.id}`, "PATCH", {
      title: title || null,
      content,
      journal_date: journalDate,
      author_id: author.id,
    });
    const index = state.journals.findIndex((item) => item.id === target.id);
    if (index >= 0) state.journals[index] = payload.journal;
    sortJournals();
    render();
    toast("저장되었습니다");
  } catch (error) {
    // 목록은 되돌리되 작성 화면으로 되돌아간다.
    // 입력칸의 값은 그대로 남아 있으므로 쓰던 글을 잃지 않고 다시 저장할 수 있다.
    restore(saved);
    goToForm();
    toast(error.message, true);
  } finally {
    state.pending = false;
    el.submit.disabled = false;
  }
}

/* ---------- 이벤트 ---------- */

function goToMonth(month) {
  if (rangeActive()) {
    setView(month, "", "");
    return;
  }
  closePicker();
  state.month = month;
  el.monthInput.value = month;
  syncMonthPick();
  goToList();
  loadJournals();
}

/** 달과 기간을 한꺼번에 바꾼다(달·날짜 판). */
function setView(month, from, to) {
  closePicker();
  state.month = month;
  el.monthInput.value = month;
  state.filter.from = from;
  state.filter.to = to;
  applyFilter();
}

/**
 * 달·날짜(기간) 고르기 판 — 좁은 화면은 달 이름, 넓은 화면은 달력 아이콘이 연다.
 * 판은 달 이동 줄 바로 아래에 붙는다(넓은 화면은 그 자리에 떠 있게 — CSS). 다시 누르면 접힌다.
 */
async function openMonthPicker() {
  if (closePicker()) return;
  const [year, month] = state.month.split("-").map(Number);
  const on = rangeActive();
  const picked = await pickMonth(el.period, {
    year,
    month,
    from: on ? state.filter.from : null,
    to: on ? state.filter.to : null,
    withDay: true,
  });
  if (!picked) return;
  setView(`${picked.year}-${pad(picked.month)}`, picked.from ?? "", picked.to ?? "");
}
el.monthPick.addEventListener("click", openMonthPicker);
el.monthCal.addEventListener("click", openMonthPicker);

// [×] — 판이 열려 있으면 닫기만, 아니면 기간을 풀고 달 전체로
function clearRange() {
  if (closePicker()) return;
  setView(state.month, "", "");
}
el.monthPickClear.addEventListener("click", clearRange);
el.rangeClear.addEventListener("click", clearRange);

el.monthPrev.addEventListener("click", () => goToMonth(shiftMonth(state.month, -1)));
el.monthNext.addEventListener("click", () => goToMonth(shiftMonth(state.month, 1)));

// 통합 검색 — 치는 동안 잠깐 기다렸다가, Enter·칸 떠남이면 바로
el.q.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(readSearch, 350);
});
el.q.addEventListener("change", readSearch);
el.monthInput.addEventListener("change", () => {
  // 달 입력을 비우면 브라우저가 빈 문자열을 준다. 그때는 되돌린다.
  if (!el.monthInput.value) {
    el.monthInput.value = state.month;
    return;
  }
  goToMonth(el.monthInput.value);
});

// 클릭 이벤트가 preset 자리로 들어가지 않게 감싼다
el.addOpen.addEventListener("click", () => openCreate());
el.addOpenNarrow.addEventListener("click", () => openCreate());
el.batch.addEventListener("click", runBatch);
el.more.addEventListener("click", loadMore);

// 취소와 ← 는 같은 동작. 입력하던 내용은 묻지 않고 버린다.
// 목록으로 돌아갈 때는 보던 자리까지 되돌린다.
el.cancel.addEventListener("click", backToList);
el.back.addEventListener("click", backToList);
el.form.addEventListener("submit", submit);

/**
 * 제목 칸에서 Enter 를 눌러도 저장하지 않는다.
 *
 * 한 줄짜리 input 이 하나뿐인 폼은 Enter 로 제출된다(브라우저 기본 동작).
 * 제목만 쓰고 습관처럼 Enter 를 치면 본문이 빈 채로 저장이 시도돼
 * "내용을 입력해 주세요"만 뜨고 쓰던 흐름이 끊긴다.
 * 제목 다음은 본문이므로 그리로 넘겨준다.
 */
el.formTitle.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.isComposing) return;
  event.preventDefault();
  el.formContent.focus();
});

/* ---------- 일지 삭제 ---------- */

/**
 * 지우기 전에 한 번 묻는다.
 *
 * 이 일지에서 가져간 관찰이 있으면 몇 건인지 먼저 세어 확인창에 적는다.
 * 관찰은 지워지지 않고 "근거 일지 삭제됨" 표시만 남는데,
 * 그걸 모르고 지우면 나중에 왜 그 표시가 생겼는지 알 수 없다.
 *
 * 자원기록은 반대로 함께 사라진다. 통계가 그만큼 줄어드는 일이라 수를 먼저 적는다.
 */
async function askDeleteJournal(journal) {
  if (state.pending) return;

  let importedCount = 0;
  let resourceCount = 0;
  try {
    const payload = await get(`/api/journals/${journal.id}/observations`);
    importedCount = payload.imported_count ?? 0;
    resourceCount = payload.resource_record_count ?? 0;
  } catch (error) {
    // 개수를 못 세도 삭제 자체는 막지 않는다. 다만 그 사실을 알린다.
    console.error("[askDeleteJournal]", error);
    toast("가져간 관찰 수를 확인하지 못했습니다. 그대로 진행합니다.", true);
  }

  const lines = [
    `${formatDate(journal.journal_date)} ${journal.title ?? config(state.kind).title}`,
    "이 일지를 지우면 되돌릴 수 없습니다.",
  ];
  if (importedCount > 0) {
    lines.push(
      "",
      `이 일지에서 가져간 관찰 ${importedCount}건은 지워지지 않고 남습니다.`,
      `대신 그 관찰에 "근거 일지 삭제됨" 표시가 붙습니다.`,
    );
  }
  if (resourceCount > 0) {
    lines.push(
      "",
      `이 일지에서 추출된 자원기록 ${resourceCount}건도 함께 삭제됩니다.`,
      "그만큼 자원 통계가 줄어듭니다. 자원사전은 그대로 남습니다.",
    );
  }

  const yes = await confirmDialog({
    title: "일지를 삭제할까요?",
    message: lines.join("\n"),
    confirmText: "삭제",
  });
  if (yes) await deleteJournal(journal);
}

async function deleteJournal(journal) {
  const saved = snapshot();

  state.pending = true;
  state.journals = state.journals.filter((item) => item.id !== journal.id);
  state.extracts.delete(journal.id);
  state.resources.delete(journal.id);
  render();

  try {
    await remove(`/api/journals/${journal.id}`);
    trackGone(journal.id);
    render();
    toast("일지를 삭제했습니다");

    // 지운 날에 일정이 남아 있으면 다시 미작성이 된다
    loadMissing();
  } catch (error) {
    restore(saved);
    toast(error.message, true);
  } finally {
    state.pending = false;
  }
}
