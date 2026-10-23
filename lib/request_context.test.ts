/**
 * 요청 컨텍스트가 요청 사이에 새지 않는지
 *
 *   deno task test
 *
 * 이 테스트가 이 방식을 쓸지 말지를 정한다.
 * 여기서 한 줄이라도 실패하면 AsyncLocalStorage 를 버리고,
 * 사용자를 인자로 명시적으로 실어 나르는 방식으로 돌아선다.
 *
 * 감사 로그의 "누가" 가 남의 이름으로 남는 것은 조용히 틀리는 종류다.
 * 화면은 멀쩡해 보이고, 나중에 그 기록을 믿고 판단하게 된다. 그래서 먼저 확인한다.
 */
import { assertEquals } from "@std/assert";
import {
  ANON_ACTOR,
  currentActor,
  currentUser,
  type RequestUser,
  runWithUser,
} from "./request_context.ts";

function person(name: string): RequestUser {
  return {
    id: `id-${name}`,
    name,
    login_name: name,
    level: "종사자",
    access_kind: "PC",
    roles: ["생활복지사"],
    active_role: "생활복지사",
    session_id: null,
  };
}

/** 요청 하나가 하는 일. 중간에 여러 번 쉬면서 자기 사용자를 계속 확인한다. */
async function pretendRequest(_name: string, waits: number[]): Promise<string[]> {
  const seen: string[] = [];
  for (const ms of waits) {
    await new Promise((done) => setTimeout(done, ms));
    seen.push(currentActor() ?? "(없음)");
  }
  return seen;
}

Deno.test("컨텍스트 밖에서는 아무도 없다 — 요청이 아니므로 빈 채로 둔다", () => {
  assertEquals(currentUser(), null);
  assertEquals(currentActor(), null);
});

Deno.test("로그인 없이 온 요청은 (미로그인) — 요청 밖과 다르다", async () => {
  await runWithUser(null, () => {
    assertEquals(currentUser(), null);
    assertEquals(currentActor(), ANON_ACTOR);
    return Promise.resolve();
  });
  // 요청이 끝나면 다시 "요청 밖" 이다
  assertEquals(currentActor(), null);
});

Deno.test("await 를 여러 번 건너도 제 사용자를 본다", async () => {
  const seen = await runWithUser(person("박서연"), () => pretendRequest("박서연", [1, 5, 1, 10]));
  assertEquals(seen, ["박서연", "박서연", "박서연", "박서연"]);
});

Deno.test("동시에 도는 요청 둘이 서로의 사용자를 보지 않는다", async () => {
  // 서로 다른 시간에 깨어나게 해서 실행이 실제로 엇갈리게 만든다.
  // 같은 간격으로 두면 우연히 안 섞인 것인지 알 수 없다.
  const [a, b] = await Promise.all([
    runWithUser(person("박서연"), () => pretendRequest("박서연", [1, 12, 3, 8])),
    runWithUser(person("유복지"), () => pretendRequest("유복지", [7, 2, 11, 1])),
  ]);

  assertEquals(a, ["박서연", "박서연", "박서연", "박서연"]);
  assertEquals(b, ["유복지", "유복지", "유복지", "유복지"]);
});

Deno.test("요청 열 건을 한꺼번에 돌려도 섞이지 않는다", async () => {
  const names = [
    "박서연",
    "유복지",
    "이복지",
    "최민호",
    "장센터",
    "정하늘",
    "오수빈",
    "김멘토",
    "한지우",
    "류다은",
  ];

  const results = await Promise.all(
    names.map((name, i) =>
      // 대기 시간을 제각각으로 흩뿌려 실행 순서를 뒤섞는다
      runWithUser(person(name), () => pretendRequest(name, [(i * 3) % 7 + 1, (i * 5) % 11 + 1, 2]))
    ),
  );

  for (let i = 0; i < names.length; i++) {
    assertEquals(results[i], [names[i], names[i], names[i]], `${names[i]} 의 컨텍스트가 섞였다`);
  }
});

Deno.test("로그인하지 않은 요청은 null 이고, 그 옆의 요청을 물들이지 않는다", async () => {
  const [anon, known] = await Promise.all([
    runWithUser(null, () => pretendRequest(ANON_ACTOR, [3, 6])),
    runWithUser(person("박서연"), () => pretendRequest("박서연", [5, 1])),
  ]);

  assertEquals(anon, [ANON_ACTOR, ANON_ACTOR]);
  assertEquals(known, ["박서연", "박서연"]);
});

Deno.test("요청이 끝나면 값이 남지 않는다", async () => {
  await runWithUser(person("박서연"), () => pretendRequest("박서연", [1]));
  assertEquals(currentActor(), null);
});

Deno.test("컨텍스트 안에서 또 감싸면 안쪽이 이긴다 — 끝나면 바깥으로 돌아온다", async () => {
  await runWithUser(person("박서연"), async () => {
    assertEquals(currentActor(), "박서연");
    await runWithUser(person("유복지"), async () => {
      await new Promise((done) => setTimeout(done, 3));
      assertEquals(currentActor(), "유복지");
    });
    await new Promise((done) => setTimeout(done, 3));
    assertEquals(currentActor(), "박서연");
  });
});
