import { assertEquals } from "@std/assert";
import { sortChildren } from "./child_order.ts";

Deno.test("아동 명단 — 학년 오름차순, 같은 학년 안 가나다, 생년월일 모름은 맨 뒤", () => {
  const rows = [
    { name: "하늘", birth_date: "2016-03-01" }, // 초4(2026)
    { name: "가을", birth_date: "2013-12-31" }, // 중1
    { name: "나래", birth_date: "2019-11-20" }, // 초1
    { name: "모름", birth_date: null },
    { name: "가람", birth_date: "2019-01-02" }, // 초1 — 1월생도 같은 학년
    { name: "다솜", birth_date: "2016-12-01" }, // 초4
    { name: "가나", birth_date: null },
    { name: "라온", birth_date: "2010-05-05" }, // 고1(10)
  ];
  assertEquals(sortChildren(rows).map((r) => r.name), [
    "가람",
    "나래",
    "다솜",
    "하늘",
    "가을",
    "라온",
    "가나",
    "모름",
  ]);
});

Deno.test("아동 명단 — 초1·초10 식 글자 정렬이 아니다(학년 숫자 두 자리도 순서대로)", () => {
  const rows = [
    { name: "갑", birth_date: "2010-01-01" }, // 10
    { name: "을", birth_date: "2019-01-01" }, // 1
    { name: "병", birth_date: "2015-01-01" }, // 5
    { name: "정", birth_date: "2008-01-01" }, // 12
  ];
  assertEquals(sortChildren(rows).map((r) => r.name), ["을", "병", "갑", "정"]);
});

Deno.test("아동 명단 — 원래 배열은 바꾸지 않는다", () => {
  const rows = [{ name: "나", birth_date: "2015-01-01" }, { name: "가", birth_date: "2019-01-01" }];
  sortChildren(rows);
  assertEquals(rows[0].name, "나");
});
