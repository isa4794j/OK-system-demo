/**
 * AI로 보낼 때 가려야 할 사람 명단을 한 벌로 모은다.
 *
 * 관찰 추출·자원 추출·연간평가가 저마다 같은 명단을 만들고 있었다.
 * 한 곳에서만 빠뜨려도 그 경로로만 실명이 새므로 한 벌로 합친다.
 *
 * Supabase는 부르지 않는다. /db 함수만 쓴다.
 * 이름은 여기서 나가지 않는다 — 이 값은 lib/anonymize.ts 로만 가고,
 * 거기서 토큰으로 바뀐 뒤에야 AI 쪽으로 넘어간다.
 */
import { listChildren } from "../db/children.ts";
import { listStaff } from "../db/staff.ts";
import type { RegisteredPerson } from "./anonymize.ts";

/**
 * 생년월일 → 학년 숫자. 초1=1 … 초6=6, 중1=7 … 중3=9, 고1=10 … 고3=12.
 *
 * 한국 학년도는 3월 1일에 바뀐다. 그래서 1~2월은 아직 이전 학년도로 친다.
 * 2009년부터 조기입학이 없어져 같은 해에 태어난 아이는 모두 같은 해 3월에 들어간다.
 * 따라서 출생 연도만으로 셀 수 있다.
 *
 * 화면 쪽 web/assets/grade.js 와 같은 규칙이다. 한쪽을 고치면 다른 쪽도 고쳐야 한다.
 * (브라우저는 /lib 를 읽지 못해 한 파일로 합칠 수 없다)
 */
export function gradeNumber(birthDate: string | null, today = new Date()): number | null {
  if (!birthDate) return null;
  const birthYear = Number(String(birthDate).slice(0, 4));
  if (!Number.isFinite(birthYear) || birthYear < 1900) return null;

  const month = today.getMonth() + 1;
  const schoolYear = month >= 3 ? today.getFullYear() : today.getFullYear() - 1;
  return schoolYear - birthYear - 6;
}

/**
 * 오늘 기준으로 다니고 있는가.
 *
 * 종결로 바꿔 두었어도 종결일이 아직 안 왔으면 다니는 아이다.
 * 종결일이 없는 옛 자료는 종결로 본다.
 * 화면 쪽 web/assets/children.js 의 classify() 와 같은 규칙이다.
 */
function isEnrolled(child: { status: string; exit_date: string | null }, today: string): boolean {
  if (child.status !== "종결") return true;
  if (!child.exit_date) return false;
  return child.exit_date > today;
}

/**
 * 가려야 할 사람을 모두 읽는다.
 *
 * 종결·종료된 사람도 뺄 수 없다. 옛 일지에 이름이 남아 있고, 그 이름도 가려야 한다.
 * 아동에는 학년과 재원 여부를 함께 담는다 —
 * 학년은 "윤0원(중1)"처럼 같은 표기를 쓰는 사람이 둘일 때 갈라내는 데,
 * 재원 여부는 이름이 통째로 가려진 표기("00이가")의 후보를 고르는 데 쓴다.
 */
export async function listPeopleToMask(): Promise<RegisteredPerson[]> {
  const [children, staff] = await Promise.all([listChildren(), listStaff(null, null)]);
  const today = new Date().toISOString().slice(0, 10);

  return [
    ...children.map((child) => ({
      id: child.id,
      name: child.name,
      kind: "child" as const,
      grade: gradeNumber(child.birth_date),
      enrolled: isEnrolled(child, today),
    })),
    ...staff.map((person) => ({
      id: person.id,
      name: person.name,
      kind: "staff" as const,
      role: person.role ?? undefined,
    })),
  ];
}
