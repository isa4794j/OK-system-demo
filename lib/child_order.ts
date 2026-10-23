/**
 * 아동 명단 순서 — 학년 오름차순(초1 → 초6 → 중1 …), 같은 학년 안에서 이름 가나다.
 *
 * 학년은 출생 연도만으로 정해진다(lib/roster.ts gradeNumber — 같은 해에 태어난 아이는 같은 학년).
 * 그래서 "학년 오름차순" = "출생 연도 내림차순" 이고, 오늘 날짜와 상관없이 순서가 같다.
 * 학년 글자("초1", "중2")로 정렬하지 않는다 — 글자 순서는 학년 순서가 아니다.
 * 생년월일을 모르면(학년 "-") 맨 뒤에 이름순.
 *
 * 화면 쪽 web/assets/grade.js 의 compareChildren 과 같은 규칙이다. 한쪽을 고치면 다른 쪽도.
 * (브라우저는 /lib 를 읽지 못한다)
 */

const collator = new Intl.Collator("ko");

function birthYear(birthDate: string | null | undefined): number | null {
  if (!birthDate) return null;
  const year = Number(String(birthDate).slice(0, 4));
  return Number.isFinite(year) && year >= 1900 ? year : null;
}

type Orderable = { name: string; birth_date?: string | null };

export function compareChildren(a: Orderable, b: Orderable): number {
  const ya = birthYear(a.birth_date);
  const yb = birthYear(b.birth_date);
  if (ya !== yb) {
    if (ya === null) return 1;
    if (yb === null) return -1;
    return yb - ya; // 늦게 태어난 아이 = 낮은 학년이 먼저
  }
  return collator.compare(String(a.name ?? ""), String(b.name ?? ""));
}

/** 새 배열로 정렬해 돌려준다 */
export function sortChildren<T extends Orderable>(rows: T[]): T[] {
  return [...rows].sort(compareChildren);
}
