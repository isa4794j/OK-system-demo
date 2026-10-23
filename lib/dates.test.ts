import { assertEquals } from "@std/assert";
import {
  addYears,
  checkChildBirth,
  checkEnrollDate,
  checkJournalDate,
  FUTURE_VOLUNTEER_JOURNAL,
  todayInSeoul,
} from "./dates.ts";

const TODAY = "2026-09-17";

Deno.test("서울 날짜 — UTC 로 전날 밤 16시는 서울로 다음 날", () => {
  assertEquals(todayInSeoul(new Date("2026-09-16T16:30:00Z")), "2026-09-17");
  assertEquals(todayInSeoul(new Date("2026-09-16T14:59:00Z")), "2026-09-16");
});

Deno.test("해 더하기 — 윤날은 말일로", () => {
  assertEquals(addYears("2026-09-17", 1), "2027-09-17");
  assertEquals(addYears("2028-02-29", 1), "2029-02-28");
  assertEquals(addYears("2025-12-31", 1), "2026-12-31");
});

Deno.test("아동 생년월일 — 2000년 ~ 오늘", () => {
  assertEquals(checkChildBirth("2000-01-01", TODAY), null);
  assertEquals(checkChildBirth("2026-09-17", TODAY), null);
  assertEquals(checkChildBirth("1999-12-31", TODAY) !== null, true);
  assertEquals(checkChildBirth("2026-09-18", TODAY) !== null, true);
  assertEquals(checkChildBirth("2999-01-01", TODAY) !== null, true);
});

Deno.test("입소일 — 1년 뒤까지", () => {
  assertEquals(checkEnrollDate("2027-09-17", TODAY), null);
  assertEquals(checkEnrollDate("2027-09-18", TODAY) !== null, true);
  assertEquals(checkEnrollDate("2010-01-01", TODAY), null);
});

Deno.test("일지 날짜 — 봉사일지는 오늘까지, 종사자 일지는 1년 뒤까지", () => {
  assertEquals(checkJournalDate("봉사", TODAY, TODAY), null);
  assertEquals(checkJournalDate("봉사", "2026-09-18", TODAY), FUTURE_VOLUNTEER_JOURNAL);
  for (const kind of ["프로그램", "일상", "회의록"]) {
    assertEquals(checkJournalDate(kind, "2027-09-17", TODAY), null);
    assertEquals(checkJournalDate(kind, "2027-09-18", TODAY) !== null, true);
  }
});
