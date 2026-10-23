/**
 * 폰에서 값을 받는 자리 — 아래에서 올라오는 시트
 *
 * 폰에서는 화면 가운데 뜨는 모달이 키보드에 반쯤 가린다.
 * 아래에서 올라와 화면을 채우면 키보드가 올라와도 적는 칸이 위에 남는다.
 *
 * [폰에서 지키는 것]
 * 입력칸 글자는 16px 이상이다 — 그보다 작으면 iOS 가 탭할 때 화면을 확대하고
 * 확대된 채로 남는다. 누르는 것은 44px 이상.
 *
 * 확인창(지울까요?)은 PC 와 같은 규칙이라 ui.js 의 confirmDialog 를 그대로 쓴다.
 * 지우는 일에 한 번 묻는 것(원칙 7)은 화면이 달라도 같다.
 *
 * [두 가지 모양]
 *   openForm  칸 목록을 주면 알아서 그린다. 대부분이 이쪽이다.
 *   openBody  안쪽을 직접 만들어 넣는다. 날짜 여러 줄처럼 모양이 있는 것.
 * 시트를 여닫는 일(겹침 방지·Esc·바깥 탭)은 아래 sheet() 한 곳에만 있다.
 */

let openSheet = null;

/**
 * 시트 제목 아래 작은 태그(겸직자만). "멘토로 기록됩니다" —
 * 멘토로 들어와 봉사일지를 쓰는 실수를 적는 순간에 한 번 더 보게 한다.
 * 역할이 하나인 사람은 null 이라 아무것도 안 나온다. app.js 가 맞춰 준다.
 */
let roleTag = null;

export function setRoleTag(text) {
  roleTag = text;
}

/** 열려 있는 시트를 닫는다. 값은 버린다. */
export function closeSheet() {
  openSheet?.(null);
}

/**
 * 시트 하나. 안쪽을 채우는 일과 값을 읽는 일만 밖에서 받는다.
 *
 * 새 시트를 열기 전에 열려 있던 것을 닫는다 — 폰에서 시트 둘이 겹치면
 * 뒤엣것이 앞엣것을 가리고, 취소를 눌러도 아래에 하나가 더 남는다.
 */
function sheet({ title, submitText, fill, read, validate, tall = false }) {
  closeSheet();

  const modal = document.createElement("div");
  modal.className = "msheet";

  const backdrop = document.createElement("div");
  backdrop.className = "msheet__backdrop";

  const panel = document.createElement("form");
  // 긴 것(반기 관찰 15항목)은 화면을 다 채운다. 반쯤 올라온 시트 안에서
  // 열다섯 줄을 굴리면 어디까지 적었는지 가늠이 안 된다.
  panel.className = tall ? "msheet__panel msheet__panel--tall" : "msheet__panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");

  const head = document.createElement("h2");
  head.className = "msheet__title";
  head.textContent = title;
  panel.append(head);

  if (roleTag) {
    const tag = document.createElement("p");
    tag.className = "msheet__role";
    tag.textContent = roleTag;
    panel.append(tag);
  }

  const error = document.createElement("p");
  error.className = "msheet__error";
  error.hidden = true;
  panel.append(error);

  fill(panel);

  const actions = document.createElement("div");
  actions.className = "msheet__actions";

  const save = document.createElement("button");
  save.type = "submit";
  save.className = "mbtn mbtn--primary";
  save.textContent = submitText;

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "mbtn";
  cancel.textContent = "취소";

  actions.append(cancel, save);
  panel.append(actions);

  modal.append(backdrop, panel);
  document.body.append(modal);

  return new Promise((resolve) => {
    const close = (value) => {
      if (openSheet !== close) return;
      openSheet = null;
      modal.remove();
      document.removeEventListener("keydown", onKey);
      resolve(value);
    };
    openSheet = close;

    function onKey(event) {
      if (event.key === "Escape") close(null);
    }

    panel.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = read();
      const problem = validate?.(value);
      if (problem) {
        error.textContent = problem;
        error.hidden = false;
        error.scrollIntoView({ block: "nearest" });
        return;
      }
      close(value);
    });

    cancel.addEventListener("click", () => close(null));
    backdrop.addEventListener("click", () => close(null));
    document.addEventListener("keydown", onKey);
  });
}

/**
 * 칸 목록을 받아 시트를 연다.
 *
 *   fields  [{ name, label, type, value, hint, ... }]
 *   notice  칸들 위에 붙일 안내 한 줄(없으면 안 붙는다)
 *   돌려주는 값: { name: value } 또는 취소하면 null
 */
export function openForm({ title, fields, submitText = "저장", onValidate, notice }) {
  const inputs = new Map();

  return sheet({
    title,
    submitText,
    validate: onValidate,
    fill: (panel) => {
      if (notice) {
        const note = document.createElement("p");
        note.className = "mnotice";
        note.textContent = notice;
        panel.append(note);
      }
      for (const field of fields) {
        const box = document.createElement("label");
        box.className = "mfield";

        const label = document.createElement("span");
        label.className = "mfield__label";
        label.textContent = field.label;
        box.append(label);

        const node = field.type === "textarea"
          ? document.createElement("textarea")
          : document.createElement("input");

        node.className = "mfield__input";
        if (field.type === "textarea") node.rows = field.rows ?? 6;
        else node.type = field.type ?? "text";
        if (field.value !== undefined && field.value !== null) node.value = field.value;
        if (field.max) node.maxLength = field.max;
        if (field.placeholder) node.placeholder = field.placeholder;
        if (field.readonly) node.readOnly = true;
        if (field.min) node.min = field.min;
        if (field.list) {
          // 고를 수 있는 날짜를 붙여 준다. 막지는 않는다 — 막는 것은 서버다.
          const datalist = document.createElement("datalist");
          datalist.id = `mlist-${field.name}`;
          for (const one of field.list) {
            const option = document.createElement("option");
            option.value = one;
            datalist.append(option);
          }
          node.setAttribute("list", datalist.id);
          box.append(datalist);
        }

        box.append(node);

        if (field.hint) {
          const hint = document.createElement("span");
          hint.className = "mfield__hint";
          hint.textContent = field.hint;
          box.append(hint);
        }

        inputs.set(field.name, node);
        panel.append(box);
      }

      // 첫 칸에 바로 커서를 둔다. 읽기 전용 칸은 건너뛴다.
      const first = fields.find((one) => !one.readonly);
      if (first) inputs.get(first.name)?.focus();
    },
    read: () => {
      const out = {};
      for (const [name, node] of inputs) out[name] = node.value.trim();
      return out;
    },
  });
}

/**
 * 안쪽을 직접 만들어 넣는 시트.
 *
 *   build(panel)  안쪽을 채운다
 *   read()        [저장] 을 누를 때 값을 만든다
 */
export function openBody({ title, submitText = "저장", build, read, onValidate, tall = false }) {
  return sheet({ title, submitText, fill: build, read, validate: onValidate, tall });
}

/** 오늘 날짜 "YYYY-MM-DD" (한국 시각) */
export function today() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}
