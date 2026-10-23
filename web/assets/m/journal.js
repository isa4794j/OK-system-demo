/**
 * 일지 탭 — 봉사일지와 반기 관찰 입구
 *
 * 무엇이 보이는지는 센터 설정(volunteer_journal_scope)이 정한다.
 * 기본은 '전체' 다 — 격주로 오는 사람이 지난주에 무슨 일이 있었는지 알아야 한다.
 * 거르는 일은 서버가 한다. 화면이 받은 값으로 거르면 본문은 이미 폰에 온 뒤다.
 * 센터가 '본인' 으로 좁혀 두면 [전체 보기] 전환 자체가 안 나타난다 —
 * 없는 것을 누를 자리를 두지 않는다.
 *
 * [안 쓴 일지]
 * 일정은 있는데 일지가 없는 날. 기준은 PC 스케줄 화면의 미작성과 같다 —
 * 서버가 같은 곳(monthOverview.missing)에서 세어 준다. 두 화면이 서로 다른 기준으로
 * 세면 "안 썼다" 는 말이 화면마다 달라진다.
 *
 * [PC 와 같은 규칙]
 * 일정이 있는 날만 쓸 수 있다. 시각은 그 일정에서 읽는다 — 일지에 따로 적지 않는다.
 * 고칠 때는 내용만 바뀐다. 날짜를 바꾸는 것은 "다른 날 일지" 라는 뜻이고,
 * 그러면 새로 쓰는 것이 맞다.
 *
 * 수퍼비전 댓글은 종사자가 단 것이라 읽기만 한다.
 *
 * [공유는 올해 것만]
 * 설정이 '전체' 여도 남이 쓴 일지는 올해 것만 서버가 준다. 지난해 달을 [전체 보기] 로
 * 넘기면 내 것만 보이므로, 조용히 비지 않게 한 줄로 알린다.
 *
 * [나눠 받기]
 * 목록은 서버가 15건씩 준다(커서). 목록 아래 줄이 화면에 들어오면 다음 쪽을 받는다.
 * [내 일지]/[전체 보기] 도 서버가 거른다 — 한 쪽이 "거른 결과" 15건이어야 한다.
 * 스냅샷에는 첫 쪽만 담는다. 다음 쪽은 그때그때 받는다.
 */
import { confirmDialog, toast } from "../ui.js";
import { get, goScreen, send } from "./app.js";
import { openForm, today } from "./form.js";
import { DEMO_NOTICE } from "../demo_notice.js";
// 반기별 관찰 숨김(2026-09-17, 데이터 보존) — 되살릴 때: import { primeObserve } from "./observe.js";
import { dayLabel, loadView, refreshView, thisMonth, timeLabel } from "./view.js";
import { rolePill } from "./role_chips.js";
import { closePicker, pickMonth } from "./month_picker.js";
import { foldBody } from "./fold.js";

const el = {
  stale: document.getElementById("journal-stale"),
  observeOpen: document.getElementById("observe-open"),
  month: document.getElementById("journal-month"),
  bar: document.getElementById("journal-bar"),
  monthBtn: document.getElementById("journal-month-btn"),
  dayClear: document.getElementById("journal-day-clear"),
  prev: document.getElementById("journal-prev"),
  next: document.getElementById("journal-next"),
  undoneBox: document.getElementById("undone-box"),
  undoneList: document.getElementById("undone-list"),
  scope: document.getElementById("journal-scope"),
  seg: document.getElementById("journal-seg"),
  segItems: document.querySelectorAll(".mseg__item[data-scope]"),
  add: document.getElementById("journal-add"),
  list: document.getElementById("journal-list"),
  more: document.getElementById("journal-more"),
  empty: document.getElementById("journal-empty"),
  state: document.getElementById("m-state"),
};

const now = thisMonth();

const state = {
  /** 보고 있는 달 */
  year: now.year,
  month: now.month,
  /** 목록에 담긴 것 (설정이 '본인' 이면 서버가 이미 내 것만 준다) */
  journals: [],
  scope: "전체",
  /**
   * [전체 보기] 가 기본. 센터 설정이 '본인' 이면 서버가 어차피 내 것만 준다 — 화면은 따로 가르지 않는다.
   */
  showAll: true,
  /** 일정은 있는데 일지가 없는 날 */
  undone: [],
  /** 다음 쪽 위치. null 이면 끝 */
  nextCursor: null,
  loadingMore: false,
  /** 지난해 달을 '전체' 로 보는 중 — 남의 일지는 서버가 주지 않는다 */
  othersHidden: false,
  /** 고른 기간 { from, to } ("YYYY-MM-DD", 하루면 둘이 같다). null 이면 보고 있는 달 전체 */
  span: null,
};

/* ---------- 데이터 ---------- */

/** 보고 있는 달의 첫날과 마지막 날. 이번 달만 담아 둔다(달력과 같은 판단). */
function range() {
  const pad = (n) => String(n).padStart(2, "0");
  const last = new Date(state.year, state.month, 0).getDate();
  return {
    from: `${state.year}-${pad(state.month)}-01`,
    to: `${state.year}-${pad(state.month)}-${pad(last)}`,
    thisMonth: state.year === now.year && state.month === now.month,
  };
}

/** 지금 보고 있는 쪽([내 일지]/[전체 보기])의 주소. 거르기는 서버가 한다. */
function listUrl() {
  const when = state.span ?? range();
  const all = state.showAll;
  return `/api/my/journals?from=${when.from}&to=${when.to}${all ? "" : "&mine=1"}`;
}

function view() {
  const when = range();
  const all = state.showAll;
  const url = listUrl();
  return {
    // 이번 달 첫 쪽만 담아 둔다. [전체 보기] 는 열쇠를 나눈다 — 섞여 그려지면 안 된다.
    // 기간을 고른 쪽은 담지 않는다(열쇠가 기간마다 갈라지지 않게).
    name: when.thisMonth && !state.span ? (all ? "journals-all" : "journals") : null,
    url,
    stale: el.stale,
    state: el.state,
    draw: (data) => {
      // 달을 빠르게 넘기면 앞서 부른 답이 나중에 올 수 있다. 지금 보는 쪽의 답만 그린다 —
      // 섞이면 "8월" 제목 아래 7월 일지가 보이고, 다음 쪽도 엉뚱한 자리에서 받는다.
      if (url !== listUrl()) return;
      state.journals = data.journals ?? [];
      state.scope = data.scope ?? "본인";
      state.nextCursor = data.next_cursor ?? null;
      state.othersHidden = !!data.others_hidden;
      render();
    },
  };
}

/**
 * 다음 15건. 받은 것은 뒤에 붙이고 스냅샷에는 담지 않는다(첫 쪽만 담는다).
 * 그 사이 달이나 보기를 바꿨으면 늦게 온 답을 버린다.
 */
async function loadMore() {
  if (!state.nextCursor || state.loadingMore) return;
  const asked = { url: listUrl(), cursor: state.nextCursor };

  state.loadingMore = true;
  try {
    const data = await get(`${asked.url}&cursor=${encodeURIComponent(asked.cursor)}`);
    if (listUrl() !== asked.url || state.nextCursor !== asked.cursor) return;
    const have = new Set(state.journals.map((one) => one.id));
    for (const one of data.journals ?? []) {
      if (!have.has(one.id)) state.journals.push(one);
    }
    state.nextCursor = data.next_cursor ?? null;
    render();
  } catch (error) {
    toast(error.message, true);
  } finally {
    state.loadingMore = false;
  }
}

/** 끝 줄이 이미 화면(과 그 아래 200px) 안에 있으면 다음 쪽을 받는다 */
function checkMore() {
  if (el.more.hidden || !state.nextCursor) return;
  const rect = el.more.getBoundingClientRect();
  if (rect.height > 0 && rect.top < globalThis.innerHeight + 200) loadMore();
}

// 목록 아래 줄이 보이면 다음 쪽. 스크롤 칸 안에서도 화면에 들어온 것을 알아챈다.
if ("IntersectionObserver" in globalThis) {
  new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) loadMore();
  }, { rootMargin: "200px 0px" }).observe(el.more);
}

/** 안 쓴 일지는 내 일정에서 온다. 달력 탭과 같은 값을 두 번 받지 않게 열쇠를 나눈다. */
function scheduleView() {
  const when = range();
  const month = `${state.year}-${state.month}`;
  return {
    name: when.thisMonth ? "schedule" : null,
    url: `/api/my/schedules?from=${when.from}&to=${when.to}`,
    // 위쪽 안내는 일지 목록이 쓴다. 두 줄이 겹쳐 뜨면 시끄럽다.
    stale: document.createElement("div"),
    state: document.createElement("div"),
    draw: (data) => {
      if (month !== `${state.year}-${state.month}`) return; // 늦게 온 다른 달의 답
      state.undone = (data.schedules ?? []).filter((one) => one.unwritten);
      drawUndone();
    },
  };
}

export function showJournal() {
  loadView(view());
  loadView(scheduleView());
  // 관찰 명단은 여기서 미리 받아 둔다 — 입구 버튼에 "21명 중 3명" 을 적어야 하고,
  // 들어갔을 때 기다리는 시간이 0 이 된다.
  // primeObserve();  ← 반기별 관찰 숨김(되살릴 때 풀기)
}

async function reload() {
  await refreshView(view());
  await refreshView(scheduleView());
}

/* ---------- 그리기 ---------- */

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

/** 그 달로 간다. 지정해 둔 날짜는 풀린다. */
function goMonth(year, month, span = null) {
  closePicker();
  state.year = year;
  state.month = month;
  state.span = span;
  state.nextCursor = null;
  loadView(view());
  loadView(scheduleView());
}

// 달 이름(📅) — 달·날짜 고르기. 날짜를 고르면 그날 일지만, [N월 전체] 면 달 전체.
// 다시 누르면 접힌다.
el.monthBtn.addEventListener("click", async () => {
  if (closePicker()) return;
  const picked = await pickMonth(el.bar, {
    year: state.year,
    month: state.month,
    from: state.span?.from ?? null,
    to: state.span?.to ?? null,
    withDay: true,
  });
  if (!picked) return;
  // 기간이면 시작일의 달을 "보고 있는 달" 로 둔다(안 쓴 일지는 그 달 기준)
  goMonth(picked.year, picked.month, picked.from ? { from: picked.from, to: picked.to } : null);
});
// [×] — 고르기 판이 열려 있으면 닫기만(원래 기간 그대로), 닫혀 있으면 기간을 풀고 달 전체로
el.dayClear.addEventListener("click", () => {
  if (closePicker()) return;
  goMonth(state.year, state.month);
});

el.prev.addEventListener("click", () => moveMonth(-1));
el.next.addEventListener("click", () => moveMonth(1));

function render() {
  // 하루면 "9월 2일", 기간이면 "9월 2일~9월 5일", 아니면 "2026년 9월"
  el.month.textContent = state.span ? spanLabel(state.span) : `${state.year}년 ${state.month}월`;
  el.dayClear.hidden = !state.span;
  el.list.replaceChildren();

  const all = state.scope === "전체";
  el.seg.hidden = !all;

  // 거르기는 서버가 했다 — 받은 것을 그대로 그린다
  const rows = state.journals;

  el.empty.hidden = rows.length > 0;
  const span = !state.span ? "이 달" : state.span.from === state.span.to ? "그날" : "그 기간에";
  el.empty.textContent = `${span} 쓴 일지가 없습니다.`;
  // 안내 문장은 두지 않는다. 지난해 달을 [전체 보기] 로 볼 때만 — 목록이 왜 짧은지 알린다.
  const hidden = all && state.showAll && state.othersHidden;
  el.scope.hidden = !hidden;
  el.scope.textContent = hidden
    ? `${state.year}년 일지는 본인 것만 보여요. 다른 봉사자 일지는 올해 것만 함께 봅니다.`
    : "";

  for (const one of rows) el.list.append(renderOne(one));

  // 남은 쪽이 있을 때만 아래 줄을 둔다(보이면 다음 쪽을 받는다)
  el.more.hidden = !state.nextCursor;
  // 한 쪽이 짧아 끝 줄이 계속 보이고 있으면 관찰자는 다시 알리지 않는다 — 직접 한 번 본다
  requestAnimationFrame(checkMore);
}

/** "9월 2일" / "9월 2일~9월 5일" */
function spanLabel({ from, to }) {
  const one = (date) => `${Number(date.slice(5, 7))}월 ${Number(date.slice(8))}일`;
  return from === to ? one(from) : `${one(from)}~${one(to)}`;
}

function drawUndone() {
  el.undoneList.replaceChildren();
  el.undoneBox.hidden = state.undone.length === 0;

  for (const one of state.undone) {
    const li = document.createElement("li");
    li.className = "mrow mrow--undone";

    const day = document.createElement("span");
    day.className = "mrow__main";
    day.textContent = dayLabel(one.sched_date);

    const time = document.createElement("span");
    time.className = "mrow__sub";
    time.textContent = `${timeLabel(one.start_time)}–${timeLabel(one.end_time)}`;

    const acts = document.createElement("span");
    acts.className = "mrow__acts";
    acts.append(linkBtn("쓰기", () => writeFor(one.sched_date)));

    li.append(day, time, acts);
    el.undoneList.append(li);
  }
}

function renderOne(one) {
  const li = document.createElement("li");
  li.className = "mcardrow";

  const head = document.createElement("div");
  head.className = "mcardrow__head";

  const day = document.createElement("span");
  day.className = "mrow__main";
  day.textContent = dayLabel(one.journal_date);

  const who = document.createElement("span");
  who.className = "mtag";
  // 이름은 사용자 입력이므로 textContent 로만 넣는다
  who.textContent = one.mine ? "나" : (one.author_name ?? "?");

  head.append(day, who);
  // 쓸 때의 역할(as_role). 섞어 보기에서 누가 어느 활동으로 썼는지 보인다.
  const pill = rolePill(one.as_role);
  if (pill) head.append(pill);

  if (one.start_time) {
    const time = document.createElement("span");
    time.className = "mrow__sub";
    time.textContent = `${timeLabel(one.start_time)}–${timeLabel(one.end_time)}`;
    head.append(time);
  }

  const body = document.createElement("p");
  body.className = "mcardrow__body";
  // 일지 본문은 사용자 입력이므로 textContent 로만 넣는다
  body.textContent = one.content ?? "";

  li.append(head, body, foldBody(body, "mlink"));

  // 수퍼비전 댓글. 종사자가 남긴 말이라 눈에 띄어야 한다.
  if (one.comment) {
    const comment = document.createElement("p");
    comment.className = "mcomment";
    comment.textContent = `수퍼비전 · ${one.comment}`;
    li.append(comment);
  }

  // 내 것에만 손댈 자리를 둔다. 실제로 막는 것은 서버다.
  if (one.mine) {
    const acts = document.createElement("div");
    acts.className = "mrow__acts";
    acts.append(
      linkBtn("수정", () => editOne(one)),
      linkBtn("삭제", () => removeOne(one), true),
    );
    li.append(acts);
  }

  return li;
}

function linkBtn(label, run, danger = false) {
  const node = document.createElement("button");
  node.type = "button";
  node.className = danger ? "mlink mlink--danger" : "mlink";
  node.textContent = label;
  node.addEventListener("click", run);
  return node;
}

/* ---------- 전환 ---------- */

for (const node of el.segItems) {
  node.addEventListener("click", () => {
    state.showAll = node.dataset.scope === "all";
    for (const other of el.segItems) {
      other.classList.toggle("is-on", other === node);
    }
    // 거르기가 서버로 옮겨 갔으므로 쪽을 바꾸면 다시 받는다
    state.nextCursor = null;
    loadView(view());
  });
}

// 반기별 관찰 숨김 — 입구 배너(m.html #observe-open)는 hidden. 되살릴 때:
// el.observeOpen.addEventListener("click", () => goScreen("observe"));

/* ---------- 쓰기 ---------- */

/** 그 날짜로 바로 쓴다. [안 쓴 일지] 에서 누르면 날짜를 다시 고를 이유가 없다. */
async function writeFor(date) {
  const value = await openForm({
    notice: DEMO_NOTICE,
    title: `${dayLabel(date)} 일지`,
    submitText: "저장",
    fields: [
      { name: "date", label: "날짜", value: dayLabel(date), readonly: true },
      {
        name: "content",
        label: "내용",
        type: "textarea",
        max: 5000,
        placeholder: "그날 아이들과 무엇을 했는지 적어 주세요.",
      },
    ],
    onValidate: (v) => (!v.content ? "내용을 적어 주세요." : null),
  });
  if (!value) return;

  try {
    await send("/api/my/journals", "POST", { journal_date: date, content: value.content });
    toast("저장했습니다");
    await reload();
  } catch (error) {
    toast(error.message, true);
  }
}

el.add.addEventListener("click", async () => {
  // 일정이 있는 날만 쓸 수 있다. 날짜를 고르기 전에 어느 날이 되는지 보여 준다 —
  // 다 적고 나서 "그날은 일정이 없습니다" 를 보면 사람이 두 번 일한다.
  const when = range();
  let days = [];
  try {
    const payload = await get(`/api/my/schedules?from=${when.from}&to=${when.to}`);
    days = (payload.schedules ?? []).map((one) => one.sched_date);
  } catch (error) {
    toast(error.message, true);
    return;
  }

  if (days.length === 0) {
    toast(`${state.month}월에 잡힌 일정이 없습니다. 일정을 먼저 넣어 주세요.`, true);
    return;
  }
  // 봉사일지는 활동한 뒤에 쓴다 — 앞날 일정은 고를 수 없다(서버도 거절한다)
  days = days.filter((one) => one <= today());
  if (days.length === 0) {
    toast("아직 진행하지 않은 봉사예요 — 활동 후에 작성해 주세요.", true);
    return;
  }

  // 기본값은 오늘이다. 오늘 일정이 없으면 일정 있는 날 중 가장 가까운 지난 날 —
  // 일지는 다녀온 날에 쓰는 것이라 앞날보다 지난날이 맞다.
  const past = days.filter((one) => one <= today());
  const start = days.includes(today())
    ? today()
    : (past[past.length - 1] ?? days[0]);

  const value = await openForm({
    notice: DEMO_NOTICE,
    title: "일지 쓰기",
    submitText: "저장",
    fields: [
      {
        name: "date",
        label: "날짜",
        type: "date",
        value: start,
        list: days,
        hint: `일정이 있는 날: ${days.map((d) => d.slice(5).replace("-", "/")).join(", ")}`,
      },
      {
        name: "content",
        label: "내용",
        type: "textarea",
        max: 5000,
        placeholder: "그날 아이들과 무엇을 했는지 적어 주세요.",
      },
    ],
    onValidate: (v) => {
      if (!days.includes(v.date)) return "그날은 일정이 없습니다. 일정 있는 날을 골라 주세요.";
      if (!v.content) return "내용을 적어 주세요.";
      return null;
    },
  });
  if (!value) return;

  try {
    await send("/api/my/journals", "POST", {
      journal_date: value.date,
      content: value.content,
    });
    toast("저장했습니다");
    await reload();
  } catch (error) {
    toast(error.message, true);
  }
});

async function editOne(one) {
  const value = await openForm({
    notice: DEMO_NOTICE,
    title: `${dayLabel(one.journal_date)} 일지`,
    fields: [
      // 날짜는 보여만 준다. 바꾸는 것은 "다른 날 일지" 라는 뜻이라 새로 쓰는 것이 맞다.
      { name: "date", label: "날짜", value: dayLabel(one.journal_date), readonly: true },
      { name: "content", label: "내용", type: "textarea", max: 5000, value: one.content ?? "" },
    ],
    onValidate: (v) => (!v.content ? "내용을 적어 주세요." : null),
  });
  if (!value) return;

  try {
    await send(`/api/my/journals/${one.id}`, "PATCH", { content: value.content });
    toast("고쳤습니다");
    await reload();
  } catch (error) {
    toast(error.message, true);
  }
}

async function removeOne(one) {
  const yes = await confirmDialog({
    title: "이 일지를 삭제할까요?",
    message: `${dayLabel(one.journal_date)}\n되돌릴 수 없습니다.`,
    confirmText: "삭제",
  });
  if (!yes) return;

  try {
    await send(`/api/my/journals/${one.id}`, "DELETE");
    toast("삭제했습니다");
    await reload();
  } catch (error) {
    toast(error.message, true);
  }
}
