/**
 * 엑셀 일괄 등록 — 열이 무엇인지 내용을 보고 추정한다(확정은 사람)
 *
 * 양식이 자유라 열 이름을 믿지 않는다. 칸 내용을 본다:
 *   ISBN      하이픈을 빼면 10·13자리(끝 X)이고 검사 자리가 맞는 칸이 많다
 *   등록번호   짧고(12자 안) 숫자가 들어 있고 줄마다 거의 다르다
 *   제목      글자가 가장 긴 글 칸
 *   저자      "지음·글·그림·옮김·엮음" 이 붙거나, 짧은 이름 모양(2~4자, 쉼표로 여럿)
 *   센터분류   짧은 글이 몇 가지로만 되풀이된다
 *   출판사     열 이름("출판사·펴낸곳·발행처")으로 — 검색 결과가 여럿일 때 좁히는 데 쓴다
 * 열 이름(첫 줄)은 내용이 애매할 때만 거든다. 추정은 제안이고 화면에서 사람이 고친다(원칙 6).
 */

export const IMPORT_ROLES = [
  "title",
  "author",
  "publisher",
  "isbn",
  "reg_no",
  "center_class",
  "acquired_via",
  "note",
  "ignore",
] as const;
export type ImportRole = typeof IMPORT_ROLES[number];

export const IMPORT_ROW_MAX = 100;

export type ColumnGuess = {
  index: number;
  /** 첫 줄이 머리일 때 그 글자, 아니면 "열 A" */
  header: string;
  samples: string[];
  role: ImportRole;
  /** 왜 그렇게 봤는지 한 줄 */
  reason: string;
};

/** ISBN 모양 + 검사 자리 */
export function looksIsbn(value: string): boolean {
  const s = value.replace(/[\s-]/g, "").toUpperCase();
  if (/^\d{13}$/.test(s)) {
    const sum = [...s.slice(0, 12)].reduce((acc, ch, i) => acc + Number(ch) * (i % 2 ? 3 : 1), 0);
    return (10 - (sum % 10)) % 10 === Number(s[12]);
  }
  if (/^\d{9}[\dX]$/.test(s)) {
    const sum = [...s.slice(0, 9)].reduce((acc, ch, i) => acc + Number(ch) * (10 - i), 0);
    const check = (11 - (sum % 11)) % 11;
    return (check === 10 ? "X" : String(check)) === s[9];
  }
  return false;
}

const HEADER_WORDS: Record<Exclude<ImportRole, "ignore" | "note" | "acquired_via">, RegExp> = {
  title: /제목|서명|도서명|책\s*이름|title/i,
  author: /저자|지은이|작가|글쓴이|author/i,
  publisher: /출판|펴낸\s*곳|발행처|publisher/i,
  isbn: /isbn/i,
  reg_no: /등록\s*번호|등록no|자료\s*번호|관리\s*번호|reg/i,
  center_class: /분류|구분|서가|class/i,
};
const NOTE_WORD = /비고|메모|note|참고/i;
const VIA_WORD = /입수|기증|구입|출처|후원/i;

const AUTHOR_MARK = /(지음|글|그림|옮김|엮음|저|역|편|著)\s*$|[,;]\s*\S/;
const NAME_LIKE = /^[가-힣]{2,4}(\s*[,·]\s*[가-힣]{2,4})*$/;

function letter(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

type Stats = {
  filled: number;
  isbn: number;
  digits: number;
  avgLen: number;
  unique: number;
  author: number;
  numeric: number;
};

function statsOf(values: string[]): Stats {
  const cells = values.filter((one) => one !== "");
  const n = Math.max(cells.length, 1);
  return {
    filled: cells.length / Math.max(values.length, 1),
    isbn: cells.filter(looksIsbn).length / n,
    digits: cells.filter((one) => /\d/.test(one)).length / n,
    avgLen: cells.reduce((sum, one) => sum + one.length, 0) / n,
    unique: new Set(cells).size / n,
    author: cells.filter((one) => AUTHOR_MARK.test(one) || NAME_LIKE.test(one)).length / n,
    numeric: cells.filter((one) => /^[\d.\-\s]+$/.test(one)).length / n,
  };
}

/** 첫 줄이 머리인가 — 머리 낱말이 있거나, ISBN 열의 첫 칸만 ISBN 이 아니면 */
function detectHeader(rows: string[][]): boolean {
  if (rows.length === 0) return false;
  const first = rows[0];
  const words = Object.values(HEADER_WORDS);
  const isWord = (cell: string) =>
    words.some((re) => re.test(cell)) || NOTE_WORD.test(cell) || VIA_WORD.test(cell);
  // 한 줄뿐이면 칸이 모두 열 이름일 때만 머리로 본다("제목,저자" 만 있는 파일 → 책이 없다고 알린다)
  if (rows.length === 1) {
    const cells = first.filter((cell) => cell.trim());
    return cells.length > 0 && cells.every(isWord);
  }
  if (first.some(isWord)) return true;
  const width = Math.max(...rows.map((row) => row.length));
  for (let c = 0; c < width; c += 1) {
    const below = rows.slice(1).map((row) => row[c] ?? "");
    if (statsOf(below).isbn >= 0.6 && !looksIsbn(first[c] ?? "")) return true;
  }
  return false;
}

export function guessColumns(
  rows: string[][],
): { hasHeader: boolean; columns: ColumnGuess[]; data: string[][] } {
  const hasHeader = detectHeader(rows);
  const data = hasHeader ? rows.slice(1) : rows;
  const width = Math.max(0, ...rows.map((row) => row.length));
  const columns: (ColumnGuess & { stats: Stats })[] = [];
  for (let c = 0; c < width; c += 1) {
    const values = data.map((row) => row[c] ?? "");
    const header = hasHeader && rows[0][c] ? rows[0][c] : `열 ${letter(c)}`;
    columns.push({
      index: c,
      header,
      samples: values.filter(Boolean).slice(0, 3),
      role: "ignore",
      reason: "",
      stats: statsOf(values),
    });
  }
  const free = () => columns.filter((one) => one.role === "ignore" && one.stats.filled > 0);
  const byHeader = (role: keyof typeof HEADER_WORDS) =>
    hasHeader ? free().find((one) => HEADER_WORDS[role].test(one.header)) : undefined;
  // 내용으로 짐작할 때는 열 이름이 다른 뜻을 말하는 열(예: "분류")은 건너뛴다
  const named = (header: string) =>
    Object.values(HEADER_WORDS).some((re) => re.test(header)) || NOTE_WORD.test(header);
  const unnamed = () => free().filter((one) => !hasHeader || !named(one.header));

  // 0) 입수경위 — 열 이름으로만(내용으로는 가리기 어렵다). 분류로 잘못 잡히지 않게 먼저
  const via = hasHeader ? free().find((one) => VIA_WORD.test(one.header)) : undefined;
  if (via) {
    via.role = "acquired_via";
    via.reason = "열 이름이 입수경위";
  }

  // 1) ISBN — 형식이 가장 확실하다
  const isbn =
    free().filter((one) => one.stats.isbn >= 0.6).sort((a, b) => b.stats.isbn - a.stats.isbn)[0];
  if (isbn) {
    isbn.role = "isbn";
    isbn.reason = `ISBN 모양 칸 ${Math.round(isbn.stats.isbn * 100)}%`;
  }

  // 2) 등록번호 — 짧고 숫자가 있고 거의 다 다르다
  const reg = byHeader("reg_no") ??
    unnamed()
      .filter((one) => one.stats.avgLen <= 12 && one.stats.digits >= 0.8 && one.stats.unique >= 0.9)
      .sort((a, b) => b.stats.unique - a.stats.unique || a.stats.avgLen - b.stats.avgLen)[0];
  if (reg) {
    reg.role = "reg_no";
    reg.reason = HEADER_WORDS.reg_no.test(reg.header)
      ? "열 이름이 등록번호"
      : `짧은 번호(평균 ${reg.stats.avgLen.toFixed(0)}자), 줄마다 다름`;
  }

  // 3) 제목 — 숫자만이 아닌 글 칸 중 가장 길다
  const texts = () => unnamed().filter((one) => one.stats.numeric < 0.5);
  const title = byHeader("title") ?? texts().sort((a, b) => b.stats.avgLen - a.stats.avgLen)[0];
  if (title) {
    title.role = "title";
    title.reason = HEADER_WORDS.title.test(title.header)
      ? "열 이름이 제목"
      : `가장 긴 글(평균 ${title.stats.avgLen.toFixed(0)}자)`;
  }

  // 4) 저자 — 저자 표시·이름 모양
  const author = byHeader("author") ??
    texts().filter((one) => one.stats.author >= 0.3).sort((a, b) =>
      b.stats.author - a.stats.author
    )[0];
  if (author) {
    author.role = "author";
    author.reason = HEADER_WORDS.author.test(author.header)
      ? "열 이름이 저자"
      : `이름·지음 모양 ${Math.round(author.stats.author * 100)}%`;
  }

  // 4-1) 출판사 — 열 이름으로만(내용은 제목·분류와 가리기 어렵다)
  const publisher = byHeader("publisher");
  if (publisher) {
    publisher.role = "publisher";
    publisher.reason = "열 이름이 출판사";
  }

  // 5) 센터분류 — 짧은 글이 몇 가지로만 되풀이
  const cls = byHeader("center_class") ??
    texts().filter((one) =>
      one.stats.avgLen <= 10 && one.stats.unique <= 0.5 && data.length >= 4
    )[0];
  if (cls) {
    cls.role = "center_class";
    cls.reason = HEADER_WORDS.center_class.test(cls.header)
      ? "열 이름이 분류"
      : "짧은 글이 몇 가지로 되풀이";
  }

  // 6) 비고 — 열 이름으로만
  const note = hasHeader ? free().find((one) => NOTE_WORD.test(one.header)) : undefined;
  if (note) {
    note.role = "note";
    note.reason = "열 이름이 비고";
  }

  for (const one of columns) {
    if (one.role === "ignore") one.reason ||= "쓰지 않음(골라서 바꿀 수 있음)";
  }
  return { hasHeader, columns: columns.map(({ stats: _s, ...rest }) => rest), data };
}

/** 출판사가 같은가 — (주)·주식회사·출판사 같은 꼬리는 떼고 한쪽이 다른 쪽을 품으면 같다고 본다 */
export function samePublisher(want: string, have: string | null | undefined): boolean {
  const norm = (text: string) =>
    text.toLowerCase()
      .replace(/\(주\)|㈜|주식회사|출판사|출판그룹|출판/g, "")
      .replace(/[\s\p{P}\p{S}]/gu, "");
  const a = norm(want);
  const b = norm(have ?? "");
  return a.length > 0 && b.length > 0 && (a.includes(b) || b.includes(a));
}

/** 검색 결과가 그 줄의 책이라고 자신할 만한가 — 제목이 (띄어쓰기·기호 빼고) 같고, 저자를 줬으면 겹친다 */
export function sameBook(
  row: { title: string; author?: string | null },
  item: { title: string; author?: string | null },
): boolean {
  const norm = (text: string) => text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
  const main = (text: string) => norm(text.split(/[:=(]/)[0]);
  if (!row.title || main(row.title) !== main(item.title)) return false;
  if (!row.author) return true;
  const want = norm(row.author).replace(/(지음|글|그림|옮김|엮음)/g, "");
  const have = norm(item.author ?? "");
  return want.length > 0 && have.includes(want.slice(0, Math.min(want.length, 3)));
}
