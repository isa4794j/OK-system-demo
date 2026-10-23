/**
 * 직원 명단 — 역할만 바꿔 어느 명단에나 쓴다.
 *
 * 멘토+봉사자 명단과 종사자 명단은 보여줄 역할만 다르고 구조가 같다.
 * 화면을 두 벌 만들지 않고 roles 를 인자로 받는다.
 *
 *   showStaff({ title: "봉사자 명단", roles: ["멘토", "봉사자"], closedLabel: "종료" })
 *   showStaff({ title: "종사자 명단", roles: ["센터장", "생활복지사"], closedLabel: "퇴사" })
 *
 * 등록·수정은 모달이다. 목록 위에 폼이 끼어 목록이 밀리지 않게.
 *
 * 브라우저는 Supabase에 직접 접근하지 않는다. 항상 /api/... 를 거친다.
 */
import { chooseDialog, typeToConfirm } from "./danger_dialog.js";
import {
  confirmDialog,
  fillOptions,
  get,
  hideState,
  remove,
  send,
  showState,
  toast,
  toOption,
} from "./ui.js";
import { loadMe, viewerAtLeast, viewerIsAdmin } from "./me.js";
import { rosterNumber, rosterPager } from "./roster_more.js";

/** 서버(/db/staff.ts)의 목록과 같아야 한다. */
const STATUSES = ["활동중", "종료"];

/** 역할 네 가지 — 등급이 높은 순(서버 lib/permission.ts ROLE_ORDER 와 같다) */
const ALL_ROLES = ["센터장", "생활복지사", "멘토", "봉사자"];

/**
 * 역할마다 어느 명단에서 고치나. 화면만 나눈다 — 서버는 어떤 조합이든 저장한다.
 * 한 명단의 등록·수정 창에는 그 명단의 역할만 체크박스로 나오고,
 * 다른 명단의 역할(겸직)은 잠긴 알약으로 보이기만 한다.
 */
const ROLE_LIST = {
  센터장: { name: "종사자 명단", label: "종사자" },
  생활복지사: { name: "종사자 명단", label: "종사자" },
  멘토: { name: "봉사자 명단", label: "멘토·봉사자" },
  봉사자: { name: "봉사자 명단", label: "멘토·봉사자" },
};

/** 이 사람의 역할 목록. 옛 응답(role 하나)도 받는다. */
function rolesOf(person) {
  if (Array.isArray(person?.roles) && person.roles.length) return person.roles;
  return person?.role ? [person.role] : [];
}

const state = {
  title: "",
  roles: [],
  people: [],
  /** 전체(= 지금 활동중) | 종료. 그만둔 사람을 부르는 말은 명단마다 다르다(퇴사/종료). */
  status: "전체",
  /** 폼을 열 때의 값. 닫을 때 바뀌었는지 보는 데 쓴다. */
  initial: "",
  query: "",
  loading: false,
  error: null,

  formMode: null, // null | "create" | "edit"
  /** 이름 충돌 창에서 풀기로 고른 명단 종료자 id. 다음 등록 한 번에만 실린다 */
  releaseLoginOf: null,
  editing: null,
  pending: false,
  /** 보는 사람이 관리자인가. 아니면 관리자인 사람의 수정·삭제 버튼을 숨긴다(막는 것은 서버). */
  viewerAdmin: false,
  /** 명단 등록·수정·종료·삭제는 센터장 이상(서버 정책표). 종사자에게는 버튼을 안 보인다 */
  canManage: true,
};

const el = {
  view: document.getElementById("view-staff"),
  title: document.getElementById("staff-title"),
  count: document.getElementById("staff-count"),
  statusChips: document.querySelectorAll(".chip[data-sstatus]"),
  search: document.getElementById("staff-search"),
  addOpen: document.getElementById("staff-add-open"),
  closedChip: document.getElementById("staff-closed-chip"),

  modal: document.getElementById("staff-modal"),
  backdrop: document.getElementById("staff-backdrop"),
  form: document.getElementById("staff-form"),
  formTitle: document.getElementById("staff-form-title"),
  name: document.getElementById("staff-name"),
  role: document.getElementById("staff-role"),
  phone: document.getElementById("staff-phone"),
  statusField: document.getElementById("staff-status-field"),
  statusSelect: document.getElementById("staff-status"),
  submit: document.getElementById("staff-submit"),
  cancel: document.getElementById("staff-cancel"),

  tbody: document.getElementById("staff-tbody"),
  state: document.getElementById("staff-state"),
  askNote: document.getElementById("staff-ask-note"),
};

const pager = rosterPager(el.state, (people, start) => {
  el.tbody.append(...people.map((person, i) => renderRow(person, start + i + 1)));
  markWrappedPhones();
  return null;
});

/* ---------- 화면 전환 (app.js가 부른다) ---------- */

export function showStaff({ title, roles, closedLabel = "종료" }) {
  const changed = state.title !== title;
  state.title = title;
  state.roles = roles;
  el.closedChip.textContent = closedLabel;

  if (changed) {
    state.people = [];
    state.status = "전체";
    state.query = "";
    el.search.value = "";
    syncStatusChips();
  }

  el.title.textContent = title;
  el.view.hidden = false;
  pager.reset();
  closeForm();
  loadStaff();
}

export function hideStaff() {
  el.view.hidden = true;
}

/* ---------- 데이터 ---------- */

async function loadStaff() {
  state.loading = true;
  state.error = null;
  render();

  // 명단 화면은 그만둔 사람까지 보여야 한다. 거르는 일은 화면에서 한다.
  const params = new URLSearchParams();
  for (const role of state.roles) params.append("role", role);
  params.set("status", "전체");

  try {
    const [payload, admin, manage] = await Promise.all([
      get(`/api/staff?${params}`),
      viewerIsAdmin(),
      viewerAtLeast("센터장"),
    ]);
    state.viewerAdmin = admin;
    state.canManage = manage;
    el.addOpen.hidden = !manage;
    el.askNote.hidden = manage;
    state.people = payload.staff ?? [];
  } catch (error) {
    state.error = error.message;
    state.people = [];
  } finally {
    state.loading = false;
    render();
  }
}

/* ---------- 그리기 ---------- */

function visiblePeople() {
  const query = state.query.trim().toLowerCase();
  return state.people.filter((person) => {
    // "전체"는 지금 활동중인 사람이다. 그만둔 사람은 옆 칩에서만 본다.
    const wanted = state.status === "전체" ? "활동중" : "종료";
    if (person.status !== wanted) return false;
    if (query && !String(person.name ?? "").toLowerCase().includes(query)) return false;
    return true;
  });
}

function render() {
  const rows = visiblePeople();

  el.tbody.replaceChildren();
  hideState(el.state);
  pager.hide();

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

  el.count.textContent = state.people.length === 0 ? "" : `${rows.length}명`;

  if (state.people.length === 0) {
    showState(el.state, "아직 등록된 사람이 없습니다.", "[+ 등록] 으로 추가할 수 있습니다.");
    return;
  }
  if (rows.length === 0) {
    showState(el.state, "조건에 맞는 사람이 없습니다.", "필터를 바꾸거나 검색어를 지워 보세요.");
    return;
  }

  pager.take(rows).forEach((person, i) => el.tbody.append(renderRow(person, i + 1)));
  markWrappedPhones();
}

/**
 * 좁은 화면 줄 목록 — 한 줄에 안 들어가 전화번호가 둘째 줄로 내려간 줄에 표시를 단다.
 * 내려간 번호는 오른쪽에 붙인다(CSS). 줄바꿈 여부는 그려 본 뒤에야 알 수 있어 여기서 잰다.
 */
const NARROW = globalThis.matchMedia?.("(max-width: 720px)");

function markWrappedPhones() {
  for (const tr of el.tbody.querySelectorAll("tr")) tr.classList.remove("is-wrapped");
  if (!NARROW?.matches) return;
  for (const tr of el.tbody.querySelectorAll("tr")) {
    const status = tr.querySelector(".roster__status");
    const phone = tr.querySelector(".roster__phone");
    if (status && phone && phone.offsetTop > status.offsetTop + status.offsetHeight / 2) {
      tr.classList.add("is-wrapped");
    }
  }
}

globalThis.addEventListener?.("resize", () => {
  if (el.tbody.isConnected) markWrappedPhones();
});

function renderRow(person, no) {
  const tr = document.createElement("tr");

  const name = document.createElement("td");
  // 이름은 사용자가 입력한 값이므로 글자 노드로만 넣는다
  name.append(rosterNumber(no), document.createTextNode(person.name ?? "-"));
  name.className = "staff__name roster__name";

  const role = document.createElement("td");
  role.className = "roster__role";
  const roles = rolesOf(person);
  // 넓은 화면: "멘토·봉사자 [겸직]" 글자. 좁은 화면: 역할마다 알약 하나(겸직 태그 없이 한 줄)
  const wide = document.createElement("span");
  wide.className = "wide-only";
  wide.textContent = roles.join("·") || "-";
  // 겸직 — 해당하는 명단마다 나온다. 한 사람이라는 것을 태그로 알린다.
  if (roles.length > 1) {
    const tag = document.createElement("span");
    tag.className = "tag staff__multi";
    tag.textContent = "겸직";
    wide.append(" ", tag);
  }
  const pills = (roles.length ? roles : ["-"]).map((name) => {
    const pill = document.createElement("span");
    pill.className = "roster__pill narrow-only";
    pill.textContent = name;
    return pill;
  });
  role.append(wide, ...pills);

  const status = document.createElement("td");
  status.className = "roster__status";
  const badge = document.createElement("span");
  badge.className = person.status === "활동중" ? "badge badge--active" : "badge";
  badge.textContent = person.status ?? "-";
  status.append(badge);

  const phone = document.createElement("td");
  phone.className = "roster__phone";
  if (person.phone) {
    // 누르면 바로 전화. 넓은 화면에서도 글자 모양은 그대로(색·밑줄 없음 — CSS)
    const tel = document.createElement("a");
    tel.className = "roster__tel";
    tel.href = `tel:${person.phone.replace(/[^0-9+]/g, "")}`;
    tel.textContent = person.phone;
    phone.append(tel);
  } else {
    phone.textContent = "-";
  }

  const actions = document.createElement("td");
  actions.className = "book__actions roster__actions";

  // 종사자는 명단을 보기만 한다(등록·수정·종료·삭제는 센터장 이상)
  if (!state.canManage) {
    tr.append(name, role, status, phone, actions);
    return tr;
  }

  // 관리자인 사람의 수정·종료·삭제는 관리자만 한다. 거절당할 버튼은 안 보인다.
  if (person.is_admin && !state.viewerAdmin) {
    const note = document.createElement("span");
    note.className = "staff__note";
    note.textContent = "관리자만 변경";
    actions.append(note);
    tr.append(name, role, status, phone, actions);
    return tr;
  }

  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "linkbtn";
  edit.textContent = "수정";
  edit.addEventListener("click", () => openEdit(person));

  const del = document.createElement("button");
  del.type = "button";
  del.className = "linkbtn linkbtn--danger";
  del.textContent = "삭제";
  del.addEventListener("click", () => askDeleteStaff(person));
  actions.append(edit, del);

  tr.append(name, role, status, phone, actions);
  return tr;
}

function syncStatusChips() {
  for (const chip of el.statusChips) {
    chip.classList.toggle("is-selected", chip.dataset.sstatus === state.status);
  }
}

/* ---------- 등록 · 수정 폼 ---------- */

function openCreate() {
  state.formMode = "create";
  state.editing = null;

  el.formTitle.textContent = "새로 등록";
  el.name.value = "";
  el.phone.value = "";

  // 역할은 반드시 하나 이상 고르게 한다(저장할 때 확인).
  // 비워 두면 이 사람이 명단에도 스케줄에도 안 잡힌다.
  fillRoleChoices([]);

  // 등록은 늘 활동중으로 시작하므로 상태 칸을 보여주지 않는다
  el.statusField.hidden = true;

  openModal();
}

function openEdit(person) {
  state.formMode = "edit";
  state.editing = person;

  el.formTitle.textContent = `${person.name} 수정`;
  el.name.value = person.name ?? "";
  el.phone.value = person.phone ?? "";

  fillRoleChoices(rolesOf(person));

  fillOptions(el.statusSelect, STATUSES.map(toOption));
  el.statusSelect.value = person.status ?? "활동중";
  el.statusField.hidden = false;

  openModal();
}

/**
 * 역할 고르기 칸 — 이 명단의 역할만 체크박스.
 * 이미 가진 다른 명단의 역할(겸직)은 잠긴 알약 "멘토 — 봉사자 명단에서 관리" 로 보이고, 저장 때 그대로 실린다.
 */
function fillRoleChoices(selected) {
  el.role.replaceChildren();
  for (const role of state.roles) {
    const label = document.createElement("label");
    label.className = "rolepick__item";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.value = role;
    box.checked = selected.includes(role);
    label.append(box, ` ${role}`);
    el.role.append(label);
  }
  for (const role of selected.filter((one) => !state.roles.includes(one))) {
    const pill = document.createElement("span");
    pill.className = "rolepick__locked";
    pill.dataset.role = role;
    pill.textContent = `${role} — ${ROLE_LIST[role]?.name ?? "다른 명단"}에서 관리`;
    el.role.append(pill);
  }
}

/** 고른 역할(등급 순) — 이 명단의 체크 + 잠긴 겸직 역할 */
function readRoles() {
  const picked = [
    ...[...el.role.querySelectorAll("input:checked")].map((box) => box.value),
    ...[...el.role.querySelectorAll(".rolepick__locked")].map((pill) => pill.dataset.role),
  ];
  return ALL_ROLES.filter((role) => picked.includes(role));
}

/** 이 명단에서 고를 역할이 하나라도 체크됐나 — 겸직 알약만으로는 이 명단의 사람이 아니다 */
function hasListRole(roles) {
  return roles.some((role) => state.roles.includes(role));
}

/**
 * 등록 전에 — 같은 이름이 다른 명단에 활동중으로 있으면 "그분에게 역할을 더할까요?" 를 묻는다.
 *   "added"  기존 사람에게 역할을 더했다(등록은 하지 않는다)
 *   "new"    다른 사람이다 — 예전처럼 새로 등록(같은 이름 흐름은 서버·충돌 창이 맡는다)
 *   "cancel" 창을 닫았다
 */
async function offerRoleAdd(name, roles) {
  const others = ALL_ROLES.filter((role) => !state.roles.includes(role));
  let found = null;
  try {
    const params = new URLSearchParams();
    for (const role of others) params.append("role", role);
    params.set("status", "전체");
    const payload = await get(`/api/staff?${params}`);
    found = (payload.staff ?? []).find((one) => one.name === name && one.status === "활동중") ?? null;
  } catch (error) {
    // 못 찾으면 예전처럼 등록으로 간다 — 겹치면 서버가 알린다
    console.error("[offerRoleAdd]", error);
  }
  // 이미 이 명단에도 있는 사람이면 같은 명단 안의 같은 이름이다 — 예전 흐름(서버 안내)으로
  if (!found || hasListRole(rolesOf(found))) return "new";

  const theirs = rolesOf(found);
  const where = ROLE_LIST[theirs.find((role) => others.includes(role))]?.label ?? "다른 명단";
  const adding = roles.filter((role) => !theirs.includes(role));
  // 관리자 계정에 역할을 더하는 일은 관리자만 한다(서버가 거절한다) — 고르기 대신 안내만
  if (found.is_admin && !state.viewerAdmin) {
    const pick = await chooseDialog({
      title: "같은 이름이 있어요",
      message: `이미 ${where}로 있는 ${found.name} 님은 관리자 계정이라 역할 추가는 관리자만 할 수 있어요.\n` +
        "같은 사람이면 관리자에게 부탁해 주세요. 다른 사람이면 [다른 사람이에요].",
      choices: [{ label: "다른 사람이에요", value: "new" }],
    });
    return pick === "new" ? "new" : "cancel";
  }
  const pick = await chooseDialog({
    title: "같은 이름이 있어요",
    message: `이미 ${where}로 있는 ${found.name} 님에게 ${adding.join("·")} 역할을 더할까요?\n` +
      `같은 사람이면 [역할 추가] — 계정·기록이 한 사람으로 이어집니다. 다른 사람이면 [다른 사람이에요].`,
    choices: [
      { label: "역할 추가", value: "add", kind: "primary" },
      { label: "다른 사람이에요", value: "new" },
    ],
  });
  if (pick === "new") return "new";
  if (pick !== "add") return "cancel";

  const merged = ALL_ROLES.filter((role) => theirs.includes(role) || roles.includes(role));
  const payload = await send(`/api/staff/${found.id}`, "PATCH", { roles: merged });
  state.people.push(payload.staff);
  sortPeople();
  render();
  toast(`${found.name} 님에게 ${adding.join("·")} 역할을 더했습니다`);
  return "added";
}

/** 폼의 지금 값을 한 줄로. 열 때와 견줘 "입력 중"인지 본다. */
function formValues() {
  return [el.name.value, el.phone.value, readRoles().join(","), el.statusSelect.value].join(
    "\u0000",
  );
}

/**
 * 역할을 뺄 때 — 그 역할로 남긴 기록이 있으면 한 번 알린다. 기록은 지우지 않는다.
 * 계속하면 true.
 */
async function confirmRoleRemoval(person, nextRoles) {
  const removed = rolesOf(person).filter((role) => !nextRoles.includes(role));
  if (removed.length === 0) return true;

  let byRole = null;
  try {
    byRole = (await get(`/api/staff/${person.id}/records-count`)).by_role ?? {};
  } catch (error) {
    console.error("[confirmRoleRemoval]", error);
  }

  const lines = removed.map((role) => {
    if (!byRole) return `${role} 기록 수를 확인하지 못했습니다.`;
    const c = byRole[role];
    const total = c ? c.schedules + c.journals + c.inquiries : 0;
    return total > 0
      ? `${role} 기록 ${total}건이 있어요(일정 ${c.schedules} · 일지 ${c.journals} · 문의 ${c.inquiries}).`
      : "";
  }).filter(Boolean);
  if (lines.length === 0) return true;

  return await confirmDialog({
    title: "역할을 뺄까요?",
    message: `${person.name} · ${removed.join("·")} 빼기\n` + lines.join("\n") +
      "\n기록은 그대로 남고, 그 기록에는 쓸 때의 역할이 계속 표시됩니다.",
    confirmText: "역할 빼기",
    danger: false,
  });
}

function openModal() {
  el.modal.hidden = false;
  state.initial = formValues();
  el.name.focus();
}

function closeForm() {
  state.formMode = null;
  state.editing = null;
  el.modal.hidden = true;
}

/**
 * 취소·바깥 클릭·Esc. 입력 중이면 한 번 묻는다.
 * 저장 중에는 닫지 않는다 — 결과를 보고 닫아야 한다.
 */
async function askClose() {
  if (state.pending) return;
  if (formValues() !== state.initial) {
    const yes = await confirmDialog({
      title: "입력 중인 내용을 버릴까요?",
      message: "저장하지 않은 내용이 사라집니다.",
      confirmText: "버리기",
    });
    if (!yes) return;
  }
  closeForm();
}

/* ---------- 저장 (낙관적 갱신) ---------- */

function snapshot() {
  return state.people.map((person) => ({ ...person }));
}

function restore(saved) {
  state.people = saved;
  render();
}

/** 이름순. 서버가 이름순으로 주므로 화면에서도 같은 순서를 지킨다. */
function sortPeople() {
  state.people.sort((a, b) => String(a.name).localeCompare(String(b.name), "ko"));
}

async function submit(event) {
  event.preventDefault();
  if (state.pending) return;

  const name = el.name.value.trim();
  const roles = readRoles();
  const role = roles[0] ?? null;
  const phone = el.phone.value.trim();

  if (!name) {
    toast("이름을 입력해 주세요.", true);
    return;
  }
  if (!hasListRole(roles)) {
    // 등록은 이 명단의 역할이 하나는 있어야 한다
    if (state.formMode !== "edit" || roles.length === 0) {
      toast(`${state.roles.join("·")} 중 하나 이상 골라 주세요.`, true);
      return;
    }
    // 수정에서 이 명단의 역할을 다 빼면 — 다른 명단의 역할만 남는다. 한 번 묻는다.
    const yes = await confirmDialog({
      title: `${state.title}에서 빠질까요?`,
      message: `${name}\n이 명단의 역할을 모두 뺍니다. ${roles.join("·")} 역할만 남아 ` +
        `${ROLE_LIST[roles[0]]?.name ?? "다른 명단"}에만 보입니다.`,
      confirmText: "빼고 저장",
      danger: false,
    });
    if (!yes) return;
  }
  if (state.formMode === "edit" && !(await confirmRoleRemoval(state.editing, roles))) return;

  // 새로 등록할 때 — 다른 명단에 같은 이름이 활동중이면 그분에게 역할을 더할지 먼저 묻는다
  if (state.formMode !== "edit" && !state.releaseLoginOf) {
    let decided;
    try {
      state.pending = true;
      decided = await offerRoleAdd(name, roles);
    } catch (error) {
      toast(error.message, true);
      return;
    } finally {
      state.pending = false;
    }
    if (decided === "cancel") return;
    if (decided === "added") {
      closeForm();
      return;
    }
  }

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

      // 화면 먼저 바꾼다
      const row = state.people.find((person) => person.id === target.id);
      if (row) Object.assign(row, { name, role, roles, phone: phone || null, status });
      sortPeople();
      closeForm();
      render();

      const payload = await send(`/api/staff/${target.id}`, "PATCH", {
        name,
        roles,
        phone: phone || null,
        status,
      });
      const index = state.people.findIndex((person) => person.id === target.id);
      if (index >= 0) state.people[index] = payload.staff;
      // 이 명단의 역할을 다 뺐으면 이 명단에서 내린다(다른 명단에는 그대로 있다)
      if (!hasListRole(rolesOf(payload.staff))) {
        state.people = state.people.filter((person) => person.id !== target.id);
      }
      sortPeople();
      render();
      // 종료였던 사람이 돌아오면 옛 비밀번호는 비워진다(서버). 무엇을 해야 하는지 알린다.
      toast(
        payload.password_cleared
          ? "저장되었습니다 · 복귀한 사람은 [계정 관리]에서 초대코드를 새로 발급해 주세요"
          : "저장되었습니다",
      );
    } else {
      const tempId = `temp-${crypto.randomUUID()}`;
      state.people.push({
        id: tempId,
        name,
        role,
        roles,
        phone: phone || null,
        status: "활동중",
        color_index: null,
      });
      sortPeople();
      closeForm();
      render();

      // 이름 충돌 창에서 [종료자를 … 바꾸고 이 이름 쓰기] 를 골랐을 때만 실린다(한 번 쓰고 비운다)
      const release = state.releaseLoginOf;
      state.releaseLoginOf = null;
      const payload = await send("/api/staff", "POST", {
        name,
        roles,
        phone: phone || null,
        ...(release ? { release_login_of: release } : {}),
      });
      const index = state.people.findIndex((person) => person.id === tempId);
      if (index >= 0) state.people[index] = payload.staff;
      sortPeople();
      render();
      toast(await afterCreateHint(roles));
    }
  } catch (error) {
    // 목록은 되돌리되 모달은 다시 연다. 입력값이 남아 있어 다시 저장할 수 있다.
    restore(saved);
    state.formMode = formMode;
    state.editing = editing;
    el.modal.hidden = false;
    state.pending = false;
    el.submit.disabled = false;

    // 명단 종료자가 이 이름을 로그인 이름으로 쥐고 있다 — 사람이 고른다
    const conflict = error.payload?.conflict;
    if (formMode !== "edit" && conflict) {
      await resolveNameConflict(name, conflict);
      return;
    }
    toast(error.message, true);
  } finally {
    state.pending = false;
    el.submit.disabled = false;
  }
}

/**
 * 이름 충돌 — 그 이름을 쥔 사람이 명단 종료자일 때만 온다(활동중인 사람과 겹치면 안내만).
 *   [종료자를 ○○_001로 바꾸고 이 이름 쓰기]  종료자 로그인 이름을 빈 번호로 옮기고 등록을 다시 보낸다
 *                                            (서버가 옮기고 감사 로그에 남긴다)
 *   [다른 이름으로 등록하기]                  입력으로 돌아간다
 * 로그인 이름을 알아서 바꾸는 일은 없다 — 이 창에서 사람이 누를 때만.
 */
async function resolveNameConflict(name, conflict) {
  if (conflict.holder_is_admin && !state.viewerAdmin) {
    await confirmDialog({
      title: "같은 이름이 명단 종료자에게 있어요",
      message: `"${name}"\n` +
        `명단에서 종료된 ${conflict.holder_name} 님은 관리자 계정이라 로그인 이름은 관리자만 바꿀 수 있어요.\n` +
        "다른 이름으로 등록하거나 관리자에게 부탁해 주세요.",
      confirmText: "다른 이름으로 등록하기",
      cancelText: "닫기",
      danger: false,
    });
    el.name.focus();
    el.name.select();
    return;
  }
  const yes = await confirmDialog({
    title: "같은 이름이 명단 종료자에게 있어요",
    message: `"${name}"\n` +
      `명단에서 종료된 ${conflict.holder_name} 님이 이 이름을 로그인 이름으로 쓰고 있습니다.\n` +
      `그분의 로그인 이름을 "${conflict.suggested}" 로 바꾸면 이 이름으로 등록할 수 있습니다(기록에 남습니다).`,
    confirmText: `종료자를 ${conflict.suggested}로 바꾸고 이 이름 쓰기`,
    cancelText: "다른 이름으로 등록하기",
    danger: false,
  });
  if (!yes) {
    el.name.focus();
    el.name.select();
    return;
  }
  state.releaseLoginOf = conflict.holder_id;
  // 앞선 저장의 마무리(버튼 풀기)가 끝난 뒤에 다시 보낸다
  setTimeout(() => el.form.requestSubmit());
}

/* ---------- 삭제 (여러 겹) ---------- */

/**
 * 직원 삭제.
 *
 * 그만둔 사람은 지우는 것이 아니라 '종료'로 바꾸는 것이 맞다. 그 길을 삭제 옆에 나란히 둔다.
 * 일지가 한 건이라도 있으면 지울 수 없다(서버도 막는다) — [삭제 진행] 대신 종료만 안내한다.
 * 건수를 모르면 이름을 직접 쳐야 지워진다.
 */
async function askDeleteStaff(person) {
  if (state.pending) return;

  // 건수를 못 세면 "0건"이 아니라 "모름"이다. 모르면 이름 관문을 반드시 거친다.
  let counts = null;
  try {
    counts = (await get(`/api/staff/${person.id}/records-count`)).counts ?? null;
  } catch (error) {
    console.error("[askDeleteStaff]", error);
  }

  // 일지가 있으면 삭제 길은 없다. 종료만 보인다.
  const journals = counts ? counts.journals + (counts.linked_journals ?? 0) : 0;
  if (counts && journals > 0) {
    const blocked = [
      `${person.name} · ${person.role ?? "역할 없음"}`,
      `일지 ${journals}건이 있어 삭제할 수 없어요.`,
      person.status === "활동중"
        ? "그만둔 경우 [종료로 변경]을 눌러 주세요 — 기록이 남고 로그인이 막힙니다."
        : "이미 종료된 사람입니다. 기록은 그대로 남습니다.",
    ];
    const pick = await chooseDialog({
      title: "삭제할 수 없어요",
      message: blocked.join("\n"),
      choices: person.status === "활동중"
        ? [{ label: "종료로 변경", value: "close", kind: "primary" }]
        : [],
    });
    if (pick === "close") await setStatus(person, "종료");
    return;
  }

  const lines = [
    `${person.name} · ${person.role ?? "역할 없음"}`,
    ...(counts
      ? [`일정 ${counts.schedules}건은 함께 삭제됩니다.`]
      : ["딸린 기록 수를 확인하지 못했습니다. 일지가 있으면 삭제되지 않고 안내가 나옵니다."]),
    "되돌릴 수 없습니다.",
  ];
  if (person.status === "활동중") {
    lines.push("", "※ 그만둔 경우엔 삭제 대신 '종료' 처리를 권합니다 — 기록이 남습니다.");
  }

  const choices = [];
  if (person.status === "활동중") {
    choices.push({ label: "종료로 변경", value: "close", kind: "primary" });
  }
  choices.push({ label: "삭제 진행", value: "delete", kind: "danger" });

  const choice = await chooseDialog({
    title: "직원을 삭제할까요?",
    message: lines.join("\n"),
    choices,
  });

  if (choice === "close") {
    await setStatus(person, "종료");
    return;
  }
  if (choice !== "delete") return;

  // 건수를 모르면 한 번 더. 이름을 그대로 쳐야 버튼이 켜진다.
  if (counts === null) {
    const sure = await typeToConfirm({
      title: "정말 삭제할까요?",
      message: "딸린 기록 수를 알 수 없습니다.",
      expected: person.name,
    });
    if (!sure) return;
  }

  await deleteStaff(person, counts ?? { journals: 0, linked_journals: 0, schedules: 0 });
}

/** 삭제 대신 종료로. 화면 먼저 바꾸고 보낸다. */
async function setStatus(person, status) {
  const saved = snapshot();
  const row = state.people.find((item) => item.id === person.id);
  if (row) row.status = status;
  render();

  try {
    const payload = await send(`/api/staff/${person.id}`, "PATCH", { status });
    const index = state.people.findIndex((item) => item.id === person.id);
    if (index >= 0) state.people[index] = payload.staff;
    render();
    toast(`${person.name} · ${status} 처리했습니다`);
  } catch (error) {
    restore(saved);
    toast(error.message, true);
  }
}

async function deleteStaff(person, counts) {
  const saved = snapshot();
  state.pending = true;
  state.people = state.people.filter((item) => item.id !== person.id);
  render();

  try {
    await remove(`/api/staff/${person.id}`);
    toast(`${person.name} 삭제 · 일정 ${counts.schedules}건 함께 삭제`);
  } catch (error) {
    restore(saved);
    toast(error.message, true);
  } finally {
    state.pending = false;
  }
}

/**
 * 등록 뒤 다음 할 일. 보통은 센터장 이상이 등록하므로 계정 관리로 보낸다.
 * 로그인 없이 등록한 경우(최초 부팅 전, 경고 모드)는 계정 관리가 아직 없다 — 로그인 화면에서 첫 관리자를 정하게 한다.
 */
async function afterCreateHint(roles) {
  const normal = "등록되었습니다 — 설정 › 계정 관리에서 초대코드를 발급해 주세요";
  if (await loadMe()) return normal;
  try {
    const boot = await get("/api/auth/state");
    if (!boot.bootstrap) return normal;
    return roles.some((role) => (boot.roles ?? []).includes(role))
      ? "등록되었습니다 — 로그인 화면에서 이 분을 첫 관리자로 정하고 비밀번호를 만들어 주세요"
      : "등록되었습니다 — 첫 관리자는 센터장·생활복지사 중에서 로그인 화면에서 정합니다";
  } catch {
    return normal;
  }
}

/* ---------- 이벤트 ---------- */

for (const chip of el.statusChips) {
  chip.addEventListener("click", () => {
    state.status = chip.dataset.sstatus;
    pager.reset();
    syncStatusChips();
    render();
  });
}

el.search.addEventListener("input", () => {
  state.query = el.search.value;
  pager.reset();
  render();
});

el.addOpen.addEventListener("click", openCreate);
el.cancel.addEventListener("click", askClose);
el.backdrop.addEventListener("click", askClose);
el.form.addEventListener("submit", submit);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !el.modal.hidden) askClose();
});
