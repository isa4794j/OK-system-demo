/**
 * 엑셀(xlsx)·CSV 표 읽기 — 첫 시트의 칸 글자만 꺼낸다(서식·수식·날짜 해석 없음)
 *
 * xlsx 는 zip 안에 XML 이 든 파일이다. 라이브러리를 들이지 않고 필요한 만큼만 읽는다:
 *   zip 목록(중앙 디렉터리) → xl/workbook.xml 의 첫 시트 → 그 시트 XML 의 <row>/<c>
 *   공유 문자열(xl/sharedStrings.xml)과 칸 안 문자열(inlineStr)을 풀어 글자로.
 * 압축은 zip 의 deflate(방식 8)와 무압축(0)만 받는다 — 엑셀이 만드는 파일은 이 둘이다.
 * 태그 접두어(<x:row> 처럼 프로그램이 만든 파일)는 읽기 전에 떼어 낸다 — 엑셀이 만든 파일과 같은 모양으로.
 *
 * 받은 파일은 메모리에서만 쓰고 어디에도 저장하지 않는다(사진과 같은 원칙).
 */

export class SheetError extends Error {}

/* ---------- zip ---------- */

type ZipEntry = { name: string; method: number; compressedSize: number; offset: number };

function u16(view: DataView, at: number): number {
  return view.getUint16(at, true);
}
function u32(view: DataView, at: number): number {
  return view.getUint32(at, true);
}

function listZip(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // 끝 표시(End of Central Directory)는 맨 뒤 22바이트 + 주석(최대 65535) 안에 있다
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 65535); at -= 1) {
    if (u32(view, at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new SheetError("엑셀(xlsx) 파일이 아니거나 손상됐습니다.");

  const count = u16(view, end + 10);
  let at = u32(view, end + 16);
  const entries: ZipEntry[] = [];
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i += 1) {
    if (u32(view, at) !== 0x02014b50) throw new SheetError("엑셀 파일 목록을 읽지 못했습니다.");
    const method = u16(view, at + 10);
    const compressedSize = u32(view, at + 20);
    const nameLen = u16(view, at + 28);
    const extraLen = u16(view, at + 30);
    const commentLen = u16(view, at + 32);
    const offset = u32(view, at + 42);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    entries.push({ name, method, compressedSize, offset });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function readEntry(bytes: Uint8Array, entry: ZipEntry): Promise<string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = entry.offset;
  if (u32(view, at) !== 0x04034b50) throw new SheetError("엑셀 파일 안쪽을 읽지 못했습니다.");
  const start = at + 30 + u16(view, at + 26) + u16(view, at + 28);
  const data = bytes.subarray(start, start + entry.compressedSize);

  let raw: Uint8Array;
  if (entry.method === 0) {
    raw = data;
  } else if (entry.method === 8) {
    const stream = new Blob([data.slice()]).stream().pipeThrough(
      new DecompressionStream("deflate-raw"),
    );
    raw = new Uint8Array(await new Response(stream).arrayBuffer());
  } else {
    throw new SheetError(
      "이 엑셀 파일의 압축 방식은 읽을 수 없습니다. 다른 이름으로 저장(xlsx) 뒤 다시 올려 주세요.",
    );
  }
  return withoutPrefix(new TextDecoder().decode(raw));
}

/** <x:row …> → <row …>, </x:c> → </c> — 속성의 접두어(r:id)는 그대로 둔다 */
export function withoutPrefix(xml: string): string {
  return xml.replace(/<(\/?)[A-Za-z_][\w.-]*:(?=[A-Za-z_])/g, "<$1");
}

/* ---------- XML 조각 ---------- */

function decodeXml(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** 한 조각 안의 <t>…</t> 를 모두 이어 붙인다(서식 있는 글자는 여러 조각이다). 읽는 소리 <rPh> 는 뺀다 */
function textOf(xml: string): string {
  const clean = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  let out = "";
  for (const m of clean.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) out += decodeXml(m[1]);
  return out;
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? m[1] : null;
}

/** "AB12" → 27 (0 부터) */
function columnIndex(ref: string): number {
  const letters = ref.replace(/[^A-Z]/gi, "").toUpperCase();
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/* ---------- 읽기 ---------- */

/**
 * xlsx 의 첫 시트를 줄×칸 글자로. 빈 줄은 뺀다.
 * 모양이 깨진 파일(zip 목록이 파일 밖을 가리키는 등)은 알아듣는 말(SheetError)로 바꾼다 — 500 으로 새지 않게.
 */
export async function readXlsx(bytes: Uint8Array, maxRows = 1000): Promise<string[][]> {
  try {
    return await readXlsxRaw(bytes, maxRows);
  } catch (error) {
    if (error instanceof SheetError) throw error;
    throw new SheetError(
      "엑셀 파일이 깨졌거나 읽을 수 없는 모양입니다. 엑셀에서 .xlsx 로 다시 저장해 올려 주세요.",
    );
  }
}

async function readXlsxRaw(bytes: Uint8Array, maxRows: number): Promise<string[][]> {
  const entries = listZip(bytes);
  const byName = new Map(entries.map((one) => [one.name, one]));
  const read = async (name: string) => {
    const entry = byName.get(name);
    return entry ? await readEntry(bytes, entry) : null;
  };

  // 첫 시트의 경로 — workbook.xml 의 첫 <sheet> → rels 의 Target
  let sheetPath = "xl/worksheets/sheet1.xml";
  const workbook = await read("xl/workbook.xml");
  const rels = await read("xl/_rels/workbook.xml.rels");
  if (workbook && rels) {
    const first = workbook.match(/<sheet\b[^>]*>/);
    const rid = first ? (attr(first[0], "r:id") ?? attr(first[0], "id")) : null;
    if (rid) {
      for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
        if (attr(m[0], "Id") !== rid) continue;
        const target = attr(m[0], "Target") ?? "";
        sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
      }
    }
  }
  const sheet = await read(sheetPath);
  if (!sheet) throw new SheetError("엑셀 파일에서 시트를 찾지 못했습니다.");

  const shared: string[] = [];
  const sst = await read("xl/sharedStrings.xml");
  if (sst) {
    for (const m of sst.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
      shared.push(textOf(m[1]));
    }
  }

  const rows: string[][] = [];
  for (const rowMatch of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: string[] = [];
    let auto = 0;
    for (const cell of rowMatch[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const head = `<c${cell[1]}>`;
      const body = cell[2] ?? "";
      const ref = attr(head, "r");
      const index = ref ? columnIndex(ref) : auto;
      auto = index + 1;
      const type = attr(head, "t");
      const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      let value = "";
      if (type === "s" && v !== undefined) value = shared[Number(v)] ?? "";
      else if (type === "inlineStr") value = textOf(body);
      else if (v !== undefined) value = decodeXml(v);
      row[index] = value.trim();
    }
    const filled = Array.from(row, (one) => one ?? "");
    if (filled.some((one) => one !== "")) rows.push(filled);
    if (rows.length > maxRows) break;
  }
  return rows;
}

/** CSV(쉼표, 큰따옴표 묶음) — 엑셀이 저장한 한글 CSV(UTF-8 BOM)도 */
export function readCsv(text: string, maxRows = 1000): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell.trim());
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i += 1;
      row.push(cell.trim());
      if (row.some((one) => one !== "")) rows.push(row);
      if (rows.length > maxRows) return rows;
      row = [];
      cell = "";
    } else cell += ch;
  }
  row.push(cell.trim());
  if (row.some((one) => one !== "")) rows.push(row);
  return rows;
}
