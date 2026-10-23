/**
 * 관문 경고 — "잠갔으면 막혔을 요청" 을 모아 둔다
 *
 * 4단계에서 관문을 켜되 막지는 않는다. 대신 막혔을 요청을 여기 쌓아 두고
 * 사람이 훑어보게 한다. 정책표의 빈틈은 이 목록에서 드러난다.
 * 목록이 비면 잠가도 된다는 뜻이다(5단계).
 *
 * [메모리에 둔다]
 * 표를 만들지 않는다. 이 값은 며칠 살면 되는 것이고, 서버가 다시 뜨면
 * 다시 쌓으면 된다. 잠근 뒤에는 이 파일 자체가 조용해진다.
 *
 * 서버 로그에도 같은 줄을 남긴다 — 배포에서는 그쪽이 오래 남는다.
 */

/** 들고 있을 개수. 넘으면 오래된 것부터 버린다. */
const MAX = 200;

export type Warning = {
  at: string;
  method: string;
  path: string;
  /** 누가 보냈나. 로그인 안 했으면 null. */
  who: string | null;
  level: string | null;
  access_kind: string | null;
  need: string;
  /** 정책표에 없어서 기본값(관리자만)으로 떨어진 자리인가 */
  fallback: boolean;
  /** 무엇 때문에 막혔을까 — 등급인가 접속 권한인가 */
  reason: "로그인 필요" | "등급 부족" | "PC 전용";
  /** 같은 줄이 몇 번 반복됐나 */
  count: number;
};

const warnings: Warning[] = [];

/** 같은 요청이 수십 번 오면 목록이 그것만으로 찬다. 같은 줄은 세기만 한다. */
function keyOf(one: Omit<Warning, "at" | "count">): string {
  return `${one.method} ${one.path} ${one.who} ${one.reason}`;
}

export function recordWarning(one: Omit<Warning, "at" | "count">): void {
  const key = keyOf(one);
  const found = warnings.find((w) => keyOf(w) === key);

  if (found) {
    found.count += 1;
    found.at = new Date().toISOString();
  } else {
    warnings.unshift({ ...one, at: new Date().toISOString(), count: 1 });
    if (warnings.length > MAX) warnings.length = MAX;
  }

  console.warn(
    `[관문 경고] ${one.method} ${one.path} · 누가=${one.who ?? "(미로그인)"}` +
      `(${one.level ?? "-"}/${one.access_kind ?? "-"}) · 필요=${one.need}` +
      ` · 이유=${one.reason}${one.fallback ? " · 표에 없음" : ""}`,
  );
}

/** 최근 것부터. 화면이 읽어 간다. */
export function listWarnings(): Warning[] {
  return warnings;
}

export function clearWarnings(): void {
  warnings.length = 0;
}
