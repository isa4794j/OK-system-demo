/**
 * 자원기록 검토 줄 — 일지 카드와 미분류함이 같이 쓴다
 *
 * 한 줄의 모양과 동작(수정·자원 아님·삭제·되돌리기)은 어디서 보든 같아야 한다.
 * 일지 안에서 검토하든 미분류함에서 검토하든 같은 판단이기 때문이다.
 * 그래서 줄을 그리는 코드는 여기 한 벌만 두고, 저장하는 일은 부르는 쪽이 넘긴다.
 *
 *   renderReviewRow(record, categories, { onPatch, onDelete })
 *     onPatch(record, patch)  → PATCH 를 보내고 화면을 갱신하는 일은 부르는 쪽
 *     onDelete(record)        → 확인창과 DELETE 는 부르는 쪽
 *
 * 이 파일은 서버를 부르지 않는다.
 */
import { button, fillOptions, toast } from "./ui.js";

/**
 * 지금 손보고 있는 줄. 한 번에 하나만 연다.
 *
 * 관찰 쪽(state.obsEditing)과 같은 방식이다. 목록과 편집기를 겹쳐 두지 않고,
 * 편집기가 그 줄 자리에 들어간다. 두 화면(일지 카드·미분류함)이 같이 쓰므로
 * 상태도 여기 한 벌만 둔다.
 *
 *   { id, name, category }  — 적던 값은 다시 그려도 남아야 한다
 */
let editing = null;

/** 다른 화면으로 넘어가거나 목록을 새로 읽을 때 부른다. */
export function closeRowEditor() {
  editing = null;
}

/**
 * 자원 한 줄. 관찰 카드와 같은 모양이다.
 *
 * 평소에는 읽기다 — 카테고리 배지와 자원 이름만 보인다.
 * 뽑히면 바로 통계에 잡히므로 굳이 누를 것이 없는 상태가 기본이다.
 * [수정] 을 누르면 그 자리가 이름·카테고리 편집으로 바뀌고, 저장하면 되돌아온다.
 *
 * "자원 아님" 으로 둔 줄만 고칠 수 없다 — 되돌리고 나서 고친다.
 *
 *   onRerender  줄을 다시 그려 달라는 신호. 편집기를 열고 닫을 때만 부른다.
 */
export function renderReviewRow(record, categories, { onPatch, onDelete, onRerender }) {
  const li = document.createElement("li");
  li.className = "extract__item resx__item";

  const tags = document.createElement("div");
  tags.className = "obs__tags";

  if (record.status === "없음") {
    const off = document.createElement("span");
    off.className = "tag tag--gone";
    off.textContent = "자원 아님";
    tags.append(off);
  } else {
    const category = document.createElement("span");
    // 카테고리가 비었다는 것은 "사람이 정해 줘야 끝난다"는 뜻이다.
    // 관찰의 [아동 확인 필요] 와 같은 종류라 같은 색을 쓴다.
    category.className = record.category ? "tag tag--area" : "tag tag--unset";
    category.textContent = record.category ?? "카테고리 미정";
    tags.append(category);
  }

  const name = document.createElement("p");
  name.className = "extract__content resx__name";
  if (record.status === "없음") name.classList.add("resx__name--off");
  // 자원명은 사용자·AI가 넣은 값이므로 textContent로만 넣는다
  name.textContent = record.resource_name;

  if (record.status === "없음") {
    li.append(tags, name, rowActions([
      button("되돌리기", "linkbtn", () => onPatch(record, { status: "Y" })),
    ]));
    return li;
  }

  if (editing?.id === record.id) {
    li.append(tags, renderRowEditor(record, categories, onPatch, onRerender));
    return li;
  }

  li.append(tags, name, rowActions([
    button("수정", "linkbtn", () => {
      editing = {
        id: record.id,
        name: record.resource_name,
        category: record.category ?? "",
      };
      onRerender?.();
    }),
    button("자원 아님", "linkbtn", () => onPatch(record, { status: "없음" })),
    button("삭제", "linkbtn linkbtn--danger", () => onDelete(record)),
  ]));
  return li;
}

/** 관찰 카드와 같은 자리·같은 톤의 버튼 줄 */
function rowActions(buttons) {
  const actions = document.createElement("div");
  actions.className = "obs__actions";
  actions.append(...buttons);
  return actions;
}

/**
 * 이름·카테고리를 그 자리에서 고친다.
 *
 * 적던 값을 editing 에 담아 두는 이유: 저장을 기다리는 동안 다른 일로 목록이
 * 다시 그려질 수 있다. 그때 칸이 빈 채로 되살아나면 적던 것이 사라진다.
 */
function renderRowEditor(record, categories, onPatch, onRerender) {
  const wrap = document.createElement("div");
  wrap.className = "resx__editor";

  const row = document.createElement("div");
  row.className = "resx__edit";

  const name = document.createElement("input");
  name.type = "text";
  name.className = "input resx__input";
  name.maxLength = 100;
  name.value = editing.name;
  name.setAttribute("aria-label", "자원명");
  name.addEventListener("input", () => {
    editing.name = name.value;
  });

  const category = document.createElement("select");
  category.className = "input resx__select";
  category.setAttribute("aria-label", "카테고리");

  // 지금 값이 카테고리 목록에 없을 수 있다. 그때도 값이 말없이 바뀌지 않게 넣어 준다.
  const options = [{ value: "", label: "카테고리 미정" }];
  const list = record.category && !categories.includes(record.category)
    ? [...categories, record.category]
    : categories;
  for (const value of list) options.push({ value, label: value });
  fillOptions(category, options);
  category.value = editing.category;
  category.addEventListener("change", () => {
    editing.category = category.value;
  });

  row.append(name, category);

  const actions = document.createElement("div");
  actions.className = "form__actions";
  actions.append(
    button("저장", "btn btn--small btn--primary", () => {
      const patch = {
        resource_name: editing.name.trim(),
        category: editing.category || null,
      };
      const problem = checkPatch(patch);
      if (problem) {
        toast(problem, true);
        return;
      }
      const same = patch.resource_name === record.resource_name &&
        patch.category === (record.category ?? null);
      editing = null;
      // 바뀐 것이 없으면 서버를 부르지 않는다. 닫히기만 하면 된다.
      if (same) onRerender?.();
      else onPatch(record, patch);
    }),
    button("취소", "btn btn--small", () => {
      editing = null;
      onRerender?.();
    }),
  );

  wrap.append(row, actions);
  queueMicrotask(() => name.focus());
  return wrap;
}

/**
 * 보내기 전에 화면에서 먼저 거른다. 서버도 같은 것을 다시 본다.
 * 문제가 있으면 그 이유를, 없으면 null 을 돌려준다.
 */
export function checkPatch(patch) {
  // 카테고리는 비워 둘 수 있다. 비면 "미분류" 로 남아 통계에 잡히고 미분류함에 뜬다.
  // 억지로 고르게 하면 아무 묶음에나 들어가 통계가 어긋난다.
  if (patch.resource_name !== undefined && !patch.resource_name) {
    return "자원명을 입력해 주세요.";
  }
  return null;
}

/** 저장 결과에 맞는 한 줄 알림. 사전이나 블랙리스트에 들어갔으면 그 사실도 적는다. */
export function patchMessage(patch, payload) {
  if (payload.added_to_dictionary) {
    return `저장했습니다 · 자원사전에 추가함: ${payload.added_to_dictionary}`;
  }
  if (patch.status === "Y") return "되돌렸습니다 · 다시 통계에 잡힙니다";
  if (patch.status === "없음") {
    return payload.blacklisted
      ? "자원이 아닌 것으로 표시했습니다 · 앞으로 뽑지 않습니다"
      : "자원이 아닌 것으로 표시했습니다";
  }
  // 상태를 안 건드린 것은 이름·카테고리를 고친 것이다
  return "저장했습니다";
}

/** 기록 삭제 확인창에 쓰는 글. 두 화면이 같은 말을 해야 한다. */
export function deleteRecordPrompt(record) {
  return {
    title: "이 자원 기록을 지울까요?",
    message: `${record.resource_name}\n다시 분석하면 또 올라올 수 있습니다. ` +
      `오추출이면 [자원 아님]으로 두는 편이 낫습니다.`,
    confirmText: "삭제",
  };
}
