import { assertEquals, assertStringIncludes } from "@std/assert";
import { COPY_PIN_VALUE, copyAllowed } from "./copy_guard.ts";

Deno.test("복제 안전핀 — 환경변수가 없으면 어떤 단계도 거부", () => {
  for (const step of ["roles", "dump", "restore", "grants"]) {
    const verdict = copyAllowed(step, undefined);
    assertEquals(verdict.ok, false, step);
    if (!verdict.ok) assertStringIncludes(verdict.reason, "애저가 원본");
  }
  assertEquals(copyAllowed("restore", "").ok, false);
  assertEquals(copyAllowed("restore", "yes").ok, false);
  assertEquals(copyAllowed("restore", COPY_PIN_VALUE.toUpperCase()).ok, false);
});

Deno.test("복제 안전핀 — 정확한 값일 때만 열린다(앞뒤 공백은 봐준다)", () => {
  assertEquals(copyAllowed("restore", COPY_PIN_VALUE).ok, true);
  assertEquals(copyAllowed("dump", ` ${COPY_PIN_VALUE} `).ok, true);
});

Deno.test("복제 안전핀 — 덤프 삭제(clean)와 단계 없이 부른 것은 그대로 둔다", () => {
  assertEquals(copyAllowed("clean", undefined).ok, true);
  assertEquals(copyAllowed(undefined, undefined).ok, true);
});
