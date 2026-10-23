/**
 * 가명화 눈으로 보기
 *
 *   deno task demo:anon
 *
 * 합격/불합격만 보는 건 lib/anonymize.test.ts 가 한다.
 * 여기서는 실제로 어떻게 바뀌는지를 사람이 읽을 수 있게 찍는다.
 * 개인정보를 다루는 부분이라 눈으로도 한 번 보고 넘어가려는 것.
 */
import { assertNoLeak, hide, type RegisteredPerson, show } from "./anonymize.ts";

const PEOPLE: RegisteredPerson[] = [
  { id: "c1", name: "테스원", kind: "child" },
  { id: "c2", name: "테스투", kind: "child" },
  { id: "c3", name: "김하늘", kind: "child" },
  { id: "s1", name: "김멘토", kind: "staff", role: "멘토" },
  { id: "s2", name: "이복지", kind: "staff", role: "종사자" },
  { id: "s3", name: "박봉사", kind: "staff", role: "봉사자" },
];

const SAMPLES = [
  "테스원이 왔다",
  "테스투가 웃었다",
  "테스원은 조용했고 테스투는 늦었다",
  "테스원을 불렀더니 테스투를 데려왔다",
  "테스원과 테스투와 김하늘이 함께 앉았다",
  "테스원에게 물었더니 테스투의 가방이라고 했다",
  "김하늘이 테스원으로 정했다",
  "테스원이랑 테스투랑 셋이 놀았다",
  "김멘토가 테스원과 이복지에게 말했다",
  "박봉사는 테스투를 도왔고 이복지가 기록했다",
  "테스원이 왔다. 테스원은 앉았고, 테스원을 도왔다.",
  "테스원, 테스투, 김하늘이 모두 참여했다",
  "테스원은행에 갔다",
  "등록되지 않은 이름은 그대로 남는다",
];

/** 동명이인은 따로 본다 — 명단이 달라야 하므로 */
const TWINS: RegisteredPerson[] = [
  { id: "t1", name: "김철수", kind: "child", grade: 3 },
  { id: "t2", name: "김철수", kind: "child", grade: 5 },
  { id: "t3", name: "이영희", kind: "child" },
];

function line(char = "─") {
  console.log(char.repeat(72));
}

function runRoundTrip(texts: string[], people: RegisteredPerson[]) {
  let failed = 0;

  for (const text of texts) {
    const result = hide(text, people);
    const restored = show(result.masked, result.map);
    const roundTripOk = restored === text;
    const safe = result.leaks.length === 0;
    if (!roundTripOk || !safe) failed += 1;

    console.log(`${roundTripOk && safe ? "✓" : "✗"} 원문   ${text}`);
    console.log(`  가림   ${result.masked}`);
    console.log(`  복원   ${restored}`);
    if (!safe) console.log(`  ⚠ 실명이 남았습니다: ${result.leaks.join(", ")}`);
    if (!roundTripOk) console.log(`  ⚠ 왕복이 원문과 다릅니다`);
    console.log("");
  }

  return failed;
}

function main(): number {
  line("═");
  console.log("가명화 — 종사자 일지에 흔히 나오는 문장으로 확인");
  line("═");

  console.log("\n[등록된 사람과 코드]");
  const codes = hide("", PEOPLE).map;
  for (const entry of codes.entries) {
    console.log(`  ${entry.code.padEnd(8)} ← ${entry.name}  (${entry.role ?? entry.kind})`);
  }
  console.log("");
  line();
  console.log("");

  let failed = runRoundTrip(SAMPLES, PEOPLE);

  line();
  console.log("\n[동명이인] 같은 이름은 코드 하나로 묶는다\n");

  const twinResult = hide("김철수가 이영희와 놀았다", TWINS);
  console.log(`  원문   김철수가 이영희와 놀았다`);
  console.log(`  가림   ${twinResult.masked}`);
  console.log(`  복원   ${show(twinResult.masked, twinResult.map)}`);

  const twin = twinResult.map.entries.find((entry) => entry.ambiguous);
  if (twin) {
    console.log(
      `\n  ⚠ "${twin.name}" 는 ${twin.people.length}명이 같은 이름을 씁니다 (${
        twin.people.join(", ")
      }).`,
    );
    console.log(`    글자만으로는 누구인지 가릴 수 없어 토큰 하나(${twin.code})로 묶었습니다.`);
    console.log(`    괄호로 학년이 적혀 있으면(김철수(초5)) 거기서 갈립니다.`);
    console.log(`    AI 응답을 사람에게 보여줄 때 이 점을 알려야 합니다.`);
  }

  console.log("");
  line();
  console.log("\n[안전망] assertNoLeak — 실명이 남으면 던진다\n");

  try {
    assertNoLeak({ masked: "테스원이 왔다", leaks: ["테스원"] });
    console.log("  ✗ 던지지 않았습니다 (안전망이 동작하지 않음)");
    failed += 1;
  } catch (error) {
    console.log(`  ✓ ${(error as Error).message}`);
  }

  console.log("");
  line("═");
  if (failed === 0) {
    console.log(`전부 통과 — 예문 ${SAMPLES.length}개, 왕복·안전망 이상 없음`);
  } else {
    console.log(`${failed}건 실패`);
  }
  line("═");

  return failed === 0 ? 0 : 1;
}

if (import.meta.main) {
  Deno.exit(main());
}
