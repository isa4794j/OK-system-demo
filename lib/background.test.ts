import { assertEquals } from "@std/assert";
import { drainBeforeExit, pendingLabels, runAfterResponse } from "./background.ts";

/** 콘솔 출력을 잠시 모은다 */
async function capture(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...args: unknown[]) => lines.push(`log ${args.join(" ")}`);
  console.warn = (...args: unknown[]) => lines.push(`warn ${args.join(" ")}`);
  console.error = (...args: unknown[]) => lines.push(`error ${args[0]}`);
  try {
    await run();
  } finally {
    Object.assign(console, saved);
  }
  return lines;
}

Deno.test("응답 뒤 일은 기다리지 않고 돌고, 끝나면 목록에서 빠진다", async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => release = resolve);
  const lines = await capture(async () => {
    runAfterResponse("시험 A", () => gate);
    assertEquals(pendingLabels(), ["시험 A"]);
    release();
    await drainBeforeExit(1000);
  });
  assertEquals(pendingLabels(), []);
  assertEquals(lines.some((line) => line.includes("완료 시험 A")), true);
});

Deno.test("실패는 던지지 않고 서버 로그에 남긴다", async () => {
  const lines = await capture(async () => {
    runAfterResponse("시험 B", () => Promise.reject(new Error("AI 고장")));
    await drainBeforeExit(1000);
  });
  assertEquals(
    lines.some((line) => line.startsWith("error") && line.includes("실패 시험 B")),
    true,
  );
});

Deno.test("종료 신호 때 끝나지 않은 일은 이름을 남긴다", async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => release = resolve);
  const lines = await capture(async () => {
    runAfterResponse("시험 C", () => gate);
    await drainBeforeExit(20);
  });
  assertEquals(
    lines.some((line) => line.includes("끝내지 못하고 종료") && line.includes("시험 C")),
    true,
  );
  release();
  await drainBeforeExit(1000);
});
