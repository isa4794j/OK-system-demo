/**
 * Claude API 게이트웨이 — AI로 나가는 유일한 문.
 *
 * 이 파일만 지키면 되도록 두 가지를 여기에 가둬 둔다.
 *   1. ANTHROPIC_API_KEY 를 읽는 곳은 여기뿐이다.
 *   2. Claude API 를 부르는 곳도 여기뿐이다.
 * 다른 파일에서 위 둘을 하면 규칙을 어긴 것이다.
 * (나중에 저장소를 훑어 강제하는 테스트를 붙일 수 있게 한곳에 모았다)
 *
 * 가장 중요한 것: 사람 이름이 이 문을 그냥 통과하지 못하게 한다.
 * callAISafe()가 가명화를 강제한다. 아래 [두 개의 문] 참고.
 */
import Anthropic from "@anthropic-ai/sdk";
import { assertNoLeak, hide, type MaskMap, type RegisteredPerson, show } from "./anonymize.ts";

/* ---------- 설정 ---------- */

/**
 * 쓰는 모델. 바꾸기 쉽게 여기 한 줄로 둔다.
 * 값은 Anthropic 이 정한 정확한 문자열이어야 한다. 날짜를 붙이면 안 된다.
 */
export const MODEL = "claude-opus-5";

/** 답변 길이 상한. 요약 정도면 넉넉하다. */
const MAX_TOKENS = 16_000;

/** 한 번의 호출을 기다리는 시간. 넘으면 끊고 알린다(SDK 가 두 번 더 재시도한다). */
const TIMEOUT_MS = 120_000;

/**
 * 안전 분류기가 요청을 거절했을 때 다른 모델로 이어받게 한다.
 * 거절만으로 기능이 통째로 멈추지 않게 하려는 것.
 * 이 베타를 아직 못 쓰는 계정이면 아래에서 자동으로 빼고 다시 시도한다.
 */
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/* ---------- 클라이언트 ---------- */

let cached: Anthropic | null = null;
let fallbackSupported = true;

/**
 * 환경변수에서 키를 읽어 클라이언트를 만든다. 최초 1회만.
 *
 * 이 프로젝트에서 ANTHROPIC_API_KEY 를 읽는 유일한 자리다.
 */
function getClient(): Anthropic {
  if (cached) return cached;

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY")?.trim();
  if (!apiKey) {
    // 무엇을 고칠지는 서버 로그에만 — 화면에는 사람이 할 일만
    console.error("[ai] 환경변수 ANTHROPIC_API_KEY 가 비어 있습니다(.env 또는 배포 환경변수).");
    throw new AIServiceError(MESSAGES.config, "config");
  }

  cached = new Anthropic({ apiKey, timeout: TIMEOUT_MS });
  return cached;
}

/**
 * 키가 들어 있는가. 시스템 점검 화면이 쓴다.
 *
 * 값은 돌려주지 않는다 — 있다/없다만. 이 키를 읽는 곳은 이 파일 하나다(원칙 3).
 * 키가 "맞는지" 는 보지 않는다. 그걸 보려면 AI 를 한 번 불러야 하고, 점검 한 번에
 * 크레딧을 쓸 이유가 없다.
 */
export function hasAnthropicKey(): boolean {
  return Boolean(Deno.env.get("ANTHROPIC_API_KEY")?.trim());
}

/* ---------- 응답에서 글자만 꺼내기 ---------- */

// deno-lint-ignore no-explicit-any
function textOf(message: any): string {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  return blocks
    // deno-lint-ignore no-explicit-any
    .filter((block: any) => block?.type === "text")
    // deno-lint-ignore no-explicit-any
    .map((block: any) => String(block.text ?? ""))
    .join("")
    .trim();
}

/* ---------- 오류를 사람이 읽을 수 있게 ---------- */

/**
 * AI 쪽(설정·서버·연결) 때문에 못 한 것. 사진이나 글 탓이 아니다.
 * 화면은 이 종류를 보고 "다른 사진으로" 같은 엉뚱한 안내를 하지 않는다(api 가 ai_service 로 알린다).
 */
export type AIFailureKind =
  | "config"
  | "credit"
  | "busy"
  | "server"
  | "timeout"
  | "network"
  | "request";

export class AIServiceError extends Error {
  constructor(message: string, readonly kind: AIFailureKind) {
    super(message);
    this.name = "AIServiceError";
  }
}

/**
 * 화면에 보일 문장 — 사회복지사가 할 수 있는 일만 적는다.
 * 환경변수 이름·HTTP 원문·JSON 은 넣지 않는다(서버 로그에 남긴다).
 * "…실패했습니다" 로 끝내지 않는다 — 화면이 "관찰 분석에 실패했습니다." 를 앞에 붙인다.
 */
export const MESSAGES: Record<AIFailureKind, string> = {
  config: "AI 연결 설정에 문제가 있습니다. 관리자에게 알려 주세요.",
  credit: "AI 사용량(크레딧)이 모자랍니다. 관리자에게 알려 주세요.",
  busy: "AI 서버가 붐빕니다. 잠시 후 다시 시도해 주세요.",
  server: "AI 서버에 일시적인 문제가 있습니다. 잠시 후 다시 시도해 주세요.",
  timeout: "AI 응답이 너무 늦어 멈췄습니다. 잠시 후 다시 시도해 주세요.",
  network: "AI 서버에 연결하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.",
  request: "AI 가 이 요청을 처리하지 못했습니다. 계속되면 관리자에게 알려 주세요.",
};

function kindOf(error: unknown): AIFailureKind {
  if (error instanceof Anthropic.AuthenticationError) return "config";
  if (error instanceof Anthropic.PermissionDeniedError) return "config";
  if (error instanceof Anthropic.RateLimitError) return "busy";
  if (error instanceof Anthropic.APIConnectionTimeoutError) return "timeout";
  if (error instanceof Anthropic.APIConnectionError) return "network";
  if (error instanceof Anthropic.BadRequestError) {
    // 크레딧 부족도 400으로 온다. 요청을 고쳐도 해결되지 않는다.
    return /credit balance/i.test(error.message) ? "credit" : "request";
  }
  if (error instanceof Anthropic.APIError) {
    const status = Number(error.status);
    if (status === 529 || status === 503) return "busy";
    if (status >= 500) return "server";
  }
  return "request";
}

/** 사람이 읽을 오류로 바꾸고, 고칠 때 필요한 원문은 서버 로그에 남긴다(키 값은 원문에 없다). */
export function describeAIError(error: unknown): AIServiceError {
  const kind = kindOf(error);
  const status = error instanceof Anthropic.APIError ? error.status : "-";
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`[ai] 호출 실패 — ${kind} (HTTP ${status}): ${detail.slice(0, 500)}`);
  return new AIServiceError(MESSAGES[kind], kind);
}

/* ---------- 두 개의 문 ---------- */

export type AskOptions = {
  /** 모델에게 주는 역할 지시 */
  system?: string;
  /** 답변 길이 상한 */
  maxTokens?: number;
};

/**
 * [문 1] 가명화 없이 그냥 보낸다.
 *
 * ⚠️ 사람 이름이 들어갈 수 있는 글에는 절대 쓰지 마라.
 *    아동·직원 이름이 나올 수 있는 곳(일지, 관찰, 상담 기록 등)은
 *    반드시 callAISafe() 를 써야 한다.
 *    이 함수는 사람이 등장하지 않는 글(자원 목록 정리, 문구 다듬기 등)에만 쓴다.
 */
export async function callAI(prompt: string, options: AskOptions = {}): Promise<string> {
  const text = prompt?.trim();
  if (!text) throw new Error("보낼 내용이 비어 있습니다.");
  return await send(text, options);
}

/** 사진에 붙일 수 있는 형식. Claude API 가 받는 것과 같다. */
export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];

/** 형식마다 파일 맨 앞 몇 바이트(서명) */
const IMAGE_SIGNATURES: Record<ImageType, (head: Uint8Array) => boolean> = {
  "image/jpeg": (h) => h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff,
  "image/png": (h) => h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4e && h[3] === 0x47,
  "image/gif": (h) => h[0] === 0x47 && h[1] === 0x49 && h[2] === 0x46 && h[3] === 0x38,
  "image/webp": (h) =>
    h[0] === 0x52 && h[1] === 0x49 && h[2] === 0x46 && h[3] === 0x46 &&
    h[8] === 0x57 && h[9] === 0x45 && h[10] === 0x42 && h[11] === 0x50,
};

/**
 * 보낼 사진이 정말 그 형식의 base64 인가. 아니면 사람이 읽을 말, 맞으면 null.
 *
 * AI 를 부르기 전에 본다 — 깨진 값을 보내면 API 가 거절할 뿐인데도 호출 한 번이 나간다
 * (1차 전수 점검 2026-09-17). 전부 풀지 않고 앞부분만 풀어 서명을 본다.
 */
export function checkImageData(imageBase64: string, mimeType: ImageType): string | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(imageBase64) || imageBase64.length % 4 !== 0) {
    return "사진 데이터가 올바르지 않습니다. 사진을 다시 골라 주세요.";
  }
  let head: Uint8Array;
  try {
    head = Uint8Array.from(atob(imageBase64.slice(0, 16)), (ch) => ch.charCodeAt(0));
  } catch {
    return "사진 데이터가 올바르지 않습니다. 사진을 다시 골라 주세요.";
  }
  if (head.length < 12 || !IMAGE_SIGNATURES[mimeType](head)) {
    return "사진 형식이 알려 준 것과 다릅니다. JPEG·PNG 로 다시 올려 주세요.";
  }
  return null;
}

/**
 * [문 1-사진] 사진 한 장과 글을 함께 보낸다. 가명화는 거치지 않는다.
 *
 * 사진에는 등록된 이름을 코드로 바꿀 방법이 없다. 그래서 이 문은
 * 사람이 찍히지 않은 사진(책장, 선반, 물건)에만 쓴다.
 * 그 판단은 부르는 쪽과 화면의 안내문이 맡는다 — 여기서는 막을 수 없다.
 *
 * 사진은 보내고 버린다. 저장하지 않는다.
 *
 * 답과 함께 stopReason 을 돌려준다. 사진에서 JSON 을 받아 오는 자리들은
 * 답이 잘리면 "읽을 수 없는 글" 이 되는데, 왜 잘렸는지는 이 값에만 있다.
 * ("max_tokens" 면 길이에서 잘린 것이다)
 */
export async function callAIWithImage(
  prompt: string,
  imageBase64: string,
  mimeType: ImageType,
  options: AskOptions = {},
): Promise<{ text: string; stopReason: string | null }> {
  const text = prompt?.trim();
  if (!text) throw new Error("보낼 내용이 비어 있습니다.");
  if (!imageBase64) throw new Error("사진이 비어 있습니다.");
  if (!(IMAGE_TYPES as readonly string[]).includes(mimeType)) {
    throw new Error(`지원하지 않는 사진 형식입니다: ${mimeType}`);
  }
  const broken = checkImageData(imageBase64, mimeType);
  if (broken) throw new Error(broken);

  return await sendDetailed(
    [
      { type: "image", source: { type: "base64", media_type: mimeType, data: imageBase64 } },
      { type: "text", text },
    ],
    options,
  );
}

/**
 * 실제로 부르는 곳. 글이든 사진이든 여기를 지난다.
 * 폴백 베타, 거절 처리, 오류 번역이 한 벌만 있어야 하므로 한 함수에 둔다.
 */
// deno-lint-ignore no-explicit-any
async function send(content: string | any[], options: AskOptions): Promise<string> {
  return (await sendDetailed(content, options)).text;
}

/**
 * 답과 함께 "왜 끝났는지" 까지 돌려준다.
 *
 * stop_reason 이 "max_tokens" 면 답이 길이에서 잘린 것이다. 잘린 JSON 은
 * 파싱에 실패하고, 그러면 부르는 쪽에서는 "AI 가 이상한 답을 했다" 로만 보인다.
 * 실제로는 우리가 max_tokens 를 너무 짜게 준 것이다 — 그 구분이 로그에 남아야 한다.
 */
async function sendDetailed(
  // deno-lint-ignore no-explicit-any
  content: string | any[],
  options: AskOptions,
): Promise<{ text: string; stopReason: string | null }> {
  const client = getClient();

  const request = {
    model: MODEL,
    max_tokens: options.maxTokens ?? MAX_TOKENS,
    ...(options.system ? { system: options.system } : {}),
    messages: [{ role: "user" as const, content }],
  };

  try {
    // deno-lint-ignore no-explicit-any
    let message: any;

    if (fallbackSupported) {
      try {
        message = await client.beta.messages.create({
          ...request,
          betas: [FALLBACK_BETA],
          fallbacks: "default",
          // deno-lint-ignore no-explicit-any
        } as any);
      } catch (error) {
        // 이 베타를 아직 못 쓰는 계정이면 한 번만 빼고 다시 시도하고,
        // 그 뒤로는 계속 없이 간다.
        //
        // 400이라고 다 베타 문제는 아니다. 크레딧 부족·잘못된 요청도 400으로 온다.
        // 폴백을 말하는 400일 때만 꺼야, 엉뚱한 이유로 기능이 조용히 사라지지 않는다.
        const isBetaRejection = error instanceof Anthropic.BadRequestError &&
          /fallback|beta/i.test(error.message);
        if (!isBetaRejection) throw error;

        fallbackSupported = false;
        console.warn("[ai] 서버측 폴백을 쓸 수 없어 끄고 진행합니다:", error.message);
        message = await client.messages.create(request);
      }
    } else {
      message = await client.messages.create(request);
    }

    // 안전 분류기가 끝내 거절한 경우. content 를 읽기 전에 먼저 본다.
    if (message.stop_reason === "refusal") {
      throw new Error(
        "AI가 이 요청에 답하기를 거부했습니다" +
          (message.stop_details?.category ? ` (${message.stop_details.category})` : "") +
          ". 내용을 바꿔 다시 시도해 보세요.",
      );
    }

    const stopReason = (message.stop_reason as string | null) ?? null;

    // 길이에서 잘린 것은 부르는 쪽이 아니라 우리가 고칠 일이다. 어느 자리든 보이게 남긴다.
    if (stopReason === "max_tokens") {
      console.warn(
        `[ai] 답이 길이에서 잘렸습니다 (max_tokens=${request.max_tokens}). ` +
          "부르는 쪽의 maxTokens 를 늘려야 합니다.",
      );
    }

    const answer = textOf(message);
    if (!answer) {
      // 길이가 너무 짧으면 글자가 한 자도 안 오기도 한다 — 보이는 답 앞에서 다 쓰인다.
      // 그때 "빈 응답" 이라고만 하면 왜 비었는지 알 수 없다.
      throw new Error(
        stopReason === "max_tokens"
          ? "AI 답이 길이 제한에서 끊겨 내용이 오지 않았습니다. 잠시 후 다시 시도해 주세요."
          : "AI가 빈 응답을 보냈습니다.",
      );
    }
    return { text: answer, stopReason };
  } catch (error) {
    // 우리가 위에서 만든 메시지는 그대로 올려보낸다
    if (error instanceof Error && !(error instanceof Anthropic.APIError)) throw error;
    throw describeAIError(error);
  }
}

/**
 * 가려진 글에 코드가 섞여 있다는 것을 모델에게 알린다.
 * 이 말이 없으면 모델이 "아동1"을 "그 아이"처럼 바꿔 써서 복원이 어긋난다.
 */
const CODE_RULE = [
  "이 글에서 사람은 실명 대신 【 】로 감싼 토큰으로 적혀 있습니다.",
  "(예: 【아동1】, 【아동2】, 【멘토1】, 【봉사자1】, 【센터장1】, 【생활복지사1】)",
  "토큰은 괄호까지 한 덩어리입니다. 글자 하나도 바꾸지 말고 그대로 옮겨 쓰세요.",
  "번호를 바꾸거나, 없던 토큰을 새로 만들거나, 사람 이름을 지어내지 마세요.",
  "토큰 대신 '그 아이', '이 학생' 같은 말로 바꿔 쓰지 마세요. 누구인지 알 수 없게 됩니다.",
].join("\n");

export type SafeResult = {
  /** 실명으로 되돌린 최종 답변. 보통 이것만 쓰면 된다. */
  text: string;
  /** 실제로 AI에 보낸 글 (실명이 코드로 바뀐 상태) */
  masked: string;
  /** AI가 돌려준 글 (아직 코드 상태) */
  maskedReply: string;
  /**
   * 코드↔사람 매핑.
   *
   * 답변에서 "아동1"이 누구인지(id) 알아내야 할 때 쓴다.
   * 복원된 text 만으로는 동명이인을 가릴 수 없으므로,
   * 사람을 id로 이어 붙여야 하는 쪽은 이 map 과 maskedReply 를 같이 봐야 한다.
   */
  map: MaskMap;
};

/**
 * [문 2] 가명화를 강제하고 보낸다. 사람이 나오는 글은 전부 이 문으로.
 *
 *   1. hide()로 등록된 이름을 코드로 바꾼다
 *   2. assertNoLeak()으로 실명이 남았는지 확인한다 — 남으면 던져서 호출 자체를 막는다
 *   3. 가려진 글만 Claude에 보낸다
 *   4. 답변의 코드를 show()로 실명으로 되돌린다
 *
 * 2번이 핵심이다. 실명이 하나라도 남아 있으면 네트워크로 나가지 않는다.
 */
export async function callAISafe(
  prompt: string,
  people: RegisteredPerson[],
  options: AskOptions = {},
): Promise<SafeResult> {
  const hidden = hide(prompt, people);

  // 실명이 남아 있으면 여기서 던진다. AI 호출은 시작조차 하지 않는다.
  const masked = assertNoLeak(hidden);

  const system = options.system ? `${options.system}\n\n${CODE_RULE}` : CODE_RULE;
  const maskedReply = await callAI(masked, { ...options, system });

  return {
    text: show(maskedReply, hidden.map),
    masked,
    maskedReply,
    map: hidden.map,
  };
}
