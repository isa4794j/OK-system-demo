/**
 * 탭 하나가 되풀이하는 일 — 스냅샷으로 먼저 그리고, 서버로 갈아 끼우기
 *
 * 세 탭(일정·일지·통계)이 똑같은 순서를 밟는다. 세 번 적으면 한 곳만 고치는 실수가 난다.
 *
 *   1. 담아 둔 것이 있으면 곧바로 그린다 (기다리는 시간 0)
 *   2. 없으면 그때만 "불러오는 중"
 *   3. 어느 쪽이든 서버에 묻고, 답이 오면 조용히 다시 그린다
 *   4. 받은 것을 담아 둔다 — 다음에 열 때 1번이 된다
 *
 * 서버가 실패해도 담아 둔 것이 있으면 그대로 둔다. 보이던 것이 사라지는 편이
 * 옛것을 보는 것보다 나쁘다 — 대신 "언제 받은 것" 인지 위에 적는다.
 */
import { get } from "./app.js";
import { read, whenText, write } from "./store.js";

/**
 * 이 화면을 담아 둘 것인가. name 이 없으면 안 담는다 —
 * 달력에서 지난달·다음달을 넘겨 볼 때가 그렇다. 그때그때 서버에서 받으면 되고,
 * 담아 두면 열쇠가 달마다 늘어나 폰의 저장 공간에 쌓이기만 한다.
 */
export async function loadView({ name, url, draw, stale, state }) {
  const saved = name ? read(name) : null;

  if (saved) {
    draw(saved.data);
    showStale(stale, saved);
  } else {
    state.textContent = "불러오는 중…";
    state.hidden = false;
    stale.hidden = true;
  }

  try {
    const fresh = await get(url);
    state.hidden = true;
    stale.hidden = true;
    draw(fresh);
    if (name) write(name, fresh);
  } catch (error) {
    if (saved) {
      // 보이던 것은 그대로 두고, 새로 못 받았다는 것만 위에 적는다.
      stale.textContent = `${whenText(saved.at)} 에 받은 화면입니다. 지금은 새로 받지 못했습니다.`;
      stale.hidden = false;
    } else {
      state.textContent = error.message;
      state.hidden = false;
    }
  }
}

/**
 * 무언가 쓰고 난 뒤. 서버에서 다시 받아 화면과 스냅샷을 함께 새로 한다.
 *
 * 화면만 고치고 스냅샷을 두면, 다음에 탭을 열 때 방금 쓴 것이 없는 옛 화면이
 * 잠깐 비쳤다가 바뀐다. 그 깜빡임이 "저장이 안 됐나" 로 읽힌다.
 */
export async function refreshView({ name, url, draw, stale, state }) {
  try {
    const fresh = await get(url);
    state.hidden = true;
    stale.hidden = true;
    draw(fresh);
    if (name) write(name, fresh);
  } catch (error) {
    state.textContent = error.message;
    state.hidden = false;
  }
}

/** 담아 둔 것이 오래됐으면 알린다. 막지는 않는다 — 보이는 것이 없는 것보다 낫다. */
function showStale(node, saved) {
  if (!saved.stale) {
    node.hidden = true;
    return;
  }
  node.textContent = `${whenText(saved.at)} 에 받은 화면입니다. 새로 받는 중…`;
  node.hidden = false;
}

/** "2026-09-10" → "9월 10일 (목)" */
export function dayLabel(date) {
  const when = new Date(`${date}T00:00:00`);
  const week = ["일", "월", "화", "수", "목", "금", "토"][when.getDay()];
  return `${when.getMonth() + 1}월 ${when.getDate()}일 (${week})`;
}

/** "15:00:00" → "15:00" */
export function timeLabel(time) {
  return String(time ?? "").slice(0, 5);
}

/** 이번 달의 첫날과 마지막 날 */
export function thisMonth() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const pad = (n) => String(n).padStart(2, "0");
  const last = new Date(year, month, 0).getDate();
  return {
    year,
    month,
    from: `${year}-${pad(month)}-01`,
    to: `${year}-${pad(month)}-${pad(last)}`,
  };
}
