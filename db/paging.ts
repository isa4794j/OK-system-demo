/**
 * 목록 나눠 받기 — 커서(keyset) 방식
 *
 * [왜 offset 이 아닌가]
 * "16번째부터 15개" 는 그 사이에 한 줄이 새로 들어오면 한 줄이 두 번 보이거나 빠진다.
 * 일지·감사 로그처럼 계속 쌓이는 목록에서 그 일이 잦다.
 * 커서는 "마지막으로 본 줄의 정렬 값 다음부터" 라 끼어든 줄에 흔들리지 않는다.
 *
 * [커서 모양]
 * 정렬 칸의 값들(마지막 줄 것)을 JSON 배열로 묶어 base64url 로 싼 글자.
 * 화면은 속을 몰라도 된다 — 받은 next_cursor 를 그대로 돌려보내면 된다.
 *
 * [값 검사]
 * 커서는 브라우저에서 오므로 PostgREST 필터 문자열에 넣기 전에 칸마다 모양을 확인한다
 * (날짜·시각·uuid·글자). 모양이 틀리면 커서를 버린다. 글자 칸은 따옴표로 감싸고
 * 따옴표·역슬래시를 escape 한다 — 쉼표·괄호가 들어 있어도 필터가 깨지지 않는다.
 */

/** 한 번에 내려주는 줄 수 */
export const PAGE_SIZE = 15;

export type KeyKind = "date" | "timestamp" | "uuid" | "text";

export type SortKey = {
  column: string;
  kind: KeyKind;
  ascending: boolean;
};

const CHECKS: Record<KeyKind, (value: string) => boolean> = {
  date: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v),
  timestamp: (v) => /^\d{4}-\d{2}-\d{2}T[\d:.]+([+-]\d{2}:\d{2}|Z)$/.test(v),
  uuid: (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
  text: (v) => v.length <= 500,
};

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): string {
  const base64 = text.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0)));
}

/** 마지막 줄에서 커서를 만든다 */
export function encodeCursor(row: Record<string, unknown>, keys: SortKey[]): string {
  return toBase64Url(JSON.stringify(keys.map((key) => String(row[key.column] ?? ""))));
}

/** 커서를 푼다. 모양이 틀리면 null — 부르는 쪽은 400 으로 돌려준다. */
export function decodeCursor(raw: string | null | undefined, keys: SortKey[]): string[] | null {
  if (!raw) return null;
  if (raw.length > 2000 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const values = JSON.parse(fromBase64Url(raw));
    if (!Array.isArray(values) || values.length !== keys.length) return null;
    const ok = values.every((value, i) => typeof value === "string" && CHECKS[keys[i].kind](value));
    return ok ? values : null;
  } catch {
    return null;
  }
}

/**
 * "이 글자가 들어 있다" 검색 값 — LIKE 특수 글자(% _ \)는 글자 그대로, 전체는 따옴표로 감싼다.
 * PostgREST 의 or() 안에 넣어도 쉼표·괄호·따옴표가 문법을 깨지 않는다(일지·도서 검색이 같이 쓴다).
 */
export function containsPattern(text: string): string {
  return quote(`%${text.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
}

/** PostgREST 필터 값. 늘 따옴표로 감싼다. */
export function quote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * "커서 다음" 을 뜻하는 or 필터. 정렬 칸 순서대로 사전식으로 비교한다.
 *
 *   (a, b, c) 내림차순, 커서 (A, B, C)
 *   → a < A  또는  (a = A 이고 b < B)  또는  (a = A, b = B 이고 c < C)
 */
export function afterCursorFilter(keys: SortKey[], values: string[]): string {
  const parts: string[] = [];
  for (let i = 0; i < keys.length; i += 1) {
    const equal = keys.slice(0, i).map((key, j) => `${key.column}.eq.${quote(values[j])}`);
    const op = keys[i].ascending ? "gt" : "lt";
    const last = `${keys[i].column}.${op}.${quote(values[i])}`;
    parts.push(equal.length === 0 ? last : `and(${[...equal, last].join(",")})`);
  }
  return parts.join(",");
}

/**
 * 한 줄 더 받아 다음 쪽이 있는지 안다. 받은 줄과 다음 커서를 돌려준다.
 * rows 는 limit + 1 개까지 받은 것이어야 한다.
 */
export function cutPage<T extends Record<string, unknown>>(
  rows: T[],
  keys: SortKey[],
  limit: number,
): { items: T[]; next_cursor: string | null } {
  const items = rows.slice(0, limit);
  const more = rows.length > limit;
  return {
    items,
    next_cursor: more && items.length > 0 ? encodeCursor(items[items.length - 1], keys) : null,
  };
}
