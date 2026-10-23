import { assertEquals, assertInstanceOf } from "@std/assert";
import Anthropic from "@anthropic-ai/sdk";
import { AIServiceError, describeAIError, MESSAGES } from "./ai.ts";

const apiError = (status: number, type: string, message = "raw") =>
  Anthropic.APIError.generate(
    status,
    { type: "error", error: { type, message } },
    message,
    new Headers(),
  );

Deno.test("AI 오류는 사람 말로 — 환경변수 이름·HTTP·JSON 이 화면 문장에 없다", () => {
  const cases: [unknown, string][] = [
    [apiError(401, "authentication_error"), MESSAGES.config],
    [apiError(403, "permission_error"), MESSAGES.config],
    [apiError(429, "rate_limit_error"), MESSAGES.busy],
    [apiError(529, "overloaded_error"), MESSAGES.busy],
    [apiError(503, "api_error"), MESSAGES.busy],
    [apiError(500, "api_error"), MESSAGES.server],
    [apiError(400, "invalid_request_error", "Your credit balance is too low"), MESSAGES.credit],
    [apiError(400, "invalid_request_error", "messages: bad"), MESSAGES.request],
    [new Anthropic.APIConnectionTimeoutError(), MESSAGES.timeout],
    [new Anthropic.APIConnectionError({ message: "fetch failed" }), MESSAGES.network],
    [new TypeError("boom"), MESSAGES.request],
  ];
  const original = console.error;
  const logged: string[] = [];
  console.error = (line: string) => logged.push(line);
  try {
    for (const [error, message] of cases) {
      const out = describeAIError(error);
      assertInstanceOf(out, AIServiceError);
      assertEquals(out.message, message);
      for (const bad of ["ANTHROPIC", "HTTP", "{", "error_type", "실패했습니다"]) {
        assertEquals(out.message.includes(bad), false, `${message} 에 ${bad}`);
      }
    }
  } finally {
    console.error = original;
  }
  // 고칠 때 필요한 원문은 서버 로그에
  assertEquals(logged.some((line) => line.includes("HTTP 529")), true);
});
