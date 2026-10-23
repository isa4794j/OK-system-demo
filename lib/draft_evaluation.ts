/**
 * 반기 평가 초안을 AI로 만든다.
 *
 * 이 파일은 이어 붙이는 일만 한다.
 *   관찰 읽기(/db) → 이름 목록(/db) → AI(게이트웨이) → 초안 반환
 * Supabase도 Claude도 직접 부르지 않는다. 각각 /db 와 lib/ai.ts 를 거친다.
 *
 * 저장은 하지 않는다. 초안은 사람이 읽고 고친 뒤에야 기록이 된다.
 * 화면에서 검토하고 저장을 눌러야 /db/evaluations.ts 를 거쳐 들어간다.
 *
 * [영역 미지정 관찰은 쓰지 않는다]
 * 평가는 영역별로 쓰는데, 영역이 없는 관찰은 어느 칸에도 넣을 수 없다.
 * 억지로 넣으면 근거가 어긋난다. 대신 몇 건이 빠졌는지 돌려주어
 * 화면이 "영역을 먼저 지정하라"고 알릴 수 있게 한다.
 */
import { type Half, listObservationsByChild } from "../db/observations.ts";
import { activeAreas, currentAreas, type ObsArea } from "./obs_areas.ts";
import { callAISafe } from "./ai.ts";
import { show } from "./anonymize.ts";
import { listPeopleToMask } from "./roster.ts";

const SYSTEM = [
  "당신은 지역아동센터에서 아동의 반기 평가를 쓰는 일을 돕습니다.",
  "관찰 기록에 적힌 것만 근거로 씁니다. 적히지 않은 일은 쓰지 않습니다.",
].join("\n");

/** "2026년 하반기" 같은 말 */
function periodText(year: number, half: Half): string {
  return `${year}년 ${half === 1 ? "상반기" : "하반기"}`;
}

/** 키 표기 — 이름이 곧 코드면 그대로, 아니면 "a01(자립)" */
function keyLabel(area: ObsArea): string {
  return area.code === area.name ? area.code : `${area.code}(${area.name})`;
}

export function buildPrompt(
  period: string,
  grouped: Map<string, string[]>,
  areas: ObsArea[],
): string {
  const sections: string[] = [];
  for (const area of areas) {
    const lines = grouped.get(area.code) ?? [];
    if (lines.length === 0) continue;
    sections.push(`[${keyLabel(area)}]`, ...lines.map((line) => `- ${line}`), "");
  }

  return [
    `아래는 한 아동의 ${period} 관찰 기록입니다. 영역별로 모아 두었습니다.`,
    "",
    "각 영역마다, 그 영역의 관찰을 근거로 반기 평가를 써 주세요.",
    "",
    "규칙",
    "- 관찰에 적힌 내용만 씁니다. 없는 일을 지어내지 마세요.",
    "- '~음', '~함' 체로 씁니다. (예: 또래와 갈등이 생겼을 때 스스로 화해를 시도함)",
    "- 한 영역당 2~4문장으로 씁니다.",
    '- 관찰이 없는 영역은 빈 문자열("")로 둡니다.',
    "",
    "JSON 객체만 출력하세요. 설명, 머리말, 코드펜스 없이 객체만 씁니다.",
    `키는 다음 ${areas.length}개를 모두 넣습니다(괄호 안은 영역 이름 — 키에는 괄호 앞 글자만): ${
      areas.map(keyLabel).join(", ")
    }`,
    `{"${areas[0]?.code ?? "건강"}": "...", ...}`,
    "",
    "--- 관찰 기록 ---",
    ...sections,
  ].join("\n");
}

/** 모델이 코드펜스나 머리말을 붙여도 객체만 꺼낸다. */
function parseDraft(reply: string): Record<string, unknown> {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("AI 응답에서 평가 내용을 찾지 못했습니다.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    throw new Error("AI 응답이 올바른 JSON이 아닙니다.");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("AI 응답이 영역별 객체 모양이 아닙니다.");
  }
  return parsed as Record<string, unknown>;
}

export type DraftResult = {
  /** {"영역": "서술문"} — 관찰이 없던 영역은 빈 문자열 */
  content: Record<string, string>;
  /** 근거로 쓴 관찰 수 */
  used: number;
  /** 영역이 없어 쓰지 못한 관찰 수 */
  unassigned: number;
};

/**
 * 한 아동의 한 반기 관찰을 근거로 영역별 평가 초안을 만든다.
 * 저장하지 않는다. 부르는 쪽이 사람에게 보여주고 고치게 해야 한다.
 */
export async function draftEvaluation(
  childId: string,
  year: number,
  half: Half,
): Promise<DraftResult> {
  const observations = await listObservationsByChild(childId, year, half);
  // 지금 쓰는 영역만 칸으로 쓴다(지운 "예전 영역" 의 관찰은 초안 근거에서 뺀다)
  const areas = activeAreas(await currentAreas());
  const codes = areas.map((one) => one.code);

  // 영역이 지정된 것만 근거로 쓴다
  const grouped = new Map<string, string[]>();
  let unassigned = 0;
  let used = 0;

  for (const item of observations) {
    if (!item.area || !codes.includes(item.area)) {
      unassigned += 1;
      continue;
    }
    const lines = grouped.get(item.area) ?? [];
    lines.push(`${item.obs_date}: ${item.content}`);
    grouped.set(item.area, lines);
    used += 1;
  }

  const empty = Object.fromEntries(codes.map((code) => [code, ""]));
  if (used === 0) {
    return { content: empty, used: 0, unassigned };
  }

  // 가려야 할 사람은 상태로 거르지 않고 전부 넘긴다.
  // 종결·종료된 사람의 이름도 관찰 본문에 남아 있을 수 있다.
  const people = await listPeopleToMask();

  const result = await callAISafe(buildPrompt(periodText(year, half), grouped, areas), people, {
    system: SYSTEM,
    maxTokens: 4000,
  });

  // 코드 상태의 응답을 파싱한 뒤 값만 실명으로 되돌린다.
  // 되돌린 글을 통째로 JSON.parse 하면, 이름에 따옴표 같은 글자가 있을 때 깨진다.
  const raw = parseDraft(result.maskedReply);

  const content: Record<string, string> = { ...empty };
  for (const code of codes) {
    const value = raw[code];
    if (typeof value !== "string") continue;
    content[code] = show(value.trim(), result.map);
  }

  return { content, used, unassigned };
}
