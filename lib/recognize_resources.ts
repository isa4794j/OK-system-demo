/**
 * 사진에서 자원 이름을 읽어낸다.
 *
 * 이 파일은 이어 붙이는 일만 한다.
 *   자원사전·카테고리(/db) → AI(게이트웨이, 사진) → 결과 다듬기
 * Supabase도 Claude도 직접 부르지 않는다. 각각 /db 와 lib/ai.ts 를 거친다.
 *
 * [읽기만 하고 저장하지 않는다]
 * 결과는 화면으로 돌아가고, 사람이 체크·수정한 뒤에 등록한다.
 * 사진 속 글자는 흐리거나 반쯤 가려져 있어 AI 가 틀리는 일이 잦다.
 *
 * [사진은 버린다]
 * 서버에 남기지 않는다. 요청 본문에 실려 왔다가 AI 로 가고, 응답이 오면 끝이다.
 *
 * [가명화를 거치지 않는다]
 * 사진에는 이름을 코드로 바꿀 방법이 없다. 사람이 찍힌 사진은 올리지 말라는
 * 안내가 화면에 있고, 그것이 이 기능의 유일한 방어다.
 */
import { parseObjectArray } from "./ai_json.ts";
import { getResourceCategories, listResources, type ResourceItem } from "../db/resources.ts";
import { callAIWithImage, type ImageType } from "./ai.ts";

/** 한 장에서 뽑을 상한. 이상한 응답이 통째로 들어오는 것을 막는다. */
const MAX_ITEMS = 60;
const MAX_DICT = 300;

const SYSTEM = [
  "당신은 지역아동센터의 자원 보관 공간 사진을 보고 자원 이름을 읽어내는 일을 합니다.",
  "사진에 실제로 보이는 것만 씁니다. 짐작으로 목록을 채우지 않습니다.",
].join("\n");

export type RecognizedItem = {
  name: string;
  /** 카테고리 목록 중 하나. 확신이 없으면 null. */
  category: string | null;
  /** 이름을 확실히 읽었는가. 화면은 false 면 체크를 풀어 둔다. */
  confident: boolean;
  /** 이미 사전에 있는가. 우리가 사전과 직접 견줘 정한다. AI 의 말은 참고만. */
  duplicate: boolean;
  /** 사전의 어느 자원과 겹치는지. duplicate 일 때만. */
  duplicate_of: string | null;
};

function dictLine(item: ResourceItem): string {
  const aliases = item.aliases ? ` (별칭: ${item.aliases})` : "";
  return `- ${item.name}${aliases}`;
}

function buildPrompt(dictionary: ResourceItem[], categories: string[]): string {
  const dict = dictionary.length > 0
    ? dictionary.slice(0, MAX_DICT).map(dictLine).join("\n")
    : "(아직 등록된 자원이 없습니다)";

  return [
    "이 사진은 지역아동센터의 자원 보관 공간(책장, 선반, 상자)입니다.",
    "보드게임, 체육용품, 미술재료, 기기 같은 자원이 놓여 있습니다.",
    "알아볼 수 있는 자원 이름을 모두 찾아 주세요.",
    "",
    "규칙",
    "- 상자나 표지에 제품명이 적혀 있으면 그대로 씁니다. 예: 할리갈리, 젠가.",
    "- 글자는 없지만 형태로 확실하면 일반 이름을 씁니다. 예: 축구공, 줄넘기, 훌라후프.",
    "- 이름을 확실히 읽었으면 confident: true, 흐리거나 반쯤 가려져 짐작이면 false.",
    "- 같은 것이 여러 개 있어도 한 번만 적습니다.",
    "- 책과 도서는 제외합니다. 도서는 다른 곳에서 관리합니다.",
    "- 아래 자원사전에 이미 있는 것(별칭 포함)이면 duplicate: true 로 표시하고,",
    "  이름은 사전의 정식 이름으로 씁니다.",
    "- 카테고리는 아래 목록 중에서 고릅니다. 확신이 없으면 빈 문자열로 둡니다.",
    "",
    "--- 자원사전 (이미 등록된 것) ---",
    dict,
    "",
    "--- 카테고리 목록 ---",
    categories.join(", "),
    "",
    "JSON 배열만 출력하세요. 설명, 머리말, 코드펜스 없이 배열만 씁니다.",
    '[{"name": "할리갈리", "category": "보드게임", "confident": true, "duplicate": false}]',
    "알아볼 수 있는 자원이 없으면 [] 만 출력하세요.",
  ].join("\n");
}

/** 모델이 코드펜스나 머리말(대괄호 섞인 것 포함)을 붙여도 배열만 꺼낸다 — lib/ai_json.ts */
export function parseItems(reply: string): Array<Record<string, unknown>> {
  return parseObjectArray(reply, "자원");
}

/**
 * AI 가 돌려준 것을 화면에 보여줄 모양으로 다듬는다.
 *
 * 중복 여부는 우리가 사전과 직접 견줘 정한다. 이름과 별칭을 모두 본다.
 * AI 가 duplicate 라고 해도 사전에 없으면 새 자원이고, 아니라고 해도 있으면 중복이다.
 * 사전은 우리 손에 있고 AI 는 사진만 봤다.
 */
export function toItems(
  raw: Array<Record<string, unknown>>,
  dictionary: ResourceItem[],
  categories: string[],
): RecognizedItem[] {
  // 이름·별칭 → 정식 이름
  const known = new Map<string, string>();
  for (const item of dictionary) {
    known.set(item.name.trim().toLowerCase(), item.name);
    for (const alias of (item.aliases ?? "").split(",")) {
      const key = alias.trim().toLowerCase();
      if (key) known.set(key, item.name);
    }
  }
  const allowed = new Set(categories);
  const seen = new Set<string>();
  const items: RecognizedItem[] = [];

  for (const entry of raw.slice(0, MAX_ITEMS)) {
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!name || name.length > 100) continue;

    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const canonical = known.get(key) ?? null;
    const guess = typeof entry.category === "string" ? entry.category.trim() : "";

    items.push({
      name: canonical ?? name,
      category: allowed.has(guess) ? guess : null,
      confident: entry.confident !== false,
      duplicate: canonical !== null,
      duplicate_of: canonical,
    });
  }

  // 등록할 수 있는 것을 위로, 이미 있는 것을 아래로. 사람이 볼 것부터 보이게.
  items.sort((a, b) => Number(a.duplicate) - Number(b.duplicate));
  return items;
}

export async function recognizeResources(
  imageBase64: string,
  mimeType: ImageType,
): Promise<RecognizedItem[]> {
  const [dictionary, categories] = await Promise.all([
    listResources(),
    getResourceCategories(),
  ]);

  const { text } = await callAIWithImage(
    buildPrompt(dictionary, categories),
    imageBase64,
    mimeType,
    { system: SYSTEM, maxTokens: 4000 },
  );

  return toItems(parseItems(text), dictionary, categories);
}
