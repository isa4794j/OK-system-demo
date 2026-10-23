/**
 * 다시 분석한 결과를 옛 결과와 짝짓는 규칙 테스트
 *
 *   deno task test
 *
 * DB 를 부르지 않는다. 짝짓기는 순수 계산이라 그것만 떼어 본다.
 */
import { assertEquals } from "@std/assert";
import { isProtectedCandidate, pairByContent } from "./journal_observations.ts";

/** 짝지은 결과를 읽기 쉽게 (옛글 → 새글) 목록으로 */
function pairsOf(olds: string[], news: string[]) {
  const result = pairByContent(
    olds.map((content) => ({ content })),
    news.map((content) => ({ content })),
  );
  return {
    pairs: result.pairs.map(([o, n]) => `${o.content} → ${n.content}`),
    oldLeft: result.oldLeft.map((one) => one.content),
    newLeft: result.newLeft.map((one) => one.content),
  };
}

Deno.test("차례가 뒤바뀌어도 내용으로 짝짓는다", () => {
  const out = pairsOf(
    ["리코더로 '구슬비'를 연습했다.", "피아노로 '자장가' 리듬을 공부했다."],
    // AI 가 순서를 바꿔 내놓았다
    ["피아노로 '자장가' 리듬 공부를 하였다.", "리코더로 '구슬비'를 연습하였다."],
  );
  assertEquals(out.pairs, [
    "리코더로 '구슬비'를 연습했다. → 리코더로 '구슬비'를 연습하였다.",
    "피아노로 '자장가' 리듬을 공부했다. → 피아노로 '자장가' 리듬 공부를 하였다.",
  ]);
  assertEquals(out.oldLeft, []);
  assertEquals(out.newLeft, []);
});

Deno.test("글자까지 같은 것은 짝으로 세지 않는다", () => {
  // 고를 것이 없는 짝이라 pairs 에 넣지 않고 조용히 뺀다
  const out = pairsOf(["같은 문장이다.", "다른 문장을 조금 고쳤다."], [
    "다른 문장을 조금 고쳐 썼다.",
    "같은 문장이다.",
  ]);
  assertEquals(out.pairs, ["다른 문장을 조금 고쳤다. → 다른 문장을 조금 고쳐 썼다."]);
  assertEquals(out.oldLeft, []);
  assertEquals(out.newLeft, []);
});

Deno.test("안 닮은 것끼리는 짝짓지 않는다", () => {
  const out = pairsOf(
    ["아침 결식이 잦아 보호자 상담이 필요함."],
    ["리코더 합주에서 파트 리더를 맡음."],
  );
  assertEquals(out.pairs, []);
  assertEquals(out.oldLeft, ["아침 결식이 잦아 보호자 상담이 필요함."]);
  assertEquals(out.newLeft, ["리코더 합주에서 파트 리더를 맡음."]);
});

Deno.test("한쪽에만 있으면 안 나옴 / 새로 나옴", () => {
  const out = pairsOf(
    ["옛 관찰 하나만 있다."],
    ["옛 관찰 하나만 있다.", "아주 다른 새 관찰이 생겼다."],
  );
  assertEquals(out.pairs, []);
  assertEquals(out.oldLeft, []);
  assertEquals(out.newLeft, ["아주 다른 새 관찰이 생겼다."]);

  const out2 = pairsOf(["없어질 관찰."], []);
  assertEquals(out2.oldLeft, ["없어질 관찰."]);
});

Deno.test("한 줄은 한 번만 짝을 맺는다", () => {
  // 새 줄 하나가 옛 줄 둘과 모두 닮았어도, 더 닮은 쪽 하나만 가져간다
  const out = pairsOf(
    ["블록으로 탑을 높이 쌓았다.", "블록으로 탑을 쌓다가 무너뜨렸다."],
    ["블록으로 탑을 높이 쌓았음."],
  );
  assertEquals(out.pairs, ["블록으로 탑을 높이 쌓았다. → 블록으로 탑을 높이 쌓았음."]);
  assertEquals(out.oldLeft, ["블록으로 탑을 쌓다가 무너뜨렸다."]);
  assertEquals(out.newLeft, []);
});

Deno.test("빈 목록에도 안전하다", () => {
  assertEquals(pairsOf([], []), { pairs: [], oldLeft: [], newLeft: [] });
});

/* ---------- 재분석 보호(1차 전수 점검 2026-09-17) ---------- */

Deno.test("재분석 보호 — 가져감·합쳐짐·고침은 보호, 나머지는 열림", () => {
  const taken = new Set(["t"]);
  const at = "2026-09-17T00:00:00Z";
  assertEquals(isProtectedCandidate({ id: "t" }, taken), true);
  assertEquals(isProtectedCandidate({ id: "m", merged_at: at }, taken), true);
  assertEquals(isProtectedCandidate({ id: "e", edited_at: at }, taken), true);
  assertEquals(isProtectedCandidate({ id: "o" }, taken), false);
  assertEquals(isProtectedCandidate({ id: "o", merged_at: null, edited_at: null }, taken), false);
});

Deno.test("재분석 보호 — 고르기에서 손댄 줄은 빠진다", () => {
  const taken = new Set(["t"]);
  const rows = [
    { id: "o1" },
    { id: "o2" },
    { id: "e", edited_at: "x" },
    { id: "m", merged_at: "x" },
    { id: "t" },
  ];
  const allowed = rows.filter((row) => !isProtectedCandidate(row, taken)).map((row) => row.id);
  assertEquals(allowed, ["o1", "o2"]);
});
