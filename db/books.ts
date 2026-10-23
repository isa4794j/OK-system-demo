/**
 * 도서(books) 데이터 접근 — 센터가 가진 책
 *
 * 규칙: Supabase 호출은 /db 안에서만 한다.
 *
 * 도서는 사람과 무관한 일반정보다. 아동·직원 표와 잇지 않는다.
 * 대출(누가 빌렸는가)은 이 파일의 일이 아니다.
 */
import { getClient, NotFoundError, RuleError, writeError } from "./client.ts";
import {
  afterCursorFilter,
  containsPattern,
  cutPage,
  decodeCursor,
  PAGE_SIZE,
  type SortKey,
} from "./paging.ts";
import { recordAudit, snapshotRow } from "./audit.ts";
import { KDC_UNSET } from "../lib/kdc.ts";

/** DB의 CHECK 제약과 같은 목록이어야 한다. */
export const BOOK_STATUSES = ["보유", "분실", "폐기"] as const;
export type BookStatus = (typeof BOOK_STATUSES)[number];

/**
 * 서지 칸 — 조회로 채운 책(biblio_locked)은 저장 뒤 이 칸들을 [정보 다시 불러오기] 로만 바꾼다(032).
 * 공식분류(kdc·kdc_label)와 표지 주소도 조회가 채우는 값이라 함께 묶는다.
 */
export const BIBLIO_FIELDS = [
  "isbn",
  "title",
  "author",
  "publisher",
  "published_year",
  "kdc",
  "kdc_label",
  "cover_url",
] as const;

export type BookItem = {
  id: string;
  isbn: string | null;
  title: string;
  author: string | null;
  publisher: string | null;
  published_year: number | null;
  /** KDC 번호. 조회로 들어온다("813.7"). */
  kdc: string | null;
  /**
   * 번호를 사람이 읽는 서가 이름으로 옮긴 것("한국문학").
   * 조회가 제안하고 사람이 고친다. 변환표는 lib/kdc.ts.
   */
  kdc_label: string | null;
  cover_url: string | null;
  /** 입수경위 — 032 부터 자유 글(예전 값 "구입/후원/기타" 와 기증자가 합쳐져 있다) */
  acquired_via: string | null;
  status: BookStatus;
  note: string | null;
  /** 등록번호(032) — 센터가 붙이는 번호 */
  reg_no?: string | null;
  /** 센터분류(032) — 자유 입력 */
  center_class?: string | null;
  /** 서지 잠금(032) — 조회로 채운 책 */
  biblio_locked?: boolean;
};

/** 고칠 수 있는 칸. id 와 시각은 뺀다. */
export type BookPatch = Partial<Omit<BookItem, "id">>;

// 한 줄로 둔다. 두 줄로 이어 붙이면 supabase-js 가 select 를 타입으로 읽지 못한다.
// 옛 칸(donor·location·call_number)은 032 에서 입수경위·비고로 옮겼고 앱은 더 읽지 않는다(값은 DB 에 남아 있다).
const COLUMNS_OLD =
  "id, isbn, title, author, publisher, published_year, kdc, kdc_label, cover_url, acquired_via, status, note";
const COLUMNS_NEW = `${COLUMNS_OLD}, reg_no, center_class, biblio_locked`;

/**
 * 032 가 적용됐나 — 한 번 물어 기억한다(재시작하면 다시 묻는다).
 * 적용 전 DB 에서도 목록·수정이 예전처럼 돌게 한다. 새 칸에 값을 넣는 저장만 "032 필요" 로 막는다.
 */
let schema032: boolean | null = null;

export async function hasBook032(): Promise<boolean> {
  if (schema032 !== null) return schema032;
  const { error } = await getClient().from("books").select("reg_no, sort_key").limit(1);
  if (!error) schema032 = true;
  else if (error.code === "42703" || /column .* does not exist/i.test(error.message)) {
    schema032 = false;
  } else throw new Error(`도서 표 확인 실패: ${error.message}`);
  return schema032;
}

async function columns(): Promise<string> {
  return (await hasBook032()) ? COLUMNS_NEW : COLUMNS_OLD;
}

export const NEED_032 =
  "등록번호·센터분류·자유 입수경위는 DB 마이그레이션 032 를 적용한 뒤에 쓸 수 있습니다. 관리자에게 알려 주세요.";

/** 032 전 DB 에 새 칸을 쓰려 하면 막는다(말없이 버리지 않는다) */
async function guard032(values: Record<string, unknown>): Promise<void> {
  if (await hasBook032()) return;
  const newOnes = ["reg_no", "center_class", "biblio_locked"].filter(
    (key) => values[key] !== undefined && values[key] !== null && values[key] !== false,
  );
  const via = values.acquired_via;
  const freeVia = typeof via === "string" && !["구입", "후원", "기타"].includes(via);
  if (newOnes.length || freeVia) throw new RuleError(NEED_032);
}

/** 032 전 DB 에는 없는 칸을 빼고 보낸다 */
async function stripFor(values: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (await hasBook032()) return values;
  const { reg_no: _r, center_class: _c, biblio_locked: _b, ...rest } = values;
  if (rest.acquired_via === null || rest.acquired_via === undefined) delete rest.acquired_via;
  return rest;
}

function isDuplicateRegNo(message: string): boolean {
  return /idx_books_reg_no_unique/i.test(message);
}

/**
 * ISBN 을 저장할 모양으로 다듬는다. 하이픈·공백을 빼고 대문자로.
 * "978-89-01-12345-6" 과 "9788901123456" 은 같은 책이어야 한다.
 * 빈 값은 null — 빈 문자열과 없음을 둘 다 두면 unique 인덱스가 빈 문자열끼리 부딪힌다.
 */
export function normalizeIsbn(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = value.replace(/[\s-]/g, "").toUpperCase();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * 이 ISBN 들 중 이미 우리 책인 것. "책 찾아보기" 결과에 [소장 중] 을 붙이는 데 쓴다.
 * 한 건씩 묻지 않고 한 번에 물어 본다 — 결과가 열 몇 줄이라 그만큼 왕복이 늘어난다.
 */
export async function findByIsbns(isbns: string[]): Promise<Map<string, BookItem>> {
  const list = isbns.map((one) => normalizeIsbn(one)).filter((one): one is string => !!one);
  if (list.length === 0) return new Map();

  const { data, error } = await getClient()
    .from("books")
    .select(await columns())
    .in("isbn", list);

  if (error) {
    throw new Error(`소장 여부 조회 실패: ${error.message}`);
  }
  const rows = (data ?? []) as unknown as BookItem[];
  return new Map(rows.map((row) => [row.isbn as string, row]));
}

/** 이미 있는 ISBN 인지 보는 데 쓴다. DB 의 unique 인덱스가 같은 기준으로 막는다. */
function isDuplicateIsbn(message: string): boolean {
  // 등록번호 유일 인덱스도 같은 23505 라 인덱스 이름으로 가른다
  return /idx_books_isbn_unique/i.test(message);
}

/**
 * 도서 목록. 검색어를 주면 제목·저자·ISBN 에서 찾는다.
 * 상태를 주면 그 상태만, 분류를 주면 그 분류만(KDC_UNSET 이면 분류가 빈 책).
 *
 * 검색은 DB 에서 한다. 자원사전은 수십 건이라 화면에서 걸렀지만,
 * 책은 수백 권이 되므로 전부 내려받아 거르면 매번 무겁다.
 * PostgREST 의 or() 로 세 칸을 한 번에 본다. ilike 라 대소문자를 가리지 않는다.
 */
/**
 * 정렬 — 032 뒤: 등록번호 있는 책 먼저(앞 숫자는 숫자순) → 없는 책 제목순. sort_key 는 DB 가 계산한다.
 * 032 전: 제목순.
 */
const BOOK_SORT_NEW: SortKey[] = [
  { column: "sort_key", kind: "text", ascending: true },
  { column: "id", kind: "uuid", ascending: true },
];
const BOOK_SORT_OLD: SortKey[] = [
  { column: "title", kind: "text", ascending: true },
  { column: "id", kind: "uuid", ascending: true },
];

/** 목록 거르기 — 상태·공식분류(kdc_label)·센터분류 */
export type BookFilter = {
  status?: BookStatus | null;
  /** 공식분류 이름. KDC_UNSET 이면 분류가 빈 책 */
  label?: string | null;
  /** 센터분류. CENTER_UNSET 이면 센터분류가 빈 책 */
  center?: string | null;
};

export const CENTER_UNSET = "센터분류 없음";

/**
 * 한 쪽(15권)씩. 검색·상태·분류를 먼저 거르고 그 결과를 나눈다.
 * 첫 쪽(커서 없음)에는 거른 결과 전체의 권수(total)를 함께 준다.
 */
export async function listBooks(
  query: string | null,
  filter: BookFilter = {},
  options: { cursor?: string | null; limit?: number } = {},
): Promise<{ books: BookItem[]; next_cursor: string | null; total: number | null }> {
  const limit = options.limit ?? PAGE_SIZE;
  const is032 = await hasBook032();
  const sort = is032 ? BOOK_SORT_NEW : BOOK_SORT_OLD;
  // 커서를 만들려면 sort_key 도 읽어야 한다(화면에는 안 넘긴다)
  const cols = is032 ? `${COLUMNS_NEW}, sort_key` : COLUMNS_OLD;
  let request = getClient()
    .from("books")
    .select(cols, options.cursor ? undefined : { count: "exact" });

  const { status, label, center } = filter;
  if (status) request = request.eq("status", status);
  if (label === KDC_UNSET) request = request.is("kdc_label", null);
  else if (label) request = request.eq("kdc_label", label);
  if (is032 && center === CENTER_UNSET) request = request.is("center_class", null);
  else if (is032 && center) request = request.eq("center_class", center);

  const q = query?.trim();
  if (q) {
    // 검색어는 따옴표로 감싸 넘긴다 — 쉼표·괄호·따옴표·% 가 있어도 필터 문법이 깨지지 않는다
    // (일지 검색과 같은 방식, db/paging.ts containsPattern). ISBN 은 하이픈을 뺀 모양으로 본다.
    const pattern = containsPattern(q);
    const isbn = containsPattern(normalizeIsbn(q) ?? q.replace(/[\s-]/g, ""));
    request = request.or(
      `title.ilike.${pattern},author.ilike.${pattern},isbn.ilike.${isbn}` +
        (is032 ? `,reg_no.ilike.${pattern}` : ""),
    );
  }

  if (options.cursor) {
    const values = decodeCursor(options.cursor, sort);
    if (!values) throw new RuleError("목록 위치(cursor)가 올바르지 않습니다.");
    request = request.or(afterCursorFilter(sort, values));
  }

  for (const key of sort) request = request.order(key.column, { ascending: key.ascending });
  const { data, error, count } = await request.limit(limit + 1);

  if (error) {
    throw new Error(`도서 목록 조회 실패: ${error.message}`);
  }
  const page = cutPage((data ?? []) as unknown as Record<string, unknown>[], sort, limit);
  const books = page.items.map(({ sort_key: _s, ...rest }) => rest as unknown as BookItem);
  return { books, next_cursor: page.next_cursor, total: count ?? null };
}

/** 쓰고 있는 센터분류 이름들(목록 필터·등록 칸 제안용). 032 전이면 빈 목록 */
export async function listCenterClasses(): Promise<string[]> {
  if (!(await hasBook032())) return [];
  const { data, error } = await getClient()
    .from("books")
    .select("center_class")
    .not("center_class", "is", null)
    .limit(5000);
  if (error) throw new Error(`센터분류 조회 실패: ${error.message}`);
  return [...new Set((data ?? []).map((row) => String(row.center_class)))]
    .sort((a, b) => a.localeCompare(b, "ko"));
}

/** 한 권 */
export async function getBook(id: string): Promise<BookItem | null> {
  const { data, error } = await getClient()
    .from("books")
    .select(await columns())
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`도서 조회 실패: ${error.message}`);
  return (data as unknown as BookItem) ?? null;
}

export async function addBook(book: BookPatch & { title: string }): Promise<BookItem> {
  const values = { ...book, isbn: normalizeIsbn(book.isbn) } as Record<string, unknown>;
  await guard032(values);
  const { data, error } = await getClient()
    .from("books")
    .insert(await stripFor(values))
    .select(await columns())
    .single();

  if (error) {
    if (isDuplicateRegNo(error.message)) {
      throw new RuleError(`등록번호 ${book.reg_no} 인 책이 이미 있습니다.`);
    }
    if (isDuplicateIsbn(error.message)) {
      throw new RuleError(`ISBN ${book.isbn} 인 책이 이미 있습니다.`);
    }
    throw new Error(`도서 등록 실패: ${error.message}`);
  }
  return data as unknown as BookItem;
}

export async function updateBook(id: string, patch: BookPatch): Promise<BookItem> {
  const changes: Record<string, unknown> = { ...patch };
  if ("isbn" in patch) changes.isbn = normalizeIsbn(patch.isbn);

  if (Object.keys(changes).length === 0) {
    throw new RuleError("바꿀 내용이 없습니다.");
  }
  await guard032(changes);

  const { data, error } = await getClient()
    .from("books")
    .update(await stripFor(changes))
    .eq("id", id)
    .select(await columns())
    .single();

  if (error) {
    if (isDuplicateRegNo(error.message)) {
      throw new RuleError(`등록번호 ${patch.reg_no} 인 책이 이미 있습니다.`);
    }
    if (isDuplicateIsbn(error.message)) {
      throw new RuleError(`ISBN ${patch.isbn} 인 책이 이미 있습니다.`);
    }
    throw writeError(error, "도서 수정 실패", "그 책을 찾지 못했습니다. 이미 지워졌을 수 있어요.");
  }
  return data as unknown as BookItem;
}

/**
 * 도서 1건을 지운다.
 *
 * 잃어버리거나 버린 책은 지우지 말고 status 를 바꾸는 것이 맞다.
 * 삭제는 잘못 등록한 줄을 치울 때 쓴다. 화면의 확인창이 그 차이를 적는다.
 */
export async function deleteBook(id: string): Promise<void> {
  const before = await snapshotRow("books", id);
  if (!before) throw new NotFoundError("그 책을 찾지 못했습니다. 이미 지워졌을 수 있어요.");
  const { error } = await getClient()
    .from("books")
    .delete()
    .eq("id", id);

  if (error) {
    throw new Error(`도서 삭제 실패: ${error.message}`);
  }
  await recordAudit({
    action: "delete",
    table_name: "books",
    record_id: id,
    summary: `도서 삭제 — ${before?.title ?? "(제목 없음)"}`,
    before,
  });
}
