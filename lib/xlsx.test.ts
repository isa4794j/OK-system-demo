import { assertEquals, assertRejects } from "@std/assert";
import { readCsv, readXlsx, SheetError } from "./xlsx.ts";
import { guessColumns, IMPORT_ROW_MAX, looksIsbn, sameBook, samePublisher } from "./book_import.ts";

/** 시험용 zip — 방식 0(무압축) 또는 8(deflate). CRC 는 리더가 안 보므로 0 */
async function zip(files: Record<string, string>, deflate: boolean): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = enc.encode(text);
    const data = deflate
      ? new Uint8Array(
        await new Response(
          new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate-raw")),
        )
          .arrayBuffer(),
      )
      : raw;
    const nameBytes = enc.encode(name);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, deflate ? 8 : 0, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, deflate ? 8 : 0, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);

    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((sum, one) => sum + one.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const all = [...locals, ...centrals, end];
  const out = new Uint8Array(all.reduce((sum, one) => sum + one.length, 0));
  let at = 0;
  for (const part of all) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const BOOK = {
  "xl/workbook.xml":
    '<workbook><sheets><sheet name="책" sheetId="1" r:id="rId1"/></sheets></workbook>',
  "xl/_rels/workbook.xml.rels":
    '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
  "xl/sharedStrings.xml":
    "<sst><si><t>도서명</t></si><si><t>지은이</t></si><si><r><t>구름</t></r><r><t>빵</t></r></si><si><t>백희나 글·그림</t></si><si><t>A &amp; B</t></si></sst>",
  "xl/worksheets/sheet1.xml": `<worksheet><sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>ISBN</t></is></c></row>
    <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="s"><v>3</v></c><c r="C2"><v>9788953527058</v></c></row>
    <row r="3"><c r="A3" t="s"><v>4</v></c><c r="C3" t="str"><v>89-7184-390-0</v></c></row>
    <row r="4"></row>
  </sheetData></worksheet>`,
};

Deno.test("xlsx — 공유·칸 안 문자열, 숫자 칸, 빈 칸 자리, 빈 줄 빼기(무압축·deflate 둘 다)", async () => {
  for (const deflate of [false, true]) {
    const rows = await readXlsx(await zip(BOOK, deflate));
    assertEquals(rows, [
      ["도서명", "지은이", "ISBN"],
      ["구름빵", "백희나 글·그림", "9788953527058"],
      ["A & B", "", "89-7184-390-0"],
    ]);
  }
});

Deno.test("xlsx — zip 이 아니면 알아듣는 말로 거절", async () => {
  await assertRejects(() => readXlsx(new TextEncoder().encode("그냥 글")), SheetError);
});

Deno.test("csv — 따옴표 안 쉼표·줄바꿈·BOM", () => {
  assertEquals(readCsv('﻿제목,저자\r\n"가, 나",홍길동\n"줄\n바꿈",""\n'), [
    ["제목", "저자"],
    ["가, 나", "홍길동"],
    ["줄\n바꿈", ""],
  ]);
});

Deno.test("ISBN 검사 자리", () => {
  assertEquals(looksIsbn("978-89-535-2705-8"), true);
  assertEquals(looksIsbn("9788953527059"), false);
  assertEquals(looksIsbn("0-306-40615-2"), true);
  assertEquals(looksIsbn("0-306-40615-3"), false);
});

/** 앞 12자리에 검사 자리를 붙인 ISBN-13 */
function isbn13(head: string): string {
  const sum = [...head].reduce((acc, ch, i) => acc + Number(ch) * (i % 2 ? 3 : 1), 0);
  return head + String((10 - (sum % 10)) % 10);
}

Deno.test("열 추정 — 이름이 엉뚱해도 내용으로", () => {
  const rows = [
    ["가", "나", "다", "라"],
    ["1", "구름빵 (그림책)", "백희나 글", "9788953527058"],
    ["2", "강아지똥", "권정생 지음", isbn13("978897094449")],
    ["3", "마당을 나온 암탉", "황선미 지음", isbn13("978897196258")],
    ["4", "괭이부리말 아이들", "김중미 지음", isbn13("978893644163")],
  ];
  const { hasHeader, columns } = guessColumns(rows);
  assertEquals(hasHeader, true);
  assertEquals(columns.map((one) => one.role), ["reg_no", "title", "author", "isbn"]);
});

Deno.test("열 추정 — 머리 없이 제목만 있는 표", () => {
  const { hasHeader, columns } = guessColumns([["어린 왕자"], ["모모"], ["나니아 연대기"]]);
  assertEquals(hasHeader, false);
  assertEquals(columns[0].role, "title");
});

Deno.test("같은 책인가 — 부제·띄어쓰기는 보지 않고, 저자를 줬으면 겹쳐야", () => {
  assertEquals(sameBook({ title: "구름 빵" }, { title: "구름빵 : 백희나 그림책" }), true);
  assertEquals(
    sameBook({ title: "구름빵", author: "백희나" }, { title: "구름빵", author: "백희나 글·그림" }),
    true,
  );
  assertEquals(
    sameBook({ title: "구름빵", author: "김철수" }, { title: "구름빵", author: "백희나" }),
    false,
  );
  assertEquals(sameBook({ title: "구름" }, { title: "구름빵" }), false);
});

Deno.test("열 추정 — 입수경위는 열 이름으로(분류로 잡히지 않게)", () => {
  const { columns } = guessColumns([
    ["도서명", "입수경위", "분류"],
    ["모모", "기증", "문학"],
    ["어린 왕자", "기증", "문학"],
    ["나니아 연대기", "구입", "판타지"],
    ["괭이부리말 아이들", "기증", "문학"],
  ]);
  assertEquals(columns.map((one) => one.role), ["title", "acquired_via", "center_class"]);
});

Deno.test("xlsx — 깨진 zip 은 알아듣는 말로(목록이 파일 밖을 가리킴)", async () => {
  const end = new Uint8Array(22);
  const view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, 0xffff, true);
  view.setUint16(10, 0xffff, true);
  view.setUint32(12, 0xffffffff, true);
  view.setUint32(16, 0xffffffff, true);
  await assertRejects(() => readXlsx(end), SheetError);
});

Deno.test("열 추정 — 머리줄만 있으면 책 줄이 없다", () => {
  const { hasHeader, data } = guessColumns([["제목", "저자"]]);
  assertEquals(hasHeader, true);
  assertEquals(data.length, 0);
  // 한 줄짜리 책 목록은 그대로 책
  assertEquals(guessColumns([["어린 왕자"]]).data.length, 1);
});

/** 프로그램(OpenXML SDK)이 만든 파일 모양 — 태그마다 x: 접두어, 칸은 t="str", rels 는 절대 경로 */
function prefixedBook(count: number): Record<string, string> {
  const rows = [
    '<x:row r="1"><x:c r="A1" t="str"><x:v>책제목</x:v></x:c><x:c r="B1" t="str"><x:v>출판사</x:v></x:c><x:c r="C1" t="str"><x:v>센터등록번호</x:v></x:c></x:row>',
  ];
  for (let i = 1; i <= count; i += 1) {
    const r = i + 1;
    rows.push(
      `<x:row r="${r}"><x:c r="A${r}" t="str"><x:v>책 ${i}</x:v></x:c><x:c r="B${r}" t="str"><x:v>문학동네</x:v></x:c><x:c r="C${r}" t="n"><x:v>${
        i + 9
      }</x:v></x:c></x:row>`,
    );
  }
  return {
    "xl/workbook.xml":
      '<?xml version="1.0"?><x:workbook xmlns:x="m"><x:sheets><x:sheet name="도서목록" sheetId="1" r:id="R17" xmlns:r="r"/></x:sheets></x:workbook>',
    "xl/_rels/workbook.xml.rels":
      '﻿<?xml version="1.0"?><Relationships><Relationship Target="/xl/worksheets/sheet1.xml" Id="R17"/></Relationships>',
    "xl/sharedStrings.xml": '<?xml version="1.0"?><x:sst xmlns:x="m" />',
    "xl/worksheets/sheet1.xml": `<?xml version="1.0"?><x:worksheet xmlns:x="m"><x:sheetData>${
      rows.join("")
    }</x:sheetData></x:worksheet>`,
  };
}

Deno.test("xlsx — 태그 접두어(x:) 파일도 읽고, 제목·출판사·센터등록번호로 추정", async () => {
  const rows = await readXlsx(await zip(prefixedBook(3), true));
  assertEquals(rows[0], ["책제목", "출판사", "센터등록번호"]);
  assertEquals(rows[3], ["책 3", "문학동네", "12"]);
  const { hasHeader, columns, data } = guessColumns(rows);
  assertEquals(hasHeader, true);
  assertEquals(columns.map((one) => one.role), ["title", "publisher", "reg_no"]);
  assertEquals(data.length, 3);
});

Deno.test("xlsx — 100줄 경계: 머리+100줄은 100권, 101줄은 넘친다고 알 수 있게", async () => {
  for (const [count, want] of [[100, 100], [101, 101]] as const) {
    const rows = await readXlsx(await zip(prefixedBook(count), false), IMPORT_ROW_MAX + 2);
    const { data } = guessColumns(rows);
    assertEquals(data.length, want);
    assertEquals(data.length > IMPORT_ROW_MAX, count > IMPORT_ROW_MAX);
  }
});

Deno.test("같은 출판사인가 — (주)·출판사 꼬리 무시, 비면 아니다", () => {
  assertEquals(samePublisher("한림출판사", "한림"), true);
  assertEquals(samePublisher("(주)비룡소", "비룡소"), true);
  assertEquals(samePublisher("창비", "창비교육"), true);
  assertEquals(samePublisher("창비", "민음사"), false);
  assertEquals(samePublisher("창비", null), false);
  assertEquals(samePublisher("", "창비"), false);
});
