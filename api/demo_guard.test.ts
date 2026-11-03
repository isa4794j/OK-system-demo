import { assertEquals } from "@std/assert";
import { DEMO_ACCOUNTS, DEMO_BLOCK_MESSAGE, DEMO_BLOCKED, demoRefusal } from "./demo_guard.ts";

const ID = "00000000-0000-4000-8000-000000000000";

function ask(method: string, path: string, who: string | null) {
  return demoRefusal(new Request(`http://x${path}`, { method }), path, who);
}

const BLOCKED: [string, string][] = [
  ["PATCH", `/api/accounts/${ID}`], // 정지·해제·관리자 깃발·로그인 이름
  ["POST", `/api/accounts/${ID}/code`],
  ["DELETE", `/api/accounts/${ID}/code`],
  ["POST", "/api/staff"],
  ["PATCH", `/api/staff/${ID}`],
  ["DELETE", `/api/staff/${ID}`],
  ["PUT", "/api/settings/consent_form"],
  ["PUT", "/api/settings/privacy_policy"],
  ["PUT", "/api/settings/center_name"],
];

const ALLOWED: [string, string][] = [
  ["PUT", "/api/settings/child_delete_by_staff"],
  ["PUT", "/api/settings/volunteer_journal_scope"],
  ["GET", "/api/settings/privacy_policy"], // 읽기는 열려 있다
  ["GET", "/api/accounts"],
  ["GET", "/api/audit"],
  ["DELETE", `/api/children/${ID}`],
  ["POST", "/api/journals"],
  ["POST", "/api/my/journals"],
  ["PUT", `/api/children/${ID}/evaluation`],
  ["POST", "/api/books"],
  ["POST", "/api/auth/login"],
];

Deno.test("데모 안전장치 — 공개 계정 셋은 막힌 요청마다 403 + 안내 문구", async () => {
  for (const who of DEMO_ACCOUNTS) {
    for (const [method, path] of BLOCKED) {
      const response = ask(method, path, who);
      assertEquals(response?.status, 403, `${who} ${method} ${path}`);
      assertEquals((await response?.json()).error, DEMO_BLOCK_MESSAGE);
    }
  }
});

Deno.test("데모 안전장치 — 일반 업무·운영 설정·읽기는 그대로 통과", () => {
  for (const who of DEMO_ACCOUNTS) {
    for (const [method, path] of ALLOWED) {
      assertEquals(ask(method, path, who), null, `${who} ${method} ${path}`);
    }
  }
});

Deno.test("데모 안전장치 — 비밀번호 정하기·첫 관리자는 로그인 전에도 막는다", () => {
  assertEquals(ask("POST", "/api/auth/first-password", null)?.status, 403);
  assertEquals(ask("POST", "/api/auth/bootstrap", null)?.status, 403);
});

Deno.test("데모 안전장치 — 데모 계정이 아닌 사람(장센터)은 막지 않는다", () => {
  for (const [method, path] of BLOCKED) {
    assertEquals(ask(method, path, "장센터"), null, `${method} ${path}`);
  }
  assertEquals(ask("PUT", "/api/settings/consent_form", null), null);
});

Deno.test("데모 안전장치 — 막는 목록에는 이름이 있다", () => {
  for (const one of DEMO_BLOCKED) assertEquals(one.what.length > 0, true);
});
