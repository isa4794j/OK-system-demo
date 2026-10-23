import { assertEquals } from "@std/assert";
import { clearCookie, isHttps, sessionCookie } from "./cookie.ts";

const at = new Date("2026-10-17T00:00:00Z");

Deno.test("쿠키 Secure — https 주소, 또는 앞단이 알려 준 https(X-Forwarded-Proto)", () => {
  assertEquals(isHttps(new Request("https://a.example/")), true);
  assertEquals(isHttps(new Request("http://localhost:8000/")), false);
  const behindProxy = new Request("http://app:8000/", {
    headers: { "x-forwarded-proto": "https" },
  });
  assertEquals(isHttps(behindProxy), true);
  assertEquals(
    isHttps(new Request("http://app/", { headers: { "x-forwarded-proto": "HTTPS, http" } })),
    true,
  );
  assertEquals(
    isHttps(new Request("http://app/", { headers: { "x-forwarded-proto": "http" } })),
    false,
  );
  assertEquals(sessionCookie(behindProxy, "t", at).endsWith("; Secure"), true);
  assertEquals(clearCookie(behindProxy).endsWith("; Secure"), true);
  assertEquals(sessionCookie(new Request("http://localhost/"), "t", at).includes("Secure"), false);
});
