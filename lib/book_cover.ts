/**
 * 책 표지 사진에서 제목·저자·출판사를 읽는다. 한 장에 여러 권이 보이면 여러 줄로.
 *
 * AI 호출은 lib/ai.ts 의 문(callAIWithImage)만 지난다. 여기서 Claude 를 직접 부르지 않는다.
 *
 * [지어내지 않는 것이 이 파일의 전부다]
 * 모델은 아는 책이면 흐릿한 표지에서도 "구름빵 / 백희나 / 한솔수북" 을 자신 있게 적는다.
 * 그게 맞는 날도 있지만 틀리는 날이 있고, 틀린 줄 모르고 등록되면 아무도 안 본다.
 * 그래서 프롬프트가 "보이는 글자만" 을 되풀이해 말하고, 읽은 값은 검색창을 채우는 데만 쓴다.
 * 이 값으로 바로 등록하는 길은 만들지 않는다 — 사람이 [찾아보기]로 확인하고 등록한다.
 *
 * [여러 권도 같은 규칙이다]
 * 한 장에 열 권이 보이면 열 줄이 된다. 그중 흐린 책은 읽히는 칸만 채우고 나머지는 빈 값이다.
 * 빈 줄도 버리지 않고 돌려준다 — 화면이 "읽지 못한 책 N권" 으로 묶어 알린다.
 * 몇 권이 있었는지는 사람이 사진을 보고 아는 것이라, 우리가 줄을 지워 버리면 안 된다.
 *
 * [사진은 남지 않는다]
 * 받은 사진은 이 함수를 지나 AI 로 갔다가 응답과 함께 버려진다.
 * 디스크에도 DB 에도 Supabase storage 에도 쓰지 않는다.
 */
import { callAIWithImage, type ImageType } from "./ai.ts";

export type CoverGuess = {
  title: string;
  author: string;
  publisher: string;
  /** 제목이 일부만 읽혔다(잘림·가림). 화면이 "일부만 읽혔어요" 를 붙인다. 온전하면 칸 자체가 없다. */
  partial?: true;
};

/** 제목은 두 글자 이상일 때만 쓴다 — 한 글자로는 찾기가 되지 않는다 */
const TITLE_MIN = 2;

/** 화면의 칸 길이와 같게 자른다. 더 길면 어차피 들어가지 않는다. */
const TITLE_MAX = 300;
const SHORT_MAX = 200;

/**
 * 받을 상한 — 한 번의 답에서도, 나눠 읽어 합친 뒤에도 같다.
 * 서가 한 칸을 책등으로 찍으면 수십 권이라 80 으로 둔다(처음 40).
 * 이상한 응답이 통째로 화면에 쏟아지는 것을 막는 자리이기도 하다(자원 사진과 같은 뜻).
 */
export const MAX_BOOKS = 80;

const SYSTEM = [
  "당신은 책 표지 사진에 적힌 글자를 그대로 옮겨 적는 일을 합니다.",
  "사진에 보이지 않는 것은 절대 적지 않습니다.",
].join("\n");

const PROMPT = [
  "이 사진에는 책이 한 권 또는 여러 권 보입니다. 앞표지일 수도, 서가에 꽂힌 책등(옆면)일 수도 있습니다.",
  "보이는 책마다 표지나 책등에 적힌 제목·저자·출판사를 옮겨 적어 주세요.",
  "사진이 큰 사진의 한 부분일 수 있습니다 — 가장자리에서 잘린 책은 보이는 글자만 적고 partial 을 붙입니다.",
  "",
  "규칙",
  "- 사진에서 읽을 수 있는 글자만 적습니다.",
  "- 책등(옆면)의 세로 글자도 읽습니다. 세로쓰기 제목은 위에서 아래로 읽어 한 줄로 적습니다.",
  "  책등이 돌아가 있어 글자가 옆으로 누워 있으면 고개를 돌려 읽듯 원래 방향대로 적습니다.",
  "- 서가에 꽂힌 책은 왼쪽에서 오른쪽, 위 칸에서 아래 칸 순서로 적습니다.",
  '- 아는 책이라도 기억으로 채우지 마세요. 표지에 안 보이면 빈 문자열("")입니다.',
  "- 읽히는 부분까지만이라도 적습니다. 제목이 잘리거나 가려져 일부만 보이면 보이는 글자만 적고",
  '  "partial": true 를 붙입니다. 전부 읽을 수 없다고 통째로 포기하지 마세요.',
  "- 보이지 않는 부분을 짐작해서 채우지 마세요. 확실히 읽은 글자만 적습니다.",
  "- 한 권에서 제목만 읽히면 제목만, 저자만 읽히면 저자만 적고 나머지는 빈 문자열로 둡니다.",
  "- 표지가 보이지만 글자를 하나도 못 읽겠으면 세 칸 모두 빈 문자열인 줄로 남깁니다.",
  "  (그 책이 거기 있었다는 사실은 사람이 알아야 합니다)",
  "- '없음', '미상', '알 수 없음' 같은 말 대신 빈 문자열을 씁니다.",
  "- 부제가 있으면 제목에 함께 적습니다. 옮긴이·그린이는 저자에 적지 않습니다.",
  "- 책이 하나도 없으면 빈 배열([])을 출력합니다.",
  "- 사람이 함께 찍혔더라도 사람에 대해서는 아무것도 적지 마세요.",
  "",
  "JSON 배열만 출력하세요. 설명, 머리말, 코드펜스 없이 배열만 씁니다.",
  '[{"title": "...", "author": "...", "publisher": "...", "partial": false}]',
].join("\n");

/** 모델이 빈 값 대신 쓰곤 하는 말. 이런 것이 검색창에 채워지면 찾기가 어긋난다. */
const EMPTY_WORDS = ["없음", "미상", "불명", "알 수 없음", "확인 불가", "n/a", "unknown", "-"];

function clean(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (!text) return "";
  if (EMPTY_WORDS.includes(text.toLowerCase())) return "";
  return text.slice(0, max);
}

function toGuess(row: Record<string, unknown>): CoverGuess {
  const rawTitle = clean(row.title, TITLE_MAX);
  const title = [...rawTitle].length >= TITLE_MIN ? rawTitle : "";
  const guess: CoverGuess = {
    title,
    author: clean(row.author, SHORT_MAX),
    publisher: clean(row.publisher, SHORT_MAX),
  };
  // 일부만 읽힌 제목 — 남은 제목이 있을 때만 알린다
  if (row.partial === true && title) guess.partial = true;
  return guess;
}

/** 코드펜스나 머리말이 붙어도 괄호 안쪽만 꺼낸다. 모양이 아니면 null. */
function sliceJson(reply: string, open: string, close: string): unknown {
  const start = reply.indexOf(open);
  const end = reply.lastIndexOf(close);
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(reply.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * 모델 응답에서 책 줄들을 꺼낸다.
 *
 * 모양이 아니면 null 이다 — 빈 목록과 갈라야 한다.
 *   []     사진에 책이 없었다 → 사람에게 "못 읽었어요"
 *   null   모델이 JSON 아닌 말을 했거나 답이 잘렸다 → readBookCovers 가 둘을 가른다(못 읽음 / 잘림)
 *
 * 한 권일 때 모델이 배열 대신 객체로 답하는 일이 있어 그것도 받는다.
 * 프롬프트는 배열을 달라고 하지만, 한 줄 때문에 통째로 실패할 이유는 없다.
 */
export function parseCovers(reply: string): CoverGuess[] | null {
  /*
   * 배열로 답했는지 객체로 답했는지는 먼저 나오는 괄호로 가른다.
   *
   * 값 안에 대괄호가 들어 있는 객체(예: 출판사 "성지[출판]")를 배열로 보면 안 되고,
   * 반대로 잘린 배열(`[{"title":"구름빵"}` 에서 끝남)을 객체로 봐서도 안 된다.
   * 뒤엣것을 객체로 읽으면 첫 권만 건져 놓고 "이게 전부" 인 것처럼 돌려주게 된다 —
   * 사진에 열 권이 있었는데 한 권만 보이고, 아무도 잘렸다는 것을 모른다.
   */
  const firstBracket = reply.indexOf("[");
  const firstBrace = reply.indexOf("{");
  const looksArray = firstBracket >= 0 && (firstBrace < 0 || firstBracket < firstBrace);

  if (looksArray) {
    const asArray = sliceJson(reply, "[", "]");
    if (!Array.isArray(asArray)) return null; // 배열로 시작해 놓고 안 닫혔다 = 잘림
    return asArray
      .filter((one): one is Record<string, unknown> => !!one && typeof one === "object")
      .slice(0, MAX_BOOKS)
      .map(toGuess);
  }

  const asObject = sliceJson(reply, "{", "}");
  if (asObject && typeof asObject === "object" && !Array.isArray(asObject)) {
    return [toGuess(asObject as Record<string, unknown>)];
  }
  return null;
}

/**
 * 표지 사진 한 장 → 책마다 한 줄. 사진에 책이 없으면 빈 배열.
 *
 * AI 가 정상으로 답했는데 목록 모양이 아니면 "못 읽음"(빈 배열)이다 — 화면이 제목 검색 길을 연다.
 * 답이 길이에서 잘렸으면(max_tokens) 던진다 — 다시 누르면 되는 고장이다.
 * AI 연결·서버 실패는 게이트웨이의 AIServiceError 가 그대로 올라간다(화면은 "일시적인 문제").
 */
export async function readBookCovers(
  imageBase64: string,
  mimeType: ImageType,
): Promise<CoverGuess[]> {
  const { text: reply, stopReason } = await callAIWithImage(PROMPT, imageBase64, mimeType, {
    system: SYSTEM,
    /*
     * 넉넉히 준다.
     *
     * 처음에 500 으로 뒀다가 답이 `{"title": "` 열한 자에서 잘렸다. max_tokens 는
     * "보이는 답" 이 아니라 그 호출이 쓰는 토큰 전부를 덮기 때문이다.
     * 이제는 한 장에 수십 권이 나올 수 있어 더 필요하다 — 사진에서 목록을 받아 오는
     * 쪽(recognize_resources)과 같은 급으로 둔다. 잘리면 게이트웨이가 경고를 남긴다.
     * 상한을 40 → 80 권으로 올리며 4000 → 8000 으로 같이 올렸다(한 권에 50~80 토큰).
     */
    maxTokens: 8000,
  });

  const covers = parseCovers(reply);
  if (!covers && stopReason !== "max_tokens") {
    // AI 는 정상으로 답했는데 목록 모양이 아니다 — 대개 "읽을 수 없습니다" 같은 말이다.
    // 고장이 아니라 "못 읽음" 이다: 빈 목록으로 돌려 화면이 [제목으로 검색] 길을 연다.
    console.warn(
      `[book_cover] 목록 모양이 아닌 답 — 못 읽음으로 처리 (길이 ${reply.length}, 앞 120자: ${
        reply.slice(0, 120)
      })`,
    );
    return [];
  }
  if (!covers) {
    // 왜 못 읽었는지가 다음 사람에게 남아야 한다. 잘린 것인지(max_tokens),
    // 모델이 딴말을 한 것인지는 stop_reason 과 앞부분을 봐야 갈린다.
    // 표지에서 읽은 글자라 아동 정보는 아니지만, 로그는 오래 남으므로 앞 200자까지만.
    console.error(
      `[book_cover] 응답이 JSON 모양이 아님 — stop_reason=${stopReason ?? "없음"} ` +
        `길이 ${reply.length}\n원문(앞 200자): ${reply.slice(0, 200)}`,
    );
    throw new Error("AI 응답이 중간에 끊겼습니다. 다시 시도해 주세요.");
  }
  return covers;
}

/* ---------- 나눠 읽은 것 합치기 ---------- */

/** 제목 맞대기용 — 띄어쓰기·문장부호·대소문자·전각을 지운다 */
export function normalizeTitle(title: string): string {
  return title.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}

/** 둘 중 더 많이 읽힌 줄 — 온전한 제목, 채워진 칸 수, 긴 제목 순 */
function better(a: CoverGuess, b: CoverGuess): CoverGuess {
  const score = (one: CoverGuess) =>
    (one.partial ? 0 : 1000) + (one.author ? 100 : 0) + (one.publisher ? 100 : 0) +
    [...one.title].length;
  return score(b) > score(a) ? b : a;
}

/**
 * 사진을 나눠 읽은 결과를 합친다(겹친 띠에 걸린 책은 양쪽에 나온다).
 *
 * - 정규화한 제목이 같으면 한 줄로 접는다(더 많이 읽힌 쪽을 남긴다).
 * - 한쪽이 일부만 읽혔고 그 제목이 다른 쪽 제목의 앞부분이면 같은 책으로 본다.
 * - 제목을 못 읽은 줄은 접지 않는다 — 같은 책인지 알 길이 없고, 몇 권이었는지는 사람이 사진으로 본다.
 * 순서는 앞 조각부터(왼쪽→오른쪽). 합친 뒤에도 MAX_BOOKS 까지만.
 */
export function mergeCovers(lists: CoverGuess[][]): CoverGuess[] {
  const merged: CoverGuess[] = [];
  const keys: string[] = [];
  for (const list of lists) {
    for (const one of list) {
      const key = one.title ? normalizeTitle(one.title) : "";
      const at = !key ? -1 : keys.findIndex((other, i) => {
        if (!other) return false;
        if (other === key) return true;
        // 일부만 읽힌 쪽의 제목이 다른 쪽 제목의 앞부분이면 같은 책
        if (one.partial && [...key].length >= 2 && other.startsWith(key)) return true;
        return !!merged[i].partial && [...other].length >= 2 && key.startsWith(other);
      });
      if (at < 0) {
        merged.push(one);
        keys.push(key);
      } else {
        merged[at] = better(merged[at], one);
        keys[at] = normalizeTitle(merged[at].title);
      }
    }
  }
  return merged.slice(0, MAX_BOOKS);
}

/**
 * 나눠 찍은 조각 여러 장 → 조각마다 읽고 합친다. 조각 하나면 그냥 읽기와 같다.
 * AI 호출은 조각 수만큼(화면은 최대 2장을 보낸다).
 */
export async function readBookCoverParts(
  parts: { image: string; mimeType: ImageType }[],
): Promise<CoverGuess[]> {
  const lists = await Promise.all(parts.map((one) => readBookCovers(one.image, one.mimeType)));
  return lists.length === 1 ? lists[0] : mergeCovers(lists);
}
