/**
 * 반기 관찰 — 아이 하나하나를 두고 반기에 한 번 적는 자리
 *
 * 탭이 아니다. 일지 탭에서 들어와 [뒤로] 로 나간다.
 *
 * [사람마다 한 장]
 * 아동·반기당 한 장이 아니다. 멘토 둘이 같은 아이를 보면 두 장이 맞다.
 * 그래서 이 화면은 "내가 쓴 것" 만 보여 준다. 남이 쓴 장은 내 화면에서 할 일이 없고,
 * 그 안에는 다른 사람이 본 아이 이야기가 그대로 적혀 있다.
 *
 * [열린 반기·닫힌 반기]
 * 상·하반기 둘 다 보인다. 닫힌 반기는 읽기만 된다 — 내가 쓴 글은 그대로 읽히고,
 * 고치거나 새로 쓰는 것만 막힌다. 여닫는 것은 종사자가 PC 에서 한다.
 * 화면에서 [쓰기] 를 감추지만, 실제로 막는 것은 서버다(api/my.ts).
 *
 * [한 번 저장하면 "썼다"]
 * 15항목을 다 채우지 않아도 저장된다. 적다 만 것을 이어 쓰는 것이 실제 모습이다.
 * 명단에는 다 채운 것(작성함)과 일부만 채운 것(일부 작성)을 갈라 보여 주지만,
 * "N명 중 M명" 의 M 에는 둘 다 들어간다. 그 수는 알림이지 관문이 아니다.
 */
import { toast } from "../ui.js";
import { get, send } from "./app.js";
import { openBody, today } from "./form.js";
import { loadView } from "./view.js";

const el = {
  count: document.getElementById("observe-count"),
  halves: document.getElementById("observe-halves"),
  note: document.getElementById("observe-note"),
  closed: document.getElementById("observe-closed"),
  list: document.getElementById("observe-list"),
  empty: document.getElementById("observe-empty"),
  state: document.getElementById("m-state"),
};

/** 영역. 서버(lib/half_items.ts)의 순서와 같다. */
const AREAS = ["생활", "교육", "정서"];

const state = {
  /** 보고 있는 반기. null 이면 아직 서버에 안 물어봤다(이번 반기로 시작한다). */
  year: null,
  half: null,
  /** 서버가 말한 "이번 반기". 담아 두는 것은 이 반기뿐이다. */
  current: null,
  open: true,
  halves: [],
  children: [],
  items: [],
  total: 0,
  written: 0,
};

/** 안 보이는 곳에 그릴 때 쓰는 빈 자리. 일지 탭에서 미리 받을 때 안내가 겹치지 않게. */
function quiet() {
  return document.createElement("div");
}

/** 지금 보는 반기를 붙인 주소. 아직 모르면 안 붙인다 — 그때는 서버가 이번 반기를 준다. */
function query() {
  return state.year ? `?year=${state.year}&half=${state.half}` : "";
}

/** 지금 보는 것이 이번 반기인가. 아직 모르면 그렇다고 본다 — 물어본 적이 없으면 이번 반기가 온다. */
function showingCurrent() {
  if (state.year === null) return true;
  if (!state.current) return false;
  return state.year === state.current.year && state.half === state.current.half;
}

function view({ silent }) {
  return {
    // 이번 반기만 담아 둔다. 지난 반기를 넘겨 볼 때까지 담으면 열쇠가 늘어나기만 한다.
    name: showingCurrent() ? "children" : null,
    url: `/api/my/children${query()}`,
    // 이 화면은 위쪽 안내를 따로 두지 않는다 — 명단은 오래돼도 읽는 데 지장이 없다.
    stale: quiet(),
    state: silent ? quiet() : el.state,
    draw: (data) => {
      state.year = data.period?.year ?? state.year;
      state.half = data.period?.half ?? state.half;
      // 반기를 안 붙이고 물었을 때 돌아온 것이 "이번 반기" 다.
      if (!state.current && data.period) state.current = { ...data.period };
      state.open = data.open !== false;
      state.halves = data.halves ?? [];
      state.children = data.children ?? [];
      state.items = data.items ?? [];
      state.total = data.total ?? state.children.length;
      state.written = data.written_count ?? 0;
      render();
    },
  };
}

/** 일지 탭에서 미리 받아 둔다 — 배너의 "N명 중 M명" 과 들어갔을 때의 기다림 0. */
export function primeObserve() {
  loadView(view({ silent: true }));
}

export function showObserve() {
  render(); // 담아 둔 것이 있으면 곧바로 보인다
  loadView(view({ silent: false }));
}

/* ---------- 그리기 ---------- */

function halfText(year, half) {
  return `${year}년 ${half === 1 ? "상" : "하"}반기`;
}

function render() {
  el.count.textContent = state.year === null
    ? "불러오는 중…"
    : `${halfText(state.year, state.half)} · ${state.total}명 중 ${state.written}명 작성`;

  drawHalves();

  el.note.textContent = state.items.length
    ? `아이마다 한 번 적습니다. ${state.items.length}항목 · 다 채우지 않아도 저장되고, 나중에 이어 쓸 수 있습니다.`
    : "아이마다 한 번 적습니다.";
  el.closed.hidden = state.open;

  el.list.replaceChildren();
  el.empty.hidden = state.children.length > 0;

  for (const child of state.children) {
    el.list.append(renderChild(child));
  }
}

function drawHalves() {
  el.halves.replaceChildren();
  el.halves.hidden = state.halves.length === 0;

  for (const one of state.halves) {
    const node = document.createElement("button");
    node.type = "button";
    node.className = one.half === state.half ? "mseg__item is-on" : "mseg__item";
    node.dataset.half = String(one.half);
    // 닫힌 반기도 들어갈 수 있다 — 읽는 것은 막지 않는다.
    node.textContent = one.half === 1 ? "상반기" : "하반기";
    if (!one.open) node.textContent += " (마감)";
    node.addEventListener("click", () => {
      if (one.half === state.half) return;
      state.half = one.half;
      state.year = one.year;
      loadView(view({ silent: false }));
    });
    el.halves.append(node);
  }
}

/** 명단 옆 표시. 다 채웠으면 "작성함", 한 번 저장했지만 빈 칸이 있으면 "일부 작성". */
function markOf(child) {
  if (!child.written) return { text: "안 씀", todo: true };
  if (state.items.length && !child.complete) return { text: "일부 작성", todo: true };
  return { text: "작성함", todo: false };
}

function renderChild(child) {
  const li = document.createElement("li");
  li.className = "mrow";

  const name = document.createElement("span");
  name.className = "mrow__main";
  // 이름은 사용자 입력이므로 textContent 로만 넣는다
  name.textContent = child.name;

  const grade = document.createElement("span");
  grade.className = "mrow__sub";
  grade.textContent = child.grade ? `${child.grade}학년` : "학년 미상";

  const mark = markOf(child);
  const tag = document.createElement("span");
  tag.className = mark.todo ? "mtag mtag--todo" : "mtag";
  tag.textContent = mark.text;

  li.append(name, grade, tag);

  // 닫힌 반기에서는 내가 쓴 것만 읽는다. 안 쓴 아이에게는 열 것이 없다.
  const canOpen = state.open || child.written;
  if (canOpen) {
    const acts = document.createElement("span");
    acts.className = "mrow__acts";
    const open = document.createElement("button");
    open.type = "button";
    open.className = "mlink";
    open.textContent = !state.open ? "읽기" : (child.written ? "이어 쓰기" : "쓰기");
    open.addEventListener("click", () => write(child));
    acts.append(open);
    li.append(acts);
  }

  return li;
}

/* ---------- 쓰기 ---------- */

/**
 * 한 장을 연다. 이미 쓴 것이 있으면 내 점수·서술이 채워진 채로 열리고,
 * 저장하면 그 장을 덮어쓴다.
 *
 * 닫힌 반기면 읽기 전용으로 연다. 서버도 그 반기 저장을 거절한다.
 */
async function write(child) {
  let payload;
  try {
    payload = await get(`/api/my/observations/${child.id}${query()}`);
  } catch (error) {
    toast(error.message, true);
    return;
  }

  const open = payload.open !== false;
  const before = payload.observation;
  const items = payload.items ?? [];

  // 누른 점수. 같은 칸을 다시 누르면 비운다 — 잘못 누른 것을 되돌릴 길이 있어야 한다.
  const scores = { ...(before?.scores ?? {}) };
  let dateInput;
  let noteInput;

  const value = await openBody({
    title: `${child.name} · ${halfText(state.year, state.half)}`,
    submitText: open ? "저장" : "닫기",
    tall: true,
    build: (panel) => {
      const guide = document.createElement("p");
      guide.className = "mguide";
      guide.textContent = "1 전혀 아니다 · 3 보통 · 5 매우 그렇다";
      panel.append(guide);

      if (!open) {
        const closed = document.createElement("p");
        closed.className = "mclosed";
        closed.textContent = "이 반기는 마감되었습니다. 읽기만 됩니다.";
        panel.append(closed);
      }

      // 관찰일자. 저장한 날과 본 날은 다르다 — 이어 쓰기가 흔하다.
      const dateBox = document.createElement("label");
      dateBox.className = "mfield";
      const dateLabel = document.createElement("span");
      dateLabel.className = "mfield__label";
      dateLabel.textContent = "관찰일자";
      dateInput = document.createElement("input");
      dateInput.type = "date";
      dateInput.className = "mfield__input";
      dateInput.value = before?.observed_on ?? (open ? today() : "");
      dateInput.max = today();
      dateInput.readOnly = !open;
      dateBox.append(dateLabel, dateInput);
      panel.append(dateBox);

      const count = document.createElement("p");
      count.className = "mfield__hint";
      const active = items.filter((one) => !one.deleted);
      const recount = () => {
        const done = active.filter((one) => typeof scores[one.code] === "number").length;
        count.textContent = `${active.length}항목 중 ${done}개 표시`;
      };

      for (const area of AREAS) {
        const inArea = items.filter((one) => one.area === area);
        if (inArea.length === 0) continue;

        const head = document.createElement("h3");
        head.className = "marea";
        head.textContent = area;
        panel.append(head);

        for (const item of inArea) {
          panel.append(scoreRow(item, scores, !open || item.deleted, recount));
        }
      }

      recount();
      panel.append(count);

      const noteBox = document.createElement("label");
      noteBox.className = "mfield";
      const noteLabel = document.createElement("span");
      noteLabel.className = "mfield__label";
      noteLabel.textContent = "특이사항";
      noteInput = document.createElement("textarea");
      noteInput.className = "mfield__input";
      noteInput.rows = 5;
      noteInput.maxLength = 2000;
      noteInput.value = before?.note ?? "";
      noteInput.readOnly = !open;
      noteInput.placeholder = open ? "점수로 남지 않는 것을 적어 주세요." : "";
      noteBox.append(noteLabel, noteInput);
      panel.append(noteBox);
    },
    read: () => ({
      observed_on: dateInput.value || null,
      note: noteInput.value.trim(),
      // 지운 항목은 보내지 않는다. 그 지난 점수는 서버가 살려 둔다.
      scores: Object.fromEntries(
        Object.entries(scores).filter(([code]) =>
          items.some((one) => one.code === code && !one.deleted)
        ),
      ),
    }),
    onValidate: (v) => {
      if (!open) return null; // 저장하지 않고 그냥 닫는다
      if (Object.keys(v.scores).length === 0 && !v.note && !before) {
        return "점수나 특이사항을 하나 이상 적어 주세요.";
      }
      return null;
    },
  });
  if (!value || !open) return;

  try {
    await send(`/api/my/observations/${child.id}${query()}`, "PUT", value);
    toast("저장했습니다");
    loadView(view({ silent: false }));
  } catch (error) {
    toast(error.message, true);
  }
}

/**
 * 항목 한 줄: 문구 + 1~만점 버튼.
 *
 * 버튼이 크다 — 폰에서 다섯 칸을 한 줄에 누르려면 칸 하나가 손끝보다 커야 한다.
 * 고른 칸은 녹색으로 채운다. 영역마다 색을 다르게 하지 않는다(포인트 색 하나).
 */
function scoreRow(item, scores, locked, recount) {
  const box = document.createElement("div");
  box.className = item.deleted ? "mscore mscore--deleted" : "mscore";

  const text = document.createElement("p");
  text.className = "mscore__text";
  const number = Number(item.code.slice(1));
  text.textContent = item.deleted
    ? `(삭제된 항목) ${item.text}`
    : `${number}. ${item.text}`;

  const row = document.createElement("div");
  row.className = "mscore__row";
  row.setAttribute("role", "group");
  row.setAttribute("aria-label", item.text);

  const buttons = [];
  for (let n = 1; n <= item.max; n++) {
    const node = document.createElement("button");
    node.type = "button";
    node.className = "mscore__btn";
    node.textContent = String(n);
    node.disabled = locked;
    node.setAttribute("aria-pressed", String(scores[item.code] === n));
    node.addEventListener("click", () => {
      if (scores[item.code] === n) delete scores[item.code];
      else scores[item.code] = n;
      for (const [i, other] of buttons.entries()) {
        other.setAttribute("aria-pressed", String(scores[item.code] === i + 1));
      }
      recount();
    });
    buttons.push(node);
    row.append(node);
  }

  box.append(text, row);
  return box;
}
