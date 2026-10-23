/**
 * AI 답에서 JSON 배열 꺼내기 — 관찰·자원 추출, 사진 자원 인식이 같이 쓴다
 *
 * "배열만 출력하라" 고 해도 모델이 머리말을 붙일 때가 있다. 그 머리말에 대괄호가 있으면
 * (일지의 "[검증]"·"[활동]" 을 되풀이하는 등) 첫 '[' 부터 마지막 ']' 까지 자르는 방식은 깨진다 —
 * 같은 일지가 매번 실패해 안전망이 계속 다시 부르게 된다(2026-09-17 애저 점검에서 발견).
 * 그래서 '[' 자리와 ']' 자리를 짝지어 가며 실제로 배열로 읽히는 첫 조각을 찾는다.
 */

/** 배열로 읽히는 조각이 있으면 그 배열, '[' 자체가 없으면 "none", 있는데 못 읽으면 "invalid" */
export function findJsonArray(reply: string): unknown[] | "none" | "invalid" {
  const trimmed = reply.trim();
  const whole = tryArray(trimmed);
  if (whole) return whole;

  const starts: number[] = [];
  const ends: number[] = [];
  for (let i = 0; i < reply.length; i += 1) {
    if (reply[i] === "[") starts.push(i);
    else if (reply[i] === "]") ends.push(i);
  }
  if (starts.length === 0) return "none";

  // 앞쪽 '[' 부터, 끝은 뒤쪽 ']' 부터 — 가장 긴 조각을 먼저 본다. 시도 수에 한도를 둔다.
  let tries = 0;
  for (const start of starts) {
    for (let k = ends.length - 1; k >= 0; k -= 1) {
      const end = ends[k];
      if (end <= start) break;
      if (++tries > 400) return "invalid";
      const found = tryArray(reply.slice(start, end + 1));
      if (found) return found;
    }
  }
  return "invalid";
}

function tryArray(text: string): unknown[] | null {
  if (!text.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 객체 항목만 남긴 배열. 못 찾으면 사람이 읽을 문장으로 던진다. */
export function parseObjectArray(reply: string, what: string): Array<Record<string, unknown>> {
  const found = findJsonArray(reply);
  if (found === "none") throw new Error(`AI 응답에서 ${what} 목록을 찾지 못했습니다.`);
  if (found === "invalid") throw new Error("AI 응답이 올바른 JSON이 아닙니다.");
  return found.filter((item): item is Record<string, unknown> =>
    !!item && typeof item === "object" && !Array.isArray(item)
  );
}
