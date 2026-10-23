/**
 * 관찰 영역 — 관찰을 어느 칸에 묶나(건강·학습·…)
 *
 * 목록은 코드가 아니라 센터가 정하는 분류라 settings.observation_areas 에 산다(관리자만 고친다).
 * 모양 검사·이전 목록과의 비교·"지금 쓸 수 있는 영역" 판단을 이 한 곳에서 한다.
 *
 * [코드는 바뀌지 않는다]
 * observations.area·journal_observations.area·평가(content 의 키)가 영역을 코드로 물고 있다.
 * 처음 여섯 영역은 이름이 곧 코드다("건강" …) — 031 이전 기록이 그 글자로 저장돼 있다.
 * 새로 더하는 영역은 a01, a02 … 를 받는다. 이름은 고쳐도 코드는 그대로라 지난 기록이 따라온다.
 *
 * [지워도 목록에서 빼지 않는다]
 * 지운 영역은 deleted: true 로 남긴다. 그 영역의 지난 관찰은 미지정으로 떨어지지 않고
 * "예전 영역" 으로(회색) 보인다. 새로 고르는 칸에는 나오지 않는다. 반기 관찰 항목과 같은 방식.
 */
import { getSetting } from "../db/settings.ts";

export type ObsArea = {
  code: string;
  name: string;
  /** 지운 영역. 지난 기록이 물고 있어 목록에서 빼지 않는다. */
  deleted?: boolean;
};

export const OBS_AREAS_KEY = "observation_areas";

/** 처음 여섯 영역 — 이름이 곧 코드(001 의 CHECK 제약 목록) */
export const DEFAULT_AREA_CODES = ["건강", "학습", "또래관계", "행동정서", "보호자요구", "연계"];
export const DEFAULT_OBS_AREAS: ObsArea[] = DEFAULT_AREA_CODES.map((code) => ({
  code,
  name: code,
}));

const NEW_CODE_RE = /^a\d{2,3}$/;
const NAME_MAX = 20;
const LIST_MAX = 40;

/** 지우지 않은 영역. 새로 고르는 칸이 이것만 보여 준다. */
export function activeAreas(list: ObsArea[]): ObsArea[] {
  return list.filter((one) => !one.deleted);
}

/** 모양만 본다. 이전 목록과 견주는 일은 checkAreaEdit 이 한다. */
export function checkAreaList(value: unknown): string | null {
  if (!Array.isArray(value)) return "영역 목록이 배열이 아닙니다.";
  if (value.length === 0) return "영역이 하나도 없습니다.";
  if (value.length > LIST_MAX) return `영역은 ${LIST_MAX}개까지만 둘 수 있습니다.`;

  const codes = new Set<string>();
  const names = new Set<string>();
  let active = 0;
  for (const raw of value) {
    if (!raw || typeof raw !== "object") return "영역 모양이 올바르지 않습니다.";
    const one = raw as Record<string, unknown>;

    if (
      typeof one.code !== "string" ||
      !(DEFAULT_AREA_CODES.includes(one.code) || NEW_CODE_RE.test(one.code))
    ) {
      return `영역 코드가 올바르지 않습니다: ${String(one.code)}`;
    }
    if (codes.has(one.code)) return `같은 코드가 둘입니다: ${one.code}`;
    codes.add(one.code);

    if (typeof one.name !== "string" || !one.name.trim()) return `${one.code}: 이름이 비었습니다.`;
    if (one.name !== one.name.trim()) return `${one.code}: 이름 앞뒤에 빈칸이 있습니다.`;
    if (one.name.length > NAME_MAX) return `${one.code}: 이름은 ${NAME_MAX}자까지입니다.`;
    if (one.name === "미지정") return `"미지정" 은 영역 이름으로 쓸 수 없습니다.`;
    if (one.deleted !== undefined && typeof one.deleted !== "boolean") {
      return `${one.code}: 삭제 표시가 올바르지 않습니다.`;
    }

    if (!one.deleted) {
      active += 1;
      // 지금 쓰는 영역끼리 이름이 같으면 고르는 사람이 가를 수 없다
      if (names.has(one.name)) return `같은 이름의 영역이 둘입니다: ${one.name}`;
      names.add(one.name);
    }
  }
  if (active === 0) return "쓸 수 있는 영역이 하나는 있어야 합니다.";
  return null;
}

/**
 * 고친 목록이 이전 목록을 깨지 않는지 본다.
 *   - 있던 코드는 전부 남아 있어야 한다(지우는 것은 deleted: true 로)
 * 새 코드(a01 …)는 더할 수 있다.
 */
export function checkAreaEdit(before: ObsArea[], after: unknown): string | null {
  const shape = checkAreaList(after);
  if (shape) return shape;

  const next = new Set((after as ObsArea[]).map((one) => one.code));
  for (const old of before) {
    if (!next.has(old.code)) {
      return `${old.name}(${old.code}) 영역이 목록에서 빠졌습니다. 지운 영역도 목록에 남겨야 지난 관찰이 미지정으로 떨어지지 않습니다.`;
    }
  }
  return null;
}

/** 저장값을 읽는다. 없거나 모양이 틀리면 처음 여섯 영역. */
export function readAreas(value: unknown): ObsArea[] {
  return checkAreaList(value) === null ? value as ObsArea[] : DEFAULT_OBS_AREAS;
}

/** 새 영역에 붙일 코드. 지운 것까지 세어 그 다음 번호 — 옛 코드를 다시 쓰지 않는다. */
export function nextAreaCode(list: ObsArea[]): string {
  let top = 0;
  for (const one of list) {
    if (!NEW_CODE_RE.test(one.code)) continue;
    const n = Number(one.code.slice(1));
    if (n > top) top = n;
  }
  return `a${String(top + 1).padStart(2, "0")}`;
}

/** 지금 목록(settings) */
export async function currentAreas(): Promise<ObsArea[]> {
  return readAreas(await getSetting<unknown>(OBS_AREAS_KEY, DEFAULT_OBS_AREAS));
}

/** 새로 지정할 수 있는 영역 코드인가(지운 영역은 안 된다) */
export async function isAssignableArea(code: string): Promise<boolean> {
  return activeAreas(await currentAreas()).some((one) => one.code === code);
}
