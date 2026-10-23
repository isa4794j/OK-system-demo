/**
 * 두 글이 얼마나 닮았는지 — 순수 계산만 둔다
 *
 * DB 도 AI 도 부르지 않는다. 그래서 어느 층에서든 불러 쓸 수 있다.
 * 지금 쓰는 곳은 둘이다.
 *   다시 분석한 관찰을 옛 관찰과 짝지을 때 (db/journal_observations.ts)
 *   새 자원 이름이 "자원 아님" 이력과 닮았는지 볼 때 (lib/extract_resources.ts)
 *
 * 형태소 분석 같은 것은 하지 않는다. 여기서 가리려는 것은
 * "이 둘이 사실상 같은 것을 달리 쓴 것인가" 뿐이고, 그 정도는 글자 겹침으로 충분하다.
 */

/** 글자 두 개씩 잘라 조각 집합으로. 한 글자짜리는 통째로 한 조각. */
export function bigrams(text: string): Set<string> {
  const chars = [...text.replace(/\s+/g, "")];
  if (chars.length < 2) return new Set(chars);

  const out = new Set<string>();
  for (let i = 0; i < chars.length - 1; i += 1) out.add(chars[i] + chars[i + 1]);
  return out;
}

/** 0~1. 겹친 조각 ÷ 전체 조각(자카드). 둘 중 하나가 비면 0. */
export function similarity(a: string, b: string): number {
  const left = bigrams(a);
  const right = bigrams(b);
  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const piece of left) if (right.has(piece)) shared += 1;
  return shared / (left.size + right.size - shared);
}
