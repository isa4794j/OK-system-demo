/**
 * 권한표 — 경로 126줄 × 신분 8(비로그인·봉사·멘토봉사·종사자·겸직 종사자·센터장·종사자 폰·관리자) = 1,008회.
 *
 * 기대값은 기능 지도(2장·3장)의 등급을 **손으로 옮긴 것**이다 — api/policy.ts 를 읽어 만들지 않는다.
 * 표를 코드에서 뽑으면 코드가 틀릴 때 기대값도 같이 틀려서 아무것도 못 잡는다.
 * 관문(로그인 필요·등급 부족·PC 전용)에 막혔는지만 본다. 통과한 요청은 없는 uuid·빈 본문이라
 * 값 검사에서 400/404 로 끝나 데이터가 바뀌지 않는다. 5xx 는 따로 모은다.
 *
 * 준비: setup.ts(검증 세션) → 서버를 AUTH_ENFORCE=true 로 띄운다 → 이 파일 → finish.ts.
 *   VERIFY_BASE=http://localhost:8000 deno run -A db/tools/verify/matrix.ts
 * 결과(경로×신분 상태 코드)는 out/matrix_out.json.
 *
 * 등급을 바꾸면 여기 기대값도 손으로 고친다(2026-09-18: 봉사자 설정 세 열쇠 GET 을 센터장으로).
 */
const OUT = new URL("./out/", import.meta.url);
const acc = JSON.parse(Deno.readTextFileSync(new URL("accounts.json", OUT)));
const BASE = Deno.env.get("VERIFY_BASE") ?? "http://localhost:8000";
const X = "00000000-0000-4000-8000-000000000000";
type Need = "공개" | "봉사" | "종사자" | "센터장" | "관리자";
type Opt = { m?: boolean; hidden?: boolean };
type Row = [string, string, Need, Opt?];
const R: Row[] = [
  ["GET", "/health", "공개"],
  ["GET", "/api/auth/state", "공개"],
  ["GET", "/api/auth/me", "공개"],
  ["POST", "/api/auth/login", "공개"],
  ["POST", "/api/auth/verify-code", "공개"],
  ["POST", "/api/auth/first-password", "공개"],
  ["POST", "/api/auth/bootstrap", "공개"],
  ["GET", "/api/auth/consent", "공개"],
  ["POST", "/api/auth/consent", "봉사", { m: true }],
  ["GET", "/api/public/privacy", "공개"],
  ["GET", "/api/settings/consent_form", "종사자"],
  ["PUT", "/api/settings/consent_form", "센터장"],
  ["GET", "/api/settings/privacy_policy", "종사자"],
  ["PUT", "/api/settings/privacy_policy", "센터장"],
  ["GET", "/api/settings/center_name", "종사자"],
  ["PUT", "/api/settings/center_name", "센터장"],
  ["GET", "/api/settings/not_a_key", "종사자"],
  ["GET", "/api/my/me", "봉사", { m: true }],
  ["POST", "/api/my/role", "봉사", { m: true }],
  ["GET", "/api/my/roster", "봉사", { m: true }],
  ["GET", "/api/my/stats", "봉사", { m: true }],
  ["GET", "/api/my/children", "봉사", { m: true, hidden: true }],
  ["GET", "/api/my/inquiries", "봉사", { m: true }],
  ["POST", "/api/my/inquiries", "봉사", { m: true }],
  ["GET", "/api/my/schedules", "봉사", { m: true }],
  ["POST", "/api/my/schedules", "봉사", { m: true }],
  ["PATCH", `/api/my/schedules/${X}`, "봉사", { m: true }],
  ["DELETE", `/api/my/schedules/${X}`, "봉사", { m: true }],
  ["GET", "/api/my/journals", "봉사", { m: true }],
  ["POST", "/api/my/journals", "봉사", { m: true }],
  ["PATCH", `/api/my/journals/${X}`, "봉사", { m: true }],
  ["DELETE", `/api/my/journals/${X}`, "봉사", { m: true }],
  ["GET", `/api/my/observations/${X}`, "봉사", { m: true, hidden: true }],
  ["PUT", `/api/my/observations/${X}`, "봉사", { m: true, hidden: true }],
  ["GET", "/api/children", "종사자"],
  ["POST", "/api/children", "종사자"],
  ["GET", `/api/children/${X}`, "종사자"],
  ["PATCH", `/api/children/${X}`, "종사자"],
  ["DELETE", `/api/children/${X}`, "종사자"],
  ["GET", `/api/children/${X}/records-count`, "종사자"],
  ["GET", `/api/children/${X}/importable`, "종사자"],
  ["GET", `/api/children/${X}/growth`, "종사자", { hidden: true }],
  ["GET", `/api/children/${X}/evaluation?year=2026&half=2`, "종사자"],
  ["PUT", `/api/children/${X}/evaluation`, "종사자"],
  ["POST", `/api/children/${X}/evaluation/draft`, "종사자"],
  ["POST", `/api/children/${X}/evaluation/evidence-check`, "종사자"],
  ["GET", "/api/observations", "종사자"],
  ["POST", "/api/observations", "종사자"],
  ["POST", "/api/observations/import", "종사자"],
  ["DELETE", `/api/observations/${X}`, "종사자"],
  ["PATCH", `/api/observations/${X}/area`, "종사자"],
  ["PATCH", `/api/observations/${X}/content`, "종사자"],
  ["POST", `/api/observations/${X}/split`, "종사자"],
  ["POST", `/api/observations/${X}/merge`, "종사자"],
  ["GET", "/api/journals", "종사자"],
  ["POST", "/api/journals", "종사자"],
  ["GET", "/api/journals/missing", "종사자"],
  ["PATCH", `/api/journals/${X}`, "종사자"],
  ["DELETE", `/api/journals/${X}`, "종사자"],
  ["POST", `/api/journals/${X}/extract`, "종사자"],
  ["GET", `/api/journals/${X}/observations`, "종사자"],
  ["POST", `/api/journals/${X}/resolve`, "종사자"],
  ["POST", `/api/journals/${X}/extract-resources`, "종사자"],
  ["GET", `/api/journals/${X}/resources`, "종사자"],
  ["POST", `/api/journals/${X}/resolve-resources`, "종사자"],
  ["PATCH", `/api/journal-observations/${X}`, "종사자"],
  ["DELETE", `/api/journal-observations/${X}`, "종사자"],
  ["POST", `/api/journal-observations/${X}/merge`, "종사자"],
  ["POST", `/api/journal-observations/${X}/split`, "종사자"],
  ["GET", "/api/schedules", "종사자"],
  ["POST", "/api/schedules", "종사자"],
  ["PATCH", `/api/schedules/${X}`, "종사자"],
  ["DELETE", `/api/schedules/${X}`, "종사자"],
  ["GET", "/api/staff", "종사자"],
  ["POST", "/api/staff", "센터장"],
  ["GET", "/api/staff/scheduled", "종사자"],
  ["GET", `/api/staff/${X}/records-count`, "종사자"],
  ["PATCH", `/api/staff/${X}`, "센터장"],
  ["DELETE", `/api/staff/${X}`, "센터장"],
  ["GET", "/api/accounts", "센터장"],
  ["POST", `/api/accounts/${X}/code`, "센터장"],
  ["DELETE", `/api/accounts/${X}/code`, "센터장"],
  ["PATCH", `/api/accounts/${X}`, "센터장"],
  ["GET", "/api/resources", "종사자"],
  ["POST", "/api/resources", "종사자"],
  ["POST", "/api/resources/batch", "종사자"],
  ["POST", "/api/resources/from-photo", "종사자"],
  ["PATCH", `/api/resources/${X}`, "종사자"],
  ["DELETE", `/api/resources/${X}`, "종사자"],
  ["GET", `/api/resources/${X}/record-count`, "종사자"],
  ["POST", `/api/resources/${X}/merge`, "종사자"],
  ["POST", `/api/resources/${X}/split`, "종사자"],
  ["POST", `/api/resources/${X}/reject`, "종사자"],
  ["GET", "/api/resource-categories", "종사자"],
  ["PUT", "/api/resource-categories", "종사자"],
  ["GET", "/api/resource-inbox", "종사자"],
  ["POST", "/api/resource-inbox/restore", "종사자"],
  ["PATCH", `/api/resource-records/${X}`, "종사자"],
  ["DELETE", `/api/resource-records/${X}`, "종사자"],
  ["GET", "/api/resource-stats?kind=category&from=2026-09-01&to=2026-09-30", "종사자"],
  ["GET", "/api/books", "종사자"],
  ["POST", "/api/books", "종사자"],
  ["PATCH", `/api/books/${X}`, "종사자"],
  ["POST", `/api/books/${X}/refresh`, "종사자"],
  ["DELETE", `/api/books/${X}`, "종사자"],
  ["GET", "/api/books/lookup", "종사자"],
  ["GET", "/api/books/search", "종사자"],
  ["POST", "/api/books/import/parse", "종사자"],
  ["POST", "/api/books/import/match", "종사자"],
  ["POST", "/api/books/from-cover", "종사자"],
  ["GET", "/api/settings/volunteer_journal_scope", "센터장"],
  ["PUT", "/api/settings/volunteer_journal_scope", "센터장"],
  ["GET", "/api/settings/observation_areas", "종사자"],
  ["PUT", "/api/settings/observation_areas", "관리자"],
  ["GET", "/api/settings/half_observation_open", "센터장", { hidden: true }],
  ["PUT", "/api/settings/half_observation_open", "센터장", { hidden: true }],
  ["GET", "/api/settings/half_observation_items", "센터장", { hidden: true }],
  ["PUT", "/api/settings/half_observation_items", "관리자", { hidden: true }],
  ["GET", "/api/inquiries", "종사자"],
  ["GET", "/api/inquiries/count", "종사자"],
  ["POST", `/api/inquiries/${X}/seen`, "종사자"],
  ["GET", "/api/audit", "관리자"],
  ["GET", "/api/guard-warnings", "관리자"],
  ["POST", "/api/system-check", "관리자"],
  ["GET", "/api/system-check/detail?key=x", "관리자"],
  ["GET", "/api/nope", "관리자"],
];
const LEVEL: Record<string, Need | null> = {
  anon: null,
  vol: "봉사",
  mentvol: "봉사",
  staff: "종사자",
  staffment: "종사자",
  head: "센터장",
  staffmobile: "종사자",
  admin: "관리자",
};
const MOBILE: Record<string, boolean> = { vol: true, mentvol: true, staffmobile: true };
const ORDER: Need[] = ["봉사", "종사자", "센터장", "관리자"];
const who = ["anon", ...Object.keys(acc)];
const problems: string[] = [];
const five: string[] = [];
const statuses: Record<string, Record<string, number>> = {};
let n = 0;
for (const [method, path, need, opt = {}] of R) {
  statuses[`${method} ${path}`] = {};
  for (const w of who) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (w !== "anon") headers.cookie = `ok_session=${acc[w].token}`;
    const body = method === "GET" || method === "DELETE" ? undefined : "{}";
    const res = await fetch(BASE + path, { method, headers, body });
    const text = await res.text();
    let kind = "";
    try {
      kind = JSON.parse(text).kind ?? "";
    } catch { /* 글자 응답 */ }
    n++;
    statuses[`${method} ${path}`][w] = res.status;
    const guard = (res.status === 401 || res.status === 403) &&
      ["로그인 필요", "등급 부족", "PC 전용"].includes(kind);
    const lv = LEVEL[w];
    let expectPass: boolean;
    if (need === "공개") expectPass = true;
    else if (!lv) expectPass = false;
    else if (MOBILE[w] && !opt.m) expectPass = false;
    else expectPass = ORDER.indexOf(lv) >= ORDER.indexOf(need);
    if (!guard !== expectPass) {
      problems.push(
        `${method} ${path} [${w}] 기대 ${expectPass ? "통과" : "막힘"} → ${res.status} ${kind} ${
          text.slice(0, 80)
        }`,
      );
    }
    if (!guard && opt.hidden && res.status !== 404) {
      problems.push(`숨김인데 열림: ${method} ${path} [${w}] ${res.status}`);
    }
    if (res.status >= 500) {
      five.push(`${method} ${path} [${w}] ${res.status} ${text.slice(0, 120)}`);
    }
  }
}
Deno.writeTextFileSync(new URL("matrix_out.json", OUT), JSON.stringify(statuses, null, 1));
console.log(
  JSON.stringify({ routes: R.length, who: who.length, calls: n, problems, five }, null, 1),
);
if (problems.length || five.length) Deno.exit(1);
