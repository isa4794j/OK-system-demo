/**
 * ISBN 으로 서지정보 찾기 — 외부 도서 API 로 나가는 유일한 문
 *
 * [키를 읽는 곳은 여기뿐이다]
 * Supabase 키는 db/client.ts, Claude 키는 lib/ai.ts 에서만 읽는 것과 같은 규칙이다.
 * 환경변수 이름은 아래 두 줄에 둔다.
 *
 * [AI 가 아니다]
 * 여기는 도서관 공개 API 다. callAISafe 를 거치지 않는다.
 * 나가는 것은 ISBN 하나뿐이고, 사람 이름이 실릴 자리가 없다.
 *
 * [두 곳에 묻는다]
 *   1차  국립중앙도서관 서지정보(seoji)  — 제목·저자·출판사·발행년·KDC·표지
 *   2차  도서관 정보나루(data4library)   — 책소개. 국중에 없는 칸만 채운다.
 * 국중이 못 찾거나 실패하면 정보나루 것만으로 채운다. 둘 다 못 찾으면 "없음" 이다.
 * "없음" 과 "연결 실패" 는 다르다 — 앞은 사람이 직접 적으면 되고, 뒤는 고쳐야 한다.
 * 그래서 실패는 null 이 아니라 BookLookupError 로 던진다.
 *
 * [두 곳에 동시에 묻는다]
 * 차례로 물으면 한 곳이 느릴 때 기다리는 시간이 두 배가 된다. 사람이 버튼을 누르고
 * 보는 화면이라 그만큼이 그대로 답답함이 된다. 그래서 함께 보내고 국중 값을 앞세운다.
 *
 * [제목·저자로도 찾는다]
 * 두 API 모두 제목·저자 검색을 지원한다(아래 각 함수의 주석에 문서 근거를 적었다).
 * 국중은 제목이 정확히 걸리고, 정보나루는 대출 많은 순으로 준다.
 * 둘을 함께 물어 ISBN 으로 합친다 — 한쪽에만 있는 책이 적지 않다.
 *
 * [감싼 모양을 가정하지 않는다]
 * 두 API 모두 칸 이름은 공개 문서에 있는데, 그 칸을 감싸는 모양(docs / response.detail …)은
 * 문서에 없다. 키가 있어야 눈으로 볼 수 있는 것이라, 없는 모양을 지어내면
 * 나중에 조용히 어긋난다. 그래서 문서에 있는 "칸 이름"으로만 찾는다.
 */
import { normalizeIsbn } from "../db/books.ts";

/** 환경변수 이름. .env 와 Deno Deploy 에 이 이름으로 넣는다. */
export const NLK_KEY_ENV = "NLK_API_KEY";
export const DATA4LIBRARY_KEY_ENV = "DATA4LIBRARY_API_KEY";

/** 한 곳을 기다리는 시간. 넘으면 끊는다. 사람이 버튼 앞에서 기다리는 화면이다. */
const TIMEOUT_MS = 5000;

const NLK_URL = "https://www.nl.go.kr/seoji/SearchApi.do";
const DATA4LIBRARY_URL = "https://data4library.kr/api/srchDtlList";
const DATA4LIBRARY_SEARCH_URL = "https://data4library.kr/api/srchBooks";

/** 한 번에 받아 오는 줄 수. 한 화면에 담기고, [더 보기]로 이어 받는다. */
export const SEARCH_PAGE_SIZE = 10;

/** ISBN-10 은 끝이 X 일 수 있다. ISBN-13 은 숫자만. */
const ISBN_RE = /^(\d{9}[\dX]|\d{13})$/;

/** API 가 돌려줄 것. 우리 books 표의 칸과 이름을 맞춰 두어 그대로 흘려보낼 수 있게 한다. */
export type BookLookup = {
  isbn: string;
  title: string;
  author: string | null;
  publisher: string | null;
  published_year: number | null;
  kdc: string | null;
  cover_url: string | null;
  /**
   * 책소개. books 표에는 이 칸이 없다.
   * 화면이 비고가 비어 있을 때만 넣어 주고, 사람이 보고 지우거나 고칠 수 있게 한다.
   */
  description: string | null;
  /** 어느 곳에서 받아왔는지. 화면에 적어 사람이 무엇을 믿을지 알게 한다. */
  sources: string[];
};

/**
 * 왜 실패했는지. 화면이 사람에게 다르게 말해 줄 수 있게 갈라 둔다.
 *   auth     키가 틀렸거나 권한이 없다 — 관리자가 고쳐야 한다
 *   network  연결이 안 되거나 너무 오래 걸린다 — 다시 눌러 보면 된다
 *   api      그 밖에 상대가 거절한 것
 */
export type LookupFailure = "auth" | "network" | "api";

export class BookLookupError extends Error {
  constructor(message: string, readonly kind: LookupFailure) {
    super(message);
  }
}

/* ---------- 공통 ---------- */

/**
 * 파싱한 값 어디에 있든 그 이름의 칸을 찾아 첫 값을 준다.
 * 이름은 앞에 적은 것부터 찾는다.
 */
function findValue(node: unknown, name: string): string | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findValue(item, name);
      if (found) return found;
    }
    return null;
  }

  if (node && typeof node === "object") {
    const record = node as Record<string, unknown>;
    const own = record[name];
    if (typeof own === "string" && own.trim()) return own.trim();
    if (typeof own === "number") return String(own);

    for (const value of Object.values(record)) {
      const found = findValue(value, name);
      if (found) return found;
    }
  }
  return null;
}

function pick(node: unknown, ...names: string[]): string | null {
  for (const name of names) {
    const found = findValue(node, name);
    if (found) return found;
  }
  return null;
}

/** "20220509" 나 "2022" 에서 연도만 꺼낸다. 못 읽으면 null. */
function toYear(value: string | null): number | null {
  const match = value ? /(\d{4})/.exec(value) : null;
  if (!match) return null;
  const year = Number(match[1]);
  return year >= 1000 && year <= 9999 ? year : null;
}

/**
 * 정해진 시간 안에 JSON 을 받아 온다.
 * 시간이 넘거나 연결이 안 되면 던진다 — 화면이 멈춰 있으면 안 된다.
 */
async function fetchJson(url: URL, where: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new BookLookupError(
      timedOut
        ? `${where} 가 ${TIMEOUT_MS / 1000}초 안에 답하지 않았습니다.`
        : `${where} 에 연결하지 못했습니다.`,
      "network",
    );
  }

  if (!response.ok) {
    // 본문을 읽어 버려야 연결이 남지 않는다
    await response.body?.cancel();
    throw new BookLookupError(`${where} 가 HTTP ${response.status} 로 답했습니다.`, "api");
  }

  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new BookLookupError(`${where} 의 응답을 읽지 못했습니다.`, "api");
  }
}

/* ---------- 국립중앙도서관 서지정보 ---------- */

/**
 * https://www.nl.go.kr/seoji/SearchApi.do
 *   cert_key, result_style=json, page_no, page_size, isbn
 * 돌려주는 칸: TITLE, AUTHOR, PUBLISHER, PUBLISH_PREDATE, KDC, TITLE_URL …
 */
async function fromNlk(isbn: string): Promise<Partial<BookLookup> | null> {
  const key = Deno.env.get(NLK_KEY_ENV)?.trim();
  if (!key) return null;

  const url = new URL(NLK_URL);
  url.searchParams.set("cert_key", key);
  url.searchParams.set("result_style", "json");
  url.searchParams.set("page_no", "1");
  url.searchParams.set("page_size", "1");
  url.searchParams.set("isbn", isbn);

  const body = await fetchJson(url, "국립중앙도서관");

  // 거절은 "책이 없다" 와 다르다. 사람이 고칠 수 있게 갈라서 알린다.
  const result = pick(body, "RESULT");
  if (result && result.toUpperCase() === "ERROR") {
    const message = pick(body, "ERR_MESSAGE") ?? "요청이 거절되었습니다.";
    throw new BookLookupError(
      `국립중앙도서관: ${message}`,
      /인증|키/.test(message) ? "auth" : "api",
    );
  }

  const title = pick(body, "TITLE");
  if (!title) return null;

  return {
    title,
    author: pick(body, "AUTHOR"),
    publisher: pick(body, "PUBLISHER"),
    published_year: toYear(pick(body, "PUBLISH_PREDATE")),
    kdc: pick(body, "KDC"),
    cover_url: pick(body, "TITLE_URL"),
  };
}

/* ---------- 도서관 정보나루 ---------- */

/**
 * https://data4library.kr/api/srchDtlList
 *   authKey, isbn13, format=json
 * 돌려주는 칸: bookname, authors, publisher, publication_year, class_no, description, bookImageURL
 *
 * isbn13 만 받는다. 10자리로 물어보면 여기는 건너뛰고 국중 것만 쓴다.
 */
/** 정보나루가 "그런 책 없음" 을 알릴 때 쓰는 오류 코드. 실패가 아니라 답이다. */
const NOT_FOUND_CODES = ["isbnLengthErr"];

async function fromData4Library(isbn: string): Promise<Partial<BookLookup> | null> {
  const key = Deno.env.get(DATA4LIBRARY_KEY_ENV)?.trim();
  if (!key || isbn.length !== 13) return null;

  const url = new URL(DATA4LIBRARY_URL);
  url.searchParams.set("authKey", key);
  url.searchParams.set("isbn13", isbn);
  url.searchParams.set("format", "json");

  const body = await fetchJson(url, "도서관 정보나루");

  const errCode = pick(body, "errCode");
  if (errCode) {
    // 모르는 ISBN 도 오류 코드로 온다("ISBN을 확인해 주시기 바랍니다").
    // 이름은 길이 탓처럼 보이지만 13자리 정상 번호에도 같은 코드가 온다 —
    // 실제로는 "그런 책이 없다" 는 답이다. 그건 실패가 아니라 무결과다.
    if (NOT_FOUND_CODES.includes(errCode)) return null;

    const message = pick(body, "error") ?? `오류 코드 ${errCode}`;
    throw new BookLookupError(
      `도서관 정보나루: ${message}`,
      errCode === "authErr" ? "auth" : "api",
    );
  }

  const title = pick(body, "bookname");
  if (!title) return null;

  return {
    title,
    author: pick(body, "authors"),
    publisher: pick(body, "publisher"),
    published_year: toYear(pick(body, "publication_year", "publication_date")),
    kdc: pick(body, "class_no"),
    cover_url: pick(body, "bookImageURL"),
    description: pick(body, "description"),
  };
}

/* ---------- 제목·저자로 찾기 ---------- */

/** 찾은 책 한 권. 아직 우리 책이 아니라 후보다. */
export type BookCandidate = {
  isbn: string | null;
  title: string;
  author: string | null;
  publisher: string | null;
  published_year: number | null;
  kdc: string | null;
  cover_url: string | null;
  /** 어느 곳에서 온 줄인지. 합쳐진 줄은 둘 다 적힌다. */
  sources: string[];
};

export type BookSearchResult = {
  items: BookCandidate[];
  /** 대략 몇 건인지. 두 곳이 각각 세므로 큰 쪽을 쓴다 — 정확한 수가 아니다. */
  total: number;
  /** 더 받을 것이 남았는가 */
  has_more: boolean;
};

export type BookSearchQuery = {
  title?: string | null;
  author?: string | null;
  /** 1부터 */
  page?: number;
};

/** 두 API 의 한 줄. 칸 이름만 다르고 뜻은 같아서 읽는 함수를 따로 둔다. */
type RawRow = Record<string, unknown>;

function text(row: RawRow, ...names: string[]): string | null {
  for (const name of names) {
    const value = row[name];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return null;
}

/**
 * 국립중앙도서관 ISBN 서지정보 — 제목·저자로 찾기
 *
 * 공식 문서(nl.go.kr Open API 활용방법 > ISBN 서지정보)의 요청 변수에
 * title(본표제), author(저자), page_no, page_size 가 있다.
 * 응답은 { TOTAL_COUNT, PAGE_NO, docs: [ … ] } 이고 한 줄의 칸은
 * TITLE, AUTHOR, PUBLISHER, PUBLISH_PREDATE, EA_ISBN, KDC, TITLE_URL 이다.
 *
 * 여기서는 pick() 을 쓰지 않는다. pick 은 어느 깊이든 첫 값을 찾아 주는 함수라
 * 한 권을 볼 때는 편하지만 목록에서는 모든 줄이 첫 줄의 값이 되어 버린다.
 */
async function searchNlk(query: BookSearchQuery): Promise<{ rows: RawRow[]; total: number }> {
  const key = Deno.env.get(NLK_KEY_ENV)?.trim();
  if (!key) return { rows: [], total: 0 };

  const url = new URL(NLK_URL);
  url.searchParams.set("cert_key", key);
  url.searchParams.set("result_style", "json");
  url.searchParams.set("page_no", String(query.page ?? 1));
  url.searchParams.set("page_size", String(SEARCH_PAGE_SIZE));
  if (query.title) url.searchParams.set("title", query.title);
  if (query.author) url.searchParams.set("author", query.author);

  const body = await fetchJson(url, "국립중앙도서관") as RawRow;

  const result = text(body, "RESULT");
  if (result && result.toUpperCase() === "ERROR") {
    const message = text(body, "ERR_MESSAGE") ?? "요청이 거절되었습니다.";
    throw new BookLookupError(
      `국립중앙도서관: ${message}`,
      /인증|키/.test(message) ? "auth" : "api",
    );
  }

  const docs = Array.isArray(body.docs) ? body.docs as RawRow[] : [];
  return { rows: docs, total: Number(text(body, "TOTAL_COUNT") ?? "0") || 0 };
}

/**
 * 도서관 정보나루 — 제목·저자로 찾기
 *
 * 공식 문서(data4library.kr > Open API 활용방법 > 도서 검색)의 요청 URL 은
 * /api/srchBooks?authKey=&keyword=&pageNo=&pageSize= 다.
 * 문서에 적힌 것은 keyword 뿐이지만 title·author 도 받는다 —
 * 응답의 response.request 에 그대로 되돌려 주고 실제로 그 칸으로 걸러 준다(실조회로 확인).
 * 응답은 { response: { numFound, docs: [ { doc: … } ] } } 이고 한 줄의 칸은
 * bookname, authors, publisher, publication_year, isbn13, class_no, bookImageURL 이다.
 * 정렬은 대출 많은 순이 기본이라, 아이들이 많이 보는 책이 앞에 온다.
 */
async function searchData4Library(
  query: BookSearchQuery,
): Promise<{ rows: RawRow[]; total: number }> {
  const key = Deno.env.get(DATA4LIBRARY_KEY_ENV)?.trim();
  if (!key) return { rows: [], total: 0 };

  const url = new URL(DATA4LIBRARY_SEARCH_URL);
  url.searchParams.set("authKey", key);
  url.searchParams.set("format", "json");
  url.searchParams.set("pageNo", String(query.page ?? 1));
  url.searchParams.set("pageSize", String(SEARCH_PAGE_SIZE));
  if (query.title) url.searchParams.set("title", query.title);
  if (query.author) url.searchParams.set("author", query.author);

  const body = await fetchJson(url, "도서관 정보나루") as RawRow;

  const errCode = text(body, "errCode");
  if (errCode) {
    const message = text(body, "error") ?? `오류 코드 ${errCode}`;
    throw new BookLookupError(
      `도서관 정보나루: ${message}`,
      errCode === "authErr" ? "auth" : "api",
    );
  }

  const response = (body.response ?? {}) as RawRow;
  const docs = Array.isArray(response.docs) ? response.docs as RawRow[] : [];
  // 한 줄이 { doc: {...} } 로 한 겹 더 싸여 온다
  const rows = docs.map((one) => (one.doc ?? one) as RawRow);
  return { rows, total: Number(response.numFound ?? 0) || 0 };
}

function fromNlkRow(row: RawRow): BookCandidate {
  return {
    isbn: normalizeIsbn(text(row, "EA_ISBN", "SET_ISBN")),
    title: text(row, "TITLE") ?? "",
    author: text(row, "AUTHOR"),
    publisher: text(row, "PUBLISHER"),
    published_year: toYear(text(row, "PUBLISH_PREDATE", "REAL_PUBLISH_DATE")),
    kdc: text(row, "KDC"),
    cover_url: text(row, "TITLE_URL"),
    sources: ["국립중앙도서관"],
  };
}

function fromD4lRow(row: RawRow): BookCandidate {
  return {
    isbn: normalizeIsbn(text(row, "isbn13")),
    title: text(row, "bookname") ?? "",
    author: text(row, "authors"),
    publisher: text(row, "publisher"),
    published_year: toYear(text(row, "publication_year", "publication_date")),
    kdc: text(row, "class_no"),
    cover_url: text(row, "bookImageURL"),
    sources: ["도서관 정보나루"],
  };
}

/** 같은 책이면 빈 칸을 서로 채운다. 값이 둘 다 있으면 먼저 온 쪽을 둔다. */
function mergeCandidate(base: BookCandidate, extra: BookCandidate): BookCandidate {
  return {
    isbn: base.isbn ?? extra.isbn,
    title: base.title || extra.title,
    author: base.author ?? extra.author,
    publisher: base.publisher ?? extra.publisher,
    published_year: base.published_year ?? extra.published_year,
    kdc: base.kdc ?? extra.kdc,
    cover_url: base.cover_url ?? extra.cover_url,
    sources: [...new Set([...base.sources, ...extra.sources])],
  };
}

/**
 * 제목·저자로 책을 찾는다. 등록하기 전에 "이 책이 맞나"를 눈으로 보는 자리다.
 *
 * 두 곳에 함께 묻고 ISBN 으로 합친다. 정보나루를 앞에 두는 이유는 두 가지다 —
 * 표지가 거의 다 있고, 대출 많은 순이라 아이들이 실제로 보는 책이 위로 온다.
 * 국중에만 있는 책은 뒤에 붙인다.
 *
 * ISBN 이 없는 줄은 합칠 열쇠가 없어 그대로 둔다. 등록은 할 수 있고 ISBN 만 비어 있다.
 *
 * 둘 다 못 찾으면 빈 목록이다 — 실패가 아니다.
 * 둘 다 실패했을 때만 던진다. 한 곳이라도 답했으면 그 결과로 보여 준다.
 */
export async function searchBooks(query: BookSearchQuery): Promise<BookSearchResult> {
  const title = query.title?.trim() || null;
  const author = query.author?.trim() || null;
  if (!title && !author) {
    throw new BookLookupError("제목이나 저자 중 하나는 있어야 합니다.", "api");
  }

  const page = Math.max(1, Math.floor(query.page ?? 1));
  const asked = { title, author, page };

  const [d4l, nlk] = await Promise.allSettled([
    searchData4Library(asked),
    searchNlk(asked),
  ]);

  if (d4l.status === "rejected" && nlk.status === "rejected") {
    console.error("[searchBooks]", d4l.reason, nlk.reason);
    if (d4l.reason instanceof BookLookupError) throw d4l.reason;
    throw nlk.reason;
  }
  for (const one of [d4l, nlk]) {
    if (one.status === "rejected") console.error("[searchBooks]", one.reason);
  }

  const first = d4l.status === "fulfilled" ? d4l.value : { rows: [], total: 0 };
  const second = nlk.status === "fulfilled" ? nlk.value : { rows: [], total: 0 };

  const items: BookCandidate[] = [];
  const byIsbn = new Map<string, number>();

  const sources: Array<[RawRow[], (row: RawRow) => BookCandidate]> = [
    [first.rows, fromD4lRow],
    [second.rows, fromNlkRow],
  ];

  for (const [rows, convert] of sources) {
    for (const row of rows) {
      const candidate = convert(row);
      if (!candidate.title) continue;

      const at = candidate.isbn ? byIsbn.get(candidate.isbn) : undefined;
      if (at !== undefined) {
        items[at] = mergeCandidate(items[at], candidate);
        continue;
      }
      if (candidate.isbn) byIsbn.set(candidate.isbn, items.length);
      items.push(candidate);
    }
  }

  return {
    items,
    total: Math.max(first.total, second.total),
    // 한 곳이라도 가득 채워 줬으면 다음 쪽이 있다
    has_more: first.rows.length >= SEARCH_PAGE_SIZE || second.rows.length >= SEARCH_PAGE_SIZE,
  };
}

/* ---------- 바깥으로 여는 문 ---------- */

/**
 * 두 키가 각각 들어 있는가. 시스템 점검 화면이 쓴다. 값은 돌려주지 않는다.
 */
export function bookKeyPresence(): { nlk: boolean; data4library: boolean } {
  return {
    nlk: Boolean(Deno.env.get(NLK_KEY_ENV)?.trim()),
    data4library: Boolean(Deno.env.get(DATA4LIBRARY_KEY_ENV)?.trim()),
  };
}

/**
 * 조회 기능을 쓸 수 있는지. 화면이 [조회] 버튼을 켤지 정하는 데 쓴다.
 * 둘 중 하나만 있어도 켠다 — 한 곳만으로도 채울 수 있다.
 */
export function isBookLookupAvailable(): boolean {
  return Boolean(
    Deno.env.get(NLK_KEY_ENV)?.trim() || Deno.env.get(DATA4LIBRARY_KEY_ENV)?.trim(),
  );
}

/**
 * ISBN 으로 서지정보를 찾는다.
 *
 *   찾음        BookLookup
 *   없음        null            — 사람이 직접 적으면 된다
 *   연결·키 오류 BookLookupError — 고쳐야 하는 일이라 조용히 넘기지 않는다
 *
 * 한 곳이 실패해도 다른 곳이 찾았으면 그 결과를 쓴다.
 * 둘 다 못 찾았는데 실패한 곳이 있으면, "없음" 이 아니라 그 실패를 알린다.
 */
export async function lookupByISBN(raw: string): Promise<BookLookup | null> {
  const isbn = normalizeIsbn(raw);
  if (!isbn || !ISBN_RE.test(isbn)) {
    throw new BookLookupError("ISBN 은 하이픈을 빼고 10자리 또는 13자리여야 합니다.", "api");
  }

  const [nlk, d4l] = await Promise.allSettled([fromNlk(isbn), fromData4Library(isbn)]);

  const failure = [nlk, d4l].find((one) => one.status === "rejected");
  if (failure?.status === "rejected") {
    // 서버 로그에는 원문을 남긴다. 어느 쪽이 왜 죽었는지 나중에 봐야 한다.
    console.error("[lookupByISBN]", failure.reason);
  }

  const primary = nlk.status === "fulfilled" ? nlk.value : null;
  const extra = d4l.status === "fulfilled" ? d4l.value : null;

  if (!primary && !extra) {
    if (failure?.status === "rejected" && failure.reason instanceof BookLookupError) {
      throw failure.reason;
    }
    return null;
  }

  const sources: string[] = [];
  if (primary) sources.push("국립중앙도서관");
  if (extra) sources.push("도서관 정보나루");

  // 국중 값을 앞세우고, 비어 있는 칸만 정보나루로 채운다.
  return {
    isbn,
    title: primary?.title ?? extra?.title ?? "",
    author: primary?.author ?? extra?.author ?? null,
    publisher: primary?.publisher ?? extra?.publisher ?? null,
    published_year: primary?.published_year ?? extra?.published_year ?? null,
    kdc: primary?.kdc ?? extra?.kdc ?? null,
    cover_url: primary?.cover_url ?? extra?.cover_url ?? null,
    // 책소개는 정보나루에만 있다
    description: extra?.description ?? null,
    sources,
  };
}
