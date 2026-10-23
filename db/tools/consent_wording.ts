/**
 * 저장된 동의서·처리방침 문구 손질 — 민감정보 항목(제23조)·보관처 문구·감수 반영(Ⅰ 제목, 거부 문구 "본 기관")
 *
 *   deno run -A --env-file db/tools/consent_wording.ts <단계> [--apply]
 *     check      지금 DB 에 저장된 문구 상태만 본다(쓰지 않음)
 *     practice   연습장(Supabase, DATABASE_URL 없이) — 민감정보 항목을 넣고 보관처는 Supabase 문구 그대로.
 *                저장값이 없으면 기본값(Azure 문구)이 보이므로, 연습장 문구로 한 벌 저장한다.
 *     azure      제출본(애저, DATABASE_URL=애저) — 민감정보 항목 + 보관처를 Azure 문구로.
 *                **재복제 뒤 반드시**: 복제는 연습장 저장 문구를 그대로 실어 온다(docs/azure-migration.md 절차).
 *                저장값이 없으면 기본값이 이미 Azure 문구라 쓸 것이 없다.
 *   --apply 가 없으면 무엇이 바뀔지만 보인다.
 *
 * - 센터가 [문구 수정] 에서 고친 다른 글은 건드리지 않는다(lib/documents.ts 의 addSensitive·setStorage).
 * - 쓰면 감사 로그를 남긴다(화면의 설정 변경과 같은 모양).
 */
import { dbMode } from "../client.ts";
import { getSetting, saveSetting } from "../settings.ts";
import { recordAudit } from "../audit.ts";
import {
  addSensitive,
  addSensitiveToPolicy,
  applyReview,
  checkConsentForm,
  checkPrivacyPolicy,
  CONSENT_FORM_KEY,
  type ConsentForm,
  DEFAULT_CONSENT_FORM,
  DEFAULT_PRIVACY_POLICY,
  PRIVACY_POLICY_KEY,
  type PrivacyPolicy,
  setStorage,
  type StorageSite,
} from "../../lib/documents.ts";

const step = Deno.args[0];
const apply = Deno.args.includes("--apply");
const ACTOR = "시스템/문구 정비 도구";

function target(): string {
  if (dbMode() !== "postgres") return "supabase";
  const host = new URL(Deno.env.get("DATABASE_URL") ?? "").hostname;
  return host.endsWith(".postgres.database.azure.com") ? "azure" : "other";
}

function describe(form: ConsentForm | null, policy: PrivacyPolicy | null): string {
  const lines: string[] = [];
  if (form) {
    const sensitive = form.sections.some((one) => one.title.includes("민감정보"));
    const storage = form.sections.flatMap((one) => one.rows).find((row) =>
      row.label === "데이터 보관"
    );
    lines.push(
      `  동의서: 항목 ${form.sections.length}개, 민감정보 ${
        sensitive ? "있음" : "없음"
      }, 데이터 보관 줄 ${storage ? storage.text.split("\n")[0] : "없음"}`,
    );
  } else lines.push("  동의서: 저장값 없음(기본값이 보인다)");
  if (policy) {
    const storage = policy.sections.find((one) => one.title.includes("보관 위탁"));
    lines.push(`  처리방침 보관: ${storage?.body.split("\n")[0] ?? "(절 없음)"}`);
  } else lines.push("  처리방침: 저장값 없음(기본값이 보인다)");
  return lines.join("\n");
}

async function read() {
  const form = await getSetting<unknown>(CONSENT_FORM_KEY, null);
  const policy = await getSetting<unknown>(PRIVACY_POLICY_KEY, null);
  if (form !== null && checkConsentForm(form)) {
    throw new Error("저장된 동의서 모양이 올바르지 않습니다 — 화면에서 먼저 확인");
  }
  if (policy !== null && checkPrivacyPolicy(policy)) {
    throw new Error("저장된 처리방침 모양이 올바르지 않습니다 — 화면에서 먼저 확인");
  }
  return { form: form as ConsentForm | null, policy: policy as PrivacyPolicy | null };
}

async function write(key: string, label: string, before: unknown, after: unknown) {
  if (JSON.stringify(before) === JSON.stringify(after)) {
    console.log(`  ${label}: 바뀔 것 없음`);
    return;
  }
  if (!apply) {
    console.log(`  ${label}: 바뀜(미리보기 — --apply 로 저장)`);
    return;
  }
  await saveSetting(key, after);
  await recordAudit({
    action: "update",
    actor: ACTOR,
    table_name: "settings",
    record_id: null,
    summary: `설정 변경: ${label} (${key}) — 민감정보 항목·보관처 문구 정비`,
    before,
    after,
  });
  console.log(`  ${label}: 저장함(감사 로그 남김)`);
}

async function fix(site: StorageSite, fillMissing: boolean) {
  const now = await read();
  console.log(`[${target()}] 지금\n${describe(now.form, now.policy)}`);
  const form = now.form ?? (fillMissing ? DEFAULT_CONSENT_FORM : null);
  const policy = now.policy ?? (fillMissing ? DEFAULT_PRIVACY_POLICY : null);
  const next = setStorage(
    applyReview(addSensitive(form ?? DEFAULT_CONSENT_FORM)),
    addSensitiveToPolicy(policy ?? DEFAULT_PRIVACY_POLICY),
    site,
  );
  console.log(`바꾼 뒤\n${describe(form ? next.form : null, policy ? next.policy : null)}`);
  if (form) await write(CONSENT_FORM_KEY, "동의서 문구", now.form, next.form);
  if (policy) await write(PRIVACY_POLICY_KEY, "개인정보 처리방침 문구", now.policy, next.policy);
}

if (step === "check") {
  const now = await read();
  console.log(`[${target()}]\n${describe(now.form, now.policy)}`);
} else if (step === "practice") {
  if (target() !== "supabase") {
    throw new Error("practice 는 연습장(Supabase)에서만 — DATABASE_URL 을 비우고 돌리세요.");
  }
  await fix("supabase", true);
} else if (step === "azure") {
  if (target() !== "azure") {
    throw new Error("azure 는 애저 DB 에서만 — DATABASE_URL 을 애저 주소로 두고 돌리세요.");
  }
  await fix("azure", false);
} else {
  console.log("단계: check | practice | azure  [--apply]");
}
Deno.exit(0);
