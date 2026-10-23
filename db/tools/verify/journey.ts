/**
 * 여정 완주 — 봉사자·종사자가 실제로 밟는 길을 HTTP 로 기계 반복한다(각 N회, 기본 10).
 *
 *   봉사자: 초대코드 → 비밀번호·동의 → 일정 등록 → 일지 작성 → 통계 확인  (+ 뒤에서 도는 분석 완료)
 *   종사자: 로그인 → 일지 작성 → 분석 대기(관찰·자원) → 후보 검토 → 관찰 가져오기 → 영역 지정
 *           → 평가 초안(저장 안 함) → 인쇄 미리보기(관찰일지)
 *
 * 화면이 부르는 API 를 화면과 같은 순서로 부른다. 계정은 [검증] 표식을 달고 새로 만들며
 * 비밀번호는 스크립트가 만들어 API 로만 넣는다(어디에도 적지 않는다). 모든 요청의 User-Agent 는
 * "verify-script" — finish.ts 가 그 세션을 지운다. 만든 계정·일지·관찰은 표식째 남는다(증거물).
 *
 * 준비: setup.ts(센터장 세션 — 계정 등록·초대코드 발급에 쓴다) → 서버(AUTH_ENFORCE=true)
 *   VERIFY_BASE=http://localhost:8000 deno run -A --env-file db/tools/verify/journey.ts [횟수]
 * 결과는 out/journey.json. AI 호출: 봉사 1회당 2(분석), 종사자 1회당 3(분석 2 + 초안 1).
 */
import { getClient } from "../../client.ts";

if (Deno.env.get("DATABASE_URL")) {
  console.error("DATABASE_URL 이 있다 — 여정 검증은 연습장에서만(계정·일지를 만든다). 멈춤.");
  Deno.exit(1);
}
const OUT = new URL("./out/", import.meta.url);
const acc = JSON.parse(Deno.readTextFileSync(new URL("accounts.json", OUT)));
const BASE = Deno.env.get("VERIFY_BASE") ?? "http://localhost:8000";
const RUNS = Number(Deno.args[0] ?? 10);
const DAY = "2026-09-12"; // 지난 토요일 — 봉사일지는 오늘까지만 쓸 수 있다
// deno-lint-ignore no-explicit-any
const db = getClient() as any;

type Step = { step: string; ok: boolean; ms: number; note?: string };
// deno-lint-ignore no-explicit-any
type Json = any;

async function call(
  method: string,
  path: string,
  opts: { cookie?: string; body?: unknown } = {},
): Promise<{ status: number; json: Json; cookie?: string; text: string }> {
  const headers: Record<string, string> = { "user-agent": "verify-script" };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.cookie) headers.cookie = `ok_session=${opts.cookie}`;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let json: Json = null;
  try {
    json = JSON.parse(text);
  } catch { /* html 등 */ }
  const set = res.headers.get("set-cookie") ?? "";
  const cookie = /ok_session=([^;]+)/.exec(set)?.[1];
  return { status: res.status, json, cookie, text };
}

/** 한 단계를 재고, 실패면 이유를 남긴다. check 가 문자열을 돌려주면 실패. */
async function step<T>(
  steps: Step[],
  name: string,
  run: () => Promise<T>,
  check: (v: T) => string | null,
): Promise<T | null> {
  const t = performance.now();
  try {
    const v = await run();
    const problem = check(v);
    steps.push({
      step: name,
      ok: !problem,
      ms: Math.round(performance.now() - t),
      note: problem ?? undefined,
    });
    return problem ? null : v;
  } catch (error) {
    steps.push({
      step: name,
      ok: false,
      ms: Math.round(performance.now() - t),
      note: String(error),
    });
    return null;
  }
}

const head = acc.head.token as string;
const need200 = (r: { status: number; text: string }) =>
  r.status === 200 ? null : `${r.status} ${r.text.slice(0, 120)}`;
const password = () => `vf-${crypto.randomUUID()}`;
const pad = (i: number) => String(i).padStart(2, "0");

/** 센터장 화면에서 하는 일 — 명단 등록 + 초대코드 발급(여정 밖, 재지 않는다) */
async function invite(name: string, roles: string[]): Promise<{ id: string; code: string }> {
  const made = await call("POST", "/api/staff", { cookie: head, body: { name, roles } });
  if (made.status !== 200) {
    throw new Error(`등록 실패 ${name}: ${made.status} ${made.text.slice(0, 120)}`);
  }
  const id = made.json.staff.id;
  const issued = await call("POST", `/api/accounts/${id}/code`, { cookie: head, body: {} });
  if (issued.status !== 200) throw new Error(`코드 실패 ${name}: ${issued.status}`);
  return { id, code: issued.json.code };
}

const VOL_TEXT = [
  "나라가 받아쓰기 틀린 낱말을 공책에 세 번씩 다시 써 보았다.",
  "마이가 보드게임 순서를 기다리며 친구에게 먼저 하라고 양보했다.",
  "나라가 수학 문제를 풀다가 막히자 스스로 손을 들어 질문했다.",
  "마이가 그림책을 소리 내어 읽고 모르는 낱말에 밑줄을 그었다.",
  "나라가 간식 정리 당번을 맡아 끝까지 책상을 닦았다.",
];
const STAFF_TEXT = [
  "김이나라가 오늘 독서 시간에 30분 동안 자리를 지키며 책을 끝까지 읽었다.",
  "응우옌티마이가 미술 시간에 색종이로 가족 얼굴을 만들고 이름을 한글로 적었다.",
  "김이나라가 줄넘기 시간에 처음으로 쉬지 않고 스무 번을 넘었다.",
  "응우옌티마이가 친구와 다툰 뒤 먼저 다가가 미안하다고 말했다.",
  "김이나라가 숙제 검사 때 틀린 문제를 다시 풀어 와서 보여 주었다.",
];

// ---------- 봉사자 ----------
const volunteer: { run: number; steps: Step[]; journal?: string; savedAt?: number }[] = [];
for (let i = 1; i <= RUNS; i++) {
  const name = `[검증]여정봉사${pad(i)}`;
  const { code } = await invite(name, ["봉사자"]);
  const steps: Step[] = [];
  const row: (typeof volunteer)[number] = { run: i, steps };
  volunteer.push(row);
  let cookie = "";
  const ok1 = await step(
    steps,
    "초대코드",
    () => call("POST", "/api/auth/verify-code", { body: { name, code } }),
    need200,
  );
  if (!ok1) continue;
  const pw = await step(
    steps,
    "비밀번호·동의",
    () =>
      call("POST", "/api/auth/first-password", {
        body: { name, code, password: password(), agreed: true },
      }),
    (r) => need200(r) ?? (r.cookie ? null : "세션 쿠키 없음"),
  );
  if (!pw) continue;
  cookie = pw.cookie!;
  const consent = await step(
    steps,
    "동의 확인",
    () => call("GET", "/api/auth/consent", { cookie }),
    (r) => need200(r) ?? (r.json.needed === false ? null : "동의가 아직 필요로 나옴"),
  );
  if (!consent) continue;
  const sched = await step(
    steps,
    "일정 등록",
    () =>
      call("POST", "/api/my/schedules", {
        cookie,
        body: { dates: [DAY], start_time: "10:00", end_time: "12:00" },
      }),
    (r) => need200(r) ?? (r.json.created === 1 ? null : `created=${r.json.created}`),
  );
  if (!sched) continue;
  const text = `${VOL_TEXT[(i - 1) % VOL_TEXT.length]} (여정 ${pad(i)})`;
  const wrote = await step(
    steps,
    "일지 작성",
    () => call("POST", "/api/my/journals", { cookie, body: { journal_date: DAY, content: text } }),
    (r) => need200(r) ?? (r.json.journal?.id ? null : "일지 id 없음"),
  );
  if (!wrote) continue;
  row.journal = wrote.json.journal.id;
  row.savedAt = performance.now();
  await step(steps, "통계 확인", () => call("GET", "/api/my/stats?year=2026", { cookie }), (r) => {
    const sep = r.json?.months?.find((m: Json) => m.month === 9 || m.month === "2026-09");
    return need200(r) ??
      (r.json.total?.schedules >= 1 && r.json.total?.written >= 1
        ? null
        : `total=${JSON.stringify(r.json.total)} sep=${JSON.stringify(sep)}`);
  });
}
// 뒤에서 도는 분석(관찰·자원)이 끝났는지 — 저장부터 끝남까지
const deadline = Date.now() + 5 * 60_000;
for (const row of volunteer) {
  if (!row.journal) continue;
  let done = false;
  while (!done && Date.now() < deadline) {
    const j =
      (await db.from("journals").select("observations_analyzed_at,resources_analyzed_at").eq(
        "id",
        row.journal,
      ).single()).data;
    done = !!(j?.observations_analyzed_at && j?.resources_analyzed_at);
    if (!done) await new Promise((r) => setTimeout(r, 1000));
  }
  row.steps.push({
    step: "분석 완료(뒤에서)",
    ok: done,
    ms: Math.round(performance.now() - row.savedAt!),
    note: done ? "저장 응답부터 잰 시간(앞 일지 분석이 겹치면 늘어난다)" : "5분 안에 안 끝남",
  });
}
console.log("봉사자 여정 끝");

// ---------- 종사자 ----------
const staffName = "[검증]여정종사자";
const staffPw = password();
{
  const { code } = await invite(staffName, ["생활복지사"]);
  const r = await call("POST", "/api/auth/first-password", {
    body: { name: staffName, code, password: staffPw, agreed: true },
  });
  if (r.status !== 200) throw new Error(`종사자 첫 비밀번호 실패 ${r.status}`);
}
const areas = (await call("GET", "/api/settings/observation_areas", { cookie: head })).json.value
  .filter((a: Json) => !a.deleted);
const staffRuns: { run: number; steps: Step[]; journal?: string; child?: string }[] = [];
for (let i = 1; i <= RUNS; i++) {
  const steps: Step[] = [];
  const row: (typeof staffRuns)[number] = { run: i, steps };
  staffRuns.push(row);
  const login = await step(
    steps,
    "로그인",
    () => call("POST", "/api/auth/login", { body: { name: staffName, password: staffPw } }),
    (r) => need200(r) ?? (r.cookie ? null : "세션 쿠키 없음"),
  );
  if (!login) continue;
  const cookie = login.cookie!;
  const text = `${STAFF_TEXT[(i - 1) % STAFF_TEXT.length]} (여정 ${pad(i)})`;
  const wrote = await step(
    steps,
    "일지 작성",
    () =>
      call("POST", "/api/journals", {
        cookie,
        body: {
          kind: "프로그램",
          journal_date: DAY,
          title: `[검증] 여정 종사자 ${pad(i)}`,
          content: text,
        },
      }),
    (r) => need200(r) ?? (r.json.journal?.id ? null : "일지 id 없음"),
  );
  if (!wrote) continue;
  const jid = wrote.json.journal.id;
  row.journal = jid;
  // 화면은 저장 뒤 관찰 → 자원 분석을 차례로 부른다(journals.js)
  const analyzed = await step(steps, "분석 대기", async () => {
    const a = await call("POST", `/api/journals/${jid}/extract`, { cookie, body: {} });
    const b = await call("POST", `/api/journals/${jid}/extract-resources`, { cookie, body: {} });
    return { a, b };
  }, ({ a, b }) => need200(a) ?? need200(b));
  if (!analyzed) continue;
  const cands = await step(
    steps,
    "후보 검토",
    () => call("GET", `/api/journals/${jid}/observations`, { cookie }),
    (r) => {
      const list = r.json?.observations ?? [];
      return need200(r) ??
        (list.some((c: Json) => c.child_id) ? null : `아동 확정 후보 없음(${list.length}건)`);
    },
  );
  if (!cands) continue;
  const pick = cands.json.observations.find((c: Json) => c.child_id);
  row.child = pick.child_id;
  const imported = await step(
    steps,
    "관찰 가져오기",
    () =>
      call("POST", "/api/observations/import", {
        cookie,
        body: { child_id: pick.child_id, ids: [pick.id] },
      }),
    (r) => need200(r),
  );
  if (!imported) continue;
  // 가져온 관찰 id — 그 아동의 이번 반기 관찰 중 이 후보에서 온 것
  const obsList = await call("GET", `/api/observations?child=${pick.child_id}&year=2026&half=2`, {
    cookie,
  });
  const obs = (obsList.json?.observations ?? []).find((o: Json) =>
    o.source_journal_obs_id === pick.id ||
    (o.content === pick.content && !o.area)
  );
  const area = areas[(i - 1) % areas.length].code;
  const placed = await step(
    steps,
    "영역 지정",
    () =>
      obs
        ? call("PATCH", `/api/observations/${obs.id}/area`, { cookie, body: { area } })
        : Promise.resolve({ status: 0, text: "가져온 관찰을 못 찾음", json: null }),
    (r) => need200(r as { status: number; text: string }),
  );
  if (!placed) continue;
  await step(
    steps,
    "평가 초안",
    () =>
      call("POST", `/api/children/${pick.child_id}/evaluation/draft`, {
        cookie,
        body: { year: 2026, half: 2 },
      }),
    (r) => need200(r) ?? (r.json?.draft || r.json?.content ? null : "초안 내용 없음"),
  );
  await step(steps, "인쇄 미리보기", async () => {
    const page = await call(
      "GET",
      `/print?kind=observations&child=${pick.child_id}&year=2026&half=2`,
      { cookie },
    );
    const parts = await Promise.all([
      call("GET", `/api/children/${pick.child_id}`, { cookie }),
      call("GET", "/api/settings/observation_areas", { cookie }),
      call("GET", "/api/auth/me", { cookie }),
      call("GET", "/api/settings/center_name", { cookie }),
      call("GET", `/api/observations?child=${pick.child_id}&year=2026&half=2`, { cookie }),
    ]);
    return { page, parts };
  }, ({ page, parts }) => {
    if (page.status !== 200 || !page.text.includes("<")) return `인쇄 화면 ${page.status}`;
    const bad = parts.find((p) => p.status !== 200);
    if (bad) return need200(bad);
    const printed = (parts[4].json?.observations ?? []).some((o: Json) =>
      o.id === obs.id && o.area === area
    );
    return printed ? null : "지정한 관찰이 인쇄 자료에 없음";
  });
}
console.log("종사자 여정 끝");

await Deno.writeTextFile(
  new URL("journey.json", OUT),
  JSON.stringify({ volunteer, staff: staffRuns }, null, 1),
);
const summary = (runs: { steps: Step[] }[], names: string[]) => ({
  완주: `${
    runs.filter((r) => names.every((n) => r.steps.find((s) => s.step === n)?.ok)).length
  }/${runs.length}`,
  단계: names.map((n) => {
    const got = runs.map((r) => r.steps.find((s) => s.step === n)).filter(Boolean) as Step[];
    const ms = got.filter((s) => s.ok).map((s) => s.ms).sort((a, b) => a - b);
    return {
      단계: n,
      성공: `${got.filter((s) => s.ok).length}/${runs.length}`,
      중앙값ms: ms[Math.floor(ms.length / 2)] ?? null,
      최대ms: ms.at(-1) ?? null,
      실패: got.filter((s) => !s.ok).map((s) => s.note),
    };
  }),
});
console.log(JSON.stringify(
  {
    봉사자: summary(volunteer, [
      "초대코드",
      "비밀번호·동의",
      "동의 확인",
      "일정 등록",
      "일지 작성",
      "통계 확인",
      "분석 완료(뒤에서)",
    ]),
    종사자: summary(staffRuns, [
      "로그인",
      "일지 작성",
      "분석 대기",
      "후보 검토",
      "관찰 가져오기",
      "영역 지정",
      "평가 초안",
      "인쇄 미리보기",
    ]),
  },
  null,
  1,
));
Deno.exit(0);
