/**
 * 로그인 화면
 *
 * 다섯 가지 모습이 한 페이지 안에서 바뀐다.
 *   password  이름 + 비밀번호            — 평소
 *   code      이름 + 초대코드            — 처음 오는 사람
 *   new       비밀번호 정하기            — 코드를 맞힌 직후
 *   boot      최초 관리자 등록           — 계정이 0개일 때만
 *   consent   개인정보 처리 동의         — 동의 기록이 없는 계정이 로그인한 직후 한 번(034)
 *
 * 안내 문구는 설정(처리방침)에 저장된 글을 /api/public/privacy 로 받아 쓴다 — 업체 이름을 여기 두지 않는다.
 *
 * 무엇을 그릴지는 서버(/api/auth/state)가 알려 준다. 화면이 혼자 정하지 않는다.
 * 최초 부팅을 막는 것도 화면이 아니라 서버다 — 여기서 폼을 숨기는 것은
 * 안내일 뿐이고, 실제 자물쇠는 POST /api/auth/bootstrap 안에 있다.
 *
 * 브라우저는 Supabase에 직접 접근하지 않는다. 항상 /api/... 를 거친다.
 * 세션 쿠키는 HttpOnly 라 이 파일이 읽을 수 없다 — 읽을 일도 없다.
 */
import { clearAll as clearSnapshots } from "./m/store.js";

const el = {
  state: document.getElementById("login-state"),
  error: document.getElementById("login-error"),

  password: document.getElementById("form-password"),
  pwName: document.getElementById("pw-name"),
  pwPassword: document.getElementById("pw-password"),
  pwSubmit: document.getElementById("pw-submit"),
  goCode: document.getElementById("go-code"),

  code: document.getElementById("form-code"),
  codeName: document.getElementById("code-name"),
  codeCode: document.getElementById("code-code"),
  codeSubmit: document.getElementById("code-submit"),
  goPassword: document.getElementById("go-password"),

  fresh: document.getElementById("form-new"),
  newLead: document.getElementById("new-lead"),
  newPassword: document.getElementById("new-password"),
  newAgain: document.getElementById("new-again"),
  newSubmit: document.getElementById("new-submit"),
  newCancel: document.getElementById("new-cancel"),
  newAgree: document.getElementById("new-agree"),

  consent: document.getElementById("form-consent"),
  consentAgree: document.getElementById("consent-agree"),
  consentSubmit: document.getElementById("consent-submit"),
  consentLogout: document.getElementById("consent-logout"),

  boot: document.getElementById("form-boot"),
  bootWho: document.getElementById("boot-who"),
  bootLead: document.getElementById("boot-lead"),
  bootPick: document.getElementById("boot-pick"),
  bootNew: document.getElementById("boot-new"),
  bootName: document.getElementById("boot-name"),
  bootRole: document.getElementById("boot-role"),
  bootPreview: document.getElementById("boot-preview"),
  bootPassword: document.getElementById("boot-password"),
  bootAgain: document.getElementById("boot-again"),
  bootSubmit: document.getElementById("boot-submit"),
};

const state = {
  /**
   * 코드 단계에서 확인한 값. 비밀번호를 정할 때 함께 보낸다.
   *
   * 서버에 표를 두지 않는 이유는 api/auth.ts 에 적었다 —
   * 배포에서는 인스턴스가 여럿이라 요청 사이에 남긴 것을 믿을 수 없다.
   * 이 값은 이 페이지가 열려 있는 동안만 산다. 어디에도 저장하지 않는다.
   */
  entry: null, // { name, code }
  /** 로그인은 됐고 동의만 남은 사람(동의 뒤 어느 화면으로 갈지) */
  user: null,
  pending: false,
};

/* ---------- 서버 ---------- */

async function call(url, body) {
  const response = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error ?? `서버 오류 (HTTP ${response.status})`);
  }
  return payload;
}

/* ---------- 화면 ---------- */

function show(which) {
  el.state.hidden = true;
  el.password.hidden = which !== "password";
  el.code.hidden = which !== "code";
  el.fresh.hidden = which !== "new";
  el.boot.hidden = which !== "boot";
  el.consent.hidden = which !== "consent";
  clearError();
  if (which !== "consent") el.consentAgree.checked = false;

  // 코드 단계를 떠나면 이름·코드를 비운다.
  // 남겨 두면 다음 사람이 열었을 때 남의 이름이 적혀 있고,
  // 되돌아왔을 때는 이미 쓴 코드가 그대로 있어 또 틀린다.
  if (which !== "code") {
    el.codeName.value = "";
    el.codeCode.value = "";
  }
  if (which !== "new") {
    el.newPassword.value = "";
    el.newAgain.value = "";
    el.newAgree.checked = false;
  }

  // 첫 칸에 바로 커서를 둔다. 로그인 화면에서 마우스를 집는 일이 없게.
  const first = {
    password: el.pwName,
    code: el.codeName,
    new: el.newPassword,
    boot: el.bootNew.hidden ? el.bootWho : el.bootName,
    consent: el.consentAgree,
  }[which];
  first?.focus();
}

/**
 * 오류를 적고 그 자리로 화면을 옮긴다.
 *
 * 폰에서는 키보드가 화면의 절반을 덮는다. 적어 두기만 하면 사람 눈에 안 들어와
 * "눌렀는데 아무 일도 안 일어났다" 가 된다. 실제로 실기기에서 그렇게 보였다.
 */
function showError(message) {
  el.error.textContent = message;
  el.error.hidden = false;
  el.error.scrollIntoView({ block: "nearest" });
}

function clearError() {
  el.error.textContent = "";
  el.error.hidden = true;
}

/** 보내는 동안 버튼을 잠근다. 두 번 눌러 두 번 보내는 일이 없게. */
function busy(button, on, label) {
  state.pending = on;
  button.disabled = on;
  button.textContent = on ? "잠시만요…" : label;
}

/**
 * 로그인에 성공했다. 세션 쿠키는 이미 붙었다.
 *
 * 봉사자 계정은 PC 화면에서 할 수 있는 것이 없으므로 곧바로 제 화면으로 보낸다.
 * 서버도 "/" 에서 같은 판단을 하지만, 한 번 덜 다녀오는 편이 폰에서 눈에 띄게 빠르다.
 */
/**
 * 들어간다. 폰 화면이면 /m 으로.
 *
 * 나가기 전에 이 기기에 담긴 폰 화면 스냅샷을 지운다.
 * 로그인은 "지금부터 이 사람" 이라고 못 박는 자리다 — 여기서 지워 두면
 * /m 이 담긴 것을 곧바로 그려도 앞사람 것이 비칠 일이 없다.
 * (로그아웃도 지우지만, 로그아웃하지 않고 다른 사람이 들어오는 길이 남는다)
 */
function enter(user) {
  clearSnapshots();
  location.replace(user?.access_kind === "모바일" ? "/m" : "/");
}

/* ---------- 개인정보 처리 안내 ---------- */

/** 안내 문구 — 설정에 저장된 처리방침에서. 못 받으면 기본 한 줄로(동의 자체는 막지 않는다) */
async function loadNotice() {
  let notice = "개인정보 처리방침을 읽고 동의해 주세요.";
  let policy = null;
  let agree = "위 안내와 개인정보 처리방침을 읽었으며 동의합니다.";
  try {
    policy = (await call("/api/public/privacy")).policy;
    notice = policy.staff_notice || notice;
    agree = policy.staff_agree || agree;
  } catch {
    // 문구를 못 받아도 전문 링크는 있다
  }
  for (const pre of ["new", "consent"]) {
    document.getElementById(`${pre}-notice`).textContent = notice;
    document.getElementById(`${pre}-agree-text`).textContent = agree;
  }
  for (const box of document.querySelectorAll("[data-policy-full]")) fillPolicy(box, policy);
}

/** 처리방침 전문을 그 자리에 채운다(글은 textContent 로만). 못 받았으면 공개 페이지 주소를 알린다 */
function fillPolicy(box, policy) {
  box.replaceChildren();
  if (!policy) {
    box.textContent = "처리방침을 불러오지 못했습니다. 로그인 화면 아래 [개인정보 처리방침]에서 볼 수 있습니다.";
    return;
  }
  const title = document.createElement("p");
  title.className = "consent__title";
  title.textContent = policy.title;
  box.append(title);
  for (const one of [{ title: "", body: policy.intro }, ...policy.sections]) {
    if (one.title) {
      const head = document.createElement("p");
      head.className = "consent__subtitle";
      head.textContent = one.title;
      box.append(head);
    }
    const body = document.createElement("p");
    body.className = "consent__text";
    body.textContent = one.body;
    box.append(body);
  }
}

for (const toggle of document.querySelectorAll("[data-policy-toggle]")) {
  toggle.addEventListener("click", () => {
    const box = toggle.nextElementSibling;
    const open = box.hidden;
    box.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.textContent = open ? "처리방침 전문 접기" : "개인정보 처리방침 전문 보기";
  });
}

/* ---------- 시작 ---------- */

async function start() {
  loadNotice();
  try {
    // 이미 들어와 있는데 동의 전인 사람 — 입구(main.ts)가 이 화면으로 돌려보냈다
    const consent = await call("/api/auth/consent").catch(() => ({ needed: false }));
    if (consent.needed) {
      show("consent");
      return;
    }

    const payload = await call("/api/auth/state");
    if (!payload.bootstrap) {
      show("password");
      return;
    }

    const candidates = payload.candidates ?? [];
    // 명단에 고를 사람이 없으면(새 센터) 첫 종사자를 이 화면에서 바로 넣는다 — 그 사람이 관리자가 된다.
    // 잠근 서버에서는 로그인 없이 명단에 넣을 길이 이것뿐이다(서버가 같은 부팅 잠금으로 막는다).
    const fresh = candidates.length === 0;
    el.bootPick.hidden = fresh;
    el.bootNew.hidden = !fresh;
    el.bootWho.required = !fresh;
    el.bootName.required = fresh;
    el.bootRole.required = fresh;
    if (fresh) {
      el.bootLead.firstChild.textContent = "아직 명단도 계정도 없습니다. 관리자를 맡을 첫 종사자의 이름·직급을 넣고 " +
        "비밀번호를 정해 주세요. ";
      el.bootRole.replaceChildren();
      for (const role of payload.roles ?? ["센터장", "생활복지사"]) {
        const option = document.createElement("option");
        option.value = role;
        option.textContent = role;
        el.bootRole.append(option);
      }
      syncBootPreview();
      show("boot");
      return;
    }

    el.bootWho.replaceChildren();
    for (const one of candidates) {
      const option = document.createElement("option");
      option.value = one.id;
      // 이름은 사용자 입력이므로 textContent 로만 넣는다
      option.textContent = `${one.name} (${one.role ?? "역할 없음"})`;
      el.bootWho.append(option);
    }
    show("boot");
  } catch (error) {
    el.state.textContent = error instanceof TypeError
      ? "서버에 연결하지 못했습니다. 잠시 뒤 새로고침해 주세요."
      : error.message;
    el.state.hidden = false;
  }
}

/* ---------- 이름 + 비밀번호 ---------- */

el.password.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.pending) return;

  busy(el.pwSubmit, true, "로그인");
  clearError();
  try {
    const payload = await call("/api/auth/login", {
      name: el.pwName.value,
      password: el.pwPassword.value,
    });
    el.pwPassword.value = "";
    if (payload.consent_needed) {
      state.user = payload.user;
      show("consent");
      return;
    }
    enter(payload.user);
  } catch (error) {
    showError(error instanceof TypeError ? "서버에 연결하지 못했습니다." : error.message);
    el.pwPassword.value = "";
    el.pwPassword.focus();
  } finally {
    busy(el.pwSubmit, false, "로그인");
  }
});

/* ---------- 이름 + 초대코드 ---------- */

el.code.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.pending) return;

  busy(el.codeSubmit, true, "다음");
  clearError();
  try {
    // 칸에는 123-456 모양으로 보이지만 서버에는 숫자 여섯 자리만 보낸다
    const entry = { name: el.codeName.value.trim(), code: el.codeCode.value.replace(/\D/g, "") };
    const payload = await call("/api/auth/verify-code", entry);
    state.entry = entry;
    el.newLead.textContent = `${payload.name} 님, 앞으로 쓰실 비밀번호를 정해 주세요.`;
    show("new");
  } catch (error) {
    showError(error instanceof TypeError ? "서버에 연결하지 못했습니다." : error.message);
    el.codeCode.value = "";
    el.codeCode.focus();
  } finally {
    busy(el.codeSubmit, false, "다음");
  }
});

/* ---------- 비밀번호 정하기 ---------- */

el.fresh.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.pending) return;

  if (!el.newAgree.checked) {
    showError("개인정보 처리 안내를 읽고 동의에 체크해 주세요.");
    el.newAgree.focus();
    return;
  }
  if (el.newPassword.value !== el.newAgain.value) {
    showError("두 비밀번호가 다릅니다.");
    el.newAgain.value = "";
    el.newAgain.focus();
    return;
  }

  busy(el.newSubmit, true, "정하고 시작");
  clearError();
  try {
    if (!state.entry) {
      showError("이름과 초대코드를 다시 넣어 주세요.");
      show("code");
      return;
    }
    const payload = await call("/api/auth/first-password", {
      name: state.entry.name,
      code: state.entry.code,
      password: el.newPassword.value,
      agreed: el.newAgree.checked,
    });
    state.entry = null;
    enter(payload.user);
  } catch (error) {
    showError(error instanceof TypeError ? "서버에 연결하지 못했습니다." : error.message);
    // 코드가 그 사이 무효가 됐으면(재발급·만료) 처음부터 다시 해야 한다.
    if (/초대코드|맞지 않습니다|잠겼습니다/.test(String(error.message))) {
      state.entry = null;
      show("code");
    }
  } finally {
    busy(el.newSubmit, false, "정하고 시작");
  }
});

/* ---------- 개인정보 처리 동의(기존 계정) ---------- */

el.consent.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.pending) return;
  if (!el.consentAgree.checked) {
    showError("안내를 읽고 동의에 체크해 주세요.");
    el.consentAgree.focus();
    return;
  }

  busy(el.consentSubmit, true, "동의하고 시작");
  clearError();
  try {
    const payload = await call("/api/auth/consent", { agreed: true });
    enter(state.user ?? payload.user);
  } catch (error) {
    showError(error instanceof TypeError ? "서버에 연결하지 못했습니다." : error.message);
    // 세션이 그 사이 끝났다 — 처음부터
    if (/로그인이 필요/.test(String(error.message))) show("password");
  } finally {
    busy(el.consentSubmit, false, "동의하고 시작");
  }
});

el.consentLogout.addEventListener("click", async () => {
  try {
    await call("/api/auth/logout", {});
  } catch {
    // 나가기는 실패해도 화면은 처음으로
  }
  state.user = null;
  clearSnapshots();
  show("password");
});

/* ---------- 최초 관리자 ---------- */

/** 넣는 즉시 "이 사람이 관리자가 됩니다" 를 보여 준다 */
function syncBootPreview() {
  const name = el.bootName.value.trim();
  el.bootPreview.hidden = !name;
  el.bootPreview.textContent = name
    ? `${name} (${el.bootRole.value}) — 명단에 등록되고 관리자가 됩니다. 로그인 이름도 "${name}" 입니다.`
    : "";
}
el.bootName.addEventListener("input", syncBootPreview);
el.bootRole.addEventListener("change", syncBootPreview);

el.boot.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.pending) return;

  if (el.bootPassword.value !== el.bootAgain.value) {
    showError("두 비밀번호가 다릅니다.");
    el.bootAgain.value = "";
    el.bootAgain.focus();
    return;
  }

  busy(el.bootSubmit, true, "관리자로 시작");
  clearError();
  try {
    const who = el.bootNew.hidden
      ? { staff_id: el.bootWho.value }
      : { name: el.bootName.value.trim(), role: el.bootRole.value };
    const payload = await call("/api/auth/bootstrap", { ...who, password: el.bootPassword.value });
    enter(payload.user);
  } catch (error) {
    showError(error instanceof TypeError ? "서버에 연결하지 못했습니다." : error.message);
    // 그 사이 누가 먼저 만들었다. 이 화면은 이제 열릴 일이 없다.
    if (String(error.message).includes("이미 계정이")) show("password");
  } finally {
    busy(el.bootSubmit, false, "관리자로 시작");
  }
});

/* ---------- 오가기 ---------- */

el.goCode.addEventListener("click", () => {
  el.codeName.value = el.pwName.value;
  show("code");
});

el.goPassword.addEventListener("click", () => {
  el.pwName.value = el.codeName.value;
  show("password");
});

el.newCancel.addEventListener("click", () => {
  state.entry = null;
  show("code");
});

// 숫자만 받고, 발급 창·안내 글과 같은 모양(123-456)으로 보여 준다.
// 붙여넣기로 하이픈이나 공백이 섞여 들어오는 일이 흔하다.
el.codeCode.addEventListener("input", () => {
  const digits = el.codeCode.value.replace(/\D/g, "").slice(0, 6);
  el.codeCode.value = digits.length > 3 ? `${digits.slice(0, 3)}-${digits.slice(3)}` : digits;
});

/**
 * 뒤로 가기로 되돌아왔을 때.
 *
 * 사파리는 페이지를 통째로 얼려 두었다가 그대로 되살린다(bfcache).
 * 그러면 비밀번호를 다 정하고 떠났던 사람이 되돌아왔을 때 옛 화면 —
 * 코드 단계와 그때 적은 값 — 을 다시 보게 된다.
 * 되살아난 것이면 처음부터 다시 판단한다.
 */
globalThis.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    state.entry = null;
    start();
  }
});

start();
