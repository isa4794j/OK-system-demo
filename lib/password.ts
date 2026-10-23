/**
 * 비밀번호·초대코드·세션 토큰 — 되돌릴 수 없게 만들고, 맞는지만 확인한다
 *
 * 이 파일은 아무것도 import 하지 않는다. Supabase 도 AI 도 부르지 않는다.
 * 값을 받아 값을 돌려주는 순수 함수만 둔다 — 그래야 테스트로 확인할 수 있다.
 *
 * [왜 PBKDF2 인가]
 * Argon2id 가 더 좋지만 WASM 의존이 하나 늘어난다. PBKDF2 는 Deno 표준
 * crypto.subtle 에 들어 있어 받아 올 것이 없고 Deno Deploy 에서 그대로 돈다.
 * OWASP 는 PBKDF2-HMAC-SHA256 을 60만 회 이상 돌리면 쓸 만하다고 본다.
 * 로그인할 때만 도는 계산이라 0.2~0.4초는 사람이 못 느낀다.
 *
 * [저장 모양에 알고리즘과 횟수를 같이 넣는다]
 *   pbkdf2$600000$<소금 b64>$<해시 b64>
 * 나중에 횟수를 올리거나 Argon2id 로 갈아탈 때, 옛 값은 옛 규칙으로 확인하고
 * 로그인에 성공한 순간 새 규칙으로 조용히 다시 해싱하면 된다.
 * 이 값이 없으면 전원 비번 재설정 말고는 길이 없다.
 *
 * [세션 토큰은 왜 PBKDF2 가 아닌가]
 * 사람이 고른 값이 아니라 32바이트 난수다. 추측할 여지가 없어 느리게 만들 이유도 없다.
 * SHA-256 한 번이면 충분하고, 요청마다 도는 계산이라 빨라야 한다.
 */

/** 지금 쓰는 반복 횟수. 옛 해시는 값 안에 적힌 제 횟수로 확인한다. */
const ITERATIONS = 600_000;

/** 소금 길이(바이트). 16이면 같은 소금이 두 번 나올 걱정은 없다. */
const SALT_BYTES = 16;

/** 해시 길이(비트). SHA-256 과 맞춘다. */
const HASH_BITS = 256;

/** 비밀번호 최소 길이. 기호·대문자는 강제하지 않는다 — 강제하면 포스트잇에 적힌다. */
export const PASSWORD_MIN = 8;

/**
 * 너무 흔해서 막는 비밀번호.
 *
 * 목록을 길게 두지 않는다. 규칙을 빡빡하게 하는 것보다 낫지만,
 * 이것도 결국 사람을 성가시게 하는 일이다. 정말 흔한 것만 막는다.
 */
const TOO_COMMON = [
  "12345678",
  "123456789",
  "1234567890",
  "password",
  "qwertyui",
  "11111111",
  "00000000",
  "okok1234",
  "abcd1234",
];

/** 초대코드 길이. 구두로 전하는 값이라 여섯 자리를 넘기지 않는다. */
export const INVITE_CODE_LENGTH = 6;

/* ---------- 바이트 ↔ 글자 ---------- */

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** crypto.subtle 에 넘길 수 있는 바이트 묶음을 만든다(공유 메모리가 아님을 타입으로 못 박는다) */
function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(new ArrayBuffer(length)));
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 길이가 같은 두 바이트열을 시간이 일정하게 비교한다.
 *
 * === 로 비교하면 앞에서 몇 글자가 맞았는지가 걸린 시간으로 새어 나간다.
 * 실제로 그걸로 뚫기는 어렵지만, 맞게 쓰는 비용이 세 줄이라 맞게 쓴다.
 */
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/* ---------- 해시 ---------- */

async function pbkdf2(
  secret: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    HASH_BITS,
  );
  return new Uint8Array(bits);
}

/**
 * 비밀번호나 초대코드를 저장할 모양으로 만든다.
 * 같은 값을 두 번 해싱해도 소금이 달라 결과가 다르다 — 그게 정상이다.
 */
export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await pbkdf2(secret, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

/**
 * 저장된 값과 맞는지 본다. 모양이 이상하면 false — 던지지 않는다.
 *
 * 던지면 부르는 쪽이 "틀린 비번" 과 "깨진 데이터" 를 갈라 다뤄야 하는데,
 * 로그인 화면에서 그 둘은 결국 같은 말("맞지 않습니다")이다.
 * 깨진 값은 서버 로그로 알린다.
 */
export async function verifySecret(secret: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;

  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") {
    console.error("[verifySecret] 저장된 해시의 모양이 낯설다");
    return false;
  }

  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1000) {
    console.error("[verifySecret] 반복 횟수가 이상하다");
    return false;
  }

  let salt: Uint8Array<ArrayBuffer>;
  let expected: Uint8Array;
  try {
    salt = fromBase64(parts[2]);
    expected = fromBase64(parts[3]);
  } catch {
    console.error("[verifySecret] 소금이나 해시를 읽지 못했다");
    return false;
  }

  return equalBytes(await pbkdf2(secret, salt, iterations), expected);
}

/**
 * 이 해시가 지금 규칙으로 만들어졌는가.
 * false 면 로그인에 성공한 순간 새로 해싱해 두면 된다(사람은 아무것도 안 한다).
 */
export function needsRehash(stored: string | null): boolean {
  if (!stored) return false;
  const parts = stored.split("$");
  return parts[0] !== "pbkdf2" || Number(parts[1]) < ITERATIONS;
}

/* ---------- 만들기 ---------- */

/**
 * 초대코드 여섯 자리.
 *
 * Math.random 을 쓰지 않는다 — 예측 가능한 값으로 계정을 여는 열쇠를 만들면 안 된다.
 * 나머지 연산으로 자리를 맞추면 앞 숫자가 조금 더 자주 나오므로, 치우친 값은 버리고 다시 뽑는다.
 */
export function makeInviteCode(): string {
  const limit = 10;
  const cutoff = 256 - (256 % limit);
  let code = "";

  while (code.length < INVITE_CODE_LENGTH) {
    for (const byte of randomBytes(INVITE_CODE_LENGTH)) {
      if (byte >= cutoff) continue;
      code += String(byte % limit);
      if (code.length === INVITE_CODE_LENGTH) break;
    }
  }
  return code;
}

/** 세션 토큰. 32바이트 난수를 URL 에 넣어도 안전한 글자로. */
export function makeSessionToken(): string {
  const bytes = randomBytes(32);
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 세션 토큰을 DB 에 담을 모양으로. 되돌릴 수 없고 빠르다. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return toHex(new Uint8Array(digest));
}

/* ---------- 검사 ---------- */

/**
 * 비밀번호로 쓸 수 있는 값인가. 쓸 수 있으면 null, 아니면 이유.
 * 이유를 그대로 화면에 띄울 수 있게 사람 말로 적는다.
 */
export function checkPassword(password: string, name?: string | null): string | null {
  if (password.length < PASSWORD_MIN) {
    return `비밀번호는 ${PASSWORD_MIN}자 이상이어야 합니다.`;
  }
  if (password.length > 200) {
    return "비밀번호가 너무 깁니다.";
  }
  if (TOO_COMMON.includes(password.toLowerCase())) {
    return "너무 흔한 비밀번호입니다. 다른 것으로 정해 주세요.";
  }
  if (name && password.toLowerCase() === name.trim().toLowerCase()) {
    return "이름과 같은 비밀번호는 쓸 수 없습니다.";
  }
  return null;
}

/** 초대코드로 볼 수 있는 모양인가. 여섯 자리 숫자만. */
export function isInviteCodeShape(code: string): boolean {
  return new RegExp(`^\\d{${INVITE_CODE_LENGTH}}$`).test(code);
}
