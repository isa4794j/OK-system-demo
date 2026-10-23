import { assertEquals } from "@std/assert";
import { BOOTSTRAP_ROLES, parseBootstrapChoice } from "./bootstrap.ts";

Deno.test("최초 부팅 — 명단에서 고르기", () => {
  assertEquals(parseBootstrapChoice({ staff_id: " abc " }), { kind: "pick", staffId: "abc" });
});

Deno.test("최초 부팅 — 첫 종사자 직접 입력(이름·직급)", () => {
  assertEquals(parseBootstrapChoice({ name: " 김센터 ", role: "센터장" }), {
    kind: "new",
    name: "김센터",
    role: "센터장",
  });
  assertEquals(
    parseBootstrapChoice({ name: "박복지", role: "생활복지사" }),
    { kind: "new", name: "박복지", role: "생활복지사" },
  );
});

Deno.test("최초 부팅 — 관리자가 될 수 없는 직급·빈 값·두 갈래 섞기는 거절", () => {
  for (const role of ["봉사자", "멘토", "", "관리자"]) {
    assertEquals(typeof parseBootstrapChoice({ name: "누구", role }), "string", role);
  }
  assertEquals(typeof parseBootstrapChoice({}), "string");
  assertEquals(typeof parseBootstrapChoice({ role: "센터장" }), "string");
  assertEquals(typeof parseBootstrapChoice({ name: "   ", role: "센터장" }), "string");
  assertEquals(typeof parseBootstrapChoice({ name: "가".repeat(101), role: "센터장" }), "string");
  assertEquals(
    typeof parseBootstrapChoice({ staff_id: "abc", name: "김센터", role: "센터장" }),
    "string",
  );
  // 숫자·객체 같은 엉뚱한 모양
  assertEquals(typeof parseBootstrapChoice({ name: 3, role: ["센터장"] }), "string");
});

Deno.test("최초 부팅 직급 목록은 명단 직급 안에 있다", async () => {
  const { ROLES } = await import("../db/staff.ts");
  for (const role of BOOTSTRAP_ROLES) {
    assertEquals((ROLES as readonly string[]).includes(role), true);
  }
});
