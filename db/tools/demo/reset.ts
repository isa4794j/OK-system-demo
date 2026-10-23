/**
 * 데모 초기화 — 하루 한 번, 기준 데이터(demo_baseline)로 되돌린다.
 *
 * 누구나 쓰는 화면이라 데이터가 어지러워진다. 매일 한 번 처음 상태로 돌린다.
 * 계정도 함께 돌아가므로 README 에 적은 데모 비밀번호가 다시 맞게 된다
 * (staff 표의 password_hash 까지 기준 그대로 복사한다).
 *
 * 한 트랜잭션 안에서 비우고 다시 채운다 — 중간에 실패하면 아무것도 바뀌지 않는다.
 * 살아 있던 로그인 창은 sessions 가 기준으로 돌아가며 끊긴다.
 *
 *   DEMO_DATABASE_URL=... deno run -A db/tools/demo/reset.ts
 *
 * 접속 주소는 환경변수로만 받는다 — 코드·문서에 적지 않는다(GitHub Actions 는 Secrets).
 */
import postgres from "npm:postgres@^3.4.5";
import { TABLES } from "./tables.ts";

const url = Deno.env.get("DEMO_DATABASE_URL")?.trim();
if (!url) {
  console.error("DEMO_DATABASE_URL 이 없습니다 — 접속 주소는 환경변수로만 줍니다.");
  Deno.exit(1);
}
const sql = postgres(url, { ssl: "require", max: 1 });

const ready = await sql.unsafe(
  `select count(*)::int as n from information_schema.tables where table_schema = 'demo_baseline'`,
);
if (ready[0].n === 0) {
  console.error("demo_baseline 이 없습니다 — 먼저 baseline.ts 로 기준을 만드세요.");
  await sql.end();
  Deno.exit(1);
}

const before: Record<string, number> = {};
const after: Record<string, number> = {};
for (const t of TABLES) {
  const [{ n }] = await sql.unsafe(`select count(*)::int as n from public."${t}"`);
  before[t] = n;
}

/**
 * 넣을 칸 목록 — 만들어지는 칸(generated, 예: books.sort_key)은 빼야 한다.
 * `insert ... select *` 로는 "DEFAULT 아닌 값을 넣을 수 없다" 며 거절당한다.
 */
async function columnsOf(table: string): Promise<string> {
  const rows = await sql.unsafe(
    `select column_name from information_schema.columns
      where table_schema = 'public' and table_name = $1 and is_generated = 'NEVER'
      order by ordinal_position`,
    [table],
  );
  return [...rows]
    .map((r) => `"${(r as unknown as { column_name: string }).column_name}"`)
    .join(", ");
}
const cols: Record<string, string> = {};
for (const t of TABLES) cols[t] = await columnsOf(t);

await sql.begin(async (tx) => {
  // 한 번에 비운다 — 외래키 순서를 신경 쓰지 않아도 되고, 트리거도 함께 멈춘다.
  const list = TABLES.map((t) => `public."${t}"`).join(", ");
  await tx.unsafe(`truncate ${list} restart identity cascade`);
  for (const t of TABLES) {
    await tx.unsafe(
      `insert into public."${t}" (${cols[t]}) select ${cols[t]} from demo_baseline."${t}"`,
    );
  }
});

for (const t of TABLES) {
  const [{ n }] = await sql.unsafe(`select count(*)::int as n from public."${t}"`);
  after[t] = n;
}
const taken = await sql.unsafe(`select at from demo_baseline._taken_at`).catch(() => []);
console.log(JSON.stringify(
  {
    기준시각: taken[0]?.at ?? "모름",
    되돌림: Object.fromEntries(TABLES.map((t) => [t, `${before[t]} → ${after[t]}`])),
  },
  null,
  1,
));
await sql.end();
