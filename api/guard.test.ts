import { assertEquals } from "@std/assert";
import { authModeOf } from "./guard.ts";

Deno.test("관문 모드 — true 잠금, warn 만 끝까지 경고, 나머지는 부팅 뒤 자동 잠금", () => {
  assertEquals(authModeOf("true"), "on");
  assertEquals(authModeOf(" TRUE "), "on");
  assertEquals(authModeOf("warn"), "warn");
  assertEquals(authModeOf("Warn"), "warn");
  // 예전의 false(경고만)는 이제 부팅 뒤 잠금 — 경고 모드로 부팅해도 열린 채 남지 않는다
  assertEquals(authModeOf("false"), "auto");
  assertEquals(authModeOf(""), "auto");
  assertEquals(authModeOf(undefined), "auto");
  // 오타는 여는 쪽이 아니라 부팅 뒤 잠그는 쪽으로
  assertEquals(authModeOf("ture"), "auto");
  assertEquals(authModeOf("warning"), "auto");
});
