/**
 * 관문 경고 — 잠갔으면 막혔을 요청  ★ 관리자 전용
 *
 * 4단계(경고만)에서 정책표의 빈틈을 눈으로 보는 자리다.
 * 여기가 비어 있으면 잠가도 된다는 뜻이고, 잠근 뒤에는 조용해야 한다.
 * 잠근 뒤에 무언가 쌓이면 그때는 실제로 막힌 것이니 정책표를 봐야 한다.
 *
 * 브라우저는 Supabase에 직접 접근하지 않는다. 항상 /api/... 를 거친다.
 */
import {
  button,
  confirmDialog,
  explain,
  get,
  hideState,
  remove,
  showState,
  toast,
} from "./ui.js";

const state = { warnings: [], enforcing: false, mode: null, total: 0, loading: false, error: null };

const el = {
  view: document.getElementById("view-warnings"),
  count: document.getElementById("warn-count"),
  mode: document.getElementById("warn-mode"),
  actions: document.getElementById("warn-actions"),
  list: document.getElementById("warn-list"),
  state: document.getElementById("warn-state"),
};

export function showWarnings() {
  el.view.hidden = false;
  load();
}

export function hideWarnings() {
  el.view.hidden = true;
}

async function load() {
  state.loading = true;
  state.error = null;
  render();

  try {
    const payload = await get("/api/guard-warnings");
    state.warnings = payload.warnings ?? [];
    state.enforcing = Boolean(payload.enforcing);
    state.mode = payload.mode ?? null;
    state.total = payload.total ?? 0;
  } catch (error) {
    state.error = error.message;
    state.warnings = [];
  } finally {
    state.loading = false;
    render();
  }
}

function render() {
  el.list.replaceChildren();
  el.actions.replaceChildren();
  hideState(el.state);

  // 지금 막고 있는지부터 적는다. 이 화면의 뜻이 모드에 따라 완전히 다르다.
  el.mode.textContent = state.enforcing
    ? "잠겨 있습니다. 아래 줄은 실제로 막힌 요청입니다."
    : state.mode === "warn"
    ? "경고만 하는 중입니다 (AUTH_ENFORCE=warn — 비상 되돌리기). 아래 줄은 잠갔으면 막혔을 요청입니다."
    : "첫 관리자를 정하기 전이라 아직 막지 않습니다. 아래 줄은 잠갔으면 막혔을 요청입니다.";
  el.mode.className = state.enforcing ? "form__hint" : "missing__title";

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

  el.count.textContent = state.warnings.length === 0
    ? ""
    : `${state.warnings.length}종 · 모두 ${state.total}번`;

  el.actions.append(button("다시 읽기", "btn btn--small", load));
  if (state.warnings.length > 0) {
    el.actions.append(button("목록 비우기", "linkbtn", askClear));
  }

  if (state.warnings.length === 0) {
    showState(
      el.state,
      "경고가 없습니다.",
      state.enforcing
        ? "막힌 요청이 없습니다."
        : "지금 잠가도 막히는 요청이 없다는 뜻입니다.",
    );
    return;
  }

  for (const one of state.warnings) el.list.append(renderWarning(one));
}

function renderWarning(one) {
  const li = document.createElement("li");
  li.className = "warn";

  const head = document.createElement("div");
  head.className = "warn__head";

  const way = document.createElement("span");
  way.className = "warn__method";
  way.textContent = one.method;

  const path = document.createElement("span");
  path.className = "warn__path";
  // 경로는 바깥에서 온 값이므로 textContent 로만 넣는다
  path.textContent = one.path;

  head.append(way, path);

  if (one.count > 1) {
    const times = document.createElement("span");
    times.className = "tag";
    times.textContent = `${one.count}번`;
    head.append(times);
  }
  // 정책표에 없어서 기본값으로 떨어진 자리. 표에 한 줄 적으면 되는 것이라 따로 표시한다.
  if (one.fallback) {
    const missing = document.createElement("span");
    missing.className = "tag tag--unset";
    missing.textContent = "정책표에 없음";
    explain(missing, "api/policy.ts 에 이 경로를 적어야 합니다");
    head.append(missing);
  }

  const why = document.createElement("p");
  why.className = "warn__why";
  why.textContent = [
    `누가: ${one.who ?? "(미로그인)"}`,
    one.level ? `등급: ${one.level}` : null,
    one.access_kind ? `접속: ${one.access_kind}` : null,
    `필요: ${one.need}`,
    `이유: ${one.reason}`,
  ].filter(Boolean).join(" · ");

  li.append(head, why);
  return li;
}

async function askClear() {
  const yes = await confirmDialog({
    title: "경고 목록을 비울까요?",
    message: "정책표를 고친 뒤 다시 세어 보려면 비우는 것이 맞습니다.\n" +
      "지금까지 쌓인 것은 서버 로그에 남아 있습니다.",
    confirmText: "비우기",
    danger: false,
  });
  if (!yes) return;

  try {
    await remove("/api/guard-warnings");
    toast("비웠습니다");
    await load();
  } catch (error) {
    toast(error.message, true);
  }
}
