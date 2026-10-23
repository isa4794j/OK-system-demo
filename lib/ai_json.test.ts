import { assertEquals, assertThrows } from "@std/assert";
import { findJsonArray, parseObjectArray } from "./ai_json.ts";

Deno.test("배열만 온 답, 코드펜스·머리말이 붙은 답", () => {
  assertEquals(findJsonArray('[{"a":1}]'), [{ a: 1 }]);
  assertEquals(findJsonArray('여기 있습니다:\n```json\n[{"a":1}]\n```'), [{ a: 1 }]);
  assertEquals(findJsonArray("[]"), []);
});

Deno.test('머리말·꼬리말에 대괄호가 있어도 배열을 찾는다("[검증]" 일지 반복 실패)', () => {
  const reply =
    '[검증] 일지에서 뽑은 관찰입니다.\n[{"child":"【아동1】","content":"블록을 쌓았다 [놀이]"}]\n[참고] 끝';
  assertEquals(findJsonArray(reply), [{ child: "【아동1】", content: "블록을 쌓았다 [놀이]" }]);
  assertEquals(findJsonArray("[검증] 뽑을 것이 없습니다.\n[]"), []);
});

Deno.test("못 찾으면 사람이 읽을 문장", () => {
  assertEquals(findJsonArray("없습니다"), "none");
  assertEquals(findJsonArray("[검증] 깨진 {"), "invalid");
  assertThrows(() => parseObjectArray("없습니다", "관찰"), Error, "관찰 목록을 찾지 못했습니다");
  assertThrows(() => parseObjectArray('[{"a":', "관찰"), Error, "올바른 JSON이 아닙니다");
  assertEquals(parseObjectArray('[{"a":1}, 3, null, [1]]', "관찰"), [{ a: 1 }]);
});
