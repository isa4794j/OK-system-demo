/**
 * 되돌릴 수 없는 일 앞에서 쓰는 창 두 가지
 *
 *   chooseDialog   — 갈림길. "삭제 말고 종결로" 같은 다른 길을 삭제 옆에 나란히 둔다.
 *   typeToConfirm  — 이름을 직접 쳐야 버튼이 켜진다. 실수로 누르는 일을 막는다.
 *
 * ui.js 의 confirmDialog 는 예/아니오 하나뿐이라 여기 따로 둔다.
 * 공통 컴포넌트는 건드리지 않고, 같은 .modal 스타일만 빌려 쓴다.
 * 창은 처음 쓸 때 한 번 만들고 다시 쓴다.
 */

let parts = null;

function build() {
  if (parts) return parts;

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

  const target = document.createElement("p");
  target.className = "confirm__target";

  const message = document.createElement("p");
  message.className = "confirm__message";

  const field = document.createElement("div");
  field.className = "field";
  field.hidden = true;

  const label = document.createElement("label");
  label.className = "field__label";
  label.htmlFor = "danger-input";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "input";
  input.id = "danger-input";
  input.autocomplete = "off";

  field.append(label, input);

  const actions = document.createElement("div");
  actions.className = "modal__actions modal__actions--wrap modal__actions--end";

  dialog.append(title, target, message, field, actions);
  modal.append(backdrop, dialog);
  document.body.append(modal);

  parts = { modal, backdrop, title, target, message, field, label, input, actions };
  return parts;
}

/** 첫 줄은 대상, 나머지는 경고. ui.js 의 확인창과 같은 규칙. */
function setMessage(p, message) {
  const lines = String(message ?? "").split("\n");
  const target = lines.length > 1 ? lines[0].trim() : "";
  const warn = (lines.length > 1 ? lines.slice(1).join("\n") : lines[0]).trim();
  p.target.textContent = target;
  p.target.hidden = !target;
  p.message.textContent = warn;
  p.message.hidden = !warn;
}

/** 열고, 닫힐 때 값을 돌려주는 공통 뼈대. 바깥 클릭과 Esc 는 "취소"다. */
function open(setup) {
  const p = build();
  p.actions.replaceChildren();
  p.field.hidden = true;
  p.label.textContent = "";
  p.input.value = "";

  return new Promise((resolve) => {
    let cleanup = () => {};
    const close = (value) => {
      p.modal.hidden = true;
      cleanup();
      resolve(value);
    };
    const onCancel = () => close(null);
    const onKey = (event) => {
      if (event.key === "Escape") close(null);
    };

    p.backdrop.addEventListener("click", onCancel);
    document.addEventListener("keydown", onKey);
    cleanup = () => {
      p.backdrop.removeEventListener("click", onCancel);
      document.removeEventListener("keydown", onKey);
    };

    setup(p, close);
    p.modal.hidden = false;
  });
}

function makeButton(label, className, onClick) {
  const node = document.createElement("button");
  node.type = "button";
  node.className = className;
  node.textContent = label;
  node.addEventListener("click", onClick);
  return node;
}

/**
 * 갈림길 창.
 *
 *   choices: [{ label, value, kind }]  kind: "danger" | "primary" | 없음
 * 고른 value 를 돌려준다. 취소·바깥 클릭·Esc 면 null.
 * 취소 버튼은 늘 마지막에 자동으로 붙는다.
 */
export function chooseDialog({ title, message, choices }) {
  return open((p, close) => {
    p.title.textContent = title;
    setMessage(p, message);

    // 취소가 맨 왼쪽. 그다음 다른 길(종결로 변경 등), 되돌릴 수 없는 것은 맨 오른쪽.
    const cancel = makeButton("취소", "btn", () => close(null));
    p.actions.append(cancel);

    let first = null;
    for (const choice of choices) {
      const className = choice.kind === "danger"
        ? "btn btn--danger"
        : choice.kind === "primary"
        ? "btn btn--primary"
        : "btn";
      const node = makeButton(choice.label, className, () => close(choice.value));
      p.actions.append(node);
      // 처음에 초점을 둘 것은 위험하지 않은 첫 버튼이다
      if (!first && choice.kind !== "danger") first = node;
    }
    (first ?? cancel).focus();
  });
}

/**
 * 이름을 쳐야 열리는 창.
 *
 * expected 와 정확히 같아야(앞뒤 공백만 무시) 삭제 버튼이 켜진다.
 * Enter 로도 진행되지만, 켜져 있을 때만이다.
 * true 면 진행, false 면 취소.
 */
export function typeToConfirm({ title, message, expected, confirmText = "삭제" }) {
  return open((p, close) => {
    p.title.textContent = title;
    setMessage(p, message);
    p.label.textContent = `확인을 위해 "${expected}" 을 그대로 입력하세요`;
    p.field.hidden = false;

    const go = makeButton(confirmText, "btn btn--danger", () => close(true));
    go.disabled = true;
    const cancel = makeButton("취소", "btn", () => close(false));
    p.actions.append(cancel, go);

    const sync = () => {
      go.disabled = p.input.value.trim() !== expected;
    };
    p.input.addEventListener("input", sync);
    p.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !go.disabled) close(true);
    });
    p.input.focus();
  }).then((value) => value === true);
}
