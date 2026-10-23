/**
 * 문의함 — 봉사자가 폰에서 보낸 불편사항
 *
 * 답장은 없다. 주고받기 시작하면 메신저를 만들게 되고, 그건 이 시스템의 일이 아니다.
 * 읽고 [확인함] 을 누르는 것까지다. 누가 언제 확인했는지는 남는다.
 *
 * 폰 화면이 어떻게 보일지 정하는 것은 옆의 [봉사자 설정] 이 맡는다 —
 * 여기는 받은 말을 읽는 자리다.
 *
 * 브라우저는 Supabase에 직접 접근하지 않는다. 항상 /api/... 를 거친다.
 */
import { get, hideState, send, showState, toast } from "./ui.js";

const state = {
  inquiries: [],
  unseen: 0,
  loading: false,
  error: null,
};

const el = {
  view: document.getElementById("view-inquiries"),
  count: document.getElementById("inquiry-count"),
  list: document.getElementById("inquiry-list"),
  state: document.getElementById("inquiry-state"),
  badge: document.getElementById("inquiry-badge"),
};

export function showInquiries() {
  el.view.hidden = false;
  load();
}

export function hideInquiries() {
  el.view.hidden = true;
}

/**
 * 뱃지만 새로 센다. 목록 없이 수만 받는다 —
 * 설정 축을 열 때마다 문의 본문을 다 내려보낼 이유가 없다.
 */
export async function refreshInquiryBadge() {
  try {
    const payload = await get("/api/inquiries/count");
    setBadge(payload.unseen ?? 0);
  } catch (error) {
    // 종사자 아래 등급이면 403 이 온다. 뱃지가 없는 것이 맞는 상태다.
    console.error("[refreshInquiryBadge]", error);
  }
}

function setBadge(count) {
  state.unseen = count;
  el.badge.textContent = String(count);
  el.badge.hidden = count === 0;
}

/* ---------- 데이터 ---------- */

async function load() {
  state.loading = true;
  state.error = null;
  render();

  try {
    const payload = await get("/api/inquiries");
    state.inquiries = payload.inquiries ?? [];
    setBadge(payload.unseen ?? 0);
  } catch (error) {
    state.error = error.message;
    state.inquiries = [];
  } finally {
    state.loading = false;
    render();
  }
}

/* ---------- 그리기 ---------- */

function render() {
  el.list.replaceChildren();
  hideState(el.state);

  el.count.textContent = state.inquiries.length
    ? `${state.inquiries.length}건 · 확인 전 ${state.unseen}건`
    : "";

  if (state.loading) {
    showState(el.state, "불러오는 중…");
    return;
  }
  if (state.error) {
    showState(el.state, "문의를 불러오지 못했습니다.", state.error, true);
    return;
  }
  if (state.inquiries.length === 0) {
    showState(el.state, "받은 문의가 없습니다.", "봉사자가 폰에서 보내면 여기에 쌓입니다.");
    return;
  }

  for (const one of state.inquiries) el.list.append(renderOne(one));
}

function renderOne(one) {
  const li = document.createElement("li");
  li.className = "warn";

  const head = document.createElement("div");
  head.className = "warn__head";

  const who = document.createElement("strong");
  // 이름은 사용자 입력이므로 textContent 로만 넣는다
  who.textContent = one.staff_name ?? "(이름 없음)";

  const when = document.createElement("span");
  when.className = "warn__why";
  when.textContent = whenText(one.created_at);

  // 보낼 때의 역할. 겸직자가 어느 역할로 물었는지 보인다
  if (one.as_role) {
    const role = document.createElement("span");
    role.className = "roletag";
    role.textContent = one.as_role;
    head.append(who, role, when);
  } else {
    head.append(who, when);
  }

  if (one.seen_at) {
    const mark = document.createElement("span");
    mark.className = "warn__why";
    mark.textContent = `· ${whenText(one.seen_at)} 확인함`;
    head.append(mark);
  } else {
    const done = document.createElement("button");
    done.type = "button";
    done.className = "btn btn--small";
    done.textContent = "확인함";
    done.addEventListener("click", () => markSeen(one, done));
    head.append(done);
  }

  const body = document.createElement("p");
  body.className = "warn__why";
  // 문의 본문은 사용자 입력이므로 textContent 로만 넣는다
  body.textContent = one.content ?? "";
  body.style.whiteSpace = "pre-wrap";

  li.append(head, body);
  return li;
}

function whenText(at) {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${when.getMonth() + 1}월 ${when.getDate()}일 ${pad(when.getHours())}:${
    pad(when.getMinutes())
  }`;
}

async function markSeen(one, node) {
  node.disabled = true;
  try {
    await send(`/api/inquiries/${one.id}/seen`, "POST");
    toast("확인 표시를 남겼습니다");
    await load();
  } catch (error) {
    node.disabled = false;
    toast(error.message, true);
  }
}
