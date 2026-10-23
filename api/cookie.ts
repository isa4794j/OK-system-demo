/**
 * 세션 쿠키 — 이름과 굽는 방법
 *
 * api/auth.ts(로그인·로그아웃)와 api/guard.ts(읽기)가 같이 쓴다.
 * 두 곳에 따로 적으면 한쪽만 고쳐 놓고 왜 안 되는지 찾게 된다.
 */

/** 화면 쪽 코드는 이 이름을 몰라도 된다 — HttpOnly 라 자바스크립트가 못 읽는다. */
export const SESSION_COOKIE = "ok_session";

/**
 * Secure 는 https 일 때만 붙인다.
 *
 * http://localhost 에 Secure 를 붙이면 브라우저가 쿠키를 아예 저장하지 않는다.
 * 로그인은 성공했는데 다음 요청에서 곧바로 튕기고, 원인이 눈에 안 보인다.
 * Deno Deploy 는 늘 https 라 배포에서는 항상 붙는다.
 *
 * 애저 Container Apps 는 수신부(Envoy)가 TLS 를 풀고 앱에는 http 로 넘긴다 — 원래 https 였다는 것은
 * X-Forwarded-Proto 로 알려 준다. 그것도 https 로 본다. (http 에서 이 헤더를 흉내 내면 브라우저가
 * 그 쿠키를 저장하지 않을 뿐이라, 스스로 로그인이 안 될 뿐 남에게 해가 없다)
 */
export function isHttps(req: Request): boolean {
  if (new URL(req.url).protocol === "https:") return true;
  const forwarded = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  return forwarded === "https";
}

function secureSuffix(req: Request): string[] {
  return isHttps(req) ? ["Secure"] : [];
}

/**
 * 세션 쿠키를 굽는다.
 *
 * SameSite=Lax 가 다른 사이트에서 오는 POST·PATCH·DELETE 를 막아 준다.
 * 그래서 CSRF 토큰을 따로 두지 않는다.
 */
export function sessionCookie(req: Request, token: string, expiresAt: Date): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Expires=${expiresAt.toUTCString()}`,
    ...secureSuffix(req),
  ].join("; ");
}

/** 쿠키를 지운다. 굽던 것과 같은 속성으로 지워야 브라우저가 알아듣는다. */
export function clearCookie(req: Request): string {
  return [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    ...secureSuffix(req),
  ].join("; ");
}
