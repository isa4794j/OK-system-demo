/**
 * 일지에서 자원 활용을 뽑아낸다.
 *
 * 이 파일은 이어 붙이는 일만 한다.
 *   일지 읽기(/db) → 자원사전·카테고리(/db) → AI(게이트웨이) → 저장(/db)
 * Supabase도 Claude도 직접 부르지 않는다. 각각 /db 와 lib/ai.ts 를 거친다.
 *
 * [뽑는 즉시 통계에 들어간다]
 * 결과는 status='Y' 로 들어가 바로 통계에 잡히고, AI 가 고른 카테고리가 그대로 붙는다.
 * 못 정한 것은 category=NULL 로 미분류함에 남는다. 사람은 사후에 틀린 것만 고친다.
 * 자원 이름은 일지에 적힌 말이 제각각이라("나무탑", "천사점토") AI가 사전과 맞춰 본다.
 *
 * [사전을 함께 보낸다]
 * 사전 없이 뽑으면 같은 물건이 매번 다른 이름으로 들어와 통계가 갈라진다.
 * 이름·카테고리·별칭을 같이 주고, 사전에 있는 것이면 정식 이름으로 돌려 달라고 한다.
 * 별칭이 실제로 쓰이는 곳이 여기다.
 *
 * 바뀌기 전 표기(as_written)도 함께 받아 raw_name 에 담는다.
 * 이 값이 없으면 나중에 별칭을 다시 떼어낼 때 어느 기록이 그 표기였는지 알 수 없다.
 *
 * [블랙리스트는 두 번 건다]
 * "자원이 아니다"라고 판단한 이름은 프롬프트에 적어 뽑지 말라고 하고,
 * 그래도 올라오면 저장할 때 '없음'으로 돌린다. AI 는 지시를 늘 지키지는 않는다.
 * 같은 것을 매번 다시 판단하지 않으려는 장치라, 한 겹으로는 부족하다.
 *
 * [자원 추출에도 가명화를 거친다]
 * 자원 이름에 사람 이름이 섞일 일은 드물다. 그래도 일지 본문을 통째로 보내므로
 * 나가는 글에 실명이 남아서는 안 된다. callAISafe 를 쓰는 이유다.
 */
import { parseObjectArray } from "./ai_json.ts";
import { NotFoundError } from "../db/client.ts";
import { getJournal, markAnalyzed } from "../db/journals.ts";
import {
  addResource,
  getResourceBlacklist,
  getResourceCategories,
  listResources,
  type ResourceItem,
} from "../db/resources.ts";
import {
  applyResourceExtraction,
  type NewResourceRecord,
  type ResourceDiff,
} from "../db/resource_records.ts";
import { callAISafe } from "./ai.ts";
import { similarity } from "./similarity.ts";
import { listPeopleToMask } from "./roster.ts";

/** 한 일지에서 뽑을 자원의 상한. 이상한 응답이 통째로 들어오는 것을 막는다. */
const MAX_ITEMS = 20;

/** 사전이 아주 커지면 프롬프트가 길어진다. 그때는 앞쪽만 보낸다. */
const MAX_DICT = 300;

/**
 * "자원 아님"이라고 해 둔 이름과 이만큼 닮으면 자동 등록하지 않는다.
 *
 * 사람이 한 번 아니라고 한 것을 말만 조금 바꿔 다시 들이지 않으려는 것이다.
 * ("보드게임 시간" 을 아니라고 했는데 "보드게임시간" 이 새로 들어오는 식)
 * 버리지는 않는다 — 카테고리를 비워 미분류함에 올려 사람이 보게 한다.
 */
const NEAR_REJECTED = 0.7;

/** 자동으로 자원사전에 올릴 한 건 */
export type NewDictionaryEntry = { name: string; category: string };

const SYSTEM = [
  "당신은 지역아동센터의 일지를 읽고 아이들이 활용한 자원을 뽑아내는 일을 합니다.",
  "일지에 실제로 적힌 것만 씁니다. 짐작하거나 살을 붙이지 않습니다.",
].join("\n");

/** 사전을 프롬프트에 넣을 한 줄로 만든다. 별칭이 있으면 함께 적는다. */
function dictLine(item: ResourceItem): string {
  const category = item.category ?? "미정";
  const aliases = item.aliases ? ` (별칭: ${item.aliases})` : "";
  return `- ${item.name} [${category}]${aliases}`;
}

function buildPrompt(
  journalText: string,
  dictionary: ResourceItem[],
  categories: string[],
  blacklist: string[],
): string {
  const dict = dictionary.length > 0
    ? dictionary.slice(0, MAX_DICT).map(dictLine).join("\n")
    : "(아직 등록된 자원이 없습니다)";

  // 블랙리스트는 있을 때만 적는다. 빈 목록을 적으면 모델이 그 줄을 이상하게 읽는다.
  const banned = blacklist.length > 0
    ? [
      "",
      "--- 자원으로 기록하지 않을 이름 ---",
      "아래 이름은 센터가 자원이 아니라고 판단한 것입니다. 일지에 나와도 뽑지 않습니다.",
      blacklist.slice(0, MAX_DICT).join(", "),
    ]
    : [];

  return [
    "아래 일지에서 아이들이 활용한 자원을 뽑아 주세요.",
    "자원이란 놀이도구, 게임, 만들기 재료, 기기, 운동기구 같은 것입니다.",
    "",
    "--- 자원사전 (센터가 가진 것) ---",
    dict,
    "",
    "--- 카테고리 목록 ---",
    categories.join(", "),
    ...banned,
    "",
    "규칙",
    "- 일지에 적힌 표기를 as_written 에 그대로 옮깁니다. 고치지 않습니다.",
    "- 사전에 있는 자원이면 사전의 정식 이름으로 적습니다.",
    '  별칭으로 적혀 있어도 정식 이름으로 바꿉니다. 예: 일지에 "나무탑" → 사전에 젠가의 별칭이면 "젠가".',
    '- 하위 종류, 상품명, 줄임말도 사전 자원으로 잇습니다. 예: "천사점토" → 사전에 점토놀이가 있으면 "점토놀이".',
    "- 사전에 없는 새 자원이면 일지에 적힌 이름을 그대로 씁니다.",
    "  카테고리는 위 목록 중에서 고릅니다.",
    '  조금이라도 확신이 없으면 카테고리를 빈 문자열("")로 두세요.',
    "  비워 두면 사람이 나중에 채웁니다. 억지로 고르면 통계가 어긋납니다.",
    "- 사전에 있는 자원의 카테고리는 사전을 따릅니다. 임의로 바꾸지 않습니다.",
    "- 같은 자원이 여러 번 나와도 한 번만 적습니다.",
    "- 장소(강당, 교실), 활동 이름(체육시간), 사람은 자원이 아닙니다. 제외합니다.",
    "- 아이들이 실제로 쓴 것만 뽑습니다. 사려고 한다, 없어서 못 했다 같은 것은 제외합니다.",
    "",
    "JSON 배열만 출력하세요. 설명, 머리말, 코드펜스 없이 배열만 씁니다.",
    '[{"name": "젠가", "as_written": "나무탑", "category": "보드게임"}]',
    "뽑을 자원이 없으면 [] 만 출력하세요.",
    "",
    "--- 일지 ---",
    journalText,
  ].join("\n");
}

/** 모델이 코드펜스나 머리말(대괄호 섞인 것 포함)을 붙여도 배열만 꺼낸다 — lib/ai_json.ts */
export function parseItems(reply: string): Array<Record<string, unknown>> {
  return parseObjectArray(reply, "자원");
}

export type ExtractResourcesResult = ResourceDiff & {
  /** 뽑혔지만 저장하지 못한 항목과 그 이유. 화면에서 알려 줄 수 있다. */
  skipped: string[];
  /** 이번에 자원사전에 자동으로 올린 이름 */
  registered: string[];
};

/**
 * AI가 돌려준 것을 저장할 모양으로 다듬는다.
 *
 * 사전에 있는 이름이면 카테고리를 사전 값으로 덮는다.
 * AI가 사전 자원의 카테고리를 다르게 적어 오는 일이 있는데,
 * 그대로 두면 같은 자원이 두 묶음으로 갈라진다. 사전이 정답이다.
 *
 * 카테고리는 목록에 있는 것만 받는다. 목록에 없으면 비워 사람이 고르게 한다.
 * 없는 카테고리로 저장하면 자원사전 화면에서 "카테고리 없음" 묶음으로 밀려난다.
 */
export function toRows(
  items: Array<Record<string, unknown>>,
  dictionary: ResourceItem[],
  categories: string[],
  blacklist: string[],
): { rows: NewResourceRecord[]; skipped: string[]; register: NewDictionaryEntry[] } {
  const byName = new Map(dictionary.map((item) => [item.name.trim().toLowerCase(), item]));
  const allowed = new Set(categories);
  const banned = new Set(blacklist.map((name) => name.trim().toLowerCase()));

  const rows: NewResourceRecord[] = [];
  const skipped: string[] = [];
  /** 사전에 없던 자원. 카테고리를 가린 것만 자동 등록한다. */
  const register: NewDictionaryEntry[] = [];

  for (const item of items.slice(0, MAX_ITEMS)) {
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (!name) {
      skipped.push("자원명이 비어 있어 건너뛰었습니다.");
      continue;
    }
    if (name.length > 100) {
      skipped.push(`"${name.slice(0, 20)}…" 는 이름이 너무 길어 건너뛰었습니다.`);
      continue;
    }

    // 블랙리스트에 걸리면 버리지 않고 '없음'으로 넣는다.
    // 걸러졌다는 사실이 화면에 보여야 "왜 안 뽑혔지"가 되지 않고,
    // 판단이 바뀌면 검토로 되돌릴 수 있다.
    if (banned.has(name.toLowerCase())) {
      rows.push({ resource_name: name, raw_name: name, category: null, status: "없음" });
      continue;
    }

    // 일지에 적혀 있던 표기. 안 주면 정식 이름과 같다고 본다.
    // 이 값이 있어야 나중에 별칭을 다시 떼어낼 때 어느 기록이 그 표기였는지 안다.
    const raw = typeof item.as_written === "string" && item.as_written.trim()
      ? item.as_written.trim().slice(0, 100)
      : name;

    const known = byName.get(name.toLowerCase());
    if (known) {
      rows.push({ resource_name: known.name, raw_name: raw, category: known.category });
      continue;
    }

    // 사전에 없는 새 자원.
    //
    // 예전에는 검토 대기로 두고 사람이 [확정]을 눌러야 통계에 들어갔다.
    // 대부분은 눌러 주기만 하는 일이었고, 안 누르면 통계가 조용히 비었다.
    // 이제 바로 넣고, 틀린 것만 나중에 고친다.
    //
    // 다만 두 가지는 사람에게 넘긴다. 카테고리를 비워 두면
    // 통계에 "카테고리 미정"으로 잡히고 미분류함에 뜬다.
    //   ㄱ. AI 가 카테고리를 못 정한 것 — 억지로 고르면 통계가 어긋난다
    //   ㄴ. "자원 아님"이라고 해 둔 이름과 닮은 것 — 사람이 한 번 아니라고 한 것이다
    const guess = typeof item.category === "string" ? item.category.trim() : "";
    const category = allowed.has(guess) ? guess : null;
    const nearRejected = blacklist.some((one) => similarity(one, name) >= NEAR_REJECTED);

    rows.push({ resource_name: name, raw_name: raw, category: nearRejected ? null : category });
    if (category && !nearRejected) register.push({ name, category });
  }

  return { rows, skipped, register };
}

/**
 * 일지 하나에서 자원을 뽑아 저장한다(status='Y').
 * 다시 뽑으면 이전 결과와 견준다 — 사람이 이미 판단한 줄('없음'이거나 카테고리가
 * 정해진 것)은 그대로 두고, 아직 아무도 안 본 줄만 새 결과와 맞춘다.
 */
export async function extractResources(journalId: string): Promise<ExtractResourcesResult> {
  const journal = await getJournal(journalId);
  if (!journal) {
    throw new NotFoundError("일지를 찾지 못했습니다. 이미 지워졌을 수 있어요.");
  }

  // 가려야 할 사람은 전부 넘긴다.
  // 종결·종료된 사람도 이름은 가려야 하므로 상태로 거르지 않는다.
  const [people, dictionary, categories, blacklist] = await Promise.all([
    listPeopleToMask(),
    listResources(),
    getResourceCategories(),
    getResourceBlacklist(),
  ]);

  const journalText = [journal.title, journal.content].filter(Boolean).join("\n\n");

  const result = await callAISafe(
    buildPrompt(journalText, dictionary, categories, blacklist),
    people,
    { system: SYSTEM, maxTokens: 2000 },
  );

  // 자원 이름에는 사람 코드가 없어야 한다. 코드가 아니라 실명으로 되돌린 쪽을 읽는다.
  // (혹시 코드가 섞여 들어오면 그대로 이름이 되므로 사람이 검토에서 걸러 낸다)
  const { rows, skipped, register } = toRows(
    parseItems(result.text),
    dictionary,
    categories,
    blacklist,
  );

  // 사전에 없던 자원을 먼저 올린다. 기록보다 사전이 먼저 있어야
  // 다음 일지에서 같은 것이 또 새 자원으로 올라오지 않는다.
  //
  // 한 건이 실패해도 나머지는 넣는다. 같은 이름이 이미 있으면(다른 일지가 방금 넣었으면)
  // 그 실패는 문제가 아니다 — 사전에 있으면 된 것이다.
  const added: string[] = [];
  for (const entry of register) {
    try {
      await addResource(entry.name, entry.category, null, true);
      added.push(entry.name);
    } catch (error) {
      console.warn(`[extractResources] 자원사전 자동 등록 건너뜀: ${entry.name}`, error);
    }
  }

  const diff = await applyResourceExtraction(
    journalId,
    journal.journal_date,
    journal.kind,
    rows,
  );

  // 뽑은 것이 0건이어도 "분석했다" 는 남긴다
  await markAnalyzed(journalId, "resources");

  return { ...diff, skipped, registered: added };
}
