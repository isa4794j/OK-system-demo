/**
 * 설정 › 동의서 — 동의서 인쇄 · 처리방침 보기 · 문구 수정
 *
 * 문구 셋은 settings 에 산다(서버 lib/documents.ts):
 *   consent_form    동의서(Ⅰ~Ⅵ, 말미·서명란·수신)
 *   privacy_policy  개인정보 처리방침(공개 페이지) + 직원·봉사자 로그인 안내
 *   center_name     센터 이름 — 인쇄물 하단(글 안에 {센터} 라고 쓴 자리도)
 * 업체·서버 이름은 이 글 안에만 있다. 바뀌는 날 코드가 아니라 여기서 고친다.
 *
 * 읽기는 종사자, 고치기는 센터장 이상(정책표). 버튼 숨김은 친절일 뿐 — 막는 것은 서버다.
 * 저장은 바뀐 열쇠만 PUT(감사 로그는 서버가 전후 글째 남긴다).
 */
import { confirmDialog, get, hideState, send, showState, toast } from "./ui.js";
import { viewerAtLeast } from "./me.js";
import { fillCenter, renderConsentDoc, renderPolicyDoc } from "./doc_render.js";
import { openPrint } from "./print_link.js";

const KEYS = { consent: "consent_form", policy: "privacy_policy", center: "center_name" };

const el = {
  view: document.getElementById("view-documents"),
  print: document.getElementById("docs-print"),
  edit: document.getElementById("docs-edit"),
  policy: document.getElementById("docs-policy"),
  read: document.getElementById("docs-read"),
  readTabs: document.querySelectorAll("[data-doc-tab]"),
  preview: document.getElementById("docs-preview"),
  state: document.getElementById("docs-state"),
  editor: document.getElementById("docs-editor"),
  editTabs: document.querySelectorAll("[data-edit-tab]"),
  panes: {
    consent: document.getElementById("docs-edit-consent"),
    policy: document.getElementById("docs-edit-policy"),
    center: document.getElementById("docs-edit-center"),
  },
  save: document.getElementById("docs-save"),
  cancel: document.getElementById("docs-cancel"),
  reset: document.getElementById("docs-reset"),
};

const state = {
  /** 저장된 값 { consent, policy, center } */
  saved: null,
  /** 기본값(서버가 GET 에 실어 준다) */
  defaults: null,
  /** 고치는 중인 사본. null 이면 보기 */
  draft: null,
  readTab: "consent",
  editTab: "consent",
  pending: false,
  seq: 0,
  canEdit: false,
};

const clone = (value) => JSON.parse(JSON.stringify(value));

export function showDocuments() {
  el.view.hidden = false;
  if (state.draft) return; // 고치던 것을 이어서
  load();
}

export function hideDocuments() {
  el.view.hidden = true;
}

async function load() {
  const seq = ++state.seq;
  el.preview.replaceChildren();
  showState(el.state, "불러오는 중…");
  try {
    const [consent, policy, center, canEdit] = await Promise.all([
      get(`/api/settings/${KEYS.consent}`),
      get(`/api/settings/${KEYS.policy}`),
      get(`/api/settings/${KEYS.center}`),
      viewerAtLeast("센터장"),
    ]);
    if (seq !== state.seq) return;
    state.saved = { consent: consent.value, policy: policy.value, center: center.value };
    state.defaults = { consent: consent.default, policy: policy.default, center: center.default };
    state.canEdit = canEdit;
    hideState(el.state);
    renderRead();
  } catch (error) {
    if (seq !== state.seq) return;
    showState(el.state, "문구를 불러오지 못했습니다.", error.message, true);
  }
}

/* ---------- 보기 ---------- */

function renderRead() {
  el.read.hidden = false;
  el.editor.hidden = true;
  el.print.hidden = false;
  el.policy.hidden = false;
  el.edit.hidden = !state.canEdit;
  for (const chip of el.readTabs) {
    const on = chip.dataset.docTab === state.readTab;
    chip.classList.toggle("is-selected", on);
    chip.setAttribute("aria-pressed", String(on));
  }
  if (!state.saved) return;
  const center = state.saved.center;
  if (state.readTab === "consent") {
    el.preview.replaceChildren(renderConsentDoc(state.saved.consent, center));
  } else {
    const raw = state.saved.policy;
    const policy = {
      ...raw,
      title: fillCenter(raw.title, center),
      intro: fillCenter(raw.intro, center),
      sections: raw.sections.map((one) => ({
        title: fillCenter(one.title, center),
        body: fillCenter(one.body, center),
      })),
      staff_notice: fillCenter(raw.staff_notice, center),
      staff_agree: fillCenter(raw.staff_agree, center),
    };
    el.preview.replaceChildren(renderPolicyDoc(policy, { staffNotice: true }));
  }
}

for (const chip of el.readTabs) {
  chip.addEventListener("click", () => {
    state.readTab = chip.dataset.docTab;
    renderRead();
  });
}

/* ---------- 고치기: 칸 만들기 ---------- */

let uid = 0;

function field(label, input, hint) {
  const box = document.createElement("div");
  box.className = "field";
  const id = `docs-f${++uid}`;
  input.id = id;
  const lab = document.createElement("label");
  lab.className = "field__label";
  lab.htmlFor = id;
  lab.textContent = label;
  box.append(lab, input);
  if (hint) {
    const p = document.createElement("p");
    p.className = "form__hint";
    p.textContent = hint;
    box.append(p);
  }
  return box;
}

/** obj[key] 를 고치는 한 줄 칸 */
function lineInput(obj, key, max = 200) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "input";
  input.maxLength = max;
  input.value = obj[key] ?? "";
  input.addEventListener("input", () => (obj[key] = input.value));
  return input;
}

/** obj[key] 를 고치는 여러 줄 칸. 글 길이만큼 늘어난다 */
function textInput(obj, key, max = 3000) {
  const input = document.createElement("textarea");
  input.className = "input textarea";
  input.maxLength = max;
  input.value = obj[key] ?? "";
  const fit = () => {
    input.rows = Math.min(12, Math.max(2, input.value.split("\n").length + 1));
  };
  fit();
  input.addEventListener("input", () => {
    obj[key] = input.value;
    fit();
  });
  return input;
}

function smallButton(label, onClick, danger = false) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `linkbtn${danger ? " linkbtn--danger" : ""}`;
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function group(title, ...children) {
  const box = document.createElement("fieldset");
  box.className = "docs__group";
  const legend = document.createElement("legend");
  legend.className = "docs__legend";
  legend.textContent = title;
  box.append(legend, ...children);
  return box;
}

/* ---------- 고치기: 동의서 ---------- */

function renderConsentEditor() {
  const form = state.draft.consent;
  const pane = el.panes.consent;
  pane.replaceChildren();

  pane.append(
    field("제목", lineInput(form, "title")),
    field("머리말", textInput(form, "intro")),
  );

  form.sections.forEach((section, index) => {
    const rows = document.createElement("div");
    rows.className = "docs__rows";
    section.rows.forEach((row, r) => {
      const line = document.createElement("div");
      line.className = "docs__row";
      const tools = document.createElement("div");
      tools.className = "docs__rowtools";
      if (section.rows.length > 1) {
        tools.append(smallButton("줄 빼기", () => {
          section.rows.splice(r, 1);
          renderConsentEditor();
        }, true));
      }
      line.append(
        field("머리", lineInput(row, "label")),
        field("본문", textInput(row, "text"), r === 0 ? "줄바꿈은 그대로 찍힙니다. ▸ 는 글자 그대로입니다." : ""),
        tools,
      );
      rows.append(line);
    });

    const choice = document.createElement("label");
    choice.className = "docs__check";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = section.choice;
    box.addEventListener("change", () => (section.choice = box.checked));
    choice.append(box, document.createTextNode(" 끝에 □ 동의함 □ 동의하지 않음 붙이기"));

    const tools = document.createElement("div");
    tools.className = "docs__tools";
    tools.append(smallButton("줄 더하기", () => {
      section.rows.push({ label: "", text: "" });
      renderConsentEditor();
    }));
    if (index > 0) {
      tools.append(smallButton("위로", () => {
        [form.sections[index - 1], form.sections[index]] = [form.sections[index], form.sections[index - 1]];
        renderConsentEditor();
      }));
    }
    if (form.sections.length > 1) {
      tools.append(smallButton("이 항목 빼기", async () => {
        const yes = await confirmDialog({
          title: "이 항목을 뺄까요?",
          message: `"${section.title}" 이 동의서에서 빠집니다. 저장해야 반영됩니다.`,
          confirmText: "빼기",
        });
        if (!yes) return;
        form.sections.splice(index, 1);
        renderConsentEditor();
      }, true));
    }

    pane.append(group(
      section.title || `${index + 1}번째 항목`,
      field("항목 제목", lineInput(section, "title")),
      rows,
      choice,
      tools,
    ));
  });

  const add = document.createElement("div");
  add.className = "docs__tools";
  add.append(smallButton("항목 더하기", () => {
    form.sections.push({
      title: "새 항목",
      rows: [{ label: "수집항목", text: "▸ " }],
      choice: true,
    });
    renderConsentEditor();
  }));
  pane.append(add);

  const signs = { text: (form.signs ?? []).join("\n") };
  const signInput = textInput(signs, "text", 1200);
  signInput.addEventListener("input", () => {
    form.signs = signs.text.split("\n").filter((line) => line.trim() !== "").slice(0, 6);
  });
  pane.append(group(
    "말미",
    field("안내(※)", textInput(form, "notes")),
    field("확인 문장", textInput(form, "confirm")),
    field("서명란", signInput, "한 줄에 하나(최대 6줄). 날짜 줄은 자동으로 붙습니다."),
    field("수신", lineInput(form, "addressee")),
  ));
}

/* ---------- 고치기: 처리방침 ---------- */

function renderPolicyEditor() {
  const policy = state.draft.policy;
  const pane = el.panes.policy;
  pane.replaceChildren();
  pane.append(
    field("제목", lineInput(policy, "title")),
    field("머리말", textInput(policy, "intro")),
  );
  policy.sections.forEach((section, index) => {
    const tools = document.createElement("div");
    tools.className = "docs__tools";
    if (index > 0) {
      tools.append(smallButton("위로", () => {
        [policy.sections[index - 1], policy.sections[index]] = [policy.sections[index], policy.sections[index - 1]];
        renderPolicyEditor();
      }));
    }
    if (policy.sections.length > 1) {
      tools.append(smallButton("이 절 빼기", () => {
        policy.sections.splice(index, 1);
        renderPolicyEditor();
      }, true));
    }
    pane.append(group(
      section.title || `${index + 1}번째 절`,
      field("절 제목", lineInput(section, "title")),
      field("본문", textInput(section, "body")),
      tools,
    ));
  });
  const add = document.createElement("div");
  add.className = "docs__tools";
  add.append(smallButton("절 더하기", () => {
    policy.sections.push({ title: `${policy.sections.length + 1}. 새 절`, body: "" });
    renderPolicyEditor();
  }));
  pane.append(add);
  pane.append(group(
    "직원·봉사자 로그인 안내",
    field("안내 문구", textInput(policy, "staff_notice"), "첫 비밀번호를 정할 때와, 아직 동의하지 않은 사람이 로그인할 때 보입니다."),
    field("동의 체크 문장", lineInput(policy, "staff_agree")),
  ));
}

/* ---------- 고치기: 센터 이름 ---------- */

function renderCenterEditor() {
  const holder = state.draft;
  const pane = el.panes.center;
  pane.replaceChildren(
    field("센터 이름", lineInput(holder, "center", 60), "인쇄물 하단에 찍힙니다. 문구 안에 {센터} 라고 쓴 자리도 이 이름으로 바뀝니다."),
  );
}

function renderEditor() {
  el.read.hidden = true;
  // 고치는 동안에는 [문구 수정]·[동의서 인쇄] 를 감춘다(인쇄는 저장된 문구를 찍는다)
  el.edit.hidden = true;
  el.print.hidden = true;
  el.policy.hidden = true;
  el.editor.hidden = false;
  for (const chip of el.editTabs) {
    const on = chip.dataset.editTab === state.editTab;
    chip.classList.toggle("is-selected", on);
    chip.setAttribute("aria-pressed", String(on));
  }
  for (const [name, pane] of Object.entries(el.panes)) pane.hidden = name !== state.editTab;
  renderConsentEditor();
  renderPolicyEditor();
  renderCenterEditor();
}

for (const chip of el.editTabs) {
  chip.addEventListener("click", () => {
    state.editTab = chip.dataset.editTab;
    renderEditor();
  });
}

function changedKeys() {
  if (!state.draft || !state.saved) return [];
  return Object.keys(KEYS).filter((name) =>
    JSON.stringify(state.draft[name]) !== JSON.stringify(state.saved[name])
  );
}

el.edit.addEventListener("click", () => {
  if (!state.saved) return;
  state.draft = clone(state.saved);
  state.editTab = state.readTab;
  renderEditor();
});

el.cancel.addEventListener("click", async () => {
  if (state.pending) return;
  if (changedKeys().length) {
    const yes = await confirmDialog({
      title: "고친 문구를 버릴까요?",
      message: "저장하지 않은 변경이 사라집니다.",
      confirmText: "버리기",
    });
    if (!yes) return;
  }
  state.draft = null;
  renderRead();
});

el.reset.addEventListener("click", async () => {
  if (!state.draft || !state.defaults) return;
  const names = { consent: "동의서", policy: "처리방침", center: "센터 이름" };
  const yes = await confirmDialog({
    title: `${names[state.editTab]}를 기본 문구로 채울까요?`,
    message: "이 탭의 고친 내용이 처음 문구로 바뀝니다. [저장] 을 눌러야 반영됩니다.",
    confirmText: "기본 문구로",
  });
  if (!yes) return;
  state.draft[state.editTab] = clone(state.defaults[state.editTab]);
  renderEditor();
});

el.editor.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.pending) return;
  const keys = changedKeys();
  if (keys.length === 0) {
    toast("바뀐 문구가 없습니다");
    return;
  }
  state.pending = true;
  el.save.disabled = true;
  try {
    // 하나씩 — 앞의 것이 저장된 뒤 뒤의 것이 막히면 저장된 것만 반영된 채로 알린다
    for (const name of keys) {
      const value = name === "center" ? String(state.draft.center).trim() : state.draft[name];
      const payload = await send(`/api/settings/${KEYS[name]}`, "PUT", { value });
      state.saved[name] = payload.value;
    }
    state.draft = null;
    renderRead();
    toast("문구를 저장했습니다");
  } catch (error) {
    // 고치던 것은 그대로 둔다(원칙 9)
    toast(error.message, true);
  } finally {
    state.pending = false;
    el.save.disabled = false;
  }
});

el.print.addEventListener("click", () => openPrint({ kind: "consent" }));

// 처리방침은 새 창 없이 이 화면의 [처리방침] 미리보기로 — 설정 안에 머문다
el.policy.addEventListener("click", () => {
  if (state.draft) return;
  state.readTab = "policy";
  renderRead();
  el.preview.scrollIntoView({ block: "start", behavior: "smooth" });
});
