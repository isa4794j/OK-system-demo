/**
 * 봉사자 폰 화면 — 탭 셋을 오가는 뼈대
 *
 * 화면마다 하는 일은 각 모듈이 맡고, 여기서는 무엇을 보여줄지만 정한다.
 * PC 의 app.js 와 같은 구조다.
 *
 * [왜 셋인가]
 * 봉사자가 폰에서 하는 일은 "언제 가나 / 무엇을 적나 / 내 것" 셋이다.
 * 관찰은 적는 일이라 일지 안으로, 통계는 내 것이라 나 안으로 들어갔다.
 * 탭이 다섯이면 글자가 줄고, 줄면 안 읽는다.
 *
 * [탭 아닌 화면]
 * 반기 관찰 명단은 일지 탭에서 들어가 [뒤로] 로 나온다.
 * 그동안 아래 탭은 일지에 그대로 켜져 있다 — 지금 어디에서 들어왔는지가 보여야 한다.
 *
 * [탭을 열면 두 가지가 동시에 일어난다]
 *   1. 스냅샷이 있으면 바로 그린다 — 기다리는 시간이 0 이다
 *   2. 그와 동시에 서버에 묻고, 답이 오면 조용히 갈아 끼운다
 * 스냅샷이 없으면 그때만 "불러오는 중" 이 보인다.
 *
 * 브라우저는 Supabase 에 직접 접근하지 않는다. 항상 /api/... 를 거친다.
 */
import { claimFor, clearAll, read, write } from "./store.js";
import { thisMonth } from "./view.js";
import { addSchedule, showSchedule } from "./schedule.js";
import { forgetWelcome, maybeWelcome } from "./welcome.js";
import { showJournal } from "./journal.js";
// 반기별 관찰 숨김(2026-09-17, 데이터 보존) — 되살릴 때: import { showObserve } from "./observe.js";
import { showMe } from "./me.js";
import { setRoleTag } from "./form.js";

/** 화면에 적는 버전. 문의를 받을 때 "옛 화면인가" 를 이 값으로 가른다. */
export const VERSION = "2026.09.17-1";

const TABS = {
  schedule: { title: "일정", show: showSchedule },
  journal: { title: "일지", show: showJournal },
  me: { title: "나", show: showMe },
};

/** 탭이 아닌 화면. 어느 탭에서 들어왔는지를 함께 적어 [뒤로] 가 갈 곳을 안다. */
const SCREENS = {
  // observe: { title: "반기 관찰", from: "journal", show: showObserve },  ← 반기별 관찰 숨김(되살릴 때 풀기)
};

const el = {
  title: document.getElementById("m-title"),
  who: document.getElementById("m-who"),
  back: document.getElementById("m-back"),
  tabs: document.querySelectorAll(".mtab[data-tab]"),
  views: document.querySelectorAll(".mview"),
  logout: document.getElementById("me-logout"),
  main: document.getElementById("m-main"),
  roleTag: document.getElementById("m-role-tag"),
  switchBtn: document.getElementById("m-switch"),
  initial: document.getElementById("m-initial"),
  role: document.getElementById("m-role"),
  roleChoices: document.getElementById("m-role-choices"),
  roleError: document.getElementById("m-role-error"),
};

const state = { tab: null, screen: null, me: null };

/** 지금 로그인한 사람. 화면이 "이 줄이 내 것인가" 를 표시할 때 쓴다(막는 것은 서버다). */
export function whoAmI() {
  return state.me;
}

/* ---------- 겸직 — 지금 역할 ---------- */

/** 역할이 둘 이상인가. 아니면 역할에 관한 것은 아무것도 보이지 않는다(예전과 똑같이). */
export function isMultiRole() {
  return (state.me?.roles?.length ?? 0) > 1;
}

/**
 * 머리줄(모든 탭 같은 모양)과 시트 안 태그를 지금 사람·역할에 맞춘다.
 *   첫 글자 원 + 이름 + 역할 알약. 겸직자는 알약이 지금 역할이고 옆에 전환 아이콘.
 *   시트 안 "○○로 기록됩니다" 는 겸직자만(역할이 하나면 헷갈릴 일이 없다).
 */
function paintRole() {
  const me = state.me;
  const multi = isMultiRole();
  const role = multi ? me?.active_role : (me?.roles?.[0] ?? me?.role ?? null);

  const name = me?.name ?? "";
  el.who.textContent = name;
  // "[검증]이름" 같은 머리표는 건너뛰고 이름의 첫 글자
  el.initial.textContent = name.replace(/^\[[^\]]*\]/, "").slice(0, 1) || name.slice(0, 1);
  el.initial.hidden = !name;

  el.roleTag.hidden = !role && !multi;
  el.roleTag.textContent = role ?? "역할 고르기";
  el.switchBtn.hidden = !multi;
  setRoleTag(multi && role ? `${role}로 기록됩니다` : null);
}

/**
 * 역할을 고르게 한다. 고르면 서버 세션에 적고 화면을 맞춘다.
 * 닫기가 없다 — 겸직자는 역할을 골라야 기록을 남길 수 있다. 전환 때는 지금 역할도 고를 수 있다.
 */
let choosing = null;

export function chooseRole() {
  if (choosing) return choosing;
  const roles = state.me?.roles ?? [];
  el.roleChoices.replaceChildren();
  el.roleError.hidden = true;

  choosing = new Promise((resolve) => {
    for (const role of roles) {
      const node = document.createElement("button");
      node.type = "button";
      node.className = role === state.me?.active_role ? "mbtn mbtn--primary mbtn--wide" : "mbtn mbtn--wide";
      node.textContent = role;
      node.addEventListener("click", async () => {
        for (const other of el.roleChoices.children) other.disabled = true;
        try {
          await send("/api/my/role", "POST", { role });
          state.me = { ...state.me, active_role: role, needs_role_choice: false };
          write("me", state.me);
          paintRole();
          el.role.hidden = true;
          choosing = null;
          resolve(role);
        } catch (error) {
          el.roleError.textContent = error.message;
          el.roleError.hidden = false;
          for (const other of el.roleChoices.children) other.disabled = false;
        }
      });
      el.roleChoices.append(node);
    }
    el.role.hidden = false;
  });
  return choosing;
}

/* ---------- 서버 ---------- */

/**
 * 서버에 묻는다. 세션이 끊겼으면 로그인 화면으로 보낸다.
 *
 * 화면 하나가 API 를 여럿 부르므로 401 도 여럿 온다. 한 번만 보낸다.
 * standalone(홈 화면 앱)에는 주소창이 없어 갇히면 나올 길이 없다.
 */
let leaving = false;

function goLogin() {
  if (leaving) return;
  leaving = true;
  location.replace("/login");
}

/**
 * 서버에 값을 보낸다. 답이 올 때까지 기다린다 —
 * 스냅샷은 보여 주기용이고, 쓰기는 반드시 서버를 다녀온다.
 */
export async function send(url, method, body) {
  const response = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 401) {
    goLogin();
    throw new Error("로그인이 필요합니다.");
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    // 겸직인데 역할을 아직 안 골랐다(다른 기기에서 세션이 바뀐 경우 등). 고르게 하고 다시 누르게 한다.
    if (payload.need_role) {
      state.me = { ...state.me, active_role: null };
      chooseRole();
    }
    throw new Error(payload.error ?? `서버 오류 (HTTP ${response.status})`);
  }
  return payload;
}

/**
 * 미리 받아 둔 것. 페이지가 뜨자마자 띄운 요청이 여기 담긴다.
 *
 * 앱이 뜰 때 예전에는 /api/my/me 를 받고 나서야 첫 화면 데이터를 부르기 시작했다.
 * 서울 Supabase 왕복이 한 번에 0.3~0.4초라, 차례로 하면 사람이 0.8초를 기다린다.
 * 둘을 같이 띄우면 그 시간이 반이 된다.
 *
 * 값이 아니라 약속(Promise)을 담는다 — 아직 안 온 것도 여기 있어야
 * 화면이 물어볼 때 "이미 부르는 중" 이라고 답할 수 있다.
 */
const waiting = new Map();

function prefetch(url) {
  waiting.set(url, ask(url));
  // 아무도 안 가져가면 조용히 버린다. 이것 때문에 오류창이 뜨면 안 된다.
  waiting.get(url).catch(() => {});
}

async function ask(url) {
  const response = await fetch(url);
  if (response.status === 401) {
    goLogin();
    throw new Error("로그인이 필요합니다.");
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error ?? `서버 오류 (HTTP ${response.status})`);
  }
  return payload;
}

export function get(url) {
  const already = waiting.get(url);
  if (already) {
    // 한 번만 쓴다. 두 번째 부를 때는 새로 받아야 방금 쓴 것이 반영된다.
    waiting.delete(url);
    return already;
  }
  return ask(url);
}

// 첫 화면(달력)이 쓸 것을 지금 띄운다. /api/my/me 를 기다리지 않는다.
const firstMonth = thisMonth();
prefetch("/api/my/me");
prefetch(`/api/my/roster?year=${firstMonth.year}&month=${firstMonth.month}`);

/* ---------- 탭 ---------- */

function paint(viewId, title, { back = false } = {}) {
  el.title.textContent = title;
  el.back.hidden = !back;
  for (const view of el.views) view.hidden = view.id !== viewId;

  // 화면 위로. 다른 화면에서 내려 보던 자리가 그대로 남으면 어디인지 헷갈린다.
  el.main.scrollTop = 0;
}

export function goTab(name) {
  const tab = TABS[name];
  if (!tab) return;

  state.tab = name;
  state.screen = null;

  for (const node of el.tabs) {
    const on = node.dataset.tab === name;
    node.classList.toggle("is-on", on);
    if (on) node.setAttribute("aria-current", "page");
    else node.removeAttribute("aria-current");
  }

  paint(`mview-${name}`, tab.title);
  tab.show?.();
}

/** 탭이 아닌 화면을 연다. 아래 탭은 들어온 탭에 그대로 켜져 있다. */
export function goScreen(name) {
  const screen = SCREENS[name];
  if (!screen) return;

  state.screen = name;
  paint(`mview-${name}`, screen.title, { back: true });
  screen.show?.();
}

/** [뒤로] — 들어왔던 탭으로 돌아간다. */
function goBack() {
  const screen = SCREENS[state.screen];
  goTab(screen?.from ?? "schedule");
}

/* ---------- 나가기 ---------- */

async function logout() {
  el.logout.disabled = true;
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } catch {
    // 서버에 못 닿아도 이 기기에서는 나가는 것이 맞다.
  }
  // 남의 기기에 내 일정이 남지 않게. 로그아웃의 절반은 이것이다.
  clearAll();
  forgetWelcome();
  location.replace("/login");
}

/* ---------- 시작 ---------- */

for (const node of el.tabs) {
  node.addEventListener("click", () => goTab(node.dataset.tab));
}
el.back.addEventListener("click", goBack);
el.switchBtn.addEventListener("click", () => chooseRole());
el.logout.addEventListener("click", logout);

/**
 * 앱을 연다.
 *
 * 담아 둔 "나" 가 있으면 서버를 기다리지 않고 곧바로 첫 화면을 그린다.
 * 앞사람 것이 비칠 걱정은 로그인 화면이 덜어 준다 — 로그인할 때 이 기기의
 * 스냅샷을 지우므로, 여기 남아 있는 것은 지금 로그인한 사람 것뿐이다.
 * 그래도 서버 답이 오면 한 번 더 맞춰 본다 — 다르면 전부 지우고 다시 그린다.
 */
async function start() {
  const saved = read("me")?.data ?? null;
  if (saved?.id) {
    // 담아 둔 역할은 믿지 않는다 — 세션이 바뀌었을 수 있다. 서버 답이 오면 맞춘다.
    state.me = { ...saved, active_role: null };
    paintRole();
    goTab("schedule");
  }

  let payload;
  try {
    payload = await get("/api/my/me");
  } catch {
    return; // 401 이면 이미 로그인 화면으로 갔다
  }
  if (!payload.me) return;

  const fresh = { ...payload.me, journal_scope: payload.journal_scope };
  const changed = saved?.id !== fresh.id;

  state.me = fresh;
  // 담긴 것이 이 사람 것인지 확인한다. 다른 사람이면 여기서 전부 지워진다.
  claimFor(fresh.id);
  write("me", fresh);
  paintRole();

  // 이미 그린 화면이 이 사람 것이면 그대로 둔다 — 다시 그리면 요청이 두 벌 나간다.
  if (changed) goTab(state.tab ?? "schedule");

  // 겸직인데 이 세션에서 아직 역할을 안 골랐다 — 로그인 직후가 그렇다.
  if (fresh.needs_role_choice) await chooseRole();

  // 로그인 뒤 한 번 — 환영과 할 일(다음 일정·안 쓴 일지)
  maybeWelcome(fresh, { get, goTab, addSchedule });
}

start();

/*
 * 서비스워커. 캐시하지 않는다 — 홈 화면에 설치될 수 있게 하는 것이 전부다(sw.js 참고).
 * 실패해도 앱은 그대로 돈다. 설치가 안 될 뿐이다.
 */
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch((error) => {
    console.error("[서비스워커 등록]", error);
  });
}
