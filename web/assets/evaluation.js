/**
 * 반기 평가 — 아동 상세의 "연간 평가" 카드
 *
 * 보고 있는 아동과 기간은 children.js 가 쥐고 있으므로 여기서는 갖지 않는다.
 * 그릴 때마다 getContext() 로 최신 값을 받아 온다.
 * 그래야 기간 칩을 바꾸거나 관찰이 다시 로드돼도 저절로 따라간다.
 *
 * AI 초안은 만들어 주기만 하고 저장하지 않는다.
 * 사람이 읽고 고친 뒤 [저장]을 눌러야 기록이 된다.
 *
 * [근거가 바뀌었는지]
 * 평가를 저장할 때 "무엇을 읽고 썼는지" 가 함께 찍힌다(근거 스냅샷).
 * 다음에 이 화면을 열면 서버가 그때와 지금을 견줘 무엇이 바뀌었는지 알려 준다.
 * 견주는 일은 서버가 한다 — 여기서는 받은 결과를 그리기만 한다.
 * [확인함] 은 "바뀐 것을 읽고 받아들였다" 는 표시다. 평가 본문은 건드리지 않는다.
 *
 * [정량 점수는 참고다]
 * 봉사자가 폰에서 매긴 점수를 옆에 놓고 볼 뿐, AI 초안에도 근거에도 들어가지 않는다.
 */
import { button, formatDate, get, hideState, send, showState, toast } from "./ui.js";
import { areaName, isOldArea, obsAreas } from "./obs_areas.js";
import { HALF_OBSERVATION } from "./features.js";
import { openPrint } from "./print_link.js";

/** 서버(/db/observations.ts)의 목록과 같아야 한다. */
/**
 * 평가 칸 — 지금 쓰는 영역 + 글이 남아 있는 예전 영역(지운 영역의 지난 평가는 지우지 않고 보인다).
 * 영역 목록은 obs_areas.js 한 벌.
 */
function evalAreas() {
  return obsAreas()
    .filter((area) => !area.deleted || (state.content[area.code] ?? "").trim())
    .map((area) => area.code);
}

const state = {
  mode: "view", // view = 열람, edit = 편집
  content: {}, // { 영역: 서술문 }
  saved: false,
  updatedAt: null,
  loading: false,
  error: null,
  drafting: false,
  pending: false,
  /** 서버가 견준 결과. null 이면 저장된 평가가 없다. */
  evidence: null,
  /** 바뀐 목록을 펼쳤는지 */
  openChanges: false,
  /** [확인함] 을 누르고 답을 기다리는 중 */
  checking: false,
  /** 봉사자 정량 관찰. null 이면 그 반기에 점수가 없다. */
  quant: null,
  /** AI 초안을 막 만들어 아직 저장하지 않은 상태인지 */
  fromDraft: false,
  openEvidence: new Set(),
};

const el = {
  actions: document.getElementById("eval-actions"),
  quant: document.getElementById("eval-quant"),
  evidence: document.getElementById("eval-evidence"),
  meta: document.getElementById("eval-meta"),
  notice: document.getElementById("eval-notice"),
  areas: document.getElementById("eval-areas"),
  state: document.getElementById("eval-state"),
  changed: document.getElementById("eval-changed"),
};
el.state.dataset.inline = "true";

/* 좁은 화면 — 연간 평가 카드는 ▸ 로 접혀 있다. 펼치면 보기·수정·AI 초안·근거 확인 전부 그대로. */
const fold = {
  card: document.getElementById("eval-card"),
  toggle: document.getElementById("eval-toggle"),
};
fold.toggle.addEventListener("click", () => {
  const open = !fold.card.classList.contains("is-open");
  fold.card.classList.toggle("is-open", open);
  fold.toggle.setAttribute("aria-expanded", String(open));
  fold.toggle.querySelector(".resgroup__mark").textContent = open ? "▾" : "▸";
});

/** () => { child, year, half, observations } */
let getContext = () => ({ child: null, year: 0, half: 1, observations: [] });

export function initEvaluation(contextFn) {
  getContext = contextFn;
}

/** 그 영역의 관찰. 근거 보기와 건수 표시에 쓴다. */
function observationsOf(area) {
  return getContext().observations.filter((item) => item.area === area);
}

function periodText() {
  const { year, half } = getContext();
  return `${year}년 ${half === 1 ? "상반기" : "하반기"}`;
}

/* ---------- 불러오기 ---------- */

/** 아동이나 기간이 바뀔 때 children.js 가 부른다. */
export async function loadEvaluation() {
  const { child, year, half } = getContext();
  if (!child) return;

  state.loading = true;
  state.error = null;
  state.fromDraft = false;
  state.openEvidence = new Set();
  renderEvaluation();

  const params = new URLSearchParams({ year: String(year), half: String(half) });

  try {
    const payload = await get(`/api/children/${child.id}/evaluation?${params}`);
    const saved = payload.evaluation;
    state.evidence = payload.evidence ?? null;
    state.quant = payload.quant ?? null;
    state.openChanges = false;
    state.saved = !!saved;
    state.content = { ...(saved?.content ?? {}) };
    state.updatedAt = saved?.updated_at ?? null;
    // 저장된 것이 있으면 열람부터. 없으면 바로 쓸 수 있게 편집으로 연다.
    state.mode = saved ? "view" : "edit";
  } catch (error) {
    state.error = error.message;
  } finally {
    state.loading = false;
    renderEvaluation();
  }
}

/* ---------- 그리기 ---------- */

export function renderEvaluation() {
  el.actions.replaceChildren();
  el.areas.replaceChildren();
  hideState(el.state);
  el.notice.hidden = !state.fromDraft;

  el.meta.textContent = periodText() +
    (state.saved
      ? ` · 저장됨${state.updatedAt ? ` (${state.updatedAt.slice(0, 10)})` : ""}`
      : " · 아직 저장하지 않음");

  renderQuant();
  renderEvidenceState();

  if (state.loading) {
    showState(el.state, "불러오는 중…");
    return;
  }
  if (state.error) {
    showState(el.state, state.error, null, true);
    return;
  }
  if (state.drafting) {
    showState(el.state, "AI가 관찰을 읽고 있어요…", "관찰이 많으면 시간이 걸립니다.");
    return;
  }

  if (state.mode === "view") {
    renderRead();
    return;
  }
  renderEdit();
}

/* ---------- 봉사자 정량 관찰 (참고) ---------- */

function renderQuant() {
  el.quant.replaceChildren();
  // 반기별 관찰을 숨긴 동안은 정량 참고 카드도 없다(서버도 quant 를 null 로 준다)
  if (!HALF_OBSERVATION || !state.quant || state.loading) return;

  const box = document.createElement("div");
  box.className = "quant";

  const head = document.createElement("p");
  head.className = "quant__head";
  head.textContent = "봉사자 정량 관찰 — 참고용, AI 초안에는 반영되지 않음";
  box.append(head);

  const areas = document.createElement("ul");
  areas.className = "quant__areas";
  for (const one of state.quant.areas ?? []) {
    const li = document.createElement("li");
    li.className = "quant__area";

    const name = document.createElement("span");
    name.className = "quant__name";
    name.textContent = one.area;

    const value = document.createElement("span");
    value.className = "quant__value";
    value.textContent = one.avg === null ? "—" : one.avg.toFixed(1);

    li.append(name, value);
    areas.append(li);
  }
  box.append(areas);

  const sub = document.createElement("p");
  sub.className = "quant__sub";
  const partial = state.quant.partial > 0
    ? ` · 그중 ${state.quant.partial}명은 일부만 채움`
    : "";
  sub.textContent = `5점 만점 · 관찰자 ${state.quant.authors}명${partial}`;
  box.append(sub);

  el.quant.append(box);
}

/* ---------- 근거가 바뀌었는지 ---------- */

function renderEvidenceState() {
  el.evidence.replaceChildren();
  const found = state.evidence;
  // 접힌 머리줄에도 알린다 — 펼쳐야만 배너가 보이면 모르고 지나간다(페르소나 리뷰)
  el.changed.hidden = !(found && !state.loading && found.tracked && found.total > 0);
  if (!found || state.loading) return;

  // 근거를 찍기 전에 저장된 평가. 견줄 것이 없다.
  if (!found.tracked) {
    const note = document.createElement("p");
    note.className = "evid__note";
    note.textContent =
      "근거 추적 이전에 저장된 평가입니다. 저장하거나 [근거 확인함]을 누르면 그때부터 추적합니다.";
    note.append(checkButton("근거 확인함"));
    el.evidence.append(note);
    return;
  }

  if (found.total === 0) {
    if (!found.checked_at) return;
    const note = document.createElement("p");
    note.className = "evid__note";
    note.textContent = `근거 확인함 · ${dayText(found.checked_at)}${
      found.checked_by_name ? ` · ${found.checked_by_name}` : ""
    }`;
    el.evidence.append(note);
    return;
  }

  el.evidence.append(changeBanner(found));
}

/** "2026-09-14T…" → "9월 14일" */
function dayText(at) {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return "";
  return `${when.getMonth() + 1}월 ${when.getDate()}일`;
}

function changeBanner(found) {
  const box = document.createElement("div");
  box.className = "evid";

  const head = document.createElement("div");
  head.className = "evid__head";

  const title = document.createElement("p");
  title.className = "evid__title";
  title.textContent = "평가를 저장한 뒤 근거가 바뀌었습니다";

  const counts = document.createElement("p");
  counts.className = "evid__counts";
  counts.textContent = countText(found);

  const words = document.createElement("div");
  words.append(title, counts);

  const actions = document.createElement("div");
  actions.className = "evid__actions";
  actions.append(
    button(state.openChanges ? "접기" : "자세히", "btn btn--small", () => {
      state.openChanges = !state.openChanges;
      renderEvaluation();
    }),
    checkButton("확인함"),
  );

  head.append(words, actions);
  box.append(head);

  if (state.openChanges) box.append(changeList(found));
  return box;
}

/** "수정 2 · 병합됨 1 · 추가 1" — 사라진 것은 왜 사라졌는지로 나눠 센다. */
function countText(found) {
  const parts = [];
  if (found.modified.length) parts.push(`수정 ${found.modified.length}`);

  const byKind = new Map();
  for (const one of found.removed) byKind.set(one.kind, (byKind.get(one.kind) ?? 0) + 1);
  for (const [kind, n] of byKind) parts.push(`${kind} ${n}`);

  if (found.added.length) parts.push(`추가 ${found.added.length}`);
  return parts.join(" · ");
}

function changeList(found) {
  const box = document.createElement("div");
  box.className = "evid__list";

  const groups = [
    ["고쳐짐", found.modified, "지금 내용입니다. 평가 서술과 어긋나는지 보세요."],
    ["근거에서 빠짐", found.removed, "합쳐졌거나 지워졌거나, 영역이 풀린 것입니다."],
    ["새로 들어옴", found.added, "이 관찰은 평가를 쓸 때 없었습니다."],
  ];

  for (const [label, rows, why] of groups) {
    if (rows.length === 0) continue;

    const head = document.createElement("p");
    head.className = "evid__group";
    head.textContent = `${label} (${rows.length})`;
    box.append(head);

    const hint = document.createElement("p");
    hint.className = "evid__why";
    hint.textContent = why;
    box.append(hint);

    const list = document.createElement("ul");
    list.className = "areaview__list";
    for (const one of rows) list.append(changeItem(one));
    box.append(list);
  }
  return box;
}

function changeItem(one) {
  const li = document.createElement("li");
  li.className = "areaview__item";

  const date = document.createElement("div");
  date.className = "areaview__date";
  const bits = [one.obs_date ? formatDate(one.obs_date) : "날짜 모름"];
  if (one.area) bits.push(one.area);
  if (one.kind) bits.push(one.kind);
  date.textContent = bits.join(" · ");

  const content = document.createElement("p");
  content.className = "areaview__content";
  // 관찰 내용은 사용자 입력이므로 textContent로만 넣는다
  content.textContent = one.content ?? "";

  li.append(date, content);
  return li;
}

function checkButton(label) {
  const node = button(
    state.checking ? "확인하는 중…" : label,
    "btn btn--primary btn--small",
    confirmEvidence,
  );
  node.disabled = state.checking;
  return node;
}

/**
 * [확인함] — 지금 근거를 새 기준으로 삼는다.
 *
 * 평가 본문은 건드리지 않는다. 누가 언제 눌렀는지는 서버가 남긴다.
 */
async function confirmEvidence() {
  const { child, year, half } = getContext();
  if (!child || state.checking) return;

  state.checking = true;
  renderEvaluation();
  try {
    await send(`/api/children/${child.id}/evaluation/evidence-check`, "POST", { year, half });
    toast("근거를 확인한 것으로 남겼습니다");
    state.checking = false;
    await loadEvaluation();
  } catch (error) {
    state.checking = false;
    renderEvaluation();
    toast(error.message, true);
  }
}

function printButton(run) {
  const node = button("🖨 인쇄", "btn wide-only", run);
  node.title = "평가서 인쇄";
  node.setAttribute("aria-label", "평가서 인쇄");
  return node;
}

function renderRead() {
  const { child, year, half } = getContext();
  el.actions.append(
    // 평가서 인쇄(새 창, PC 전용 — 좁은 화면 숨김) — 저장된 평가를 관찰일지와 같은 양식으로
    printButton(() => openPrint({ kind: "evaluation", child: child.id, year, half })),
    button("수정", "btn", () => {
      state.mode = "edit";
      renderEvaluation();
    }),
  );

  const written = evalAreas().filter((area) => (state.content[area] ?? "").trim());
  if (written.length === 0) {
    showState(el.state, "저장된 평가가 비어 있습니다.", "[수정]에서 내용을 채울 수 있습니다.");
    return;
  }
  for (const area of written) {
    el.areas.append(renderArea(area, false));
  }
}

function renderEdit() {
  el.actions.append(
    button("AI 초안 생성", "btn", makeDraft),
    button("저장", "btn btn--primary", saveEvaluation),
  );
  if (state.saved) {
    // 저장된 값으로 되돌린다. 고치던 것은 버린다.
    el.actions.append(button("취소", "btn", loadEvaluation));
  }
  for (const area of evalAreas()) {
    el.areas.append(renderArea(area, true));
  }
}

function renderArea(area, editable) {
  const box = document.createElement("section");
  box.className = "evalarea";

  const head = document.createElement("div");
  head.className = "evalarea__head";

  const name = document.createElement(editable ? "label" : "span");
  name.className = "evalarea__name";
  name.textContent = areaName(area);
  if (editable) name.htmlFor = `eval-${area}`;
  head.append(name);
  if (isOldArea(area)) {
    box.classList.add("evalarea--old");
    const tag = document.createElement("span");
    tag.className = "tag area__old";
    tag.textContent = "예전 영역";
    head.append(tag);
  }

  if (editable) {
    const count = document.createElement("span");
    count.className = "evalarea__count";
    const n = observationsOf(area).length;
    count.textContent = n === 0 ? "관찰 없음" : `관찰 ${n}건`;
    head.append(count);
  }

  head.append(evidenceButton(area));
  box.append(head);

  if (editable) {
    const input = document.createElement("textarea");
    input.className = "input textarea";
    input.id = `eval-${area}`;
    input.rows = 4;
    input.value = state.content[area] ?? "";
    input.placeholder = "~음 / ~함 체로 씁니다.";
    // 입력 중에는 다시 그리지 않는다. 다시 그리면 커서가 튄다.
    input.addEventListener("input", () => {
      state.content[area] = input.value;
    });
    box.append(input);
  } else {
    const text = document.createElement("p");
    text.className = "evalarea__text";
    text.textContent = state.content[area] ?? "";
    box.append(text);
  }

  if (state.openEvidence.has(area)) box.append(renderEvidence(area));
  return box;
}

/** 근거 보기 — AI가 무엇을 읽고 썼는지 사람이 확인할 수 있어야 한다 */
function evidenceButton(area) {
  const open = state.openEvidence.has(area);
  return button(open ? "근거 닫기" : "근거 보기", "linkbtn evalarea__evidence", () => {
    if (open) state.openEvidence.delete(area);
    else state.openEvidence.add(area);
    renderEvaluation();
  });
}

function renderEvidence(area) {
  const items = observationsOf(area);
  const box = document.createElement("div");
  box.className = "evidence";

  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "extract__note";
    empty.textContent = `${periodText()}에 이 영역의 관찰이 없습니다.`;
    box.append(empty);
    return box;
  }

  const list = document.createElement("ul");
  list.className = "areaview__list";
  for (const item of items) {
    const li = document.createElement("li");
    li.className = "areaview__item";

    const date = document.createElement("div");
    date.className = "areaview__date";
    date.textContent = formatDate(item.obs_date);

    const content = document.createElement("p");
    content.className = "areaview__content";
    // 관찰 내용은 사용자 입력이므로 textContent로만 넣는다
    content.textContent = item.content ?? "";

    li.append(date, content);
    list.append(li);
  }
  box.append(list);
  return box;
}

/* ---------- AI 초안 ---------- */

async function makeDraft() {
  const { child, year, half } = getContext();
  if (!child || state.drafting) return;

  state.drafting = true;
  renderEvaluation();

  try {
    const draft = await send(`/api/children/${child.id}/evaluation/draft`, "POST", { year, half });

    if (draft.used === 0) {
      toast(
        draft.unassigned > 0
          ? `이 반기 관찰이 모두 영역 미지정이라 초안을 만들 수 없어요. ` +
            `날짜별 편집에서 영역을 먼저 지정해 주세요. (${draft.unassigned}건)`
          : "이 반기 관찰이 없어 초안을 만들 수 없어요.",
        true,
      );
      return;
    }

    state.content = { ...state.content, ...draft.content };
    state.fromDraft = true;
    toast(
      draft.unassigned > 0
        ? `관찰 ${draft.used}건으로 초안을 만들었습니다. ` +
          `영역 미지정 ${draft.unassigned}건은 쓰이지 않았습니다.`
        : `관찰 ${draft.used}건으로 초안을 만들었습니다`,
    );
  } catch (error) {
    toast(error.message, true);
  } finally {
    state.drafting = false;
    renderEvaluation();
  }
}

/* ---------- 저장 ---------- */

async function saveEvaluation() {
  const { child, year, half } = getContext();
  if (!child || state.pending) return;

  state.pending = true;
  try {
    const payload = await send(`/api/children/${child.id}/evaluation`, "PUT", {
      year,
      half,
      content: state.content,
    });

    state.saved = true;
    state.updatedAt = payload.evaluation?.updated_at ?? null;
    state.content = { ...(payload.evaluation?.content ?? {}) };
    state.fromDraft = false;
    state.mode = "view";
    toast("저장되었습니다");
    // 저장하면서 근거가 다시 찍혔다. 화면의 "바뀜" 도 그 기준으로 새로 받는다.
    await loadEvaluation();
  } catch (error) {
    toast(error.message, true);
  } finally {
    state.pending = false;
  }
}
