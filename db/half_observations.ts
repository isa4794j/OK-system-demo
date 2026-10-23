/**
 * 반기 관찰(half_observations) 데이터 접근 — 봉사자·멘토가 아이 하나하나를 두고 적는 것
 *
 * 규칙: Supabase 호출은 /db 안에서만 한다.
 *
 * [사람마다 한 장]
 * 아동·반기당 한 장이 아니다. 멘토 둘이 같은 아이를 보면 두 장이 맞다.
 * 한 장을 여럿이 덮어쓰면 나중 사람만 남고 앞사람이 본 것이 조용히 사라진다.
 * DB 의 unique index (child_id, year, half, author_id) 가 그 규칙을 쥐고 있고,
 * 여기서는 그 네 값으로 upsert 한다 — 같은 사람이 다시 쓰면 자기 장만 덮어쓴다.
 *
 * 점수가 무엇을 뜻하는지(항목 목록)는 settings.half_observation_items 가 갖고,
 * 그 규칙은 lib/half_items.ts 한 곳에 있다. 여기서는 받은 대로 담는다.
 */
import { getClient } from "./client.ts";
import { recordAudit } from "./audit.ts";

export type HalfObservation = {
  id: string;
  child_id: string;
  year: number;
  half: 1 | 2;
  author_id: string | null;
  scores: Record<string, number>;
  note: string | null;
  observed_on: string | null;
  updated_at: string;
};

export type HalfObservationWithAuthor = HalfObservation & { author_name: string | null };

// deno-fmt-ignore
const COLUMNS = "id, child_id, year, half, author_id, scores, note, observed_on, updated_at";

/** 이 사람이 이번 반기에 쓴 것 전부. 명단 옆에 "썼음" 을 붙이는 데 쓴다. */
export async function listHalfObservationsByAuthor(
  authorId: string,
  year: number,
  half: 1 | 2,
): Promise<HalfObservation[]> {
  const { data, error } = await getClient()
    .from("half_observations")
    .select(COLUMNS)
    .eq("author_id", authorId)
    .eq("year", year)
    .eq("half", half);

  if (error) {
    throw new Error(`반기 관찰 조회 실패: ${error.message}`);
  }
  return (data ?? []) as HalfObservation[];
}

/** 이 사람이 이 아이를 두고 그 반기에 쓴 한 장. 없으면 null. */
export async function getHalfObservation(
  childId: string,
  year: number,
  half: 1 | 2,
  authorId: string,
): Promise<HalfObservation | null> {
  const { data, error } = await getClient()
    .from("half_observations")
    .select(COLUMNS)
    .eq("child_id", childId)
    .eq("year", year)
    .eq("half", half)
    .eq("author_id", authorId)
    .maybeSingle();

  if (error) {
    throw new Error(`반기 관찰 조회 실패: ${error.message}`);
  }
  return (data ?? null) as HalfObservation | null;
}

/**
 * 한 아이의 반기 관찰 전부. 성장 추이가 쓴다.
 *
 * 누가 봤는지 이름을 함께 읽는다 — 사람마다 한 장이라 평균으로 뭉개지 않고
 * "김멘토 4.2 / 정하늘 3.8" 처럼 갈라 보여야 한다. 그러려면 이름이 있어야 한다.
 */
export async function listHalfObservationsByChild(
  childId: string,
): Promise<HalfObservationWithAuthor[]> {
  // deno-fmt-ignore
  const { data, error } = await getClient()
    .from("half_observations")
    .select("id, child_id, year, half, author_id, scores, note, observed_on, updated_at, author:staff(name)")
    .eq("child_id", childId)
    .order("year", { ascending: true })
    .order("half", { ascending: true });

  if (error) {
    throw new Error(`반기 관찰 조회 실패: ${error.message}`);
  }
  // deno-lint-ignore no-explicit-any
  return (data ?? []).map((row: any) => {
    const { author, ...rest } = row;
    return { ...rest, author_name: author?.name ?? null } as HalfObservationWithAuthor;
  });
}

/**
 * 한 장을 저장한다. 이미 쓴 것이 있으면 덮어쓴다(PUT).
 *
 * 덮어쓰기로 두는 이유: 폰에서 적다 만 것을 나중에 이어 적는 것이 실제 모습이다.
 * 매번 새 줄이 쌓이면 한 아이에 같은 사람 글이 여러 장 남고, 어느 것이 지금인지
 * 아무도 모르게 된다.
 *
 * 덮어쓸 때(이미 있던 장의 값이 바뀔 때)는 감사 로그에 전후 값을 남긴다.
 * 처음 쓰는 것은 등록이라 남기지 않는다(원칙 8 제외 목록).
 */
export async function saveHalfObservation(input: {
  child_id: string;
  year: number;
  half: 1 | 2;
  author_id: string;
  note: string | null;
  scores: Record<string, number>;
  observed_on: string | null;
}): Promise<HalfObservation> {
  const client = getClient();
  const { data: before, error: readError } = await client
    .from("half_observations")
    .select(COLUMNS)
    .eq("child_id", input.child_id)
    .eq("year", input.year)
    .eq("half", input.half)
    .eq("author_id", input.author_id)
    .maybeSingle();
  if (readError) throw new Error(`반기 관찰 읽기 실패: ${readError.message}`);

  const { data, error } = await client
    .from("half_observations")
    .upsert({
      child_id: input.child_id,
      year: input.year,
      half: input.half,
      author_id: input.author_id,
      note: input.note,
      scores: input.scores,
      observed_on: input.observed_on,
    }, { onConflict: "child_id,year,half,author_id" })
    .select(COLUMNS)
    .single();

  if (error) {
    throw new Error(`반기 관찰 저장 실패: ${error.message}`);
  }
  const after = data as HalfObservation;

  const old = before as HalfObservation | null;
  if (old) {
    const pick = (row: HalfObservation) => ({
      child_id: row.child_id,
      year: row.year,
      half: row.half,
      author_id: row.author_id,
      scores: row.scores,
      note: row.note,
      observed_on: row.observed_on,
    });
    const changed = JSON.stringify([old.scores, old.note, old.observed_on]) !==
      JSON.stringify([after.scores, after.note, after.observed_on]);
    if (changed) {
      await recordAudit({
        action: "update",
        table_name: "half_observations",
        record_id: after.id,
        summary: `반기 관찰 수정 — ${after.year}년 ${after.half === 1 ? "상" : "하"}반기`,
        before: pick(old),
        after: pick(after),
      });
    }
  }
  return after;
}
