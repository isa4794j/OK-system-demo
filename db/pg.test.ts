import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  buildQuery,
  ident,
  parseLogic,
  parseSelect,
  PgBuildError,
  type QueryState,
  splitTop,
} from "./pg.ts";

const meta = {
  columns: new Map([
    [
      "journals",
      new Map([
        ["id", "uuid"],
        ["title", "text"],
        ["content", "text"],
        ["author_id", "uuid"],
        ["schedule_id", "uuid"],
        ["journal_date", "date"],
        ["created_at", "timestamp with time zone"],
        ["kind", "text"],
      ]),
    ],
    [
      "staff",
      new Map([["id", "uuid"], ["name", "text"], ["role", "text"], ["roles", "text[]"], [
        "status",
        "text",
      ]]),
    ],
    [
      "schedules",
      new Map([["id", "uuid"], ["staff_id", "uuid"], ["start_time", "time without time zone"]]),
    ],
    ["journal_observations", new Map([["id", "uuid"], ["journal_id", "uuid"], ["area", "text"]])],
    ["settings", new Map([["key", "text"], ["value", "jsonb"]])],
  ]),
  fks: [
    {
      src: "journals",
      col: "author_id",
      dst: "staff",
      dstCol: "id",
      name: "journals_author_id_fkey",
    },
    {
      src: "journals",
      col: "schedule_id",
      dst: "schedules",
      dstCol: "id",
      name: "journals_schedule_id_fkey",
    },
    {
      src: "schedules",
      col: "staff_id",
      dst: "staff",
      dstCol: "id",
      name: "schedules_staff_id_fkey",
    },
    {
      src: "journal_observations",
      col: "journal_id",
      dst: "journals",
      dstCol: "id",
      name: "jo_journal_fkey",
    },
  ],
  procs: new Map([["delete_child_cascade", new Map([["p_child_id", "uuid"]])]]),
};

function state(partial: Partial<QueryState>): QueryState {
  return {
    table: "journals",
    mode: "select",
    select: null,
    countExact: false,
    head: false,
    filters: [],
    embedFilters: [],
    orders: [],
    limit: null,
    offset: null,
    payload: null,
    onConflict: null,
    ...partial,
  };
}

Deno.test("pg — 괄호 밖 쉼표로만 나눈다(따옴표 안 쉼표·괄호 무시)", () => {
  assertEquals(splitTop(`a,b(c,d),"x,(y",e`), ["a", "b(c,d)", `"x,(y"`, "e"]);
  assertThrows(() => splitTop("a(b"), PgBuildError);
});

Deno.test("pg — select: 별칭·끼워 읽기·건수·inner", () => {
  const items = parseSelect(
    "id, author:staff(name, role), schedule:schedules(start_time), journal_observations(count), schedules!inner(staff_id)",
  );
  assertEquals(items.length, 5);
  assertEquals(items[1], {
    kind: "embed",
    table: "staff",
    alias: "author",
    inner: false,
    hint: null,
    items: [{ kind: "column", name: "name", alias: "name" }, {
      kind: "column",
      name: "role",
      alias: "role",
    }],
  });
  assertEquals(items[3].kind === "embed" && items[3].items[0].kind, "count");
  assertEquals(items[4].kind === "embed" && items[4].inner, true);
  assertThrows(() => parseSelect("id; drop table x"), PgBuildError);
});

Deno.test("pg — or 논리식: 따옴표 값·in 목록·and 묶음·빈 값·not", () => {
  const conds = parseLogic(
    `content.ilike."%a,b\\"c%",author_id.in.("x","y"),and(at.eq."2026-01-01",id.lt."z"),actor.eq.,actor.is.null,x.not.is.null`,
  );
  assertEquals(conds[0], {
    kind: "cmp",
    column: "content",
    op: "ilike",
    negate: false,
    value: '%a,b"c%',
  });
  assertEquals(conds[1], {
    kind: "cmp",
    column: "author_id",
    op: "in",
    negate: false,
    value: ["x", "y"],
  });
  assertEquals(conds[2].kind, "group");
  assertEquals(conds[3], { kind: "cmp", column: "actor", op: "eq", negate: false, value: "" });
  assertEquals(conds[4], { kind: "cmp", column: "actor", op: "is", negate: false, value: null });
  assertEquals(conds[5], { kind: "cmp", column: "x", op: "is", negate: true, value: null });
});

Deno.test("pg — 이름은 규칙에 맞는 것만(따옴표로 감쌈)", () => {
  assertEquals(ident("author_id"), `"author_id"`);
  for (const bad of ['a"b', "A", "a b", "a;b", "1a", ""]) {
    assertThrows(() => ident(bad), PgBuildError);
  }
});

Deno.test("pg — select SQL: 값은 파라미터·타입 캐스팅, 관계는 하위쿼리", () => {
  const built = buildQuery(
    meta,
    state({
      select: "id, title, author:staff(name), journal_observations(count)",
      filters: [
        { kind: "cmp", column: "kind", op: "eq", negate: false, value: "봉사'; drop" },
        { kind: "cmp", column: "author_id", op: "in", negate: false, value: ["a", "b"] },
      ],
      orders: [{ column: "journal_date", ascending: false }],
      limit: 16,
      countExact: true,
    }),
  );
  assert(!built.text.includes("drop"));
  assertEquals(built.values, ["봉사'; drop", "a", "b"]);
  assert(built.text.includes(`t0."kind" = $1::text`));
  assert(built.text.includes(`t0."author_id" in ($2::text::uuid, $3::text::uuid)`));
  assert(built.text.includes(`t1."id" = t0."author_id"`)); // to-one
  assert(built.text.includes(`json_build_array(json_build_object('count'`)); // to-many count
  assert(built.text.includes(`order by t0."journal_date" desc limit 16`));
  assert(built.countText?.startsWith("select count(*)"));
});

Deno.test("pg — inner 끼워 읽기와 그 표 조건은 exists 로", () => {
  const built = buildQuery(
    meta,
    state({
      select: "id, schedules!inner(staff_id)",
      embedFilters: [{
        path: "schedules",
        cond: { kind: "cmp", column: "staff_id", op: "eq", negate: false, value: "s1" },
      }],
      head: true,
      countExact: true,
    }),
  );
  assert(built.countText?.includes('exists (select 1 from "schedules"'));
  assert(built.countText?.includes(`t1."staff_id" = $1::text::uuid`));
});

Deno.test("pg — 빈 in 은 거짓, is 는 정해진 값만, 없는 칸은 오류", () => {
  const empty = buildQuery(
    meta,
    state({ filters: [{ kind: "cmp", column: "id", op: "in", negate: false, value: [] }] }),
  );
  assert(empty.text.includes("(false)"));
  assertThrows(
    () =>
      buildQuery(
        meta,
        state({ filters: [{ kind: "cmp", column: "id", op: "is", negate: false, value: "1; x" }] }),
      ),
    PgBuildError,
  );
  assertThrows(
    () =>
      buildQuery(
        meta,
        state({ filters: [{ kind: "cmp", column: "nope", op: "eq", negate: false, value: "1" }] }),
      ),
    PgBuildError,
  );
  assertThrows(() => buildQuery(meta, state({ table: "nope" })), PgBuildError);
});

Deno.test("pg — 쓰기: insert 빠진 칸은 default, upsert 는 on conflict, 배열·json 캐스팅", () => {
  const ins = buildQuery(
    meta,
    state({
      table: "staff",
      mode: "insert",
      select: "id, name",
      payload: [{ name: "가", roles: ["멘토", 'a"b'] }, { name: "나", status: "활동중" }],
    }),
  );
  assert(
    ins.text.includes(
      `insert into "staff" ("name", "roles", "status") values ($1::text, $2::text::text[], default), ($3::text, default, $4::text)`,
    ),
  );
  assertEquals(ins.values[1], `{"멘토","a\\"b"}`);
  const up = buildQuery(
    meta,
    state({
      table: "settings",
      mode: "upsert",
      payload: { key: "k", value: { a: [1] } },
      onConflict: "key",
    }),
  );
  assert(up.text.includes(`on conflict ("key") do update set "value" = excluded."value"`));
  assertEquals(up.values, ["k", `{"a":[1]}`]);
  const upd = buildQuery(
    meta,
    state({
      table: "staff",
      mode: "update",
      payload: { name: "다" },
      filters: [{ kind: "cmp", column: "id", op: "eq", negate: false, value: "x" }],
    }),
  );
  assert(upd.text.includes(`set "name" = $1::text where (t0."id" = $2::text::uuid)`));
  const del = buildQuery(
    meta,
    state({
      mode: "delete",
      filters: [{ kind: "cmp", column: "id", op: "eq", negate: false, value: "x" }],
    }),
  );
  assert(
    del.text.includes(`delete from "journals" t0 where (t0."id" = $1::text::uuid) returning t0.*`),
  );
  assertThrows(() => buildQuery(meta, state({ mode: "update", payload: {} })), PgBuildError);
});
