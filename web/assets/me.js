/**
 * 앱바의 "지금 누구인지" 와 등급에 따른 메뉴 감추기
 *
 * 센터 PC 한 대를 여럿이 쓴다. 앞사람 계정으로 일지를 쓰는 사고는
 * 로그아웃 버튼보다 이름이 늘 보이는 편이 더 잘 막는다. 그래서 앱바에 둔다.
 *
 * [못 누르는 메뉴는 안 보이게 한다]
 * 관문이 막아도 눌러 보고 "권한이 없습니다" 를 읽는 것은 헛걸음이다.
 * 서버가 알려 준 등급으로 안 되는 서브탭을 아예 감춘다.
 * 감추는 것은 편의고 막는 것은 서버다 — 여기 없어도 관문이 다시 본다.
 *
 * [모바일 계정은 여기 올 일이 없다]
 * 봉사자에게는 제 화면(/m)이 있고, 서버가 "/" 에서 그리로 보낸다.
 * 그래도 어쩌다 여기 닿으면(리다이렉트 전 잠깐) 갈 곳을 알려 준다.
 *
 * [로그인하지 않았으면 아무것도 안 그린다]
 * 잠그기 전(1~4단계)에는 로그인 없이도 전 화면이 돈다. 그때 "로그인" 버튼을
 * 크게 띄우면 안 해도 되는 일을 하라고 조르는 꼴이다.
 * 잠근 뒤에는 로그인하지 않은 사람이 애초에 이 페이지에 못 온다.
 */
import { toast } from "./ui.js";

/** 서브탭마다 필요한 등급. 서버 정책표(api/policy.ts)와 같은 기준이어야 한다. */
const SETTING_NEEDS = {
  "변경 기록": "관리자",
  "계정 관리": "센터장",
  // 폰에 무엇이 보일지 정하는 자리 — 읽기도 센터장 이상(정책표). 종사자 설정은 문의함·동의서뿐
  "봉사자 설정": "센터장",
  "관문 경고": "관리자",
  "시스템 점검": "관리자",
  "관찰 영역": "관리자",
};

const ORDER = ["봉사", "종사자", "센터장", "관리자"];

function atLeast(have, need) {
  return ORDER.indexOf(have) >= ORDER.indexOf(need);
}

let mePromise = null;

/**
 * 지금 사용자. 한 번만 묻고 여러 화면이 나눠 쓴다. 모르면 null.
 *
 * 세션 확인에 실패해도 화면은 그대로 돈다. 잠그기 전이면 전과 같이 쓸 수 있고,
 * 잠근 뒤라면 서버가 이미 로그인 화면으로 보냈을 것이다.
 */
export function loadMe() {
  mePromise ??= fetch("/api/auth/me")
    .then((response) => (response.ok ? response.json() : null))
    .then((payload) => payload?.user ?? null)
    .catch(() => null);
  return mePromise;
}

/**
 * 보는 사람이 관리자인가. 관리자 계정의 버튼을 숨기는 데만 쓴다.
 * 숨김은 친절이지 보안이 아니다 — 막는 것은 서버(api/admin_target.ts)다.
 */
/**
 * 보는 사람의 등급이 need 이상인가. 서버가 거절할 버튼을 미리 숨기는 데만 쓴다(막는 것은 서버).
 * 모르면(로그인 전·확인 실패) 숨기지 않는다.
 */
export async function viewerAtLeast(need) {
  const user = await loadMe();
  return !user || atLeast(user.level, need);
}

export async function viewerIsAdmin() {
  return (await loadMe())?.level === "관리자";
}

/**
 * 이 설정 서브탭을 열 수 있는 등급인가. 서버 정책표와 같은 기준(SETTING_NEEDS).
 * 모르면(로그인 전·확인 실패) 막지 않는다 — 막는 것은 어차피 서버다.
 */
export async function canOpenSetting(name) {
  const user = await loadMe();
  if (!user) return true;
  const need = SETTING_NEEDS[name];
  return !need || atLeast(user.level, need);
}

export async function initMe() {
  const bar = document.querySelector(".appbar");
  if (!bar) return;

  const user = await loadMe();
  if (!user) return;

  bar.append(renderMe(user));

  if (user.access_kind === "모바일") {
    location.replace("/m");
    return;
  }
  hideWhatTheyCannotUse(user.level);
}

function renderMe(user) {
  const box = document.createElement("div");
  box.className = "appbar__me";

  const name = document.createElement("span");
  name.className = "appbar__name";
  // 이름은 사용자 입력이므로 textContent 로만 넣는다
  name.textContent = user.name;

  const level = document.createElement("span");
  level.className = "appbar__level";
  level.textContent = user.level;

  const out = document.createElement("button");
  out.type = "button";
  out.className = "appbar__logout";
  out.textContent = "로그아웃";
  out.addEventListener("click", () => logout(out));

  box.append(name, level, out);
  return box;
}

/** 등급이 안 되는 서브탭을 감춘다. 그 축에 남는 것이 없으면 메인탭까지 감춘다. */
function hideWhatTheyCannotUse(level) {
  for (const node of document.querySelectorAll(".subnav__item[data-setting]")) {
    const need = SETTING_NEEDS[node.dataset.setting];
    if (need && !atLeast(level, need)) node.closest("li").hidden = true;
  }

  const settings = document.getElementById("subnav-settings");
  // 보일 항목이 하나도 없는 그룹은 통째로 숨긴다(비관리자에게 "로그" 그룹이 안 보인다)
  for (const group of settings.querySelectorAll(".sgroup")) {
    const visible = [...group.querySelectorAll(".subnav__item[data-setting]")]
      .some((node) => !node.closest("li").hidden);
    if (!visible) group.hidden = true;
  }
  const left = [...settings.querySelectorAll(".subnav__item[data-setting]")]
    .filter((node) => !node.closest("li").hidden);
  if (left.length === 0) {
    document.querySelector('.rail__item[data-rail="settings"]')?.setAttribute("hidden", "");
  }
}

async function logout(button) {
  button.disabled = true;
  try {
    await fetch("/api/auth/logout", { method: "POST" });
    location.replace("/login");
  } catch {
    button.disabled = false;
    toast("로그아웃하지 못했습니다. 다시 눌러 주세요.", true);
  }
}
