/**
 * 역할 거르기 칩 — [전체] [봉사자] [멘토] (폰 일정·일지 탭 공용)
 *
 * 모양은 [내 일지]/[전체 보기] 띠(.mseg)와 같다 — 칸만 셋.
 * 고른 값은 화면 안에만 둔다. 주소·스냅샷에 남기지 않는다(새로 열면 늘 [전체]).
 * 역할이 하나인 센터여도 그대로 둔다 — 조건을 나눠 숨기면 화면이 사람마다 달라진다.
 */

/** 거를 수 있는 역할. 서버(api/my.ts)와 같아야 한다. */
export const ROLE_CHOICES = ["봉사자", "멘토"];

export function mountRoleChips(box, onChange) {
  let value = "";
  box.replaceChildren();
  box.classList.add("mseg", "mseg--3");
  box.setAttribute("role", "group");
  box.setAttribute("aria-label", "역할 거르기");

  const choices = ["", ...ROLE_CHOICES];
  const buttons = choices.map((role) => {
    const node = document.createElement("button");
    node.type = "button";
    node.className = "mseg__item";
    node.textContent = role || "전체";
    node.addEventListener("click", () => {
      if (value === role) return;
      value = role;
      paint();
      onChange(value);
    });
    box.append(node);
    return node;
  });

  function paint() {
    buttons.forEach((node, i) => {
      const on = choices[i] === value;
      node.classList.toggle("is-on", on);
      node.setAttribute("aria-pressed", String(on));
    });
  }
  paint();
}

/** 이름 옆 역할 알약(작은 회색 태그). 역할을 모르면 아무것도 안 붙인다. */
export function rolePill(role) {
  if (!role) return null;
  const pill = document.createElement("span");
  pill.className = "mrolepill";
  pill.textContent = role;
  return pill;
}

/** 멘토 점은 네모 — PC 달력과 같은 약속(봉사자 ●, 멘토 ■) */
export function dotShape(role) {
  return role === "멘토" ? " mcal__dot--mentor" : "";
}
