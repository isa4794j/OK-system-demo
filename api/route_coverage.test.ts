import { assertEquals } from "@std/assert";
import { checkCoverage, findGhostRules, readRouterSource, samplePaths } from "./route_coverage.ts";

Deno.test("정규식 경로를 보낼 수 있는 주소로 펼친다 — 대안(a|b)은 하나씩", () => {
  const source = [
    'const A = new RegExp(`^/api/journals/(${UUID})/(extract|resources)$`, "i");',
    'if (pathname === "/api/books/search") {',
    // mod.ts 에 실제로 적힌 모양 그대로 — 슬래시 앞에 역슬래시가 있다
    String.raw`const S = /^\/api\/settings\/([a-z0-9_]{1,60})$/i;`,
  ].join("\n");
  assertEquals(samplePaths(source), [
    "/api/books/search",
    "/api/journals/00000000-0000-4000-8000-000000000000/extract",
    "/api/journals/00000000-0000-4000-8000-000000000000/resources",
    "/api/settings/sample_key",
  ]);
});

Deno.test("라우팅의 핸들러 호출은 전부 메서드 검사 뒤에 있다 — 점검이 핸들러를 실행하지 않는 근거", async () => {
  const source = await readRouterSource();
  const body = source.slice(source.indexOf("export function routeApi"));
  const lines = body.split("\n");
  const unguarded = lines.filter((line, i) =>
    /return handle/.test(line) && !/req\.method/.test(line) &&
    !/req\.method/.test(lines[i - 1] ?? "")
  );
  assertEquals(unguarded, []);
});

Deno.test("유령 줄 — 경로가 없거나, 경로는 있어도 그 메서드가 없는 줄을 잡는다", () => {
  const UUID = "00000000-0000-4000-8000-000000000000";
  const routes = [
    { path: `/api/accounts/${UUID}`, method: "PATCH" },
    { path: "/api/staff", method: "GET" },
  ];
  const ghosts = findGhostRules([
    // 실제로 있던 사고: 깃발 변경은 PATCH /api/accounts/:id 의 필드였다
    { path: /^\/api\/accounts\/([0-9a-f-]{36})\/admin$/i },
    { path: /^\/api\/accounts\/([0-9a-f-]{36})(\/code)?$/i },
    { path: "/api/staff", methods: ["POST"] },
    { path: /^\/api\/staff(\/|$)/ },
  ], routes);
  assertEquals(ghosts, [
    String.raw`전체 메서드 /^\/api\/accounts\/([0-9a-f-]{36})\/admin$/i`,
    "POST /api/staff",
  ]);
});

Deno.test("지금 정책표와 라우팅은 양쪽으로 짝이 맞다 — 기본값으로 떨어지는 경로도, 유령 줄도 없다", async () => {
  const { scanned, fallbacks, ghosts } = await checkCoverage(await readRouterSource());
  // 경로를 하나도 못 찾았다면 스캐너가 망가진 것이다
  assertEquals(scanned > 50, true);
  // 새 경로가 기본값으로 떨어지면: 의도한 것이면 이 기대를 고치고, 누락이면 정책표를 고친다.
  assertEquals(fallbacks, []);
  // 표에 줄을 적었는데 실제 경로가 없으면: 오타이거나, 막는다고 믿는 곳이 실제로는 안 막히고 있다.
  assertEquals(ghosts, []);
});
