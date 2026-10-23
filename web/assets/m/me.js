/**
 * 나 — 내가 누구인지, 내가 얼마나 왔는지, 하고 싶은 말
 *
 * 통계가 여기 있는 이유: 남의 수는 없다. 견주는 화면이 아니라 자기 것을 돌아보는
 * 화면이라 "나" 안에 있는 것이 맞다. 일정이 없던 달은 줄을 만들지 않는다 —
 * 0 이 열두 줄이면 읽을 것이 없다.
 *
 * 문의는 한 방향이다. 답장은 없다 — 주고받기 시작하면 메신저를 만들게 되고,
 * 그건 이 시스템의 일이 아니다. 종사자가 PC 에서 보고 [확인함] 을 누르는 것까지다.
 */
import { toast } from "../ui.js";
import { send, VERSION } from "./app.js";
import { openForm } from "./form.js";
import { loadView, refreshView } from "./view.js";

const el = {
  version: document.getElementById("me-version"),
  stale: document.getElementById("stats-stale"),
  total: document.getElementById("stats-total"),
  months: document.getElementById("stats-months"),
  inquiryAdd: document.getElementById("inquiry-add"),
  inquiryList: document.getElementById("inquiry-list"),
  inquiryEmpty: document.getElementById("inquiry-empty"),
  update: document.getElementById("me-update"),
  state: document.getElementById("m-state"),
};

function statsView() {
  const year = new Date().getFullYear();
  return {
    name: "stats",
    url: `/api/my/stats?year=${year}`,
    stale: el.stale,
    state: el.state,
    draw: drawStats,
  };
}

function inquiryView() {
  return {
    name: "inquiries",
    url: "/api/my/inquiries",
    // 위쪽 안내는 통계가 쓴다. 두 줄이 겹쳐 뜨면 시끄럽다.
    stale: document.createElement("div"),
    state: document.createElement("div"),
    draw: drawInquiries,
  };
}

export function showMe() {
  el.version.textContent = `버전 ${VERSION}`;
  loadView(statsView());
  loadView(inquiryView());
}

/* ---------- 봉사 통계 ---------- */

/** "5번 · 10시간 · 일지 4" */
function tallyText(t) {
  return `${t.schedules}번 · ${t.hours}시간 · 일지 ${t.written}`;
}

/**
 * 겸직자만 — 역할별로 가른 줄들. 서버가 by_role 을 줄 때만 온다(역할이 하나면 안 준다).
 * 그 역할로 잡힌 것이 있는 역할이 **둘 이상일 때만** 그린다 — 하나뿐이면 합계와 같은 숫자를
 * 한 번 더 적는 것이라 없는 편이 읽기 쉽다. 없으면 null.
 */
function splitLines(parts, className) {
  const live = (parts ?? []).filter((part) => part.schedules > 0 || part.written > 0);
  if (live.length < 2) return null;
  const box = document.createElement("span");
  box.className = className;
  for (const part of live) {
    const line = document.createElement("span");
    line.textContent = `${part.role} ${tallyText(part)}`;
    box.append(line);
  }
  return box;
}

function drawStats(data) {
  el.total.replaceChildren();
  const total = data.total ?? { schedules: 0, hours: 0, written: 0 };

  const head = document.createElement("p");
  head.className = "msum__head";
  head.textContent = `${data.year}년 합계`;

  // 큰 숫자 셋 — 번 · 시간 · 일지
  const nums = document.createElement("div");
  nums.className = "msum__nums";
  for (const [value, unit] of [[total.schedules, "번"], [total.hours, "시간"], [total.written, "일지"]]) {
    const box = document.createElement("div");
    box.className = "msum__num";
    const v = document.createElement("strong");
    v.textContent = String(value);
    const u = document.createElement("span");
    u.textContent = unit;
    box.append(v, u);
    nums.append(box);
  }

  el.total.append(head, nums);
  const totalSplit = splitLines(data.total_by_role, "msum__split");
  if (totalSplit) el.total.append(totalSplit);

  el.months.replaceChildren();
  for (const one of data.months ?? []) {
    if (one.schedules === 0 && one.written === 0) continue;

    const li = document.createElement("li");
    li.className = "mmonth";

    const month = document.createElement("span");
    month.className = "mmonth__name";
    month.textContent = `${one.month}월`;

    const sub = document.createElement("span");
    sub.className = "mmonth__nums";
    sub.textContent = tallyText(one);

    li.append(month, sub);
    const split = splitLines(one.by_role, "mrow__split");
    if (split) li.append(split);
    el.months.append(li);
  }

  if (el.months.children.length === 0) {
    const li = document.createElement("li");
    li.className = "mmonth mmonth--empty";
    li.textContent = "올해 아직 기록이 없습니다.";
    el.months.append(li);
  }
}

/* ---------- 문의 ---------- */

function drawInquiries(data) {
  const rows = data.inquiries ?? [];
  el.inquiryList.replaceChildren();
  el.inquiryEmpty.hidden = rows.length > 0;

  for (const one of rows) {
    const li = document.createElement("li");
    li.className = "mcardrow";

    const head = document.createElement("div");
    head.className = "mcardrow__head";

    const when = document.createElement("span");
    when.className = "mrow__sub";
    when.textContent = dayText(one.created_at);

    const mark = document.createElement("span");
    mark.className = one.seen ? "mtag" : "mtag mtag--todo";
    // 답장이 아니라 "봤다" 표시일 뿐이라는 것이 말에서 드러나야 한다.
    mark.textContent = one.seen ? "확인함" : "확인 전";

    head.append(when, mark);

    const body = document.createElement("p");
    body.className = "mcardrow__body";
    // 문의 본문은 사용자 입력이므로 textContent 로만 넣는다
    body.textContent = one.content ?? "";

    li.append(head, body);
    el.inquiryList.append(li);
  }
}

/** "2026-09-10T…" → "9월 10일" */
function dayText(at) {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return "";
  return `${when.getMonth() + 1}월 ${when.getDate()}일`;
}

/* ---------- 업데이트 ---------- */

/**
 * 화면을 새로 받는다.
 *
 * 우리 서비스워커는 캐시하지 않지만, 옛 버전이 남긴 캐시나 브라우저가 쥔 것이 있을 수 있다.
 * 캐시를 전부 지우고 → 서비스워커를 풀고 → 새 주소로 연다.
 * 주소 끝의 ?v= 는 "이건 처음 보는 주소" 라고 브라우저를 설득하는 몫이다.
 *
 * 데이터 스냅샷(localStorage)은 지우지 않는다 — 그건 코드가 아니고, 서버가 늘 이긴다.
 */
el.update.addEventListener("click", async () => {
  el.update.disabled = true;
  el.update.textContent = "업데이트 중…";
  try {
    if ("caches" in window) {
      for (const key of await caches.keys()) await caches.delete(key);
    }
    if ("serviceWorker" in navigator) {
      for (const one of await navigator.serviceWorker.getRegistrations()) await one.unregister();
    }
  } catch (error) {
    // 지우다 실패해도 새로 여는 것은 한다. 그것만으로 풀리는 경우가 대부분이다.
    console.error("[업데이트]", error);
  }
  location.replace(`/m?v=${Date.now()}`);
});

el.inquiryAdd.addEventListener("click", async () => {
  const value = await openForm({
    title: "문의하기",
    submitText: "보내기",
    fields: [
      {
        name: "content",
        label: "불편한 점·궁금한 점",
        type: "textarea",
        max: 1000,
        rows: 8,
        placeholder: "화면에서 안 되는 것이나 궁금한 것을 적어 주세요.",
        hint: "답장은 오지 않습니다. 센터에서 읽고 확인 표시를 남깁니다.",
      },
    ],
    onValidate: (v) => (!v.content ? "내용을 적어 주세요." : null),
  });
  if (!value) return;

  try {
    await send("/api/my/inquiries", "POST", { content: value.content });
    toast("보냈습니다");
    await refreshView(inquiryView());
  } catch (error) {
    toast(error.message, true);
  }
});
