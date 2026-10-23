/**
 * 생년월일 → 학년 계산
 *
 * 한국 학년도는 3월 1일에 바뀐다. 그래서 1~2월은 아직 이전 학년도로 친다.
 * 2009년부터 조기입학(1~2월생) 제도가 없어져, 같은 해에 태어난 아이는
 * 모두 같은 해 3월에 입학한다. 따라서 생년(출생 연도)만으로 계산할 수 있다.
 *
 * 기준: 출생연도 + 7년이 되는 해의 3월에 초등학교 1학년.
 *   예) 2019년생 → 2026년 3월에 초1
 *
 * 그래좋아 사회적협동조합의 대상은 초1~중2지만, 범위를 벗어난 값도 깨지지 않게
 * 미취학 / 고등 / 졸업까지 이름을 붙여둔다.
 */

/** 주어진 날짜가 속한 학년도(3월 시작). */
export function schoolYearOf(today = new Date()) {
  const month = today.getMonth() + 1; // 0-based 보정
  return month >= 3 ? today.getFullYear() : today.getFullYear() - 1;
}

/**
 * 학년을 숫자로 반환한다. 초1=1 ... 초6=6, 중1=7 ... 중3=9, 고1=10 ... 고3=12
 * 취학 전이면 0 이하, 생년월일을 모르면 null.
 */
export function gradeNumber(birthDate, today = new Date()) {
  if (!birthDate) return null;
  const birthYear = Number(String(birthDate).slice(0, 4));
  if (!Number.isFinite(birthYear) || birthYear < 1900) return null;
  return schoolYearOf(today) - birthYear - 6;
}

/**
 * 아동 명단 순서 — 학년 오름차순, 같은 학년 안 가나다, 생년월일 모름은 맨 뒤.
 * 학년 = 출생 연도로 정해지므로 출생 연도 내림차순과 같다. 서버 lib/child_order.ts 와 같은 규칙.
 */
const collator = new Intl.Collator("ko");
function birthYearOf(birthDate) {
  const year = Number(String(birthDate ?? "").slice(0, 4));
  return birthDate && Number.isFinite(year) && year >= 1900 ? year : null;
}
export function compareChildren(a, b) {
  const ya = birthYearOf(a.birth_date);
  const yb = birthYearOf(b.birth_date);
  if (ya !== yb) {
    if (ya === null) return 1;
    if (yb === null) return -1;
    return yb - ya;
  }
  return collator.compare(String(a.name ?? ""), String(b.name ?? ""));
}

/** 화면에 표시할 학년 문자열. 예: "초3", "중1", "미취학", "-" */
export function gradeLabel(birthDate, today = new Date()) {
  const grade = gradeNumber(birthDate, today);
  if (grade === null) return "-";
  if (grade < 1) return "미취학";
  if (grade <= 6) return `초${grade}`;
  if (grade <= 9) return `중${grade - 6}`;
  if (grade <= 12) return `고${grade - 9}`;
  return "졸업";
}
