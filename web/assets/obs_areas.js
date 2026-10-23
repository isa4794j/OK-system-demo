/**
 * 관찰 영역 목록 — 화면들이 함께 쓰는 한 벌(서버 규칙은 lib/obs_areas.ts)
 *
 * 목록은 settings.observation_areas 에서 한 번 받아 나눠 쓴다. 받기 전·못 받으면 처음 여섯 영역.
 *   code    기록이 물고 있는 값(처음 여섯은 이름 그대로, 새로 더한 것은 a01 …) — 바뀌지 않는다
 *   name    보이는 이름 — 관리자가 고칠 수 있다
 *   deleted 지운 영역 — 새로 고르는 칸에는 없고, 지난 기록에는 "예전 영역"(회색)으로 보인다
 */
import { get } from "./ui.js";

const DEFAULT_CODES = ["건강", "학습", "또래관계", "행동정서", "보호자요구", "연계"];

let list = DEFAULT_CODES.map((code) => ({ code, name: code }));
let loading = null;
const listeners = new Set();

/** 목록을 받는다(한 번만). force 면 다시 받는다. */
export function loadObsAreas(force = false) {
  if (!loading || force) {
    loading = get("/api/settings/observation_areas")
      .then((payload) => {
        if (Array.isArray(payload?.value) && payload.value.length) setObsAreas(payload.value);
        return list;
      })
      .catch(() => list);
  }
  return loading;
}

/** 저장한 뒤 바로 반영(다시 받지 않고) */
export function setObsAreas(next) {
  list = next.map((one) => ({ ...one }));
  for (const run of listeners) run(list);
}

/** 목록이 바뀌면 부른다 — 고르는 칸·영역 칸을 다시 그리는 데 쓴다 */
export function onObsAreasChange(run) {
  listeners.add(run);
}

export function obsAreas() {
  return list;
}

export function activeObsAreas() {
  return list.filter((one) => !one.deleted);
}

/** 목록에 있는 코드인가(지운 것 포함) */
export function isKnownArea(code) {
  return !!code && list.some((one) => one.code === code);
}

/** 지금 고를 수 있는 코드인가(지운 것 제외) */
export function isActiveArea(code) {
  return !!code && list.some((one) => one.code === code && !one.deleted);
}

export function isOldArea(code) {
  return !!code && list.some((one) => one.code === code && one.deleted);
}

/** 보이는 이름. 모르는 코드면 코드 그대로 */
export function areaName(code) {
  return list.find((one) => one.code === code)?.name ?? code;
}

/** 새 영역 코드 — 지운 것까지 세어 다음 번호(서버 nextAreaCode 와 같은 규칙) */
export function nextAreaCode(items) {
  let top = 0;
  for (const one of items) {
    const m = /^a(\d{2,3})$/.exec(one.code);
    if (m && Number(m[1]) > top) top = Number(m[1]);
  }
  return `a${String(top + 1).padStart(2, "0")}`;
}
