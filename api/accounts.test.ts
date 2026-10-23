import { assertEquals } from "@std/assert";
import { handleAccountUpdate, handleIssueCode, handleRevokeCode } from "./accounts.ts";
import { handleStaffDelete, handleStaffUpdate } from "./staff.ts";
import { ADMIN_TARGET_MESSAGE, refuseAdminTarget, targetLookup } from "./admin_target.ts";
import { type RequestUser, runWithUser } from "../lib/request_context.ts";

/*
 * 관리자 계정 보호 — "관리자 계정에 대한 모든 변경은 관리자만"
 *
 * 대상이 관리자인지는 DB 를 봐야 안다. 여기서는 그 조회(targetLookup)를 바꿔 끼워
 * DB 없이 권한 갈래만 확인한다. 검사가 통과한 뒤의 실제 변경·마지막 관리자 보호는
 * DB 가 필요해 실제 서버로 확인했다.
 */

const ADMIN_ID = "00000000-0000-4000-8000-00000000000a";
const STAFF_ID = "00000000-0000-4000-8000-00000000000b";

function user(level: string): RequestUser {
  return {
    id: "u",
    name: "시험",
    login_name: "시험",
    level,
    access_kind: "PC",
    roles: [],
    active_role: null,
    session_id: null,
  };
}

function json(method: string, path: string, body: unknown): Request {
  return new Request(`http://local${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** 대상 조회를 가짜로. 몇 번 불렸는지도 센다. */
function withLookup<T>(work: (calls: { n: number }) => Promise<T>): Promise<T> {
  const real = targetLookup.isAdmin;
  const calls = { n: 0 };
  targetLookup.isAdmin = (id: string) => {
    calls.n += 1;
    return Promise.resolve(id === ADMIN_ID);
  };
  return work(calls).finally(() => {
    targetLookup.isAdmin = real;
  });
}

async function run(who: RequestUser | null, call: () => Promise<Response>) {
  const response = await runWithUser(who, call);
  const body = await response.json().catch(() => ({}));
  return { status: response.status, error: body.error as string | undefined };
}

/* ---------- 깃발 필드 ---------- */

Deno.test("센터장은 관리자 깃발을 붙이지도 떼지도 못한다 — 403", async () => {
  await withLookup(async () => {
    const as = (body: unknown) =>
      run(user("센터장"), () => handleAccountUpdate(json("PATCH", "/", body), STAFF_ID));
    assertEquals((await as({ is_admin: true })).status, 403);
    assertEquals((await as({ is_admin: false })).status, 403);
    // 다른 필드에 섞어 보내도 통째로 거부한다(일부만 반영하지 않는다)
    assertEquals((await as({ access_kind: "PC", is_admin: true })).status, 403);
    // 값 모양이 틀려도 권한이 먼저다
    assertEquals((await as({ is_admin: "yes" })).status, 403);
  });
});

Deno.test("종사자·봉사·미로그인도 깃발은 403 — 잠금 설정과 무관하다", async () => {
  await withLookup(async () => {
    for (const who of [user("종사자"), user("봉사"), null]) {
      const r = await run(
        who,
        () => handleAccountUpdate(json("PATCH", "/", { is_admin: true }), STAFF_ID),
      );
      assertEquals(r.status, 403);
    }
  });
});

/* ---------- 대상이 관리자 계정 ---------- */

/** 관리자 계정에 가하는 조작 전부. 경로 목록은 보고서와 같다. */
const OPERATIONS: Array<[string, (id: string) => Promise<Response>]> = [
  ["POST /api/accounts/:id/code", (id) => handleIssueCode(json("POST", "/", {}), id)],
  ["DELETE /api/accounts/:id/code", (id) => handleRevokeCode(id)],
  // 모양이 틀린 값을 보내 DB 전에 멈추게 한다 — 403 이 아니면 권한은 통과한 것이다
  [
    "PATCH /api/accounts/:id login_name",
    (id) => handleAccountUpdate(json("PATCH", "/", { login_name: "" }), id),
  ],
  [
    "PATCH /api/accounts/:id access_kind",
    (id) => handleAccountUpdate(json("PATCH", "/", { access_kind: "?" }), id),
  ],
  [
    "PATCH /api/accounts/:id account_status",
    (id) => handleAccountUpdate(json("PATCH", "/", { account_status: "?" }), id),
  ],
  ["PATCH /api/staff/:id", (id) => handleStaffUpdate(json("PATCH", "/", { status: "?" }), id)],
];

Deno.test("센터장이 관리자 계정에 가하는 조작은 전부 403", async () => {
  await withLookup(async () => {
    for (const [label, call] of OPERATIONS) {
      const r = await run(user("센터장"), () => call(ADMIN_ID));
      assertEquals([label, r.status, r.error], [label, 403, ADMIN_TARGET_MESSAGE]);
    }
    const del = await run(user("센터장"), () => handleStaffDelete(ADMIN_ID));
    assertEquals(del.status, 403);
  });
});

Deno.test("센터장이 일반 계정에 하는 조작은 권한 검사를 지나간다(기존대로)", async () => {
  await withLookup(async () => {
    // 코드 발급·회수·삭제는 DB 까지 가야 끝나므로 여기서는 값 검사로 멈추는 것만 본다
    for (const [label, call] of OPERATIONS.slice(2)) {
      const r = await run(user("센터장"), () => call(STAFF_ID));
      assertEquals([label, r.status], [label, 400]);
    }
  });
});

Deno.test("관리자는 관리자 계정도 다룬다 — 대상 조회조차 하지 않는다", async () => {
  await withLookup(async (calls) => {
    for (const [label, call] of OPERATIONS.slice(2)) {
      const r = await run(user("관리자"), () => call(ADMIN_ID));
      assertEquals([label, r.status], [label, 400]);
    }
    const flag = await run(
      user("관리자"),
      () => handleAccountUpdate(json("PATCH", "/", { is_admin: "yes" }), ADMIN_ID),
    );
    assertEquals(flag.status, 400);
    assertEquals(calls.n, 0);
  });
});

Deno.test("대상 조회가 실패하면 통과시키지 않는다 — 500", async () => {
  const real = targetLookup.isAdmin;
  targetLookup.isAdmin = () => Promise.reject(new Error("DB 없음"));
  const quiet = console.error;
  console.error = () => {};
  try {
    const r = await runWithUser(user("센터장"), () => refuseAdminTarget(ADMIN_ID));
    assertEquals(r?.status, 500);
  } finally {
    targetLookup.isAdmin = real;
    console.error = quiet;
  }
});

/* ---------- 빠뜨림 방지 ---------- */

Deno.test("계정·명단 파일에서 id 를 받는 쓰기 핸들러는 전부 관리자 계정 보호를 부른다", async () => {
  // 읽기만 하는 핸들러. 여기 없는 id 핸들러가 새로 생기면 이 테스트가 잡는다.
  const READ_ONLY = new Set(["handleStaffRecordsCount"]);
  const missing: string[] = [];
  const checked: string[] = [];
  for (const file of ["./accounts.ts", "./staff.ts"]) {
    const source = await Deno.readTextFile(new URL(file, import.meta.url));
    const parts = source.split(/(?=export async function )/);
    for (const part of parts) {
      const head = part.match(/^export async function (\w+)\(([^)]*)\)/);
      if (!head || !/\bid: string/.test(head[2]) || READ_ONLY.has(head[1])) continue;
      checked.push(head[1]);
      if (!part.includes("refuseAdminTarget(id)")) missing.push(head[1]);
    }
  }
  // 스캔이 비어 통과하는 것을 막는다
  assertEquals(checked.sort(), [
    "handleAccountUpdate",
    "handleIssueCode",
    "handleRevokeCode",
    "handleStaffDelete",
    "handleStaffUpdate",
  ]);
  assertEquals(missing, []);
});
