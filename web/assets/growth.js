/**
 * 성장 추이 — 아동 상세의 반기 관찰 모아 보기
 *
 * 봉사자·멘토가 반기마다 적은 점수를 반기 축으로 늘어놓는다.
 *
 * [평균으로 뭉개지 않는다]
 * 반기 관찰은 사람마다 한 장이다. 같은 아이를 김멘토는 4.2, 정하늘은 3.8 로 봤다면
 * 그 차이가 곧 정보다 — 보는 자리(공부방·놀이 시간)가 다르면 아이도 다르게 보인다.
 * 그래서 반기 안에서 사람마다 한 줄씩 따로 둔다.
 *
 * 평균은 서버가 계산해 준다(lib/half_items.ts — 지운 항목은 빼는 규칙까지).
 * 브라우저는 Supabase에 직접 접근하지 않는다. 항상 /api/... 를 거친다.
 */
import { get, hideState, showState } from "./ui.js";

const el = {
  box: document.getElementById("growth"),
  state: document.getElementById("growth-state"),
};
el.state.dataset.inline = "true";

/** 요청 경합 가드. 아동을 빨리 바꿔 열면 앞 아동의 답이 늦게 와서 덮어쓸 수 있다. */
let asking = null;

export async function loadGrowth(childId) {
  asking = childId;
  el.box.replaceChildren();
  showState(el.state, "불러오는 중…");

  try {
    const payload = await get(`/api/children/${childId}/growth`);
    if (asking !== childId) return;
    render(payload);
  } catch (error) {
    if (asking !== childId) return;
    showState(el.state, "성장 추이를 불러오지 못했습니다.", error.message, true);
  }
}

function halfText(year, half) {
  return `${year} ${half === 1 ? "상" : "하"}반기`;
}

function dayText(date) {
  if (!date) return "—";
  const [, m, d] = date.split("-").map(Number);
  return `${m}월 ${d}일`;
}

function render({ areas = [], items = [], records = [] }) {
  hideState(el.state);
  el.box.replaceChildren();

  if (records.length === 0) {
    showState(
      el.state,
      "아직 반기 관찰이 없습니다.",
      "봉사자·멘토가 폰에서 반기 관찰을 적으면 여기에 반기별로 쌓입니다.",
    );
    return;
  }

  // 반기 → 관찰자 이름 순. 같은 반기의 여러 사람이 붙어 있어야 견줘 보인다.
  const rows = [...records].sort((a, b) =>
    a.year - b.year || a.half - b.half ||
    String(a.author_name).localeCompare(String(b.author_name), "ko")
  );

  el.box.append(averageTable(areas, rows), itemTable(areas, items, rows), notes(rows));
}

/* ---------- 영역별 평균 ---------- */

function averageTable(areas, rows) {
  const section = document.createElement("div");
  section.className = "growth__part";

  const head = document.createElement("h4");
  head.className = "growth__head";
  head.textContent = "영역별 평균 (5점 만점)";
  section.append(head);

  const wrap = document.createElement("div");
  wrap.className = "growth__scroll";

  const table = document.createElement("table");
  table.className = "table growth__table";

  const thead = document.createElement("thead");
  const tr = document.createElement("tr");
  for (const label of ["반기", "관찰자", "관찰일", ...areas]) {
    const th = document.createElement("th");
    th.className = "table__th";
    th.scope = "col";
    th.textContent = label;
    tr.append(th);
  }
  thead.append(tr);

  const tbody = document.createElement("tbody");
  let lastPeriod = null;
  for (const one of rows) {
    const row = document.createElement("tr");
    const period = halfText(one.year, one.half);

    // 같은 반기가 이어지면 반기 칸을 비워 둔다 — 한 반기에 여러 사람이 묶여 보이게.
    row.append(cell(period === lastPeriod ? "" : period, "growth__period"));
    row.append(cell(one.author_name ?? "(명단에서 빠진 사람)"));
    row.append(cell(dayText(one.observed_on), "growth__muted"));
    for (const area of areas) row.append(barCell(one.averages?.[area] ?? null, 5));

    if (period !== lastPeriod) row.classList.add("growth__first");
    lastPeriod = period;
    tbody.append(row);
  }

  table.append(thead, tbody);
  wrap.append(table);
  section.append(wrap);
  return section;
}

function cell(text, className = "") {
  const td = document.createElement("td");
  td.className = `table__td ${className}`.trim();
  // 이름은 사용자 입력이므로 textContent 로만 넣는다
  td.textContent = text;
  return td;
}

/** 수 + 막대. 막대는 눈으로 훑는 용도고, 읽는 것은 수다. */
function barCell(value, max) {
  const td = document.createElement("td");
  td.className = "table__td growth__num";
  if (value === null) {
    td.textContent = "—";
    td.classList.add("growth__muted");
    return td;
  }

  const num = document.createElement("span");
  num.textContent = value.toFixed(1);

  const bar = document.createElement("span");
  bar.className = "growth__bar";
  const fill = document.createElement("span");
  fill.className = "growth__fill";
  fill.style.width = `${Math.round((value / max) * 100)}%`;
  bar.append(fill);

  td.append(num, bar);
  return td;
}

/* ---------- 항목별 점수 ---------- */

function itemTable(areas, items, rows) {
  const section = document.createElement("details");
  section.className = "growth__part";

  const summary = document.createElement("summary");
  summary.className = "growth__head growth__toggle";
  summary.textContent = "항목별 점수";
  section.append(summary);

  const wrap = document.createElement("div");
  wrap.className = "growth__scroll";

  const table = document.createElement("table");
  table.className = "table growth__table growth__table--items";

  const thead = document.createElement("thead");
  const tr = document.createElement("tr");
  const first = document.createElement("th");
  first.className = "table__th";
  first.scope = "col";
  first.textContent = "항목";
  tr.append(first);
  for (const one of rows) {
    const th = document.createElement("th");
    th.className = "table__th growth__num";
    th.scope = "col";
    th.textContent = `${halfText(one.year, one.half)} · ${one.author_name ?? "?"}`;
    tr.append(th);
  }
  thead.append(tr);

  const tbody = document.createElement("tbody");
  const scoredCodes = new Set(rows.flatMap((one) => Object.keys(one.scores ?? {})));

  const group = (label, list) => {
    if (list.length === 0) return;
    const headRow = document.createElement("tr");
    const th = document.createElement("th");
    th.className = "table__td growth__area";
    th.colSpan = rows.length + 1;
    th.scope = "colgroup";
    th.textContent = label;
    headRow.append(th);
    tbody.append(headRow);

    for (const item of list) {
      const row = document.createElement("tr");
      const number = Number(item.code.slice(1));
      row.append(cell(item.deleted ? item.text : `${number}. ${item.text}`, "growth__text"));
      for (const one of rows) {
        const score = one.scores?.[item.code];
        row.append(cell(typeof score === "number" ? String(score) : "—", "growth__num"));
      }
      tbody.append(row);
    }
  };

  for (const area of areas) {
    group(area, items.filter((one) => one.area === area && !one.deleted));
  }
  // 지운 항목은 지난 기록이 점수를 물고 있을 때만 보인다.
  group(
    "삭제된 항목",
    items.filter((one) => one.deleted && scoredCodes.has(one.code)),
  );

  table.append(thead, tbody);
  wrap.append(table);
  section.append(wrap);
  return section;
}

/* ---------- 특이사항 ---------- */

function notes(rows) {
  const section = document.createElement("details");
  section.className = "growth__part";

  const withNote = rows.filter((one) => one.note);
  const summary = document.createElement("summary");
  summary.className = "growth__head growth__toggle";
  summary.textContent = `특이사항 (${withNote.length})`;
  section.append(summary);

  const list = document.createElement("ul");
  list.className = "growth__notes";
  for (const one of withNote) {
    const li = document.createElement("li");
    const who = document.createElement("p");
    who.className = "growth__muted";
    who.textContent = `${halfText(one.year, one.half)} · ${one.author_name ?? "?"} · ${
      dayText(one.observed_on)
    }`;
    const body = document.createElement("p");
    body.className = "growth__note";
    // 서술은 사용자 입력이므로 textContent 로만 넣는다
    body.textContent = one.note;
    li.append(who, body);
    list.append(li);
  }
  if (withNote.length === 0) {
    const li = document.createElement("li");
    li.className = "growth__muted";
    li.textContent = "적힌 특이사항이 없습니다.";
    list.append(li);
  }
  section.append(list);
  return section;
}
