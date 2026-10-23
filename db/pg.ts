/**
 * Postgres 직결 클라이언트 — supabase-js 와 같은 호출 모양(쓰는 만큼만)을 SQL 로 바꿔 실행한다
 *
 * [왜 이 모양인가]
 * /db 의 25개 파일은 supabase-js 문법(from·select·eq·or·rpc …)으로 적혀 있다.
 * DB 를 애저 PostgreSQL 로 옮기면서 그 호출을 하나하나 SQL 로 다시 쓰는 대신,
 * 같은 모양을 받아 SQL 로 바꾸는 층을 여기 하나 둔다. 그러면
 *   - Supabase(직결 주소)와 애저가 같은 코드로 돈다 — 접속은 DATABASE_URL 하나
 *   - 옛 경로(supabase-js)와 새 경로(여기)의 결과를 나란히 대조할 수 있다
 * db/client.ts 의 getClient() 가 DATABASE_URL 이 있으면 이것을, 없으면 supabase-js 를 준다.
 *
 * [결과 모양은 PostgREST 와 같게]
 * 행을 json_agg(to_json(…)) 로 받는다 — 날짜·시각이 PostgREST 와 같은 ISO 글자, 숫자는 숫자,
 * json 칸은 그대로 객체. 관계 끼워 읽기(author:staff(name))는 상관 하위쿼리로 같은 모양을 만든다.
 *
 * [값은 늘 파라미터 + 컬럼 타입 캐스팅]
 * 사람이 적은 글이 SQL 에 섞이지 않게 모든 값은 $n 으로 보내고, 컬럼 타입(format_type)으로 캐스팅한다.
 * 컬럼 이름·표 이름은 코드가 준 것만 받는다(글자 규칙 검사 + 따옴표).
 *
 * 지원하는 것: 이 저장소의 /db 가 실제로 쓰는 것만(select·insert·update·upsert·delete·rpc,
 * eq·neq·gt·gte·lt·lte·like·ilike·is·in·not·or·overlaps, order·limit·range, single·maybeSingle,
 * count exact·head). 모르는 것을 부르면 조용히 무시하지 않고 오류를 낸다.
 */
import postgres from "postgres";

/** SQL 을 실행하는 쪽 — 운영은 postgres.js, 대조 시험은 다른 실행기(PGlite)도 끼울 수 있다 */
export type Sql = {
  // deno-lint-ignore no-explicit-any
  unsafe(text: string, values?: (string | null)[]): PromiseLike<any[]>;
};

export type PgError = {
  message: string;
  code?: string;
  details?: string | null;
  hint?: string | null;
};
export type PgResult = {
  data: unknown;
  error: PgError | null;
  count: number | null;
  status: number;
};

/* ---------- 접속 ---------- */

let sqlClient: Sql | null = null;

export function connect(url: string): Sql {
  if (sqlClient) return sqlClient;
  sqlClient = postgres(url, {
    max: Number(Deno.env.get("DATABASE_POOL_MAX") ?? 5),
    // 풀러(Supabase·PgBouncer)에서도 돌게 — 이름 붙은 준비문을 쓰지 않는다
    prepare: false,
    idle_timeout: 30,
    connect_timeout: 15,
    onnotice: () => {},
    // 시각 글자(to_json)를 Supabase 와 같은 UTC(+00:00)로 — 서버 기본 시간대에 기대지 않는다
    connection: { TimeZone: "UTC" },
    // 결과는 전부 json 한 칸으로 받으므로 타입 변환은 json 만 쓴다
  });
  return sqlClient;
}

/* ---------- 스키마 정보(한 번 읽어 기억) ---------- */

type Fk = { src: string; col: string; dst: string; dstCol: string; name: string };
type Meta = {
  columns: Map<string, Map<string, string>>;
  fks: Fk[];
  procs: Map<string, Map<string, string>>;
};

let metaPromise: Promise<Meta> | null = null;

async function loadMeta(sql: Sql): Promise<Meta> {
  const cols = await sql.unsafe(
    `select c.relname as tbl, a.attname as col, format_type(a.atttypid, a.atttypmod) as typ
       from pg_attribute a join pg_class c on c.oid = a.attrelid
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r','v','m','p') and a.attnum > 0 and not a.attisdropped`,
  );
  const columns = new Map<string, Map<string, string>>();
  for (const row of cols) {
    const t = columns.get(row.tbl) ?? new Map<string, string>();
    t.set(row.col, row.typ);
    columns.set(row.tbl, t);
  }
  const fkRows = await sql.unsafe(
    `select src.relname as src, a.attname as col, dst.relname as dst, af.attname as dst_col, c.conname as name
       from pg_constraint c
       join pg_class src on src.oid = c.conrelid
       join pg_class dst on dst.oid = c.confrelid
       join pg_namespace n on n.oid = c.connamespace
       join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
       join pg_attribute af on af.attrelid = c.confrelid and af.attnum = c.confkey[1]
      where c.contype = 'f' and n.nspname = 'public' and array_length(c.conkey, 1) = 1`,
  );
  const fks = fkRows.map((r) => ({
    src: r.src,
    col: r.col,
    dst: r.dst,
    dstCol: r.dst_col,
    name: r.name,
  }));
  const procRows = await sql.unsafe(
    `select p.proname as name, coalesce(p.proargnames, '{}') as argnames,
            array(select format_type(t, null) from unnest(p.proargtypes) as t) as argtypes
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'`,
  );
  const procs = new Map<string, Map<string, string>>();
  for (const r of procRows) {
    const args = new Map<string, string>();
    (r.argnames as string[]).forEach((argName: string, i: number) =>
      args.set(argName, (r.argtypes as string[])[i])
    );
    procs.set(r.name, args);
  }
  return { columns, fks, procs };
}

function meta(sql: Sql): Promise<Meta> {
  metaPromise ??= loadMeta(sql).catch((error) => {
    metaPromise = null;
    throw error;
  });
  return metaPromise;
}

/** 테스트 전용 — 스키마 정보를 직접 넣는다(DB 없이 SQL 만들기 검사) */
export function setMetaForTest(value: Meta | null): void {
  metaPromise = value ? Promise.resolve(value) : null;
}

/* ---------- 이름 ---------- */

const NAME = /^[a-z_][a-z0-9_]*$/;

export function ident(name: string): string {
  if (!NAME.test(name)) throw new PgBuildError(`이름으로 쓸 수 없는 글자: ${name}`);
  return `"${name}"`;
}

export class PgBuildError extends Error {}

/* ---------- select 글 풀기 ---------- */

export type SelectItem =
  | { kind: "star" }
  | { kind: "column"; name: string; alias: string }
  | {
    kind: "embed";
    table: string;
    alias: string;
    inner: boolean;
    hint: string | null;
    items: SelectItem[];
  }
  | { kind: "count" };

/** 괄호 밖의 쉼표로 나눈다 */
export function splitTop(text: string, sep = ","): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      current += ch;
      if (ch === "\\" && i + 1 < text.length) current += text[++i];
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === sep && depth === 0) {
      out.push(current);
      current = "";
    } else current += ch;
  }
  if (depth !== 0 || quoted) throw new PgBuildError(`괄호·따옴표가 맞지 않습니다: ${text}`);
  out.push(current);
  return out.map((part) => part.trim()).filter((part) => part !== "");
}

export function parseSelect(text: string): SelectItem[] {
  return splitTop(text.replace(/\s+/g, " ")).map((part): SelectItem => {
    if (part === "*") return { kind: "star" };
    if (part === "count") return { kind: "count" };
    const open = part.indexOf("(");
    if (open < 0) {
      const [alias, name] = part.includes(":")
        ? part.split(":").map((s) => s.trim())
        : [part, part];
      ident(name);
      ident(alias);
      return { kind: "column", name, alias };
    }
    if (!part.endsWith(")")) throw new PgBuildError(`select 모양이 올바르지 않습니다: ${part}`);
    let head = part.slice(0, open).trim();
    const inside = part.slice(open + 1, -1);
    let alias: string | null = null;
    if (head.includes(":")) [alias, head] = head.split(":").map((s) => s.trim());
    const [table, ...mods] = head.split("!");
    let inner = false;
    let hint: string | null = null;
    for (const mod of mods) {
      if (mod === "inner") inner = true;
      else if (mod === "left") inner = false;
      else hint = mod;
    }
    ident(table);
    return { kind: "embed", table, alias: alias ?? table, inner, hint, items: parseSelect(inside) };
  });
}

/* ---------- or(...) 글 풀기 (PostgREST 논리식) ---------- */

export type Cond =
  | { kind: "cmp"; column: string; op: string; negate: boolean; value: string | string[] | null }
  | { kind: "group"; op: "and" | "or"; negate: boolean; items: Cond[] };

function unquote(value: string): string {
  const v = value.trim();
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    return v.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return v;
}

export function parseLogic(text: string): Cond[] {
  return splitTop(text).map((part): Cond => {
    const group = part.match(/^(not\.)?(and|or)\((.*)\)$/s);
    if (group) {
      return {
        kind: "group",
        op: group[2] as "and" | "or",
        negate: Boolean(group[1]),
        items: parseLogic(group[3]),
      };
    }
    const first = part.indexOf(".");
    if (first < 0) throw new PgBuildError(`조건 모양이 올바르지 않습니다: ${part}`);
    const column = part.slice(0, first);
    let rest = part.slice(first + 1);
    let negate = false;
    if (rest.startsWith("not.")) {
      negate = true;
      rest = rest.slice(4);
    }
    const dot = rest.indexOf(".");
    if (dot < 0) throw new PgBuildError(`조건 모양이 올바르지 않습니다: ${part}`);
    const op = rest.slice(0, dot);
    const raw = rest.slice(dot + 1);
    let value: string | string[] | null;
    if (op === "in") {
      if (!raw.startsWith("(") || !raw.endsWith(")")) {
        throw new PgBuildError(`in 값은 (…) 이어야 합니다: ${part}`);
      }
      value = raw.slice(1, -1).trim() === "" ? [] : splitTop(raw.slice(1, -1)).map(unquote);
    } else if (op === "is") {
      value = raw === "null" ? null : raw;
    } else {
      value = unquote(raw);
    }
    return { kind: "cmp", column, op, negate, value };
  });
}

/* ---------- SQL 조각 만들기 ---------- */

class Params {
  values: (string | null)[] = [];
  add(value: unknown, type: string): string {
    this.values.push(toText(value, type));
    // 실행기(postgres.js·PGlite)는 파라미터 타입을 보고 값을 제 방식으로 직렬화한다(불리언·json 등).
    // 늘 글자로 받게 하고 SQL 안에서 캐스팅한다 — 값 모양이 실행기에 따라 달라지지 않는다.
    const target = castType(type);
    return target === "text"
      ? `$${this.values.length}::text`
      : `$${this.values.length}::text::${target}`;
  }
}

/** 캐스팅에 쓸 타입 이름 — 길이 제한(varchar(20))은 떼어 낸다 */
function castType(type: string): string {
  return type.replace(/\(\d+(,\d+)?\)/g, "");
}

function pgArrayLiteral(values: unknown[]): string {
  const parts = values.map((v) => {
    if (v === null || v === undefined) return "NULL";
    const s = String(v);
    return `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  });
  return `{${parts.join(",")}}`;
}

function toText(value: unknown, type: string): string | null {
  if (value === null || value === undefined) return null;
  if (type === "json" || type === "jsonb") return JSON.stringify(value);
  if (type.endsWith("[]")) {
    if (!Array.isArray(value)) {
      throw new PgBuildError(`배열 칸에 배열이 아닌 값: ${JSON.stringify(value)}`);
    }
    return pgArrayLiteral(value);
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

type Scope = { table: string; alias: string };

function columnType(m: Meta, table: string, column: string): string {
  const type = m.columns.get(table)?.get(column);
  if (!type) throw new PgBuildError(`${table} 표에 ${column} 칸이 없습니다.`);
  return type;
}

const OPS: Record<string, string> = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };

function cmpSql(m: Meta, scope: Scope, c: Extract<Cond, { kind: "cmp" }>, p: Params): string {
  const type = columnType(m, scope.table, c.column);
  const col = `${scope.alias}.${ident(c.column)}`;
  let expr: string;
  if (c.op in OPS) {
    expr = `${col} ${OPS[c.op]} ${p.add(c.value, type)}`;
  } else if (c.op === "like" || c.op === "ilike") {
    expr = `${col}::text ${c.op === "like" ? "like" : "ilike"} ${p.add(c.value, "text")}`;
  } else if (c.op === "is") {
    const v = c.value === null ? "null" : String(c.value).toLowerCase();
    if (!["null", "true", "false", "unknown"].includes(v)) {
      throw new PgBuildError(`is 값이 올바르지 않습니다: ${v}`);
    }
    expr = `${col} is ${v}`;
  } else if (c.op === "in") {
    const list = Array.isArray(c.value) ? c.value : [];
    expr = list.length === 0
      ? "false"
      : `${col} in (${list.map((v) => p.add(v, type)).join(", ")})`;
  } else if (c.op === "ov") {
    expr = `${col} && ${p.add(c.value, type)}`;
  } else if (c.op === "cs") {
    expr = `${col} @> ${p.add(c.value, type)}`;
  } else {
    throw new PgBuildError(`지원하지 않는 비교: ${c.op}`);
  }
  return c.negate ? `not (${expr})` : expr;
}

function condSql(m: Meta, scope: Scope, c: Cond, p: Params): string {
  if (c.kind === "cmp") return cmpSql(m, scope, c, p);
  if (c.items.length === 0) return c.op === "and" ? "true" : "false";
  const inner = c.items.map((item) => `(${condSql(m, scope, item, p)})`).join(` ${c.op} `);
  return c.negate ? `not (${inner})` : inner;
}

/* ---------- 관계 찾기 ---------- */

type Relation = { toOne: boolean; join: (child: string, parent: string) => string };

function findRelation(
  m: Meta,
  base: string,
  target: string,
  alias: string,
  hint: string | null,
): Relation {
  const pick = (list: Fk[], byCol: (fk: Fk) => string): Fk => {
    let found = list;
    if (hint) found = list.filter((fk) => fk.name === hint || fk.col === hint);
    if (found.length > 1) {
      const guess = found.filter((fk) => [alias, `${alias}_id`].includes(byCol(fk)));
      if (guess.length === 1) found = guess;
    }
    if (found.length !== 1) {
      throw new PgBuildError(
        `${base} ↔ ${target} 관계를 하나로 정할 수 없습니다(${found.length}개).`,
      );
    }
    return found[0];
  };
  const forward = m.fks.filter((fk) => fk.src === base && fk.dst === target);
  if (forward.length) {
    const fk = pick(forward, (x) => x.col);
    return {
      toOne: true,
      join: (child, parent) => `${child}.${ident(fk.dstCol)} = ${parent}.${ident(fk.col)}`,
    };
  }
  const reverse = m.fks.filter((fk) => fk.src === target && fk.dst === base);
  if (reverse.length) {
    const fk = pick(reverse, (x) => x.col);
    return {
      toOne: false,
      join: (child, parent) => `${child}.${ident(fk.col)} = ${parent}.${ident(fk.dstCol)}`,
    };
  }
  throw new PgBuildError(`${base} 와 ${target} 사이에 외래키가 없습니다.`);
}

/* ---------- select 목록 → SQL ---------- */

type EmbedFilter = { path: string; cond: Cond };

class Aliases {
  n = 0;
  next(): string {
    return `t${++this.n}`;
  }
}

function selectList(
  m: Meta,
  scope: Scope,
  items: SelectItem[],
  p: Params,
  aliases: Aliases,
  embedFilters: EmbedFilter[],
  path: string,
  wheres: string[],
): string {
  const parts: string[] = [];
  for (const item of items) {
    if (item.kind === "star") parts.push(`${scope.alias}.*`);
    else if (item.kind === "column") {
      columnType(m, scope.table, item.name);
      parts.push(`${scope.alias}.${ident(item.name)} as ${ident(item.alias)}`);
    } else if (item.kind === "count") {
      throw new PgBuildError("count 는 끼워 읽기 안에서만 씁니다.");
    } else {
      const rel = findRelation(m, scope.table, item.table, item.alias, item.hint);
      const child: Scope = { table: item.table, alias: aliases.next() };
      const myPath = path ? `${path}.${item.alias}` : item.alias;
      const filters = embedFilters
        .filter((f) => f.path === myPath || f.path === item.table)
        .map((f) => condSql(m, child, f.cond, p));
      const where = [rel.join(child.alias, scope.alias), ...filters].join(" and ");
      const from = `${ident(item.table)} ${child.alias}`;
      if (item.inner) wheres.push(`exists (select 1 from ${from} where ${where})`);
      const onlyCount = item.items.length === 1 && item.items[0].kind === "count";
      if (onlyCount) {
        const expr = `(select count(*) from ${from} where ${where})`;
        parts.push(
          rel.toOne
            ? `json_build_object('count', ${expr}) as ${ident(item.alias)}`
            : `json_build_array(json_build_object('count', ${expr})) as ${ident(item.alias)}`,
        );
        continue;
      }
      const innerWheres: string[] = [];
      const cols = selectList(m, child, item.items, p, aliases, embedFilters, myPath, innerWheres);
      const fullWhere = [where, ...innerWheres].join(" and ");
      const sub = `select ${cols} from ${from} where ${fullWhere}`;
      parts.push(
        rel.toOne
          ? `(select to_json(s) from (${sub} limit 1) s) as ${ident(item.alias)}`
          : `(select coalesce(json_agg(s), '[]'::json) from (${sub}) s) as ${ident(item.alias)}`,
      );
    }
  }
  return parts.join(", ");
}

/* ---------- 질의 만들기 ---------- */

type Order = { column: string; ascending: boolean; nullsFirst?: boolean };
type Mode = "select" | "insert" | "update" | "upsert" | "delete";

export type Built = { text: string; values: (string | null)[]; countText?: string };

export type QueryState = {
  table: string;
  mode: Mode;
  select: string | null;
  countExact: boolean;
  head: boolean;
  filters: Cond[];
  embedFilters: EmbedFilter[];
  orders: Order[];
  limit: number | null;
  offset: number | null;
  payload: unknown;
  onConflict: string | null;
};

export function buildQuery(m: Meta, q: QueryState): Built {
  if (!m.columns.has(q.table)) throw new PgBuildError(`${q.table} 표가 없습니다.`);
  const p = new Params();
  const aliases = new Aliases();
  const base: Scope = { table: q.table, alias: "t0" };
  const wheres: string[] = [];
  const items = parseSelect(q.select ?? "*");
  const cols = selectList(m, base, items, p, aliases, q.embedFilters, "", wheres);
  for (const f of q.filters) wheres.push(condSql(m, base, f, p));
  const whereSql = wheres.length ? ` where ${wheres.map((w) => `(${w})`).join(" and ")}` : "";
  const orderSql = q.orders.length
    ? ` order by ${
      q.orders.map((o) => {
        columnType(m, q.table, o.column);
        const nulls = o.nullsFirst === undefined
          ? ""
          : o.nullsFirst
          ? " nulls first"
          : " nulls last";
        return `t0.${ident(o.column)} ${o.ascending ? "asc" : "desc"}${nulls}`;
      }).join(", ")
    }`
    : "";
  const limitSql = `${q.limit !== null ? ` limit ${q.limit}` : ""}${
    q.offset ? ` offset ${q.offset}` : ""
  }`;

  if (q.mode === "select") {
    const inner = `select ${cols} from ${ident(q.table)} t0${whereSql}${orderSql}${limitSql}`;
    const text = q.head
      ? "select null::json as data"
      : `select coalesce(json_agg(q), '[]'::json) as data from (${inner}) q`;
    const countText = q.countExact
      ? `select count(*)::int as n from ${ident(q.table)} t0${whereSql}`
      : undefined;
    return { text, values: p.values, countText };
  }

  let mutation: string;
  if (q.mode === "delete") {
    mutation = `delete from ${ident(q.table)} t0${whereSql} returning t0.*`;
  } else if (q.mode === "update") {
    const patch = q.payload as Record<string, unknown>;
    const keys = Object.keys(patch ?? {});
    if (keys.length === 0) throw new PgBuildError("바꿀 칸이 없습니다.");
    // set 절의 파라미터가 where 보다 먼저 번호를 받도록 새로 만든다
    const p2 = new Params();
    p2.values = [];
    const sets = keys.map((k) => `${ident(k)} = ${p2.add(patch[k], columnType(m, q.table, k))}`);
    const wh2: string[] = [];
    const cols2 = selectList(m, base, items, p2, new Aliases(), q.embedFilters, "", wh2);
    for (const f of q.filters) wh2.push(condSql(m, base, f, p2));
    const where2 = wh2.length ? ` where ${wh2.map((w) => `(${w})`).join(" and ")}` : "";
    const text =
      `with m as (update ${ident(q.table)} t0 set ${sets.join(", ")}${where2} returning t0.*) ` +
      `select coalesce((select json_agg(q) from (select ${cols2} from m t0) q), '[]'::json) as data, ` +
      `(select count(*)::int from m) as n`;
    return { text, values: p2.values };
  } else {
    const rows = (Array.isArray(q.payload) ? q.payload : [q.payload]) as Record<string, unknown>[];
    if (rows.length === 0) throw new PgBuildError("넣을 줄이 없습니다.");
    const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const p2 = new Params();
    const valuesSql = rows.map((r) =>
      `(${
        keys.map((
          k,
        ) => (k in r && r[k] !== undefined ? p2.add(r[k], columnType(m, q.table, k)) : "default"))
          .join(", ")
      })`
    ).join(", ");
    let conflict = "";
    if (q.mode === "upsert") {
      const target = (q.onConflict ?? "id").split(",").map((s) => s.trim());
      target.forEach(ident);
      const updates = keys.filter((k) => !target.includes(k));
      conflict = ` on conflict (${target.map(ident).join(", ")}) ` +
        (updates.length
          ? `do update set ${updates.map((k) => `${ident(k)} = excluded.${ident(k)}`).join(", ")}`
          : "do nothing");
    }
    mutation = `insert into ${ident(q.table)} (${
      keys.map(ident).join(", ")
    }) values ${valuesSql}${conflict} returning *`;
    const cols2 = selectList(m, base, items, p2, new Aliases(), q.embedFilters, "", []);
    const text = `with m as (${mutation}) ` +
      `select coalesce((select json_agg(q) from (select ${cols2} from m t0) q), '[]'::json) as data, ` +
      `(select count(*)::int from m) as n`;
    return { text, values: p2.values };
  }
  const text = `with m as (${mutation}) ` +
    `select coalesce((select json_agg(q) from (select ${cols} from m t0) q), '[]'::json) as data, ` +
    `(select count(*)::int from m) as n`;
  return { text, values: p.values };
}

/* ---------- 실행 ---------- */

function toError(error: unknown): PgError {
  if (error instanceof PgBuildError) return { message: error.message, code: "PGRST100" };
  const e = error as { message?: string; code?: string; detail?: string; hint?: string };
  return {
    message: e?.message ?? String(error),
    code: e?.code,
    details: e?.detail ?? null,
    hint: e?.hint ?? null,
  };
}

const NOT_ONE: PgError = {
  code: "PGRST116",
  message: "JSON object requested, multiple (or no) rows returned",
  details: null,
  hint: null,
};

class QueryBuilder implements PromiseLike<PgResult> {
  private q: QueryState;
  private singleMode: "one" | "maybe" | null = null;
  private selected = false;

  constructor(private sql: Sql, table: string) {
    this.q = {
      table,
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
    };
  }

  select(columns = "*", options?: { count?: string; head?: boolean }): this {
    this.q.select = columns;
    this.selected = true;
    if (options?.count) {
      if (options.count !== "exact") {
        throw new PgBuildError(`count: ${options.count} 는 지원하지 않습니다.`);
      }
      this.q.countExact = true;
    }
    if (options?.head) this.q.head = true;
    return this;
  }
  insert(values: unknown, options?: { count?: string }): this {
    this.q.mode = "insert";
    this.q.payload = values;
    if (options?.count) this.q.countExact = true;
    return this;
  }
  upsert(values: unknown, options?: { onConflict?: string; count?: string }): this {
    this.q.mode = "upsert";
    this.q.payload = values;
    this.q.onConflict = options?.onConflict ?? null;
    if (options?.count) this.q.countExact = true;
    return this;
  }
  update(values: unknown, options?: { count?: string }): this {
    this.q.mode = "update";
    this.q.payload = values;
    if (options?.count) this.q.countExact = true;
    return this;
  }
  delete(options?: { count?: string }): this {
    this.q.mode = "delete";
    if (options?.count) this.q.countExact = true;
    return this;
  }

  private add(column: string, op: string, value: unknown, negate = false): this {
    const dot = column.indexOf(".");
    const cond: Cond = {
      kind: "cmp",
      column: dot < 0 ? column : column.slice(dot + 1),
      op,
      negate,
      value: value as string | string[] | null,
    };
    if (dot < 0) this.q.filters.push(cond);
    else this.q.embedFilters.push({ path: column.slice(0, dot), cond });
    return this;
  }
  eq(c: string, v: unknown) {
    return this.add(c, "eq", v);
  }
  neq(c: string, v: unknown) {
    return this.add(c, "neq", v);
  }
  gt(c: string, v: unknown) {
    return this.add(c, "gt", v);
  }
  gte(c: string, v: unknown) {
    return this.add(c, "gte", v);
  }
  lt(c: string, v: unknown) {
    return this.add(c, "lt", v);
  }
  lte(c: string, v: unknown) {
    return this.add(c, "lte", v);
  }
  like(c: string, v: string) {
    return this.add(c, "like", v);
  }
  ilike(c: string, v: string) {
    return this.add(c, "ilike", v);
  }
  is(c: string, v: unknown) {
    return this.add(c, "is", v === null ? null : String(v));
  }
  in(c: string, v: unknown[]) {
    return this.add(c, "in", v);
  }
  overlaps(c: string, v: unknown[]) {
    return this.add(c, "ov", v);
  }
  contains(c: string, v: unknown[]) {
    return this.add(c, "cs", v);
  }
  not(c: string, op: string, v: unknown) {
    return this.add(c, op, op === "is" ? (v === null ? null : String(v)) : v, true);
  }
  or(text: string) {
    this.q.filters.push({ kind: "group", op: "or", negate: false, items: parseLogic(text) });
    return this;
  }
  order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }) {
    this.q.orders.push({
      column,
      ascending: options?.ascending ?? true,
      nullsFirst: options?.nullsFirst,
    });
    return this;
  }
  limit(n: number) {
    this.q.limit = Math.max(0, Math.floor(n));
    return this;
  }
  range(from: number, to: number) {
    this.q.offset = Math.max(0, Math.floor(from));
    this.q.limit = Math.max(0, Math.floor(to) - Math.floor(from) + 1);
    return this;
  }
  single() {
    this.singleMode = "one";
    return this;
  }
  maybeSingle() {
    this.singleMode = "maybe";
    return this;
  }

  async run(): Promise<PgResult> {
    try {
      const m = await meta(this.sql);
      const built = buildQuery(m, this.q);
      // head(건수만)는 행을 읽지 않는다
      const rows = this.q.mode === "select" && this.q.head
        ? [{ data: null }]
        : await this.sql.unsafe(built.text, built.values);
      let data = rows[0]?.data ?? null;
      let count: number | null = null;
      if (this.q.mode === "select") {
        if (built.countText) {
          const c = await this.sql.unsafe(built.countText, built.values);
          count = c[0]?.n ?? 0;
        }
      } else {
        if (this.q.countExact) count = rows[0]?.n ?? 0;
        // 쓰기는 .select() 를 붙였을 때만 행을 돌려준다(supabase-js 와 같다)
        if (!this.selected) data = null;
      }
      if (this.singleMode && Array.isArray(data)) {
        if (data.length === 1) data = data[0];
        else if (data.length === 0 && this.singleMode === "maybe") data = null;
        else return { data: null, error: NOT_ONE, count, status: 406 };
      } else if (this.singleMode && data === null && this.selected) {
        if (this.singleMode === "one") return { data: null, error: NOT_ONE, count, status: 406 };
      }
      return { data, error: null, count, status: 200 };
    } catch (error) {
      return { data: null, error: toError(error), count: null, status: 400 };
    }
  }

  then<A = PgResult, B = never>(
    onfulfilled?: ((value: PgResult) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return this.run().then(onfulfilled, onrejected);
  }
}

class RpcCall implements PromiseLike<PgResult> {
  constructor(private sql: Sql, private fn: string, private args: Record<string, unknown>) {}
  async run(): Promise<PgResult> {
    try {
      ident(this.fn);
      const m = await meta(this.sql);
      const sig = m.procs.get(this.fn);
      if (!sig) throw new PgBuildError(`DB 함수 ${this.fn} 이(가) 없습니다.`);
      const p = new Params();
      const parts = Object.entries(this.args ?? {}).map(([k, v]) => {
        const type = sig.get(k);
        if (!type) throw new PgBuildError(`${this.fn} 에 ${k} 인자가 없습니다.`);
        return `${ident(k)} => ${p.add(v, type)}`;
      });
      const rows = await this.sql.unsafe(
        `select to_json(${ident(this.fn)}(${parts.join(", ")})) as data`,
        p.values,
      );
      return { data: rows[0]?.data ?? null, error: null, count: null, status: 200 };
    } catch (error) {
      return { data: null, error: toError(error), count: null, status: 400 };
    }
  }
  then<A = PgResult, B = never>(
    onfulfilled?: ((value: PgResult) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return this.run().then(onfulfilled, onrejected);
  }
}

/** supabase-js 의 SupabaseClient 중 /db 가 쓰는 부분 */
export class PgClient {
  constructor(private sql: Sql) {}
  from(table: string): QueryBuilder {
    return new QueryBuilder(this.sql, table);
  }
  rpc(fn: string, args: Record<string, unknown> = {}): RpcCall {
    return new RpcCall(this.sql, fn, args);
  }
  /** 연결 확인·점검용 — 한 줄 */
  async ping(): Promise<void> {
    await this.sql.unsafe("select 1");
  }
}

export function createPgClient(url: string): PgClient {
  return new PgClient(connect(url));
}

/** 대조 시험용 — 실행기를 직접 넣는다. 스키마 정보는 그 실행기에서 새로 읽는다 */
export function createPgClientWith(executor: Sql): PgClient {
  metaPromise = null;
  return new PgClient(executor);
}
