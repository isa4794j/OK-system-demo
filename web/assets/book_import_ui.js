/**
 * 엑셀로 등록 — [+ 도서 등록] 모달의 [📄 엑셀로 등록] 이 연다
 *
 * ① 파일 고르기 → 서버가 읽어 열마다 "이건 제목·저자·출판사·ISBN·등록번호로 보여요" 를 추정(POST /api/books/import/parse)
 * ② 사람이 열 배정을 확인·고친다(추측으로 확정하지 않는다 — 원칙 6)
 * ③ 줄마다 차례로: 찾기(POST /api/books/import/match) → 딱 맞으면 등록(POST /api/books, 조회 채움 → 서지 잠금)
 *    이미 소장·실패는 사유와 함께 남기고, 애매한 줄은 "확인 필요" — 표지 여러 권과 같은 연속 등록 줄(book_pick.js)
 * 한 줄씩 기다리며 보낸다(외부 도서 API 를 한꺼번에 두드리지 않게). 파일은 어디에도 저장하지 않는다.
 */
import { base64Bytes, fillOptions, hideState, send, showState, toast } from "./ui.js";
import { biblioOf, mountQueue } from "./book_pick.js";

const ROLE_LABELS = {
  title: "제목",
  author: "저자",
  publisher: "출판사",
  isbn: "ISBN",
  reg_no: "등록번호",
  center_class: "센터분류",
  acquired_via: "입수경위",
  note: "비고",
  ignore: "쓰지 않음",
};
const FILE_MAX_BYTES = 2 * 1024 * 1024;

const el = {
  modal: document.getElementById("bimport-modal"),
  backdrop: document.getElementById("bimport-backdrop"),
  close: document.getElementById("bimport-close"),
  stepFile: document.getElementById("bimport-step-file"),
  file: document.getElementById("bimport-file"),
  stepMap: document.getElementById("bimport-step-map"),
  mapSummary: document.getElementById("bimport-map-summary"),
  map: document.getElementById("bimport-map"),
  start: document.getElementById("bimport-start"),
  via: document.getElementById("bimport-via"),
  again: document.getElementById("bimport-again"),
  stepRun: document.getElementById("bimport-step-run"),
  progress: document.getElementById("bimport-progress"),
  bar: document.getElementById("bimport-bar"),
  summary: document.getElementById("bimport-summary"),
  failed: document.getElementById("bimport-failed"),
  checkTitle: document.getElementById("bimport-check-title"),
  queue: document.getElementById("bimport-queue"),
  state: document.getElementById("bimport-state"),
};

const state = { parsed: null, roles: [], running: false, stop: false, onRegistered: null };

export function openImport({ onRegistered }) {
  state.onRegistered = onRegistered;
  state.parsed = null;
  state.running = false;
  state.stop = false;
  el.file.value = "";
  el.via.value = "";
  show("file");
  hideState(el.state);
  el.modal.hidden = false;
}

function show(step) {
  el.stepFile.hidden = step !== "file";
  el.stepMap.hidden = step !== "map";
  el.stepRun.hidden = step !== "run";
}

function close() {
  if (state.running) {
    // 도는 중에 닫으면 남은 줄은 멈춘다(이미 등록한 것은 그대로)
    state.stop = true;
  }
  el.modal.hidden = true;
}

/* ---------- ① 파일 ---------- */

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(text);
}

el.file.addEventListener("change", async () => {
  const file = el.file.files?.[0];
  if (!file) return;
  if (file.size > FILE_MAX_BYTES) {
    toast("파일이 너무 큽니다. 2MB 이하로 올려 주세요.", true);
    return;
  }
  showState(el.state, "파일을 읽는 중…");
  try {
    const encoded = toBase64(await file.arrayBuffer());
    if (base64Bytes(encoded) > FILE_MAX_BYTES) throw new Error("파일이 너무 큽니다.");
    const payload = await send("/api/books/import/parse", "POST", { file: encoded, name: file.name });
    hideState(el.state);
    state.parsed = payload;
    state.roles = payload.columns.map((one) => one.role);
    renderMap();
    show("map");
  } catch (error) {
    showState(el.state, "파일을 읽지 못했어요", error.message, true);
  } finally {
    el.file.value = "";
  }
});

/* ---------- ② 열 배정 ---------- */

function renderMap() {
  const { columns, rows, has_header: hasHeader } = state.parsed;
  const read = columns
    .filter((one, i) => state.roles[i] !== "ignore")
    .map((one) => `"${one.header}" = ${ROLE_LABELS[state.roles[columns.indexOf(one)]]}`);
  el.mapSummary.textContent = `${rows.length}줄을 읽었어요${hasHeader ? "(첫 줄은 열 이름으로 봤어요)" : ""}. ` +
    (read.length ? `이렇게 읽었어요 — ${read.join(", ")}. 틀린 곳은 열마다 고쳐 주세요.` : "열을 짐작하지 못했어요. 열마다 골라 주세요.");

  el.map.replaceChildren();
  const head = document.createElement("thead");
  const nameRow = document.createElement("tr");
  const roleRow = document.createElement("tr");
  columns.forEach((one, i) => {
    const th = document.createElement("th");
    th.className = "table__th";
    th.textContent = one.header;
    nameRow.append(th);

    const cell = document.createElement("th");
    cell.className = "bimport__role";
    const select = document.createElement("select");
    select.className = "input";
    select.setAttribute("aria-label", `${one.header} 열은`);
    fillOptions(select, Object.entries(ROLE_LABELS).map(([value, label]) => ({ value, label })));
    select.value = state.roles[i];
    select.addEventListener("change", () => {
      // 비고 말고는 한 열만 — 다른 열에 같은 것이 있으면 풀어 준다
      if (select.value !== "ignore" && select.value !== "note") {
        state.roles = state.roles.map((role, j) => (j !== i && role === select.value ? "ignore" : role));
      }
      state.roles[i] = select.value;
      renderMap();
    });
    const why = document.createElement("p");
    why.className = "bimport__why";
    why.textContent = one.reason;
    cell.append(select, why);
    roleRow.append(cell);
  });
  head.append(nameRow, roleRow);
  const body = document.createElement("tbody");
  for (const row of rows.slice(0, 3)) {
    const tr = document.createElement("tr");
    columns.forEach((_one, i) => {
      const td = document.createElement("td");
      td.textContent = row[i] ?? "";
      tr.append(td);
    });
    body.append(tr);
  }
  el.map.append(head, body);
  el.start.disabled = !state.roles.includes("title") && !state.roles.includes("isbn");
  el.start.title = el.start.disabled ? "제목이나 ISBN 열을 하나는 골라 주세요" : "";
}

el.again.addEventListener("click", () => {
  show("file");
  el.file.click();
});

/* ---------- ③ 차례로 찾기·등록 ---------- */

function rowOf(cells) {
  const out = {};
  state.roles.forEach((role, i) => {
    if (role === "ignore") return;
    const value = String(cells[i] ?? "").trim();
    if (!value) return;
    out[role] = role === "note" && out.note ? `${out.note}\n${value}` : value;
  });
  return out;
}

el.start.addEventListener("click", async () => {
  if (state.running) return;
  const rows = state.parsed.rows.map(rowOf);
  // 입수경위 — 열에 값이 있으면 그 값, 없으면 여기 한 번 적은 값(모든 줄)
  const commonVia = el.via.value.trim() || null;
  state.running = true;
  state.stop = false;
  show("run");
  el.summary.hidden = true;
  el.failed.hidden = true;
  el.failed.replaceChildren();
  el.checkTitle.hidden = true;
  el.queue.replaceChildren();

  let added = 0;
  const failed = [];
  const check = [];
  for (let i = 0; i < rows.length; i += 1) {
    if (state.stop) break;
    const row = rows[i];
    const label = `${i + 1}번 줄${row.title ? ` "${row.title}"` : row.isbn ? ` ISBN ${row.isbn}` : ""}`;
    el.progress.textContent = `${i + 1} / ${rows.length} — ${label} 찾는 중…`;
    el.bar.style.width = `${Math.round((i / rows.length) * 100)}%`;
    const center = {
      reg_no: row.reg_no ?? null,
      center_class: row.center_class ?? null,
      acquired_via: row.acquired_via ?? commonVia,
      note: row.note ?? null,
      status: "보유",
    };
    try {
      const found = await send("/api/books/import/match", "POST", {
        title: row.title ?? null,
        author: row.author ?? null,
        publisher: row.publisher ?? null,
        isbn: row.isbn ?? null,
      });
      if (found.status === "matched") {
        await send("/api/books", "POST", { ...biblioOf(found.item), ...center, biblio_source: "lookup" });
        added += 1;
      } else if (found.status === "check") {
        check.push({
          heading: label,
          sub: row.publisher ? `${found.reason} · 파일의 출판사: ${row.publisher}` : found.reason,
          title: row.title,
          author: row.author,
          publisher: row.publisher,
          isbn: row.isbn,
          ...center,
          // 열 값만 줄에 박는다 — 공통 값은 "이전 책과 같음" 기본값으로(고칠 수 있게)
          acquired_via: row.acquired_via ?? null,
        });
      } else {
        failed.push(`${label} — ${found.reason}`);
      }
    } catch (error) {
      failed.push(`${label} — ${error.message}`);
    }
  }
  el.bar.style.width = "100%";
  state.running = false;

  const stopped = state.stop ? ` · 멈춤(남은 ${rows.length - added - check.length - failed.length}줄)` : "";
  el.progress.textContent = "끝났습니다.";
  el.summary.textContent = `등록 ${added}권 · 확인 필요 ${check.length}권 · 실패 ${failed.length}권${stopped}`;
  el.summary.hidden = false;
  if (failed.length) {
    el.failed.replaceChildren(...failed.map((text) => {
      const li = document.createElement("li");
      li.textContent = text;
      return li;
    }));
    el.failed.hidden = false;
  }
  if (added) state.onRegistered?.();
  if (check.length) {
    el.checkTitle.hidden = false;
    const queue = mountQueue(el.queue, check, {
      onRegistered: () => state.onRegistered?.(),
      acquiredVia: commonVia ?? "",
    });
    queue.openFirst();
  }
  toast(el.summary.textContent, added === 0 && check.length === 0);
});

el.close.addEventListener("click", close);
el.backdrop.addEventListener("click", close);
el.modal.addEventListener("keydown", (event) => {
  if (event.key === "Escape") close();
});
