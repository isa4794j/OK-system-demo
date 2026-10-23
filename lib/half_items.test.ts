import { assertEquals } from "@std/assert";
import {
  areaAverages,
  checkItemEdit,
  checkItemList,
  cleanScores,
  type HalfItem,
  isComplete,
  keepDeletedScores,
  nextCode,
} from "./half_items.ts";

const ITEMS: HalfItem[] = [
  { code: "h01", area: "생활", text: "청결", max: 5 },
  { code: "h02", area: "생활", text: "건강", max: 5 },
  { code: "h06", area: "교육", text: "진도", max: 5 },
  { code: "h11", area: "정서", text: "발달", max: 5, deleted: true },
];

Deno.test("항목을 지워도 목록에서 빼면 안 된다 — 지난 점수가 뜻을 잃는다", () => {
  const dropped = ITEMS.filter((one) => one.code !== "h02");
  assertEquals(typeof checkItemEdit(ITEMS, dropped), "string");

  const marked = ITEMS.map((one) => one.code === "h02" ? { ...one, deleted: true } : one);
  assertEquals(checkItemEdit(ITEMS, marked), null);
});

Deno.test("만점은 바꿀 수 없다", () => {
  const changed = ITEMS.map((one) => one.code === "h01" ? { ...one, max: 3 } : one);
  assertEquals(typeof checkItemEdit(ITEMS, changed), "string");
});

Deno.test("문구와 영역은 고칠 수 있고, 새 항목은 더할 수 있다", () => {
  const edited: HalfItem[] = [
    ...ITEMS.map((one) =>
      one.code === "h01" ? { ...one, text: "옷과 몸이 깨끗했다", area: "정서" as const } : one
    ),
    { code: "h12", area: "교육", text: "새 항목", max: 5 },
  ];
  assertEquals(checkItemEdit(ITEMS, edited), null);
});

Deno.test("모양 검사 — 코드 중복·빈 문구·모르는 영역", () => {
  assertEquals(checkItemList(ITEMS), null);
  assertEquals(typeof checkItemList([...ITEMS, { ...ITEMS[0] }]), "string");
  assertEquals(typeof checkItemList([{ ...ITEMS[0], text: "  " }]), "string");
  assertEquals(typeof checkItemList([{ ...ITEMS[0], area: "건강" }]), "string");
  assertEquals(typeof checkItemList([{ ...ITEMS[0], code: "x1" }]), "string");
  assertEquals(typeof checkItemList("항목"), "string");
});

Deno.test("새 코드는 지운 것까지 세어 그 다음 — 옛 코드를 다시 쓰지 않는다", () => {
  assertEquals(nextCode(ITEMS), "h12");
  assertEquals(nextCode([]), "h01");
});

Deno.test("점수 거르기 — 빈 칸은 되고, 틀린 값은 거절", () => {
  assertEquals(cleanScores(ITEMS, { h01: 4 }), { scores: { h01: 4 } });
  assertEquals(cleanScores(ITEMS, {}), { scores: {} });
  assertEquals(cleanScores(ITEMS, undefined), { scores: {} });

  assertEquals("error" in cleanScores(ITEMS, { h01: 6 }), true);
  assertEquals("error" in cleanScores(ITEMS, { h01: 0 }), true);
  assertEquals("error" in cleanScores(ITEMS, { h01: 3.5 }), true);
  assertEquals("error" in cleanScores(ITEMS, { h99: 3 }), true);
  // 지운 항목에는 새 점수를 줄 수 없다
  assertEquals("error" in cleanScores(ITEMS, { h11: 3 }), true);
});

Deno.test("덮어써도 지운 항목의 지난 점수는 남는다", () => {
  const before = { h01: 2, h11: 4 };
  assertEquals(keepDeletedScores(ITEMS, before, { h01: 5 }), { h11: 4, h01: 5 });
  // 지우지 않은 항목은 새 값이 통째로 이긴다 — 빈 칸으로 되돌리는 것도 된다
  assertEquals(keepDeletedScores(ITEMS, before, {}), { h11: 4 });
});

Deno.test("다 채웠는가 — 지운 항목은 세지 않는다", () => {
  assertEquals(isComplete(ITEMS, { h01: 1, h02: 2, h06: 3 }), true);
  assertEquals(isComplete(ITEMS, { h01: 1, h02: 2 }), false);
  assertEquals(isComplete(ITEMS, null), false);
});

Deno.test("영역 평균 — 지운 항목은 빼고, 점수 없는 영역은 null", () => {
  const avg = areaAverages(ITEMS, { h01: 4, h02: 5, h11: 1 });
  assertEquals(avg.생활, 4.5);
  assertEquals(avg.교육, null); // 0 으로 두면 "아주 낮음" 으로 읽힌다
  assertEquals(avg.정서, null); // h11 은 지운 항목이라 세지 않는다
});
