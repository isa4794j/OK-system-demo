/**
 * 인쇄 화면 — 관찰일지 · 평가서 · 동의서
 *
 * 주소의 kind 로 무엇을 찍을지 정한다(print.html 머리 주석).
 * 종이에 들어갈 값(기간·작성일·작성자·평가 제목)은 도구줄에서 고친다 — 저장하지 않는다.
 * 작성일 기본은 오늘, 작성자 기본은 로그인한 사람("장센터 센터장" 처럼 이름 + 역할).
 *
 * 관찰일지: 영역마다 한 줄, 그 안에 날짜별 관찰(날짜 + [역할] + 글). 영역 미지정 관찰은 넣지 않고 위에 알린다.
 * 평가서: 저장된 평가(영역별 요약)를 그대로. 영역 구조가 아닌 글이면 본문 한 칸.
 * 동의서: 설정에 저장된 문구(consent_form) — 빈 양식.
 *
 * 브라우저는 Supabase 에 직접 가지 않는다. /api 만 부른다.
 */
import { dateLong, gradeFull, renderConsentDoc, renderRecordDoc } from "./doc_render.js";

const el = {
  close: document.getElementById("p-close"),
  name: document.getElementById("p-name"),
  print: document.getElementById("p-print"),
  fields: document.getElementById("p-fields"),
  titleField: document.getElementById("p-title-field"),
  title: document.getElementById("p-title"),
  year: document.getElementById("p-year"),
  half: document.getElementById("p-half"),
  date: document.getElementById("p-date"),
  author: document.getElementById("p-author"),
  note: document.getElementById("p-note"),
  areas: document.getElementById("p-areas"),
  areaList: document.getElementById("p-area-list"),
  paper: document.getElementById("paper"),
  state: document.getElementById("p-state"),
};

const params = new URLSearchParams(location.search);
const kind = params.get("kind");

/** 역할 태그 — 관찰의 출처(일지 종류) */
const SOURCE_TAG = { 멘토: "멘토링", 봉사: "봉사", 프로그램: "프로그램", 일상: "일상", 회의: "회의" };

const HALF_LABEL = { 1: "상반기", 2: "하반기", all: "연간" };

let child = null;
let center = "";
let areas = [];
/** 불러온 것 — 제목·작성일·작성자만 바뀌면 다시 받지 않는다 */
let loaded = null;
let loadSeq = 0;
/** 빼기로 한 영역 이름 — 기간을 바꿔 다시 읽어도 고른 것이 유지된다(기본 전체 선택) */
const skipped = new Set();

/** 영역 체크 칸 — 지금 표에 있는 영역마다 하나 */
function renderAreaPicks(rows) {
  el.areaList.replaceChildren();
  for (const row of rows) {
    const label = document.createElement("label");
    label.className = "pareas__item";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = !skipped.has(row.name);
    box.addEventListener("change", () => {
      if (box.checked) skipped.delete(row.name);
      else skipped.add(row.name);
      draw();
    });
    label.append(box, document.createTextNode(row.name));
    el.areaList.append(label);
  }
  el.areas.hidden = rows.length === 0;
}

async function getJson(url) {
  const response = await fetch(url);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `서버 오류 (HTTP ${response.status})`);
  return payload;
}

function todaySeoul() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

function showState(message, isError = false) {
  const p = document.createElement("p");
  p.className = `paper__state${isError ? " paper__state--error" : ""}`;
  p.textContent = message;
  el.paper.replaceChildren(p);
  el.print.disabled = true;
}

function rangeOf(year, half) {
  if (half === "1") return { from: `${year}-01-01`, to: `${year}-06-30` };
  if (half === "2") return { from: `${year}-07-01`, to: `${year}-12-31` };
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}

function periodLabel(year, half) {
  const { from, to } = rangeOf(year, half);
  const name = half === "all" ? `${year}년` : `${year}년 ${HALF_LABEL[half]}`;
  return `${name} (${from} ~ ${to})`;
}

/** 기간 끝날의 학년 — 상반기면 6월, 하반기·연간이면 12월 기준 */
function gradeAt(year, half) {
  const { to } = rangeOf(year, half);
  const [y, m, d] = to.split("-").map(Number);
  return gradeFull(child?.birth_date, new Date(y, m - 1, d));
}

function setNote(text) {
  el.note.textContent = text ?? "";
  el.note.hidden = !text;
}

/* ---------- 관찰일지 ---------- */

async function fetchObservations(year, half) {
  const halves = half === "all" ? ["1", "2"] : [half];
  const lists = await Promise.all(
    halves.map((h) =>
      getJson(`/api/observations?child=${encodeURIComponent(child.id)}&year=${year}&half=${h}`)
    ),
  );
  return lists.flatMap((one) => one.observations ?? []);
}

function observationRows(observations) {
  const byArea = new Map();
  for (const one of observations) {
    if (!one.area) continue;
    if (!byArea.has(one.area)) byArea.set(one.area, []);
    byArea.get(one.area).push(one);
  }
  // 지금 쓰는 영역은 전부(비어도), 지운 영역은 기록이 있을 때만
  const shown = areas.filter((one) => !one.deleted || byArea.has(one.code));
  // 목록에 없는 코드(있을 리 없지만)도 떨어뜨리지 않는다
  for (const code of byArea.keys()) {
    if (!shown.some((one) => one.code === code)) shown.push({ code, name: code });
  }
  return shown.map((area) => ({
    name: area.deleted ? `${area.name} (예전 영역)` : area.name,
    lines: (byArea.get(area.code) ?? [])
      .sort((a, b) => String(a.obs_date).localeCompare(String(b.obs_date)))
      .map((one) => ({
        date: String(one.obs_date).slice(5, 10).replace("-", "."),
        tag: SOURCE_TAG[one.source] ?? "",
        text: one.content ?? "",
      })),
  }));
}

/* ---------- 평가서 ---------- */

function evaluationRows(evaluation) {
  const content = evaluation?.content;
  if (!content) return [];
  if (typeof content === "string") return [{ name: "내용", text: content }];
  const known = new Set(areas.map((one) => one.code));
  const rows = areas
    .filter((one) => !one.deleted || content[one.code]?.trim())
    .map((one) => ({ name: one.name, text: content[one.code] ?? "" }));
  for (const [code, text] of Object.entries(content)) {
    if (!known.has(code) && String(text ?? "").trim()) rows.push({ name: code, text: String(text) });
  }
  return rows;
}

/* ---------- 그리기 ---------- */

function draw() {
  if (!loaded) return;
  const year = el.year.value;
  const half = el.half.value;
  const info = {
    name: child.name,
    grade: gradeAt(year, half),
    period: periodLabel(year, half),
    date: dateLong(el.date.value),
    author: el.author.value.trim(),
  };
  const isEval = kind === "evaluation";
  const title = isEval ? (el.title.value.trim() || "연 간 평 가") : "관 찰 일 지";
  const rows = loaded.rows.filter((row) => !skipped.has(row.name));
  if (loaded.rows.length && rows.length === 0) {
    showState("찍을 영역을 하나 이상 골라 주세요.");
    return;
  }
  const doc = renderRecordDoc({
    title,
    center,
    info,
    rows,
    empty: isEval ? "작성된 평가 없음" : "관찰 기록 없음",
  });
  el.paper.replaceChildren(doc);
  el.print.disabled = false;
  document.title = `${isEval ? "평가서" : "관찰일지"} ${child.name} ${year} ${HALF_LABEL[half]}`;
}

async function loadRecords() {
  const seq = ++loadSeq;
  loaded = null;
  showState("불러오는 중…");
  setNote("");
  const year = el.year.value;
  const half = el.half.value;
  try {
    if (kind === "evaluation") {
      const payload = await getJson(
        `/api/children/${encodeURIComponent(child.id)}/evaluation?year=${year}&half=${half}`,
      );
      if (seq !== loadSeq) return;
      loaded = { rows: evaluationRows(payload.evaluation) };
      if (!payload.evaluation) setNote("이 기간에 저장된 평가가 없습니다. 빈 양식으로 찍힙니다.");
    } else {
      const observations = await fetchObservations(year, half);
      if (seq !== loadSeq) return;
      const unset = observations.filter((one) => !one.area).length;
      loaded = { rows: observationRows(observations) };
      if (unset) {
        setNote(`영역 미지정 관찰 ${unset}건은 인쇄에 들어가지 않습니다 — 아동 상세의 날짜별·편집에서 영역을 정해 주세요.`);
      }
    }
    renderAreaPicks(loaded.rows);
    draw();
  } catch (error) {
    if (seq !== loadSeq) return;
    showState(error.message, true);
  }
}

function fillYears() {
  const now = Number(todaySeoul().slice(0, 4));
  const enrolled = Number(String(child.enroll_date ?? "").slice(0, 4));
  const first = Number.isInteger(enrolled) && enrolled >= 2000 && enrolled <= now ? enrolled : now;
  const wanted = Number(params.get("year")) || now;
  el.year.replaceChildren();
  for (let y = now; y >= Math.min(first, wanted); y--) {
    el.year.append(new Option(`${y}년`, String(y)));
  }
  el.year.value = String(wanted);
}

function fillHalves() {
  const choices = kind === "evaluation"
    ? [["1", "상반기"], ["2", "하반기"]]
    : [["all", "연도 전체"], ["1", "상반기"], ["2", "하반기"]];
  el.half.replaceChildren(...choices.map(([value, label]) => new Option(label, value)));
  const wanted = params.get("half");
  el.half.value = choices.some(([value]) => value === wanted) ? wanted : choices[0][0];
}

async function startRecords() {
  const childId = params.get("child") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(childId)) {
    showState("어느 아동인지 알 수 없습니다. 아동 상세에서 [인쇄] 를 눌러 주세요.", true);
    return;
  }
  const [childPayload, areaPayload, me, centerPayload] = await Promise.all([
    getJson(`/api/children/${encodeURIComponent(childId)}`),
    getJson("/api/settings/observation_areas"),
    getJson("/api/auth/me").catch(() => ({ user: null })),
    getJson("/api/settings/center_name").catch(() => ({ value: "" })),
  ]);
  child = childPayload.child;
  areas = Array.isArray(areaPayload.value) ? areaPayload.value : [];
  center = String(centerPayload.value ?? "");

  const isEval = kind === "evaluation";
  el.name.textContent = `${isEval ? "평가서" : "관찰일지"} — ${child.name}`;
  el.titleField.hidden = !isEval;
  el.title.value = "연 간 평 가";
  el.date.value = todaySeoul();
  const user = me.user;
  el.author.value = user ? [user.name, user.role].filter(Boolean).join(" ") : "";
  fillYears();
  fillHalves();
  el.fields.hidden = false;

  el.year.addEventListener("change", loadRecords);
  el.half.addEventListener("change", loadRecords);
  for (const input of [el.title, el.date, el.author]) input.addEventListener("input", draw);
  await loadRecords();
}

async function startConsent() {
  el.name.textContent = "개인정보 처리에 관한 동의서";
  const [form, centerPayload] = await Promise.all([
    getJson("/api/settings/consent_form"),
    getJson("/api/settings/center_name"),
  ]);
  center = String(centerPayload.value ?? "");
  el.paper.replaceChildren(renderConsentDoc(form.value, center));
  el.print.disabled = false;
  document.title = "개인정보 처리에 관한 동의서";
}

/* ---------- 시작 ---------- */

el.print.addEventListener("click", () => globalThis.print());
el.close.addEventListener("click", () => {
  // 앱이 새 창으로 열었으면 닫고, 주소로 직접 왔으면 앱으로
  globalThis.close();
  setTimeout(() => location.assign("/"), 150);
});

(async () => {
  try {
    if (kind === "observations" || kind === "evaluation") await startRecords();
    else if (kind === "consent") await startConsent();
    else showState("무엇을 인쇄할지 알 수 없습니다.", true);
  } catch (error) {
    showState(error.message, true);
  }
})();
