/**
 * 명단 [더 보기] — 아동·종사자·봉사자 명단이 같이 쓴다
 *
 * 명단은 서버에서 한 번에 받고(검색·칩 거르기가 화면에서 돈다) 그리기만 10명씩 나눈다.
 * 거르는 조건이 바뀌면 reset() 으로 처음 10명부터 다시 보인다.
 *
 * [더 보기] 는 목록을 다시 그리지 않고 새 줄만 밑에 붙인다 — 통째로 다시 그리면 그 순간 목록이 비어
 * 화면이 맨 위로 튕기는 기기가 있다(2026-09-18 사용자 보고). 누른 위치(굴린 자리)도 그대로 붙잡아 둔다.
 */

export const ROSTER_STEP = 10;

/**
 * 이름 앞 순번 "1." — 지금 보이는 목록(정렬·칩·검색을 거친 뒤) 안의 차례. [더 보기] 로 이어져도 번호가 이어진다.
 * 숫자는 읽는 소리에서 빼지 않는다(몇 번째인지 화면 읽기에도 쓸모 있다).
 */
export function rosterNumber(n) {
  const span = document.createElement("span");
  span.className = "roster__no";
  span.textContent = `${n}.`;
  return span;
}

/**
 * @param {Element} anchor 버튼을 이 요소 바로 뒤에 둔다(명단 카드 안의 상태 칸)
 * @param {(rows: unknown[], start: number) => Element | null | void} append
 *   더 보기로 새로 보일 줄들(rows)과 그 첫 줄의 순번-1(start)을 받아 밑에 붙인다.
 *   포커스를 옮길 요소를 돌려주면(버튼이 사라질 때) 그리로 옮긴다.
 */
export function rosterPager(anchor, append) {
  let shown = ROSTER_STEP;
  /** 마지막으로 take 한 목록(거르고 정렬한 것) — 더 보기가 이어 붙일 원본 */
  let lastRows = [];
  const more = document.createElement("button");
  more.type = "button";
  more.className = "btn roster__more";
  more.hidden = true;

  function sync() {
    const left = lastRows.length - shown;
    more.hidden = left <= 0;
    more.textContent = `더 보기 (${Math.max(left, 0)}명 남음)`;
  }

  more.addEventListener("click", () => {
    const scroller = more.closest(".main") ?? document.scrollingElement;
    const top = scroller?.scrollTop ?? 0;
    const start = shown;
    shown += ROSTER_STEP;
    const next = append(lastRows.slice(start, shown), start);
    sync();
    // 붙이는 동안 위치가 바뀌었으면 누른 자리로 되돌린다
    if (scroller && scroller.scrollTop !== top) scroller.scrollTop = top;
    if (more.hidden) next?.focus?.({ preventScroll: true });
  });
  anchor.after(more);

  return {
    reset() {
      shown = ROSTER_STEP;
    },
    hide() {
      more.hidden = true;
    },
    /** 이번에 그릴 줄만 돌려주고, 남은 수로 버튼을 맞춘다 */
    take(rows) {
      lastRows = rows;
      sync();
      return rows.slice(0, shown);
    },
  };
}
