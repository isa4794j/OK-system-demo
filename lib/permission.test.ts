import { assertEquals } from "@std/assert";
import {
  chooseAsRole,
  effectiveRole,
  guessAccessKind,
  levelOf,
  normalizeRoles,
  primaryRole,
} from "./permission.ts";

Deno.test("등급은 역할 중 가장 높은 것 — 멘토·봉사자 겸직은 그대로 봉사", () => {
  assertEquals(levelOf({ roles: ["봉사자"], is_admin: false }), "봉사");
  assertEquals(levelOf({ roles: ["멘토", "봉사자"], is_admin: false }), "봉사");
  assertEquals(levelOf({ roles: ["생활복지사", "멘토"], is_admin: false }), "종사자");
  assertEquals(levelOf({ roles: ["센터장"], is_admin: false }), "센터장");
  assertEquals(levelOf({ roles: [], is_admin: false }), "봉사");
  assertEquals(levelOf({ roles: ["봉사자"], is_admin: true }), "관리자");
});

Deno.test("역할 목록 정리 — 모르는 값·겹친 값을 버리고 등급 순서로", () => {
  assertEquals(normalizeRoles(["봉사자", "멘토", "봉사자", "관리자", 3]), ["멘토", "봉사자"]);
  assertEquals(normalizeRoles([]), []);
  assertEquals(primaryRole(["봉사자", "멘토"]), "멘토");
  assertEquals(primaryRole([]), null);
});

Deno.test("지금 역할 — 한 역할이면 늘 그 역할, 겸직은 고른 것만", () => {
  assertEquals(effectiveRole(["봉사자"], null), "봉사자");
  assertEquals(effectiveRole(["봉사자"], "멘토"), "봉사자");
  assertEquals(effectiveRole(["멘토", "봉사자"], null), null);
  assertEquals(effectiveRole(["멘토", "봉사자"], "멘토"), "멘토");
  assertEquals(effectiveRole(["멘토", "봉사자"], "센터장"), null);
});

Deno.test("접속 권한 추정 — 봉사 역할뿐이면 모바일", () => {
  assertEquals(guessAccessKind(["멘토", "봉사자"]), "모바일");
  assertEquals(guessAccessKind(["생활복지사", "멘토"]), "PC");
  assertEquals(guessAccessKind([]), "PC");
});

Deno.test("대신 기록할 때 역할 — 한 역할이면 자동, 겸직이면 골라야", () => {
  assertEquals(chooseAsRole(["봉사자"], undefined), { role: "봉사자" });
  assertEquals(chooseAsRole(["멘토", "봉사자"], "멘토"), { role: "멘토" });
  assertEquals("error" in chooseAsRole(["멘토", "봉사자"], undefined), true);
  assertEquals("error" in chooseAsRole(["봉사자"], "멘토"), true);
  assertEquals("error" in chooseAsRole([], undefined), true);
});
