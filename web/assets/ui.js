/**
 * 화면 공통 도구
 *
 * 여러 화면이 같이 쓰는 것만 둔다. 화면별 로직은 각자 파일에.
 */
import { DEMO_NOTICE } from "./demo_notice.js";
import { PRIVACY_EXAMPLES, PRIVACY_FIRST, PRIVACY_RULES } from "./privacy_text.js";

/* ---------- 서버 통신 ---------- */

/**
 * 세션이 끊겼을 때 로그인 화면으로 보낸다.
 *
 * 화면 하나가 열릴 때 API 를 예닐곱 개 부른다. 세션이 끊기면 401 이 그만큼 온다.
 * 그때마다 보내면 주소가 여러 번 갈리므로 한 번만 보낸다.
 */
let leaving = false;

function toLogin() {
  if (leaving) return;
  leaving = true;
  location.replace("/login");
}

/**
 * 응답을 값으로 바꾼다. 안 되면 던진다.
 *
 * 401  세션이 없거나 끊겼다 — 로그인 화면으로 보낸다. 화면이 할 일은 없다.
 * 403  로그인은 됐지만 이 자리를 볼 등급이 아니다 — 화면이 그 사실을 적어야 한다.
 *      던지는 오류에 forbidden 을 붙여 두면 부르는 쪽이 갈라 다룰 수 있다.
 *      갈라 다루지 않아도 메시지가 그대로 화면에 뜨므로 빈 화면이 되지는 않는다.
 */
async function unwrap(response) {
  const payload = await response.json().catch(() => ({}));
  if (response.ok) return payload;

  if (response.status === 401) {
    toLogin();
    throw new Error(payload.error ?? "로그인이 필요합니다.");
  }

  const error = new Error(payload.error ?? `서버 오류 (HTTP ${response.status})`);
  if (response.status === 403) error.forbidden = true;
  // 고를 거리가 딸린 거절(예: 409 이름 충돌)은 화면이 본문을 보고 선택지를 띄운다
  error.status = response.status;
  error.payload = payload;
  throw error;
}

/** GET. 실패하면 서버가 준 메시지로 예외를 던진다. */
export async function get(url) {
  return await unwrap(await fetch(url));
}

/** POST / PATCH. 실패하면 서버가 준 메시지로 예외를 던진다. */
export async function send(url, method, body) {
  return await unwrap(await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

/* ---------- 스낵바 ---------- */

const snackbar = document.getElementById("snackbar");
let snackbarTimer = null;

export function toast(message, isError = false) {
  snackbar.textContent = message;
  snackbar.className = isError ? "snackbar snackbar--error" : "snackbar";
  snackbar.hidden = false;

  clearTimeout(snackbarTimer);
  snackbarTimer = setTimeout(() => {
    snackbar.hidden = true;
  }, isError ? 6000 : 2500);
}

/* ---------- 설명이 딸린 표시 ---------- */

/**
 * 표시(태그 등)에 설명을 붙인다.
 *
 * 마우스로는 올려 두면 title 이 뜬다. 손가락에는 올려 두기가 없어 title 을 읽을 방법이 없다.
 * 그래서 눌러도 같은 글이 스낵바로 뜨게 한다. 터치 화면에서는 ⓘ 표시가 붙어
 * "누르면 설명이 나온다" 는 것을 알린다(style.css .hint).
 *
 * 내용이 판단에 필요한 설명에만 쓴다. 보이는 글자를 되풀이할 뿐인 title 에는 쓰지 않는다.
 */
export function explain(node, text) {
  node.title = text;
  node.classList.add("hint");
  node.tabIndex = 0;
  node.setAttribute("role", "button");
  node.setAttribute("aria-label", `${node.textContent} — ${text}`);
  const show = (event) => {
    // 카드 전체가 눌리는 자리에 있어도 설명만 띄운다
    event.stopPropagation();
    toast(text);
  };
  node.addEventListener("click", show);
  node.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      show(event);
    }
  });
  return node;
}

/* ---------- 로딩 / 비어있음 / 오류 표시 ---------- */

export function showState(box, message, hint, isError = false) {
  box.replaceChildren();
  box.className = isError ? "state state--error" : "state";
  if (box.dataset.inline === "true") box.classList.add("state--inline");

  const p = document.createElement("p");
  p.style.margin = "0";
  p.textContent = message;
  box.append(p);

  if (hint) {
    const small = document.createElement("p");
    small.className = "state__hint";
    small.textContent = hint;
    box.append(small);
  }
  box.hidden = false;
}

export function hideState(box) {
  box.replaceChildren();
  box.hidden = true;
}

/* ---------- 작은 도구들 ---------- */

export function toOption(value) {
  return { value, label: value };
}

export function fillOptions(select, options) {
  select.replaceChildren();
  for (const { value, label } of options) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    select.append(option);
  }
}

export function button(label, className, onClick) {
  const node = document.createElement("button");
  node.type = "button";
  node.className = className;
  node.textContent = label;
  node.addEventListener("click", onClick);
  return node;
}

/**
 * 넓은 화면에서만 초점을 준다. 좁은 화면(폰)은 모달이 열리자마자 키보드가 올라와 화면을 덮으므로
 * 사람이 칸을 눌러야 올라오게 둔다(일지 작성과 같은 규칙).
 */
export function focusOnWide(node) {
  if (WIDE?.matches ?? true) node?.focus();
}

/** "2026-08-14" → "8월 14일" */
export function formatDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ""));
  if (!match) return String(value ?? "-");
  return `${Number(match[2])}월 ${Number(match[3])}일`;
}

/** 오늘을 "YYYY-MM-DD"로. (toISOString은 UTC라 한국에서 하루 어긋날 수 있어 직접 만든다) */
export function todayISO() {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 받침에 맞춘 "로/으로" — ㄹ 받침은 "로"(서울로), 다른 받침은 "으로", 받침 없으면 "로" */
export function ro(word) {
  const last = String(word ?? "").trim().slice(-1);
  const code = last.charCodeAt(0) - 0xac00;
  if (code < 0 || code > 11171) return "(으)로";
  const tail = code % 28;
  return tail === 0 || tail === 8 ? "로" : "으로";
}

export function pad(n) {
  return String(n).padStart(2, "0");
}

/* ---------- 사람 색 ---------- */

/** 사람을 가리는 색. 점 하나에만 쓰므로 여섯 개면 충분하다. */
const COLOR_COUNT = 6;

/**
 * 사람마다 다른 색을 준다. .personchip--N 의 N 이 된다.
 *
 * color_index 가 있으면 그것을, 없으면 id 로 만든 값을 쓴다.
 * id 에서 뽑으면 새로고침해도 같은 사람은 같은 색이다.
 * 스케줄과 일지가 이 함수를 같이 쓴다 — 화면마다 색이 달라지면 점이 쓸모없어진다.
 */
export function personColor(item) {
  if (Number.isInteger(item.color_index)) return item.color_index % COLOR_COUNT;

  const id = String(item.staff_id ?? item.id ?? "");
  let sum = 0;
  for (let i = 0; i < id.length; i += 1) sum = (sum + id.charCodeAt(i)) % 997;
  return sum % COLOR_COUNT;
}

/* ---------- 개인정보 안내문 ---------- */

/**
 * 일지 작성 화면마다 같은 안내가 붙는다. 글은 privacy_text.js 한 곳에만 적고
 * (폰 화면도 같은 글을 쓴다 — 폰은 이 파일을 불러오지 않는다),
 * 여기서는 .notice--privacy 자리에 모양만 채워 넣는다.
 */

/**
 * 첫 줄만 늘 보이고, 나머지(일반 명칭 안내·적지 않는 것·예시)는 [자세히 ▾] 안에 접는다.
 * 좁은 화면에서 안내 상자가 작성 화면의 절반을 차지하던 것을 줄인다.
 * 넓은 화면은 예전처럼 다 펼친 채로 둔다(접기 버튼도 안 보인다 — CSS).
 */
const WIDE = globalThis.matchMedia?.("(min-width: 721px)");

function fillPrivacyNotices() {
  for (const box of document.querySelectorAll(".notice--privacy")) {
    box.replaceChildren();

    // 데모 저장소에만 있는 줄 — 접지 않고 늘 맨 위에 보인다.
    const demo = document.createElement("p");
    demo.className = "notice__lead notice__demo";
    demo.textContent = DEMO_NOTICE;
    box.append(demo);

    const lead = document.createElement("p");
    lead.className = "notice__lead";
    lead.textContent = PRIVACY_FIRST;
    box.append(lead);

    const more = document.createElement("details");
    more.className = "notice__more";
    more.open = !!WIDE?.matches;

    const summary = document.createElement("summary");
    summary.textContent = "자세히";
    more.append(summary);

    for (const line of PRIVACY_RULES) {
      const p = document.createElement("p");
      p.className = "notice__lead";
      p.textContent = line;
      more.append(p);
    }

    const list = document.createElement("ul");
    list.className = "notice__examples";
    for (const [before, after] of PRIVACY_EXAMPLES) {
      const item = document.createElement("li");
      item.textContent = `${before} → ${after}`;
      list.append(item);
    }
    more.append(list);
    box.append(more);
  }
}

fillPrivacyNotices();
// 창 폭이 넓어지면 펼친다(넓은 화면은 늘 펼친 모양)
WIDE?.addEventListener?.("change", (event) => {
  if (!event.matches) return;
  for (const one of document.querySelectorAll(".notice__more")) one.open = true;
});

/* ---------- 확인 대화상자 ---------- */

let confirmParts = null;

/** 처음 쓸 때 한 번만 만든다. 화면마다 마크업을 두지 않기 위해서. */
function buildConfirm() {
  if (confirmParts) return confirmParts;

  const modal = document.createElement("div");
  modal.className = "modal";
  modal.hidden = true;

  const backdrop = document.createElement("div");
  backdrop.className = "modal__backdrop";

  const dialog = document.createElement("div");
  dialog.className = "modal__dialog modal__dialog--confirm";
  dialog.setAttribute("role", "alertdialog");
  dialog.setAttribute("aria-modal", "true");

  const title = document.createElement("h3");
  title.className = "confirm__title";

  // 첫 줄은 "무엇을" — 조금 강조. 나머지는 경고 — 작고 흐리게, 앞에 ⚠.
  const target = document.createElement("p");
  target.className = "confirm__target";

  // 저장될 내용을 그대로 보여 주는 자리. 합치기처럼 결과를 미리 봐야 하는 창만 쓴다.
  const preview = document.createElement("pre");
  preview.className = "confirm__preview";
  preview.hidden = true;

  const message = document.createElement("p");
  message.className = "confirm__message";

  const actions = document.createElement("div");
  actions.className = "modal__actions modal__actions--end";

  const okBtn = document.createElement("button");
  okBtn.type = "button";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "btn";
  cancelBtn.textContent = "취소";

  // 창을 닫지 않는 보조 동작(초대코드 [복사]) — 넘긴 창에서만 보인다
  const extraBtn = document.createElement("button");
  extraBtn.type = "button";
  extraBtn.className = "btn confirm__extra";
  extraBtn.hidden = true;

  // 취소가 먼저, 되돌릴 수 없는 쪽이 오른쪽 끝
  actions.append(extraBtn, cancelBtn, okBtn);
  dialog.append(title, target, preview, message, actions);
  modal.append(backdrop, dialog);
  document.body.append(modal);

  confirmParts = { modal, backdrop, title, target, preview, message, actions, okBtn, cancelBtn, extraBtn };
  return confirmParts;
}

/**
 * 메시지를 "대상 한 줄"과 "경고"로 나눈다.
 * 부르는 쪽은 예전부터 첫 줄에 이름·날짜를, 그 아래에 경고를 적어 왔다.
 * 줄이 하나뿐이면 대상 없이 경고만이다.
 */
function splitMessage(message) {
  const lines = String(message ?? "").split("\n");
  if (lines.length === 1) return { target: "", warn: lines[0] };
  const [first, ...rest] = lines;
  return { target: first.trim(), warn: rest.join("\n").trim() };
}

/**
 * 되돌릴 수 없는 일을 하기 전에 한 번 묻는다.
 *
 * 되돌릴 수 없는 쪽(삭제)에만 빨강을 쓴다.
 * 바깥을 누르거나 Esc를 누르면 "아니오"로 본다.
 * 실수로 창을 닫았을 때 지워지는 일이 없어야 하기 때문.
 *
 * preview 는 "누르면 이렇게 저장된다"를 그대로 보여 줄 때만 넘긴다(관찰 합치기).
 * 없으면 그 자리 자체가 나타나지 않아, 기존 확인창의 생김새는 그대로다.
 */
export function confirmDialog({
  title,
  message,
  preview = "",
  // 미리보기를 크게 보여야 하는 자리가 있다(초대코드 여섯 자리).
  // 기본은 지금까지와 같은 작은 글씨다.
  previewClass = "",
  confirmText = "삭제",
  cancelText = "취소",
  danger = true,
  // 닫지 않는 보조 버튼 — { text, run }. 없으면 보이지 않는다
  extra = null,
  // 취소 버튼을 감출 때(알리기만 하는 창)
  hideCancel = false,
}) {
  const parts = buildConfirm();

  const { target, warn } = splitMessage(message);
  parts.title.textContent = title;
  parts.target.textContent = target;
  parts.target.hidden = !target;
  // 사용자 입력이 그대로 들어오는 자리라 textContent 로만 넣는다
  parts.preview.textContent = preview;
  parts.preview.className = previewClass
    ? `confirm__preview ${previewClass}`
    : "confirm__preview";
  parts.preview.hidden = !preview;
  parts.message.textContent = warn;
  parts.message.hidden = !warn;
  parts.okBtn.textContent = confirmText;
  parts.cancelBtn.textContent = cancelText;
  parts.okBtn.className = danger ? "btn btn--danger" : "btn btn--primary";
  parts.cancelBtn.hidden = hideCancel;
  parts.extraBtn.hidden = !extra;
  parts.extraBtn.textContent = extra?.text ?? "";
  parts.extraBtn.onclick = extra ? () => extra.run() : null;
  parts.modal.hidden = false;
  (hideCancel ? parts.okBtn : parts.cancelBtn).focus();

  return new Promise((resolve) => {
    const close = (answer) => {
      parts.modal.hidden = true;
      parts.okBtn.removeEventListener("click", onOk);
      parts.cancelBtn.removeEventListener("click", onCancel);
      parts.backdrop.removeEventListener("click", onCancel);
      document.removeEventListener("keydown", onKey);
      resolve(answer);
    };
    const onOk = () => close(true);
    const onCancel = () => close(false);
    const onKey = (event) => {
      if (event.key === "Escape") close(false);
    };

    parts.okBtn.addEventListener("click", onOk);
    parts.cancelBtn.addEventListener("click", onCancel);
    parts.backdrop.addEventListener("click", onCancel);
    document.addEventListener("keydown", onKey);
  });
}

/**
 * 글을 클립보드에 넣는다. 보안 문맥(https·localhost)이 아니면 옛 방법으로 한 번 더 해 본다.
 * 성공하면 true.
 */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    let done = false;
    try {
      done = document.execCommand("copy");
    } catch {
      done = false;
    }
    area.remove();
    return done;
  }
}

/** DELETE. 실패하면 서버가 준 메시지로 예외를 던진다. */
export async function remove(url) {
  const response = await fetch(url, { method: "DELETE" });
  if (response.status === 204) return {};
  if (response.status === 401 || response.status === 403) return await unwrap(response);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error ?? `서버 오류 (HTTP ${response.status})`);
  }
  return payload;
}

/* ---------- 맨 위로 ---------- */

/** 이만큼 내려가면 버튼을 보여 준다. 한 화면 남짓. */
const TO_TOP_AFTER = 600;

/**
 * 긴 목록에서 맨 위로 돌아가는 버튼.
 *
 * 화면마다 만들지 않고 하나를 본문 칸에 붙여 둔다.
 * 굴러가는 것은 창이 아니라 본문 칸(.main)이라 거기에 매단다.
 *
 * 스크롤 자리를 기억해 두는 화면(일지 목록)과 부딪히지 않는다 —
 * 이 버튼은 사람이 누를 때만 움직이고, 스스로 자리를 바꾸지 않는다.
 *
 * app.js 가 시작할 때 한 번 부른다.
 */
/* ---------- 드롭다운 메뉴 ---------- */

/**
 * 버튼에 딸린 작은 메뉴. 지금은 계정 관리의 [⋯] 이 쓰고, 다음 것도 여기를 쓴다.
 *
 * [왜 body 에 붙이나]
 * 버튼 옆에 붙여 두면 그 줄을 감싼 칸이 잘라 버린다 — .main 은 세로로 굴러가고,
 * 목록은 표 안에 있다. 화면 맨 위(body)에 fixed 로 띄우면 아무도 자를 수 없다.
 *
 * [가장자리를 피한다]
 * 오른쪽 끝 열에서 오른쪽으로 펼치면 거의 늘 잘린다. 맨 아랫줄도 마찬가지다.
 * 열 때 남은 자리를 재어, 모자란 쪽 반대로 편다.
 *
 * [fixed 라 따라다니지 않는다]
 * 화면이 굴러가면 메뉴만 제자리에 남아 엉뚱한 곳을 가리킨다.
 * 그래서 굴리거나 창 크기를 바꾸면 닫는다 — 따라 움직이게 만드는 것보다 단순하고,
 * 메뉴는 열자마자 고르는 것이라 닫혀도 손해가 없다.
 */

/** 버튼과 메뉴 사이, 그리고 화면 가장자리와의 최소 간격 */
const MENU_GAP = 4;
const MENU_EDGE = 8;

let openMenuNode = null;
let openMenuClose = null;

/** 열려 있는 메뉴를 닫는다. 없으면 아무 일도 안 한다. */
export function closeMenu() {
  openMenuClose?.();
}

/**
 * items 는 [{ label, run, danger, disabled, title }] 다.
 * disabled 인 줄은 눌리지 않는다 — 왜 안 되는지는 title 에 적는다.
 *
 * anchor 는 이 메뉴를 연 버튼이다. 그 자리를 기준으로 편다.
 */
export function openMenu(anchor, items, { onClose } = {}) {
  closeMenu();

  const menu = document.createElement("div");
  menu.className = "menu";
  menu.setAttribute("role", "menu");

  for (const one of items) {
    const node = document.createElement("button");
    node.type = "button";
    node.className = one.danger ? "menu__item menu__item--danger" : "menu__item";
    node.setAttribute("role", "menuitem");
    node.textContent = one.label;
    if (one.title) node.title = one.title;
    // 눌리지 않는 항목은 누를 수도 없어 title 을 띄울 길이 없다.
    // 터치 화면에서는 이유를 항목 아래에 글로 보인다(style.css .menu__why).
    if (one.disabled && one.title) {
      const why = document.createElement("span");
      why.className = "menu__why";
      why.textContent = one.title;
      node.append(why);
    }
    if (one.disabled) node.disabled = true;
    else {
      node.addEventListener("click", (event) => {
        event.stopPropagation();
        close();
        one.run();
      });
    }
    menu.append(node);
  }

  document.body.append(menu);
  placeMenu(menu, anchor);

  // 첫 줄에 초점을 둔다. 키보드로 연 사람이 곧바로 고를 수 있게.
  menu.querySelector(".menu__item:not([disabled])")?.focus();

  function close() {
    if (openMenuNode !== menu) return;
    menu.remove();
    openMenuNode = null;
    openMenuClose = null;
    document.removeEventListener("click", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
    globalThis.removeEventListener("resize", close);
    globalThis.removeEventListener("scroll", close, true);
    onClose?.();
  }

  function onOutside(event) {
    if (!menu.contains(event.target) && event.target !== anchor) close();
  }

  function onKey(event) {
    if (event.key === "Escape") {
      close();
      anchor.focus();
    }
  }

  document.addEventListener("click", onOutside, true);
  document.addEventListener("keydown", onKey, true);
  globalThis.addEventListener("resize", close);
  // capture 로 받는다 — 굴러가는 것은 .main 이지 창이 아니다.
  globalThis.addEventListener("scroll", close, true);

  openMenuNode = menu;
  openMenuClose = close;
  return menu;
}

/**
 * 남은 자리를 재어 놓는다.
 *
 * 가로: 버튼 오른쪽 끝에 맞춰 왼쪽으로 편다(오른쪽 끝 열이 흔하므로 이쪽이 기본).
 *       그래도 왼쪽으로 넘치면 버튼 왼쪽 끝에 맞추고, 그것도 안 되면 화면 안으로 민다.
 * 세로: 아래로 편다. 아래가 모자라면 위로. 위도 모자라면 화면 안으로 민다.
 */
function placeMenu(menu, anchor) {
  const at = anchor.getBoundingClientRect();
  const size = menu.getBoundingClientRect();
  const wide = globalThis.innerWidth;
  const high = globalThis.innerHeight;

  let left = at.right - size.width;
  if (left < MENU_EDGE) left = at.left;
  left = Math.max(MENU_EDGE, Math.min(left, wide - size.width - MENU_EDGE));

  let top = at.bottom + MENU_GAP;
  if (top + size.height > high - MENU_EDGE) {
    const above = at.top - size.height - MENU_GAP;
    top = above >= MENU_EDGE ? above : Math.max(MENU_EDGE, high - size.height - MENU_EDGE);
  }

  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
}

export function initToTop() {
  const scroller = document.querySelector(".main");
  if (!scroller) return;

  const node = document.createElement("button");
  node.type = "button";
  node.className = "totop";
  node.hidden = true;
  node.setAttribute("aria-label", "맨 위로");
  node.title = "맨 위로";
  node.textContent = "↑";

  node.addEventListener("click", () => {
    scroller.scrollTo({ top: 0, behavior: "smooth" });
    // 누른 뒤 버튼에 초점이 남으면 다음 Tab 이 엉뚱한 데서 시작한다
    node.blur();
  });

  /**
   * 스크롤은 아주 잦게 일어난다. 그래도 프레임에 미루지 않는다.
   *
   * requestAnimationFrame 은 화면이 그려지지 않는 자리(배경 탭, 내장 뷰)에서 아예 안 돈다.
   * 거기에 "이미 예약했다" 표시를 걸어 두면 그 표시가 영영 안 풀려 버튼이 다시는 안 뜬다.
   * 하는 일이 값 하나 읽고 하나 쓰는 것뿐이라, 그냥 그 자리에서 한다.
   * 대신 상태가 바뀔 때만 손대 쓸데없이 다시 그리지 않게 한다.
   */
  let visible = false;
  scroller.addEventListener("scroll", () => {
    const should = scroller.scrollTop >= TO_TOP_AFTER;
    if (should === visible) return;
    visible = should;
    node.hidden = !should;
  }, { passive: true });

  document.body.append(node);
}

/* ---------- 사진 입력 ---------- */

/**
 * 사진을 올리는 모든 자리에 같은 말로 붙는다.
 *
 * 사진은 가명화할 수 없다. 글은 이름을 코드로 바꿔 보낼 수 있지만(lib/anonymize.ts)
 * 사진에 찍힌 얼굴과 이름표는 그대로 나간다. 그래서 막는 자리가 코드가 아니라 사람이고,
 * 사람이 누르기 전에 읽는 이 한 줄이 마지막 방어다. 자리마다 말이 다르면 힘이 빠진다.
 */
export const PHOTO_NOTICE = "아동의 얼굴·이름이 나오지 않게, 자료만 촬영해 주세요.";

const PHOTO_ACCEPT = "image/jpeg,image/png,image/webp";

/**
 * 사진 고르는 자리 — [📷 찍기] / [🖼 갤러리] 두 버튼. 자원 사진·책 표지가 함께 쓴다.
 *
 * 파일 칸 하나로는 폰이 "카메라냐 사진첩이냐" 를 한 번 더 묻거나(안드로이드),
 * 곧장 사진첩만 열어(일부 브라우저) 찍으러 간 사람이 헤맨다. 그래서 둘로 나눈다.
 *   찍기   capture="environment" — 폰에서 바로 뒤 카메라. PC 에서는 파일 고르기와 같다
 *   갤러리 capture 없음 — 사진첩·파일
 * 어느 쪽이든 고른 파일은 같은 onPick 으로 모인다(줄이기·크기 검사·인식은 그 뒤 한 길).
 *
 * @returns {{ reset(): void }}
 */
export function mountPhotoSource(box, onPick) {
  box.replaceChildren();
  box.classList.add("photo__source");

  const make = (label, capture) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = PHOTO_ACCEPT;
    if (capture) input.setAttribute("capture", "environment");
    input.className = "visually-hidden";
    input.tabIndex = -1;
    input.setAttribute("aria-hidden", "true");
    input.addEventListener("change", () => {
      const file = input.files?.[0] ?? null;
      // 같은 사진을 다시 골라도 change 가 오게 비운다(고른 파일은 이미 넘겼다)
      input.value = "";
      if (file) onPick(file);
    });

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn photo__btn";
    btn.textContent = label;
    btn.addEventListener("click", () => input.click());
    box.append(btn, input);
    return { input, btn };
  };

  const camera = make("📷 찍기", true);
  const gallery = make("🖼 갤러리", false);

  return {
    reset() {
      camera.input.value = "";
      gallery.input.value = "";
    },
  };
}

/** 사진을 줄일 때 긴 변의 상한. 글자를 읽는 데는 이만하면 넉넉하다. */
const PHOTO_MAX_EDGE = 1600;

/** 보낼 수 있는 크기. 서버(api/books.ts·api/resources.ts)의 상한과 같아야 한다. */
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024;

/** base64 글자 수로 원본 바이트를 어림한다. 서버도 같은 식으로 센다. */
export function base64Bytes(base64) {
  return Math.floor(base64.length * 3 / 4);
}

/**
 * 파일을 그림으로 푼다.
 *
 * createImageBitmap 을 먼저 쓴다. 아이폰 사진은 12메가픽셀(4032×3024)이라
 * <img> 로 풀어 캔버스에 그리면 iOS 사파리가 조용히 빈 그림을 내놓는 일이 있다.
 * 그러면 흰 종이가 AI 로 가고 "표지를 읽지 못했어요" 가 돌아온다 —
 * 사람 눈에는 사진을 제대로 찍었는데 아무 일도 안 일어난 것처럼 보인다.
 * createImageBitmap 은 디코드를 브라우저가 알아서 하므로 큰 사진에 더 안전하다.
 */
async function decodeImage(file) {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        release: () => bitmap.close?.(),
      };
    } catch (error) {
      // HEIC 를 못 푸는 브라우저가 여기로 온다. <img> 가 풀 수도 있으니 한 번 더 해 본다.
      console.warn("[prepareImage] createImageBitmap 실패, <img> 로 다시:", error);
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const node = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("사진을 열지 못했습니다."));
      image.src = url;
    });
    return {
      source: node,
      width: node.naturalWidth,
      height: node.naturalHeight,
      release: () => URL.revokeObjectURL(url),
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

/**
 * 그려 놓은 캔버스가 사실상 빈 그림인지 본다.
 *
 * 디코드는 성공했는데 그리기가 실패하면 투명하거나 한 가지 색인 캔버스가 남는다.
 * 그대로 JPEG 로 만들면 흰 종이 한 장이 되고, 그걸 보낸 쪽은 "글자가 없다" 는 답을 받는다.
 * 고장인데 답처럼 보이는 것이라, 보내기 전에 여기서 잡는다.
 *
 * [점을 찍어 훑지 않고 통째로 줄여서 본다]
 * 큰 그림에서 점 몇 백 개만 뽑으면 글자를 통째로 비껴간다 —
 * 표지 대부분은 배경이고 글자는 한 줌이라, 뽑은 점이 전부 배경이면
 * 멀쩡한 표지가 "빈 그림" 이 된다(실제로 그렇게 잘못 잡았다).
 * 32×32 로 줄여 그리면 글자가 있는 칸은 평균이 어두워져 반드시 차이가 남는다.
 */
function looksBlank(canvas) {
  const size = 32;
  const small = document.createElement("canvas");
  small.width = size;
  small.height = size;

  let data;
  try {
    const ctx = small.getContext("2d");
    ctx.drawImage(canvas, 0, 0, size, size);
    data = ctx.getImageData(0, 0, size, size).data;
  } catch (error) {
    // 못 읽으면 검사를 건너뛴다 — 막을 이유는 아니다.
    console.warn("[prepareImage] 빈 그림 검사 건너뜀:", error);
    return false;
  }

  let min = 255;
  let max = 0;
  let opaque = false;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] !== 0) opaque = true;
    const value = (data[i] + data[i + 1] + data[i + 2]) / 3;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  // 전부 투명하거나, 줄여 놓고도 밝기가 한 가지면 빈 그림이다.
  return !opaque || max - min < 6;
}

/**
 * 고른 사진을 줄여서 base64 로 만든다.
 *
 * 휴대폰 사진은 원본이 5~10MB 라 그대로 올리면 서버가 막는다.
 * 긴 변 1600px 의 JPEG 로 줄이면 몇백 KB 가 되고, 글자를 읽는 데는 충분하다.
 *
 * [실패하면 원본을 보내지 않는다]
 * 예전에는 줄이기에 실패하면 원본을 그대로 올렸다. 그러면 폰에서 HEIC 가 그대로 가서
 * 서버가 형식을 거절하거나, 5MB 를 넘어 막히거나, 더 나쁘게는 빈 그림이 올라가
 * "표지를 읽지 못했어요" 로 끝났다. 무엇이 잘못됐는지 아무도 알 수 없다.
 * 이제는 여기서 멈추고 무엇이 문제인지 말한다.
 *
 * 자원 사진과 책 표지가 같은 함수를 쓴다 — 한쪽만 고쳐 크기가 갈리는 일이 없게.
 */
/**
 * 서가 사진 나누기 — 책이 많은 사진은 둘로 잘라 따로 읽으면 한 권 한 권이 더 크게 보인다.
 *
 * 자동으로 나누는 것은 **가로로 긴 큰 사진**만이다(책등이 옆으로 늘어선 서가 한 칸을 찍은 모양).
 * 좌/우로 자르면 세로로 선 책등 사이를 가르므로 한 권이 두 동강 날 일이 적고,
 * 가운데 12% 를 겹쳐 잘린 책도 어느 한쪽에는 온전히 담긴다(겹쳐 두 번 읽힌 책은 서버가 합친다).
 * 세로 사진은 나누지 않는다 — 표지 한 권을 가까이 찍은 사진이 대개 세로라, 나누면 한 권이 갈린다.
 * 사람이 반쪽씩 나눠 찍는 것이 여전히 가장 정확하다(촬영 안내).
 */
const SPLIT_MIN_EDGE = 1200; // 이보다 작은 사진은 나눠도 글자가 커지지 않는다(나누면 한 번에 볼 책 수가 줄어 더 잘 읽는다 — 1269px 서가 사진 실측)
const SPLIT_MIN_RATIO = 1.2; // 가로 ÷ 세로
const SPLIT_OVERLAP = 0.12; // 가운데 겹침(전체 폭 대비)

export function splitPlan(width, height) {
  if (Math.max(width, height) < SPLIT_MIN_EDGE || width < height * SPLIT_MIN_RATIO) return null;
  const partWidth = Math.round(width * (0.5 + SPLIT_OVERLAP / 2));
  return [
    { sx: 0, sy: 0, sw: partWidth, sh: height },
    { sx: width - partWidth, sy: 0, sw: partWidth, sh: height },
  ];
}

/** 원본의 한 영역을 긴 변 1600 이하로 그려 JPEG base64 로(5MB 넘으면 품질을 낮춰 다시) */
function encodeRegion(source, { sx, sy, sw, sh }) {
  const scale = Math.min(1, PHOTO_MAX_EDGE / Math.max(sw, sh));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sw * scale));
  canvas.height = Math.max(1, Math.round(sh * scale));
  canvas.getContext("2d").drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);

  if (looksBlank(canvas)) {
    throw new Error(
      "사진을 변환하지 못했어요. 사진이 너무 크면 이런 일이 생깁니다 — 다시 찍어 주세요.",
    );
  }

  // 한 번 줄여도 상한을 넘을 수 있다. 품질을 낮춰 몇 번 더 해 본다.
  for (const quality of [0.85, 0.7, 0.55]) {
    const dataUrl = canvas.toDataURL("image/jpeg", quality);
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    if (base64Bytes(base64) <= PHOTO_MAX_BYTES) {
      return { base64, mimeType: "image/jpeg", previewUrl: dataUrl };
    }
  }
  throw new Error("사진이 너무 큽니다. 조금 멀리서 다시 찍어 주세요.");
}

/**
 * @param {File} file
 * @param {{ split?: boolean }} [options] split — 책 사진: 서가처럼 가로로 긴 큰 사진이면 조각(parts)도 만든다
 * @returns {Promise<{ base64, mimeType, previewUrl, parts?: { base64, mimeType }[] }>}
 */
export async function prepareImage(file, { split = false } = {}) {
  let decoded;
  try {
    decoded = await decodeImage(file);
  } catch (error) {
    console.warn("[prepareImage] 사진을 풀지 못했습니다:", error);
    throw new Error(
      `사진 형식을 처리하지 못했어요 (${file.type || "형식 모름"}). ` +
        "카메라 설정을 '높은 호환성(JPEG)' 으로 바꾸거나, 다른 사진으로 해 주세요.",
    );
  }

  try {
    const { source, width, height } = decoded;
    if (!width || !height) {
      throw new Error("사진 크기를 알 수 없어요. 다른 사진으로 해 주세요.");
    }

    const whole = encodeRegion(source, { sx: 0, sy: 0, sw: width, sh: height });
    const plan = split ? splitPlan(width, height) : null;
    if (!plan) return whole;
    const parts = plan.map((region) => {
      const { base64, mimeType } = encodeRegion(source, region);
      return { base64, mimeType };
    });
    return { ...whole, parts };
  } finally {
    decoded.release();
  }
}
