/**
 * 관찰 영역 관리 — 관리자만. 입구는 [설정 › 관찰 영역] 하나(아동 상세의 [영역 관리] 모달은 뺐다).
 * 서버도 관리자만 받는다(정책표 PUT /api/settings/observation_areas). 좁은 화면에는 안 보인다(PC 전용).
 *
 * 이름 바꾸기·추가·삭제. 저장은 PUT /api/settings/observation_areas 한 번(감사 로그는 서버가).
 *   - 코드는 그대로다. 이름을 바꾸면 지난 관찰에도 새 이름으로 보인다.
 *   - 지우기는 목록에서 빼지 않고 "지움" 표시만 한다(되살릴 수 있다). 그 영역의 관찰은 미지정으로
 *     떨어지지 않고 "예전 영역"(회색)으로 남는다. 저장 전에 방금 더한 줄만 완전히 뺄 수 있다.
 * 규칙의 진짜 문지기는 서버(lib/obs_areas.ts)다. 여기서는 흔한 실수만 먼저 알린다.
 */
import { button, confirmDialog, send, toast } from "./ui.js";
import { loadObsAreas, nextAreaCode, obsAreas, setObsAreas } from "./obs_areas.js";

const el = {
  form: document.getElementById("area-form"),
  list: document.getElementById("area-list"),
  newName: document.getElementById("area-new"),
  add: document.getElementById("area-add"),
  save: document.getElementById("area-save"),
  cancel: document.getElementById("area-cancel"),
  view: document.getElementById("view-obs-areas"),
};

/** 고치는 중인 목록 — [{ code, name, deleted, fresh }] (fresh = 이번에 더한 줄) */
let draft = [];
let initial = "";
let pending = false;

function values() {
  return JSON.stringify(draft.map(({ code, name, deleted }) => ({ code, name: name.trim(), deleted: !!deleted })));
}

/** 지금 저장된 목록으로 고치기를 새로 시작한다 */
async function resetDraft() {
  await loadObsAreas();
  draft = obsAreas().map((one) => ({ ...one, deleted: !!one.deleted, fresh: false }));
  initial = values();
  el.newName.value = "";
  render();
}

/** [설정 › 관찰 영역] */
export async function showAreaSetting() {
  el.view.hidden = false;
  await resetDraft();
}

export function hideAreaSetting() {
  el.view.hidden = true;
}

/** 고치던 것을 버리고 저장된 목록으로 되돌린다 */
function resetForm() {
  resetDraft();
}

async function askClose() {
  if (pending) return;
  if (values() !== initial) {
    const yes = await confirmDialog({
      title: "고친 내용을 버릴까요?",
      message: "저장하지 않은 영역 변경이 사라집니다.",
      confirmText: "버리기",
    });
    if (!yes) return;
  }
  resetForm();
}

function render() {
  el.list.replaceChildren();
  for (const one of draft) el.list.append(renderRow(one));
}

function renderRow(one) {
  const li = document.createElement("li");
  li.className = one.deleted ? "rescat__item arearow arearow--old" : "rescat__item arearow";

  if (one.deleted) {
    const name = document.createElement("span");
    name.className = "rescat__name";
    // 영역 이름은 사람이 적은 글이라 textContent 로만
    name.textContent = one.name;
    const tag = document.createElement("span");
    tag.className = "tag area__old";
    tag.textContent = "지움";
    name.append(" ", tag);
    li.append(name);
  } else {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "input rescat__input arearow__input";
    input.maxLength = 20;
    input.value = one.name;
    input.setAttribute("aria-label", `${one.name || "새 영역"} 이름`);
    input.addEventListener("input", () => {
      one.name = input.value;
    });
    li.append(input);
  }

  const actions = document.createElement("div");
  actions.className = "rescat__actions";
  if (one.fresh) {
    actions.append(button("빼기", "linkbtn", () => {
      draft = draft.filter((row) => row !== one);
      render();
    }));
  } else if (one.deleted) {
    actions.append(button("되살리기", "linkbtn", () => {
      one.deleted = false;
      render();
    }));
  } else {
    actions.append(button("삭제", "linkbtn linkbtn--danger", () => {
      one.deleted = true;
      render();
    }));
  }
  li.append(actions);
  return li;
}

function addRow() {
  const name = el.newName.value.trim();
  if (!name) {
    toast("새 영역 이름을 입력해 주세요.", true);
    return;
  }
  if (draft.some((one) => !one.deleted && one.name.trim() === name)) {
    toast(`"${name}" 영역이 이미 있습니다.`, true);
    return;
  }
  draft.push({ code: nextAreaCode(draft), name, deleted: false, fresh: true });
  el.newName.value = "";
  render();
  el.newName.focus();
}

async function save(event) {
  event.preventDefault();
  if (pending) return;
  const value = JSON.parse(values());
  const empty = value.find((one) => !one.deleted && !one.name);
  if (empty) {
    toast("이름이 빈 영역이 있습니다.", true);
    return;
  }
  const removed = draft.filter((one) => one.deleted && !one.fresh && !obsAreas().find((a) => a.code === one.code)?.deleted);
  if (removed.length) {
    const yes = await confirmDialog({
      title: "영역을 지울까요?",
      message: `${removed.map((one) => one.name).join(", ")}\n` +
        "지운 영역은 새로 고를 수 없게 됩니다. 이미 그 영역인 관찰은 미지정으로 바뀌지 않고 \"예전 영역\"으로 남습니다.",
      confirmText: "지우고 저장",
    });
    if (!yes) return;
  }

  pending = true;
  el.save.disabled = true;
  try {
    const payload = await send("/api/settings/observation_areas", "PUT", { value });
    setObsAreas(payload.value ?? value);
    resetForm();
    toast("영역을 저장했습니다");
  } catch (error) {
    // 입력한 것은 그대로 둔다 — 고쳐서 다시 저장할 수 있게
    toast(error.message, true);
  } finally {
    pending = false;
    el.save.disabled = false;
  }
}

el.add.addEventListener("click", addRow);
el.newName.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.isComposing) return;
  event.preventDefault();
  addRow();
});
el.form.addEventListener("submit", save);
el.cancel.addEventListener("click", askClose);
