/**
 * 성장 추이 — 아동 상세의 반기 관찰 모아 보기
 *
 *   GET /api/children/:id/growth
 *
 * 반기를 축으로 영역별 평균과 항목별 점수를 준다.
 *
 * [평균으로 뭉개지 않는다]
 * 반기 관찰은 사람마다 한 장이다. 같은 아이를 김멘토는 4.2, 정하늘은 3.8 로 봤다면
 * 그 차이가 곧 정보다 — 한 사람은 공부방에서, 한 사람은 놀이 시간에 봤을 수 있다.
 * 둘을 합쳐 4.0 으로 보이면 그 차이가 사라진다. 그래서 장마다 따로 준다.
 *
 * 평균 계산은 lib/half_items.ts 한 곳에서 한다(지운 항목은 빼는 규칙까지).
 * 이 파일은 Supabase 를 직접 부르지 않는다. /db 만 쓴다.
 */
import { listHalfObservationsByChild } from "../db/half_observations.ts";
import { getSetting } from "../db/settings.ts";
import { areaAverages, HALF_AREAS, readItems } from "../lib/half_items.ts";

const JSON_HEADERS = { "cache-control": "no-store" };

export async function handleChildGrowth(childId: string): Promise<Response> {
  try {
    const [rows, rawItems] = await Promise.all([
      listHalfObservationsByChild(childId),
      getSetting<unknown>("half_observation_items", []),
    ]);
    const items = readItems(rawItems);

    return Response.json({
      areas: HALF_AREAS,
      // 지운 항목도 준다 — 지난 기록이 그 항목에 점수를 물고 있으면 표에 "삭제된 항목" 으로 보인다.
      items,
      records: rows.map((one) => ({
        id: one.id,
        year: one.year,
        half: one.half,
        author_id: one.author_id,
        author_name: one.author_name,
        observed_on: one.observed_on,
        updated_at: one.updated_at,
        scores: one.scores ?? {},
        note: one.note,
        averages: areaAverages(items, one.scores ?? {}),
      })),
    }, { headers: JSON_HEADERS });
  } catch (error) {
    console.error("[GET /api/children/:id/growth]", error);
    return Response.json(
      { error: "요청을 처리하지 못했습니다." },
      { status: 500, headers: JSON_HEADERS },
    );
  }
}
