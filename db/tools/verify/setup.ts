/**
 * 검증 계정 준비 — 권한표(matrix.ts)가 쓸 신분 여섯 + 관리자 세션.
 *
 * [검증] 표식을 단 직원 행을 만들고(이미 있으면 그대로 쓴다) 세션을 새로 연다.
 * 세션 토큰은 out/accounts.json 에만 적는다(저장소에 올리지 않는다 — .gitignore).
 * 끝나면 finish.ts 로 세션을 지운다. 계정 행은 표식째 남는다(검증 증거물).
 *
 * 연습장(구 스택) 전용 — DATABASE_URL(애저)이 잡혀 있으면 멈춘다. 애저 점검은 쓰기 없는 표본으로 한다.
 *
 *   unset DATABASE_URL; deno run -A --env-file db/tools/verify/setup.ts
 */
import { getClient } from "../../client.ts";
import { createSession } from "../../sessions.ts";

if (Deno.env.get("DATABASE_URL")) {
  console.error("DATABASE_URL 이 있다 — 검증 계정은 연습장에만 만든다. 멈춤.");
  Deno.exit(1);
}
// deno-lint-ignore no-explicit-any
const db = getClient() as any;
const PEOPLE = [
  { key: "vol", name: "[검증]봉사", roles: ["봉사자"], access_kind: "모바일" },
  { key: "mentvol", name: "[검증]멘토봉사", roles: ["멘토", "봉사자"], access_kind: "모바일" },
  { key: "staff", name: "[검증]종사자", roles: ["생활복지사"], access_kind: "PC" },
  { key: "staffment", name: "[검증]복지멘토", roles: ["생활복지사", "멘토"], access_kind: "PC" },
  { key: "head", name: "[검증]센터장", roles: ["센터장"], access_kind: "PC" },
  { key: "staffmobile", name: "[검증]종사자폰", roles: ["생활복지사"], access_kind: "모바일" },
];
const out: Record<string, { id: string; token: string }> = {};
for (const p of PEOPLE) {
  const found = (await db.from("staff").select("id").eq("name", p.name)).data ?? [];
  let id: string = found[0]?.id;
  if (!id) {
    const ins = await db.from("staff").insert({
      name: p.name,
      login_name: p.name,
      role: p.roles[0],
      roles: p.roles,
      status: "활동중",
      access_kind: p.access_kind,
      // 034 — 동의한 상태로(입구가 /login 으로 돌리지 않게). 동의 전 흐름은 journey.ts 가 따로 본다
      privacy_agreed_at: new Date().toISOString(),
    }).select("id").single();
    if (ins.error) throw ins.error;
    id = ins.data.id;
  }
  out[p.key] = { id, token: (await createSession(id, "verify-script")).token };
}
// 관리자 세션은 이름이 아니라 역할로 찾는다 — 센터가 바뀌어도 그대로 돌아가게.
// 1순위 관리자 깃발, 없으면 센터장 역할. 계정 자체는 건드리지 않는다.
const people = (await db.from("staff").select("id,name,role,roles,is_admin,status")
  .eq("status", "활동중")).data ?? [];
const isHead = (p: { role?: string; roles?: string[] }) =>
  p.role === "센터장" || (p.roles ?? []).includes("센터장");
const admin = people.find((p: { is_admin?: boolean }) => p.is_admin) ?? people.find(isHead);
if (!admin) {
  console.error("관리자 깃발도 센터장도 없습니다 — 먼저 명단에 한 사람을 두세요.");
  Deno.exit(1);
}
out.admin = { id: admin.id, token: (await createSession(admin.id, "verify-script")).token };
console.log("관리자 세션:", admin.name);
await Deno.mkdir(new URL("./out/", import.meta.url), { recursive: true });
await Deno.writeTextFile(
  new URL("./out/accounts.json", import.meta.url),
  JSON.stringify(out, null, 1),
);
console.log("신분:", Object.keys(out).join(","));
Deno.exit(0);
