/**
 * 역할 거르기 버튼 줄 — [전체] [봉사자] [멘토]
 *
 * 봉사일지 목록과 스케줄 달력이 같이 쓴다(겸직 2단계). 고른 값은 화면 안에만 둔다 —
 * 주소나 저장값에 남기지 않는다(새로 열면 늘 [전체]).
 *
 *   const filter = mountRoleFilter(box, { suffix: "만", onChange: (role) => ... });
 *   filter.value   // "" | "봉사자" | "멘토"
 */

/** 거를 수 있는 역할. 서버(api/journals.ts FILTER_ROLES)와 같아야 한다. */
export const FILTER_ROLES = ["봉사자", "멘토"];

/** 이 역할이면 점을 네모로 — 달력·통계에서 멘토를 봉사자와 가른다(사람 색은 그대로). */
export function roleDotClass(role) {
  return role === "멘토" ? " personchip__dot--mentor" : "";
}

export function mountRoleFilter(box, { suffix = "", label = "역할", onChange }) {
  let value = "";
  box.replaceChildren();
  box.classList.add("rolefilter");
  box.setAttribute("role", "group");
  box.setAttribute("aria-label", `${label} 거르기`);

  const choices = [{ value: "", text: "전체" }, ...FILTER_ROLES.map((role) => ({
    value: role,
    text: `${role}${suffix}`,
  }))];

  const buttons = choices.map((choice) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "rolefilter__btn";
    btn.textContent = choice.text;
    btn.addEventListener("click", () => {
      if (value === choice.value) return;
      set(choice.value);
      onChange(value);
    });
    box.append(btn);
    return btn;
  });

  function set(next) {
    value = next;
    buttons.forEach((btn, i) => btn.setAttribute("aria-pressed", String(choices[i].value === value)));
  }
  set("");

  return {
    get value() {
      return value;
    },
    /** 값만 바꾼다(onChange 는 안 부른다) */
    set,
  };
}
