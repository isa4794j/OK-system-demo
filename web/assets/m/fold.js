/**
 * 일지 본문 접기 — 넓은 화면 4줄, 좁은 화면·폰 2줄까지 보이고 [더 보기 ▾] 로 펼친다 (PC 일지 4종·폰 일지 공용)
 *
 * 줄 수는 CSS(.fold 의 --fold-lines)가 정한다. 글이 그보다 짧으면 버튼을 숨긴다 —
 * 넘치는지는 그려 본 뒤에야 알 수 있어 크기가 바뀔 때마다 잰다.
 * 펼침은 이 카드 안에만 있다. 목록을 새로 그리면 다시 접힌다.
 *
 * @param {HTMLElement} body 본문 요소(이미 글이 들어 있는 것)
 * @param {string} buttonClass 화면 쪽 링크 버튼 모양(PC linkbtn · 폰 mlink)
 * @returns {HTMLButtonElement} 본문 바로 뒤에 붙일 토글
 */
export function foldBody(body, buttonClass) {
  body.classList.add("fold", "is-folded");

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = `${buttonClass} fold__toggle`;
  toggle.hidden = true;
  toggle.setAttribute("aria-expanded", "false");
  toggle.textContent = "더 보기 ▾";
  toggle.addEventListener("click", () => {
    const open = body.classList.toggle("is-folded") === false;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.textContent = open ? "접기 ▴" : "더 보기 ▾";
  });

  const measure = () => {
    if (!body.classList.contains("is-folded")) return; // 펼친 뒤에는 버튼을 그대로 둔다(접을 수 있게)
    toggle.hidden = body.scrollHeight <= body.clientHeight + 1;
  };
  if (typeof ResizeObserver === "function") new ResizeObserver(measure).observe(body);
  else requestAnimationFrame(measure);

  return toggle;
}
