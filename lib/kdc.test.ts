/**
 * KDC 번호 → 이름 변환 테스트
 *
 *   deno task test
 *
 * 조회로 들어오는 번호는 모양이 제각각이다("813.7", "8", "", 이름이 섞인 것).
 * 어떤 모양이 와도 서가 이름이 하나로 정해지거나, 아니면 확실히 null 이어야 한다.
 */
import { assertEquals } from "@std/assert";
import { KDC_LABELS, kdcLabel } from "./kdc.ts";

Deno.test("대분류는 첫 자리로 정해진다", () => {
  assertEquals(kdcLabel("000"), "총류");
  assertEquals(kdcLabel("199"), "철학");
  assertEquals(kdcLabel("234"), "종교");
  assertEquals(kdcLabel("375.1"), "사회과학");
  assertEquals(kdcLabel("491.6"), "자연과학");
  assertEquals(kdcLabel("517"), "기술과학");
  assertEquals(kdcLabel("650"), "예술");
  assertEquals(kdcLabel("711"), "언어");
  assertEquals(kdcLabel("911"), "역사");
});

Deno.test("문학은 둘째 자리까지 나눈다", () => {
  assertEquals(kdcLabel("808"), "문학");
  assertEquals(kdcLabel("813.7"), "한국문학");
  assertEquals(kdcLabel("823"), "중국문학");
  assertEquals(kdcLabel("833"), "일본문학");
  assertEquals(kdcLabel("843"), "영미문학");
  assertEquals(kdcLabel("893"), "기타문학");
});

Deno.test("자리가 모자라면 대분류로 둔다", () => {
  assertEquals(kdcLabel("4"), "자연과학");
  // 그냥 "8" 은 어느 나라 문학인지 모른다. 억지로 한국문학으로 밀지 않는다.
  assertEquals(kdcLabel("8"), "문학");
});

Deno.test("숫자가 없으면 null — 억지로 어느 칸에도 넣지 않는다", () => {
  assertEquals(kdcLabel(""), null);
  assertEquals(kdcLabel(null), null);
  assertEquals(kdcLabel(undefined), null);
  assertEquals(kdcLabel("본표"), null);
});

Deno.test("앞뒤에 다른 글자가 붙어 와도 숫자만 읽는다", () => {
  assertEquals(kdcLabel(" 813.7 "), "한국문학");
  assertEquals(kdcLabel("KDC 375"), "사회과학");
});

Deno.test("고를 수 있는 이름은 열아홉 개, 서가 순서대로", () => {
  assertEquals(KDC_LABELS.length, 19);
  assertEquals(KDC_LABELS[0], "총류");
  assertEquals(KDC_LABELS[8], "문학");
  assertEquals(KDC_LABELS[9], "한국문학");
  assertEquals(KDC_LABELS[18], "역사");
  // 변환 결과는 반드시 고를 수 있는 이름 안에 있어야 한다
  for (const no of ["000", "813.7", "893", "911"]) {
    assertEquals(KDC_LABELS.includes(kdcLabel(no) ?? ""), true);
  }
});
