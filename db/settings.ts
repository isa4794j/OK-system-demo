/**
 * 설정(settings) 데이터 접근 — 코드가 아니라 센터가 정하는 값
 *
 * 규칙: Supabase 호출은 /db 안에서만 한다.
 *
 * 이름-값 한 쌍이다. 값의 모양은 설정마다 다르므로 여기서는 모른다.
 * 어떤 모양이어야 하는지는 그 설정을 쓰는 쪽(예: resources.ts)이 안다.
 */
import { getClient } from "./client.ts";

/**
 * 설정 하나를 읽는다. 없으면 fallback 을 그대로 돌려준다.
 *
 * 없는 것은 오류가 아니다. 마이그레이션이 기본값을 넣어 두지만,
 * 누군가 지웠거나 새 설정을 코드가 먼저 쓰기 시작한 경우가 있다.
 * 그때 화면이 안 뜨는 것보다 기본값으로 도는 편이 낫다.
 */
export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const { data, error } = await getClient()
    .from("settings")
    .select("value")
    .eq("key", key)
    .maybeSingle();

  if (error) {
    throw new Error(`설정 조회 실패: ${error.message}`);
  }
  return (data?.value ?? fallback) as T;
}

/** 설정 하나를 저장한다. 없으면 만들고 있으면 덮어쓴다. */
export async function saveSetting(key: string, value: unknown): Promise<void> {
  const { error } = await getClient()
    .from("settings")
    .upsert({ key, value }, { onConflict: "key" });

  if (error) {
    throw new Error(`설정 저장 실패: ${error.message}`);
  }
}

/**
 * 설정 자리를 선점한다. 이미 있으면 false — 덮어쓰지 않는다.
 *
 * saveSetting 은 upsert 라 이 목적에 못 쓴다. 두 요청이 동시에 오면 둘 다 성공한다.
 * 여기서는 순수한 insert 를 쓴다. key 가 기본키라 두 번째는 DB 가 막는다.
 * "최초 관리자를 두 사람이 동시에 만드는 일" 을 막는 자물쇠다.
 */
export async function claimSetting(key: string, value: unknown = true): Promise<boolean> {
  const { error } = await getClient()
    .from("settings")
    .insert({ key, value });

  if (!error) return true;
  // 이미 누가 잡았다. 오류가 아니라 답이다.
  if (/duplicate key|settings_pkey|23505/i.test(error.message)) return false;

  throw new Error(`설정 선점 실패: ${error.message}`);
}

/**
 * 선점한 자리를 돌려놓는다 — 선점한 요청이 그 뒤 일을 못 끝냈을 때만 쓴다.
 * (최초 부팅에서 첫 종사자 등록이 실패하면 부팅이 닫힌 채 계정이 0개로 남는다 — 그러면 아무도 못 들어온다)
 */
export async function releaseSetting(key: string): Promise<void> {
  const { error } = await getClient().from("settings").delete().eq("key", key);
  if (error) throw new Error(`설정 선점 되돌리기 실패: ${error.message}`);
}
