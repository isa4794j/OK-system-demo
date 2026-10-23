/**
 * 요청 컨텍스트 — "지금 이 요청은 누가 보냈나" 를 요청 하나에 매어 둔다
 *
 * [왜 필요한가]
 * 감사 로그의 actor 를 채우려면 db/audit.ts 의 recordAudit() 이 지금 사용자를 알아야 한다.
 * 그 함수는 삭제·수정 함수 깊은 곳에서 불린다 — 사용자를 인자로 실어 나르려면
 * 39개 API 핸들러와 그 아래 /db 함수 대부분의 시그니처를 고쳐야 한다.
 *
 * [왜 전역 변수가 아닌가]
 * db/audit.ts 주석이 이미 못 박아 두었다: "전역 변수가 아니라 요청 컨텍스트로 넘겨야 한다 —
 * 두 요청이 섞이지 않게". 서버는 요청을 동시에 처리한다. 전역 변수에 담으면
 * A 가 지운 것이 B 의 이름으로 남는다. 조용히 틀리는 종류라 제일 나쁘다.
 *
 * AsyncLocalStorage 는 await 를 건너도 값이 그 흐름을 따라간다.
 * 요청마다 run() 으로 감싸면 각 요청이 제 값만 본다.
 *
 * [검증하고 쓴다]
 * 이게 정말 안 섞이는지 먼저 확인하고 감사 로그를 붙였다.
 * lib/request_context.test.ts 가 그 확인이고, 지금도 매번 지킨다.
 * 그 테스트가 깨지면 이 방식을 버리고 사용자를 인자로 실어 나르는 쪽으로 돌아서야 한다.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** 요청 하나에 매어 두는 것. 지금은 "누구인가" 뿐이다. */
export type RequestUser = {
  id: string;
  /** 화면에 나오는 이름 */
  name: string;
  /**
   * 감사 로그에 적는 이름. 화면 이름(name)이 아니라 로그인 이름이다.
   * 동명이인이 있으면 "김지현" 만으로는 누구인지 알 수 없다.
   */
  login_name: string;
  level: string;
  access_kind: string;
  /** 역할 목록(겸직이면 둘 이상) */
  roles: string[];
  /**
   * 지금 활동 중인 역할. 역할이 하나면 그 역할, 겸직이면 이 세션에 고른 역할(안 골랐으면 null).
   * 새로 만드는 일정·일지·문의에 as_role 로 박힌다.
   */
  active_role: string | null;
  /** 이 요청의 세션. 역할 전환이 이 세션만 바꾼다 */
  session_id: string | null;
};

/** 로그인하지 않은 요청. 잠그기 전 과도기에만 나온다(4단계까지). */
export const ANON_ACTOR = "(미로그인)";

const storage = new AsyncLocalStorage<RequestUser | null>();

/**
 * 이 요청을 처리하는 동안 user 를 매어 둔다.
 * 로그인하지 않은 요청도 감싼다 — 그때는 null 이고, 그것도 사실이다.
 */
export function runWithUser<T>(user: RequestUser | null, work: () => T): T {
  return storage.run(user, work);
}

/** 지금 요청을 보낸 사람. 로그인 전이거나 컨텍스트 밖이면 null. */
export function currentUser(): RequestUser | null {
  return storage.getStore() ?? null;
}

/**
 * 감사 로그에 적을 이름.
 *
 * 세 가지가 다르다. 셋을 한 값으로 뭉개면 나중에 로그를 못 읽는다.
 *   "박서연"     로그인한 사람이 한 일
 *   "(미로그인)"  요청은 왔는데 로그인이 없다 — 잠그기 전 과도기에만 나온다
 *   null         요청 자체가 아니다(스크립트·마이그레이션). 그때는 빈 채로 둔다
 *
 * 기계가 한 일은 이 값을 쓰지 않고 AI_ACTOR 를 따로 넘긴다.
 */
export function currentActor(): string | null {
  const store = storage.getStore();
  if (store === undefined) return null; // 요청 밖
  return store?.login_name ?? ANON_ACTOR;
}
