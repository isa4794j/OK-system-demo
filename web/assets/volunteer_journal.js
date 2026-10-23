/**
 * 봉사일지 작성·수정 모달
 *
 * 종사자 일지와 갈라 둔 이유:
 * 봉사일지는 일정에 매여 있다. 일정이 없는 날에는 쓸 수 없고, 시각은 일정에서 읽는다.
 * 제목도 없다. 칸이 적고 규칙이 달라 한 화면에 두 규칙을 섞느니 따로 둔다.
 * (종사자 일지는 제목 + 긴 본문이라 지금처럼 전체 화면이 맞다)
 *
 * 두 곳에서 부른다.
 *   봉사일지 목록의 [+ 일지 작성]
 *   스케줄 화면의 미작성 목록 [일지 작성]  — 날짜·사람·일정이 이미 정해진 채로
 *
 * 브라우저는 Supabase에 직접 접근하지 않는다. 항상 /api/... 를 거친다.
 */
import { confirmDialog, fillOptions, formatDate, get, send, toast, todayISO } from "./ui.js";

const el = {
  modal: document.getElementById("vj-modal"),
  backdrop: document.getElementById("vj-backdrop"),
  form: document.getElementById("vj-form"),
  title: document.getElementById("vj-title"),
  pick: document.getElementById("vj-pick"),
  date: document.getElementById("vj-date"),
  author: document.getElementById("vj-author"),
  meta: document.getElementById("vj-meta"),
  note: document.getElementById("vj-note"),
  content: document.getElementById("vj-content"),
  submit: document.getElementById("vj-submit"),
  cancel: document.getElementById("vj-cancel"),
};

const state = {
  mode: null, // null | "create" | "edit"
  editing: null,
  /** 고른 날짜에 일정이 있는 사람들. { schedule_id, staff_id, name, role, start_time, end_time } */
  scheduled: [],
  initial: "",
  pending: false,
  /** 열려 있는 동안의 약속. 저장하면 일지를, 닫으면 null 을 준다. */
  resolve: null,
};

/* ---------- 열고 닫기 ---------- */

function formValues() {
  return JSON.stringify([el.date.value, el.author.value, el.content.value]);
}

function open() {
  el.modal.hidden = false;
  state.initial = formValues();
}

/** 본문 칸에 초점 — 좁은 화면에서는 하지 않는다(키보드가 바로 올라와 위가 가려진다) */
function focusContent() {
  if (!globalThis.matchMedia?.("(max-width: 720px)").matches) el.content.focus();
}

function close(result) {
  el.modal.hidden = true;
  state.mode = null;
  state.editing = null;
  state.scheduled = [];
  const done = state.resolve;
  state.resolve = null;
  if (done) done(result);
}

/** 취소·바깥 클릭·Esc. 쓰던 글이 있으면 한 번 묻는다. */
async function askClose() {
  if (state.pending || el.modal.hidden) return;
  if (formValues() !== state.initial) {
    const yes = await confirmDialog({
      title: "쓰던 내용을 버릴까요?",
      message: "저장하지 않은 내용이 사라집니다.",
      confirmText: "버리기",
    });
    if (!yes) return;
  }
  close(null);
}

/* ---------- 그 날 일정 ---------- */

/** 고른 날짜에 일정이 있는 사람을 작성자 후보로 채운다. */
async function loadScheduled(date, preferStaffId = null) {
  state.scheduled = [];
  el.author.disabled = true;
  el.submit.disabled = true;
  el.note.textContent = "일정을 확인하는 중…";

  if (!date) {
    el.note.textContent = "날짜를 골라 주세요.";
    fillOptions(el.author, [{ value: "", label: "날짜를 먼저 고르세요" }]);
    return;
  }
  // 봉사일지는 활동한 뒤에 쓴다 — 서버도 오늘 뒤 날짜는 거절한다(lib/dates.ts)
  if (date > todayISO()) {
    el.note.textContent = "아직 진행하지 않은 봉사예요 — 활동 후에 작성해 주세요.";
    fillOptions(el.author, [{ value: "", label: "오늘까지의 날짜만 쓸 수 있어요" }]);
    return;
  }

  try {
    const payload = await get(`/api/staff/scheduled?date=${encodeURIComponent(date)}`);
    state.scheduled = payload.scheduled ?? [];
  } catch (error) {
    console.error("[loadScheduled]", error);
    el.note.textContent = "일정을 불러오지 못했습니다.";
    fillOptions(el.author, [{ value: "", label: "불러오지 못했습니다" }]);
    return;
  }

  if (state.scheduled.length === 0) {
    // 일정이 없는 날에는 쓸 수 없다. 봉사일지는 "온 날"의 기록이기 때문이다.
    fillOptions(el.author, [{ value: "", label: "이 날은 일정이 없습니다" }]);
    el.note.textContent = "이 날은 일정이 없어요. 스케줄에 일정을 먼저 넣어 주세요.";
    return;
  }

  el.author.disabled = false;
  el.submit.disabled = false;
  // 한 사람이 하루에 두 번 오면 두 줄이 된다. 시각을 함께 적어 구분한다.
  fillOptions(
    el.author,
    state.scheduled.map((person) => {
      // 겸직자가 그날 역할이 다른 일정이 둘이면 역할도 적는다 — 어느 일정의 일지인지 갈라야 한다
      const roles = new Set(
        state.scheduled.filter((one) => one.staff_id === person.staff_id).map((one) => one.role),
      );
      const role = roles.size > 1 && person.role ? `${person.role} · ` : "";
      return {
        value: person.schedule_id,
        label: state.scheduled.length > 1
          ? `${person.name} (${role}${person.start_time}–${person.end_time})`
          : person.name,
      };
    }),
  );
  if (preferStaffId) {
    const found = state.scheduled.find((person) => person.staff_id === preferStaffId);
    if (found) el.author.value = found.schedule_id;
  }
  showTime();
}

/** 고른 사람의 일정 시각을 보여만 준다. 고칠 곳은 스케줄 화면이다. */
function showTime() {
  const picked = state.scheduled.find((person) => person.schedule_id === el.author.value);
  el.note.textContent = picked
    ? `시각 ${picked.start_time} ~ ${picked.end_time} — 일정에서 가져옵니다. 고치려면 스케줄에서 바꾸세요.`
    : "";
}

/* ---------- 작성 ---------- */

/**
 * 봉사일지를 새로 쓴다.
 * preset 이 있으면(미작성 목록에서 왔을 때) 날짜·사람이 이미 정해진 채로 연다.
 * 저장하면 만들어진 일지를, 닫으면 null 을 돌려준다.
 */
export function openVolunteerJournal(preset = null) {
  state.mode = "create";
  state.editing = null;

  el.title.textContent = "봉사일지 작성";
  el.pick.hidden = false;
  el.meta.hidden = true;
  el.content.value = "";
  // 수정에서 잠가 둔 것을 푼다 (아래 [숨기는 것만으로는 모자라다] 참고)
  el.date.disabled = false;
  el.date.max = todayISO();
  el.date.value = preset?.sched_date ?? todayISO();
  el.submit.disabled = true;

  open();
  loadScheduled(el.date.value, preset?.staff_id ?? null).then(() => {
    state.initial = formValues();
    focusContent();
  });

  return new Promise((resolve) => {
    state.resolve = resolve;
  });
}

/**
 * 이미 쓴 봉사일지를 고친다. 내용만 바꾼다.
 * 날짜·작성자·시각은 일정이 정하는 것이라 여기서 손대지 않는다.
 *
 * [숨기는 것만으로는 모자라다]
 * 날짜 칸은 required 다. 그런데 숨긴다고 검사에서 빠지지 않는다 —
 * 브라우저는 disabled 인 칸만 건너뛴다. 그래서 수정 화면에서는 날짜가 빈 채로 남아
 * 저장을 눌러도 submit 이 아예 일어나지 않았다. 오류도 안 뜬다.
 * 숨긴 칸이라 브라우저가 "여기를 채우세요"를 띄울 자리조차 없기 때문이다.
 * 버튼이 죽은 것처럼 보이던 것이 이 때문이다. 그래서 숨기면서 함께 잠근다.
 */
export function editVolunteerJournal(journal) {
  state.mode = "edit";
  state.editing = journal;

  el.title.textContent = "봉사일지 수정";
  el.pick.hidden = true;
  el.date.disabled = true;
  el.author.disabled = true;
  el.meta.hidden = false;
  el.meta.replaceChildren();

  const when = document.createElement("span");
  when.textContent = formatDate(journal.journal_date);

  const who = document.createElement("span");
  who.className = "personchip";
  const dot = document.createElement("span");
  dot.className = "personchip__dot";
  const name = document.createElement("span");
  // 이름은 사용자 입력이므로 textContent로만 넣는다
  name.textContent = journal.author_name ?? "작성자 없음";
  who.append(dot, name);

  const time = document.createElement("span");
  time.className = "roletag";
  time.textContent = journal.start_time
    ? `${journal.start_time} ~ ${journal.end_time ?? ""}`
    : "시각 없음";

  el.meta.append(when, who, time);

  el.note.textContent = "날짜·작성자·시각은 일정에서 옵니다. 여기서는 내용만 고칩니다.";
  el.content.value = journal.content ?? "";
  el.submit.disabled = false;

  open();
  focusContent();

  return new Promise((resolve) => {
    state.resolve = resolve;
  });
}

/* ---------- 저장 ---------- */

async function submit(event) {
  event.preventDefault();
  if (state.pending) return;

  const content = el.content.value.trim();
  if (!content) {
    toast("내용을 입력해 주세요.", true);
    return;
  }

  state.pending = true;
  el.submit.disabled = true;

  try {
    if (state.mode === "edit") {
      const payload = await send(`/api/journals/${state.editing.id}`, "PATCH", { content });
      toast("저장되었습니다");
      close(payload.journal);
      return;
    }

    const picked = state.scheduled.find((person) => person.schedule_id === el.author.value);
    if (!picked) {
      toast("작성자를 골라 주세요.", true);
      return;
    }

    const payload = await send("/api/journals", "POST", {
      kind: "봉사",
      journal_date: el.date.value,
      author_id: picked.staff_id,
      schedule_id: picked.schedule_id,
      content,
    });
    toast("저장되었습니다");
    close(payload.journal);
  } catch (error) {
    // 모달과 쓰던 글은 그대로 둔다. 고쳐서 다시 낼 수 있게.
    toast(error.message, true);
  } finally {
    state.pending = false;
    el.submit.disabled = state.mode === "create" && state.scheduled.length === 0;
  }
}

/* ---------- 이벤트 ---------- */

el.form.addEventListener("submit", submit);
el.cancel.addEventListener("click", askClose);
el.backdrop.addEventListener("click", askClose);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !el.modal.hidden) askClose();
});
el.date.addEventListener("change", () => loadScheduled(el.date.value));
el.author.addEventListener("change", showTime);

/**
 * 저장한 봉사일지를 분석한다(관찰 → 자원). 기다리지 않고 부르는 자리에서 쓴다.
 *
 * 일지 목록 화면은 카드에 진행 상황을 그리는 자기 함수(runExtract)를 쓴다.
 * 카드가 없는 화면(스케줄의 [일지 작성])이 이 함수를 쓴다 — 거기서 쓴 일지도
 * 목록에서 쓴 것과 똑같이 분석돼야 한다. 실패해도 일지는 저장돼 있고,
 * 일지 화면의 "미분석" 표시와 [일괄 분석] 이 안전망이다.
 */
export async function analyzeSaved(journalId) {
  try {
    await send(`/api/journals/${journalId}/extract`, "POST", {});
    await send(`/api/journals/${journalId}/extract-resources`, "POST", {});
  } catch (error) {
    console.error("[analyzeSaved]", journalId, error);
    toast("일지는 저장했지만 분석하지 못했습니다 — 일지 화면에서 [분석하기]를 눌러 주세요.", true);
  }
}
