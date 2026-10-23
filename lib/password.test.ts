/**
 * 비밀번호·초대코드·토큰 테스트
 *
 *   deno task test
 *
 * DB 도 서버도 부르지 않는다. 값을 넣고 값을 보는 것만 한다.
 * 여기가 틀리면 계정이 열리거나 아무도 못 들어온다. 다른 어떤 테스트보다 앞선다.
 *
 * PBKDF2 60만 회는 한 번에 0.2초쯤 걸린다. 그래서 해싱하는 테스트는 꼭 필요한 것만 둔다.
 */
import { assert, assertEquals, assertMatch, assertNotEquals } from "@std/assert";
import {
  checkPassword,
  hashSecret,
  hashToken,
  INVITE_CODE_LENGTH,
  isInviteCodeShape,
  makeInviteCode,
  makeSessionToken,
  needsRehash,
  verifySecret,
} from "./password.ts";

Deno.test("해시는 알고리즘·횟수·소금·해시 네 토막이다", async () => {
  const stored = await hashSecret("비밀번호12");
  assertMatch(stored, /^pbkdf2\$600000\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
});

Deno.test("같은 값을 두 번 해싱하면 다른 값이 나오고, 둘 다 맞는다", async () => {
  const a = await hashSecret("같은비밀번호");
  const b = await hashSecret("같은비밀번호");
  assertNotEquals(a, b, "소금이 다르면 결과도 달라야 한다");
  assertEquals(await verifySecret("같은비밀번호", a), true);
  assertEquals(await verifySecret("같은비밀번호", b), true);
});

Deno.test("틀린 값은 안 맞는다", async () => {
  const stored = await hashSecret("비밀번호12");
  assertEquals(await verifySecret("비밀번호13", stored), false);
  assertEquals(await verifySecret("", stored), false);
  assertEquals(await verifySecret("비밀번호12 ", stored), false);
});

Deno.test("저장된 값이 없거나 깨졌으면 던지지 않고 false", async () => {
  assertEquals(await verifySecret("아무거나", null), false);
  assertEquals(await verifySecret("아무거나", ""), false);
  assertEquals(await verifySecret("아무거나", "그냥글자"), false);
  assertEquals(await verifySecret("아무거나", "pbkdf2$600000$소금"), false);
  assertEquals(await verifySecret("아무거나", "bcrypt$10$a$b"), false);
  assertEquals(await verifySecret("아무거나", "pbkdf2$10$AAAA$BBBB"), false);
});

Deno.test("옛 규칙으로 만든 해시는 다시 해싱할 대상으로 표시된다", () => {
  assertEquals(needsRehash("pbkdf2$600000$a$b"), false);
  assertEquals(needsRehash("pbkdf2$100000$a$b"), true);
  assertEquals(needsRehash("bcrypt$10$a$b"), true);
  assertEquals(needsRehash(null), false);
});

Deno.test("초대코드는 여섯 자리 숫자이고 매번 다르다", () => {
  const codes = new Set<string>();
  for (let i = 0; i < 300; i++) {
    const code = makeInviteCode();
    assertEquals(code.length, INVITE_CODE_LENGTH);
    assertMatch(code, /^\d{6}$/);
    codes.add(code);
  }
  // 300번 뽑아 거의 다 달라야 한다. 같은 값이 자주 나오면 난수가 아니다.
  assert(codes.size > 280, `너무 자주 겹친다: ${codes.size}/300`);
});

Deno.test("숫자 열 개가 고르게 나온다 — 앞자리가 더 자주 나오면 안 된다", () => {
  const counts = new Array(10).fill(0);
  for (let i = 0; i < 2000; i++) {
    for (const ch of makeInviteCode()) counts[Number(ch)]++;
  }
  // 12000자리를 열 갈래로 나누면 갈래마다 1200개다. 넉넉히 잡아도 이 범위는 넘지 않는다.
  for (let digit = 0; digit < 10; digit++) {
    assert(
      counts[digit] > 1000 && counts[digit] < 1400,
      `${digit} 이 ${counts[digit]}번 — 치우쳤다`,
    );
  }
});

Deno.test("초대코드 모양 검사", () => {
  assertEquals(isInviteCodeShape("012345"), true);
  assertEquals(isInviteCodeShape("12345"), false);
  assertEquals(isInviteCodeShape("1234567"), false);
  assertEquals(isInviteCodeShape("12345a"), false);
  assertEquals(isInviteCodeShape(""), false);
});

Deno.test("세션 토큰은 URL 에 넣어도 안전한 글자만 쓰고 매번 다르다", () => {
  const tokens = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const token = makeSessionToken();
    assertMatch(token, /^[A-Za-z0-9_-]{43}$/);
    tokens.add(token);
  }
  assertEquals(tokens.size, 200);
});

Deno.test("토큰 해시는 같은 값에 같은 결과, 다른 값에 다른 결과", async () => {
  const token = makeSessionToken();
  const once = await hashToken(token);
  assertEquals(await hashToken(token), once);
  assertMatch(once, /^[0-9a-f]{64}$/);
  assertNotEquals(await hashToken(makeSessionToken()), once);
});

Deno.test("비밀번호 규칙 — 여덟 자, 그 밖에는 강제하지 않는다", () => {
  assertEquals(checkPassword("비밀번호12345"), null);
  assertEquals(checkPassword("aaaabbbb"), null, "기호를 강제하지 않는다");
  assert(checkPassword("일곱글자야") !== null, "여덟 자 미만은 막는다");
  assert(checkPassword("12345678") !== null, "너무 흔한 것은 막는다");
  assert(checkPassword("PASSWORD") !== null, "대소문자를 가리지 않고 막는다");
  assert(checkPassword("가".repeat(201)) !== null, "너무 길면 막는다");
  // 이름 규칙만 걸리게 여덟 자 넘는 이름으로 본다 — 짧으면 길이 규칙에 먼저 걸려
  // 무엇 때문에 막혔는지 알 수 없다.
  assert(checkPassword("김지현생활복지사", "김지현생활복지사") !== null, "이름과 같으면 막는다");
  assert(checkPassword("김지현생활복지사", " 김지현생활복지사 ") !== null, "앞뒤 공백은 무시한다");
  assertEquals(checkPassword("김지현생활복지사", "박서연"), null, "다른 이름이면 통과");
});
