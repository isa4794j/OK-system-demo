import { assertEquals } from "@std/assert";
import {
  afterCursorFilter,
  cutPage,
  decodeCursor,
  encodeCursor,
  quote,
  type SortKey,
} from "./paging.ts";

const JOURNAL_KEYS: SortKey[] = [
  { column: "journal_date", kind: "date", ascending: false },
  { column: "created_at", kind: "timestamp", ascending: false },
  { column: "id", kind: "uuid", ascending: false },
];

const ROW = {
  journal_date: "2026-08-31",
  created_at: "2026-09-10T01:33:43.827625+00:00",
  id: "4751b3a0-273b-4ec2-b1cf-30bf76317a5d",
};

Deno.test("커서는 풀면 같은 값이 나온다", () => {
  const cursor = encodeCursor(ROW, JOURNAL_KEYS);
  assertEquals(/^[A-Za-z0-9_-]+$/.test(cursor), true);
  assertEquals(decodeCursor(cursor, JOURNAL_KEYS), [ROW.journal_date, ROW.created_at, ROW.id]);
});

Deno.test("모양이 틀린 커서는 버린다 — 필터 문자열로 새지 않게", () => {
  const bad = (values: unknown) =>
    btoa(JSON.stringify(values)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  // 날짜 칸에 필터 조각을 끼워 넣은 것
  assertEquals(
    decodeCursor(bad(["2026-08-31),or(id.gt.x", ROW.created_at, ROW.id]), JOURNAL_KEYS),
    null,
  );
  assertEquals(decodeCursor(bad([ROW.journal_date, ROW.created_at]), JOURNAL_KEYS), null);
  assertEquals(
    decodeCursor(bad([ROW.journal_date, ROW.created_at, "not-a-uuid"]), JOURNAL_KEYS),
    null,
  );
  assertEquals(decodeCursor("아무거나", JOURNAL_KEYS), null);
  assertEquals(decodeCursor("", JOURNAL_KEYS), null);
  assertEquals(decodeCursor(null, JOURNAL_KEYS), null);
});

Deno.test("한글·따옴표가 든 글자 칸도 그대로 오간다", () => {
  const keys: SortKey[] = [
    { column: "title", kind: "text", ascending: true },
    { column: "id", kind: "uuid", ascending: true },
  ];
  const row = { title: '어린왕자 "특별판", (개정)', id: ROW.id };
  assertEquals(decodeCursor(encodeCursor(row, keys), keys), [row.title, row.id]);
  assertEquals(quote('a"b\\c'), '"a\\"b\\\\c"');
});

Deno.test("커서 다음 필터는 정렬 칸 순서대로 사전식 비교", () => {
  assertEquals(
    afterCursorFilter(JOURNAL_KEYS, [ROW.journal_date, ROW.created_at, ROW.id]),
    `journal_date.lt."2026-08-31",` +
      `and(journal_date.eq."2026-08-31",created_at.lt."2026-09-10T01:33:43.827625+00:00"),` +
      `and(journal_date.eq."2026-08-31",created_at.eq."2026-09-10T01:33:43.827625+00:00",` +
      `id.lt."4751b3a0-273b-4ec2-b1cf-30bf76317a5d")`,
  );
  const asc: SortKey[] = [{ column: "title", kind: "text", ascending: true }];
  assertEquals(afterCursorFilter(asc, ["가"]), `title.gt."가"`);
});

Deno.test("한 줄 더 받았을 때만 다음 커서가 있다", () => {
  const rows = [1, 2, 3].map((n) => ({ ...ROW, id: `4751b3a0-273b-4ec2-b1cf-30bf7631700${n}` }));
  const full = cutPage(rows, JOURNAL_KEYS, 2);
  assertEquals(full.items.length, 2);
  assertEquals(decodeCursor(full.next_cursor, JOURNAL_KEYS)?.[2], rows[1].id);
  const last = cutPage(rows.slice(0, 2), JOURNAL_KEYS, 2);
  assertEquals(last.next_cursor, null);
});
