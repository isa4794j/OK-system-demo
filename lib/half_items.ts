/**
 * 반기 관찰 항목 — 무엇을 몇 점으로 보나
 *
 * 목록은 코드가 아니라 센터가 정하는 평가지표라 settings.half_observation_items 에 산다.
 * 여기는 그 목록이 올바른 모양인지, 받은 점수가 쓸 만한지, 평균을 어떻게 내는지를 한 곳에서 정한다.
 *
 * [항목 코드는 바뀌지 않는다]
 * half_observations.scores 가 {"h01": 4} 처럼 코드로 점수를 물고 있다.
 * 코드가 바뀌거나 다른 문구에 다시 쓰이면 지난 점수가 다른 질문의 답이 된다 — 조용히 틀린다.
 * 그래서 항목을 지워도 목록에서 빼지 않고 deleted: true 로 남긴다.
 * 그 코드는 영영 그 항목의 것이다.
 *
 * [문구는 고칠 수 있다]
 * 오탈자나 표현을 다듬는 일은 흔하다. 다만 고친 문구는 지난 기록에도 그대로 보인다 —
 * 뜻이 바뀌는 수정이면 고치지 말고 지운 뒤 새로 더해야 한다. 편집 화면이 그렇게 알린다.
 *
 * [만점도 바꾸지 않는다]
 * 5점 만점이던 항목을 3점 만점으로 바꾸면 지난 4점, 5점이 뜻을 잃는다.
 */

/** 영역. 화면이 이 순서로 묶는다. */
export const HALF_AREAS = ["생활", "교육", "정서"] as const;
export type HalfArea = typeof HALF_AREAS[number];

export type HalfItem = {
  code: string;
  area: HalfArea;
  text: string;
  max: number;
  /** 지운 항목. 지난 점수가 물고 있어 목록에서 빼지 않는다. */
  deleted?: boolean;
};

const CODE_RE = /^h\d{2,3}$/;
const TEXT_MAX = 200;

/** 지우지 않은 항목. 새로 쓰는 화면이 이것만 보여 준다. */
export function activeItems(items: HalfItem[]): HalfItem[] {
  return items.filter((one) => !one.deleted);
}

/** 모양만 본다. 이전 목록과 견주는 일은 checkItemEdit 이 한다. */
export function checkItemList(value: unknown): string | null {
  if (!Array.isArray(value)) return "항목 목록이 배열이 아닙니다.";
  if (value.length > 100) return "항목은 100개까지만 둘 수 있습니다.";

  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object") return "항목 모양이 올바르지 않습니다.";
    const one = raw as Record<string, unknown>;

    if (typeof one.code !== "string" || !CODE_RE.test(one.code)) {
      return `항목 코드가 올바르지 않습니다: ${String(one.code)}`;
    }
    if (seen.has(one.code)) return `같은 코드가 둘입니다: ${one.code}`;
    seen.add(one.code);

    if (!HALF_AREAS.includes(one.area as HalfArea)) {
      return `${one.code}: 영역은 ${HALF_AREAS.join("·")} 중 하나여야 합니다.`;
    }
    if (typeof one.text !== "string" || !one.text.trim()) return `${one.code}: 문구가 비었습니다.`;
    if (one.text.length > TEXT_MAX) return `${one.code}: 문구는 ${TEXT_MAX}자까지입니다.`;
    if (!Number.isInteger(one.max) || (one.max as number) < 2 || (one.max as number) > 10) {
      return `${one.code}: 만점이 올바르지 않습니다.`;
    }
    if (one.deleted !== undefined && typeof one.deleted !== "boolean") {
      return `${one.code}: 삭제 표시가 올바르지 않습니다.`;
    }
  }
  return null;
}

/**
 * 고친 목록이 이전 목록을 깨지 않는지 본다.
 *
 *   - 있던 코드는 전부 남아 있어야 한다 (지우는 것은 deleted: true 로)
 *   - 있던 항목의 만점은 그대로여야 한다
 * 새 코드는 얼마든지 더할 수 있다.
 */
export function checkItemEdit(before: HalfItem[], after: HalfItem[]): string | null {
  const shape = checkItemList(after);
  if (shape) return shape;

  const next = new Map(after.map((one) => [one.code, one]));
  for (const old of before) {
    const now = next.get(old.code);
    if (!now) {
      return `${old.code} 항목이 목록에서 빠졌습니다. 지운 항목도 목록에 남겨야 지난 점수가 뜻을 잃지 않습니다.`;
    }
    if (now.max !== old.max) {
      return `${old.code}: 만점은 바꿀 수 없습니다(${old.max}점). 지난 점수의 뜻이 달라집니다.`;
    }
  }
  return null;
}

/** 새 항목에 붙일 코드. 지운 것까지 세어 그 다음 번호 — 옛 코드를 다시 쓰지 않는다. */
export function nextCode(items: HalfItem[]): string {
  let top = 0;
  for (const one of items) {
    const n = Number(one.code.slice(1));
    if (Number.isFinite(n) && n > top) top = n;
  }
  return `h${String(top + 1).padStart(2, "0")}`;
}

/**
 * 받은 점수를 거른다. 지우지 않은 항목 코드만, 1 부터 그 항목 만점까지의 정수만.
 *
 * 빈 칸은 허용한다 — 적다 만 것을 저장했다가 나중에 이어 쓰는 것이 실제 모습이다.
 * 틀린 값은 조용히 버리지 않고 거절한다. 화면이 잘못 보낸 것을 모르고 지나가면 안 된다.
 */
export function cleanScores(
  items: HalfItem[],
  raw: unknown,
): { scores: Record<string, number> } | { error: string } {
  if (raw === undefined || raw === null) return { scores: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "점수 모양이 올바르지 않습니다." };
  }

  const byCode = new Map(activeItems(items).map((one) => [one.code, one]));
  const scores: Record<string, number> = {};

  for (const [code, value] of Object.entries(raw as Record<string, unknown>)) {
    const item = byCode.get(code);
    if (!item) return { error: `없거나 지워진 항목입니다: ${code}` };
    if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > item.max) {
      return { error: `${code}: 점수는 1~${item.max} 사이의 정수여야 합니다.` };
    }
    scores[code] = value as number;
  }
  return { scores };
}

/**
 * 덮어쓸 때 지운 항목의 지난 점수는 살려 둔다.
 *
 * 화면은 지운 항목을 보여 주지 않으므로 그 점수를 다시 보내지 않는다.
 * 새 점수로 통째로 바꾸면 지운 항목의 지난 점수가 이 저장 한 번에 사라진다.
 */
export function keepDeletedScores(
  items: HalfItem[],
  before: Record<string, number> | null | undefined,
  next: Record<string, number>,
): Record<string, number> {
  const deleted = new Set(items.filter((one) => one.deleted).map((one) => one.code));
  const kept: Record<string, number> = {};
  for (const [code, value] of Object.entries(before ?? {})) {
    if (deleted.has(code)) kept[code] = value;
  }
  return { ...kept, ...next };
}

/** 항목이 전부 채워졌는가. "작성함" 과 "일부" 를 가르는 데만 쓴다 — 관문이 아니다. */
export function isComplete(items: HalfItem[], scores: Record<string, number> | null): boolean {
  const active = activeItems(items);
  if (active.length === 0) return false;
  return active.every((one) => typeof scores?.[one.code] === "number");
}

/**
 * 영역별 평균. 지우지 않은 항목만 센다.
 *
 * 지운 항목을 넣으면 같은 아이의 반기별 평균이 서로 다른 항목 묶음에서 나와
 * 견줄 수 없게 된다. 지운 항목의 점수는 항목별 표에서 따로 보인다.
 * 점수가 하나도 없는 영역은 null — 0 으로 두면 "아주 낮음" 으로 읽힌다.
 */
export function areaAverages(
  items: HalfItem[],
  scores: Record<string, number> | null,
): Record<HalfArea, number | null> {
  const out = {} as Record<HalfArea, number | null>;
  for (const area of HALF_AREAS) {
    const values = activeItems(items)
      .filter((one) => one.area === area)
      .map((one) => scores?.[one.code])
      .filter((value): value is number => typeof value === "number");
    out[area] = values.length
      ? Math.round((values.reduce((sum, v) => sum + v, 0) / values.length) * 10) / 10
      : null;
  }
  return out;
}

/** 설정에서 읽은 값을 항목 목록으로. 모양이 틀렸으면 빈 목록 — 화면이 서술 칸만 연다. */
export function readItems(value: unknown): HalfItem[] {
  return checkItemList(value) ? [] : value as HalfItem[];
}
