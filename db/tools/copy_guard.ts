/**
 * 복제 도구 안전핀 — 애저가 원본이 된 뒤로 copy_to_azure 는 기본이 "실행 거부" 다
 *
 * 2026-09-18 결정: **애저 DB 가 원본**이고 연습장(Supabase) 데이터는 더 이상 애저로 복사하지 않는다.
 * 그런데 도구는 그대로 남아 있다(옛 절차 기록·새 DB 를 세울 일이 다시 생길 수 있어서).
 * 실수로 한 줄 돌리면 센터가 애저에 새로 넣은 기록이 옛 연습장 데이터로 덮인다 — 되돌릴 수 없다.
 * 그래서 문서 경고가 아니라 코드가 막는다: 환경변수를 정확한 값으로 주지 않으면 아무 단계도 돌지 않는다.
 *
 * clean(덤프 파일 삭제)만 예외다 — 지우는 쪽이라 막을 이유가 없고, 막으면 개인정보가 든 파일이 남는다.
 */

export const COPY_PIN_ENV = "ALLOW_COPY_TO_AZURE";

/** 손이 미끄러져 눌리지 않을 만큼 길고, 뜻이 분명한 값. */
export const COPY_PIN_VALUE = "overwrite-azure-with-practice-data";

/** 안전핀 없이도 되는 단계 — 지우기만 한다. */
const FREE_STEPS = new Set(["clean", "", undefined]);

export type CopyVerdict = { ok: true } | { ok: false; reason: string };

/**
 * 이 단계를 돌려도 되는가. 환경변수 값이 정확히 맞을 때만 연다.
 * @param step 도구에 준 단계 이름
 * @param pin 환경변수 ALLOW_COPY_TO_AZURE 값(없으면 undefined)
 */
export function copyAllowed(step: string | undefined, pin: string | undefined): CopyVerdict {
  if (FREE_STEPS.has(step)) return { ok: true };
  if ((pin ?? "").trim() === COPY_PIN_VALUE) return { ok: true };
  return {
    ok: false,
    reason: [
      `막았습니다 — '${step}' 는 애저 DB 를 연습장(Supabase) 데이터로 덮어쓰는 길입니다.`,
      "2026-09-18 부터 **애저가 원본**입니다. 센터가 애저에 넣은 기록이 사라지고 되돌릴 수 없습니다.",
      "정말 새 DB 를 세우는 경우에만, 사람이 그 뜻을 알고 이렇게 켭니다:",
      `  ${COPY_PIN_ENV}=${COPY_PIN_VALUE} deno run -A --env-file --config deno.json db/tools/copy_to_azure.ts ${step}`,
      "(덤프 파일 삭제 clean 은 안전핀 없이 됩니다.)",
    ].join("\n"),
  };
}
