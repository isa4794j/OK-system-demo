import { assertEquals } from "@std/assert";
import { failureChanges, MAX_FAILED, pickFreeLoginName } from "./accounts.ts";

Deno.test("종료자 로그인 이름 풀기 — 비어 있는 첫 번호(_001)", () => {
  assertEquals(pickFreeLoginName("김민영", ["김민영", "이서준"]), "김민영_001");
});

Deno.test("_001 이 차 있으면 _002, 중간이 비면 그 번호", () => {
  assertEquals(pickFreeLoginName("김민영", ["김민영", "김민영_001"]), "김민영_002");
  assertEquals(pickFreeLoginName("김민영", ["김민영_001", "김민영_003"]), "김민영_002");
});

Deno.test("비교는 앞뒤 공백·대소문자를 가리지 않는다(유일 인덱스와 같은 기준)", () => {
  assertEquals(pickFreeLoginName(" Kim ", [" kim_001 ", "KIM_002"]), "Kim_003");
});

Deno.test("일반 계정은 MAX_FAILED 번째 실패에 잠긴다", () => {
  const before = failureChanges({ login_name: "김민영", failed_attempts: MAX_FAILED - 2 });
  assertEquals(before, { failed_attempts: MAX_FAILED - 1 });
  const locked = failureChanges({ login_name: "김민영", failed_attempts: MAX_FAILED - 1 }, 0);
  assertEquals(locked?.failed_attempts, 0);
  assertEquals(typeof locked?.locked_until, "string");
});

Deno.test("데모 계정 셋은 몇 번을 틀려도 세지도 잠그지도 않는다", () => {
  for (const who of ["데모센터장", "데모복지사", "데모봉사자"]) {
    assertEquals(failureChanges({ login_name: who, failed_attempts: MAX_FAILED - 1 }), null);
  }
});
