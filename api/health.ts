/**
 * GET /health — DB 연결 상태를 텍스트로 반환한다(Supabase REST 또는 Postgres 직결 — db/client.ts dbMode).
 *
 * 이 파일은 Supabase를 직접 부르지 않는다. /db의 함수만 사용한다.
 */
import { dbMode, ping } from "../db/client.ts";

export async function handleHealth(): Promise<Response> {
  const result = await ping();

  const lines = [
    "OK-system health check",
    "----------------------",
    `server   : OK`,
    dbMode() === "postgres"
      ? `database : ${result.ok ? "OK" : "FAIL"} (postgres)`
      : `supabase : ${result.ok ? "OK" : "FAIL"}`,
    `status   : ${result.status ?? "-"}`,
    `latency  : ${result.latencyMs}ms`,
    `message  : ${result.message}`,
    `time     : ${new Date().toISOString()}`,
  ];

  return new Response(lines.join("\n") + "\n", {
    status: result.ok ? 200 : 503,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
