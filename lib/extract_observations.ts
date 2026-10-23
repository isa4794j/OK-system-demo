/**
 * 일지에서 아동 관찰을 뽑아낸다.
 *
 * 이 파일은 이어 붙이는 일만 한다.
 *   일지 읽기(/db) → 이름 목록(/db) → AI(게이트웨이) → 저장(/db)
 * Supabase도 Claude도 직접 부르지 않는다. 각각 /db 와 lib/ai.ts 를 거친다.
 *
 * /db 에 두지 않은 이유: /db 는 "DB를 갈아끼울 때 여기만 고치면 되는 층"이다.
 * 거기에 AI 호출이 섞이면 그 약속이 깨진다.
 *
 * [영역은 뽑지 않는다]
 * AI는 "어느 아동의 어떤 내용인지"만 뽑는다. 영역(건강·학습·또래관계 …)은
 * 평가지표에 따라 달라지는 사람의 판단이라 기계에 맡기지 않는다.
 * 프롬프트에 영역 얘기를 넣지 않고, 저장할 때도 늘 비운다.
 * 영역은 나중에 아동 쪽으로 가져온 뒤 사람이 지정한다.
 *
 * [토큰으로 아동을 알아내는 순서]
 * 답변을 실명으로 되돌린 뒤 이름으로 아동을 찾으면 동명이인을 가릴 수 없다.
 * 그래서 토큰 상태의 답변(maskedReply)을 먼저 읽어 토큰→id 로 이은 다음,
 * 사람이 읽을 내용(content)만 실명으로 되돌린다.
 *
 * [누구인지 못 가린 것은 버리지 않는다]
 * "김0준"이 명단의 두 아이와 다 맞으면 기계는 거기서 멈춘다(lib/anonymize.ts).
 * 예전에는 그런 관찰을 통째로 버렸는데, 버리면 사람이 손으로 찾기 전에는
 * 그 관찰이 없는 것이 된다. 지금은 아동을 비운 채로 후보 목록과 함께 저장하고,
 * 일지 카드에서 사람이 고른다.
 */
import { parseObjectArray } from "./ai_json.ts";
import { NotFoundError } from "../db/client.ts";
import { getJournal, markAnalyzed } from "../db/journals.ts";
import {
  applyExtraction,
  type ExtractDiff,
  type NewJournalObservation,
} from "../db/journal_observations.ts";
import { callAISafe } from "./ai.ts";
import type { MaskMap } from "./anonymize.ts";
import { show } from "./anonymize.ts";
import { listPeopleToMask } from "./roster.ts";

/** 한 일지에서 뽑을 관찰의 상한. 이상한 응답이 통째로 들어오는 것을 막는다. */
const MAX_ITEMS = 30;

const SYSTEM = [
  "당신은 지역아동센터의 일지를 읽고 아동에 대한 관찰을 뽑아내는 일을 합니다.",
  "일지에 실제로 적힌 내용만 씁니다. 짐작하거나 살을 붙이지 않습니다.",
].join("\n");

function buildPrompt(journalText: string): string {
  return [
    "아래 일지에서 특정 아동에 대한 관찰을 뽑아 주세요.",
    "",
    "규칙",
    "- 아동 토큰(【아동1】, 【아동2】 …)으로 적힌 사람에 대한 내용만 뽑습니다.",
    "- 직원 토큰(【멘토1】, 【봉사자1】, 【센터장1】, 【생활복지사1】 …)에 대한 내용은 관찰이 아닙니다. 제외합니다.",
    "- 어느 아동인지 특정되지 않는 내용은 제외합니다.",
    "- 한 아동에 대해 서로 다른 관찰이 여럿이면 항목을 나눕니다.",
    "- 내용은 일지에 적힌 사실만 한두 문장으로 씁니다.",
    "- child 에는 일지에 있던 토큰을 【 】까지 그대로 옮겨 적습니다. 없던 토큰을 만들지 마세요.",
    "",
    "JSON 배열만 출력하세요. 설명, 머리말, 코드펜스 없이 배열만 씁니다.",
    '[{"child": "【아동1】", "content": "..."}]',
    "뽑을 관찰이 없으면 [] 만 출력하세요.",
    "",
    "--- 일지 ---",
    journalText,
  ].join("\n");
}

/** 모델이 코드펜스나 머리말(대괄호 섞인 것 포함)을 붙여도 배열만 꺼낸다 — lib/ai_json.ts */
function parseItems(reply: string): Array<Record<string, unknown>> {
  return parseObjectArray(reply, "관찰");
}

export type ExtractResult = ExtractDiff & {
  /** 뽑혔지만 저장하지 못한 항목과 그 이유. 화면에서 알려 줄 수 있다. */
  skipped: string[];
  /** 아동을 못 가려 사람이 정해 줘야 하는 관찰 수 */
  pending: number;
};

/**
 * 토큰으로 적힌 응답을 실제 아동 id로 이어 붙인다.
 *
 * 다음은 저장하지 않는다.
 *   - 아동이 아닌 토큰(직원)
 *   - 모르는 토큰 — 모델이 지어냈거나 원문 이름을 그대로 쓴 것이다
 * 누구인지 못 가린 토큰은 버리지 않고 아동을 비운 채로 저장한다.
 * 아무 쪽에나 붙이면 남의 기록이 되지만, 버리면 아예 없는 기록이 된다.
 * 둘 다 안 하고 사람에게 넘긴다.
 */
function toRows(
  items: Array<Record<string, unknown>>,
  map: MaskMap,
): { rows: NewJournalObservation[]; skipped: string[]; pending: number } {
  const rows: NewJournalObservation[] = [];
  const skipped: string[] = [];
  let pending = 0;

  for (const item of items.slice(0, MAX_ITEMS)) {
    const code = typeof item.child === "string" ? item.child.trim() : "";
    const rawContent = typeof item.content === "string" ? item.content.trim() : "";

    if (!code || !rawContent) {
      skipped.push("아동 또는 내용이 비어 있어 건너뛰었습니다.");
      continue;
    }

    const entry = map.byCode[code];
    if (!entry) {
      // 토큰을 그대로 옮기라고 일러 두었는데도 다른 말이 왔다.
      // 그 항목이 누구 이야기인지 알 방법이 없으므로 버린다.
      skipped.push(`모르는 토큰(${code})이라 건너뛰었습니다.`);
      continue;
    }
    if (entry.kind !== "child") {
      skipped.push(`${code}는 아동이 아니라 건너뛰었습니다.`);
      continue;
    }
    if (entry.people.length === 0) {
      skipped.push(`${code}의 아동 id를 찾지 못해 건너뛰었습니다.`);
      continue;
    }

    // 영역은 AI가 정하지 않는다. 항상 비운 채로 저장한다.
    // 어느 영역으로 볼지는 평가지표에 따라 달라지는 사람의 판단이다.
    // 나중에 아동 쪽으로 가져온 뒤 사람이 지정한다.
    //
    // 내용은 사람이 읽을 글이라 실명으로 되돌린다.
    // 토큰으로 저장하면 나중에 명단이 바뀔 때 다른 사람을 가리키게 된다.
    const base = { area: null, content: show(rawContent, map) };

    if (entry.ambiguous) {
      pending += 1;
      rows.push({ ...base, child_id: null, pending_child_ids: entry.people });
      continue;
    }
    rows.push({ ...base, child_id: entry.people[0] });
  }

  return { rows, skipped, pending };
}

/**
 * 일지 하나에서 관찰을 뽑아 저장한다.
 * 그 일지의 이전 추출 결과는 지우고 새로 넣는다(다시 뽑기 대비).
 */
export async function extractObservations(journalId: string): Promise<ExtractResult> {
  const journal = await getJournal(journalId);
  if (!journal) {
    throw new NotFoundError("일지를 찾지 못했습니다. 이미 지워졌을 수 있어요.");
  }

  // 가려야 할 사람은 전부 넘긴다. 명단을 모으는 일은 lib/roster.ts 한 곳에서 한다.
  const people = await listPeopleToMask();

  const journalText = [journal.title, journal.content].filter(Boolean).join("\n\n");

  const result = await callAISafe(buildPrompt(journalText), people, {
    system: SYSTEM,
    maxTokens: 4000,
  });

  // 토큰 상태의 응답을 읽어야 아동 id로 이을 수 있다
  const { rows, skipped, pending } = toRows(parseItems(result.maskedReply), result.map);
  const diff = await applyExtraction(journalId, rows);

  // 뽑은 것이 0건이어도 "분석했다" 는 남긴다. 카드가 "관찰 0" 과 "미분석" 을 갈라 보여준다.
  await markAnalyzed(journalId, "observations");

  return { ...diff, skipped, pending };
}
