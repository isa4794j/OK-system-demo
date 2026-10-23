import { assertEquals, assertMatch } from "@std/assert";
import {
  activeAreas,
  checkAreaEdit,
  checkAreaList,
  DEFAULT_OBS_AREAS,
  nextAreaCode,
  type ObsArea,
  readAreas,
} from "./obs_areas.ts";

const base = (): ObsArea[] => DEFAULT_OBS_AREAS.map((one) => ({ ...one }));

Deno.test("관찰 영역 — 저장값이 없거나 틀리면 처음 여섯 영역", () => {
  assertEquals(readAreas(null), DEFAULT_OBS_AREAS);
  assertEquals(readAreas([{ code: "x", name: "?" }]), DEFAULT_OBS_AREAS);
  assertEquals(activeAreas(DEFAULT_OBS_AREAS).length, 6);
});

Deno.test("관찰 영역 — 이름 바꾸기·지우기(deleted)·새 코드 더하기는 된다", () => {
  const next = base();
  next[0].name = "건강·위생";
  next[5].deleted = true;
  next.push({ code: nextAreaCode(next), name: "자립" });
  assertEquals(next[6].code, "a01");
  assertEquals(checkAreaEdit(base(), next), null);
  assertEquals(activeAreas(next).map((one) => one.code).includes("연계"), false);
});

Deno.test("관찰 영역 — 있던 코드를 빼면 거절(지난 관찰이 미지정으로 떨어지지 않게)", () => {
  const next = base().slice(1);
  assertMatch(checkAreaEdit(base(), next) ?? "", /빠졌습니다/);
});

Deno.test("관찰 영역 — 모양 검사", () => {
  assertMatch(checkAreaList([]) ?? "", /하나도/);
  assertMatch(checkAreaList([{ code: "b01", name: "x" }]) ?? "", /코드/);
  assertMatch(checkAreaList([...base(), { code: "a01", name: "건강" }]) ?? "", /같은 이름/);
  assertMatch(checkAreaList([...base(), { code: "a01", name: "미지정" }]) ?? "", /미지정/);
  assertMatch(checkAreaList(base().map((one) => ({ ...one, deleted: true }))) ?? "", /하나는/);
  // 지운 영역과 같은 이름으로 새로 더하는 것은 된다(코드가 다르다)
  const reuse = base();
  reuse[1].deleted = true;
  reuse.push({ code: "a01", name: "학습" });
  assertEquals(checkAreaList(reuse), null);
});

Deno.test("관찰 영역 — 새 코드는 지운 것까지 세어 다음 번호", () => {
  assertEquals(nextAreaCode([...base(), { code: "a07", name: "x", deleted: true }]), "a08");
});
