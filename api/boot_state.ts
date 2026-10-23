/**
 * 최초 부팅이 끝났는가 — 부팅 화면(api/auth.ts)과 관문(api/guard.ts)이 같이 쓰는 한 가지 기준
 *
 * 둘 중 하나면 끝난 것이다 — 표시(bootstrap_done)가 있거나, 비밀번호를 정한 계정이 있거나.
 * 표시만 보면 SQL 로 계정을 먼저 만든 DB 에서 로그인 없이 누구든 관리자를 만들 수 있다.
 * 기준이 두 곳에 있으면 한쪽만 고쳐 틈이 생긴다 — 그래서 이 파일 하나다.
 *
 * [한 번 닫히면 다시 안 열린다]
 * 끝남은 되돌아가지 않는 사실이라 "끝났다" 만 기억해 둔다(요청마다 DB 를 두 번 읽지 않게).
 * "아직" 은 기억하지 않는다 — 다른 인스턴스·다른 요청이 방금 끝냈을 수 있다.
 * 기억은 닫힌 쪽으로만 틀린다. SQL 로 계정·표시를 지워 부팅을 일부러 다시 열려면 서버를 다시 띄운다.
 */
import { hasPasswordAccount } from "../db/accounts.ts";
import { getSetting } from "../db/settings.ts";

/** 최초 부팅을 한 번만 열기 위한 자리. settings 의 key 가 기본키라 두 번 못 넣는다. */
export const BOOTSTRAP_KEY = "bootstrap_done";

let closedSeen = false;

export async function bootstrapClosed(): Promise<boolean> {
  if (closedSeen) return true;
  const closed = (await getSetting<boolean>(BOOTSTRAP_KEY, false)) || (await hasPasswordAccount());
  if (closed) closedSeen = true;
  return closed;
}
