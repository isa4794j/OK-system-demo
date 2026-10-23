/**
 * 미분류함 — 카테고리를 못 정한 자원을 한 화면에서 훑는다
 *
 * 일지 카드 안에서도 검토할 수 있다. 둘은 같은 기록을 같은 방식으로 다룬다.
 * 이 화면은 "쌓인 것을 한꺼번에 정리하는" 자리다. 그래서 판단 근거로
 * 원본 일지의 제목과 본문 앞부분을 줄마다 함께 보여준다.
 *
 * 아래에는 "자원 아님"으로 둔 이름들이 있다. 되돌리면 블랙리스트에서 빠지고
 * 그 이름의 기록이 검토로 돌아온다.
 *
 * 브라우저는 Supabase에 직접 접근하지 않는다. 항상 /api/... 를 거친다.
 */
import { button, confirmDialog, formatDate, get, hideState, remove, send, showState, toast } from "./ui.js";
import {
  checkPatch,
  closeRowEditor,
  deleteRecordPrompt,
  patchMessage,
  renderReviewRow,
} from "./resource_review.js";

const state = {
  pending: [],
  rejected: [],
  categories: [],
  loading: false,
  error: null,
};

const el = {
  view: document.getElementById("view-resource-inbox"),
  count: document.getElementById("inbox-count"),
  pending: document.getElementById("inbox-pending"),
  rejected: document.getElementById("inbox-rejected"),
  state: document.getElementById("inbox-state"),
  badge: document.getElementById("inbox-badge"),
  badgeSection: document.getElementById("inbox-badge-section"),
  toggle: document.getElementById("inbox-toggle"),
  body: document.getElementById("inbox-body"),
};

/*
 * 자원사전 맨 아래의 접는 섹션이다(예전의 따로 된 서브탭). 기본 접힘, 뱃지는 머리와 [자원사전] 서브탭에.
 */
el.toggle.addEventListener("click", () => {
  const open = el.body.hidden;
  el.body.hidden = !open;
  el.toggle.setAttribute("aria-expanded", String(open));
  el.toggle.querySelector(".resgroup__mark").textContent = open ? "▾" : "▸";
});

/* ---------- 화면 전환 (app.js가 부른다) ---------- */

/** 자원사전을 열 때 부른다(섹션 자체는 자원사전 화면과 함께 보인다) */
export function showInbox() {
  load();
}

/**
 * 서브탭의 미분류 뱃지를 다시 센다.
 *
 * 일지에서 카테고리를 채우거나 미분류함에서 정리하면 수가 바뀐다.
 * 그때마다 부른다. 실패하면 조용히 둔다 — 뱃지 하나 때문에 화면을 막을 일은 아니다.
 */
export async function refreshInboxBadge() {
  try {
    const payload = await get("/api/resource-inbox");
    setBadge((payload.pending ?? []).length);
  } catch (error) {
    console.error("[refreshInboxBadge]", error);
  }
}

function setBadge(count) {
  for (const badge of [el.badge, el.badgeSection]) {
    badge.textContent = String(count);
    badge.hidden = count === 0;
  }
}

/* ---------- 데이터 ---------- */

async function load() {
  closeRowEditor(); // 목록이 통째로 갈리므로 손보던 줄은 닫는다
  state.loading = true;
  state.error = null;
  render();

  try {
    const payload = await get("/api/resource-inbox");
    state.pending = payload.pending ?? [];
    state.rejected = payload.rejected ?? [];
    state.categories = payload.categories ?? [];
    setBadge(state.pending.length);
  } catch (error) {
    state.error = error.message;
    state.pending = [];
    state.rejected = [];
  } finally {
    state.loading = false;
    render();
  }
}

/* ---------- 그리기 ---------- */

function render() {
  el.pending.replaceChildren();
  el.rejected.replaceChildren();
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

  el.count.textContent = state.pending.length === 0 ? "" : `카테고리 미정 ${state.pending.length}건`;

  renderPending();
  renderRejected();
}

function renderPending() {
  const section = document.createElement("section");
  section.className = "card card--pad";

  const title = document.createElement("h3");
  title.className = "card__title";
  title.textContent = "카테고리 미정";
  section.append(title);

  if (state.pending.length === 0) {
    const empty = document.createElement("p");
    empty.className = "extract__note";
    empty.textContent = "검토할 자원이 없습니다. 일지를 저장하면 뽑힌 자원이 여기 쌓입니다.";
    section.append(empty);
    el.pending.append(section);
    return;
  }

  const hint = document.createElement("p");
  hint.className = "form__hint";
  hint.textContent = "통계에는 \"카테고리 미정\"으로 이미 잡혀 있습니다. " +
    "카테고리를 골라 주면 그 묶음으로 옮겨집니다.";
  section.append(hint);

  const list = document.createElement("ul");
  list.className = "resx__list";

  for (const record of state.pending) {
    const row = renderReviewRow(record, state.categories, {
      onPatch: patchRecord,
      onDelete: askDeleteRecord,
      onRerender: render,
    });
    // 어느 일지에서 나왔는지. 이름만 보고는 판단할 수 없는 줄이 있다.
    row.append(renderSource(record));
    list.append(row);
  }
  section.append(list);
  el.pending.append(section);
}

/** 원본 일지 한 줄 — 날짜 · 종류 · 제목 · 본문 앞부분 */
function renderSource(record) {
  const p = document.createElement("p");
  p.className = "inbox__source";

  const meta = document.createElement("span");
  meta.className = "inbox__meta";
  meta.textContent = [formatDate(record.record_date), record.source, record.journal_title]
    .filter(Boolean)
    .join(" · ");

  const excerpt = document.createElement("span");
  excerpt.className = "inbox__excerpt";
  // 일지 본문은 사용자 입력이므로 textContent로만 넣는다
  excerpt.textContent = record.journal_excerpt ?? "(원본 일지가 지워졌습니다)";

  p.append(meta, excerpt);
  return p;
}

/**
 * "자원 아님"으로 둔 이름들.
 *
 * 되돌리기 하나로 끝낸다. 블랙리스트만 빼면 기록은 '없음'인 채로 남고,
 * 기록만 되돌리면 다음 추출에서 또 '없음'이 된다. 반쯤 취소된 상태를 만들지 않는다.
 */
function renderRejected() {
  if (state.rejected.length === 0) return;

  const section = document.createElement("section");
  section.className = "card card--pad";

  const title = document.createElement("h3");
  title.className = "card__title";
  title.textContent = `자원 아님으로 둔 이름 ${state.rejected.length}건`;
  section.append(title);

  const hint = document.createElement("p");
  hint.className = "form__hint";
  hint.textContent = "이 이름들은 다음 일지에서 뽑지 않습니다. 되돌리면 다시 뽑고, 기록도 검토로 돌아옵니다.";
  section.append(hint);

  const list = document.createElement("ul");
  list.className = "inbox__rejected";

  for (const item of state.rejected) {
    const li = document.createElement("li");
    li.className = "inbox__rejected-item";

    const name = document.createElement("span");
    name.className = "resx__name resx__name--off";
    name.textContent = item.name;

    const count = document.createElement("span");
    count.className = "resx__category";
    count.textContent = item.count > 0 ? `기록 ${item.count}건` : "기록 없음";

    li.append(name, count);

    // 기록만 '없음'이고 블랙리스트에는 없는 이름이 있을 수 있다 (예전 판단).
    // 그것도 되돌릴 수 있어야 하므로 버튼은 늘 둔다.
    li.append(button("↩ 되돌리기", "linkbtn", () => restoreName(item)));
    list.append(li);
  }
  section.append(list);
  el.rejected.append(section);
}

/* ---------- 저장 (낙관적 갱신) ---------- */

async function patchRecord(record, patch) {
  const problem = checkPatch(patch);
  if (problem) {
    toast(problem, true);
    return;
  }

  const saved = state.pending.map((item) => ({ ...item }));
  const savedRejected = state.rejected.map((item) => ({ ...item }));

  // 카테고리가 채워진 줄은 여기서 빠진다. 여기는 "아직 못 정한 것"만 두는 자리다.
  state.pending = state.pending.filter((item) => item.id !== record.id);
  if (patch.status === "없음") {
    addRejectedLocally(record.resource_name);
  }
  setBadge(state.pending.length);
  render();

  try {
    const payload = await send(`/api/resource-records/${record.id}`, "PATCH", patch);
    toast(patchMessage(patch, payload));
  } catch (error) {
    state.pending = saved;
    state.rejected = savedRejected;
    setBadge(state.pending.length);
    render();
    toast(error.message, true);
  }
}

function addRejectedLocally(name) {
  const key = name.trim().toLowerCase();
  const found = state.rejected.find((item) => item.name.toLowerCase() === key);
  if (found) found.count += 1;
  else state.rejected.push({ name: name.trim(), count: 1, blacklisted: true });
  state.rejected.sort((a, b) => a.name.localeCompare(b.name, "ko"));
}

async function askDeleteRecord(record) {
  const yes = await confirmDialog(deleteRecordPrompt(record));
  if (!yes) return;

  const saved = state.pending.map((item) => ({ ...item }));
  state.pending = state.pending.filter((item) => item.id !== record.id);
  setBadge(state.pending.length);
  render();

  try {
    await remove(`/api/resource-records/${record.id}`);
    toast("자원 기록을 삭제했습니다");
  } catch (error) {
    state.pending = saved;
    setBadge(state.pending.length);
    render();
    toast(error.message, true);
  }
}

/** 자원 아님 취소. 되돌아온 기록은 미분류함에 다시 나타나야 하므로 목록을 다시 읽는다. */
async function restoreName(item) {
  const saved = state.rejected.map((row) => ({ ...row }));
  state.rejected = state.rejected.filter((row) => row.name !== item.name);
  render();

  try {
    const payload = await send("/api/resource-inbox/restore", "POST", { name: item.name });
    const restored = payload.restored ?? 0;
    toast(
      restored > 0
        ? `되돌렸습니다: ${item.name} · 기록 ${restored}건이 통계로 돌아왔습니다`
        : `되돌렸습니다: ${item.name} · 다음 일지부터 다시 뽑습니다`,
    );
    // 되돌아온 기록의 원본 일지 정보는 여기 없다. 서버에서 다시 받는다.
    if (restored > 0) await load();
  } catch (error) {
    state.rejected = saved;
    render();
    toast(error.message, true);
  }
}
