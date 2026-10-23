/**
 * 센터가 고치는 문서 — 동의서·개인정보 처리방침·센터 이름
 *
 * [업체·인프라 이름은 코드가 아니라 저장된 문구에 산다]
 * DB·서버(Supabase → 다른 곳)와 AI 업체(Anthropic → 다른 곳)는 바뀔 수 있다.
 * 바뀌는 날 코드를 고치지 않고 [설정 › 동의서 › 문구 수정] 에서 글만 고치면 되게,
 * 인쇄·공개 화면은 settings 에 저장된 값을 읽는다. 여기 있는 것은 **처음 한 번 쓰는 기본값**뿐이다.
 * (기본값에 적힌 업체명은 저장값이 없을 때만 보인다. 한 번 저장하면 그 뒤로는 저장값이 이긴다.)
 *
 * [센터 이름]
 * 기본 문구에는 센터 이름(그래좋아 사회적협동조합)을 글자 그대로 적는다 — [문구 수정] 화면에 실제 이름이 보이고, 조사(을/를)도 맞게.
 * 인쇄물 하단은 center_name 설정을 쓴다. 문구 안에 {센터} 라고 쓰면 그 설정으로 바뀐다(선택 — 이름을 한 곳에서 바꾸고 싶을 때).
 *
 * 모양 검사는 api/settings.ts 가 이 파일의 check* 로 한다. 화면(web/assets/documents.js)은 같은 모양을 쓴다.
 */

export const CONSENT_FORM_KEY = "consent_form";
export const PRIVACY_POLICY_KEY = "privacy_policy";
export const CENTER_NAME_KEY = "center_name";

export const DEFAULT_CENTER_NAME = "그래좋아 사회적협동조합";

/** 항목 안의 한 줄 — 머리(수집항목·목적…)와 본문(여러 줄 가능) */
export type DocRow = { label: string; text: string };

/** 동의서 항목 하나(Ⅰ~Ⅵ) */
export type ConsentSection = {
  title: string;
  rows: DocRow[];
  /** 끝의 □ 동의함 □ 동의하지 않음 을 붙이는가 */
  choice: boolean;
};

export type ConsentForm = {
  title: string;
  intro: string;
  sections: ConsentSection[];
  /** 말미 안내(※ …) */
  notes: string;
  /** 확인 문장 */
  confirm: string;
  /** 서명란 줄들 — "아동 성명 :            (서명)" 같은 */
  signs: string[];
  /** 수신 — "○○장 귀하" */
  addressee: string;
};

export type PolicySection = { title: string; body: string };

export type PrivacyPolicy = {
  title: string;
  intro: string;
  sections: PolicySection[];
  /** 직원·봉사자 첫 로그인 동의 화면에 보이는 요약 */
  staff_notice: string;
  /** 동의 체크 칸 옆 문장 */
  staff_agree: string;
};

const REFUSAL_LABEL = "거부권 및 거부에 따른 불이익";
const REFUSAL_TEXT =
  "귀하는 위와 같은 개인정보의 수집·이용을 거부할 수 있습니다. 다만, 개인정보의 필수적 수집·이용에 동의하지 않을 경우 본 기관에서 제공하는 사업에 대한 활동이 제한될 수 있습니다.";

/**
 * 민감정보 별도 동의(개인정보 보호법 제23조) — 가정환경·경제상황은 Ⅰ 에서 이리로 옮겼다.
 * 이미 저장된 문구에 끼워 넣는 도구(azure-migration 의 db/tools/consent_wording.ts)도 이 값을 쓴다.
 */
export const SENSITIVE_SECTION: ConsentSection = {
  title: "Ⅱ. 민감정보 수집·이용 동의",
  rows: [
    { label: "법적 근거", text: "▸ 개인정보 보호법 제23조(민감정보의 처리 제한)" },
    {
      label: "수집항목",
      text: "▸ 건강상의 유의점 등 건강 관련 관찰 기록\n▸ 가정환경, 경제상황",
    },
    { label: "수집 및 이용 목적", text: "▸ 아동 보호 및 발달 관찰" },
    { label: "보유 및 이용기간", text: "▸ 5년" },
    {
      label: REFUSAL_LABEL,
      text:
        "귀하는 민감정보의 수집·이용을 거부할 수 있습니다. 거부하시더라도 센터 이용에는 제한이 없으나, 건강·가정 사정을 고려한 보호와 지원이 충분하지 못할 수 있습니다.",
    },
  ],
  choice: true,
};

/** 처리방침 1절에 더하는 민감정보 줄 */
export const SENSITIVE_POLICY_LINE =
  "▸ 민감정보(별도 동의): 건강상의 유의점 등 건강 관련 관찰 기록, 가정환경·경제상황";

/**
 * 보관처 문구 — 제출본(Azure)과 연습장(Supabase)이 다르다.
 * 기본값은 Azure. 연습장 DB 에는 supabase 문구를 저장해 둔다(azure-migration 의 db/tools/consent_wording.ts).
 */
export type StorageSite = "azure" | "supabase";
const STORAGE_ROW_LABEL = "데이터 보관";
export const STORAGE_WORDING: Record<StorageSite, { row: DocRow | null; policy: string }> = {
  azure: {
    row: {
      label: STORAGE_ROW_LABEL,
      text:
        "▸ 대한민국 소재 클라우드(Microsoft Azure)\n(국외로 전송되는 것은 분석할 때의 가명 처리된 기록뿐)",
    },
    policy:
      "▸ 개인정보는 대한민국 소재 클라우드 서버(현재: Microsoft Azure, 대한민국(Korea South))에 암호화 통신으로 보관됩니다.",
  },
  supabase: {
    row: null,
    policy:
      "▸ 개인정보는 국외 소재 클라우드 서버(현재: Supabase, 미국)에 암호화 통신으로 보관됩니다.",
  },
};

export const DEFAULT_CONSENT_FORM: ConsentForm = {
  title: "개인정보 처리에 관한 동의서",
  intro:
    "본인은 그래좋아 사회적협동조합을 이용함에 있어 아래와 같이 개인정보를 수집·이용 및 제공하는 것에 대하여 안내를 받았으며, 이에 동의합니다.",
  sections: [
    {
      title: "Ⅰ. 개인정보 수집·이용 동의",
      rows: [
        {
          label: "수집항목",
          text: "▸ 성명, 생년월일, 이메일, 연락처, 주소, 학교명, 학년, 반",
        },
        { label: "수집 및 이용 목적", text: "▸ 프로그램 지원·운영 및 아동 관리" },
        { label: "보유 및 이용기간", text: "▸ 5년" },
        { label: REFUSAL_LABEL, text: REFUSAL_TEXT },
      ],
      choice: true,
    },
    SENSITIVE_SECTION,
    {
      title: "Ⅲ. 사진·영상·홍보물·인쇄물 수집·이용 동의",
      rows: [
        { label: "수집항목", text: "▸ 활동사진, 영상, 성명, 학년" },
        { label: "수집 및 이용 목적", text: "▸ 활동 기록 및 홍보" },
        { label: "보유 및 이용기간", text: "▸ 5년" },
        { label: REFUSAL_LABEL, text: REFUSAL_TEXT },
      ],
      choice: true,
    },
    {
      title: "Ⅳ. 보호자 개인정보 선택적 수집·이용 동의",
      rows: [
        { label: "수집항목", text: "▸ 성명, 연락처, 생년월일" },
        { label: "수집 및 이용 목적", text: "▸ 프로그램 참가" },
        { label: "보유 및 이용기간", text: "▸ 목적 달성 시까지" },
        { label: REFUSAL_LABEL, text: REFUSAL_TEXT },
      ],
      choice: true,
    },
    {
      title: "Ⅴ. 개인정보 제3자 제공 동의",
      rows: [
        { label: "제공항목", text: "▸ 성명, 연락처, 학년, 활동기록" },
        { label: "제공 목적", text: "▸ 외부 지원 사업 선정·평가·결과보고" },
        { label: "보유 및 이용기간", text: "▸ 이용목적 달성 시까지" },
        { label: REFUSAL_LABEL, text: REFUSAL_TEXT },
      ],
      choice: true,
    },
    {
      title: "Ⅵ. 개인정보 처리위탁 및 국외 이전 동의(AI 활용)",
      rows: [
        {
          label: "법적 근거",
          text:
            "▸ 개인정보 보호법 제26조(업무위탁에 따른 개인정보의 처리 제한), 제28조의8(개인정보의 국외 이전)",
        },
        {
          label: "위탁·이전받는 자",
          text: "▸ Anthropic, PBC (미국)\n※ 위탁 업체가 변경되는 경우 변경 내용을 안내합니다",
        },
        { label: "이전 국가·방법", text: "▸ 미국, 기록 분석 시 네트워크 전송" },
        STORAGE_WORDING.azure.row!,
        {
          label: "이전 항목",
          text:
            "▸ 가명 처리된 활동·관찰 기록\n(성명 등 식별정보는 전송 전 가명 치환되어 전송되지 않음)",
        },
        {
          label: "이용 목적",
          text: "▸ 기록 분석 및 발달 관찰 보조\n(AI 분석 결과는 종사자 검토 후 확정)",
        },
        {
          label: "보유 및 이용기간",
          text: "▸ 분석 처리 시까지\n(원문·개인정보는 AI 학습에 사용되지 않음)",
        },
        {
          label: REFUSAL_LABEL,
          text:
            "동의하지 않을 경우 해당 아동의 기록은 AI 분석 없이 수기로 기록·관리되며, 센터 이용에는 제한이 없습니다.",
        },
      ],
      choice: true,
    },
  ],
  notes:
    "※ 위의 신상정보에 대해서는 '개인정보보호법'에 따라 보호되며, 영리목적으로 활용되지 않습니다.\n※ 만 14세 미만 아동의 경우 법정대리인의 동의가 필요합니다.",
  confirm: "본인은 위의 내용을 충분히 이해하였으며, 위와 같이 개인정보를 처리하는 것에 동의합니다.",
  signs: ["아동 성명 :                    (서명)", "보호자 성명 :                    (서명)"],
  addressee: "그래좋아 사회적협동조합장 귀하",
};

export const DEFAULT_PRIVACY_POLICY: PrivacyPolicy = {
  title: "개인정보 처리방침",
  intro:
    '그래좋아 사회적협동조합(이하 "센터")는 아동·보호자·종사자·봉사자의 개인정보를 소중히 다루며, 개인정보 보호법에 따라 아래와 같이 처리합니다.',
  sections: [
    {
      title: "1. 수집하는 개인정보 항목",
      body:
        `▸ 아동: 성명, 생년월일, 성별, 학교, 입소·종결일, 보호자 관계·연락처, 주소, 의뢰배경\n${SENSITIVE_POLICY_LINE}\n▸ 활동 기록: 일지·관찰·평가 글\n▸ 종사자·봉사자: 성명, 연락처, 역할, 로그인 정보(비밀번호는 복원할 수 없는 형태로 저장)`,
    },
    {
      title: "2. 수집·이용 목적",
      body:
        "▸ 아동 보호·돌봄 프로그램 운영 및 아동 관리\n▸ 활동 기록과 발달 관찰, 연간 평가\n▸ 종사자·봉사자 근무 일정과 계정 관리",
    },
    {
      title: "3. 보유 및 이용 기간",
      body:
        "▸ 아동 기록: 5년(동의서에서 정한 기간)\n▸ 보호자 선택 정보: 목적 달성 시까지\n▸ 계정 정보: 활동 종료 후 센터가 정한 기간까지",
    },
    {
      title: "4. 개인정보 처리위탁 및 국외 이전(AI 활용)",
      body:
        "▸ 위탁·이전받는 자: Anthropic, PBC (미국)\n▸ 이전 항목: 가명 처리된 활동·관찰 기록 — 성명 등 식별정보는 전송 전 가명으로 바뀌어 전송되지 않습니다\n▸ 이전 방법: 기록 분석 시 네트워크 전송\n▸ 이용 목적: 기록 분석 및 발달 관찰 보조 — AI 분석 결과는 종사자가 검토한 뒤 확정합니다\n▸ 보유 기간: 분석 처리 시까지 — 원문·개인정보는 AI 학습에 사용되지 않습니다\n▸ 자료 사진(자원·책 표지)은 내용 인식에만 쓰고 저장하지 않습니다\n※ 위탁 업체가 바뀌면 이 절을 고쳐 안내합니다.",
    },
    {
      title: "5. 보관 위탁",
      body:
        `${STORAGE_WORDING.azure.policy}\n※ 보관 서버(인프라)가 바뀌면 이 절을 고쳐 안내합니다.`,
    },
    {
      title: "6. 안전성 확보 조치",
      body:
        "▸ 로그인한 사람만, 맡은 역할에 필요한 만큼만 볼 수 있게 권한을 나눕니다\n▸ 아동 신원 정보와 활동 기록을 나누어 저장합니다\n▸ 삭제와 주요 수정은 변경 기록에 남깁니다\n▸ 통신은 암호화(HTTPS)되며, 비밀번호는 복원할 수 없는 형태로 저장합니다",
    },
    {
      title: "7. 정보주체의 권리",
      body: "▸ 본인(아동은 법정대리인)은 개인정보의 열람·정정·삭제·처리정지를 요구할 수 있습니다.",
    },
    {
      title: "8. 문의처",
      body: "▸ 그래좋아 사회적협동조합 센터장\n▸ 개인정보 관련 문의는 센터로 연락해 주세요.",
    },
  ],
  staff_notice:
    "이 시스템은 아동의 활동·관찰 기록을 다룹니다. 기록 분석에는 AI(국외 위탁)가 쓰이며, 이름 등 식별정보는 전송 전에 가명으로 바뀝니다. 아동 정보는 업무에만 쓰고, 화면을 찍거나 밖으로 옮기지 마세요. 이용자 본인(성명·연락처·로그인 기록)의 정보도 계정 관리에 쓰입니다.",
  staff_agree:
    "위 안내와 개인정보 처리방침을 읽었으며, 개인정보 처리와 업무상 비밀 유지에 동의합니다.",
};

/* ---------- 저장된 문구 손질(azure-migration 의 db/tools/consent_wording.ts) — 센터가 고친 다른 글은 그대로 두고 필요한 곳만 ---------- */

const ROMAN = ["Ⅰ", "Ⅱ", "Ⅲ", "Ⅳ", "Ⅴ", "Ⅵ", "Ⅶ", "Ⅷ", "Ⅸ", "Ⅹ", "Ⅺ", "Ⅻ"];
const MOVED_LINE = "▸ 가정환경, 경제상황";

/**
 * 감수 반영(2026-09-17) — Ⅰ 제목에서 '고유식별정보' 제거, 거부 불이익 문구의 '지역아동센터' → '본 기관'.
 * 옛 글자가 있는 곳만 바꾼다(여러 번 돌려도 같다).
 */
export function applyReview(form: ConsentForm): ConsentForm {
  const next = structuredClone(form);
  for (const section of next.sections) {
    section.title = section.title.replace(
      "일반개인정보 및 고유식별정보 수집·이용 동의",
      "개인정보 수집·이용 동의",
    );
    for (const row of section.rows) {
      if (row.label === REFUSAL_LABEL) row.text = row.text.replaceAll("지역아동센터", "본 기관");
    }
  }
  return next;
}

/** 민감정보 항목을 Ⅱ 에 끼우고 뒤 번호를 한 칸씩 민다. 이미 있으면 그대로(여러 번 돌려도 같다). */
export function addSensitive(form: ConsentForm): ConsentForm {
  const next = structuredClone(form);
  if (next.sections.some((one) => one.title.includes("민감정보"))) return next;
  // 가정환경·경제상황은 민감정보 쪽으로 옮긴다
  for (const row of next.sections[0]?.rows ?? []) {
    row.text = row.text.split("\n").filter((line) => line.trim() !== MOVED_LINE).join("\n");
  }
  next.sections.splice(1, 0, structuredClone(SENSITIVE_SECTION));
  next.sections.forEach((one, i) => {
    if (i > 1 && ROMAN[i]) one.title = one.title.replace(/^[Ⅰ-Ⅻ]\./, `${ROMAN[i]}.`);
  });
  return next;
}

/** 처리방침 1절(수집 항목)에 민감정보 줄 — 이미 있으면 그대로 */
export function addSensitiveToPolicy(policy: PrivacyPolicy): PrivacyPolicy {
  const next = structuredClone(policy);
  const first = next.sections.find((one) => one.title.includes("수집하는")) ?? next.sections[0];
  if (!first || first.body.includes("민감정보")) return next;
  const lines = first.body.split("\n");
  const child = lines.findIndex((line) => line.startsWith("▸ 아동"));
  lines.splice(child + 1, 0, SENSITIVE_POLICY_LINE);
  first.body = lines.join("\n");
  return next;
}

/** 보관처 문구만 바꾼다 — 동의서 위탁 항목의 "데이터 보관" 줄, 처리방침 보관 절의 첫 줄 */
export function setStorage(
  form: ConsentForm,
  policy: PrivacyPolicy,
  site: StorageSite,
): { form: ConsentForm; policy: PrivacyPolicy } {
  const wording = STORAGE_WORDING[site];
  const nextForm = structuredClone(form);
  const transfer = nextForm.sections.find((one) =>
    one.rows.some((row) => row.label.includes("이전받는"))
  );
  if (transfer) {
    transfer.rows = transfer.rows.filter((row) => row.label !== STORAGE_ROW_LABEL);
    if (wording.row) {
      const after = transfer.rows.findIndex((row) => row.label.startsWith("이전 국가"));
      transfer.rows.splice(after < 0 ? 1 : after + 1, 0, structuredClone(wording.row));
    }
  }
  const nextPolicy = structuredClone(policy);
  const storage = nextPolicy.sections.find((one) => one.title.includes("보관 위탁"));
  if (storage) {
    const lines = storage.body.split("\n");
    const at = lines.findIndex((line) =>
      line.startsWith("▸ 개인정보는") && line.includes("보관됩니다")
    );
    if (at < 0) lines.unshift(wording.policy);
    else lines[at] = wording.policy;
    storage.body = lines.join("\n");
  }
  return { form: nextForm, policy: nextPolicy };
}

/** {센터} 를 센터 이름으로 */
export function fillCenter(text: string, center: string): string {
  return text.replaceAll("{센터}", center);
}

/* ---------- 모양 검사 ---------- */

const LIMIT = { short: 200, text: 3000, sections: 20, rows: 12, signs: 6 };

function isText(value: unknown, max: number, allowEmpty = true): value is string {
  return typeof value === "string" && value.length <= max && (allowEmpty || value.trim() !== "");
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function checkCenterName(value: unknown): string | null {
  if (!isText(value, 60, false)) return "센터 이름을 1~60자로 적어 주세요.";
  return null;
}

export function checkConsentForm(value: unknown): string | null {
  if (!isPlain(value)) return "동의서 문구 모양이 올바르지 않습니다.";
  if (!isText(value.title, LIMIT.short, false)) return "동의서 제목을 적어 주세요(200자 이내).";
  for (const key of ["intro", "notes", "confirm"] as const) {
    if (!isText(value[key], LIMIT.text)) {
      const name = { intro: "머리말", notes: "말미 안내", confirm: "확인 문장" }[key];
      return `동의서 ${name}은 ${LIMIT.text}자를 넘을 수 없습니다.`;
    }
  }
  if (!isText(value.addressee, LIMIT.short)) return "수신(귀하) 문구는 200자 이내로 적어 주세요.";
  const signs = value.signs;
  if (
    !Array.isArray(signs) || signs.length > LIMIT.signs ||
    !signs.every((one) => isText(one, LIMIT.short))
  ) {
    return `서명란은 ${LIMIT.signs}줄 이내, 줄마다 200자 이내입니다.`;
  }
  const sections = value.sections;
  if (!Array.isArray(sections) || sections.length === 0 || sections.length > LIMIT.sections) {
    return `동의 항목은 1~${LIMIT.sections}개여야 합니다.`;
  }
  for (const [i, section] of sections.entries()) {
    const where = `${i + 1}번째 항목`;
    if (!isPlain(section)) return `${where}의 모양이 올바르지 않습니다.`;
    if (!isText(section.title, LIMIT.short, false)) return `${where}의 제목을 적어 주세요.`;
    if (typeof section.choice !== "boolean") return `${where}의 동의 칸 여부가 올바르지 않습니다.`;
    const problem = checkRows(section.rows, where);
    if (problem) return problem;
  }
  return null;
}

function checkRows(rows: unknown, where: string): string | null {
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > LIMIT.rows) {
    return `${where}의 줄은 1~${LIMIT.rows}개여야 합니다.`;
  }
  for (const row of rows) {
    if (!isPlain(row) || !isText(row.label, LIMIT.short, false) || !isText(row.text, LIMIT.text)) {
      return `${where}의 줄마다 머리(200자 이내)와 본문(${LIMIT.text}자 이내)이 있어야 합니다.`;
    }
  }
  return null;
}

export function checkPrivacyPolicy(value: unknown): string | null {
  if (!isPlain(value)) return "처리방침 문구 모양이 올바르지 않습니다.";
  if (!isText(value.title, LIMIT.short, false)) return "처리방침 제목을 적어 주세요(200자 이내).";
  if (!isText(value.intro, LIMIT.text)) {
    return `처리방침 머리말은 ${LIMIT.text}자를 넘을 수 없습니다.`;
  }
  if (!isText(value.staff_notice, LIMIT.text, false)) return "직원·봉사자 안내 문구를 적어 주세요.";
  if (!isText(value.staff_agree, LIMIT.short, false)) {
    return "동의 체크 문장을 적어 주세요(200자 이내).";
  }
  const sections = value.sections;
  if (!Array.isArray(sections) || sections.length === 0 || sections.length > LIMIT.sections) {
    return `처리방침 절은 1~${LIMIT.sections}개여야 합니다.`;
  }
  for (const [i, section] of sections.entries()) {
    if (
      !isPlain(section) || !isText(section.title, LIMIT.short, false) ||
      !isText(section.body, LIMIT.text)
    ) {
      return `${i + 1}번째 절에 제목(200자 이내)과 본문(${LIMIT.text}자 이내)이 있어야 합니다.`;
    }
  }
  return null;
}

/** 저장값이 망가져 있으면 기본값으로 읽는다(화면이 빈 문서를 그리지 않게) */
export function readConsentForm(value: unknown): ConsentForm {
  return checkConsentForm(value) === null ? value as ConsentForm : DEFAULT_CONSENT_FORM;
}

export function readPrivacyPolicy(value: unknown): PrivacyPolicy {
  return checkPrivacyPolicy(value) === null ? value as PrivacyPolicy : DEFAULT_PRIVACY_POLICY;
}

export function readCenterName(value: unknown): string {
  return checkCenterName(value) === null ? (value as string).trim() : DEFAULT_CENTER_NAME;
}
