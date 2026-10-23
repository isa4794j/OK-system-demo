import { assertEquals, assertNotEquals } from "@std/assert";
import {
  buildSnapshot,
  countChanges,
  diffSnapshot,
  evidenceHash,
  readSnapshot,
} from "./evidence.ts";

Deno.test("같은 본문·영역이면 같은 해시, 하나라도 다르면 다른 해시", async () => {
  const a = await evidenceHash("또래와 다투다 스스로 화해함", "또래관계");
  assertEquals(a, await evidenceHash("또래와 다투다 스스로 화해함", "또래관계"));

  // 본문이 바뀌면
  assertNotEquals(a, await evidenceHash("또래와 다투다 스스로 화해함.", "또래관계"));
  // 영역이 바뀌면 — 그 근거가 다른 칸으로 옮겨 간 것이라 평가 쓴 사람이 알아야 한다
  assertNotEquals(a, await evidenceHash("또래와 다투다 스스로 화해함", "행동정서"));
});

Deno.test("영역 미지정 관찰은 스냅샷에 담지 않는다", async () => {
  const snapshot = await buildSnapshot([
    { id: "b", area: "건강", content: "가" },
    { id: "a", area: null, content: "나" },
  ]);
  assertEquals(snapshot.length, 1);
  assertEquals(snapshot[0].obs_id, "b");
});

Deno.test("스냅샷은 obs_id 순이다 — 순서만 바뀐 것으로 시끄럽지 않게", async () => {
  const rows = [
    { id: "c", area: "건강", content: "1" },
    { id: "a", area: "학습", content: "2" },
    { id: "b", area: "연계", content: "3" },
  ];
  const snapshot = await buildSnapshot(rows);
  assertEquals(snapshot.map((one) => one.obs_id), ["a", "b", "c"]);
});

Deno.test("견주기 — 수정·추가·사라짐", () => {
  const snapshot = [
    { obs_id: "a", content_hash: "1111" },
    { obs_id: "b", content_hash: "2222" },
    { obs_id: "c", content_hash: "3333" },
  ];
  const current = [
    { obs_id: "a", content_hash: "1111" }, // 그대로
    { obs_id: "b", content_hash: "9999" }, // 고쳐짐
    { obs_id: "d", content_hash: "4444" }, // 새로 들어옴
  ]; // c 는 사라짐

  const diff = diffSnapshot(snapshot, current);
  assertEquals(diff.modified, ["b"]);
  assertEquals(diff.added, ["d"]);
  assertEquals(diff.removed, ["c"]);
  assertEquals(countChanges(diff), 3);
});

Deno.test("바뀐 것이 없으면 0", () => {
  const same = [{ obs_id: "a", content_hash: "1111" }];
  assertEquals(countChanges(diffSnapshot(same, same)), 0);
});

Deno.test("빈 스냅샷과 빈 현재 — 관찰이 하나도 없던 반기", () => {
  assertEquals(countChanges(diffSnapshot([], [])), 0);
  assertEquals(diffSnapshot([], [{ obs_id: "a", content_hash: "1" }]).added, ["a"]);
});

Deno.test("모양이 아니면 null — 추적 이전 평가와 같게 다룬다", () => {
  assertEquals(readSnapshot([{ obs_id: "a", content_hash: "1" }])?.length, 1);
  assertEquals(readSnapshot([]), []);
  assertEquals(readSnapshot(null), null);
  assertEquals(readSnapshot("스냅샷"), null);
  assertEquals(readSnapshot([{ obs_id: "a" }]), null);
  assertEquals(readSnapshot([{ obs_id: 1, content_hash: "1" }]), null);
});
