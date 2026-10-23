/**
 * 도서 API
 *
 *   GET    /api/books?q=검색어&status=보유     목록 (검색·상태는 선택)
 *   POST   /api/books                        등록
 *   PATCH  /api/books/:id                    수정 (상태 변경 포함). 서지 잠긴 책은 서지 칸을 못 바꾼다
 *   POST   /api/books/:id/refresh            [정보 다시 불러오기] — ISBN 으로 서지 칸을 새로 채운다
 *   DELETE /api/books/:id                    삭제
 *   GET    /api/books/lookup?isbn=           ISBN 으로 서지정보
 *   GET    /api/books/search?title=&author=&page=  제목·저자로 바깥에서 찾기
 *   POST   /api/books/from-cover             표지·책등 사진(나눈 조각 최대 2장)에서 책마다 제목·저자·출판사 읽기 (AI, 저장 안 함)
 *   POST   /api/books/import/parse           엑셀(xlsx)·CSV 를 읽어 열 추정 + 줄(저장 안 함, 100줄까지)
 *   POST   /api/books/import/match           엑셀 한 줄 → ISBN 조회·제목 검색으로 "맞춤/확인 필요/이미 소장/실패" (저장 안 함)
 *
 * 이 파일은 Supabase를 직접 부르지 않는다. /db 와 /lib 의 함수만 사용한다.
 * 형식 검증은 여기서 끝내고, 틀리면 DB까지 가지 않고 400으로 끊는다.
 */
import {
  addBook,
  BIBLIO_FIELDS,
  BOOK_STATUSES,
  type BookPatch,
  type BookStatus,
  CENTER_UNSET,
  deleteBook,
  findByIsbns,
  getBook,
  hasBook032,
  listBooks,
  listCenterClasses,
  normalizeIsbn,
  updateBook,
} from "../db/books.ts";
import { NotFoundError, RuleError } from "../db/client.ts";
import {
  BookLookupError,
  isBookLookupAvailable,
  lookupByISBN,
  searchBooks,
} from "../lib/book_lookup.ts";
import { KDC_LABELS, KDC_UNSET, kdcLabel } from "../lib/kdc.ts";
import { checkImageData, IMAGE_TYPES, type ImageType } from "../lib/ai.ts";
import { readBookCoverParts } from "../lib/book_cover.ts";
import { AIServiceError } from "../lib/ai.ts";
import { readCsv, readXlsx, SheetError } from "../lib/xlsx.ts";
import {
  guessColumns,
  IMPORT_ROLES,
  IMPORT_ROW_MAX,
  sameBook,
  samePublisher,
} from "../lib/book_import.ts";

/** 표지 사진 조각 상한 — 화면이 서가 사진을 좌/우로 나눠 보낸다(AI 호출 = 조각 수) */
const COVER_PARTS_MAX = 2;

/** 엑셀 파일 크기 상한(원본 바이트) */
const SHEET_MAX_BYTES = 2 * 1024 * 1024;

/**
 * 사진 크기 상한 (원본 바이트 기준). 화면이 먼저 줄여 보내므로 보통 훨씬 작다.
 * 자원 사진(api/resources.ts)과 같은 값이어야 화면 안내문도 한 가지로 끝난다.
 */
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

const TITLE_MAX = 300;

/**
 * 조회에 실패해 제목 없이 센터 정보만 저장한 책의 제목 자리(DB 는 제목을 비울 수 없다).
 * 화면(books.js)이 같은 글자로 알아보고 [ISBN 다시 검색] 을 띄운다.
 */
export const TITLE_UNKNOWN = "제목 미확인";
const SHORT_MAX = 200;
const NOTE_MAX = 2000;
const QUERY_MAX = 100;
/** 등록번호·센터분류 길이 */
const CODE_MAX = 30;
/** 입수경위(자유 글) 길이 */
const VIA_MAX = 200;

/** ISBN-10 은 끝이 X 일 수 있다. ISBN-13 은 숫자만. */
const ISBN_RE = /^(\d{9}[\dX]|\d{13})$/;

const JSON_HEADERS = { "cache-control": "no-store" };

function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400, headers: JSON_HEADERS });
}

function serverError(where: string, error: unknown): Response {
  // 없는 대상은 404, 규칙에 어긋난 요청(없는 사람을 가리킴 등)은 400 — 사람이 읽을 말 그대로(db/client.ts)
  if (error instanceof NotFoundError) {
    return Response.json({ error: error.message }, { status: 404, headers: JSON_HEADERS });
  }
  // 규칙에 어긋난 요청(같은 ISBN·등록번호, 032 전 새 칸)은 서버 고장이 아니다
  if (error instanceof RuleError) return badRequest(error.message);
  console.error(`[${where}]`, error);
  return Response.json(
    { error: "요청을 처리하지 못했습니다." },
    { status: 500, headers: JSON_HEADERS },
  );
}

function ok(body: unknown): Response {
  return Response.json(body, { headers: JSON_HEADERS });
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/* ---------- 값 검증 ---------- */

/** 짧은 글 칸. 없어도 된다. 빈 문자열은 null. 너무 길면 undefined(오류). */
function parseShort(value: unknown, max = SHORT_MAX): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > max ? undefined : trimmed;
}

/** ISBN. 없어도 된다. 있으면 하이픈을 뺀 뒤 10자리 또는 13자리여야 한다. */
function parseIsbn(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return undefined;
  const normalized = normalizeIsbn(value);
  if (normalized === null) return null;
  return ISBN_RE.test(normalized) ? normalized : undefined;
}

/** 발행년. 없어도 된다. 있으면 네 자리 연도. */
function parseYear(value: unknown): number | null | undefined {
  if (value === null || value === undefined || value === "") return null;
  const year = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isInteger(year) || year < 1000 || year > 2999) return undefined;
  return year;
}

/**
 * 본문을 읽어 저장할 모양으로 만든다. 등록과 수정이 같은 규칙을 쓴다.
 * strict 면 제목이 반드시 있어야 한다(등록). 아니면 온 것만 본다(수정).
 */
function parseBook(
  body: Record<string, unknown>,
  strict: boolean,
): { patch: BookPatch } | { error: string } {
  const patch: BookPatch = {};

  if (strict || "title" in body) {
    const title = parseShort(body.title, TITLE_MAX);
    if (!title) return { error: `제목은 비어 있을 수 없고 ${TITLE_MAX}자를 넘을 수 없습니다.` };
    patch.title = title;
  }

  if ("isbn" in body) {
    const isbn = parseIsbn(body.isbn);
    if (isbn === undefined) {
      return { error: "ISBN 은 하이픈을 빼고 10자리 또는 13자리여야 합니다." };
    }
    patch.isbn = isbn;
  }

  for (const key of ["author", "publisher"] as const) {
    if (!(key in body)) continue;
    const value = parseShort(body[key]);
    if (value === undefined) return { error: `${key} 는 ${SHORT_MAX}자를 넘을 수 없습니다.` };
    patch[key] = value;
  }

  // 센터 정보 — 등록번호·센터분류(자유 입력, 선택)
  const labels = { reg_no: "등록번호", center_class: "센터분류" } as const;
  for (const key of ["reg_no", "center_class"] as const) {
    if (!(key in body)) continue;
    const value = parseShort(body[key], CODE_MAX);
    if (value === undefined) return { error: `${labels[key]}는 ${CODE_MAX}자를 넘을 수 없습니다.` };
    patch[key] = value;
  }

  if ("note" in body) {
    const note = parseShort(body.note, NOTE_MAX);
    if (note === undefined) return { error: `비고는 ${NOTE_MAX}자를 넘을 수 없습니다.` };
    patch.note = note;
  }

  if ("published_year" in body) {
    const year = parseYear(body.published_year);
    if (year === undefined) return { error: "발행년은 네 자리 연도여야 합니다." };
    patch.published_year = year;
  }

  // 입수경위 — 032 부터 자유 글(예: "후원 — ○○ 도서관 기증")
  if ("acquired_via" in body) {
    const via = parseShort(body.acquired_via, VIA_MAX);
    if (via === undefined) return { error: `입수경위는 ${VIA_MAX}자를 넘을 수 없습니다.` };
    patch.acquired_via = via;
  }

  if ("status" in body) {
    const status = body.status;
    if (typeof status !== "string" || !(BOOK_STATUSES as readonly string[]).includes(status)) {
      return { error: "상태는 보유, 분실, 폐기 중 하나여야 합니다." };
    }
    patch.status = status as BookStatus;
  }

  // 외부 API 가 채우는 칸. 사람이 직접 넣어도 막지는 않는다 — 아는 사람은 KDC 를 안다.
  for (const key of ["kdc", "cover_url"] as const) {
    if (!(key in body)) continue;
    const value = parseShort(body[key], 500);
    if (value === undefined) return { error: `${key} 가 너무 깁니다.` };
    patch[key] = value;
  }

  // 서가 이름. 고를 수 있는 것만 받는다 — 아무 글자나 들어오면 필터가 갈라진다.
  if ("kdc_label" in body) {
    const label = parseShort(body.kdc_label, 30);
    if (label === undefined) return { error: "분류 이름이 너무 깁니다." };
    if (label !== null && !KDC_LABELS.includes(label)) {
      return { error: "분류는 목록에 있는 것 중에서 골라 주세요." };
    }
    patch.kdc_label = label;
  }

  return { patch };
}

/* ---------- GET /api/books ---------- */

export async function handleBooksList(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;

  const q = params.get("q")?.trim() ?? "";
  if (q.length > QUERY_MAX) return badRequest(`검색어는 ${QUERY_MAX}자를 넘을 수 없습니다.`);

  const statusParam = params.get("status")?.trim() ?? "";
  let status: BookStatus | null = null;
  if (statusParam && statusParam !== "전체") {
    if (!(BOOK_STATUSES as readonly string[]).includes(statusParam)) {
      return badRequest("status 는 보유, 분실, 폐기, 전체 중 하나여야 합니다.");
    }
    status = statusParam as BookStatus;
  }

  const labelParam = params.get("label")?.trim() ?? "";
  if (labelParam && labelParam !== "전체") {
    if (labelParam !== KDC_UNSET && !KDC_LABELS.includes(labelParam)) {
      return badRequest("label 은 분류 목록에 있는 이름이어야 합니다.");
    }
  }
  // 센터분류 — 자유 입력이라 목록 검사는 없다(길이만)
  const centerParam = params.get("center")?.trim() ?? "";
  if (centerParam.length > CODE_MAX) return badRequest("center 가 너무 깁니다.");

  // 목록은 15권씩(커서). 검색·상태·분류로 거른 결과를 나눈다.
  const cursor = params.get("cursor")?.trim() || null;

  try {
    const page = await listBooks(
      q || null,
      {
        status,
        label: labelParam && labelParam !== "전체" ? labelParam : null,
        center: centerParam && centerParam !== "전체" ? centerParam : null,
      },
      { cursor },
    );
    return ok({
      books: page.books,
      next_cursor: page.next_cursor,
      // 첫 쪽에만 온다(거른 결과 전체 권수)
      ...(page.total === null ? {} : { total: page.total }),
      // 화면이 [조회]·[책 찾아보기] 를 켤지 정하는 데 쓴다. 키가 오면 여기가 true 가 된다.
      lookup_available: isBookLookupAvailable(),
      // 분류 이름표는 서버가 갖고 있다. 화면이 lib 을 못 부르므로 함께 내려보낸다.
      kdc_labels: KDC_LABELS,
      // 첫 쪽에만 — 쓰고 있는 센터분류(필터·등록 칸 제안). 032 전이면 빈 목록
      ...(cursor ? {} : {
        center_classes: await listCenterClasses(),
        center_unset: CENTER_UNSET,
        schema_032: await hasBook032(),
      }),
    });
  } catch (error) {
    return serverError("GET /api/books", error);
  }
}

/* ---------- POST /api/books ---------- */

export async function handleBookCreate(req: Request): Promise<Response> {
  const body = await readJson(req);
  if (!body) return badRequest("요청 본문이 JSON이 아닙니다.");

  // 등록의 필수는 제목·상태 둘. ISBN·저자 같은 서지 나머지는 비워도 된다(손 입력 책 — 잠금 없음)
  if (!("status" in body)) return badRequest("상태를 골라 주세요.");
  // 조회에 실패해도 ISBN 이 있으면 센터 정보만으로 저장한다 — 서지는 나중에 [ISBN 다시 검색]
  const noTitle = typeof body.title !== "string" || !body.title.trim();
  if (noTitle && typeof body.isbn === "string" && body.isbn.trim()) body.title = TITLE_UNKNOWN;
  if (noTitle && body.title !== TITLE_UNKNOWN) {
    return badRequest("제목이나 ISBN 중 하나는 넣어 주세요.");
  }
  const parsed = parseBook(body, true);
  if ("error" in parsed) return badRequest(parsed.error);

  const book = { ...parsed.patch, status: parsed.patch.status as BookStatus };

  // 조회(ISBN·검색·표지)로 채운 서지는 저장 뒤 잠근다 — ISBN 이 있어야 [정보 다시 불러오기] 를 할 수 있다
  if (body.biblio_source === "lookup" && book.isbn) book.biblio_locked = true;

  try {
    const created = await addBook({ ...book, title: book.title as string });
    return ok({ book: created });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("이미 있습니다")) return badRequest(message);
    return serverError("POST /api/books", error);
  }
}

/* ---------- PATCH /api/books/:id ---------- */

export async function handleBookUpdate(req: Request, id: string): Promise<Response> {
  const body = await readJson(req);
  if (!body) return badRequest("요청 본문이 JSON이 아닙니다.");

  const parsed = parseBook(body, false);
  if ("error" in parsed) return badRequest(parsed.error);
  if (Object.keys(parsed.patch).length === 0) return badRequest("바꿀 내용이 없습니다.");

  try {
    // 서지 잠긴 책 — 서지 칸이 바뀌면 거절한다(같은 값이 다시 온 것은 괜찮다)
    const before = await getBook(id);
    if (!before) {
      return Response.json({ error: "그 책을 찾지 못했습니다." }, {
        status: 404,
        headers: JSON_HEADERS,
      });
    }
    if (before.biblio_locked) {
      const touched = BIBLIO_FIELDS.filter((key) =>
        key in parsed.patch && (parsed.patch[key] ?? null) !== (before[key] ?? null)
      );
      if (touched.length) {
        return badRequest(
          "조회로 채운 서지 정보는 고칠 수 없습니다. [정보 다시 불러오기] 로 새로 받아 주세요.",
        );
      }
    }
    const book = await updateBook(id, parsed.patch);
    return ok({ book });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("이미 있습니다")) return badRequest(message);
    return serverError("PATCH /api/books/:id", error);
  }
}

/* ---------- POST /api/books/:id/refresh ---------- */

/**
 * [정보 다시 불러오기]·[ISBN 다시 검색] — 그 책의 ISBN 으로 다시 조회해 서지 칸(제목·저자·출판사·발행년·KDC·표지)을 새로 채운다.
 * 조회로 채운 책(잠김)이 서지를 바꾸는 유일한 길이다. 센터 정보는 건드리지 않는다.
 * 본문에 isbn 을 주면(잠기지 않은 책만) 그 ISBN 으로 찾고 함께 저장한다. 찾아 채운 책은 조회 채움이라 잠근다.
 */
export async function handleBookRefresh(req: Request, id: string): Promise<Response> {
  const body = (await readJson(req)) ?? {};
  if (!isBookLookupAvailable()) {
    return Response.json(
      { error: "도서 정보 조회 API가 아직 연결되지 않았습니다." },
      { status: 503, headers: JSON_HEADERS },
    );
  }
  try {
    const before = await getBook(id);
    if (!before) {
      return Response.json({ error: "그 책을 찾지 못했습니다." }, {
        status: 404,
        headers: JSON_HEADERS,
      });
    }
    let isbn = before.isbn;
    if (typeof body.isbn === "string" && body.isbn.trim() && !before.biblio_locked) {
      const given = parseIsbn(body.isbn);
      if (!given) return badRequest("ISBN 은 하이픈을 빼고 10자리 또는 13자리여야 합니다.");
      isbn = given;
    }
    if (!isbn) return badRequest("ISBN 이 없는 책은 다시 불러올 수 없습니다.");

    const found = await lookupByISBN(isbn);
    if (!found) return badRequest("이 ISBN 으로 찾은 책이 없습니다. 지금 정보를 그대로 둡니다.");

    const patch: BookPatch = {
      isbn,
      biblio_locked: true,
      title: found.title?.trim() || before.title,
      author: found.author ?? null,
      publisher: found.publisher ?? null,
      published_year: found.published_year ?? null,
      kdc: found.kdc ?? null,
      kdc_label: kdcLabel(found.kdc),
      cover_url: found.cover_url ?? null,
    };
    const book = await updateBook(id, patch);
    return ok({ book, sources: found.sources ?? [], kdc_missing: !patch.kdc_label });
  } catch (error) {
    if (error instanceof BookLookupError) {
      return Response.json(
        { error: error.message, kind: error.kind },
        { status: error.kind === "auth" ? 500 : 502, headers: JSON_HEADERS },
      );
    }
    const message = error instanceof Error ? error.message : "";
    if (message.includes("이미 있습니다")) return badRequest(message);
    return serverError("POST /api/books/:id/refresh", error);
  }
}

/* ---------- DELETE /api/books/:id ---------- */

export async function handleBookDelete(id: string): Promise<Response> {
  try {
    await deleteBook(id);
    return new Response(null, { status: 204, headers: JSON_HEADERS });
  } catch (error) {
    return serverError("DELETE /api/books/:id", error);
  }
}

/* ---------- GET /api/books/search ---------- */

/** 한 번에 찾아볼 수 있는 쪽수 상한. 그보다 뒤는 검색어를 좁히는 편이 빠르다. */
const SEARCH_MAX_PAGE = 20;

/**
 * 제목·저자로 바깥 도서관에서 찾는다. 우리 표를 건드리지 않는다.
 *
 * 우리가 이미 가진 책은 여기서 표시해 준다. 같은 책을 두 번 등록하는 것이
 * 도서관에서 제일 흔한 사고이고, 등록 버튼을 누르기 전에 알아야 막을 수 있다.
 * ISBN 을 한 번에 모아 물어 본다 — 줄마다 묻지 않는다.
 *
 * 분류 이름표(kdc_label)도 여기서 붙여 보낸다. 등록 화면이 그대로 쓴다.
 */
export async function handleBookSearch(req: Request): Promise<Response> {
  if (!isBookLookupAvailable()) {
    return Response.json(
      { error: "도서 정보 조회 API가 아직 연결되지 않았습니다." },
      { status: 503, headers: JSON_HEADERS },
    );
  }

  const params = new URL(req.url).searchParams;
  const title = params.get("title")?.trim() ?? "";
  const author = params.get("author")?.trim() ?? "";

  if (!title && !author) return badRequest("제목이나 저자 중 하나는 입력해 주세요.");
  if (title.length > QUERY_MAX || author.length > QUERY_MAX) {
    return badRequest(`검색어는 ${QUERY_MAX}자를 넘을 수 없습니다.`);
  }

  const page = Number(params.get("page") ?? "1");
  if (!Number.isInteger(page) || page < 1 || page > SEARCH_MAX_PAGE) {
    return badRequest(`쪽 번호는 1 부터 ${SEARCH_MAX_PAGE} 까지입니다.`);
  }

  try {
    const found = await searchBooks({ title, author, page });

    const owned = await findByIsbns(
      found.items.map((one) => one.isbn).filter((one): one is string => !!one),
    );

    const items = found.items.map((one) => {
      const mine = one.isbn ? owned.get(one.isbn) : undefined;
      return {
        ...one,
        kdc_label: kdcLabel(one.kdc),
        // 이미 우리 책이면 그 책의 id 를 준다. 화면이 그리로 데려간다.
        owned_id: mine?.id ?? null,
      };
    });

    return ok({ items, total: found.total, has_more: found.has_more, page });
  } catch (error) {
    console.error("[GET /api/books/search]", error);
    if (error instanceof BookLookupError) {
      return Response.json(
        { error: error.message, kind: error.kind },
        { status: error.kind === "auth" ? 500 : 502, headers: JSON_HEADERS },
      );
    }
    return Response.json(
      { error: "책을 찾지 못했습니다.", kind: "api" },
      { status: 502, headers: JSON_HEADERS },
    );
  }
}

/* ---------- GET /api/books/lookup ---------- */

/**
 * ISBN 으로 서지정보를 찾는다.
 *
 * 키가 없으면 503 이다. 400 이 아니다 — 요청이 틀린 게 아니라 아직 준비가 안 된 것이다.
 * 화면은 이 응답을 "API 준비 중"으로 보여준다.
 */
export async function handleBookLookup(req: Request): Promise<Response> {
  if (!isBookLookupAvailable()) {
    return Response.json(
      { error: "도서 정보 조회 API가 아직 연결되지 않았습니다." },
      { status: 503, headers: JSON_HEADERS },
    );
  }

  const isbn = parseIsbn(new URL(req.url).searchParams.get("isbn"));
  if (!isbn) return badRequest("ISBN 은 하이픈을 빼고 10자리 또는 13자리여야 합니다.");

  try {
    // 못 찾으면 found 가 null 이다. 오류가 아니라 "그런 책이 없다" 는 답이다.
    const found = await lookupByISBN(isbn);
    return ok({
      found: found && { ...found, kdc_label: kdcLabel(found.kdc) },
      kdc_labels: KDC_LABELS,
    });
  } catch (error) {
    console.error("[GET /api/books/lookup]", error);

    // 왜 실패했는지를 함께 준다. 화면이 "키 문제" 와 "잠깐 안 됨" 을 다르게 말해야 한다.
    if (error instanceof BookLookupError) {
      return Response.json(
        { error: error.message, kind: error.kind },
        { status: error.kind === "auth" ? 500 : 502, headers: JSON_HEADERS },
      );
    }
    return Response.json(
      { error: "서지정보를 찾지 못했습니다.", kind: "api" },
      { status: 502, headers: JSON_HEADERS },
    );
  }
}

/* ---------- POST /api/books/import/parse ---------- */

/**
 * 엑셀·CSV 를 읽어 열이 무엇인지 추정해 돌려준다. 등록은 하지 않는다 — 화면이 사람에게 열 배정을 확인받고,
 * 줄마다 조회·검색·등록을 차례로 부른다(진행 표시가 화면에 있어야 해서).
 * 본문: { file: base64, name: "책목록.xlsx" }. 파일은 메모리에서만 쓰고 저장하지 않는다.
 */
export async function handleBookImportParse(req: Request): Promise<Response> {
  const body = await readJson(req);
  if (!body) return badRequest("요청 본문이 JSON이 아닙니다.");

  const name = typeof body.name === "string" ? body.name.trim().toLowerCase() : "";
  const file = typeof body.file === "string" ? body.file.trim() : "";
  if (!file) return badRequest("파일이 비어 있습니다.");
  if (Math.floor(file.length * 3 / 4) > SHEET_MAX_BYTES) {
    return badRequest("파일이 너무 큽니다. 2MB 이하로 올려 주세요.");
  }

  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(file), (ch) => ch.charCodeAt(0));
  } catch {
    return badRequest("파일을 읽지 못했습니다.");
  }

  try {
    let rows: string[][];
    if (name.endsWith(".csv")) {
      rows = readCsv(new TextDecoder().decode(bytes), IMPORT_ROW_MAX + 2);
    } else if (name.endsWith(".xlsx")) {
      rows = await readXlsx(bytes, IMPORT_ROW_MAX + 2);
    } else if (name.endsWith(".xls")) {
      return badRequest(
        "옛 엑셀(.xls)은 읽지 못합니다. 엑셀에서 [다른 이름으로 저장] → .xlsx 로 저장해 올려 주세요.",
      );
    } else {
      return badRequest("엑셀(.xlsx)이나 CSV 파일만 올릴 수 있습니다.");
    }

    const guess = guessColumns(rows);
    if (guess.data.length === 0) {
      return badRequest(
        guess.hasHeader
          ? "책이 없어요 — 열 이름 줄만 있고 책 줄이 없습니다."
          : "책이 없어요 — 파일에 읽을 줄이 없습니다.",
      );
    }
    if (guess.data.length > IMPORT_ROW_MAX) {
      return badRequest(
        `한 번에 ${IMPORT_ROW_MAX}줄까지 올릴 수 있습니다. 파일을 나눠 올려 주세요.`,
      );
    }
    return ok({
      has_header: guess.hasHeader,
      columns: guess.columns,
      rows: guess.data,
      roles: IMPORT_ROLES,
      row_max: IMPORT_ROW_MAX,
    });
  } catch (error) {
    if (error instanceof SheetError) return badRequest(error.message);
    return serverError("POST /api/books/import/parse", error);
  }
}

/* ---------- POST /api/books/import/match ---------- */

/**
 * 엑셀 한 줄의 책을 찾는다. 저장은 하지 않는다(화면이 맞춤 줄만 등록 API 로 보낸다).
 *   ISBN 이 있으면 조회 — 찾으면 맞춤(이미 소장이면 그렇게)
 *   없거나 못 찾으면 제목(+저자)으로 검색 — 제목이 같고(부제·띄어쓰기 무시) 저자가 겹치는 책이
 *   한 권(같은 ISBN 여럿 포함)이면 맞춤, 아니면 확인 필요(사람이 고른다)
 *   출판사를 줬으면 그 출판사 책으로 좁혀서 한 권일 때만 맞춤(다른 출판사 판을 잘못 등록하지 않게)
 * 본문: { title, author, publisher, isbn }  — 저자가 없으면 제목(+출판사)만으로 찾는다
 */
export async function handleBookImportMatch(req: Request): Promise<Response> {
  const body = await readJson(req);
  if (!body) return badRequest("요청 본문이 JSON이 아닙니다.");
  // 너무 긴 칸은 "비어 있음" 으로 넘기지 않고 알린다(엑셀 한 칸에 글이 통째로 들어간 경우)
  const titleRaw = parseShort(body.title, TITLE_MAX);
  if (titleRaw === undefined) return badRequest(`제목은 ${TITLE_MAX}자를 넘을 수 없습니다.`);
  const authorRaw = parseShort(body.author);
  if (authorRaw === undefined) return badRequest(`저자는 ${SHORT_MAX}자를 넘을 수 없습니다.`);
  const title = titleRaw ?? null;
  const author = authorRaw ?? null;
  const publisher = parseShort(body.publisher) ?? null;
  const isbn = parseIsbn(body.isbn) ?? null;
  const labeled = <T extends { kdc?: string | null }>(one: T) => ({
    ...one,
    kdc_label: kdcLabel(one.kdc ?? null),
  });

  if (!title && !isbn) return ok({ status: "fail", reason: "제목도 ISBN 도 비어 있습니다." });
  if (!isBookLookupAvailable()) {
    return ok({ status: "check", reason: "도서 조회 API 가 연결되지 않아 직접 골라야 합니다." });
  }

  try {
    if (isbn) {
      const owned = await findByIsbns([isbn]);
      if (owned.size) return ok({ status: "owned", reason: `이미 소장 중(ISBN ${isbn})` });
      const found = await lookupByISBN(isbn);
      if (found) return ok({ status: "matched", item: labeled(found), via: "isbn" });
      if (!title) return ok({ status: "fail", reason: `ISBN ${isbn} 으로 찾은 책이 없습니다.` });
    }

    const found = await searchBooks({ title: title as string, author: author ?? "", page: 1 });
    const sameTitle = found.items.filter((one) =>
      sameBook({ title: title as string, author }, one)
    );
    const hits = publisher
      ? sameTitle.filter((one) => samePublisher(publisher, one.publisher))
      : sameTitle;
    const isbns = new Set(hits.map((one) => one.isbn ?? one.title));
    if (hits.length && isbns.size === 1) {
      const owned = hits[0].isbn ? await findByIsbns([hits[0].isbn]) : new Map();
      if (owned.size) return ok({ status: "owned", reason: `이미 소장 중(${hits[0].title})` });
      return ok({ status: "matched", item: labeled(hits[0]), via: "title" });
    }
    return ok({
      status: "check",
      reason: hits.length > 1
        ? `같은 제목이 ${isbns.size}가지${publisher ? `(출판사 ${publisher})` : ""}`
        : sameTitle.length
        ? `제목은 같지만 출판사(${publisher})가 맞는 책이 없음`
        : found.items.length
        ? "제목이 딱 맞는 책이 없음"
        : "찾은 책이 없음",
    });
  } catch (error) {
    if (error instanceof BookLookupError) {
      return ok({ status: "check", reason: `조회 실패(${error.message}) — 직접 골라 주세요` });
    }
    return serverError("POST /api/books/import/match", error);
  }
}

/* ---------- POST /api/books/from-cover ---------- */

/**
 * 표지 사진에서 책마다 제목·저자·출판사를 읽는다. 저장하지 않는다.
 *
 * 본문: { image: base64 문자열, mime_type: "image/jpeg" 등 }
 *   또는 { parts: [{ image, mime_type }, …] } — 서가처럼 책이 많은 사진을 화면이 나눠 보낸 조각(최대 2장)
 * 사진은 여기서 AI 로 갔다가 응답과 함께 버려진다. 디스크에도 DB 에도 남지 않는다.
 *
 * 읽은 값으로 바로 등록하지 않는다 — 화면이 [책 찾아보기] 검색창을 채우는 데만 쓴다.
 * 모델이 흐린 표지를 자신 있게 지어내도, 사람이 찾아보기로 확인한 뒤에야 기록이 된다.
 */
export async function handleBookFromCover(req: Request): Promise<Response> {
  const body = await readJson(req);
  if (!body) return badRequest("요청 본문이 JSON이 아닙니다.");

  // 한 장({ image, mime_type }) 또는 나눠 찍은 조각({ parts: [{ image, mime_type }, …] }, 최대 2장)
  const rawParts = Array.isArray(body.parts) ? body.parts : [body];
  if (rawParts.length === 0 || rawParts.length > COVER_PARTS_MAX) {
    return badRequest(`사진 조각은 1~${COVER_PARTS_MAX}장까지 보낼 수 있습니다.`);
  }

  const parts: { image: string; mimeType: ImageType }[] = [];
  const shown: string[] = [];
  for (const raw of rawParts) {
    const one = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const mime = typeof one.mime_type === "string" ? one.mime_type.trim().toLowerCase() : "";
    // 받은 형식 글자는 사람이 보낸 값이다 — 로그·문구에는 앞 몇 글자만, 줄바꿈 없이 싣는다
    const mimeShown = mime.replace(/[^\w/.+-]/g, "").slice(0, 30);
    const image = typeof one.image === "string" ? one.image.trim() : "";
    // base64 는 원본의 4/3 크기다. 디코드하지 않고 길이로 어림한다.
    const bytes = Math.floor(image.length * 3 / 4);

    // 무엇이 왔는지 한 줄 남긴다. 폰에서 빈 값이 오는 이유를 나중에 여기서 가린다.
    // 형식과 크기만 적는다 — 사진 자체는 로그에도 남기지 않는다.
    const from = `mime=${mimeShown || "(없음)"} ${Math.round(bytes / 1024)}KB`;
    shown.push(from);

    if (!(IMAGE_TYPES as readonly string[]).includes(mime)) {
      console.warn(`[from-cover] 받지 않는 형식 — ${from}`);
      return badRequest(
        `사진 형식을 처리하지 못했습니다 (${
          mimeShown || "형식 없음"
        }). JPEG·PNG 로 다시 올려 주세요.`,
      );
    }
    if (!image) return badRequest("사진이 비어 있습니다.");
    if (bytes > IMAGE_MAX_BYTES) {
      console.warn(`[from-cover] 너무 큼 — ${from}`);
      return badRequest(
        `사진이 너무 큽니다 (${Math.round(bytes / 1024 / 1024)}MB). 5MB 이하로 올려 주세요.`,
      );
    }
    const broken = checkImageData(image, mime as ImageType);
    if (broken) {
      console.warn(`[from-cover] 사진 데이터 이상 — ${from}`);
      return badRequest(broken);
    }
    parts.push({ image, mimeType: mime as ImageType });
  }
  const from = `${parts.length}장 [${shown.join(", ")}]`;

  const started = Date.now();
  try {
    // 조각마다 AI 한 번, 겹친 띠의 같은 책은 합친다(lib/book_cover.ts)
    const covers = await readBookCoverParts(parts);
    // 찾아볼 거리가 있는 줄. 제목도 저자도 없는 줄은 화면이 "읽지 못한 책" 으로 묶는다.
    const readable = covers.filter((one) => one.title || one.author);

    // 읽은 글자는 세지만 내용은 안 남긴다. 몇 권 중 몇 권을 읽었는지가 원인을 좁혀 준다.
    console.log(
      `[from-cover] ${readable.length}/${covers.length}권 읽음 — ${from} ${Date.now() - started}ms`,
    );

    // 한 권도 못 읽었으면 "못 읽었다" 는 뜻이다. 오류가 아니라 답이므로 200 으로 보낸다 —
    // 화면은 그때 빈 검색창과 안내 문구를 띄운다.
    return ok({ covers, read: readable.length > 0, parts: parts.length });
  } catch (error) {
    // AI 게이트웨이가 만든 사람이 읽을 수 있는 메시지는 그대로 내보낸다.
    // 이쪽은 "못 읽음" 이 아니라 고장이다 — 화면도 다른 말을 한다.
    // AI 쪽(설정·서버·연결) 실패인지 알린다 — 화면은 "못 읽음" 과 "일시적인 문제" 를 가른다.
    console.error(`[from-cover] 실패 — ${from} ${Date.now() - started}ms`, error);
    return Response.json(
      {
        error: error instanceof Error ? error.message : "사진을 읽지 못했습니다.",
        ai_service: error instanceof AIServiceError,
        ai_kind: error instanceof AIServiceError ? error.kind : null,
      },
      { status: 502, headers: JSON_HEADERS },
    );
  }
}
