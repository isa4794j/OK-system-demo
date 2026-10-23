import { assertEquals } from "@std/assert";
import { SWEEP, SWEEP_CRON_NAME, sweepUnanalyzed } from "./analysis_sweep.ts";

const NOW = Date.parse("2026-09-16T12:00:00Z");

function fake(
  candidates: Array<{ id: string; observations_analyzed: boolean; resources_analyzed: boolean }>,
) {
  const calls: string[] = [];
  const logs: string[] = [];
  let asked: { since: string; until: string; limit: number } | null = null;
  return {
    calls,
    logs,
    asked: () => asked,
    deps: {
      list: (since: string, until: string, limit: number) => {
        asked = { since, until, limit };
        return Promise.resolve(candidates);
      },
      observe: (id: string) => {
        calls.push(`obs ${id}`);
        return id === "bad" ? Promise.reject(new Error("AI 고장")) : Promise.resolve();
      },
      resources: (id: string) => {
        calls.push(`res ${id}`);
        return Promise.resolve();
      },
      now: () => NOW,
      // 시험에서는 앞에서부터 고른다
      pick: <T>(items: T[], count: number) => items.slice(0, count),
      log: (line: string) => logs.push(line),
    },
  };
}

Deno.test("cron 이름은 Deno.cron 이 받는 모양이다(영문·숫자·공백·하이픈·밑줄)", () => {
  assertEquals(/^[A-Za-z0-9\s_-]+$/.test(SWEEP_CRON_NAME), true);
});

Deno.test("쓴 지 10분 지난 것 ~ 2일 안의 것만 묻는다", async () => {
  const f = fake([]);
  const result = await sweepUnanalyzed(f.deps);
  assertEquals(result, { candidates: 0, done: [], failed: [] });
  assertEquals(f.asked(), {
    since: new Date(NOW - SWEEP.maxAgeMs).toISOString(),
    until: new Date(NOW - 10 * 60 * 1000).toISOString(),
    limit: 20,
  });
  // 후보가 없으면 AI 도 로그도 없다
  assertEquals(f.calls, []);
  assertEquals(f.logs, []);
});

Deno.test("한 번에 2건, 덜 된 쪽만 부른다", async () => {
  const f = fake([
    { id: "a", observations_analyzed: false, resources_analyzed: false },
    { id: "b", observations_analyzed: true, resources_analyzed: false },
    { id: "c", observations_analyzed: false, resources_analyzed: false },
  ]);
  const result = await sweepUnanalyzed(f.deps);
  assertEquals(f.calls, ["obs a", "res a", "res b"]);
  assertEquals(result.done, ["a", "b"]);
  assertEquals(f.logs, ["[cron] 미분석 봉사일지 — 후보 3건 중 완료 2건"]);
});

Deno.test("한 건이 실패해도 다음 건은 하고, 실패는 로그에 남긴다", async () => {
  const f = fake([
    { id: "bad", observations_analyzed: false, resources_analyzed: false },
    { id: "ok", observations_analyzed: false, resources_analyzed: true },
  ]);
  const result = await sweepUnanalyzed(f.deps);
  assertEquals(result.failed, ["bad"]);
  assertEquals(result.done, ["ok"]);
  assertEquals(f.calls, ["obs bad", "obs ok"]);
  assertEquals(f.logs.some((line) => line.includes("분석 실패 bad")), true);
  assertEquals(f.logs.at(-1), "[cron] 미분석 봉사일지 — 후보 2건 중 완료 1건 · 실패 1건");
});

Deno.test("안전망 갈래 — Deploy 운영=cron, 미리보기·브랜치=끔, 컨테이너=interval(켰을 때만), 로컬=끔", async () => {
  const { sweepMode } = await import("./analysis_sweep.ts");
  const env = (o: Record<string, string>) => ({ get: (k: string) => o[k] });
  assertEquals(sweepMode(env({ DENO_DEPLOY: "true", DENO_TIMELINE: "production" })), "deploy-cron");
  assertEquals(sweepMode(env({ DENO_DEPLOY: "true" })), "deploy-cron");
  assertEquals(sweepMode(env({ DENO_DEPLOY: "true", DENO_TIMELINE: "preview/abc" })), "off");
  assertEquals(
    sweepMode(env({ DENO_DEPLOY: "true", DENO_TIMELINE: "git-branch/azure-migration" })),
    "off",
  );
  assertEquals(sweepMode(env({ ANALYSIS_SWEEP: "interval" })), "interval");
  // Deploy 에 잘못 넣어도 cron 한 갈래만
  assertEquals(sweepMode(env({ DENO_DEPLOY: "true", ANALYSIS_SWEEP: "interval" })), "deploy-cron");
  assertEquals(sweepMode(env({})), "off");
  assertEquals(sweepMode(env({ ANALYSIS_SWEEP: "yes" })), "off");
});

Deno.test("안전망 interval — 겹치지 않고, 실패해도 멈추지 않는다", async () => {
  const { startIntervalSweep } = await import("./analysis_sweep.ts");
  const lines: string[] = [];
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => release = r);
  const handle = startIntervalSweep(
    async () => {
      calls += 1;
      if (calls === 1) await gate;
      if (calls === 2) throw new Error("boom");
    },
    60_000,
    (line) => lines.push(line),
  );
  try {
    const first = handle.tick();
    await handle.tick(); // 첫 바퀴가 도는 중 — 건너뜀
    assertEquals(calls, 1);
    release();
    await first;
    await handle.tick(); // 실패
    await handle.tick(); // 그래도 다음 바퀴는 돈다
    assertEquals(calls, 3);
    assertEquals(lines.some((l) => l.includes("건너뜀")), true);
    assertEquals(lines.some((l) => l.includes("실패")), true);
  } finally {
    handle.stop();
  }
});
