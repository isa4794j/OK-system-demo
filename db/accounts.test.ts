import { assertEquals } from "@std/assert";
import { pickFreeLoginName } from "./accounts.ts";

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
