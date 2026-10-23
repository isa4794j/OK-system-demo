import { assertEquals } from "@std/assert";
import { MAX_BOOKS, mergeCovers, normalizeTitle, parseCovers } from "./book_cover.ts";

const 구름빵 = { title: "구름빵", author: "백희나", publisher: "한솔수북" };

Deno.test("배열이 오면 줄마다 읽는다", () => {
  const reply = JSON.stringify([
    구름빵,
    { title: "강아지똥", author: "권정생", publisher: "길벗어린이" },
  ]);
  assertEquals(parseCovers(reply), [
    구름빵,
    { title: "강아지똥", author: "권정생", publisher: "길벗어린이" },
  ]);
});

Deno.test("한 권일 때 객체로 답해도 받는다 — 한 줄 때문에 통째로 실패할 이유가 없다", () => {
  assertEquals(parseCovers(JSON.stringify(구름빵)), [구름빵]);
});

Deno.test("빈 배열은 답이다 — 사진에 책이 없었다는 뜻", () => {
  assertEquals(parseCovers("[]"), []);
});

Deno.test("일부만 읽힌 줄 — 읽힌 칸만 남고 나머지는 빈 값", () => {
  const reply = '[{"title":"구름빵","author":"","publisher":""},' +
    '{"title":"","author":"권정생","publisher":""}]';
  assertEquals(parseCovers(reply), [
    { title: "구름빵", author: "", publisher: "" },
    { title: "", author: "권정생", publisher: "" },
  ]);
});

Deno.test("세 칸이 다 빈 줄도 버리지 않는다 — 그 책이 거기 있었다는 사실이다", () => {
  const reply = '[{"title":"구름빵","author":"백희나","publisher":"한솔수북"},' +
    '{"title":"","author":"","publisher":""}]';
  const got = parseCovers(reply);
  assertEquals(got?.length, 2);
  assertEquals(got?.[1], { title: "", author: "", publisher: "" });
});

Deno.test("'없음·미상' 같은 말은 빈 값으로 — 검색창에 들어가면 찾기가 어긋난다", () => {
  const reply = '[{"title":"구름빵","author":"미상","publisher":"알 수 없음"}]';
  assertEquals(parseCovers(reply), [{ title: "구름빵", author: "", publisher: "" }]);
});

Deno.test("코드펜스 여러 모양 — 말머리가 없어도, 뒤에 설명이 붙어도", () => {
  const body = '[{"title":"구름빵","author":"백희나","publisher":"한솔수북"}]';
  assertEquals(parseCovers("```\n" + body + "\n```"), [구름빵]);
  assertEquals(parseCovers("```json\n" + body + "\n```\n표지에서 읽었습니다."), [구름빵]);
  assertEquals(parseCovers("\n\n" + body + "\n\n"), [구름빵]);
});

Deno.test("길이에서 잘린 답은 null — 빈 목록과 갈라야 화면이 다른 말을 한다", () => {
  assertEquals(parseCovers('[{"title": "'), null);
  assertEquals(parseCovers('[{"title":"구름빵","author":"백희'), null);
  assertEquals(parseCovers('{"title": "'), null);
  assertEquals(parseCovers('```json\n[{"title":"구름빵"}'), null);
});

Deno.test("모양이 아니면 null", () => {
  assertEquals(parseCovers("죄송합니다. 이미지가 흐려 읽을 수 없습니다."), null);
  assertEquals(parseCovers(""), null);
  assertEquals(parseCovers('"구름빵"'), null);
});

Deno.test("객체가 아닌 원소는 걸러낸다", () => {
  const reply = '["구름빵", {"title":"강아지똥","author":"권정생","publisher":"길벗어린이"}, null]';
  assertEquals(parseCovers(reply), [
    { title: "강아지똥", author: "권정생", publisher: "길벗어린이" },
  ]);
});

Deno.test("값이 글자가 아니면 빈 값으로 — 줄은 살린다", () => {
  assertEquals(parseCovers('[{"title":123,"author":null}]'), [
    { title: "", author: "", publisher: "" },
  ]);
});

Deno.test("칸 길이를 넘으면 자른다", () => {
  const long = "가".repeat(400);
  const got = parseCovers(JSON.stringify([{ title: long, author: long, publisher: long }]));
  assertEquals(got?.[0].title.length, 300);
  assertEquals(got?.[0].author.length, 200);
  assertEquals(got?.[0].publisher.length, 200);
});

Deno.test("한 장에서 받는 줄 수에 상한이 있다", () => {
  const many = Array.from(
    { length: 120 },
    (_, i) => ({ title: `책 ${i}`, author: "", publisher: "" }),
  );
  assertEquals(MAX_BOOKS, 80);
  assertEquals(parseCovers(JSON.stringify(many))?.length, 80);
});

Deno.test("값 안에 중괄호·대괄호가 있어도 읽는다", () => {
  const reply = '[{"title":"수학의 정석 {상}","author":"홍성대","publisher":"성지[출판]"}]';
  assertEquals(parseCovers(reply), [
    { title: "수학의 정석 {상}", author: "홍성대", publisher: "성지[출판]" },
  ]);
});

Deno.test("제목이 일부만 읽히면 partial 이 붙는다 — 온전하면 칸이 없다", () => {
  const reply = '[{"title":"구름","author":"","publisher":"","partial":true},' +
    '{"title":"강아지똥","author":"권정생","publisher":"","partial":false}]';
  assertEquals(parseCovers(reply), [
    { title: "구름", author: "", publisher: "", partial: true },
    { title: "강아지똥", author: "권정생", publisher: "" },
  ]);
});

Deno.test("한 글자 제목은 쓰지 않는다 — 저자만 남는다", () => {
  const reply = '[{"title":"구","author":"백희나","publisher":"","partial":true}]';
  assertEquals(parseCovers(reply), [{ title: "", author: "백희나", publisher: "" }]);
});

Deno.test("나눠 읽은 결과 합치기 — 겹친 띠의 같은 책은 한 줄, 더 많이 읽힌 쪽을 남긴다", () => {
  const left = [
    { title: "구름빵", author: "", publisher: "" },
    { title: "강아지 똥", author: "권정생", publisher: "" },
    { title: "", author: "", publisher: "" },
  ];
  const right = [
    { title: "강아지똥", author: "권정생", publisher: "길벗어린이" }, // 띄어쓰기만 다름
    { title: "", author: "", publisher: "" }, // 못 읽은 줄은 접지 않는다
    { title: "마당을", author: "", publisher: "", partial: true as const }, // 일부만
    { title: "마당을 나온 암탉", author: "황선미", publisher: "" },
  ];
  assertEquals(mergeCovers([left, right]), [
    { title: "구름빵", author: "", publisher: "" },
    { title: "강아지똥", author: "권정생", publisher: "길벗어린이" },
    { title: "", author: "", publisher: "" },
    { title: "", author: "", publisher: "" },
    { title: "마당을 나온 암탉", author: "황선미", publisher: "" },
  ]);
  assertEquals(normalizeTitle("Harry Potter: 마법사의 돌 (1)"), "harrypotter마법사의돌1");
  // 한 글자짜리 일부 제목은 다른 책을 삼키지 않는다
  assertEquals(
    mergeCovers([[{ title: "가나", author: "", publisher: "" }], [{
      title: "가",
      author: "",
      publisher: "",
      partial: true as const,
    }]]).length,
    2,
  );
});

Deno.test("합친 뒤에도 상한 80", () => {
  const half = (p: string) =>
    Array.from({ length: 60 }, (_, i) => ({ title: `${p} ${i}`, author: "", publisher: "" }));
  assertEquals(mergeCovers([half("왼"), half("오")]).length, 80);
});
