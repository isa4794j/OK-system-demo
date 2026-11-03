/**
 * 센터가 정하는 값 — 화면에서 바꿀 수 있는 설정
 *
 *   GET /api/settings/:key
 *   PUT /api/settings/:key   { value }
 *
 * [아무 열쇠나 못 바꾼다]
 * settings 표에는 화면에서 건드리면 안 되는 줄도 산다(최초 관리자 선점 자물쇠 같은 것).
 * 그래서 여기 적힌 열쇠만 열린다. 목록에 없으면 404 다 —
 * 새 설정을 화면에 열 때 이 표에 한 줄을 더하는 것이 그 결정을 남기는 자리다.
 *
 * [값 모양도 여기서 지킨다]
 * 아무 것이나 담기면 그 값을 읽는 화면이 뜻 없는 것을 그린다.
 * 열쇠마다 어떤 모양이어야 하는지, 이전 값과 견줘 무엇을 지켜야 하는지 함께 적어 둔다.
 *
 * [누가 바꿀 수 있나는 정책표가 정한다]
 * 여기서는 등급을 보지 않는다. half_observation_items 가 관리자만인 것도 api/policy.ts 에 있다.
 *
 * 바꾼 것은 감사 로그에 이전 값·새 값째 남는다(원칙 8).
 * 이 파일은 Supabase 를 직접 부르지 않는다. /db 만 쓴다.
 */
import { NotFoundError, RuleError } from "../db/client.ts";
import { getSetting, saveSetting } from "../db/settings.ts";
import { HALF_OBSERVATION_ENABLED } from "../lib/features.ts";
import { recordAudit } from "../db/audit.ts";
import { isHalfOpenMap } from "../lib/half.ts";
import { checkItemEdit, type HalfItem, readItems } from "../lib/half_items.ts";
import { checkAreaEdit, DEFAULT_OBS_AREAS, OBS_AREAS_KEY, readAreas } from "../lib/obs_areas.ts";
import {
  CENTER_NAME_KEY,
  checkCenterName,
  checkConsentForm,
  checkPrivacyPolicy,
  CONSENT_FORM_KEY,
  DEFAULT_CENTER_NAME,
  DEFAULT_CONSENT_FORM,
  DEFAULT_PRIVACY_POLICY,
  PRIVACY_POLICY_KEY,
} from "../lib/documents.ts";

const JSON_HEADERS = { "cache-control": "no-store" };

type Rule = {
  /** 값이 없을 때 이 값으로 읽힌다. 코드의 기본값과 같아야 한다. */
  fallback: unknown;
  /** 고르는 값이면 그 목록. 화면이 이 목록으로 버튼을 만든다. */
  choices?: string[];
  /** 감사 로그에 적는 이름 */
  label: string;
  /** 받은 값이 쓸 만한지 본다. 이전 값과 견줘야 하는 규칙도 여기서. */
  check: (value: unknown, before: unknown) => string | null;
};

/**
 * 화면에서 바꿀 수 있는 설정.
 *
 * child_delete_by_staff — 종사자도 아동을 지울 수 있는가.
 *   기본은 꺼짐(센터장 이상만). 아동 삭제는 딸린 관찰·평가가 한꺼번에 사라지는 일이다.
 *   이 열쇠를 바꾸는 것도 센터장 이상(정책표), 바꾼 것은 감사 로그에 전후 값째 남는다.
 *   사람별로 허용하는 것은 아직 없다 — 센터 전체에 하나다.
 *
 * volunteer_journal_scope — 봉사자가 서로의 일지를 볼 수 있는가.
 *   기본은 '전체'. 격주로 오는 사람이 지난주에 무슨 일이 있었는지 알아야 한다.
 *
 * half_observation_open — 반기별로 관찰을 쓸 수 있는가.
 *   적혀 있지 않은 반기는 "이번 반기면 열림" 으로 읽는다(lib/half.ts).
 *
 * half_observation_items — 반기 관찰 항목. 평가지표라 관리자만 바꾼다(정책표).
 *   있던 코드는 지울 수 없고(deleted 로만), 만점도 못 바꾼다(lib/half_items.ts).
 *
 * observation_areas — 관찰 영역(건강·학습·…). 관리자만 바꾼다(정책표).
 *   코드는 불변, 지워도 deleted 로 남는다(lib/obs_areas.ts). 이름은 고칠 수 있다.
 *
 * consent_form · privacy_policy · center_name — 동의서·처리방침·센터 이름(③단계).
 *   업체·인프라 이름이 이 글 안에만 있게 한다 — 바뀌면 코드가 아니라 글을 고친다(lib/documents.ts).
 *   바꾸는 것은 센터장 이상(정책표 기본 규칙), 바꾼 것은 감사 로그에 전후 글째 남는다.
 */
const ALLOWED: Record<string, Rule> = {
  child_delete_by_staff: {
    // 기본은 꺼짐 — 아동과 딸린 기록이 한꺼번에 사라지는 일은 센터장 이상이 한다.
    // 켜면 종사자도 지울 수 있다. 판단은 서버가 한다(api/children.ts canDeleteChild).
    fallback: false,
    label: "종사자 아동 삭제 허용",
    check: (value) => typeof value === "boolean" ? null : "켜기 또는 끄기여야 합니다.",
  },
  volunteer_journal_scope: {
    fallback: "전체",
    choices: ["본인", "전체"],
    label: "봉사일지 공유 범위",
    check: (value) =>
      value === "본인" || value === "전체" ? null : "본인 또는 전체 중에서 골라 주세요.",
  },
  half_observation_open: {
    fallback: {},
    label: "반기 관찰 열림·닫힘",
    check: (value) => isHalfOpenMap(value) ? null : "반기별 열림·닫힘 값이 올바르지 않습니다.",
  },
  half_observation_items: {
    fallback: [],
    label: "반기 관찰 항목",
    check: (value, before) => checkItemEdit(readItems(before), value as HalfItem[]),
  },
  [OBS_AREAS_KEY]: {
    fallback: DEFAULT_OBS_AREAS,
    label: "관찰 영역",
    check: (value, before) => checkAreaEdit(readAreas(before), value),
  },
  [CONSENT_FORM_KEY]: {
    fallback: DEFAULT_CONSENT_FORM,
    label: "동의서 문구",
    check: (value) => checkConsentForm(value),
  },
  [PRIVACY_POLICY_KEY]: {
    fallback: DEFAULT_PRIVACY_POLICY,
    label: "개인정보 처리방침 문구",
    check: (value) => checkPrivacyPolicy(value),
  },
  [CENTER_NAME_KEY]: {
    fallback: DEFAULT_CENTER_NAME,
    label: "센터 이름",
    check: (value) => checkCenterName(value),
  },
};

function ok(body: unknown): Response {
  return Response.json(body, { headers: JSON_HEADERS });
}

function fail(status: number, message: string): Response {
  return Response.json({ error: message }, { status, headers: JSON_HEADERS });
}

function notFound(): Response {
  return fail(404, "화면에서 바꿀 수 있는 설정이 아닙니다.");
}

function serverError(where: string, error: unknown): Response {
  // 없는 대상은 404, 규칙에 어긋난 요청(없는 사람을 가리킴 등)은 400 — 사람이 읽을 말 그대로(db/client.ts)
  if (error instanceof NotFoundError) {
    return Response.json({ error: error.message }, { status: 404, headers: JSON_HEADERS });
  }
  if (error instanceof RuleError) {
    return Response.json({ error: error.message }, { status: 400, headers: JSON_HEADERS });
  }
  console.error(`[${where}]`, error);
  return fail(500, "요청을 처리하지 못했습니다.");
}

/** 반기별 관찰을 숨긴 동안(lib/features.ts) 그 두 열쇠는 없는 것처럼 — 값은 settings 에 그대로 */
function ruleOf(key: string): Rule | undefined {
  if (!HALF_OBSERVATION_ENABLED && key.startsWith("half_observation_")) return undefined;
  return ALLOWED[key];
}

export async function handleSettingGet(key: string): Promise<Response> {
  const rule = ruleOf(key);
  if (!rule) return notFound();

  try {
    const value = await getSetting<unknown>(key, rule.fallback);
    // default — 문구 편집 화면의 [기본 문구로 되돌리기] 가 쓴다
    return ok({ key, value, choices: rule.choices, default: rule.fallback });
  } catch (error) {
    return serverError("GET /api/settings/:key", error);
  }
}

export async function handleSettingSave(req: Request, key: string): Promise<Response> {
  const rule = ruleOf(key);
  if (!rule) return notFound();

  let value: unknown;
  try {
    value = (await req.json())?.value;
  } catch {
    return fail(400, "요청 본문이 JSON이 아닙니다.");
  }

  try {
    const before = await getSetting<unknown>(key, rule.fallback);

    const problem = rule.check(value, before);
    if (problem) return fail(400, problem);

    await saveSetting(key, value);
    await recordAudit({
      action: "update",
      table_name: "settings",
      // settings 의 열쇠는 uuid 가 아니라 record_id 에 못 담는다. 요약에 적는다.
      record_id: null,
      summary: `설정 변경: ${rule.label} (${key})`,
      before,
      after: value,
    });
    return ok({ key, value });
  } catch (error) {
    return serverError("PUT /api/settings/:key", error);
  }
}
