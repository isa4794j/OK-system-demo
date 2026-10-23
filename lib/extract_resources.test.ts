/**
 * 자원 추출의 "AI 응답 → 저장할 줄" 단계 테스트
 *
 *   deno task test
 *
 * AI 를 부르지 않는다. AI 가 돌려줬다고 치고 그 뒤를 본다.
 * 특히 블랙리스트의 두 번째 겹(저장 단계에서 '없음'으로 돌리기)은
 * AI 가 프롬프트를 잘 따르면 실제로는 안 밟히는 길이라, 여기서만 확인할 수 있다.
 */
import { assertEquals } from "@std/assert";
import { parseItems, toRows } from "./extract_resources.ts";
import type { ResourceItem } from "../db/resources.ts";

const DICT: ResourceItem[] = [
  { id: "r1", name: "젠가", category: "보드게임", aliases: "나무탑, 탑쌓기", auto_added: false },
  { id: "r2", name: "훌라후프", category: "체육", aliases: null, auto_added: false },
];
const CATEGORIES = ["기기", "보드게임", "예술", "체육", "기타"];

Deno.test("블랙리스트 이름은 버리지 않고 '없음'으로 넣는다", () => {
  const { rows, skipped } = toRows(
    [{ name: "강당", category: "기타" }, { name: "젠가", category: "보드게임" }],
    DICT,
    CATEGORIES,
    ["강당"],
  );
  assertEquals(skipped, []);
  assertEquals(rows, [
    { resource_name: "강당", raw_name: "강당", category: null, status: "없음" },
    { resource_name: "젠가", raw_name: "젠가", category: "보드게임" },
  ]);
});

Deno.test("블랙리스트는 앞뒤 공백과 대소문자를 가리지 않는다", () => {
  const { rows } = toRows([{ name: "Hula Hoop", category: "체육" }], DICT, CATEGORIES, [
    " hula hoop ",
  ]);
  assertEquals(rows[0].status, "없음");
});

Deno.test("사전에 있는 자원은 AI 가 적은 카테고리를 무시하고 사전 값을 쓴다", () => {
  const { rows } = toRows([{ name: "젠가", category: "예술" }], DICT, CATEGORIES, []);
  assertEquals(rows, [{ resource_name: "젠가", raw_name: "젠가", category: "보드게임" }]);
});

Deno.test("사전에 없는 자원의 카테고리는 목록에 있는 것만 받는다", () => {
  const { rows } = toRows(
    [{ name: "천사점토", category: "예술" }, { name: "물총", category: "놀이" }],
    DICT,
    CATEGORIES,
    [],
  );
  assertEquals(rows, [
    { resource_name: "천사점토", raw_name: "천사점토", category: "예술" },
    { resource_name: "물총", raw_name: "물총", category: null },
  ]);
});

Deno.test("별칭으로 적힌 것은 정식 이름으로 저장하되 적힌 표기를 남긴다", () => {
  // 이 값이 없으면 나중에 "나무탑"을 젠가에서 다시 떼어낼 수 없다.
  const { rows } = toRows(
    [{ name: "젠가", as_written: "나무탑", category: "보드게임" }],
    DICT,
    CATEGORIES,
    [],
  );
  assertEquals(rows, [{ resource_name: "젠가", raw_name: "나무탑", category: "보드게임" }]);
});

Deno.test("적힌 표기를 안 주면 정식 이름과 같다고 본다", () => {
  const { rows } = toRows([{ name: "젠가" }], DICT, CATEGORIES, []);
  assertEquals(rows[0].raw_name, "젠가");
});

Deno.test("이름이 비었거나 너무 길면 건너뛰고 이유를 남긴다", () => {
  const { rows, skipped } = toRows(
    [{ name: "  " }, { name: "가".repeat(101), category: "기타" }],
    DICT,
    CATEGORIES,
    [],
  );
  assertEquals(rows, []);
  assertEquals(skipped.length, 2);
});

Deno.test("응답에 코드펜스나 머리말이 섞여도 배열만 꺼낸다", () => {
  const items = parseItems('여기 있습니다:\n```json\n[{"name":"젠가"}]\n```');
  assertEquals(items, [{ name: "젠가" }]);
});
