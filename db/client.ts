/**
 * Supabase 클라이언트 (단일 생성 지점)
 *
 * 규칙:
 *  - 이 파일 밖에서는 절대 createClient()를 호출하지 않는다.
 *  - Supabase를 직접 부르는 코드는 /db 폴더 안에만 존재한다.
 *    (나중에 다른 DB로 교체할 때 /db만 갈아끼우면 되도록)
 *  - 키는 환경변수(SUPABASE_URL, SUPABASE_KEY)에서만 읽는다. 하드코딩 금지.
 *  - DATABASE_URL(Postgres 접속 주소)이 있으면 Supabase REST 대신 Postgres 에 직결한다(db/pg.ts).
 *    Supabase 직결 주소든 애저 PostgreSQL 이든 같은 코드가 돈다(애저 이전). 이 값도 이 파일만 읽는다.
 *  - SUPABASE_KEY는 service_role 키이므로 절대 브라우저로 내려보내지 않는다.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createPgClient, type PgClient } from "./pg.ts";

/**
 * 규칙에 어긋난 요청. 서버가 고장난 것이 아니라 요청이 틀린 것이다.
 *
 * /db 안에서 "이건 할 수 없는 일이다"를 알릴 때 쓴다.
 *   합칠 수 없는 두 관찰, 일정에 매인 일지의 날짜 바꾸기 …
 * /api 는 이 예외만 400 으로 돌려보내고, 메시지를 그대로 사람에게 보여준다.
 * 나머지 오류는 DB 구조를 노출하므로 서버 로그에만 남기고 500 으로 끊는다.
 *
 * 여기 두는 이유: 표 하나에 매인 개념이 아니라 /db 전체가 함께 쓰는 말이라서다.
 */
export class RuleError extends Error {}

/** 찾는 대상이 없다(이미 지워졌거나 잘못된 id). /api 는 404 로 돌려준다. RuleError 의 한 갈래. */
export class NotFoundError extends RuleError {}

/**
 * 쓰기(insert·update) 오류를 풀어 준다.
 *   PGRST116(한 줄을 기대했는데 0줄) → NotFoundError(404)
 *   23503 외래키 위반(없는 사람·아동·일정을 가리킴) → RuleError(400)
 *   그 밖 → 평범한 Error(500, 원문은 서버 로그에만)
 */
export function writeError(
  error: { code?: string; message: string },
  label: string,
  notFound = "찾는 기록이 없습니다. 이미 지워졌을 수 있어요 — 화면을 새로 고쳐 주세요.",
): Error {
  if (error.code === "PGRST116") return new NotFoundError(notFound);
  if (error.code === "23503") {
    return new RuleError("가리킨 사람·아동·일정을 찾지 못했습니다. 화면을 새로 고쳐 주세요.");
  }
  return new Error(`${label}: ${error.message}`);
}

/**
 * DB 함수(RPC)가 낸 오류를 풀어 준다. 함수는 실패하면 아무것도 바꾸지 않는다(트랜잭션).
 *   P0002 not_found      → 사람이 읽을 말(RuleError, 400)
 *   P0001 merge_mismatch → 사람이 읽을 말(RuleError, 400) — 앱이 읽은 뒤 그 사이에 바뀐 경우
 *   그 밖                → 평범한 Error(500, 원문은 서버 로그에만)
 */
export function rpcError(
  error: { code?: string; message: string },
  messages: { notFound: string; mismatch?: string },
  label: string,
): Error {
  if (error.code === "P0002") return new NotFoundError(messages.notFound);
  if (error.code === "P0001" && error.message === "merge_mismatch") {
    return new RuleError(messages.mismatch ?? "지금은 합칠 수 없습니다. 화면을 새로 고쳐 주세요.");
  }
  return new Error(`${label}(아무것도 바꾸지 않음): ${error.message}`);
}

/**
 * Supabase 설정이 들어 있는가. 시스템 점검 화면이 쓴다.
 *
 * 값은 돌려주지 않는다 — 있다/없다만. 키를 읽는 곳이 이 파일 하나라는 원칙(3)을
 * 지키려고 점검 코드가 환경변수를 직접 보지 않고 여기를 부른다.
 */
export function hasSupabaseConfig(): { url: boolean; key: boolean } {
  return {
    url: Boolean(Deno.env.get("SUPABASE_URL")?.trim()),
    key: Boolean(Deno.env.get("SUPABASE_KEY")?.trim()),
  };
}

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(
      `환경변수 ${name} 이(가) 설정되지 않았습니다. .env.example을 참고해 .env를 만들거나 Deno Deploy에 환경변수를 등록하세요.`,
    );
  }
  return value;
}

/**
 * SUPABASE_URL을 supabase-js가 기대하는 형태로 정규화한다.
 *
 * supabase-js는 이 값 뒤에 "/rest/v1/..." 을 문자열로 이어붙인다.
 * 그래서 프로젝트 루트(https://xxx.supabase.co)만 들어와야 하는데,
 * 대시보드에서 복사하다 보면 다음 두 가지가 섞여 들어온다.
 *   - 끝의 슬래시            → "//rest/v1/..."
 *   - "/rest/v1" 경로까지    → "/rest/v1/rest/v1/..."
 * 둘 다 PGRST125 "Invalid path specified in request URL" 로 실패하므로
 * 여기서 흡수한다. 잘못된 값이 배포 환경에 들어가도 동작하게 하려는 것.
 */
function requireUrl(name: string): string {
  const raw = requireEnv(name).trim();

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`환경변수 ${name} 이(가) 올바른 URL이 아닙니다: 값의 형식을 확인하세요.`);
  }

  // 끝의 슬래시와 REST 경로를 떼어낸다.
  const path = parsed.pathname.replace(/\/+$/, "").replace(/\/rest\/v1$/, "");
  return `${parsed.origin}${path}`;
}

let cached: SupabaseClient | null = null;
let pgCached: PgClient | null = null;

function databaseUrl(): string | null {
  return Deno.env.get("DATABASE_URL")?.trim() || null;
}

/** 지금 어느 길로 DB 에 닿는가 — 시스템 점검·health 가 보여 준다(값은 내보내지 않는다) */
export function dbMode(): "postgres" | "supabase" {
  return databaseUrl() ? "postgres" : "supabase";
}

/**
 * Supabase 클라이언트를 반환한다. 최초 호출 시 1회만 생성한다.
 * /db 폴더 안의 도메인별 데이터 접근 함수들이 이 함수를 사용한다.
 */
let testClient: unknown = null;

/** 대조 시험 전용 — 이 프로세스의 getClient() 가 돌려줄 것을 바꾼다(null 이면 원래대로) */
export function setClientForTest(client: unknown): void {
  testClient = client;
}

export function getClient(): SupabaseClient {
  if (testClient) return testClient as SupabaseClient;
  const url = databaseUrl();
  if (url) {
    // 호출 모양이 같으므로 /db 코드는 그대로 — 타입만 supabase-js 것을 빌려 쓴다(db/pg.ts 머리 주석)
    pgCached ??= createPgClient(url);
    return pgCached as unknown as SupabaseClient;
  }
  if (cached) return cached;

  cached = createClient(requireUrl("SUPABASE_URL"), requireEnv("SUPABASE_KEY"), {
    auth: {
      // 서버 환경이므로 세션을 저장하거나 갱신하지 않는다.
      persistSession: false,
      autoRefreshToken: false,
    },
  });
  return cached;
}

export type PingResult = {
  ok: boolean;
  status: number | null;
  message: string;
  latencyMs: number;
};

/**
 * Supabase에 실제로 도달하는지, URL과 키가 유효한지 확인한다.
 * 테이블이 아직 없어도 동작하도록 REST 루트(/rest/v1/)를 호출한다.
 *  - 200: 연결 및 인증 정상
 *  - 401/403: 키가 잘못됨
 */
export async function ping(): Promise<PingResult> {
  const startedAt = performance.now();
  if (databaseUrl()) {
    try {
      pgCached ??= createPgClient(databaseUrl()!);
      await pgCached.ping();
      return {
        ok: true,
        status: 200,
        message: "연결 성공(Postgres 직결)",
        latencyMs: Math.round(performance.now() - startedAt),
      };
    } catch (error) {
      // 접속 주소(비밀번호 포함)가 오류 글에 섞여 나가지 않게 코드·짧은 글만
      const e = error as { code?: string; message?: string };
      return {
        ok: false,
        status: null,
        message: `Postgres 연결 실패: ${e.code ?? ""} ${
          String(e.message ?? error).replace(/postgres(ql)?:\/\/\S+/g, "(주소)").slice(0, 120)
        }`,
        latencyMs: Math.round(performance.now() - startedAt),
      };
    }
  }
  try {
    const url = requireUrl("SUPABASE_URL");
    const key = requireEnv("SUPABASE_KEY");

    const response = await fetch(new URL("/rest/v1/", url), {
      method: "GET",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
      signal: AbortSignal.timeout(5000),
    });
    // 응답 본문을 읽어 리소스 누수를 막는다.
    await response.body?.cancel();

    const latencyMs = Math.round(performance.now() - startedAt);
    if (response.ok) {
      return { ok: true, status: response.status, message: "연결 성공", latencyMs };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        status: response.status,
        message: "인증 실패: SUPABASE_KEY를 확인하세요.",
        latencyMs,
      };
    }
    return {
      ok: false,
      status: response.status,
      message: `예상치 못한 응답: HTTP ${response.status}`,
      latencyMs,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const cause = error instanceof Error && error.cause instanceof Error
      ? ` (${error.cause.message})`
      : "";
    return {
      ok: false,
      status: null,
      message: detail + cause,
      latencyMs: Math.round(performance.now() - startedAt),
    };
  }
}
