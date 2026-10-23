/**
 * 시스템 점검 — 관리자 전용
 *
 *   POST /api/system-check                  점검 실행 (항목별 결과)
 *   GET  /api/system-check/detail?item=     한 항목의 상세 목록
 *
 * [읽기만 한다. 고치지 않는다]
 * 이상을 찾아도 여기서 지우거나 되돌리지 않는다. 결과는 사람이 보고 판단한다 —
 * 자동으로 고치면 "왜 이게 없어졌지" 를 아무도 설명할 수 없게 된다.
 * 점검을 돌렸다는 사실만 감사 로그에 남긴다(누가 언제).
 *
 * [키 값은 절대 내보내지 않는다]
 * 환경변수는 있다/없다만 본다. 그것도 각 키를 읽는 파일(db/client.ts·lib/ai.ts·
 * lib/book_lookup.ts)에 물어서 — 이 파일은 Deno.env 를 직접 읽지 않는다(원칙 3).
 *
 * 이 파일은 Supabase 를 직접 부르지 않는다. /db 만 쓴다.
 */
import { dbMode, hasSupabaseConfig, ping } from "../db/client.ts";
import { hasAnthropicKey } from "../lib/ai.ts";
import { bookKeyPresence } from "../lib/book_lookup.ts";
import {
  adminCounts,
  auditHealth,
  countOrphans,
  DETAIL_KEYS,
  type DetailKey,
  detailOf,
  dummyCounts,
} from "../db/diagnostics.ts";
import { recordAudit } from "../db/audit.ts";
import { authMode, isEnforcing } from "./guard.ts";
import { checkCoverage, readRouterSource } from "./route_coverage.ts";

const JSON_HEADERS = { "cache-control": "no-store" };

type Status = "ok" | "warn" | "fail";

type Line = { status: Status; text: string; detail?: DetailKey };

type Item = {
  key: string;
  title: string;
  status: Status;
  summary: string;
  lines: Line[];
};

/** 줄들 중 가장 나쁜 것이 항목의 상태가 된다. */
function worst(lines: Line[]): Status {
  if (lines.some((one) => one.status === "fail")) return "fail";
  if (lines.some((one) => one.status === "warn")) return "warn";
  return "ok";
}

/** 한 항목이 통째로 실패해도 나머지 점검은 계속한다. */
async function safely(key: string, title: string, run: () => Promise<Item>): Promise<Item> {
  try {
    return await run();
  } catch (error) {
    console.error(`[system-check] ${key}`, error);
    return {
      key,
      title,
      status: "fail",
      summary: "점검 중 오류가 났습니다.",
      lines: [{ status: "fail", text: error instanceof Error ? error.message : String(error) }],
    };
  }
}

/* ---------- 1. 환경변수 ---------- */

async function checkEnv(): Promise<Item> {
  const supabase = hasSupabaseConfig();
  const books = bookKeyPresence();
  const enforcing = await isEnforcing();
  const mode = authMode();

  const has = (ok: boolean) => (ok ? "있음" : "없음");
  // DB 접속 — Postgres 직결(DATABASE_URL, 애저 컨테이너)이면 Supabase 키는 쓰지 않는다
  const dbLines: Line[] = dbMode() === "postgres"
    ? [{ status: "ok", text: "DATABASE_URL — 있음(Postgres 직결 — SUPABASE_URL·KEY 는 쓰지 않음)" }]
    : [
      { status: supabase.url ? "ok" : "fail", text: `SUPABASE_URL — ${has(supabase.url)}` },
      { status: supabase.key ? "ok" : "fail", text: `SUPABASE_KEY — ${has(supabase.key)}` },
    ];
  const lines: Line[] = [
    ...dbLines,
    {
      status: hasAnthropicKey() ? "ok" : "fail",
      text: `ANTHROPIC_API_KEY — ${
        has(hasAnthropicKey())
      } (없으면 관찰·자원 추출, 평가 초안, 사진 읽기가 멈춤)`,
    },
    {
      status: books.nlk ? "ok" : "warn",
      text: `NLK_API_KEY — ${has(books.nlk)} (없으면 국립중앙도서관 조회를 건너뜀)`,
    },
    {
      status: books.data4library ? "ok" : "warn",
      text: `DATA4LIBRARY_API_KEY — ${
        has(books.data4library)
      } (없으면 도서관 정보나루 조회를 건너뜀)`,
    },
    {
      status: enforcing ? "ok" : "warn",
      text: mode === "warn"
        ? "AUTH_ENFORCE=warn — 경고만(비상 되돌리기, 막지 않고 기록만 함). 원인을 고친 뒤 true 로 되돌려 주세요."
        : enforcing
        ? `AUTH_ENFORCE — 잠금(로그인·등급을 실제로 막음)${
          mode === "auto" ? " · 부팅 뒤 자동 잠금" : ""
        }`
        : "AUTH_ENFORCE — 부팅 전이라 아직 막지 않음(첫 관리자를 정하면 자동으로 잠김).",
    },
  ];
  const missing = lines.filter((one) => one.status !== "ok").length;
  return {
    key: "env",
    title: "환경변수",
    status: worst(lines),
    summary: missing === 0
      ? "필요한 키와 잠금 설정이 모두 들어 있습니다."
      : `${missing}곳을 확인하세요.`,
    lines,
  };
}

/* ---------- 2. DB 연결 ---------- */

function dbLabel(): string {
  return dbMode() === "postgres" ? "Postgres(직결)" : "Supabase";
}

async function checkDb(): Promise<Item> {
  const result = await ping();
  const lines: Line[] = [{
    status: result.ok ? (result.latencyMs > 2000 ? "warn" : "ok") : "fail",
    text: result.ok
      ? `${dbLabel()} 응답 ${result.latencyMs}ms${result.latencyMs > 2000 ? " — 느립니다" : ""}`
      : `연결 실패: ${result.message}`,
  }];
  return {
    key: "db",
    title: "DB 연결",
    status: worst(lines),
    summary: result.ok ? `${dbLabel()} 에 닿습니다.` : `${dbLabel()} 에 닿지 않습니다.`,
    lines,
  };
}

/* ---------- 3. 고아 데이터 ---------- */

async function checkOrphans(): Promise<Item> {
  const c = await countOrphans();
  const n = (count: number) => `${count}건`;

  const lines: Line[] = [
    {
      status: c.recordsWithoutJournal ? "warn" : "ok",
      text: `원본 일지가 없는 자원기록 ${n(c.recordsWithoutJournal)}` +
        (c.recordsWithoutJournal
          ? " — 일지 삭제 시 함께 지우도록 바뀌기 전의 것일 수 있습니다"
          : ""),
      detail: c.recordsWithoutJournal ? "records_without_journal" : undefined,
    },
    {
      status: c.recordsInLimbo ? "warn" : "ok",
      text: `어디에도 안 보이는 자원기록(status 'N') ${n(c.recordsInLimbo)}` +
        (c.recordsInLimbo ? " — 통계에도 미분류함에도 안 잡힙니다" : ""),
      detail: c.recordsInLimbo ? "records_in_limbo" : undefined,
    },
    {
      status: c.observationsNoChild ? "fail" : "ok",
      text: `없는 아동을 가리키는 관찰 ${n(c.observationsNoChild)}`,
    },
    {
      status: c.evaluationsNoChild ? "fail" : "ok",
      text: `없는 아동을 가리키는 연간평가 ${n(c.evaluationsNoChild)}`,
    },
    {
      status: c.halfObservationsNoChild ? "fail" : "ok",
      text: `없는 아동을 가리키는 반기 관찰 ${n(c.halfObservationsNoChild)}`,
    },
    {
      status: c.observationsBrokenCandidate ? "fail" : "ok",
      text: `없는 후보를 가리키는 관찰(병합 잔재) ${n(c.observationsBrokenCandidate)}`,
    },
    {
      status: c.candidatesBrokenMerge ? "fail" : "ok",
      text: `없는 줄에 합쳐졌다고 적힌 관찰 후보 ${n(c.candidatesBrokenMerge)}`,
    },
    {
      // 설계상 남는다 — 일지를 지워도 가져온 관찰은 사람이 쓴 기록이라 둔다.
      status: "ok",
      text: `원본 일지가 지워진 관찰 ${
        n(c.observationsJournalGone)
      } (설계상 남음 — 관찰 화면에 "원본 삭제" 로 표시)`,
      detail: c.observationsJournalGone ? "observations_journal_gone" : undefined,
    },
    {
      status: c.snapshotMissingEntries ? "warn" : "ok",
      text: `평가 스냅샷이 가리키는데 지금 없는 관찰 ${n(c.snapshotMissingEntries)}` +
        (c.snapshotMissingEvaluations
          ? ` (평가 ${c.snapshotMissingEvaluations}건 — 평가 화면 배너에서 [확인함] 으로 정리)`
          : ""),
      detail: c.snapshotMissingEntries ? "snapshot_missing" : undefined,
    },
  ];

  const bad = lines.filter((one) => one.status !== "ok").length;
  return {
    key: "orphans",
    title: "고아 데이터",
    status: worst(lines),
    summary: bad === 0 ? "서로 어긋난 기록이 없습니다." : `${bad}가지를 확인하세요.`,
    lines,
  };
}

/* ---------- 4. 정책표 커버리지 ---------- */

async function checkPolicy(): Promise<Item> {
  const { scanned, fallbacks, ghosts } = await checkCoverage(await readRouterSource());
  const lines: Line[] = [];

  if (fallbacks.length === 0) {
    lines.push({ status: "ok", text: `경로·메서드 ${scanned}개가 모두 정책표에 적혀 있습니다.` });
  }
  for (const one of fallbacks) {
    lines.push({
      status: "warn",
      text: `${one.method} ${one.path} — 표에 없어 "관리자만" 으로 떨어짐`,
    });
  }

  // 역방향. 표를 읽는 사람은 이 줄이 막고 있다고 믿지만 실제로는 아무 요청도 안 걸린다.
  if (ghosts.length === 0) {
    lines.push({ status: "ok", text: "정책표의 줄마다 실제 경로가 있습니다." });
  }
  for (const label of ghosts) {
    lines.push({
      status: "warn",
      text:
        `${label} — 표에는 있는데 이 줄에 맞는 실제 경로가 없음(오타이거나 막는다고 착각한 자리)`,
    });
  }

  const problems = [
    fallbacks.length ? `기본값으로 떨어지는 경로 ${fallbacks.length}개` : "",
    ghosts.length ? `실제 경로가 없는 표의 줄 ${ghosts.length}개` : "",
  ].filter(Boolean);

  return {
    key: "policy",
    title: "정책표 커버리지",
    status: worst(lines),
    summary: problems.length === 0
      ? `${scanned}개 경로·메서드 확인, 양방향 짝이 맞습니다.`
      : `${problems.join(" · ")} — 의도한 것인지 보세요.`,
    lines,
  };
}

/* ---------- 5. 감사 로그 ---------- */

async function checkAudit(): Promise<Item> {
  const a = await auditHealth();
  const days = a.latestAt ? Math.floor((Date.now() - Date.parse(a.latestAt)) / 86_400_000) : null;

  const lines: Line[] = [
    {
      status: a.total === 0 ? "fail" : days !== null && days > 30 ? "warn" : "ok",
      text: a.total === 0
        ? "기록이 하나도 없습니다 — 삭제·수정이 남지 않고 있을 수 있습니다"
        : `최근 기록 ${days === 0 ? "오늘" : `${days}일 전`} · 전체 ${a.total}건`,
    },
    {
      status: a.noActor ? "warn" : "ok",
      text: `누가 했는지 비어 있는 기록 ${a.noActor}건` +
        (a.noActor ? " — 로그인 도입(3단계) 이전 기록이면 정상입니다" : ""),
      detail: a.noActor ? "audit_no_actor" : undefined,
    },
  ];
  return {
    key: "audit",
    title: "감사 로그",
    status: worst(lines),
    summary: a.total === 0 ? "기록이 없습니다." : "기록이 쌓이고 있습니다.",
    lines,
  };
}

/* ---------- 6. 계정 ---------- */

async function checkAccounts(): Promise<Item> {
  const { flagged, usable } = await adminCounts();
  const lines: Line[] = [
    {
      status: usable === 0 ? "fail" : usable === 1 ? "warn" : "ok",
      text: usable === 0
        ? "로그인할 수 있는 관리자가 없습니다 — 아무도 계정을 발급할 수 없습니다"
        : usable === 1
        ? "로그인할 수 있는 관리자가 1명 — 그 사람이 자리를 비우면 계정 발급이 멈춥니다"
        : `로그인할 수 있는 관리자 ${usable}명`,
    },
    {
      status: flagged > usable ? "warn" : "ok",
      text: flagged > usable
        ? `관리자 깃발은 ${flagged}명인데 ${
          flagged - usable
        }명은 정지·퇴사·비밀번호 없음으로 쓸 수 없습니다`
        : `관리자 깃발 ${flagged}명 모두 쓸 수 있는 계정입니다`,
    },
    {
      status: "ok",
      text:
        "마지막 관리자 보호: 켜짐 — 마지막 한 명은 해제·정지를 서버가 거절합니다(api/accounts.ts)",
    },
  ];
  return {
    key: "accounts",
    title: "계정",
    status: worst(lines),
    summary: `관리자 ${usable}명이 로그인할 수 있습니다.`,
    lines,
  };
}

/* ---------- 7. 더미 표식 ---------- */

async function checkDummy(): Promise<Item> {
  const d = await dummyCounts();
  const total = d.sessions + d.observations + d.journals + d.halfObservations + d.inquiries;
  const lines: Line[] = [
    {
      status: d.sessions ? "warn" : "ok",
      text: `검증용으로 만든 세션 ${d.sessions}건 (user_agent = "verify-script")`,
    },
    {
      status: d.observations + d.journals + d.halfObservations + d.inquiries ? "warn" : "ok",
      text: `"[검증]" 표식이 붙은 기록 — 관찰 ${d.observations} · 일지 ${d.journals} · ` +
        `반기 관찰 ${d.halfObservations} · 문의 ${d.inquiries}`,
    },
  ];
  return {
    key: "dummy",
    title: "더미 표식",
    status: worst(lines),
    summary: total === 0 ? "검증 흔적이 없습니다." : `실사용 전에 비울 것 ${total}건.`,
    lines,
  };
}

/* ---------- POST /api/system-check ---------- */

export async function handleSystemCheck(): Promise<Response> {
  const startedAt = new Date().toISOString();

  // 서로 기다릴 이유가 없어 함께 돌린다(환경변수도 잠금 여부를 DB 로 보므로 같이).
  const items: Item[] = [
    ...(await Promise.all([
      safely("env", "환경변수", checkEnv),
      safely("db", "DB 연결", checkDb),
      safely("orphans", "고아 데이터", checkOrphans),
      safely("policy", "정책표 커버리지", checkPolicy),
      safely("audit", "감사 로그", checkAudit),
      safely("accounts", "계정", checkAccounts),
      safely("dummy", "더미 표식", checkDummy),
    ])),
  ];

  const tally = {
    ok: items.filter((one) => one.status === "ok").length,
    warn: items.filter((one) => one.status === "warn").length,
    fail: items.filter((one) => one.status === "fail").length,
  };

  // 점검을 돌렸다는 사실만 남긴다. 누가(actor)는 요청 컨텍스트에서 붙는다.
  // 감사 로그 action 은 create·update·delete 셋뿐이라 "점검 한 번이 만들어졌다" 로 적는다.
  try {
    await recordAudit({
      action: "create",
      table_name: "system_check",
      record_id: null,
      summary: `시스템 점검 실행 — 정상 ${tally.ok} · 주의 ${tally.warn} · 문제 ${tally.fail}`,
      after: { ran_at: startedAt, tally },
    });
  } catch (error) {
    // 점검 결과는 그대로 보여 준다. 기록 실패는 서버 로그와 결과에 함께 알린다.
    console.error("[system-check] 감사 기록 실패", error);
    items.push({
      key: "audit_write",
      title: "점검 기록",
      status: "warn",
      summary: "이번 점검을 감사 로그에 남기지 못했습니다.",
      lines: [{ status: "warn", text: error instanceof Error ? error.message : String(error) }],
    });
  }

  return Response.json({ ran_at: startedAt, tally, items }, { headers: JSON_HEADERS });
}

/* ---------- GET /api/system-check/detail ---------- */

export async function handleSystemCheckDetail(req: Request): Promise<Response> {
  const item = new URL(req.url).searchParams.get("item") ?? "";
  if (!(DETAIL_KEYS as readonly string[]).includes(item)) {
    return Response.json({ error: "모르는 점검 항목입니다." }, {
      status: 400,
      headers: JSON_HEADERS,
    });
  }
  try {
    return Response.json({ item, rows: await detailOf(item as DetailKey) }, {
      headers: JSON_HEADERS,
    });
  } catch (error) {
    console.error("[GET /api/system-check/detail]", error);
    return Response.json({ error: "상세를 읽지 못했습니다." }, {
      status: 500,
      headers: JSON_HEADERS,
    });
  }
}
