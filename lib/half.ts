/**
 * 반기 — 언제가 몇 반기인지, 그 반기가 열려 있는지
 *
 * 1~6월이 상반기, 7~12월이 하반기다. observations 조회와 같은 기준이다.
 *
 * [왜 열고 닫나]
 * 반기가 끝나면 그 반기 관찰은 더 쓰지 않는 것이 맞다. 그런데 자동으로 닫으면
 * 12월 31일에 적다 만 사람이 1월 1일에 못 쓰게 된다. 언제 닫을지는 센터가 안다.
 * 그래서 사람이 누른다 — settings.half_observation_open 에 반기별로 담긴다.
 *
 * 값 모양: { "2026-1": false, "2026-2": true }
 * 적혀 있지 않은 반기는 "이번 반기면 열림, 아니면 닫힘" 으로 본다.
 * 설정을 한 번도 안 건드린 센터에서도 지금 반기는 쓸 수 있어야 한다.
 */

export type Half = 1 | 2;
export type HalfOpenMap = Record<string, boolean>;

/** "2026-2" — 설정에 담기는 열쇠 모양 */
export function halfKey(year: number, half: Half): string {
  return `${year}-${half}`;
}

/** 오늘이 몇 년 몇 반기인지 (한국 시각) */
export function currentHalf(now: Date = new Date()): { year: number; half: Half } {
  const seoul = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
  return { year: seoul.getFullYear(), half: seoul.getMonth() + 1 <= 6 ? 1 : 2 };
}

/**
 * 이 반기가 열려 있는가.
 *
 * 설정에 적힌 값이 이긴다. 없으면 이번 반기만 열린 것으로 본다 —
 * 기본값이 "전부 열림" 이면 지난 기록을 아무 때나 고치게 되고,
 * "전부 닫힘" 이면 설정을 켜기 전까지 아무도 못 쓴다.
 */
export function isHalfOpen(
  map: HalfOpenMap | null | undefined,
  year: number,
  half: Half,
  now: Date = new Date(),
): boolean {
  const saved = map?.[halfKey(year, half)];
  if (typeof saved === "boolean") return saved;

  const nowHalf = currentHalf(now);
  return year === nowHalf.year && half === nowHalf.half;
}

/** 화면에 적는 말. "2026년 하반기" */
export function halfText(year: number, half: Half): string {
  return `${year}년 ${half === 1 ? "상" : "하"}반기`;
}

/**
 * 화면에 늘어놓을 반기들. 올해 상·하반기 둘.
 *
 * 지난해까지 늘어놓지 않는 이유: 폰 목록이 길어지기만 하고,
 * 닫힌 지 오래된 반기를 봉사자가 다시 열 일이 없다.
 */
export function halvesOf(year: number): Array<{ year: number; half: Half }> {
  return [{ year, half: 1 }, { year, half: 2 }];
}

/** 설정 값이 이 모양인지 본다. 아무 것이나 담기면 화면이 뜻 없는 값을 읽는다. */
export function isHalfOpenMap(value: unknown): value is HalfOpenMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  for (const [key, one] of Object.entries(value)) {
    if (!/^\d{4}-[12]$/.test(key)) return false;
    if (typeof one !== "boolean") return false;
  }
  return true;
}
