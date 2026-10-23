/**
 * 입력 날짜의 허용 범위 — 등록·수정할 때만 본다(이미 들어 있는 기록을 읽는 데는 쓰지 않는다).
 *
 * 1차 전수 점검(2026-09-17)에서 생일 2999년·일지 2999년이 그대로 저장됐다. 범위는 센터가 정했다.
 *   아동 생년월일   2000-01-01 ~ 오늘
 *   입소일         ~ 오늘 + 1년
 *   종사자 일지     ~ 오늘 + 1년(프로그램·일상·회의록 — 계획을 미리 적는 일이 있다)
 *   봉사일지       ~ 오늘(활동한 뒤에 쓴다 — PC·폰 둘 다)
 *
 * "오늘" 은 서울 날짜다. 서버(Deploy)는 UTC 라 그냥 new Date() 를 쓰면 아침 9시 전에 하루가 어긋난다.
 */

/** 서울 기준 오늘 "YYYY-MM-DD" */
export function todayInSeoul(now = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

/** "YYYY-MM-DD" 에 해를 더한다. 2월 29일은 다음 해 2월 28일로. */
export function addYears(date: string, years: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const target = y + years;
  const last = new Date(Date.UTC(target, m, 0)).getUTCDate();
  return `${target}-${String(m).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

export const CHILD_BIRTH_MIN = "2000-01-01";

export const FUTURE_VOLUNTEER_JOURNAL = "아직 진행하지 않은 봉사예요 — 활동 후에 작성해 주세요.";

/** 아동 생년월일. 문제가 있으면 사람이 읽을 말, 없으면 null. */
export function checkChildBirth(value: string, today = todayInSeoul()): string | null {
  if (value < CHILD_BIRTH_MIN) return "생년월일은 2000년 1월 1일 이후여야 합니다.";
  if (value > today) return "생년월일은 오늘보다 뒤일 수 없습니다.";
  return null;
}

/** 입소일 — 1년 뒤까지는 받는다(입소 예정) */
export function checkEnrollDate(value: string, today = todayInSeoul()): string | null {
  return value > addYears(today, 1) ? "입소일은 오늘부터 1년 뒤까지만 넣을 수 있습니다." : null;
}

/** 일지 날짜 — 봉사일지는 오늘까지, 종사자 일지는 1년 뒤까지 */
export function checkJournalDate(
  kind: string,
  value: string,
  today = todayInSeoul(),
): string | null {
  if (kind === "봉사") return value > today ? FUTURE_VOLUNTEER_JOURNAL : null;
  return value > addYears(today, 1) ? "일지 날짜는 오늘부터 1년 뒤까지만 넣을 수 있습니다." : null;
}
