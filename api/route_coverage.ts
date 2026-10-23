/**
 * 정책표 커버리지 — 라우팅과 정책표가 서로 짝이 맞는가
 *
 * 두 방향을 본다.
 *   정방향  등록된 API 경로 중 정책표에 없어 기본값(관리자만)으로 떨어지는 것
 *   역방향  정책표에는 있는데 실제로는 없는 경로를 가리키는 줄("유령 줄")
 *
 * [유령 줄이 왜 위험한가]
 * 표를 읽는 사람은 "여기서 막고 있다" 고 믿는다. 실제로는 아무 요청도 그 줄에 안 걸리고,
 * 진짜 경로는 다른 (더 넓은) 줄에 걸려 있다. /api/accounts/:id/admin 이 그랬다 —
 * 관리자 깃발은 PATCH /api/accounts/:id 의 필드였고, 그 경로는 센터장에게 열려 있었다.
 *
 * [어떻게 경로를 모으나]
 * 라우팅(api/mod.ts)은 표가 아니라 if 문이라 목록이 따로 없다. 따로 목록을 만들면
 * 라우팅과 어긋나는 날이 온다. 그래서 실제 라우터에게 물어본다.
 *
 *   1. mod.ts 에 적힌 경로 글자와 정규식에서 "보낼 만한 주소" 를 만든다
 *   2. 그 주소로 가짜 메서드(PROBE) 요청을 라우터에 넣는다
 *   3. 라우터는 핸들러를 부르기 전에 메서드를 보고 405 + allow 헤더로 답한다
 *      → 그 경로가 받는 메서드를 핸들러를 한 번도 실행하지 않고 알 수 있다
 *   4. 정방향: 메서드마다 정책표(requiredFor)에 묻고, 기본값으로 떨어지는 것만 모은다
 *      역방향: 표의 줄마다 그 줄의 경로·메서드에 맞는 실제 (주소, 메서드)가 하나라도 있는지 본다
 *
 * [핸들러는 실행되지 않는다]
 * mod.ts 의 핸들러 호출은 전부 `req.method === ...` 검사 뒤에 있다(이 파일의 테스트가 지킨다).
 * PROBE 는 어떤 검사에도 걸리지 않으므로 DB 도 AI 도 건드리지 않는다 — 점검은 읽기만 한다.
 *
 * [기본값이 늘 누락은 아니다]
 * "표에 없으면 관리자만" 은 일부러 그렇게 둔 자리도 있다. 그래서 목록만 보여 주고,
 * 의도된 것인지 빠뜨린 것인지는 사람이 본다.
 */
import { routeApi } from "./mod.ts";
import { policyRules, requiredFor } from "./policy.ts";

const SAMPLE_UUID = "00000000-0000-4000-8000-000000000000";
const PROBE = "PROBE";

export type Route = { path: string; method: string };
export type FallbackRoute = Route;
type RuleShape = { path: string | RegExp; methods?: readonly string[] };

/** mod.ts 의 경로 표기에서 실제로 보낼 수 있는 주소들을 만든다. */
export function samplePaths(source: string): string[] {
  const out = new Set<string>();

  // "/api/..." 글자 그대로 쓴 경로
  for (const m of source.matchAll(/"(\/(?:api\/[a-z0-9\-/]+|health))"/g)) out.add(m[1]);

  // new RegExp(`^/api/...$`) 모양
  for (const m of source.matchAll(/`\^(\/api\/[^`]+?)\$`/g)) {
    for (const path of expand(m[1])) out.add(path);
  }
  // /^\/api\/...$/ 모양
  for (const m of source.matchAll(/\/\^(\\\/api\\\/[^\s]+?)\$\/i?/g)) {
    for (const path of expand(m[1].replaceAll("\\/", "/"))) out.add(path);
  }
  return [...out].sort();
}

/** 정규식 조각을 보낼 수 있는 주소로. 대안(a|b)은 하나씩 펼친다. */
function expand(pattern: string): string[] {
  const text = pattern
    .replaceAll("(${UUID})", SAMPLE_UUID)
    .replace(/\(\[a-z0-9_\]\{[^}]+\}\)/g, "sample_key");

  const alt = text.match(/\(([a-z0-9\-|]+)\)/);
  if (!alt) return [text];
  const [whole, body] = alt;
  return body.split("|").flatMap((one) => expand(text.replace(whole, one)));
}

/** 그 주소가 받는 메서드. 라우팅에 없으면 빈 목록. */
async function methodsOf(path: string): Promise<string[]> {
  const req = new Request(`http://probe.local${path}`, { method: PROBE });
  const pending = routeApi(req, path);
  if (!pending) return [];
  const response = await pending;
  if (response.status !== 405) return [];
  return (response.headers.get("allow") ?? "")
    .split(",")
    .map((one) => one.trim())
    .filter(Boolean);
}

/**
 * 경로와 메서드를 한 줄에 같이 검사하는 자리 — `pathname === "/health" && req.method === "GET"`.
 * 이런 자리는 405 갈래가 없어 PROBE 로는 안 보인다. 글자에서 바로 읽는다.
 */
function inlineRoutes(source: string): Route[] {
  return [...source.matchAll(/pathname === "([^"]+)" && req\.method === "([A-Z]+)"/g)]
    .map((m) => ({ path: m[1], method: m[2] }));
}

/**
 * 라우팅에 실제로 있는 (주소, 메서드) 전부.
 *
 * extraPaths: 정책표가 글자로 적은 경로. /api/settings/half_observation_items 처럼
 * 라우팅에는 정규식(/api/settings/:열쇠)으로만 있는 구체 주소라 소스에서는 안 나온다.
 * 라우터에 직접 물어보면(PROBE) 받는 주소인지 알 수 있다.
 */
export async function listRoutes(source: string, extraPaths: string[] = []): Promise<Route[]> {
  const routes: Route[] = inlineRoutes(source);
  const seen = new Set(routes.map(({ path, method }) => `${method} ${path}`));
  const paths = new Set([...samplePaths(source), ...extraPaths]);

  for (const path of [...paths].sort()) {
    for (const method of await methodsOf(path)) {
      const key = `${method} ${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      routes.push({ path, method });
    }
  }
  return routes;
}

/** 표의 줄을 사람이 읽을 수 있게 */
export function ruleLabel(rule: RuleShape): string {
  const path = typeof rule.path === "string" ? rule.path : String(rule.path);
  return `${rule.methods?.join(",") ?? "전체 메서드"} ${path}`;
}

/**
 * 역방향 — 어떤 실제 경로·메서드에도 안 맞는 표의 줄.
 * first-match 로 이기는지는 보지 않는다. "이 줄이 가리키는 경로가 세상에 있는가" 만 본다.
 */
export function findGhostRules(rules: readonly RuleShape[], routes: readonly Route[]): string[] {
  return rules
    .filter((rule) =>
      !routes.some(({ path, method }) => {
        const pathHit = typeof rule.path === "string"
          ? rule.path === path
          : new RegExp(rule.path.source, rule.path.flags.replace("g", "")).test(path);
        return pathHit && (!rule.methods || rule.methods.includes(method));
      })
    )
    .map(ruleLabel);
}

/** 정방향·역방향을 한 번에. 라우터 탐색은 한 번만 한다. */
export async function checkCoverage(source: string): Promise<{
  scanned: number;
  fallbacks: FallbackRoute[];
  ghosts: string[];
}> {
  const rules = policyRules();
  const literal = rules.flatMap((rule) => typeof rule.path === "string" ? [rule.path] : []);
  const routes = await listRoutes(source, literal);
  const fallbacks = routes.filter(({ path, method }) => requiredFor(path, method).fallback);
  return { scanned: routes.length, fallbacks, ghosts: findGhostRules(rules, routes) };
}

/** mod.ts 원문. 배포 환경에서도 소스가 함께 올라가므로 읽을 수 있다. */
export async function readRouterSource(): Promise<string> {
  return await Deno.readTextFile(new URL("./mod.ts", import.meta.url));
}
