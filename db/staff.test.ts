import { assertEquals } from "@std/assert";
import { withoutSecrets } from "./staff.ts";

Deno.test("직원 삭제 감사 기록에는 비밀번호·초대코드 해시를 싣지 않는다", () => {
  const row = {
    id: "s1",
    name: "시험",
    role: "봉사자",
    password_hash: "pbkdf2$...",
    invite_code_hash: "sha256$...",
    invite_code_expires_at: "2026-10-01T00:00:00Z",
    is_admin: false,
  };
  assertEquals(withoutSecrets(row), {
    id: "s1",
    name: "시험",
    role: "봉사자",
    invite_code_expires_at: "2026-10-01T00:00:00Z",
    is_admin: false,
  });
  assertEquals(withoutSecrets(null), null);
});
