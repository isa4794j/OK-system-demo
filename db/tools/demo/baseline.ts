/**
 * 데모 기준 데이터 만들기 — 지금 DB 를 그대로 `demo_baseline` 스키마에 복사해 둔다.
 *
 * 하루 한 번 reset.ts 가 이 복사본으로 되돌린다. 덤프 파일을 만들지 않는 이유:
 * 덤프에는 계정 비밀번호 해시가 들어가는데, 그 파일을 저장소에 두고 싶지 않다.
 * 복사본을 DB 안에 두면 접속 정보(Secrets) 하나만 있으면 되고 파일이 남지 않는다.
 *
 * 기준을 다시 잡고 싶을 때만 돌린다(데모 데이터를 손본 뒤).
 *   DEMO_DATABASE_URL=... deno run -A db/tools/demo/baseline.ts
 *
 * 접속 주소는 환경변수로만 받는다 — 코드·문서에 적지 않는다.
 */
import postgres from "npm:postgres@^3.4.5";
import { TABLES } from "./tables.ts";

const url = Deno.env.get("DEMO_DATABASE_URL")?.trim();
if (!url) {
  console.error("DEMO_DATABASE_URL 이 없습니다 — 접속 주소는 환경변수로만 줍니다.");
  Deno.exit(1);
}
const sql = postgres(url, { ssl: "require", max: 1 });

await sql.unsafe("create schema if not exists demo_baseline");
const counts: Record<string, number> = {};
for (const t of TABLES) {
  await sql.unsafe(`drop table if exists demo_baseline."${t}"`);
  await sql.unsafe(`create table demo_baseline."${t}" as table public."${t}"`);
  const [{ n }] = await sql.unsafe(`select count(*)::int as n from demo_baseline."${t}"`);
  counts[t] = n;
}
// 기준을 언제 잡았는지 남겨 둔다(reset.ts 가 읽어 보고한다)
await sql.unsafe(`drop table if exists demo_baseline._taken_at`);
await sql.unsafe(`create table demo_baseline._taken_at as select now() as at`);
console.log(JSON.stringify({ 기준: counts }, null, 1));
await sql.end();
