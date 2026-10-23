/**
 * 도서관 — 센터가 가진 책의 목록
 *
 * 목록 위에 [+ 도서 등록] 하나 — 누르면 모달(채우는 길 다섯 + 서지 정보·센터 정보 두 단). 수정도 같은 모달.
 * 책은 수백 권이 되므로 묶음보다 검색이 먼저다. 검색·거르기(표 머리의 분류·상태)는 서버가 한다.
 *
 * [두 단]
 *   서지 정보  ISBN·제목·저자·출판사·발행년·공식분류(KDC). 조회로 채워 저장한 책은 잠긴다 —
 *             [정보 다시 불러오기] 로만 바뀐다. 손으로 넣은 책은 고칠 수 있다.
 *   센터 정보  등록번호·센터분류(자유)·상태·입수경위(자유 글)·비고.
 * 정렬은 등록번호 있는 책 먼저(번호순) → 없는 책 제목순(서버, 032).
 *
 * [두 갈래]
 *   우리 도서관   가진 책의 목록. 검색·분류 필터·등록·수정.
 *   책 찾아보기   바깥 도서관에서 제목·저자로 찾아 온다. 우리 표는 건드리지 않는다.
 * 찾은 책을 바로 저장하지 않는다. 등록 화면을 채워 열어 주고 사람이 보고 [저장]을 누른다.
 * 이미 가진 책이면 [소장 중] 을 붙여 두 번 등록하는 것을 막는다.
 *
 * [ISBN 조회]
 * ISBN 을 넣고 [조회]를 누르면 도서관 API 에서 서지정보를 받아 빈 칸을 채운다.
 * 사람이 이미 적은 칸은 덮지 않고, 저장은 사람이 [저장]을 눌러야 한다.
 * 책소개는 어느 칸에도 넣지 않고 조회 결과 줄에 보여만 준다 — 우리 표에 칸이 없다.
 * 키가 없으면 서버가 lookup_available=false 를 주고 버튼은 꺼진 채 이유를 적어 둔다.
 *
 * [책 사진으로 등록]
 * 표지를 찍으면 AI 가 제목·저자를 읽어 [책 찾아보기] 검색창을 채운다.
 * 한 장에 여러 권이 보이면 후보 목록이 뜨고, 줄마다 [찾기] 로 하나씩 넘어간다.
 * 등록을 마친 줄에는 체크가 붙어, 목록으로 돌아왔을 때 어디까지 했는지 보인다.
 * 읽은 값으로 바로 등록하지 않는다 — 표지를 잘못 읽어도 사람이 찾아보기에서 거른다.
 * 사진은 서버에서 AI 로 갔다가 버려진다. 어디에도 저장하지 않는다.
 *
 * [바코드]
 * ISBN 칸 옆 [스캔] 으로 책 뒤표지를 찍으면 번호가 채워지고 조회까지 이어진다.
 * 카메라를 못 쓰는 자리(권한 거부·http)에서는 버튼이 아예 안 보인다 — 손으로 넣으면 된다.
 *
 * [분류]
 * KDC 번호를 서가 이름으로 옮겨 담는다("813.7" → 한국문학). 자동은 제안이고
 * 등록 화면에서 고칠 수 있다. 번호가 없는 책은 "미분류" 로 모인다.
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
import { scanIsbn, scanSupported } from "./barcode.js";
import { mountBookPicker, mountQueue } from "./book_pick.js";
import { openImport } from "./book_import_ui.js";

/** 서버(/db/books.ts)의 목록과 같아야 한다. */
const STATUSES = ["보유", "분실", "폐기"];

/** 서지 칸 — 잠긴 책에서 못 고치는 입력칸 */
const BIBLIO_INPUTS = ["isbn", "title", "author", "publisher", "year", "kdcLabel"];

/** 검색어를 다 치기 전에 요청이 나가지 않게 조금 기다린다 */
const SEARCH_DELAY_MS = 250;

/** 분류를 못 정한 책을 모으는 이름. 서버(lib/kdc.ts)의 KDC_UNSET 과 같아야 한다. */
const KDC_UNSET = "미분류";

/** 조회에 실패해 제목 없이 저장한 책의 제목 자리. 서버(api/books.ts)의 TITLE_UNKNOWN 과 같아야 한다. */
const TITLE_UNKNOWN = "제목 미확인";

/** 분류가 비었을 때 덧붙이는 말 — 저장을 막지 않는다 */
const KDC_LATER = "분류는 나중에 지정할 수 있어요.";

/**
 * [ISBN 다시 검색] 을 띄울 책 — 잠기지 않았고(조회로 채운 책은 [정보 다시 불러오기]),
 * ISBN 이 있고, 서지가 비었거나(제목 미확인·저자 없음) 분류가 미정인 책.
 */
function needsRecheck(book) {
  if (!book || book.biblio_locked || !book.isbn) return false;
  return book.title === TITLE_UNKNOWN || !book.author || !book.kdc_label;
}

const state = {
  tab: "mine", // "mine" | "find"
  books: [],
  query: "",
  /** 표 머리 거르기 — 상태("전체"|보유…), 분류("전체"|"k:공식분류"|"c:센터분류") */
  status: "전체",
  cls: "전체",
  /** 좁은 화면에서 펼친 책(id) — 한 번에 하나 */
  openBook: null,
  /** 고를 수 있는 공식분류 이름. 서버가 목록과 함께 준다. */
  labels: [],
  /** 쓰고 있는 센터분류 이름들(032 전이면 빈 목록) */
  centers: [],
  centerUnset: "센터분류 없음",
  /** 등록 폼이 조회(ISBN·찾아보기·표지)로 채워졌나 — 저장하면 서지가 잠긴다 */
  fromLookup: false,
  lookupAvailable: false,
  loading: false,
  error: null,

  /** 책 찾아보기 */
  find: {
    title: "",
    author: "",
    page: 1,
    items: [],
    total: 0,
    hasMore: false,
    loading: false,
    error: null,
    searched: false,
  },

  /** 표지 사진 */
  photo: {
    image: null,
    busy: false,
  },

  formMode: null, // null | "create" | "edit"
  editing: null,
  pending: false,
  searchTimer: null,
  /** ISBN 조회가 채워 준 값 중 화면에 칸이 없는 것. 저장할 때 함께 보낸다. */
  lookedUp: null,
};

const el = {
  view: document.getElementById("view-books"),
  count: document.getElementById("book-count"),
  moreBox: document.getElementById("book-more-box"),
  more: document.getElementById("book-more"),
  tabs: document.querySelectorAll(".chip[data-btab]"),
  mine: document.getElementById("book-mine"),
  find: document.getElementById("book-find"),
  classFilter: document.getElementById("book-class-filter"),
  statusFilter: document.getElementById("book-status-filter"),
  search: document.getElementById("book-search"),
  addOpen: document.getElementById("book-add-open"),
  photoOpen: document.getElementById("book-photo-open"),
  importOpen: document.getElementById("book-import-open"),
  pick: document.getElementById("book-pick"),

  modal: document.getElementById("book-modal"),
  backdrop: document.getElementById("book-backdrop"),
  ways: document.getElementById("book-ways"),
  isbnFind: document.getElementById("book-isbn-find"),
  lockNote: document.getElementById("book-lock-note"),
  refresh: document.getElementById("book-refresh"),
  recheck: document.getElementById("book-recheck"),
  regNo: document.getElementById("book-regno"),
  center: document.getElementById("book-center"),
  centerList: document.getElementById("book-center-list"),
  form: document.getElementById("book-form"),
  formTitle: document.getElementById("book-form-title"),
  isbn: document.getElementById("book-isbn"),
  scan: document.getElementById("book-scan"),
  lookup: document.getElementById("book-lookup"),
  lookupHint: document.getElementById("book-lookup-hint"),
  lookupResult: document.getElementById("book-lookup-result"),
  title: document.getElementById("book-title"),
  author: document.getElementById("book-author"),
  publisher: document.getElementById("book-publisher"),
  year: document.getElementById("book-year"),
  kdcLabel: document.getElementById("book-kdc-label"),
  via: document.getElementById("book-via"),
  note: document.getElementById("book-note"),
  statusSelect: document.getElementById("book-status"),
  submit: document.getElementById("book-submit"),
  cancel: document.getElementById("book-cancel"),

  tbody: document.getElementById("book-tbody"),
  state: document.getElementById("book-state"),

  fs: {
    form: document.getElementById("booksearch-form"),
    title: document.getElementById("booksearch-title"),
    author: document.getElementById("booksearch-author"),
    submit: document.getElementById("booksearch-submit"),
    count: document.getElementById("booksearch-count"),
    list: document.getElementById("booksearch-list"),
    more: document.getElementById("booksearch-more"),
    state: document.getElementById("booksearch-state"),
  },

  photo: {
    modal: document.getElementById("bphoto-modal"),
    backdrop: document.getElementById("bphoto-backdrop"),
    close: document.getElementById("bphoto-close"),
    notice: document.getElementById("bphoto-notice"),
    source: document.getElementById("bphoto-source"),
    preview: document.getElementById("bphoto-preview"),
    scan: document.getElementById("bphoto-scan"),
    run: document.getElementById("bphoto-run"),
    state: document.getElementById("bphoto-state"),
    pick: document.getElementById("bphoto-pick"),
    found: document.getElementById("bphoto-found"),
    summary: document.getElementById("bphoto-summary"),
    list: document.getElementById("bphoto-list"),
    unread: document.getElementById("bphoto-unread"),
    again: document.getElementById("bphoto-again"),
  },
};

/* ---------- 화면 전환 (app.js가 부른다) ---------- */

export function showBooks() {
  el.view.hidden = false;
  closeForm();
  goToTab("mine");
  loadBooks();
}

/**
 * 탭을 바꾼다. 찾아보기에서 등록으로 넘어갈 때도 이 함수를 쓴다.
 * 폼은 우리 도서관 쪽에 있으므로, 등록을 열려면 반드시 그쪽으로 와야 한다.
 */
function goToTab(tab) {
  state.tab = tab;
  el.mine.hidden = tab !== "mine";
  el.find.hidden = tab !== "find";
  for (const chip of el.tabs) chip.classList.toggle("is-selected", chip.dataset.btab === tab);
}

export function hideBooks() {
  el.view.hidden = true;
}

/* ---------- 데이터 ---------- */

/** 지금 검색·상태·분류 조건. 나눠 받는 쪽마다 같은 조건을 보낸다. */
function listParams() {
  const params = new URLSearchParams();
  if (state.query.trim()) params.set("q", state.query.trim());
  if (state.status !== "전체") params.set("status", state.status);
  if (state.cls.startsWith("k:")) params.set("label", state.cls.slice(2));
  if (state.cls.startsWith("c:")) params.set("center", state.cls.slice(2));
  return params;
}

/**
 * [나눠 받기] 목록은 15권씩 온다. 첫 쪽에 거른 결과 전체 권수(total)가 함께 온다.
 * 검색·필터를 바꾸면 처음부터 다시 받는다 — 한 쪽은 늘 "거른 결과" 기준이다.
 */
let nextCursor = null;
let total = 0;
let loadingMore = false;

async function loadBooks() {
  state.loading = true;
  state.error = null;
  nextCursor = null;
  render();

  const asked = listParams().toString();
  try {
    const payload = await get(`/api/books?${asked}`);
    // 검색어를 치는 사이 늦게 온 답은 버린다
    if (listParams().toString() !== asked) return;
    state.books = payload.books ?? [];
    nextCursor = payload.next_cursor ?? null;
    total = payload.total ?? state.books.length;
    state.lookupAvailable = Boolean(payload.lookup_available);
    if (payload.kdc_labels?.length) state.labels = payload.kdc_labels;
    if (Array.isArray(payload.center_classes)) {
      state.centers = payload.center_classes;
      state.centerUnset = payload.center_unset ?? state.centerUnset;
    }
    fillClassOptions();
    syncLookupButton();
  } catch (error) {
    state.error = error.message;
    state.books = [];
    total = 0;
  } finally {
    state.loading = false;
    render();
  }
}

/** 다음 15권. 조건이 그 사이 바뀌었으면 버린다. */
async function loadMoreBooks() {
  if (!nextCursor || loadingMore) return;
  const asked = listParams();
  const cursor = nextCursor;
  asked.set("cursor", cursor);

  loadingMore = true;
  syncMore();
  try {
    const payload = await get(`/api/books?${asked}`);
    asked.delete("cursor");
    if (listParams().toString() !== asked.toString() || nextCursor !== cursor) return;
    const have = new Set(state.books.map((one) => one.id));
    for (const one of payload.books ?? []) {
      if (!have.has(one.id)) state.books.push(one);
    }
    nextCursor = payload.next_cursor ?? null;
    render();
  } catch (error) {
    toast(error.message, true);
  } finally {
    loadingMore = false;
    syncMore();
  }
}

function syncMore() {
  el.moreBox.hidden = state.loading || !!state.error || !nextCursor;
  el.more.disabled = loadingMore;
  el.more.textContent = loadingMore
    ? "불러오는 중…"
    : `더 보기 (${Math.max(total - state.books.length, 0)}권 남음)`;
}

/* ---------- 그리기 ---------- */

function render() {
  el.tbody.replaceChildren();
  hideState(el.state);
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

  const filtering = state.query.trim() || state.status !== "전체" || state.cls !== "전체";
  const shown = Math.max(total, state.books.length);
  el.count.textContent = state.books.length === 0
    ? ""
    : filtering
    ? `${shown}권 찾음`
    : `${shown}권`;

  if (state.books.length === 0) {
    if (filtering) {
      showState(
        el.state,
        "조건에 맞는 책이 없습니다.",
        "검색어를 지우거나 표 머리의 분류·상태를 '전체'로 바꿔 보세요.",
      );
    } else {
      showState(el.state, "아직 등록된 도서가 없어요.", "[+ 도서 등록] 으로 첫 책을 넣어 보세요.");
    }
    return;
  }

  for (const book of state.books) el.tbody.append(renderRow(book));
}

function renderRow(book) {
  const tr = document.createElement("tr");
  tr.className = "book__row";

  const regNo = document.createElement("td");
  regNo.className = "book__regno";
  regNo.textContent = book.reg_no ?? "";

  const title = document.createElement("td");
  title.className = "book__title";
  // 넓은 화면: 제목 + ISBN / 좁은 화면: 제목을 누르면 상세가 아래로 펼쳐진다(등록번호·제목만 한 줄)
  const wide = document.createElement("span");
  wide.className = "wide-only";
  // 제목은 사용자 입력이므로 textContent로만 넣는다
  wide.textContent = book.title;
  if (book.isbn) {
    const isbn = document.createElement("span");
    isbn.className = "book__isbn";
    isbn.textContent = book.isbn;
    wide.append(isbn);
  }
  const opened = state.openBook === book.id;
  const open = button(book.title, "book__open narrow-only", () => {
    state.openBook = state.openBook === book.id ? null : book.id;
    const now = state.openBook === book.id;
    open.setAttribute("aria-expanded", String(now));
    detail.hidden = !now;
    // 다른 줄의 펼침은 닫는다(한 번에 하나)
    for (const other of el.tbody.querySelectorAll(".book__detailrow")) {
      if (other !== detail) other.hidden = true;
    }
    for (const other of el.tbody.querySelectorAll(".book__open")) {
      if (other !== open) other.setAttribute("aria-expanded", "false");
    }
  });
  open.setAttribute("aria-expanded", String(opened));
  title.append(wide, open);

  const author = document.createElement("td");
  author.textContent = book.author ?? "-";

  const publisher = document.createElement("td");
  publisher.textContent = [book.publisher, book.published_year].filter(Boolean).join(" · ") ||
    "-";

  // 분류 — 센터분류(있으면) 왼쪽, 공식분류(KDC) 오른쪽. 태그는 세로로 꺾이지 않는다
  const label = document.createElement("td");
  label.className = "book__classes";
  if (book.center_class) {
    const center = document.createElement("span");
    center.className = "tag tag--center";
    center.textContent = book.center_class;
    center.title = "센터분류";
    label.append(center);
  }
  if (book.kdc_label) {
    const tag = document.createElement("span");
    tag.className = "tag tag--area";
    tag.textContent = book.kdc_label;
    if (book.kdc) tag.title = `KDC ${book.kdc}`;
    label.append(tag);
  } else {
    // 분류를 못 정한 책. 잘못이 아니라 아직 안 채운 것이라 흐리게만 둔다.
    const tag = document.createElement("span");
    tag.className = "tag tag--unset";
    tag.textContent = KDC_UNSET;
    explain(tag, "ISBN 으로 조회하면 채워집니다");
    label.append(tag);
  }

  const status = document.createElement("td");
  const badge = document.createElement("span");
  badge.className = book.status === "보유" ? "badge badge--active" : "badge";
  badge.textContent = book.status;
  status.append(badge);

  const actions = document.createElement("td");
  actions.className = "book__actions";
  const edit = button("수정", "linkbtn", () => openEdit(book));
  const del = button("삭제", "linkbtn linkbtn--danger", () => askDelete(book));
  edit.disabled = isTemp(book.id);
  del.disabled = isTemp(book.id);
  if (needsRecheck(book) && !isTemp(book.id)) {
    const again = button("ISBN 다시 검색", "linkbtn", () => recheckBook(book));
    again.disabled = !state.lookupAvailable;
    actions.append(again);
  }
  actions.append(edit, del);

  tr.append(regNo, title, author, publisher, label, status, actions);

  // 좁은 화면 상세 — 서지 + 센터 정보 + [수정][삭제]
  const detail = document.createElement("tr");
  detail.className = "book__detailrow narrow-only";
  detail.hidden = !opened;
  const cell = document.createElement("td");
  cell.colSpan = 7;
  const list = document.createElement("dl");
  list.className = "book__detail";
  const pairs = [
    ["ISBN", book.isbn],
    ["저자", book.author],
    ["출판사 · 발행년", [book.publisher, book.published_year].filter(Boolean).join(" · ")],
    ["공식분류", book.kdc_label ?? KDC_UNSET],
    ["센터분류", book.center_class],
    ["상태", book.status],
    ["입수경위", book.acquired_via],
    ["비고", book.note],
  ];
  for (const [name, value] of pairs) {
    if (!value) continue;
    const dt = document.createElement("dt");
    dt.textContent = name;
    const dd = document.createElement("dd");
    dd.textContent = String(value);
    list.append(dt, dd);
  }
  const buttons = document.createElement("div");
  buttons.className = "book__detailacts";
  const edit2 = button("수정", "btn", () => openEdit(book));
  const del2 = button("삭제", "btn btn--danger", () => askDelete(book));
  edit2.disabled = isTemp(book.id);
  del2.disabled = isTemp(book.id);
  if (needsRecheck(book) && !isTemp(book.id)) {
    const again2 = button("ISBN 다시 검색", "btn", () => recheckBook(book));
    again2.disabled = !state.lookupAvailable;
    buttons.append(again2);
  }
  buttons.append(edit2, del2);
  cell.append(list, buttons);
  detail.append(cell);

  const pair = document.createDocumentFragment();
  pair.append(tr, detail);
  return pair;
}

/**
 * 분류 고르기 — 표 머리 거르기(센터분류 묶음 + 공식분류 묶음)와 등록 폼의 공식분류 칸.
 * 공식분류 이름표는 서버가 준다 — 화면이 lib/kdc.ts 를 직접 못 부르기 때문이다.
 */
function fillClassOptions() {
  const keep = state.cls;
  el.classFilter.replaceChildren();
  const add = (parent, value, label) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    parent.append(option);
  };
  add(el.classFilter, "전체", "분류 ▾");
  if (state.centers.length) {
    const group = document.createElement("optgroup");
    group.label = "센터분류";
    for (const name of state.centers) add(group, `c:${name}`, name);
    add(group, `c:${state.centerUnset}`, state.centerUnset);
    el.classFilter.append(group);
  }
  const official = document.createElement("optgroup");
  official.label = "공식분류(KDC)";
  for (const name of state.labels) add(official, `k:${name}`, name);
  // 분류가 빈 책만 모아 보는 자리. 채워 넣을 것을 찾을 때 쓴다.
  add(official, `k:${KDC_UNSET}`, KDC_UNSET);
  el.classFilter.append(official);
  el.classFilter.value = [...el.classFilter.options].some((o) => o.value === keep) ? keep : "전체";
  el.classFilter.classList.toggle("is-on", el.classFilter.value !== "전체");

  const picked = el.kdcLabel.value;
  fillOptions(el.kdcLabel, [{ value: "", label: "미정" }, ...state.labels.map(toOption)]);
  el.kdcLabel.value = picked;

  el.centerList.replaceChildren(...state.centers.map((name) => {
    const option = document.createElement("option");
    option.value = name;
    return option;
  }));
}

function fillStatusFilter() {
  fillOptions(el.statusFilter, [{ value: "전체", label: "상태 ▾" }, ...STATUSES.map(toOption)]);
  el.statusFilter.value = state.status;
}

function syncStatusChips() {
  el.statusFilter.value = state.status;
  el.statusFilter.classList.toggle("is-on", state.status !== "전체");
}

/**
 * [조회] 버튼. 키가 없으면 꺼 두고 왜 꺼져 있는지 적는다.
 * 버튼을 아예 숨기지 않는 이유: 이 기능이 생길 자리라는 것을 보여 주려고.
 */
function syncLookupButton() {
  el.lookup.disabled = !state.lookupAvailable;
  el.lookup.title = state.lookupAvailable ? "" : "API 키 미설정 — 키가 연결되면 켜집니다";
  el.lookupHint.hidden = state.lookupAvailable;
}

/**
 * 조회 결과 한 줄. 스낵바는 곧 사라지지만 이 줄은 폼이 열려 있는 동안 남는다.
 * 어디서 받아왔는지, 화면에 칸이 없는 값(KDC·표지)이 무엇인지 여기서 알린다.
 */
function showLookupNote(message, isError = false) {
  el.lookupResult.replaceChildren();
  el.lookupResult.textContent = message;
  el.lookupResult.classList.toggle("booklookup--error", isError);
  el.lookupResult.hidden = false;
}

function clearLookupNote() {
  state.lookedUp = null;
  el.lookupResult.replaceChildren();
  el.lookupResult.classList.remove("booklookup--error");
  el.lookupResult.hidden = true;
}

/**
 * 찾은 결과를 적는다. 어디서 왔는지 + 화면 칸에 없는 것(KDC·표지·책소개).
 *
 * 책소개는 어느 칸에도 넣지 않고 여기서 읽기만 한다.
 * 우리 표에 칸이 없고, 비고는 사서가 쓰는 자리라 출판사 소개글이 들어갈 곳이 아니다.
 * 그래도 무슨 책인지 가려내는 데는 도움이 되므로 보여는 준다.
 */
function showLookupResult(found) {
  clearLookupNote();
  state.lookedUp = { kdc: found.kdc ?? null, cover_url: found.cover_url ?? null };

  const head = document.createElement("span");
  const extra = [
    found.kdc ? `KDC ${found.kdc}` : null,
    found.cover_url ? "표지 있음" : null,
  ].filter(Boolean);
  head.textContent = `${found.sources?.join(" + ") ?? "도서관 API"} 에서 찾았습니다.` +
    (extra.length > 0 ? ` (${extra.join(" · ")})` : "") +
    " 확인한 뒤 저장하세요." +
    (found.kdc_label ? "" : ` ${KDC_LATER}`);
  el.lookupResult.append(head);

  if (found.description) {
    const blurb = document.createElement("span");
    blurb.className = "booklookup__blurb";
    // 책소개는 바깥에서 온 글이므로 textContent 로만 넣는다
    blurb.textContent = `책소개: ${found.description}`;
    el.lookupResult.append(blurb);
  }

  el.lookupResult.hidden = false;
}

/* ---------- 등록 · 수정 폼 ---------- */

function fillForm(book) {
  el.isbn.value = book?.isbn ?? "";
  el.isbnFind.value = "";
  el.title.value = book?.title ?? "";
  el.author.value = book?.author ?? "";
  el.publisher.value = book?.publisher ?? "";
  el.year.value = book?.published_year ?? "";
  el.kdcLabel.value = book?.kdc_label ?? "";
  el.regNo.value = book?.reg_no ?? "";
  el.center.value = book?.center_class ?? "";
  el.via.value = book?.acquired_via ?? "";
  el.note.value = book?.note ?? "";
  el.statusSelect.value = book?.status ?? "보유";
  // 폼을 새로 채우면 이전 조회 결과는 이 책의 것이 아니다
  clearLookupNote();
  state.fromLookup = false;
  setBiblioLocked(Boolean(book?.biblio_locked), book);
}

/** 서지 칸 잠금 — 조회로 채워 저장한 책. 풀린 책(손으로 넣은 책)은 고칠 수 있다 */
function setBiblioLocked(locked, book = null) {
  for (const key of BIBLIO_INPUTS) el[key].disabled = locked;
  el.lockNote.hidden = !locked;
  el.refresh.hidden = !locked || !book?.isbn;
  el.refresh.disabled = !state.lookupAvailable;
  // 잠기지 않은 책 수정 — 서지가 비었거나 분류 미정이면 ISBN 칸 옆에서 바로 다시 찾는다
  el.recheck.hidden = !(state.formMode === "edit" && needsRecheck(book));
  el.recheck.disabled = !state.lookupAvailable;
}

/**
 * [ISBN 다시 검색] — 서지가 빈 책을 ISBN 으로 다시 찾아 채운다(조회 채움이라 저장 뒤 잠긴다).
 * 수정 화면에서 누르면 ISBN 칸의 값(고친 값)으로 찾는다.
 */
async function recheckBook(book, isbn = null) {
  const buttons = [el.recheck];
  for (const node of buttons) node.disabled = true;
  try {
    const payload = await send(`/api/books/${book.id}/refresh`, "POST", isbn ? { isbn } : {});
    const index = state.books.findIndex((item) => item.id === book.id);
    if (index >= 0) state.books[index] = payload.book;
    sortBooks();
    render();
    if (state.formMode === "edit" && state.editing?.id === book.id) {
      state.editing = payload.book;
      fillForm(payload.book);
    }
    toast(
      `서지를 채웠습니다 (${(payload.sources ?? []).join(" + ") || "도서관 API"})` +
        (payload.kdc_missing ? ` · ${KDC_LATER}` : ""),
    );
  } catch (error) {
    toast(error.message, true);
  } finally {
    for (const node of buttons) node.disabled = !state.lookupAvailable;
  }
}

function openModal() {
  el.modal.hidden = false;
}

function openCreate() {
  state.formMode = "create";
  state.editing = null;

  el.formTitle.textContent = "도서 등록";
  fillForm(null);
  el.ways.hidden = false;
  // 기본 길 — 제목으로 찾아 고르면 서지 칸이 채워진다(조회 채움 → 저장 뒤 잠금)
  const picker = mountBookPicker(el.pick, {
    actionLabel: "고르기",
    onChoose: (item) => {
      fillFromItem(item);
      focusOnWide(el.regNo);
    },
  });

  openModal();
  focusOnWide(el.pick.querySelector(".bpick__title"));
}

/**
 * 찾은 책(검색 결과)으로 서지 칸을 채운다. 저장은 사람이 [저장] 을 눌러야 한다.
 * 바깥에서 온 값이 늘 맞는 것은 아니다(전집의 한 권이 낱권으로 잡히기도 한다).
 */
function fillFromItem(item) {
  el.isbn.value = item.isbn ?? "";
  el.title.value = item.title ?? "";
  el.author.value = item.author ?? "";
  el.publisher.value = item.publisher ?? "";
  el.year.value = item.published_year ?? "";
  el.kdcLabel.value = item.kdc_label ?? "";
  // 화면에 칸이 없는 값. 저장할 때 함께 보낸다.
  state.lookedUp = { kdc: item.kdc ?? null, cover_url: item.cover_url ?? null };
  // 바깥에서 찾아 채운 서지 — 저장하면 잠긴다(ISBN 이 있을 때)
  state.fromLookup = true;
  showLookupNote(
    `${(item.sources ?? []).join(" + ") || "도서관 API"} 에서 가져온 "${item.title}" 입니다. ` +
      "센터 정보를 붙여 [저장] 을 눌러 주세요." +
      (item.kdc_label ? "" : ` ${KDC_LATER}`),
  );
}

function openEdit(book) {
  state.formMode = "edit";
  state.editing = book;

  el.formTitle.textContent = `${book.title} 수정`;
  fillForm(book);
  el.ways.hidden = true;

  openModal();
  focusOnWide(book.biblio_locked ? el.regNo : el.title);
}

function closeForm() {
  state.formMode = null;
  state.editing = null;
  el.modal.hidden = true;
}

/** 폼의 값을 서버에 보낼 모양으로 모은다. 빈 칸은 null. 잠긴 책은 서지 칸을 보내지 않는다. */
function readForm() {
  const text = (node) => node.value.trim() || null;
  const locked = state.formMode === "edit" && Boolean(state.editing?.biblio_locked);
  const biblio = locked ? {} : {
    isbn: text(el.isbn),
    title: el.title.value.trim(),
    author: text(el.author),
    publisher: text(el.publisher),
    published_year: el.year.value.trim() ? Number(el.year.value) : null,
    kdc_label: el.kdcLabel.value || null,
    // 화면에 칸이 없어 조회로만 들어오는 값. 조회를 안 했으면 보내지 않는다.
    ...(state.lookedUp ?? {}),
  };
  return {
    ...biblio,
    reg_no: text(el.regNo),
    center_class: text(el.center),
    acquired_via: text(el.via),
    note: text(el.note),
    status: el.statusSelect.value || "보유",
  };
}

/* ---------- 저장 (낙관적 갱신) ---------- */

function isTemp(id) {
  return String(id).startsWith("temp-");
}

function snapshot() {
  return state.books.map((book) => ({ ...book }));
}

function restore(saved) {
  state.books = saved;
  render();
}

/**
 * 서버와 같은 순서 — 등록번호 있는 책 먼저(앞 숫자는 숫자순), 없는 책은 제목순.
 * (서버 sort_key 와 같은 생각. 가나다 비교만 브라우저 것이라 드물게 한 칸씩 다를 수 있다)
 */
function sortKey(book) {
  const reg = String(book.reg_no ?? "").trim();
  if (!reg) return `1${book.title ?? ""}`;
  // 033 과 같은 규칙 — 숫자로 시작하면 "0", 글자로 시작하면 "1"+앞 글자, 그 뒤 첫 숫자 덩어리를 12자리로
  const head = /^\d/.test(reg) ? "0" : `1${(reg.match(/^\D*/) ?? [""])[0]}`;
  const num = (reg.match(/\d+/) ?? [""])[0];
  return `0${head}${num.padStart(12, "0")}${reg}`;
}

function sortBooks() {
  state.books.sort((a, b) => sortKey(a).localeCompare(sortKey(b), "ko"));
}

async function submit(event) {
  event.preventDefault();
  if (state.pending) return;

  const book = readForm();
  // 제목도 ISBN 도 없으면 무엇인지 알 길이 없다 — 칸으로 데려가 알린다(말없이 막지 않는다)
  if ("title" in book && !book.title && !book.isbn) {
    toast("제목이나 ISBN 중 하나는 넣어 주세요.", true);
    el.title.scrollIntoView({ block: "center" });
    el.title.focus();
    return;
  }
  // 조회에 실패해도 ISBN 이 있으면 센터 정보만으로 저장한다 — 서버가 제목 자리를 채운다
  const untitled = "title" in book && !book.title;
  if (untitled) book.title = TITLE_UNKNOWN;

  // 낙관적으로 폼을 닫으면 closeForm() 이 수정 중이라는 표시를 지운다.
  // 실패해서 폼을 다시 열 때 그대로 되살려야 한다 — 안 그러면 다시 [저장]이 "새로 등록" 이 된다.
  const formMode = state.formMode;
  const editing = state.editing;

  const saved = snapshot();
  state.pending = true;
  el.submit.disabled = true;

  try {
    if (formMode === "edit") {
      const target = editing;
      const status = el.statusSelect.value;

      const row = state.books.find((item) => item.id === target.id);
      if (row) Object.assign(row, book);
      sortBooks();
      closeForm();
      render();

      const payload = await send(`/api/books/${target.id}`, "PATCH", book);
      const index = state.books.findIndex((item) => item.id === target.id);
      if (index >= 0) state.books[index] = payload.book;
      sortBooks();
      render();
      toast("저장되었습니다");
    } else {
      const tempId = `temp-${crypto.randomUUID()}`;
      state.books.push({
        id: tempId,
        kdc: null,
        cover_url: null,
        ...book,
      });
      sortBooks();
      const fromLookup = state.fromLookup;
      closeForm();
      render();

      // 조회로 채웠으면 저장 뒤 서지가 잠긴다(ISBN 이 있을 때 — 서버가 판단)
      const payload = await send("/api/books", "POST", {
        ...book,
        ...(fromLookup ? { biblio_source: "lookup" } : {}),
      });
      const index = state.books.findIndex((item) => item.id === tempId);
      if (index >= 0) state.books[index] = payload.book;
      total += 1;
      sortBooks();
      render();
      toast(
        untitled
          ? "등록했습니다 — 서지는 나중에 [ISBN 다시 검색] 으로 채울 수 있어요."
          : payload.book.kdc_label
          ? "등록되었습니다"
          : `등록되었습니다 · ${KDC_LATER}`,
      );
    }
  } catch (error) {
    // 목록은 되돌리되 폼은 다시 연다. 입력값이 남아 있어 다시 저장할 수 있다.
    restore(saved);
    state.formMode = formMode;
    state.editing = editing;
    openModal();
    toast(error.message, true);
  } finally {
    state.pending = false;
    el.submit.disabled = false;
  }
}

/* ---------- 삭제 ---------- */

/**
 * 잃어버리거나 버린 책은 지우는 것이 아니라 상태를 바꾸는 것이다.
 * 확인창에서 그 차이를 한 번 짚는다.
 */
async function askDelete(book) {
  if (state.pending) return;

  const yes = await confirmDialog({
    title: "도서를 삭제할까요?",
    message: `${book.title}\n잘못 등록한 줄을 치울 때만 지우세요.\n` +
      `잃어버리거나 버린 책은 [수정]에서 상태를 분실·폐기로 바꾸면 기록이 남습니다.\n` +
      `되돌릴 수 없습니다.`,
    confirmText: "삭제",
  });
  if (!yes) return;

  const saved = snapshot();
  state.pending = true;
  state.books = state.books.filter((item) => item.id !== book.id);
  render();

  try {
    await remove(`/api/books/${book.id}`);
    total = Math.max(total - 1, 0);
    render();
    toast("도서를 삭제했습니다");
  } catch (error) {
    restore(saved);
    toast(error.message, true);
  } finally {
    state.pending = false;
  }
}

/* ---------- 이벤트 ---------- */

for (const chip of el.tabs) {
  chip.addEventListener("click", () => goToTab(chip.dataset.btab));
}

// 표 머리 거르기 — 분류·상태
el.classFilter.addEventListener("change", () => {
  state.cls = el.classFilter.value;
  el.classFilter.classList.toggle("is-on", state.cls !== "전체");
  loadBooks();
});
el.statusFilter.addEventListener("change", () => {
  state.status = el.statusFilter.value;
  syncStatusChips();
  loadBooks();
});
fillStatusFilter();

// 모달 — 바깥·Esc = 취소
el.backdrop.addEventListener("click", () => {
  if (!state.pending) closeForm();
});
el.modal.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !state.pending) closeForm();
});

// 채우는 길 — 📷 표지 사진·책 찾아보기는 등록 모달을 닫고 그쪽 흐름으로(찾은 책은 [등록] 으로 이 모달이 다시 열린다)
el.photoOpen.addEventListener("click", () => {
  closeForm();
  openPhoto();
});
// 📄 엑셀로 등록 — 등록 모달을 닫고 엑셀 모달로(book_import_ui.js). 등록되면 목록을 다시 읽는다
el.importOpen.addEventListener("click", () => {
  closeForm();
  openImport({ onRegistered: () => loadBooks() });
});

// [정보 다시 불러오기] — 잠긴 책의 서지를 ISBN 으로 새로 받는다(센터 정보는 그대로)
el.refresh.addEventListener("click", async () => {
  const target = state.editing;
  if (!target) return;
  el.refresh.disabled = true;
  el.refresh.textContent = "불러오는 중…";
  try {
    const payload = await send(`/api/books/${target.id}/refresh`, "POST", {});
    const index = state.books.findIndex((item) => item.id === target.id);
    if (index >= 0) state.books[index] = payload.book;
    state.editing = payload.book;
    el.isbn.value = payload.book.isbn ?? "";
    el.title.value = payload.book.title ?? "";
    el.author.value = payload.book.author ?? "";
    el.publisher.value = payload.book.publisher ?? "";
    el.year.value = payload.book.published_year ?? "";
    el.kdcLabel.value = payload.book.kdc_label ?? "";
    sortBooks();
    render();
    toast(`${(payload.sources ?? []).join(" + ") || "도서관 API"} 에서 다시 불러왔습니다`);
  } catch (error) {
    toast(error.message, true);
  } finally {
    el.refresh.disabled = !state.lookupAvailable;
    el.refresh.textContent = "정보 다시 불러오기";
  }
});

// 검색은 서버가 하므로 글자마다 요청을 보내지 않고 손이 멈추면 보낸다
el.search.addEventListener("input", () => {
  state.query = el.search.value;
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(loadBooks, SEARCH_DELAY_MS);
});

el.recheck.addEventListener("click", () => {
  if (state.editing) recheckBook(state.editing, el.isbn.value.trim() || null);
});
el.addOpen.addEventListener("click", openCreate);
el.more.addEventListener("click", loadMoreBooks);
el.cancel.addEventListener("click", closeForm);
el.form.addEventListener("submit", submit);

fillOptions(el.statusSelect, STATUSES.map(toOption));

/**
 * [조회] — ISBN 으로 서지정보를 받아 빈 칸을 채운다.
 *
 * 사람이 이미 적은 칸은 덮지 않는다. 받아온 값이 늘 더 옳은 것은 아니고,
 * 무엇보다 쓰던 것을 말없이 지우면 안 된다.
 * 채우기만 하고 저장은 하지 않는다 — 사람이 보고 [저장]을 눌러야 기록이 된다.
 */
el.lookup.addEventListener("click", async () => {
  const isbn = el.isbnFind.value.trim() || el.isbn.value.trim();
  if (!isbn) {
    toast("ISBN 을 먼저 입력해 주세요.", true);
    return;
  }

  el.lookup.disabled = true;
  el.lookup.textContent = "조회 중…";
  showLookupNote("조회하는 중…");

  try {
    const payload = await get(`/api/books/lookup?isbn=${encodeURIComponent(isbn)}`);
    const found = payload.found;

    if (!found) {
      // 오류가 아니다. 그런 책이 없다는 답이라 직접 적으면 된다. 찾던 ISBN 은 칸에 남겨 저장되게 한다.
      if (!el.isbn.value.trim()) el.isbn.value = isbn;
      showLookupNote(
        "이 ISBN 으로 찾은 책이 없습니다. 제목을 적어 저장하거나, 센터 정보만 저장한 뒤 " +
          "나중에 목록의 [ISBN 다시 검색] 으로 채울 수 있어요.",
      );
      return;
    }

    el.isbn.value = found.isbn ?? isbn;
    state.fromLookup = true;
    if (!el.title.value.trim()) el.title.value = found.title ?? "";
    if (!el.author.value.trim()) el.author.value = found.author ?? "";
    if (!el.publisher.value.trim()) el.publisher.value = found.publisher ?? "";
    if (!el.year.value.trim() && found.published_year) el.year.value = found.published_year;
    // 분류도 사람이 이미 골랐으면 덮지 않는다. 제안이지 정답이 아니다.
    if (!el.kdcLabel.value && found.kdc_label) el.kdcLabel.value = found.kdc_label;

    // 화면에 칸이 없는 값(KDC 번호·표지)은 들고 있다가 저장할 때 함께 보낸다
    state.lookedUp = { kdc: found.kdc ?? null, cover_url: found.cover_url ?? null };

    // 책소개는 어느 칸에도 넣지 않는다. 비고는 사서가 쓰는 자리라
    // 출판사 소개글이 들어가 앉으면 그 자리의 뜻이 흐려진다. 참고로 보여만 준다.
    showLookupResult(found);
  } catch (error) {
    // 서버까지 못 간 경우(fetch 자체가 실패)는 TypeError 로 온다.
    // 브라우저가 주는 영어 문구를 그대로 보여 주면 무엇을 해야 할지 알 수 없다.
    // 서버가 답을 준 경우는 왜 실패했는지(키·무결과·상대 API)까지 담아 보내므로 그대로 쓴다.
    const message = error instanceof TypeError
      ? "서버에 연결하지 못했습니다. 잠시 뒤 다시 눌러 주세요."
      : error.message;
    // 조회가 실패해도 저장은 막지 않는다 — ISBN 을 남겨 두면 나중에 다시 찾을 수 있다
    if (!el.isbn.value.trim()) el.isbn.value = isbn;
    showLookupNote(`${message} 센터 정보만 먼저 저장해도 됩니다 — 나중에 [ISBN 다시 검색].`, true);
    toast(message, true);
  } finally {
    el.lookup.disabled = !state.lookupAvailable;
    el.lookup.textContent = "ISBN 조회";
  }
});

/* ---------- 책 사진으로 등록 ---------- */

/**
 * 표지를 찍어 [책 찾아보기] 검색창을 채운다.
 *
 * 읽은 값으로 바로 등록하는 길은 만들지 않는다. 모델은 흐린 표지에서도
 * 아는 책이면 자신 있게 적는데, 틀린 채로 등록되면 아무도 다시 안 본다.
 * 검색창을 채우는 데까지만 쓰면 사람이 찾아보기 결과를 보고 고르게 된다.
 */
function openPhoto() {
  // 사진 안내는 모든 사진 자리가 같은 말이어야 한다(ui.js 의 PHOTO_NOTICE).
  el.photo.notice.textContent = PHOTO_NOTICE;

  state.photo = { image: null, busy: false };
  el.photo.found.hidden = true;
  el.photo.pick.hidden = false;
  photoSource.reset();
  el.photo.preview.hidden = true;
  el.photo.run.disabled = true;
  el.photo.run.textContent = "표지 읽기";
  // 카메라를 못 쓰는 자리에서는 바코드 버튼이 아예 안 보인다(barcode.js 와 같은 판단).
  el.photo.scan.hidden = !scanSupported();
  hideState(el.photo.state);

  el.photo.modal.hidden = false;
  // 좁은 화면은 사진 버튼에도 초점을 주지 않는다(일지 작성과 같은 규칙)
  focusOnWide(el.photo.modal.querySelector("#bphoto-source button"));
}

function closePhoto() {
  if (state.photo.busy) return;
  el.photo.modal.hidden = true;
}

/** [📷 찍기]·[🖼 갤러리] 어느 쪽에서 골랐든 여기로 모인다 */
async function onCoverPicked(file) {
  state.photo.image = null;
  el.photo.run.disabled = true;
  el.photo.preview.hidden = true;
  if (!file) return;

  if (!file.type.startsWith("image/")) {
    toast("사진 파일만 올릴 수 있습니다.", true);
    return;
  }

  hideState(el.photo.state);

  try {
    // 줄이는 데 실패하면 여기서 던진다. 원본을 그대로 보내지 않는다 —
    // 무엇이 잘못됐는지 모른 채 "표지를 읽지 못했어요" 로 끝나던 자리다.
    // 서가처럼 가로로 긴 큰 사진이면 좌/우 조각도 만든다(ui.js splitPlan)
    const prepared = await prepareImage(file, { split: true });

    const bytes = base64Bytes(prepared.base64);
    if (bytes > PHOTO_MAX_BYTES) {
      toast(
        `사진이 너무 큽니다 (${Math.round(bytes / 1024 / 1024)}MB). 조금 멀리서 다시 찍어 주세요.`,
        true,
      );
      return;
    }

    state.photo.image = {
      base64: prepared.base64,
      mimeType: prepared.mimeType,
      parts: prepared.parts ?? null,
    };
    el.photo.preview.src = prepared.previewUrl;
    el.photo.preview.hidden = false;
    el.photo.run.disabled = false;
  } catch (error) {
    // 사진을 처리하지 못한 것이라 창을 닫지 않는다. 다른 사진을 바로 고를 수 있다.
    showState(el.photo.state, "사진을 준비하지 못했어요", error.message, true);
  }
}

async function runCover() {
  if (!state.photo.image || state.photo.busy) return;

  state.photo.busy = true;
  el.photo.run.disabled = true;
  el.photo.run.textContent = "읽는 중…";
  // 몇 초 걸린다. 아무 표시가 없으면 사람이 버튼을 또 누른다.
  const parts = state.photo.image.parts;
  showState(
    el.photo.state,
    parts ? "책이 많은 사진이라 둘로 나눠 읽는 중…" : "표지를 읽는 중…",
    parts
      ? "왼쪽·오른쪽을 따로 읽고 합칩니다. 20~40초쯤 걸립니다."
      : "사진을 보내고 답을 기다립니다. 몇 초 걸립니다.",
  );

  try {
    const payload = await send(
      "/api/books/from-cover",
      "POST",
      parts
        ? { parts: parts.map((one) => ({ image: one.base64, mime_type: one.mimeType })) }
        : { image: state.photo.image.base64, mime_type: state.photo.image.mimeType },
    );

    hideState(el.photo.state);
    // 못 읽었으면 빈 줄 하나 — 그 자리에서 제목을 적어 찾는다(화면을 떠나지 않는다)
    showCandidates(payload.read ? payload.covers ?? [] : [{}], payload.read);
  } catch (error) {
    // 두 갈래 — AI 연결·서버 문제(일시적) / 그 밖(사진·답을 못 읽음).
    // 앞은 같은 사진으로 다시 누르면 되고, 뒤는 제목으로 찾는 길을 연다.
    if (error.payload?.ai_service || error instanceof TypeError) {
      // 설정·크레딧 문제는 기다려도 풀리지 않는다 — 관리자에게
      const lasting = ["config", "credit"].includes(error.payload?.ai_kind);
      showState(
        el.photo.state,
        lasting
          ? "AI 연결에 문제가 있어요 — 관리자에게 알려 주세요."
          : "AI 연결에 일시적인 문제가 있어요 — 잠시 뒤 같은 사진으로 다시 시도해 주세요.",
        error instanceof TypeError ? "서버에 연결하지 못했습니다." : error.message,
        true,
      );
    } else if (error.status === 400) {
      // 사진 자체 문제(형식·크기) — 서버가 사람이 읽을 문장을 준다
      showState(el.photo.state, "사진을 보내지 못했어요", error.message, true);
    } else {
      hideState(el.photo.state);
      showCandidates([{}], false);
    }
  } finally {
    state.photo.busy = false;
    el.photo.run.disabled = false;
    el.photo.run.textContent = "표지 읽기";
  }
}

/* ---------- 표지 → 연속 등록 줄 ---------- */

/**
 * 읽은 책마다 한 줄. 줄의 [찾기] 를 누르면 그 줄 밑에서 찾아 고르고 [등록](등록번호·상태 간단 입력) —
 * 등록한 줄은 ✓ 로 접히고 다음 줄이 열린다. 목록을 떠나지 않고 열 권을 잇달아 넣는다(book_pick.js).
 * 표지에서 읽은 값은 검색어일 뿐이다 — 등록은 사람이 결과를 보고 누른다.
 */
function showCandidates(covers, read = true) {
  const entries = covers.map((cover, index) => ({
    heading: cover.title
      ? `${cover.title}${cover.partial ? " …(일부만 읽힘)" : ""}`
      : cover.author
      ? `(제목을 못 읽음) ${cover.author}`
      : `읽지 못한 책${covers.length > 1 ? ` ${index + 1}` : ""}`,
    sub: [cover.author, cover.publisher].filter(Boolean).join(" · ") ||
      (cover.title ? "" : "제목을 직접 넣어 찾아 주세요"),
    title: cover.title ?? "",
    author: cover.author ?? "",
  }));
  el.photo.summary.textContent = !read
    ? "표지를 읽지 못했어요 — 제목으로 검색해 주세요."
    : entries.length === 1
    ? "한 권을 읽었습니다. 찾은 책에서 맞는 것을 [등록] 하세요."
    : `사진에서 ${entries.length}권이 보입니다. 줄마다 찾아 [등록] 하면 다음 줄이 열립니다.`;
  el.photo.unread.hidden = true;

  const queue = mountQueue(el.photo.list, entries, {
    onRegistered: (book) => {
      state.books.push(book);
      total += 1;
      sortBooks();
      render();
    },
  });
  el.photo.pick.hidden = true;
  el.photo.found.hidden = false;
  hideState(el.photo.state);
  el.photo.modal.hidden = false;
  // 한 권(또는 못 읽음)이면 바로 펼친다
  if (entries.length === 1) queue.open(0);
}

el.photo.again.addEventListener("click", openPhoto);

el.photo.close.addEventListener("click", closePhoto);
el.photo.backdrop.addEventListener("click", closePhoto);
const photoSource = mountPhotoSource(el.photo.source, (file) => onCoverPicked(file));
el.photo.run.addEventListener("click", runCover);

/**
 * 사진 화면의 [바코드로 찾기] — 표지가 안 읽히는 책은 뒤표지 번호가 빠르다.
 * 번호를 읽으면 등록 폼으로 넘어가 ISBN 조회까지 이어진다(폼의 [스캔] 과 같은 길).
 */
el.photo.scan.addEventListener("click", async () => {
  el.photo.scan.disabled = true;
  try {
    const isbn = await scanIsbn();
    if (!isbn) return;

    el.photo.modal.hidden = true;
    goToTab("mine");
    openCreate();
    el.isbnFind.value = isbn;
    el.isbn.value = isbn;
    clearLookupNote();
    toast(`ISBN ${isbn} 을(를) 읽었습니다`);
    if (state.lookupAvailable) el.lookup.click();
  } finally {
    el.photo.scan.disabled = false;
  }
});

/* ---------- 바코드 스캔 ---------- */

/**
 * [스캔] — 책 뒤표지 바코드로 ISBN 을 넣고 곧바로 조회까지 간다.
 *
 * 카메라를 못 쓰는 자리에서는 버튼이 아예 없다. 있는데 눌러도 안 되는 것보다,
 * 없어서 손으로 넣는 편이 헷갈리지 않는다.
 *
 * 읽은 번호로 조회까지 이어 주는 이유: 바코드를 찍는 사람은 이미 책을 손에 들고 있다.
 * 거기서 버튼을 한 번 더 누르게 할 일이 아니다. 저장은 여전히 사람이 누른다.
 */
el.scan.hidden = !scanSupported();
el.scan.addEventListener("click", async () => {
  el.scan.disabled = true;
  try {
    const isbn = await scanIsbn();
    if (!isbn) return;

    el.isbnFind.value = isbn;
    el.isbn.value = isbn;
    clearLookupNote();
    toast(`ISBN ${isbn} 을(를) 읽었습니다`);
    if (state.lookupAvailable) el.lookup.click();
  } finally {
    el.scan.disabled = false;
  }
});

/* ---------- 책 찾아보기 ---------- */

function renderFind() {
  const find = state.find;
  el.fs.list.replaceChildren();
  hideState(el.fs.state);
  el.fs.more.hidden = true;

  if (find.loading && find.items.length === 0) {
    el.fs.count.textContent = "";
    showState(el.fs.state, "찾는 중…");
    return;
  }
  if (find.error) {
    el.fs.count.textContent = "";
    showState(el.fs.state, find.error, null, true);
    return;
  }
  if (!find.searched) {
    el.fs.count.textContent = "";
    showState(
      el.fs.state,
      "제목이나 저자를 넣고 [찾기] 를 눌러 보세요.",
      "국립중앙도서관과 도서관 정보나루에서 함께 찾습니다.",
    );
    return;
  }
  if (find.items.length === 0) {
    el.fs.count.textContent = "";
    showState(
      el.fs.state,
      "찾지 못했습니다.",
      "제목을 줄여 보시거나, [우리 도서관] 의 [+ 도서 등록] 에서 직접 넣으셔도 됩니다.",
    );
    return;
  }

  // 두 곳이 각각 세어 주는 수라 정확하지 않다. "약" 을 붙여 그대로 말한다.
  el.fs.count.textContent = `약 ${find.total}건 중 ${find.items.length}권`;
  for (const item of find.items) el.fs.list.append(renderFound(item));

  el.fs.more.hidden = !find.hasMore;
  el.fs.more.disabled = find.loading;
  el.fs.more.textContent = find.loading ? "받는 중…" : "더 보기";
}

function renderFound(item) {
  const li = document.createElement("li");
  li.className = "bfind__item";

  const cover = document.createElement("div");
  cover.className = "bfind__cover";
  if (item.cover_url) {
    const img = document.createElement("img");
    img.src = item.cover_url;
    img.alt = "";
    img.loading = "lazy";
    // 표지 주소가 죽어 있는 일이 흔하다. 깨진 그림 대신 빈 자리로 둔다.
    img.addEventListener("error", () => img.remove());
    cover.append(img);
  }

  const body = document.createElement("div");
  body.className = "bfind__body";

  const title = document.createElement("p");
  title.className = "bfind__title";
  // 바깥에서 온 글이므로 textContent 로만 넣는다
  title.textContent = item.title;
  body.append(title);

  const meta = document.createElement("p");
  meta.className = "bfind__meta";
  meta.textContent = [item.author, item.publisher, item.published_year]
    .filter(Boolean).join(" · ") || "정보 없음";
  body.append(meta);

  const tags = document.createElement("div");
  tags.className = "obs__tags";
  if (item.kdc_label) {
    const tag = document.createElement("span");
    tag.className = "tag tag--area";
    tag.textContent = item.kdc_label;
    if (item.kdc) tag.title = `KDC ${item.kdc}`;
    tags.append(tag);
  }
  if (item.isbn) {
    const isbn = document.createElement("span");
    isbn.className = "tag";
    isbn.textContent = item.isbn;
    tags.append(isbn);
  }
  for (const source of item.sources ?? []) {
    const from = document.createElement("span");
    from.className = "tag";
    from.textContent = source;
    tags.append(from);
  }
  body.append(tags);

  const actions = document.createElement("div");
  actions.className = "bfind__actions";
  if (item.owned_id) {
    const owned = document.createElement("span");
    owned.className = "badge badge--active";
    owned.textContent = "소장 중";
    actions.append(owned, button("그 책 보기", "linkbtn", () => goToOwned(item)));
  } else {
    actions.append(button("등록", "btn btn--small btn--primary", () => registerFound(item)));
  }

  li.append(cover, body, actions);
  return li;
}

/**
 * 이미 가진 책으로 데려간다.
 *
 * 목록을 그 ISBN 하나로 좁혀 보여 준다. 스크롤해서 찾게 하는 것보다 확실하고,
 * 그 자리에서 [수정] 으로 바로 이어진다.
 */
function goToOwned(item) {
  state.query = item.isbn ?? item.title;
  el.search.value = state.query;
  state.status = "전체";
  state.cls = "전체";
  el.classFilter.value = "전체";
  el.classFilter.classList.remove("is-on");
  syncStatusChips();
  goToTab("mine");
  loadBooks();
}

/**
 * 찾은 책을 등록 화면에 채워 연다. 저장하지는 않는다.
 *
 * 바깥에서 온 값이 늘 맞는 것은 아니다(전집의 한 권이 낱권으로 잡히기도 한다).
 * 사람이 눈으로 보고 [저장] 을 눌러야 우리 책이 된다 — 원칙 그대로다.
 */
function registerFound(item) {
  goToTab("mine");
  openCreate();
  fillFromItem(item);
  focusOnWide(el.regNo);
}

async function runFind(nextPage) {
  const find = state.find;
  if (find.loading) return;

  find.loading = true;
  find.error = null;
  find.searched = true;
  if (nextPage === 1) find.items = [];
  renderFind();

  const params = new URLSearchParams();
  if (find.title) params.set("title", find.title);
  if (find.author) params.set("author", find.author);
  params.set("page", String(nextPage));

  try {
    const payload = await get(`/api/books/search?${params}`);
    const items = payload.items ?? [];

    // [더 보기] 로 이어 받을 때 같은 책이 두 번 들어오는 것을 막는다.
    // 두 곳의 결과를 섞어 받으므로 쪽 경계에서 겹칠 수 있다.
    const seen = new Set(find.items.map((one) => one.isbn).filter(Boolean));
    for (const one of items) {
      if (one.isbn && seen.has(one.isbn)) continue;
      if (one.isbn) seen.add(one.isbn);
      find.items.push(one);
    }

    find.total = payload.total ?? find.items.length;
    find.hasMore = Boolean(payload.has_more);
    find.page = nextPage;
  } catch (error) {
    const message = error instanceof TypeError
      ? "서버에 연결하지 못했습니다. 잠시 뒤 다시 눌러 주세요."
      : error.message;
    // 이미 받아 둔 것이 있으면 지우지 않는다. 다음 쪽만 못 받은 것이다.
    if (find.items.length === 0) find.error = message;
    else toast(message, true);
  } finally {
    find.loading = false;
    renderFind();
  }
}

el.fs.form.addEventListener("submit", (event) => {
  event.preventDefault();
  const title = el.fs.title.value.trim();
  const author = el.fs.author.value.trim();
  if (!title && !author) {
    toast("제목이나 저자 중 하나는 넣어 주세요.", true);
    return;
  }
  state.find.title = title;
  state.find.author = author;
  runFind(1);
});

el.fs.more.addEventListener("click", () => runFind(state.find.page + 1));

renderFind();
