/**
 * 화면 전환(네비게이션)
 *
 * 두 단이다.
 *   메인 메뉴    — 아동 / 자원 / 설정(넓은 화면 왼쪽 레일, 좁은 화면 아래 탭바).
 *                  서브탭 패널을 통째로 바꾼다.
 *   서브탭        — 그 축 안에서 어떤 화면을 보여줄지 정한다.
 *
 * 여기서는 무엇을 보여줄지만 정한다.
 * 화면 안쪽 로직은 각 모듈(children.js, journals.js, staff.js, resources.js)이 맡는다.
 */
import { hideChildren, showChildren } from "./children.js";
import { hideJournals, showJournals } from "./journals.js";
import { hideStaff, showStaff } from "./staff.js";
import { hideSchedule, showSchedule } from "./schedule.js";
import { hideResources, showResources } from "./resources.js";
import { hideResourceStats, showResourceStats } from "./resource_stats.js";
import { refreshInboxBadge } from "./resource_inbox.js";
import { hideBooks, showBooks } from "./books.js";
import { hideAudit, showAudit } from "./audit.js";
import { hideAccounts, showAccounts } from "./accounts.js";
import { hideWarnings, showWarnings } from "./guard_warnings.js";
import { hideInquiries, refreshInquiryBadge, showInquiries } from "./inquiries.js";
import { hideVolunteerSettings, showVolunteerSettings } from "./volunteer_settings.js";
import { hideSystemCheck, showSystemCheck } from "./system_check.js";
import { initToTop } from "./ui.js";
import { canOpenSetting, initMe } from "./me.js";
import { hideAreaSetting, showAreaSetting } from "./obs_area_admin.js";
import { hideDocuments, showDocuments } from "./documents.js";

const el = {
  tabButtons: document.querySelectorAll(".rail__item[data-rail]"),
  subnavChildren: document.getElementById("subnav-children"),
  subnavResources: document.getElementById("subnav-resources"),
  subnavSettings: document.getElementById("subnav-settings"),
  resButtons: document.querySelectorAll(".subnav__item[data-res]"),

  settingButtons: document.querySelectorAll(".subnav__item[data-setting]"),
  /** 설정 그룹 칩(좁은 화면) — 시스템 관리·로그. 문의함은 그 자체가 항목이다 */
  settingGroupChips: document.querySelectorAll(".subnav__item[data-sgroup-chip]"),
  settingGroups: document.querySelectorAll("#subnav-settings .sgroup"),
  sectionButtons: document.querySelectorAll(".subnav__item[data-section]"),
  staffViewButtons: document.querySelectorAll(".subnav__item[data-sview]"),
  volButtons: document.querySelectorAll(".subnav__item[data-vol]"),
  kindList: document.getElementById("kind-list"),
  volList: document.getElementById("volunteer-list"),
};

/** 하위 목록의 첫 항목을 기본으로 연다 */
const DEFAULT_STAFF_VIEW = "명단";
const DEFAULT_VOL = "명단";
const DEFAULT_RES = "자원사전";
/** 설정의 첫 항목 — 누구나 여는 문의함(등급이 안 되는 화면으로 먼저 가 403 이 뜨지 않게) */
const DEFAULT_SETTING = "문의함";

/**
 * 명단 화면은 역할만 바꿔 다시 쓴다.
 * 화면을 두 벌 만들지 않으므로, 명단이 하나 더 필요해지면 여기에 한 줄만 더하면 된다.
 */
const STAFF_LISTS = {
  // closedLabel: 그만둔 사람을 부르는 말. 종사자는 퇴사, 봉사자는 종료.
  staff: { title: "종사자 명단", roles: ["센터장", "생활복지사"], closedLabel: "퇴사" },
  volunteer: { title: "봉사자 명단", roles: ["멘토", "봉사자"], closedLabel: "종료" },
};

const state = {
  /** 메인탭에서 고른 축: children | resources | settings */
  tab: "children",
  section: "children", // children | staff | volunteer
  /** 종사자 아래에서 보고 있는 것: 명단 / 프로그램 / 일상 / 회의록 */
  staffView: DEFAULT_STAFF_VIEW,
  /** 멘토+봉사자 아래에서 보고 있는 것: 명단 / 스케줄 / 봉사일지 */
  vol: DEFAULT_VOL,
  /** 자원 아래에서 보고 있는 것 */
  res: DEFAULT_RES,
  /** 설정 아래에서 보고 있는 것 */
  setting: DEFAULT_SETTING,
  /** 설정 그룹마다 마지막으로 본 항목(그룹 칩을 다시 누르면 거기로) */
  settingInGroup: {},
};

/**
 * 메인탭을 고른다. 서브탭 패널이 통째로 바뀐다.
 *
 * 축마다 마지막으로 보던 화면을 기억한다.
 * 자원을 보다 아동으로 갔다가 돌아오면 보던 곳으로 돌아와야 한다.
 */
function selectTab(tab) {
  state.tab = tab;

  for (const node of el.tabButtons) {
    const isActive = node.dataset.rail === tab;
    node.classList.toggle("is-active", isActive);
    if (isActive) node.setAttribute("aria-current", "page");
    else node.removeAttribute("aria-current");
  }

  el.subnavChildren.hidden = tab !== "children";
  el.subnavResources.hidden = tab !== "resources";
  el.subnavSettings.hidden = tab !== "settings";

  if (tab === "resources") {
    // 미분류함 뱃지는 [자원사전] 서브탭에 붙어 있다. 이 축을 열 때 한 번 센다.
    refreshInboxBadge();
    selectResource(state.res);
  } else if (tab === "settings") {
    // 문의 뱃지는 서브탭에 붙어 있다. 이 축을 열 때 한 번 센다(미분류함과 같은 방식).
    refreshInquiryBadge();
    openAllowedSetting();
  } else {
    selectSection(state.section);
  }
}

/** 자원 축 안에서 화면을 고른다. */
function selectResource(res) {
  state.res = res;

  for (const node of el.resButtons) {
    const isActive = node.dataset.res === res;
    node.classList.toggle("is-active", isActive);
    if (isActive) node.setAttribute("aria-current", "page");
    else node.removeAttribute("aria-current");
  }

  revealActiveSubnav();

  hideAllViews();
  if (res === "자원통계") showResourceStats();
  else if (res === "도서관") showBooks();
  else showResources();
}

/**
 * 지금 고른 서브탭이 눈에 보이게 옆으로 민다.
 *
 * 좁은 화면(폰)에서는 서브탭이 세로 칸이 아니라 가로 띠로 눕는다.
 * 그러면 항목이 화면 밖으로 밀려날 수 있다 — [종사자]를 누르면 일지 3종이
 * 오른쪽에 펼쳐지는데, 그 자리가 화면 밖이면 펼쳐진 줄도 모른다.
 * 넓은 화면에서는 밀 것이 없어 아무 일도 일어나지 않는다.
 */
function revealActiveSubnav() {
  const panel = document.querySelector(".subnav:not([hidden])");
  if (!panel) return;

  // 아동 축(좁은 화면): 그룹 탭 셋은 고정이고, 옆으로 미는 것은 둘째 줄(화면 칩)뿐이다.
  // 그 줄 안에서만 민다 — scrollIntoView 는 iOS 사파리에서 화면 전체까지 끌어 움직여
  // 그룹 탭이 고를 때마다 튀었다(묶음 li 가 display:contents 라 기준 상자도 없다).
  // 설정 축도 같은 두 줄(그룹 칩 → 그 그룹의 항목 칩)
  const twoTier = panel.id === "subnav-children" || panel.id === "subnav-settings";
  const sub = panel.id === "subnav-children"
    ? panel.querySelector(".subnav__sub:not([hidden])")
    : panel.querySelector(".sgroup.is-open .subnav__sub");
  if (twoTier && globalThis.matchMedia?.("(max-width: 720px)").matches) {
    const chip = sub?.querySelector(".subnav__item.is-active");
    if (sub && chip) slideInto(sub, chip, false);
    return;
  }

  const active = panel.querySelector(".subnav__item.is-active");
  if (!active || panel.scrollWidth <= panel.clientWidth) return;

  // 하위 목록이 딸려 있으면 그 묶음째 왼쪽에 붙인다.
  // 고른 버튼만 보이게 하면 방금 펼쳐진 하위 항목이 오른쪽 화면 밖에 그대로 남는다.
  const group = active.closest("li");
  const hasSub = group?.querySelector(".subnav__sub:not([hidden])");
  slideInto(panel, hasSub ? group.firstElementChild ?? active : active, Boolean(hasSub));
}

/** scroller 만 옆으로 민다(바깥 칸·화면은 건드리지 않는다). start 면 왼쪽 끝에 붙인다. */
function slideInto(scroller, target, start) {
  const box = scroller.getBoundingClientRect();
  const at = target.getBoundingClientRect();
  const inset = parseFloat(getComputedStyle(scroller).paddingLeft) || 0;
  if (start) {
    scroller.scrollLeft += at.left - box.left - inset;
  } else if (at.left < box.left + inset) {
    scroller.scrollLeft += at.left - box.left - inset;
  } else if (at.right > box.right - inset) {
    scroller.scrollLeft += at.right - box.right + inset;
  }
}

/**
 * 설정 축을 열 때 첫 화면을 등급에 맞게 고른다.
 *
 * 예전 기본값(변경 기록)은 관리자 화면이라 센터장·종사자가 [설정]을 누르면 곧바로 403 이 떴다(지금 기본값은 문의함).
 * 마지막으로 보던 화면을 먼저 보고, 못 여는 것이면 서브탭 순서대로 처음 열리는 것을 연다.
 */
async function openAllowedSetting() {
  const names = [...el.settingButtons].map((node) => node.dataset.setting);
  const order = [state.setting, ...names.filter((name) => name !== state.setting)];
  for (const name of order) {
    if (pcOnlyHere(name)) continue;
    if (!(await canOpenSetting(name))) continue;
    // 기다리는 사이 다른 축으로 옮겼으면 아무것도 하지 않는다
    if (state.tab === "settings") selectSetting(name);
    return;
  }
}

/** 좁은 화면(종사자 폰)에서 숨기는 PC 전용 설정인가 — index.html 의 data-pc-only */
const NARROW = globalThis.matchMedia("(max-width: 720px)");
function pcOnlyHere(name) {
  if (!NARROW.matches) return false;
  const node = [...el.settingButtons].find((one) => one.dataset.setting === name);
  return Boolean(node?.closest("[data-pc-only]"));
}

// 설정을 보던 중 좁은 화면이 되면, PC 전용 화면에 머물지 않게 열 수 있는 것으로 옮긴다
NARROW.addEventListener("change", () => {
  if (state.tab === "settings" && pcOnlyHere(state.setting)) openAllowedSetting();
});

/**
 * 그룹 칩(넓은 화면에서는 숨김 — 예전 좁은 화면용)을 눌렀을 때 — 그 그룹에서 마지막으로 본 항목, 없으면 처음 열리는 항목.
 * 숨긴(등급이 안 되는) 항목은 건너뛴다.
 */
async function openSettingGroup(group) {
  const box = [...el.settingGroups].find((node) => node.dataset.sgroup === group);
  if (!box) return;
  const names = [...box.querySelectorAll(".subnav__item[data-setting]")]
    .filter((node) => !node.closest("li").hidden)
    .map((node) => node.dataset.setting);
  const last = state.settingInGroup[group];
  const order = last && names.includes(last) ? [last, ...names.filter((name) => name !== last)] : names;
  for (const name of order) {
    if (!(await canOpenSetting(name))) continue;
    if (state.tab === "settings") selectSetting(name);
    return;
  }
}

/** 설정 축 안에서 화면을 고른다. */
function selectSetting(setting) {
  state.setting = setting;

  for (const node of el.settingButtons) {
    const isActive = node.dataset.setting === setting;
    node.classList.toggle("is-active", isActive);
    if (isActive) node.setAttribute("aria-current", "page");
    else node.removeAttribute("aria-current");
  }
  // 고른 항목이 든 그룹을 연다(좁은 화면 둘째 줄) — 그룹 칩에도 고른 표시
  for (const group of el.settingGroups) {
    const open = Boolean(group.querySelector(`.subnav__item[data-setting="${setting}"]`));
    group.classList.toggle("is-open", open);
    if (open) state.settingInGroup[group.dataset.sgroup] = setting;
  }
  for (const chip of el.settingGroupChips) {
    const open = chip.closest(".sgroup").classList.contains("is-open");
    chip.classList.toggle("is-active", open);
    if (open) chip.setAttribute("aria-current", "true");
    else chip.removeAttribute("aria-current");
  }

  revealActiveSubnav();

  hideAllViews();
  if (setting === "계정 관리") showAccounts();
  else if (setting === "관문 경고") showWarnings();
  else if (setting === "문의함") showInquiries();
  else if (setting === "봉사자 설정") showVolunteerSettings();
  else if (setting === "시스템 점검") showSystemCheck();
  else if (setting === "관찰 영역") showAreaSetting();
  else if (setting === "동의서") showDocuments();
  else showAudit();
}

/** 화면 전환 — 먼저 모두 감추고 필요한 것만 연다 */
function hideAllViews() {
  hideChildren();
  hideJournals();
  hideStaff();
  hideSchedule();
  hideResources();
  hideResourceStats();
  hideBooks();
  hideAudit();
  hideAccounts();
  hideWarnings();
  hideInquiries();
  hideVolunteerSettings();
  hideSystemCheck();
  hideAreaSetting();
  hideDocuments();
}

function selectSection(section, { staffView, vol } = {}) {
  state.section = section;
  if (section === "staff") state.staffView = staffView ?? state.staffView ?? DEFAULT_STAFF_VIEW;
  if (section === "volunteer") state.vol = vol ?? state.vol ?? DEFAULT_VOL;

  // 선택 표시
  for (const node of el.sectionButtons) {
    const isActive = node.dataset.section === section;
    node.classList.toggle("is-active", isActive);
    if (isActive) node.setAttribute("aria-current", "page");
    else node.removeAttribute("aria-current");
  }
  for (const node of el.staffViewButtons) {
    const isActive = section === "staff" && node.dataset.sview === state.staffView;
    node.classList.toggle("is-active", isActive);
    if (isActive) node.setAttribute("aria-current", "page");
    else node.removeAttribute("aria-current");
  }
  for (const node of el.volButtons) {
    const isActive = section === "volunteer" && node.dataset.vol === state.vol;
    node.classList.toggle("is-active", isActive);
    if (isActive) node.setAttribute("aria-current", "page");
    else node.removeAttribute("aria-current");
  }

  // 고른 항목의 하위 목록만 펼친다
  el.kindList.hidden = section !== "staff";
  el.volList.hidden = section !== "volunteer";

  // 펼쳐진 하위 목록이 화면 밖에 있으면 안 보인다. 먼저 옆으로 밀어 둔다.
  revealActiveSubnav();

  hideAllViews();

  if (section === "staff") {
    // 명단이면 공통 명단 화면, 아니면 그 종류의 일지 화면
    if (state.staffView === "명단") showStaff(STAFF_LISTS.staff);
    else showJournals(state.staffView);
  } else if (section === "volunteer") {
    // 봉사일지는 종사자 일지와 같은 화면을 kind만 바꿔 다시 쓴다
    if (state.vol === "스케줄") showSchedule();
    else if (state.vol === "봉사일지") showJournals("봉사");
    else showStaff(STAFF_LISTS.volunteer);
  } else {
    showChildren();
  }
}

for (const node of el.tabButtons) {
  node.addEventListener("click", () => selectTab(node.dataset.rail));
}
for (const node of el.resButtons) {
  node.addEventListener("click", () => selectResource(node.dataset.res));
}
for (const node of el.settingButtons) {
  node.addEventListener("click", () => selectSetting(node.dataset.setting));
}
for (const node of el.settingGroupChips) {
  node.addEventListener("click", () => openSettingGroup(node.dataset.sgroupChip));
}
for (const node of el.sectionButtons) {
  // 서브탭을 누르면 그 축 안에서 움직인다. 메인탭은 이미 아동에 있다.
  node.addEventListener("click", () => selectSection(node.dataset.section));
}
for (const node of el.staffViewButtons) {
  node.addEventListener("click", () => selectSection("staff", { staffView: node.dataset.sview }));
}
for (const node of el.volButtons) {
  node.addEventListener("click", () => selectSection("volunteer", { vol: node.dataset.vol }));
}

// 긴 목록에서 맨 위로 돌아가는 버튼. 화면마다 두지 않고 여기서 한 번 붙인다.
initToTop();

// 앱바에 "지금 누구인지". 로그인하지 않았으면 아무것도 안 그린다.
initMe();

// 처음에는 아동 명단
selectTab("children");
