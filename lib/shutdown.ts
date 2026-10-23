/**
 * 꺼질 때 — 받은 요청은 끝까지 답하고, 응답 뒤에 돌던 일(lib/background.ts)도 잠깐 기다린다.
 *
 * 전에는 남은 백그라운드 일이 없으면 곧바로 Deno.exit 해서, 그 순간 처리 중이던 요청이 끊길 수 있었다.
 * server.shutdown() 은 새 연결을 받지 않고 처리 중인 요청이 끝나기를 기다린다.
 * 기다림에는 한도를 둔다 — Deploy 는 SIGINT 뒤 5초, Container Apps 는 SIGTERM 뒤 30초를 준다.
 */
export const SHUTDOWN_WAIT_MS = { deploy: 4500, container: 25000 } as const;

export async function shutdownGracefully(
  server: { shutdown(): Promise<void> },
  drain: () => Promise<void>,
  waitMs: number,
): Promise<"done" | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    Promise.allSettled([server.shutdown(), drain()]).then(() => "done" as const),
    new Promise<"timeout">((resolve) => timer = setTimeout(() => resolve("timeout"), waitMs)),
  ]);
  clearTimeout(timer);
  if (result === "timeout") console.error(`[shutdown] ${waitMs}ms 안에 다 끝내지 못하고 종료`);
  return result;
}
