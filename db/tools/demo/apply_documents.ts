/**
 * 데모 DB 의 동의서·처리방침 문구를 이 코드의 기본 문구로 바꾼다 — 데모_반영지시 2-5 의 (나) 방식.
 *
 * 코드를 고쳐도 데모 화면이 안 바뀌는 까닭: settings 에 저장된 값이 기본값을 이긴다(readPrivacyPolicy).
 * 그래서 새 기본 문구를 settings 에 직접 넣는다. 화면의 [이 탭을 기본 문구로] → [저장] 과 같은 결과다.
 *
 *   deno run -A --env-file db/tools/demo/apply_documents.ts            # 미리보기(쓰지 않음)
 *   deno run -A --env-file db/tools/demo/apply_documents.ts --apply    # 저장 + 감사 기록
 *
 * - 데모는 Supabase 보관이라 보관처 문구는 supabase 로 맞춘다(기본값은 Azure 문구).
 * - center_name 은 건드리지 않는다 — 데모 센터 이름이 기본값으로 돌아가면 안 된다.
 * - 접속 주소는 환경변수(DATABASE_URL 또는 SUPABASE_*)로만 받는다. 값은 출력하지 않는다.
 *   호스트가 Azure(*.postgres.database.azure.com)면 즉시 멈춘다.
 * - 쓴 뒤에는 baseline.ts 를 다시 돌려야 다음 날 초기화 때도 새 문구가 남는다.
 */
import { dbMode } from "../../client.ts";
import { getSetting, saveSetting } from "../../settings.ts";
import { recordAudit } from "../../audit.ts";
import {
  addSensitive,
  addSensitiveToPolicy,
  applyReview,
  checkConsentForm,
  checkPrivacyPolicy,
  CONSENT_FORM_KEY,
  DEFAULT_CONSENT_FORM,
  DEFAULT_PRIVACY_POLICY,
  PRIVACY_POLICY_KEY,
  setStorage,
} from "../../../lib/documents.ts";

const apply = Deno.args.includes("--apply");
const ACTOR = "시스템/데모 문구 정비";

if (dbMode() === "postgres") {
  const host = new URL(Deno.env.get("DATABASE_URL") ?? "").hostname;
  if (host.endsWith(".postgres.database.azure.com")) {
    console.error("Azure DB 입니다 — 데모 DB 가 아니므로 멈춥니다.");
    Deno.exit(1);
  }
}

const next = setStorage(
  applyReview(addSensitive(structuredClone(DEFAULT_CONSENT_FORM))),
  addSensitiveToPolicy(structuredClone(DEFAULT_PRIVACY_POLICY)),
  "supabase",
);
// 저장 전에 화면과 같은 모양 검사를 통과하는지 본다
const bad = checkConsentForm(next.form) ?? checkPrivacyPolicy(next.policy);
if (bad) {
  console.error(`새 문구가 모양 검사를 통과하지 못했습니다: ${bad}`);
  Deno.exit(1);
}

const targets = [
  { key: CONSENT_FORM_KEY, label: "동의서 문구", value: next.form },
  { key: PRIVACY_POLICY_KEY, label: "개인정보 처리방침 문구", value: next.policy },
];

for (const one of targets) {
  const before = await getSetting<unknown>(one.key, null);
  if (JSON.stringify(before) === JSON.stringify(one.value)) {
    console.log(`${one.label}: 이미 같음`);
    continue;
  }
  if (!apply) {
    console.log(`${one.label}: 바뀜(미리보기 — --apply 로 저장)`);
    continue;
  }
  await saveSetting(one.key, one.value);
  // 누가 언제 바꿨는지가 비면 안 된다 — 화면의 설정 변경과 같은 모양으로 남긴다
  await recordAudit({
    action: "update",
    actor: ACTOR,
    table_name: "settings",
    record_id: null,
    summary: `설정 변경: ${one.label} (${one.key})`,
    before,
    after: one.value,
  });
  console.log(`${one.label}: 저장함(감사 기록 남김)`);
}
if (apply) console.log("끝났습니다 — 이어서 baseline.ts 를 다시 돌리세요.");
Deno.exit(0);
