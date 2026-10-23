/**
 * 미분석 봉사일지 안전망 — 10분마다 서버가 스스로 돈다(Deno.cron, main.ts)
 *
 * [왜]
 * 폰에서 쓴 봉사일지는 저장 응답 뒤에 서버가 분석한다(lib/background.ts).
 * Deno Deploy 는 그 뒤 작업을 끝까지 지켜 주지 않는다 — 조용하면 앱이 꺼지고 분석이 끊길 수 있다.
 * 사람이 PC 에서 [일괄 분석]을 눌러 주기 전까지 그 일지는 "미분석" 으로 남는다.
 * 그 틈을 서버가 스스로 메운다.
 *
 * [무엇을 도나]
 *   - 봉사일지 중 관찰이나 자원 분석이 덜 된 것
 *   - 쓴 지 10분이 지난 것만 — 방금 쓴 것은 뒤 작업이 아직 돌고 있을 수 있다(겹치면 AI 를 두 번 부른다)
 *   - 쓴 지 2일 안의 것만 — 오래 실패하는 일지를 끝없이 다시 부르지 않는다.
 *     그보다 오래된 것은 PC [일괄 분석]의 몫이다(사람이 보고 누른다)
 *   - 한 번에 2건 — AI 호출은 크레딧이다. 10분에 2건이면 하루 288건까지 받아 준다
 *
 * [한 건이 계속 실패할 때]
 * 늘 가장 오래된 2건만 고르면, 계속 실패하는 일지가 자리를 막아 뒤의 일지가 영영 밀린다.
 * 그래서 오래된 순으로 후보를 넉넉히(20건) 받아 그중 2건을 무작위로 고른다.
 *
 * 결과는 모두 서버 로그에 남는다(대상 수·처리·실패). 조용히 삼키지 않는다.
 */
import { listUnanalyzedVolunteerJournals } from "../db/journals.ts";
import { extractObservations } from "./extract_observations.ts";
import { extractResources } from "./extract_resources.ts";

/**
 * Deno.cron 이름. 영문·숫자·공백·하이픈·밑줄만 된다 — 한글이면 등록 순간 예외가 나고
 * Deploy 에서는 앱이 뜨지 못한다(실제로 한 번 배포가 막혔다). 테스트가 모양을 지킨다.
 */
export const SWEEP_CRON_NAME = "volunteer-journal-analysis-sweep";

export const SWEEP = {
  /** 쓴 지 이만큼 지난 것만 */
  minAgeMs: 10 * 60 * 1000,
  /** 쓴 지 이만큼 안의 것만 */
  maxAgeMs: 2 * 24 * 60 * 60 * 1000,
  /** 후보로 받아 볼 수 */
  candidates: 20,
  /** 한 번에 처리할 수 */
  perRun: 2,
};

type Candidate = { id: string; observations_analyzed: boolean; resources_analyzed: boolean };

export type SweepDeps = {
  list: (since: string, until: string, limit: number) => Promise<Candidate[]>;
  observe: (id: string) => Promise<unknown>;
  resources: (id: string) => Promise<unknown>;
  now: () => number;
  pick: <T>(items: T[], count: number) => T[];
  log: (line: string, error?: unknown) => void;
};

/** 무작위로 count 개 */
export function pickRandom<T>(items: T[], count: number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, count);
}

const DEFAULTS: SweepDeps = {
  list: listUnanalyzedVolunteerJournals,
  observe: extractObservations,
  resources: extractResources,
  now: () => Date.now(),
  pick: pickRandom,
  log: (line, error) => error === undefined ? console.log(line) : console.error(line, error),
};

export type SweepResult = { candidates: number; done: string[]; failed: string[] };

/** 한 번 돈다. 덜 된 쪽(관찰·자원)만 부른다. 한 건이 실패해도 다음 건은 한다. */
export async function sweepUnanalyzed(overrides: Partial<SweepDeps> = {}): Promise<SweepResult> {
  const deps = { ...DEFAULTS, ...overrides };
  const now = deps.now();
  const since = new Date(now - SWEEP.maxAgeMs).toISOString();
  const until = new Date(now - SWEEP.minAgeMs).toISOString();

  const candidates = await deps.list(since, until, SWEEP.candidates);
  const result: SweepResult = { candidates: candidates.length, done: [], failed: [] };
  if (candidates.length === 0) return result;

  for (const one of deps.pick(candidates, SWEEP.perRun)) {
    try {
      if (!one.observations_analyzed) await deps.observe(one.id);
      if (!one.resources_analyzed) await deps.resources(one.id);
      result.done.push(one.id);
    } catch (error) {
      result.failed.push(one.id);
      deps.log(`[cron] 미분석 봉사일지 분석 실패 ${one.id}`, error);
    }
  }

  deps.log(
    `[cron] 미분석 봉사일지 — 후보 ${result.candidates}건 중 완료 ${result.done.length}건` +
      (result.failed.length ? ` · 실패 ${result.failed.length}건` : ""),
  );
  return result;
}

/* ---------- 어디서 돌리나 (애저 이전) ---------- */

/** 10분 — Deno.cron 식 "*\/10 * * * *" 과 같은 간격 */
export const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

export type SweepMode = "deploy-cron" | "interval" | "off";

/**
 * 안전망을 어떤 방식으로 돌릴지.
 *   deploy-cron — Deno Deploy 운영(미리보기·브랜치 타임라인 제외): 지금처럼 Deno.cron
 *   interval    — 컨테이너(애저 Container Apps): ANALYSIS_SWEEP=interval 일 때 앱 안 setInterval
 *                 (컨테이너에서는 Deno.cron 이 돌지 않는다 — 운영 DB 를 보는 곳이 여럿이면 AI 를 두 번 부르므로
 *                  켜는 곳을 환경변수로 한 곳에만 정한다. 앱 인스턴스는 1개로 둔다)
 *   off         — 그 밖(로컬 개발 서버·시험) — 같은 DB 를 여러 곳이 보므로 끈다
 */
export function sweepMode(env: { get(key: string): string | undefined }): SweepMode {
  const timeline = env.get("DENO_TIMELINE") ?? "";
  const onDeploy = env.get("DENO_DEPLOY") === "true";
  if (onDeploy) {
    return timeline.startsWith("preview/") || timeline.startsWith("git-branch/")
      ? "off"
      : "deploy-cron";
  }
  return env.get("ANALYSIS_SWEEP") === "interval" ? "interval" : "off";
}

/**
 * setInterval 로 도는 안전망. 한 바퀴가 길어져도 겹치지 않는다(돌고 있으면 이번 차례는 건너뛴다).
 * 첫 바퀴는 간격만큼 뒤에 — 재시작이 잦아도 AI 를 몰아 부르지 않게.
 */
export function startIntervalSweep(
  run: () => Promise<unknown> = sweepUnanalyzed,
  intervalMs = SWEEP_INTERVAL_MS,
  log: (line: string, error?: unknown) => void = DEFAULTS.log,
): { stop: () => void; tick: () => Promise<void> } {
  let running = false;
  const tick = async () => {
    if (running) {
      log("[cron] 이전 바퀴가 아직 도는 중 — 이번 차례 건너뜀");
      return;
    }
    running = true;
    try {
      await run();
    } catch (error) {
      log("[cron] 미분석 봉사일지 안전망 실패", error);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  log(`[cron] 안전망 시작 — ${Math.round(intervalMs / 60000)}분마다(컨테이너)`);
  return { stop: () => clearInterval(timer), tick };
}
