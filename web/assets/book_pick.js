/**
 * 책 고르기 부품 두 개 — 등록 모달(제목 검색)·표지 여러 권·엑셀 "확인 필요" 가 함께 쓴다
 *
 *   mountBookPicker(box, { title, author, actionLabel, onChoose })
 *     제목·저자 칸 + [찾기] → 결과 줄(표지·제목·저자·출판사·연도·분류) → [고르기]/[등록].
 *     이미 가진 책은 "소장 중" 으로만 보인다. 찾기는 GET /api/books/search(국중·정보나루).
 *
 *   mountQueue(box, entries, { onRegistered })
 *     줄 목록 — 줄마다 [찾기] 를 누르면 그 줄 밑에 센터 정보(등록번호·상태) + 고르기 부품이 펼쳐진다.
 *     [등록] 하면 바로 저장(조회 채움 → 서지 잠금), 그 줄은 ✓ 로 접히고 다음 줄이 열린다 — 화면을 떠나지 않는다.
 *     찾는 책이 없으면 [이 제목으로 등록](손 입력, 잠금 없음).
 *
 * 저장은 사람이 누를 때만 한다. 자동으로 맞춘 줄(엑셀)도 부르는 쪽이 사람의 확인 뒤에 보낸다.
 * 바깥에서 온 글은 textContent 로만 넣는다.
 */
import { button, fillOptions, focusOnWide, get, send, toast, toOption } from "./ui.js";

const STATUSES = ["보유", "분실", "폐기"];

/** 고른 책(검색 결과)을 등록 본문의 서지 부분으로 */
export function biblioOf(item) {
  return {
    isbn: item.isbn ?? null,
    title: item.title,
    author: item.author ?? null,
    publisher: item.publisher ?? null,
    published_year: item.published_year ?? null,
    kdc: item.kdc ?? null,
    kdc_label: item.kdc_label ?? null,
    cover_url: item.cover_url ?? null,
  };
}

/** 찾기 — 실패하면 사람이 읽을 말로 던진다 */
export async function searchBooks(title, author, page = 1) {
  const params = new URLSearchParams();
  if (title) params.set("title", title);
  if (author) params.set("author", author);
  params.set("page", String(page));
  try {
    return await get(`/api/books/search?${params}`);
  } catch (error) {
    throw new Error(
      error instanceof TypeError ? "서버에 연결하지 못했습니다. 잠시 뒤 다시 눌러 주세요." : error.message,
    );
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function mountBookPicker(box, { title = "", author = "", actionLabel = "고르기", onChoose }) {
  const state = { page: 1, items: [], hasMore: false, busy: false, title, author };
  box.replaceChildren();
  box.classList.add("bpick");

  const row = el("div", "bpick__row");
  const titleInput = el("input", "input bpick__title");
  titleInput.type = "search";
  titleInput.placeholder = "제목";
  titleInput.maxLength = 100;
  titleInput.value = title;
  titleInput.setAttribute("aria-label", "제목");
  const authorInput = el("input", "input bpick__author");
  authorInput.type = "search";
  authorInput.placeholder = "저자(선택)";
  authorInput.maxLength = 100;
  authorInput.value = author;
  authorInput.setAttribute("aria-label", "저자");
  const go = button("찾기", "btn bpick__go", () => run(1));
  row.append(titleInput, authorInput, go);

  const note = el("p", "form__hint bpick__note");
  note.hidden = true;
  const list = el("ul", "bpick__list");
  const more = button("더 보기", "btn btn--small bpick__more", () => run(state.page + 1));
  more.hidden = true;
  box.append(row, note, list, more);

  // 폼 안에 들어가도 Enter 가 바깥 폼을 저장하지 않게 — 여기서는 찾기다
  for (const input of [titleInput, authorInput]) {
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      run(1);
    });
  }

  function say(text) {
    note.textContent = text;
    note.hidden = !text;
  }

  async function run(page) {
    const t = titleInput.value.trim();
    const a = authorInput.value.trim();
    if (!t && !a) {
      say("제목이나 저자를 넣어 주세요.");
      titleInput.focus();
      return;
    }
    if (state.busy) return;
    state.busy = true;
    go.disabled = true;
    more.disabled = true;
    if (page === 1) {
      state.items = [];
      list.replaceChildren();
    }
    say("찾는 중…");
    try {
      const payload = await searchBooks(t, a, page);
      const seen = new Set(state.items.map((one) => one.isbn).filter(Boolean));
      for (const one of payload.items ?? []) {
        if (one.isbn && seen.has(one.isbn)) continue;
        if (one.isbn) seen.add(one.isbn);
        state.items.push(one);
        list.append(renderItem(one));
      }
      state.page = page;
      state.hasMore = Boolean(payload.has_more);
      say(state.items.length ? "" : "찾지 못했습니다. 제목을 줄이거나 저자를 빼 보세요.");
    } catch (error) {
      say(error.message);
    } finally {
      state.busy = false;
      go.disabled = false;
      more.disabled = false;
      more.hidden = !state.hasMore;
    }
  }

  function renderItem(item) {
    const li = el("li", "bpick__item");
    const cover = el("div", "bpick__cover");
    if (item.cover_url) {
      const img = el("img");
      img.src = item.cover_url;
      img.alt = "";
      img.loading = "lazy";
      img.addEventListener("error", () => img.remove());
      cover.append(img);
    }
    const body = el("div", "bpick__body");
    body.append(el("p", "bpick__name", item.title));
    body.append(
      el(
        "p",
        "bpick__meta",
        [item.author, item.publisher, item.published_year, item.kdc_label, item.isbn].filter(Boolean).join(" · ") ||
          "정보 없음",
      ),
    );
    const act = el("div", "bpick__act");
    if (item.owned_id) act.append(el("span", "badge badge--active", "소장 중"));
    else act.append(button(actionLabel, "btn btn--small btn--primary", () => onChoose(item)));
    li.append(cover, body, act);
    return li;
  }

  return {
    search: () => run(1),
    focus: () => titleInput.focus(),
  };
}

/**
 * 연속 등록 줄 목록.
 * entry = { heading, sub?, title?, author?, isbn?, reg_no?, center_class?, acquired_via?, note?, done?, doneText?, error? }
 *
 * 줄마다 [×] 로 뺄 수 있다(잘못 읽힘·이미 있는 책·안 넣을 책) — 뺀 줄은 목록에서 사라지고 "제외 N권" 개수만 남는다.
 * 입수경위는 앞 권에 쓴 값이 다음 권의 기본값이 된다("이전 책과 같음", 고칠 수 있다).
 */
export function mountQueue(box, entries, { onRegistered, emptyText = "", acquiredVia = "" } = {}) {
  let openIndex = -1;
  let lastVia = acquiredVia;
  let sameVia = true;
  box.replaceChildren();
  box.classList.add("bqueue");

  const live = () => entries.filter((one) => !one.excluded);

  function draw() {
    box.replaceChildren();
    if (live().length === 0 && emptyText) box.append(el("p", "form__hint", emptyText));
    entries.forEach((entry, index) => {
      if (!entry.excluded) box.append(drawRow(entry, index));
    });
    const excluded = entries.length - live().length;
    if (excluded > 0) box.append(el("p", "form__hint bqueue__excluded", `제외 ${excluded}권`));
  }

  function openNext(from) {
    // 뒤쪽에 남은 줄이 없으면 앞에서 건너뛴 줄로 돌아간다
    const waiting = (one) => !one.done && !one.excluded;
    const after = entries.findIndex((one, i) => i > from && waiting(one));
    const next = after >= 0 ? after : entries.findIndex(waiting);
    openIndex = next;
    draw();
    if (next >= 0) focusOnWide(box.querySelector(".bqueue__panel .bpick__title"));
  }

  async function register(entry, index, biblio, center, fromLookup) {
    try {
      const payload = await send("/api/books", "POST", {
        ...biblio,
        ...center,
        ...(fromLookup ? { biblio_source: "lookup" } : {}),
      });
      entry.done = true;
      entry.doneText = `등록함 — ${payload.book.title}${payload.book.reg_no ? ` (${payload.book.reg_no})` : ""}`;
      entry.error = null;
      if (center.acquired_via) lastVia = center.acquired_via;
      toast(`${payload.book.title} 등록했습니다`);
      onRegistered?.(payload.book);
      openNext(index);
    } catch (error) {
      entry.error = error.message;
      draw();
    }
  }

  function drawRow(entry, index) {
    const li = el("li", entry.done ? "bqueue__row is-done" : "bqueue__row");
    const head = el("div", "bqueue__head");
    head.append(el("span", "bqueue__mark", entry.done ? "✓" : ""));
    const words = el("div", "bqueue__words");
    words.append(el("p", "bqueue__heading", entry.done ? entry.doneText : entry.heading));
    if (!entry.done && entry.sub) words.append(el("p", "bqueue__sub", entry.sub));
    if (entry.error) words.append(el("p", "bqueue__error", entry.error));
    head.append(words);
    if (!entry.done) {
      const open = openIndex === index;
      const acts = el("div", "bqueue__acts");
      acts.append(button(open ? "접기" : "찾기", "btn btn--small", () => {
        openIndex = open ? -1 : index;
        draw();
      }));
      const drop = button("×", "btn btn--small bqueue__drop", () => {
        entry.excluded = true;
        if (openIndex === index) openNext(index);
        else draw();
      });
      drop.setAttribute("aria-label", "이 줄 빼기");
      drop.title = "이 줄 빼기 — 잘못 읽힘·이미 있는 책·등록 안 할 책";
      acts.append(drop);
      head.append(acts);
    }
    li.append(head);
    if (entry.done || openIndex !== index) return li;

    // 펼친 줄 — 센터 정보(간단) + 고르기
    const panel = el("div", "bqueue__panel");
    const center = el("div", "bqueue__center");
    const reg = el("input", "input bqueue__reg");
    reg.maxLength = 30;
    reg.placeholder = "등록번호(선택)";
    reg.value = entry.reg_no ?? "";
    reg.setAttribute("aria-label", "등록번호");
    const status = el("select", "input");
    status.setAttribute("aria-label", "상태");
    status.required = true;
    fillOptions(status, STATUSES.map(toOption));
    status.value = "보유";
    center.append(reg, status);

    // 입수경위 — 줄에 값이 있으면 그 값, 없으면 앞 권 값("이전 책과 같음")
    const viaRow = el("div", "bqueue__via");
    const via = el("input", "input");
    via.maxLength = 100;
    via.placeholder = "입수경위(선택, 예: 기증 — ○○도서관)";
    via.setAttribute("aria-label", "입수경위");
    via.value = entry.acquired_via ?? (sameVia ? lastVia : "");
    viaRow.append(via);
    if (!entry.acquired_via && lastVia) {
      const label = el("label", "bqueue__same");
      const check = el("input");
      check.type = "checkbox";
      check.checked = sameVia;
      check.addEventListener("change", () => {
        sameVia = check.checked;
        via.value = sameVia ? lastVia : "";
      });
      label.append(check, document.createTextNode(" 이전 책과 같음"));
      viaRow.append(label);
    }
    center.append(viaRow);

    const centerOf = () => ({
      reg_no: reg.value.trim() || null,
      status: status.value || "보유",
      center_class: entry.center_class ?? null,
      acquired_via: via.value.trim() || null,
      note: entry.note ?? null,
    });

    const pickBox = el("div");
    const picker = mountBookPicker(pickBox, {
      title: entry.title ?? "",
      author: entry.author ?? "",
      actionLabel: "등록",
      onChoose: (item) => register(entry, index, biblioOf(item), centerOf(), true),
    });

    // ISBN 없는·확인 안 되는 책 — 제목만 있으면 손 입력으로(잠금 없음)
    const manual = button("찾는 책이 없으면 — 이 제목으로 등록", "linkbtn bqueue__manual", () => {
      const title = pickBox.querySelector(".bpick__title").value.trim();
      if (!title) {
        toast("제목을 넣어 주세요.", true);
        return;
      }
      const author = pickBox.querySelector(".bpick__author").value.trim() || null;
      register(
        entry,
        index,
        { title, author, publisher: entry.publisher ?? null, isbn: entry.isbn ?? null },
        centerOf(),
        false,
      );
    });

    panel.append(center, pickBox, manual);
    li.append(panel);
    // 읽은 제목·저자가 있으면 바로 찾는다(누른 뜻이 그것이다)
    if (entry.title || entry.author) queueMicrotask(() => picker.search());
    return li;
  }

  draw();
  return {
    open(index) {
      openIndex = index;
      draw();
    },
    openFirst() {
      openNext(-1);
    },
    remaining: () => entries.filter((one) => !one.done && !one.excluded).length,
  };
}
