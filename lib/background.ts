/**
 * 응답을 보낸 뒤에 도는 일
 *
 * [왜]
 * 봉사자가 폰에서 일지를 저장하면 AI 분석(관찰·자원)이 뒤따라야 한다. 분석은 수십 초가
 * 걸리므로 그 사이 폰을 붙잡아 둘 수 없다 — 저장 응답을 먼저 보내고 분석은 뒤에서 돈다.
 *
 * [Deno Deploy 에서의 한계 — 보장이 아니다]
 * Deploy 에는 waitUntil 같은 "응답 뒤 작업을 끝까지 지켜 주는" 장치가 없다.
 * 앱은 요청·응답이 오가는 동안 살아 있고, 조용해지면 5초~10분 사이에 SIGINT 를 받은 뒤
 * 5초 안에 꺼진다(docs.deno.com/deploy/reference/runtime). 그래서 뒤에서 돌던 분석이
 * 중간에 끊길 수 있다.
 *
 * 끊겨도 잃는 것은 없다 — 일지는 이미 저장됐고, 분석이 끝나지 않은 일지는 PC 일지 화면에
 * "미분석" 으로 남아 [일괄 분석] 이 받아 준다(안전망).
 * 다만 조용히 끊기지 않게 한다: 끝나면 완료를, 실패하면 오류를, 꺼질 때 남은 일을 서버 로그에 남긴다.
 */

const pending = new Map<symbol, { label: string; startedAt: number; done: Promise<void> }>();

/** 기다리지 않고 돌린다. 실패는 삼키지 않고 서버 로그에 남긴다. */
export function runAfterResponse(label: string, work: () => Promise<void>): void {
  const key = Symbol(label);
  const startedAt = Date.now();
  const done = (async () => {
    try {
      await work();
      console.log(`[background] 완료 ${label} (${Date.now() - startedAt}ms)`);
    } catch (error) {
      console.error(`[background] 실패 ${label} (${Date.now() - startedAt}ms)`, error);
    } finally {
      pending.delete(key);
    }
  })();
  pending.set(key, { label, startedAt, done });
}

/** 지금 돌고 있는 일 (시험·종료 기록용) */
export function pendingLabels(): string[] {
  return [...pending.values()].map((one) => one.label);
}

/**
 * 꺼지기 전에 남은 일을 잠깐 기다린다. 다 못 끝낸 것은 이름을 남긴다.
 * Deploy 는 SIGINT 뒤 5초를 준다 — 그보다 조금 짧게 기다린다.
 */
export async function drainBeforeExit(waitMs = 4000): Promise<void> {
  if (pending.size === 0) return;
  console.warn(
    `[background] 종료 신호 — 남은 일 ${pending.size}건 기다림: ${pendingLabels().join(", ")}`,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled([...pending.values()].map((one) => one.done)),
    new Promise((resolve) => timer = setTimeout(resolve, waitMs)),
  ]);
  clearTimeout(timer);
  if (pending.size > 0) {
    console.error(
      `[background] 끝내지 못하고 종료 — ${pendingLabels().join(", ")}. ` +
        "일지는 저장돼 있고 PC 일지 화면의 [일괄 분석] 으로 다시 돌릴 수 있다.",
    );
  }
}
