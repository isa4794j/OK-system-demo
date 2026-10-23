/**
 * AI 문이 열리는지, 가명화가 강제되는지 눈으로 확인한다.
 *
 *   deno task demo:ai
 *
 * 실제로 Claude에 요청을 보내므로 요금이 든다. 짧은 요청 세 번이다.
 * 키가 없으면 무엇을 어떻게 채워야 하는지 알려주고 조용히 끝난다.
 */
import { assertNoLeak, hide, type RegisteredPerson } from "./anonymize.ts";
import { callAI, callAISafe, MODEL } from "./ai.ts";

const PEOPLE: RegisteredPerson[] = [
  { id: "c1", name: "테스원", kind: "child" },
  { id: "c2", name: "테스투", kind: "child" },
  { id: "s1", name: "이복지", kind: "staff", role: "종사자" },
];

function line(char = "─") {
  console.log(char.repeat(72));
}

/** 키가 없으면 여기서 친절히 끝낸다. 실패로 치지 않는다. */
function hasKey(): boolean {
  if (Deno.env.get("ANTHROPIC_API_KEY")?.trim()) return true;

  console.log("");
  line("═");
  console.log("ANTHROPIC_API_KEY 가 없어 AI 호출을 건너뜁니다.");
  line("═");
  console.log("");
  console.log("  1) https://console.anthropic.com 에서 API 키를 만듭니다");
  console.log("  2) .env 에 아래 한 줄을 넣습니다");
  console.log("");
  console.log("       ANTHROPIC_API_KEY=sk-ant-...");
  console.log("");
  console.log("  3) 다시 실행합니다:  deno task demo:ai");
  console.log("");
  console.log("키 없이도 확인할 수 있는 것은 아래에서 계속합니다.");
  console.log("");
  return false;
}

/** 키가 없어도 되는 검사 — 가명화가 실제로 문을 막는지 */
function checkGateWithoutNetwork(): number {
  let failed = 0;

  line();
  console.log("\n[1] 가명화가 AI 호출을 막는지 (네트워크 없이)\n");

  // 정상: 등록된 이름은 모두 코드로 바뀐다
  const clean = hide("테스원이 이복지에게 물었다", PEOPLE);
  console.log(`  원문   테스원이 이복지에게 물었다`);
  console.log(`  전송   ${clean.masked}`);
  if (clean.leaks.length === 0) {
    console.log(`  ✓ 실명이 남지 않았습니다 — 이대로 나갑니다`);
  } else {
    console.log(`  ✗ 실명이 남았습니다: ${clean.leaks.join(", ")}`);
    failed += 1;
  }

  // 비정상: 실명이 남은 상태를 억지로 만들면 문이 닫혀야 한다
  console.log("");
  try {
    assertNoLeak({ masked: "테스원이 왔다", leaks: ["테스원"] });
    console.log(`  ✗ 실명이 남았는데도 통과했습니다 (문이 열려 있음)`);
    failed += 1;
  } catch (error) {
    console.log(`  ✓ 실명이 남으면 호출 전에 막힙니다`);
    console.log(`    → ${(error as Error).message}`);
  }

  console.log("");
  return failed;
}

/** 문 1 — 사람 이름이 없는 글 */
async function checkPlainCall(): Promise<number> {
  line();
  console.log("\n[2] callAI — 사람 이름이 없는 글 (가명화 없이)\n");

  const prompt = "다음 문장을 한 문장으로 요약해줘: " +
    "오늘 오후 프로그램에서 색종이가 부족해 급히 문구점에서 더 사 왔고, " +
    "덕분에 활동은 예정대로 마쳤지만 다음 회차에는 재료를 미리 세어 두기로 했다.";

  console.log(`  보냄   ${prompt.slice(0, 40)}…`);
  try {
    const answer = await callAI(prompt, { maxTokens: 300 });
    console.log(`  받음   ${answer}`);
    console.log(`  ✓ 응답이 돌아왔습니다`);
    console.log("");
    return 0;
  } catch (error) {
    console.log(`  ✗ ${(error as Error).message}`);
    console.log("");
    return 1;
  }
}

/** 문 2 — 사람 이름이 든 글. 코드로 나가고 실명으로 돌아와야 한다 */
async function checkSafeCall(): Promise<number> {
  line();
  console.log("\n[3] callAISafe — 이름이 든 글 (가명화 강제)\n");

  const prompt = "다음 기록을 한 문장으로 요약해줘. " +
    "등장하는 사람은 그대로 두고 써줘.\n\n" +
    "테스원이 오늘 활동에 늦게 왔지만 끝까지 참여했다. " +
    "이복지가 테스원에게 이유를 물었더니 준비물을 찾느라 늦었다고 했다. " +
    "테스투는 테스원을 기다려 주었다.";

  console.log(`  원문   테스원이 오늘 활동에 늦게 왔지만 … 이복지가 … 테스투는 …`);

  try {
    const result = await callAISafe(prompt, PEOPLE, { maxTokens: 300 });

    console.log("");
    console.log(`  나간 글 (실명 없음)`);
    console.log(`    ${result.masked.replace(/\n/g, "\n    ")}`);
    console.log("");
    console.log(`  AI 응답 (코드 상태)`);
    console.log(`    ${result.maskedReply}`);
    console.log("");
    console.log(`  복원한 응답`);
    console.log(`    ${result.text}`);
    console.log("");

    let failed = 0;

    // 나간 글에 실명이 없어야 한다
    const leakedNames = PEOPLE.map((p) => p.name).filter((n) => result.masked.includes(n));
    if (leakedNames.length === 0) {
      console.log(`  ✓ 실명이 나가지 않았습니다`);
    } else {
      console.log(`  ✗ 실명이 나갔습니다: ${leakedNames.join(", ")}`);
      failed += 1;
    }

    // 코드가 실제로 나갔어야 한다
    const sentCodes = ["아동1", "아동2", "종사자1"].filter((c) => result.masked.includes(c));
    console.log(
      sentCodes.length > 0
        ? `  ✓ 코드로 바뀌어 나갔습니다: ${sentCodes.join(", ")}`
        : `  ✗ 코드가 보이지 않습니다`,
    );
    if (sentCodes.length === 0) failed += 1;

    // 응답의 코드가 실명으로 돌아왔어야 한다
    const restored = PEOPLE.map((p) => p.name).filter((n) => result.text.includes(n));
    const codeLeftOver = ["아동1", "아동2", "종사자1"].filter((c) => result.text.includes(c));

    if (restored.length > 0) {
      console.log(`  ✓ 실명으로 되돌아왔습니다: ${restored.join(", ")}`);
    } else if (codeLeftOver.length > 0) {
      console.log(`  ✗ 코드가 그대로 남았습니다: ${codeLeftOver.join(", ")}`);
      failed += 1;
    } else {
      // AI가 사람을 아예 언급하지 않은 요약을 쓸 수도 있다. 실패는 아니다.
      console.log(`  · 응답에 사람이 등장하지 않아 복원할 것이 없었습니다`);
    }

    console.log("");
    return failed;
  } catch (error) {
    console.log(`  ✗ ${(error as Error).message}`);
    console.log("");
    return 1;
  }
}

async function main(): Promise<number> {
  line("═");
  console.log(`AI 게이트웨이 확인 — 모델 ${MODEL}`);
  line("═");

  let failed = checkGateWithoutNetwork();

  if (!hasKey()) {
    line("═");
    console.log(
      failed === 0
        ? "가명화 문은 정상입니다. 키를 넣으면 실제 호출까지 확인합니다."
        : `${failed}건 실패`,
    );
    line("═");
    return failed === 0 ? 0 : 1;
  }

  failed += await checkPlainCall();
  failed += await checkSafeCall();

  line("═");
  console.log(failed === 0 ? "전부 통과" : `${failed}건 실패`);
  line("═");
  return failed === 0 ? 0 : 1;
}

if (import.meta.main) {
  Deno.exit(await main());
}
