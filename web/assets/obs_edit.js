/**
 * 관찰 손보기 — 합치기(드래그) · 나누기(인라인) · 수정
 *
 * 두 화면이 같은 동작을 한다.
 *   일지 카드의 "추출된 관찰"  → journal_observations (후보)
 *   아동 상세의 "날짜별 편집"   → observations (확정)
 * 대상 표만 다르고 사람이 하는 일은 같으므로, 화면 조각은 여기 한 벌만 둔다.
 * 각 화면은 "무엇끼리 합칠 수 있는가(key)"와 "저장은 어느 주소로"만 정한다.
 *
 * 합치기는 HTML5 드래그다. 자원사전과 같은 방식이고, 마우스가 있는 자리를 전제한다.
 * 터치에서는 동작하지 않는다 — 종사자가 책상에서 정리하는 화면이다.
 */
import { button, confirmDialog } from "./ui.js";

/* ---------- 합쳐질 내용 ---------- */

/**
 * 드롭 대상 내용 뒤에 끌어온 내용을 이어 붙인다.
 *
 * 줄바꿈으로 잇는다. 공백으로 이으면 두 관찰이 한 문장처럼 읽혀
 * 나중에 어디서 갈렸던 것인지 알아볼 수 없다.
 */
export function joinContent(keepText, fromText) {
  return `${String(keepText ?? "").trim()}\n${String(fromText ?? "").trim()}`.trim();
}

/**
 * 합치기 전에 묻는다. 저장될 내용을 그대로 미리 보여 준다.
 * "예"면 그 내용을, 아니면 null 을 돌려준다.
 *
 * notes 에는 화면마다 다른 경고를 넣는다(근거가 바뀐다 / 다시 가져올 수 있게 된다).
 */
export async function confirmMerge({ keepText, fromText, notes = [] }) {
  const content = joinContent(keepText, fromText);

  const yes = await confirmDialog({
    title: "두 관찰을 합칠까요?",
    message: [
      "내용이 아래처럼 이어 붙습니다.",
      "끌어온 관찰은 사라집니다. 되돌릴 수 없습니다.",
      ...notes,
    ].join("\n"),
    preview: content,
    confirmText: "합치기",
    // 지우는 일이긴 하지만 내용은 남는다. 삭제만큼 무겁게 칠하지 않는다.
    danger: false,
  });

  return yes ? content : null;
}

/* ---------- 끌어서 합치기 ---------- */

/**
 * 지금 끌고 있는 것. 한 번에 하나뿐이라 모듈이 들고 있는다.
 * { id, key } — key 가 같은 자리에만 놓을 수 있다.
 */
let dragging = null;

function clearDropMarks() {
  for (const node of document.querySelectorAll(".obsdrag--drop, .obsdrag--nodrop")) {
    node.classList.remove("obsdrag--drop", "obsdrag--nodrop");
  }
}

/**
 * 관찰 한 줄에 드래그를 붙인다.
 *
 *   id        이 관찰
 *   key       같은 무리인지 가르는 열쇠 (같은 아동·같은 날짜·같은 원본 일지)
 *   disabled  아직 저장 전(임시 id)이면 끌지 않는다
 *   onMerge   놓였을 때. 끌려온 쪽의 id 를 받는다.
 *
 * key 가 다른 자리에서는 preventDefault 를 하지 않는다.
 * 그러면 브라우저가 "놓을 수 없음" 커서를 띄운다. 테두리도 함께 흐리게 준다.
 */
export function attachMergeDrag(node, { id, key, disabled = false, onMerge }) {
  if (disabled) return;

  node.draggable = true;
  node.classList.add("obsdrag");
  node.title = "끌어서 같은 아동·같은 날짜의 다른 관찰 위에 놓으면 합칩니다";

  node.addEventListener("dragstart", (event) => {
    event.dataTransfer.setData("text/plain", id);
    event.dataTransfer.effectAllowed = "move";
    dragging = { id, key };
    node.classList.add("obsdrag--dragging");
  });

  node.addEventListener("dragend", () => {
    dragging = null;
    node.classList.remove("obsdrag--dragging");
    clearDropMarks();
  });

  node.addEventListener("dragover", (event) => {
    // 자기 자신 위에는 놓을 수 없다
    if (!dragging || dragging.id === id) return;

    if (dragging.key !== key) {
      node.classList.add("obsdrag--nodrop");
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    node.classList.add("obsdrag--drop");
  });

  node.addEventListener("dragleave", () => {
    node.classList.remove("obsdrag--drop", "obsdrag--nodrop");
  });

  node.addEventListener("drop", (event) => {
    event.preventDefault();
    clearDropMarks();
    const fromId = event.dataTransfer.getData("text/plain") || dragging?.id;
    if (!fromId || fromId === id) return;
    onMerge(fromId);
  });
}

/* ---------- 인라인 편집기 ---------- */

/** label 과 textarea 를 짝지어 만든다. id 는 창 안에서만 겹치지 않으면 된다. */
function labeledTextarea({ label: labelText, value, rows = 3, onInput }) {
  const field = document.createElement("div");
  field.className = "field";

  const id = `obsedit-${crypto.randomUUID()}`;

  const label = document.createElement("label");
  label.className = "field__label";
  label.textContent = labelText;
  label.htmlFor = id;

  const textarea = document.createElement("textarea");
  textarea.className = "input textarea";
  textarea.id = id;
  textarea.rows = rows;
  textarea.value = value ?? "";
  // 입력 중에는 다시 그리지 않는다. 다시 그리면 커서가 튄다.
  textarea.addEventListener("input", () => onInput(textarea.value));

  field.append(label, textarea);
  return { field, textarea };
}

/** 저장·취소 두 개. 순서와 색을 두 화면이 같이 쓴다. */
function editorActions(onSave, onCancel, saveLabel = "저장") {
  const actions = document.createElement("div");
  actions.className = "form__actions";
  actions.append(
    button(saveLabel, "btn btn--primary", onSave),
    button("취소", "btn", onCancel),
  );
  return actions;
}

/** 내용만 고치는 편집기. */
export function renderContentEditor({ value, onInput, onSave, onCancel }) {
  const wrap = document.createElement("div");

  const textarea = document.createElement("textarea");
  textarea.className = "input textarea";
  textarea.rows = 3;
  textarea.value = value ?? "";
  textarea.setAttribute("aria-label", "관찰 내용");
  textarea.addEventListener("input", () => onInput(textarea.value));

  wrap.append(textarea, editorActions(onSave, onCancel));
  queueMicrotask(() => textarea.focus());
  return wrap;
}

/**
 * 나누기 편집기. 관찰 바로 아래에 펼쳐진다.
 *
 *   위   원글 — 고칠 수 있다. 여기서 일부를 잘라
 *   아래 새 관찰 — 붙여 넣는다.
 *
 * extraField 는 화면마다 더 필요한 칸(아동 상세의 영역 고르기)을 받는 자리다.
 * 후보(journal_observations)에는 영역이 없으므로 넘기지 않는다.
 */
export function renderSplitEditor({
  hint,
  keepValue,
  newValue,
  onKeepInput,
  onNewInput,
  extraField = null,
  onSave,
  onCancel,
}) {
  const wrap = document.createElement("div");
  wrap.className = "form";

  const note = document.createElement("p");
  note.className = "form__hint";
  note.textContent = hint;

  const keep = labeledTextarea({
    label: "원글 (남길 부분)",
    value: keepValue,
    onInput: onKeepInput,
  });
  const fresh = labeledTextarea({
    label: "새 관찰 (떼어낼 부분)",
    value: newValue,
    onInput: onNewInput,
  });

  wrap.append(note, keep.field, fresh.field);
  if (extraField) wrap.append(extraField);
  wrap.append(editorActions(onSave, onCancel, "저장"));

  // 잘라 붙일 곳으로 바로 간다
  queueMicrotask(() => fresh.textarea.focus());
  return wrap;
}
