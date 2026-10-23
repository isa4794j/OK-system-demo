import { assertEquals } from "@std/assert";
import { currentHalf, halfKey, halvesOf, isHalfOpen, isHalfOpenMap } from "./half.ts";

Deno.test("1~6월이 상반기, 7~12월이 하반기", () => {
  assertEquals(currentHalf(new Date("2026-01-01T12:00:00+09:00")).half, 1);
  assertEquals(currentHalf(new Date("2026-06-30T12:00:00+09:00")).half, 1);
  assertEquals(currentHalf(new Date("2026-07-01T12:00:00+09:00")).half, 2);
  assertEquals(currentHalf(new Date("2026-12-31T12:00:00+09:00")).half, 2);
});

Deno.test("연도는 한국 시각 기준이다", () => {
  // UTC 로는 아직 12월 31일이지만 서울은 이미 새해다
  const 새해 = new Date("2026-12-31T16:00:00Z");
  assertEquals(currentHalf(새해).year, 2027);
  assertEquals(currentHalf(새해).half, 1);
});

Deno.test("적혀 있지 않으면 이번 반기만 열린다", () => {
  const now = new Date("2026-09-10T12:00:00+09:00"); // 2026 하반기

  assertEquals(isHalfOpen({}, 2026, 2, now), true);
  assertEquals(isHalfOpen({}, 2026, 1, now), false);
  assertEquals(isHalfOpen({}, 2025, 2, now), false);
  // 설정이 아예 없어도 같다 — 한 번도 안 건드린 센터에서 지금 반기는 써야 한다
  assertEquals(isHalfOpen(null, 2026, 2, now), true);
});

Deno.test("적혀 있으면 그 값이 이긴다 — 이번 반기도 닫을 수 있다", () => {
  const now = new Date("2026-09-10T12:00:00+09:00");

  assertEquals(isHalfOpen({ "2026-2": false }, 2026, 2, now), false);
  assertEquals(isHalfOpen({ "2026-1": true }, 2026, 1, now), true);
  // 다른 반기를 적어 둔 것이 이번 반기 판단을 물들이지 않는다
  assertEquals(isHalfOpen({ "2026-1": true }, 2026, 2, now), true);
});

Deno.test("열쇠 모양", () => {
  assertEquals(halfKey(2026, 2), "2026-2");
  assertEquals(halvesOf(2026), [{ year: 2026, half: 1 }, { year: 2026, half: 2 }]);
});

Deno.test("설정 값 모양을 가린다 — 아무 것이나 담기면 화면이 뜻 없는 것을 읽는다", () => {
  assertEquals(isHalfOpenMap({}), true);
  assertEquals(isHalfOpenMap({ "2026-2": true, "2025-1": false }), true);

  assertEquals(isHalfOpenMap({ "2026-3": true }), false); // 반기는 1 또는 2
  assertEquals(isHalfOpenMap({ "26-2": true }), false); // 연도는 네 자리
  assertEquals(isHalfOpenMap({ "2026-2": 1 }), false); // 값은 참·거짓
  assertEquals(isHalfOpenMap([]), false);
  assertEquals(isHalfOpenMap(null), false);
  assertEquals(isHalfOpenMap("전체"), false);
});
