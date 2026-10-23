/**
 * 반기 평가(yearly_evaluations) 데이터 접근
 *
 * 규칙: Supabase 호출은 /db 안에서만 한다.
 *
 * 이 파일은 읽고 쓰기만 한다. AI를 부르지 않는다.
 * 초안을 만드는 일은 /lib/draft_evaluation.ts 가 맡는다.
 *
 * [근거 스냅샷]
 * 저장할 때 "무엇을 읽고 썼는지" 를 함께 찍는다(026). 해시만 담기므로
 * 관찰 본문이 이 표에 복사되지는 않는다. 찍는 규칙은 lib/evidence.ts 한 곳에 있다.
 * evidence_checked_at 은 사람이 [확인함] 을 눌렀을 때만 채워진다 —
 * 저장은 "썼다" 이고 확인은 "그 사이 바뀐 것을 보고 받아들였다" 라서 다른 일이다.
 */
import { getClient, writeError } from "./client.ts";
import { recordAudit } from "./audit.ts";
import type { Half } from "./observations.ts";
import { type EvidenceEntry, readSnapshot } from "../lib/evidence.ts";

/** {"영역": "서술문"} — 영역 목록이 바뀔 수 있어 자유로운 모양으로 둔다. */
export type EvaluationContent = Record<string, string>;

export type YearlyEvaluation = {
  id: string;
  child_id: string;
  year: number;
  half: Half;
  content: EvaluationContent;
  updated_at: string;
  /** null 이면 근거 추적 이전 평가. 배너 대신 그렇게 적는다. */
  evidence_snapshot: EvidenceEntry[] | null;
  evidence_checked_at: string | null;
  evidence_checked_by: string | null;
  /** 확인한 사람 이름. 명단에서 사라졌으면 null */
  checked_by_name: string | null;
};

// 이어 붙이면 supabase-js 가 반환 타입을 못 읽는다. 한 줄 문자열로 둔다.
// deno-fmt-ignore
const COLUMNS = "id, child_id, year, half, content, updated_at, evidence_snapshot, evidence_checked_at, evidence_checked_by, checked_by:staff(name)";

// deno-lint-ignore no-explicit-any
function flatten(row: any): YearlyEvaluation {
  const { checked_by, ...rest } = row;
  return {
    ...rest,
    evidence_snapshot: readSnapshot(row.evidence_snapshot),
    checked_by_name: checked_by?.name ?? null,
  } as YearlyEvaluation;
}

/** 저장된 평가를 읽는다. 아직 없으면 null. */
export async function getYearlyEval(
  childId: string,
  year: number,
  half: Half,
): Promise<YearlyEvaluation | null> {
  const { data, error } = await getClient()
    .from("yearly_evaluations")
    .select(COLUMNS)
    .eq("child_id", childId)
    .eq("year", year)
    .eq("half", half)
    .maybeSingle();

  if (error) {
    throw new Error(`연간평가 조회 실패: ${error.message}`);
  }
  return data ? flatten(data) : null;
}

/**
 * 평가를 저장한다. 같은 아동·년도·반기가 이미 있으면 덮어쓴다.
 *
 * 한 반기에 평가는 하나뿐이라 DB에 unique 제약이 걸려 있고,
 * 그 제약을 기준으로 upsert 한다. 화면에서 두 번 저장해도 행이 늘지 않는다.
 *
 * 근거 스냅샷을 함께 찍는다. 확인 시각(evidence_checked_at)은 건드리지 않는다 —
 * upsert 에 안 넣은 컬럼은 그대로 남으므로 지난 확인 기록이 지워지지 않는다.
 */
export async function saveYearlyEval(
  childId: string,
  year: number,
  half: Half,
  content: EvaluationContent,
  snapshot: EvidenceEntry[],
): Promise<YearlyEvaluation> {
  // 이미 있던 평가를 덮어쓰는 것이면 전 값을 남긴다. 처음 저장은 안 남긴다.
  const before = await getYearlyEval(childId, year, half);

  const { data, error } = await getClient()
    .from("yearly_evaluations")
    .upsert(
      { child_id: childId, year, half, content, evidence_snapshot: snapshot },
      { onConflict: "child_id,year,half" },
    )
    .select(COLUMNS)
    .single();

  if (error) {
    throw writeError(error, "연간평가 저장 실패");
  }
  // 덮어쓴 것만 남긴다. 처음 저장은 등록이라 안 남긴다 — 그 값은 다음 덮어쓰기의 before 로 남는다.
  if (before) {
    await recordAudit({
      action: "update",
      table_name: "yearly_evaluations",
      record_id: before.id,
      summary: `연간평가 수정 — ${year}년 ${half === 1 ? "상반기" : "하반기"}`,
      before,
      after: flatten(data),
    });
  }
  return flatten(data);
}

/**
 * [확인함] — 바뀐 근거를 사람이 보고 받아들였다.
 *
 * 스냅샷을 지금 것으로 다시 찍고, 누가 언제 확인했는지 남긴다.
 * 평가 본문은 건드리지 않는다 — 확인은 "읽었다" 이지 "고쳤다" 가 아니다.
 *
 * 기록은 감사 로그에 before/after 째 남는다. 누가 눌렀는지(actor)는
 * 요청 컨텍스트에서 login_name 으로 붙는다(db/audit.ts).
 */
export async function markEvidenceChecked(
  childId: string,
  year: number,
  half: Half,
  snapshot: EvidenceEntry[],
  byStaffId: string,
): Promise<YearlyEvaluation> {
  const before = await getYearlyEval(childId, year, half);
  if (!before) {
    throw new Error("저장된 평가가 없습니다.");
  }

  const { data, error } = await getClient()
    .from("yearly_evaluations")
    .update({
      evidence_snapshot: snapshot,
      evidence_checked_at: new Date().toISOString(),
      evidence_checked_by: byStaffId,
    })
    .eq("id", before.id)
    .select(COLUMNS)
    .single();

  if (error) {
    throw new Error(`근거 확인 기록 실패: ${error.message}`);
  }
  const after = flatten(data);

  await recordAudit({
    action: "update",
    table_name: "yearly_evaluations",
    record_id: before.id,
    summary: `연간평가 근거 확인 — ${year}년 ${half === 1 ? "상반기" : "하반기"}`,
    // 본문은 안 바뀌므로 근거 쪽만 남긴다. 통째로 남기면 무엇이 바뀌었는지 묻힌다.
    before: {
      evidence_snapshot: before.evidence_snapshot,
      evidence_checked_at: before.evidence_checked_at,
      evidence_checked_by: before.evidence_checked_by,
    },
    after: {
      evidence_snapshot: after.evidence_snapshot,
      evidence_checked_at: after.evidence_checked_at,
      evidence_checked_by: after.evidence_checked_by,
    },
  });
  return after;
}
