/**
 * 계정 관리 — 누가 들어올 수 있고, 무엇을 할 수 있는가
 *
 * 명단 화면(staff.js)과 나눠 둔 이유: 명단은 종사자도 보는 화면이고,
 * 계정 상태·마지막 로그인·관리자 깃발은 볼 사람만 봐야 한다.
 * ★ 5단계에서 이 화면과 그 API 는 관리자·센터장 전용으로 잠긴다.
 *
 * [두 묶음으로 나눈다]
 * 종사자와 멘토·봉사자는 다루는 일이 다르다. 종사자는 계정을 반드시 열어야 하고,
 * 봉사자는 모바일 단계까지 안 열어도 된다. 한 목록에 섞어 두면 그 차이가 안 보인다.
 * 묶음 안에서는 대기가 먼저다 — "지금 손봐야 할 사람" 이 위에 있어야 한다.
 *
 * [줄마다 버튼 하나]
 * 할 수 있는 일이 일곱 가지인데 다 늘어놓으면 정작 눌러야 할 것이 안 보인다.
 * 상태에 따라 지금 해야 할 일 하나만 버튼으로 내고 나머지는 [⋯] 안에 접는다.
 *
 * [초대코드는 한 번만 보인다]
 * 저장하는 것은 해시라 서버도 다시 알려 줄 수 없다. 발급 창을 닫으면 끝이고,
 * 그때는 재발급밖에 없다. 그 사실을 창에 적어 둔다 — 모르고 닫으면 사람이 당황한다.
 *
 * 브라우저는 Supabase에 직접 접근하지 않는다. 항상 /api/... 를 거친다.
 */
import {
  button,
  closeMenu,
  confirmDialog,
  copyText,
  get,
  hideState,
  openMenu,
  remove,
  send,
  showState,
  toast,
} from "./ui.js";
import { viewerIsAdmin } from "./me.js";

/** 서버(lib/permission.ts)의 목록과 같아야 한다. */
const ACCESS_KINDS = ["PC", "모바일"];

/** 초대코드 표기 — 발급 창·목록·복사 글·로그인 칸이 같은 모양(123-456). 로그인은 숫자만 읽는다. */
function formatCode(code) {
  const digits = String(code ?? "").replace(/\D/g, "");
  return digits.length === 6 ? `${digits.slice(0, 3)}-${digits.slice(3)}` : digits;
}

/**
 * 이 창에서 방금 발급한 코드 — 목록의 [복사] 가 쓴다. 서버는 해시만 두므로 다시 받을 수 없다.
 * 화면 메모리에만 둔다(새로 고치면 사라진다 — 저장하지 않는다).
 */
const issued = new Map();

/** 받는 사람에게 보낼 안내 글 */
function inviteText({ login_name, code }) {
  return [
    "OK 시스템 로그인 초대코드입니다.",
    `이름(아이디): ${login_name} / 초대코드: ${formatCode(code)}`,
    `접속 주소: ${location.origin}/login 에서 초대코드로 첫 비밀번호를 설정해 주세요.`,
  ].join("\n");
}

async function copyInvite(entry) {
  const done = await copyText(inviteText(entry));
  toast(
    done
      ? "안내 글을 복사했습니다 — 문자·메신저에 붙여 넣어 보내 주세요"
      : "복사하지 못했습니다. 코드를 받아 적어 주세요.",
    !done,
  );
}

/**
 * 화면의 두 묶음. 명단 화면이 roles 로 나누는 것과 같은 기준이다.
 * 직급이 비어 있는 사람은 어느 묶음에도 안 들어가므로 맨 아래 따로 모은다.
 */
const GROUPS = [
  { title: "종사자", roles: ["센터장", "생활복지사"] },
  { title: "멘토·봉사자", roles: ["멘토", "봉사자"] },
];

/** 묶음 안 정렬. 손봐야 할 것이 위로 온다. */
const STATE_ORDER = ["대기", "미발급", "정지", "활성"];

const state = {
  accounts: [],
  /**
   * 지금 실제로 들어올 수 있는 관리자 수. 서버가 세어 준다.
   * 화면이 직접 세면 서버와 기준이 갈릴 수 있다 — 비번을 안 정한 관리자를
   * 화면은 세고 서버는 안 세면, 눌리는데 거절당하는 버튼이 생긴다.
   */
  usableAdmins: 0,
  /**
   * 보는 사람이 관리자인가. 아니면 관리자 계정의 버튼과 깃발 메뉴를 숨긴다.
   * 숨김은 친절이다 — 서버가 403 으로 다시 막는다.
   */
  viewerAdmin: false,
  loading: false,
  error: null,
  pending: false,
};

const el = {
  view: document.getElementById("view-accounts"),
  count: document.getElementById("acct-count"),
  list: document.getElementById("acct-list"),
  state: document.getElementById("acct-state"),
};

/* ---------- 화면 전환 (app.js가 부른다) ---------- */

export function showAccounts() {
  el.view.hidden = false;
  load();
}

export function hideAccounts() {
  el.view.hidden = true;
  closeMenu();
}

/* ---------- 데이터 ---------- */

async function load() {
  state.loading = true;
  state.error = null;
  closeMenu();
  render();

  try {
    const [payload, admin] = await Promise.all([get("/api/accounts"), viewerIsAdmin()]);
    state.viewerAdmin = admin;
    state.accounts = payload.accounts ?? [];
    state.usableAdmins = payload.usable_admins ?? 0;
  } catch (error) {
    state.error = error.message;
    state.accounts = [];
  } finally {
    state.loading = false;
    render();
  }
}

/* ---------- 그리기 ---------- */

function render() {
  // 다시 그리면 [⋯] 버튼이 새것으로 바뀐다. 열려 있던 메뉴는 옛 버튼을 가리키므로 닫는다.
  closeMenu();
  el.list.replaceChildren();
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
  if (state.accounts.length === 0) {
    el.count.textContent = "";
    showState(el.state, "명단에 사람이 없습니다.", "먼저 명단에 등록해 주세요.");
    return;
  }

  // "아직 못 들어오는 사람이 몇 명인가" 가 이 화면의 핵심 숫자다.
  // 관문을 켜기 전에 대기·미발급이 0이 되어야 한다(5단계).
  const count = (value) => state.accounts.filter((one) => one.state === value).length;
  el.count.textContent = `활성 ${count("활성")} · 대기 ${count("대기")} · 미발급 ${
    count("미발급")
  }`;

  const used = new Set();
  for (const group of GROUPS) {
    const rows = sortGroup(state.accounts.filter((one) => group.roles.includes(one.role)));
    for (const one of rows) used.add(one.id);
    if (rows.length > 0) el.list.append(renderGroup(group.title, rows));
  }

  // 직급이 비어 있는 사람. 드물지만 조용히 사라지면 안 된다.
  const rest = sortGroup(state.accounts.filter((one) => !used.has(one.id)));
  if (rest.length > 0) el.list.append(renderGroup("직급 없음", rest));
}

/** 대기가 먼저, 같은 상태면 이름순. */
function sortGroup(rows) {
  return [...rows].sort((a, b) => {
    const order = STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state);
    return order !== 0 ? order : String(a.name).localeCompare(String(b.name), "ko");
  });
}

function renderGroup(title, rows) {
  const section = document.createElement("section");
  section.className = "acctgroup";

  const head = document.createElement("h3");
  head.className = "acctgroup__title";
  head.textContent = `${title} ${rows.length}명`;

  const list = document.createElement("ul");
  list.className = "acct__list";
  for (const one of rows) list.append(renderAccount(one));

  section.append(head, list);
  return section;
}

function tag(text, className = "tag") {
  const node = document.createElement("span");
  node.className = className;
  node.textContent = text;
  return node;
}

function renderAccount(account) {
  const li = document.createElement("li");
  li.className = "acct";

  const who = document.createElement("div");
  who.className = "acct__who";
  // 이름은 사용자 입력이므로 textContent 로만 넣는다
  who.textContent = account.name;
  // 로그인 이름이 화면 이름과 다르면 그 사실이 보여야 한다 — 동명이인을 푼 흔적이다.
  if (account.login_name && account.login_name !== account.name) {
    const login = document.createElement("span");
    login.className = "acct__login";
    login.textContent = `로그인: ${account.login_name}`;
    who.append(login);
  }

  const tags = document.createElement("div");
  tags.className = "acct__tags";
  // 명단 종료자는 "명단 종료" 하나만. 정지 태그는 실제로 정지한 계정에만 붙인다.
  const ended = account.status === "종료";
  if (!ended) tags.append(tag(account.state, stateClass(account.state)));
  else if (account.account_status === "정지") tags.append(tag("정지", stateClass("정지")));
  // 접속·겸직·관리자 태그와 아래 한 줄(최근·열린 창)은 넓은 화면에서만 — 좁은 화면은 이름 · 상태 · 버튼 한 줄(style.css)
  tags.append(tag(account.access_kind, "tag acct__extra"));
  // 겸직 — 대표 역할의 묶음에 한 번만 나온다. 나머지 역할은 태그로 보인다.
  if ((account.roles?.length ?? 0) > 1) {
    tags.append(tag(`겸직 ${account.roles.join("·")}`, "tag acct__extra"));
  }
  if (account.is_admin) tags.append(tag("관리자", "tag tag--area acct__extra"));
  if (account.status === "종료") tags.append(tag("명단 종료", "tag tag--gone"));

  const meta = document.createElement("div");
  meta.className = "acct__meta";
  meta.textContent = metaLine(account);

  li.append(who, tags, meta);
  // 봉사 등급인데 PC 접속이면 PC 화면이 거의 다 막힌다(서버가 등급으로 거절). 바꾸지는 않고 알리기만.
  if (account.level === "봉사" && account.access_kind === "PC" && !ended) {
    const warn = document.createElement("div");
    warn.className = "acct__warn";
    warn.textContent = "봉사 등급인데 PC 접속이에요 — PC 화면은 대부분 쓸 수 없어요. 보통은 모바일 접속입니다.";
    li.append(warn);
  }
  li.append(renderActions(account));
  return li;
}

function stateClass(value) {
  if (value === "활성") return "tag tag--area";
  if (value === "대기") return "tag tag--unset";
  if (value === "정지") return "tag tag--gone";
  return "tag";
}

function metaLine(account) {
  const parts = [];
  if (account.state === "대기" && account.invite_code_expires_at) {
    const mine = issued.get(account.id);
    parts.push(
      mine
        ? `코드 ${formatCode(mine.code)} · ${shortDate(account.invite_code_expires_at)} 만료`
        : `코드 만료 ${shortDate(account.invite_code_expires_at)}`,
    );
  }
  if (account.last_login_at) parts.push(`최근 ${shortDate(account.last_login_at)}`);
  if (account.sessions > 0) parts.push(`열린 창 ${account.sessions}`);
  if (account.locked_until && new Date(account.locked_until) > new Date()) {
    parts.push("잠김");
  }
  return parts.join(" · ");
}

function shortDate(value) {
  const date = new Date(value);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

/* ---------- 줄 오른쪽: 주 동작 하나 + [⋯] ---------- */

/** 지금 이 사람에게 해야 할 일 하나. 상태가 정한다. */
function mainAction(account) {
  if (account.state === "정지") {
    return { label: "정지 해제", run: () => patch(account, { account_status: "활성" }) };
  }
  if (account.state === "대기") return { label: "코드 재발급", run: () => askIssue(account) };
  if (account.state === "활성") return { label: "비번 재설정", run: () => askIssue(account) };
  return { label: "코드 발급", run: () => askIssue(account) };
}

function renderActions(account) {
  const box = document.createElement("div");
  box.className = "acct__actions";

  // 관리자 계정은 관리자만 바꾼다. 누르면 거절당할 버튼은 처음부터 안 보인다.
  if (account.is_admin && !state.viewerAdmin) {
    const note = document.createElement("span");
    note.className = "acct__note";
    note.textContent = "관리자만 변경";
    box.append(note);
    return box;
  }

  // 명단에서 종료된 사람 — 계정으로 할 일이 없다. 복귀는 명단 화면에서(되돌리면 옛 비밀번호도 비워진다).
  // 예전에는 [정지 해제] 가 켜져 있었지만 눌러도 종료 상태라 아무것도 바뀌지 않았다.
  if (account.status === "종료") {
    const note = document.createElement("span");
    note.className = "acct__note";
    note.textContent = "명단에서 종료됨 — 복귀는 명단 화면에서";
    box.append(note);
  } else {
    // 이 창에서 방금 발급한 대기 계정 — 안내 글 복사
    const mine = account.state === "대기" ? issued.get(account.id) : null;
    if (mine) box.append(button("복사", "btn btn--small", () => copyInvite(mine)));
    const main = mainAction(account);
    box.append(button(main.label, "btn btn--small", main.run));
  }

  const more = document.createElement("button");
  more.type = "button";
  more.className = "acct__more";
  more.textContent = "⋯";
  more.setAttribute("aria-label", `${account.name} 계정 더보기`);
  more.setAttribute("aria-expanded", "false");
  more.addEventListener("click", (event) => {
    event.stopPropagation();
    if (more.getAttribute("aria-expanded") === "true") {
      closeMenu();
      return;
    }
    more.setAttribute("aria-expanded", "true");
    openMenu(more, menuItems(account), {
      onClose: () => more.setAttribute("aria-expanded", "false"),
    });
  });
  box.append(more);

  return box;
}

/**
 * 이 사람이 지금 유일한 관리자인가.
 *
 * 유일하면 관리자 해제도 정지도 막는다 — 풀어 주면 아무도 계정을 발급할 수
 * 없게 되고, 그때는 SQL 비상 절차뿐이다.
 * 여기서 막는 것은 헛걸음을 줄이는 편의고, 실제로 막는 것은 서버다.
 */
function isLastAdmin(account) {
  return account.is_admin && account.state === "활성" && state.usableAdmins <= 1;
}

const LAST_ADMIN_WHY = "마지막 관리자는 해제/정지할 수 없습니다. " +
  "다른 계정에 먼저 관리자를 지정하세요.";

/**
 * 접어 둔 나머지 동작. 그리는 일은 공통 드롭다운(ui.js)이 한다.
 *
 * 위험한 것(정지·관리자 해제)은 색으로 갈라 두고, 누르면 확인창이 뜬다.
 * 색만으로 막지 않는다 — 색은 알아보게 할 뿐이고 막는 것은 확인창이다.
 */
function menuItems(account) {
  const items = [];
  const last = isLastAdmin(account);

  if (account.state === "대기") {
    items.push({ label: "발급한 코드 회수", run: () => revoke(account) });
  }

  items.push({ label: "로그인 이름 고치기", run: () => askLoginName(account) });

  const other = account.access_kind === "PC" ? ACCESS_KINDS[1] : ACCESS_KINDS[0];
  items.push({
    label: `접속 권한을 ${other}로`,
    run: () => patch(account, { access_kind: other }),
  });

  // 깃발 지정·해제는 관리자만. 관리자가 아니면 메뉴에서 뺀다.
  if (state.viewerAdmin && account.is_admin) {
    items.push({
      label: "관리자에서 빼기",
      run: () => askAdmin(account),
      danger: true,
      disabled: last,
      title: last ? LAST_ADMIN_WHY : "",
    });
  } else if (state.viewerAdmin) {
    items.push({ label: "관리자로 지정", run: () => askAdmin(account) });
  }

  if (account.account_status === "정지") {
    items.push({ label: "정지 해제", run: () => patch(account, { account_status: "활성" }) });
  } else {
    items.push({
      label: "계정 정지",
      run: () => askSuspend(account),
      danger: true,
      disabled: last,
      title: last ? LAST_ADMIN_WHY : "",
    });
  }

  return items;
}

/* ---------- 초대코드 ---------- */

async function askIssue(account) {
  if (state.pending) return;

  const again = account.state === "활성";
  const yes = await confirmDialog({
    title: again ? "비밀번호를 다시 정하게 할까요?" : "초대코드를 발급할까요?",
    message: `${account.name}\n` +
      (again
        ? "지금 비밀번호는 새 코드로 다시 정할 때까지 그대로 쓸 수 있지만, " +
          "열려 있는 창은 모두 끊깁니다.\n"
        : account.state === "대기"
        ? "전에 준 코드는 그 자리에서 무효가 됩니다.\n"
        : "") +
      "코드는 발급 직후 한 번만 보입니다. 다시 볼 수 없으니 받아 적어 주세요.",
    confirmText: again ? "재설정" : "발급",
    danger: again,
  });
  if (!yes) return;

  state.pending = true;
  try {
    const payload = await send(`/api/accounts/${account.id}/code`, "POST", {});
    await showCode({ ...payload, id: account.id });
    await load();
  } catch (error) {
    toast(error.message, true);
  } finally {
    state.pending = false;
  }
}

/**
 * 발급된 코드를 크게 보여 준다.
 *
 * 확인창을 다시 쓴다 — 새 컴포넌트를 만들 만큼 다른 일이 아니다.
 * preview 자리에 코드를 넣고 큰 글씨 모양만 따로 준다.
 */
async function showCode(payload) {
  issued.set(payload.id, payload);
  await confirmDialog({
    title: `${payload.name} 님의 초대코드`,
    preview: formatCode(payload.code),
    extra: { text: "📋 안내 글 복사", run: () => copyInvite(payload) },
    hideCancel: true,
    previewClass: "confirm__preview--code",
    danger: false,
    message: "지금 받아 적거나 [안내 글 복사] 로 보내 주세요. 이 화면을 새로 고치면 다시 볼 수 없습니다.\n" +
      `로그인 이름은 "${payload.login_name}" 입니다. 코드는 ${
        shortDate(payload.expires_at)
      } 까지 쓸 수 있습니다.` +
      (payload.closed_sessions > 0
        ? `\n열려 있던 창 ${payload.closed_sessions}개를 끊었습니다.`
        : ""),
    confirmText: "받아 적었습니다",
  });
}

async function revoke(account) {
  if (state.pending) return;

  const yes = await confirmDialog({
    title: "발급한 코드를 무를까요?",
    message: `${account.name}\n그 코드로는 더 이상 들어올 수 없게 됩니다.`,
    confirmText: "회수",
  });
  if (!yes) return;

  state.pending = true;
  try {
    await remove(`/api/accounts/${account.id}/code`);
    issued.delete(account.id);
    toast("코드를 회수했습니다");
    await load();
  } catch (error) {
    toast(error.message, true);
  } finally {
    state.pending = false;
  }
}

/* ---------- 계정 설정 ---------- */

/**
 * 로그인 이름 고치기. 동명이인을 푸는 자리다.
 *
 * prompt 를 쓴다. 값 하나를 받는 일에 모달을 새로 만들 이유가 없고,
 * 이 화면은 관리자가 가끔 여는 자리라 손에 붙는 모양보다 단순한 편이 낫다.
 */
async function askLoginName(account) {
  if (state.pending) return;

  const next = globalThis.prompt(
    `${account.name} 님이 로그인할 때 쓸 이름입니다.\n` +
      "같은 이름이 둘 있으면 여기를 서로 다르게 해 주세요. (예: 김지현(멘토))",
    account.login_name ?? account.name,
  );
  if (next === null) return;

  const value = next.trim();
  if (!value) {
    toast("로그인 이름은 비워 둘 수 없습니다.", true);
    return;
  }
  if (value === account.login_name) return;

  await patch(account, { login_name: value });
}

async function askAdmin(account) {
  if (state.pending) return;

  const on = !account.is_admin;
  const yes = await confirmDialog({
    title: on ? "관리자로 지정할까요?" : "관리자에서 뺄까요?",
    message: `${account.name}\n` +
      (on
        ? "설정과 계정 발급을 만질 수 있게 됩니다. 직급과는 무관합니다."
        : "설정과 계정 발급을 만질 수 없게 됩니다.\n" +
          "관리자가 한 명도 남지 않으면 아무도 계정을 만들 수 없습니다."),
    confirmText: on ? "관리자로" : "해제",
    danger: !on,
  });
  if (!yes) return;

  await patch(account, { is_admin: on });
}

async function askSuspend(account) {
  if (state.pending) return;

  const yes = await confirmDialog({
    title: "계정을 정지할까요?",
    message: `${account.name}\n` +
      "곧바로 못 들어옵니다. 열려 있는 창도 그 자리에서 끊깁니다.\n" +
      "명단에서 지우는 것이 아니라 문만 잠그는 것입니다. 언제든 풀 수 있습니다.",
    confirmText: "정지",
  });
  if (!yes) return;

  await patch(account, { account_status: "정지" });
}

/** 계정 설정을 고친다. 낙관적 갱신은 하지 않는다 — 권한이 바뀌는 자리라 서버 답을 기다린다. */
async function patch(account, body) {
  if (state.pending) return;

  state.pending = true;
  try {
    const payload = await send(`/api/accounts/${account.id}`, "PATCH", body);
    const index = state.accounts.findIndex((one) => one.id === account.id);
    if (index >= 0 && payload.account) state.accounts[index] = payload.account;
    render();

    toast(
      payload.closed_sessions > 0
        ? `저장했습니다 · 열린 창 ${payload.closed_sessions}개를 끊었습니다`
        : "저장했습니다",
    );
  } catch (error) {
    toast(error.message, true);
  } finally {
    state.pending = false;
  }
}
