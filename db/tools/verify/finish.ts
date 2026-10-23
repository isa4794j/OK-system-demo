/**
 * 검증 마무리 — 검증 세션(user_agent "verify-script")만 지운다.
 *
 * [검증] 계정·일지 같은 증거물과 감사 로그는 남긴다(CLAUDE.md 원칙 12).
 * 살아 있는 토큰만 없앤다 — 증거물이 로그인 가능한 채로 남지 않게.
 *
 *   unset DATABASE_URL; deno run -A --env-file db/tools/verify/finish.ts
 */
import { getClient } from "../../client.ts";

if (Deno.env.get("DATABASE_URL")) {
  console.error("DATABASE_URL 이 있다 — 연습장 전용. 멈춤.");
  Deno.exit(1);
}
// deno-lint-ignore no-explicit-any
const db = getClient() as any;
const s = await db.from("sessions").delete({ count: "exact" }).eq("user_agent", "verify-script");
if (s.error) throw s.error;
console.log("검증 세션 삭제:", s.count);
Deno.exit(0);
