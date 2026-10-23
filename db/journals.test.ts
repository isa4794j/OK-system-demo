import { assertEquals } from "@std/assert";
import { textFilter } from "./journals.ts";

Deno.test("통합 검색 — 본문·제목, 이름이 맞은 작성자가 있으면 그 사람도", () => {
  assertEquals(textFilter("산책"), 'content.ilike."%산책%",title.ilike."%산책%"');
  assertEquals(
    textFilter("김", ["a1", "b2"]),
    'content.ilike."%김%",title.ilike."%김%",author_id.in.("a1","b2")',
  );
});

Deno.test("통합 검색 — %·_·쉼표·따옴표는 글자 그대로 찾는다", () => {
  // LIKE 특수 글자는 \ 로, 필터 문법의 따옴표·\ 는 quote 가 한 번 더 감싼다
  assertEquals(textFilter("50%"), 'content.ilike."%50\\\\%%",title.ilike."%50\\\\%%"');
  assertEquals(textFilter("a_b"), 'content.ilike."%a\\\\_b%",title.ilike."%a\\\\_b%"');
  assertEquals(textFilter('가,"나"'), 'content.ilike."%가,\\"나\\"%",title.ilike."%가,\\"나\\"%"');
});
