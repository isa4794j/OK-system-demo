import { assertEquals, assertNotEquals } from "@std/assert";
import {
  addSensitive,
  addSensitiveToPolicy,
  applyReview,
  checkCenterName,
  checkConsentForm,
  checkPrivacyPolicy,
  DEFAULT_CENTER_NAME,
  DEFAULT_CONSENT_FORM,
  DEFAULT_PRIVACY_POLICY,
  fillCenter,
  readCenterName,
  readConsentForm,
  readPrivacyPolicy,
  setStorage,
  STORAGE_WORDING,
} from "./documents.ts";

Deno.test("기본 문구는 제 검사를 통과한다", () => {
  assertEquals(checkConsentForm(DEFAULT_CONSENT_FORM), null);
  assertEquals(checkPrivacyPolicy(DEFAULT_PRIVACY_POLICY), null);
  assertEquals(checkCenterName(DEFAULT_CENTER_NAME), null);
});

Deno.test("동의서 기본값 — Ⅰ~Ⅵ, Ⅱ 민감정보(제23조), Ⅵ 는 위탁·국외 이전과 거부 시 수기 관리", () => {
  const titles = DEFAULT_CONSENT_FORM.sections.map((one) => one.title);
  assertEquals(titles.map((one) => one.slice(0, 2)), ["Ⅰ.", "Ⅱ.", "Ⅲ.", "Ⅳ.", "Ⅴ.", "Ⅵ."]);
  const two = JSON.stringify(DEFAULT_CONSENT_FORM.sections[1]);
  for (const word of ["민감정보", "제23조", "건강상의 유의점", "가정환경, 경제상황", "거부할 수"]) {
    assertEquals(two.includes(word), true, word);
  }
  assertEquals(JSON.stringify(DEFAULT_CONSENT_FORM.sections[0]).includes("가정환경"), false);
  const five = DEFAULT_CONSENT_FORM.sections[5].rows.map((row) => `${row.label}:${row.text}`).join(
    "\n",
  );
  for (
    const word of [
      "제26조",
      "제28조의8",
      "Anthropic, PBC (미국)",
      "가명",
      "학습에 사용되지 않음",
      "수기로",
      "대한민국 소재 클라우드(Microsoft Azure)",
    ]
  ) {
    assertEquals(five.includes(word), true, word);
  }
  assertEquals(DEFAULT_CONSENT_FORM.sections.every((one) => one.choice), true);
});

Deno.test("처리방침 기본값 — 보관 위탁 절(Microsoft Azure, 대한민국)·민감정보 줄과 갱신 문구", () => {
  const all = DEFAULT_PRIVACY_POLICY.sections.map((one) => `${one.title}\n${one.body}`).join("\n");
  assertEquals(
    all.includes("현재: Microsoft Azure, 대한민국(Korea South))에 암호화 통신으로 보관"),
    true,
  );
  assertEquals(all.includes("Supabase"), false);
  assertEquals(all.includes("민감정보(별도 동의)"), true);
  assertEquals(all.includes("이 절을 고쳐 안내합니다"), true);
  // 동의서 Ⅵ 과 같은 업체
  assertEquals(all.includes("Anthropic, PBC (미국)"), true);
});

Deno.test("모양이 틀리면 거절, 망가진 저장값은 기본값으로 읽는다", () => {
  assertNotEquals(checkConsentForm(null), null);
  assertNotEquals(checkConsentForm({ ...DEFAULT_CONSENT_FORM, sections: [] }), null);
  assertNotEquals(
    checkConsentForm({
      ...DEFAULT_CONSENT_FORM,
      sections: [{ title: "x", rows: [{ label: "", text: "a" }], choice: true }],
    }),
    null,
  );
  assertNotEquals(
    checkConsentForm({ ...DEFAULT_CONSENT_FORM, signs: ["a", "b", "c", "d", "e", "f", "g"] }),
    null,
  );
  assertNotEquals(checkPrivacyPolicy({ ...DEFAULT_PRIVACY_POLICY, staff_notice: " " }), null);
  assertNotEquals(checkCenterName(""), null);
  assertNotEquals(checkCenterName("가".repeat(61)), null);
  assertEquals(readConsentForm({ title: 1 }), DEFAULT_CONSENT_FORM);
  assertEquals(readPrivacyPolicy("x"), DEFAULT_PRIVACY_POLICY);
  assertEquals(readCenterName(null), DEFAULT_CENTER_NAME);
  assertEquals(readCenterName("  새 센터 "), "새 센터");
});

Deno.test("고친 문구(업체 변경)도 통과한다 — 코드 수정 없이 글만 바꾸는 길", () => {
  const next = structuredClone(DEFAULT_CONSENT_FORM);
  next.sections[5].rows[1].text = "▸ 다른 AI 회사 (대한민국)";
  assertEquals(checkConsentForm(next), null);
  const policy = structuredClone(DEFAULT_PRIVACY_POLICY);
  policy.sections[4].body =
    "▸ 개인정보는 국외 소재 클라우드 서버(현재: Azure, 미국)에 암호화 통신으로 보관됩니다.";
  assertEquals(checkPrivacyPolicy(policy), null);
});

Deno.test("{센터} 채우기", () => {
  assertEquals(
    fillCenter("{센터}장 귀하", "그래좋아 사회적협동조합"),
    "그래좋아 사회적협동조합장 귀하",
  );
  assertEquals(fillCenter("{센터}·{센터}", "A"), "A·A");
});

/** 민감정보 항목 전의 옛 기본값(Ⅰ~Ⅴ, 보관처 Supabase) — 이미 저장된 문구가 이 모양이다 */
function legacy() {
  const form = structuredClone(DEFAULT_CONSENT_FORM);
  form.sections.splice(1, 1);
  form.sections[0].rows[0].text += "\n▸ 가정환경, 경제상황";
  form.sections.forEach((one, i) => one.title = one.title.replace(/^[Ⅰ-Ⅻ]\./, `${"ⅠⅡⅢⅣⅤ"[i]}.`));
  form.sections[4].rows = form.sections[4].rows.filter((row) => row.label !== "데이터 보관");
  form.sections[2].rows[0].text = "▸ 센터가 고친 글"; // 센터가 고친 곳은 그대로 남아야 한다
  // 감수 전 글자
  form.sections[0].title = "Ⅰ. 일반개인정보 및 고유식별정보 수집·이용 동의";
  for (const one of form.sections) {
    for (const row of one.rows) {
      row.text = row.text.replace("본 기관에서 제공하는", "지역아동센터에서 제공하는");
    }
  }
  const policy = structuredClone(DEFAULT_PRIVACY_POLICY);
  policy.sections[0].body = policy.sections[0].body.split("\n").filter((l) =>
    !l.includes("민감정보")
  ).join("\n");
  policy.sections[4].body =
    `${STORAGE_WORDING.supabase.policy}\n※ 보관 서버(인프라)가 바뀌면 이 절을 고쳐 안내합니다.`;
  return { form, policy };
}

Deno.test("저장 문구 손질 — 민감정보 끼우기(번호 밀기·가정환경 옮기기, 두 번 돌려도 같다)", () => {
  const { form, policy } = legacy();
  const once = applyReview(addSensitive(form));
  assertEquals(
    once.sections.map((one) => one.title),
    DEFAULT_CONSENT_FORM.sections.map((one) => one.title),
  );
  assertEquals(once.sections[0].rows[0].text, DEFAULT_CONSENT_FORM.sections[0].rows[0].text);
  assertEquals(once.sections[3].rows[0].text, "▸ 센터가 고친 글");
  assertEquals(addSensitive(once), once);
  assertEquals(checkConsentForm(once), null);
  const p = addSensitiveToPolicy(policy);
  assertEquals(p.sections[0].body, DEFAULT_PRIVACY_POLICY.sections[0].body);
  assertEquals(addSensitiveToPolicy(p), p);
});

Deno.test("저장 문구 손질 — 보관처 azure ↔ supabase (재복제 뒤 되돌리기)", () => {
  const { form, policy } = legacy();
  const toAzure = setStorage(applyReview(addSensitive(form)), policy, "azure");
  const expected = structuredClone(DEFAULT_CONSENT_FORM);
  expected.sections[3].rows[0].text = "▸ 센터가 고친 글";
  assertEquals(toAzure.form, expected);
  assertEquals(toAzure.policy.sections[4].body, DEFAULT_PRIVACY_POLICY.sections[4].body);
  assertEquals(setStorage(toAzure.form, toAzure.policy, "azure"), toAzure);
  const back = setStorage(toAzure.form, toAzure.policy, "supabase");
  assertEquals(JSON.stringify(back).includes("Microsoft Azure"), false);
  assertEquals(back.policy.sections[4].body.startsWith(STORAGE_WORDING.supabase.policy), true);
});

Deno.test("감수 반영 — Ⅰ 제목·거부 문구 '본 기관'(기본값에도, 저장값 손질에도)", () => {
  const all = JSON.stringify(DEFAULT_CONSENT_FORM);
  assertEquals(all.includes("고유식별정보"), false);
  assertEquals(all.includes("지역아동센터"), false);
  assertEquals(DEFAULT_CONSENT_FORM.sections[0].title, "Ⅰ. 개인정보 수집·이용 동의");
  const fixed = applyReview(legacy().form);
  assertEquals(JSON.stringify(fixed).includes("지역아동센터"), false);
  assertEquals(fixed.sections[0].title, "Ⅰ. 개인정보 수집·이용 동의");
  assertEquals(applyReview(fixed), fixed);
});
