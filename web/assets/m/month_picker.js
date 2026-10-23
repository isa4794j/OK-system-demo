/**
 * 달·날짜 고르기 — 월 이동줄의 달 글자나 📅 을 누르면 그 아래 뜨는 작은 판 (일정·일지 공용)
 *
 * 오늘은 늘 보인다 — 오늘 칸(달이면 이번 달 칸)에 테두리·점, 판 위에 "오늘 9월 17일(목)" 한 줄(누르면 이번 달로).
 *
 *   withDay=false  해 넘기기 + 열두 달 — 달을 고르면 닫힌다
 *   withDay=true   달 넘기기 + 날짜 — **기간**을 고른다(숙박 앱처럼)
 *                  첫 탭 = 시작일, 둘째 탭 = 종료일(사이는 칠해 보인다) → 닫힌다.
 *                  둘째 탭이 시작일보다 앞이면 그날이 새 시작일. 같은 날을 두 번 = 하루.
 *                  달을 넘겨 종료일을 골라도 된다. [N월 전체] 는 기간 없이 그 달로 닫힌다.
 *
 * 바깥·Esc·[×] 로 닫으면 고르던 것은 버리고 원래 걸려 있던 것 그대로(null).
 * 고른 값은 화면 안에만 둔다 — 주소·스냅샷에 남기지 않는다.
 */

const WEEK = ["일", "월", "화", "수", "목", "금", "토"];
const pad = (n) => String(n).padStart(2, "0");

/** 이 기기 기준 오늘 */
function today() {
  const now = new Date();
  return {
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    label: `${now.getMonth() + 1}월 ${now.getDate()}일(${WEEK[now.getDay()]})`,
  };
}

let closeOpen = null;

/**
 * anchor 아래에 판을 연다.
 * @returns {Promise<{year:number, month:number, from:string|null, to:string|null} | null>}
 */
export function pickMonth(anchor, { year, month, from = null, to = null, withDay = false }) {
  closeOpen?.(null);

  return new Promise((resolve) => {
    const panel = document.createElement("div");
    panel.className = "mpick";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", withDay ? "달·날짜 고르기" : "달 고르기");

    let y = year;
    let m = month;
    /** 첫 탭으로 고른 시작일(아직 종료일 전). 종료일 전에 닫히면 버린다. */
    let start = null;
    const day = (date) => ({ year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)) });

    const finish = (value) => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", onKey, true);
      panel.remove();
      closeOpen = null;
      resolve(value);
      anchor.focus?.();
    };
    closeOpen = finish;

    // 끝까지 안 고르고 닫으면 원래대로 — 고르던 시작일은 버린다
    const dismiss = () => finish(null);
    const outside = (event) => {
      if (!panel.contains(event.target) && !anchor.contains(event.target)) dismiss();
    };
    const onKey = (event) => {
      if (event.key === "Escape") dismiss();
    };

    const button = (text, className, run, label) => {
      const node = document.createElement("button");
      node.type = "button";
      node.className = className;
      node.textContent = text;
      if (label) node.setAttribute("aria-label", label);
      node.addEventListener("click", run);
      return node;
    };

    function draw() {
      panel.replaceChildren();

      const head = document.createElement("div");
      head.className = "mpick__head";
      const title = document.createElement("span");
      title.className = "mpick__title";
      title.textContent = withDay ? `${y}년 ${m}월` : `${y}년`;
      const step = (delta) => () => {
        if (!withDay) {
          y += delta;
        } else {
          m += delta;
          if (m < 1) [y, m] = [y - 1, 12];
          if (m > 12) [y, m] = [y + 1, 1];
        }
        draw();
      };
      head.append(
        button("‹", "mpick__nav", step(-1), withDay ? "지난달" : "지난해"),
        title,
        button("›", "mpick__nav", step(1), withDay ? "다음달" : "다음해"),
      );
      panel.append(head);

      // 오늘 — 판을 어디로 넘겼든 오늘이 어딘지 알 수 있게. 누르면 오늘이 든 달(해)로 돌아온다
      const now = today();
      const away = withDay ? (y !== now.year || m !== now.month) : y !== now.year;
      const todayLine = button(
        `오늘 ${now.label}${away ? " · 이번 달로" : ""}`,
        away ? "mpick__today is-away" : "mpick__today",
        () => {
          y = now.year;
          m = now.month;
          draw();
        },
        away ? `오늘 ${now.label} — 이번 달로 옮기기` : `오늘 ${now.label}`,
      );
      panel.append(todayLine);

      if (!withDay) {
        const grid = document.createElement("div");
        grid.className = "mpick__months";
        for (let i = 1; i <= 12; i++) {
          const on = y === year && i === month;
          const cls = ["mpick__cell"];
          if (on) cls.push("is-on");
          if (y === now.year && i === now.month) cls.push("is-today");
          const cell = button(`${i}월`, cls.join(" "), () => finish({ year: y, month: i, from: null, to: null }));
          if (cls.includes("is-today")) cell.setAttribute("aria-current", "date");
          grid.append(cell);
        }
        panel.append(grid);
        return;
      }

      panel.append(
        button(`${m}월 전체`, "mbtn mbtn--wide mpick__all", () => finish({ year: y, month: m, from: null, to: null })),
      );

      const hint = document.createElement("p");
      hint.className = "mpick__hint";
      hint.textContent = start ? "끝나는 날을 고르세요 (같은 날을 한 번 더 누르면 하루)" : "시작하는 날을 고르세요";
      panel.append(hint);

      const week = document.createElement("div");
      week.className = "mpick__week";
      week.setAttribute("aria-hidden", "true");
      for (const w of WEEK) {
        const s = document.createElement("span");
        s.textContent = w;
        week.append(s);
      }
      panel.append(week);

      const grid = document.createElement("div");
      grid.className = "mpick__days";
      const first = new Date(y, m - 1, 1).getDay();
      for (let i = 0; i < first; i++) grid.append(document.createElement("span"));
      const last = new Date(y, m, 0).getDate();
      for (let d = 1; d <= last; d++) {
        const date = `${y}-${pad(m)}-${pad(d)}`;
        // 칠하기 — 고르는 중이면 시작일만, 아니면 지금 걸린 기간
        const lo = start ?? from;
        const hi = start ? start : to;
        const cls = ["mpick__cell"];
        if (lo && hi && date > lo && date < hi) cls.push("is-range");
        if (date === lo || date === hi) cls.push("is-on");
        if (date === now.date) cls.push("is-today");
        const cell = button(String(d), cls.join(" "), () => {
          if (!start || date < start) {
            // 첫 탭, 또는 시작일보다 앞을 눌렀다 — 새 시작일
            start = date;
            draw();
            return;
          }
          // 둘째 탭 — 같은 날이면 하루, 뒤면 기간
          finish({ ...day(start), from: start, to: date });
        }, `${m}월 ${d}일`);
        if (date === start) cell.setAttribute("aria-pressed", "true");
        if (date === now.date) cell.setAttribute("aria-current", "date");
        grid.append(cell);
      }
      panel.append(grid);
    }

    draw();
    anchor.insertAdjacentElement("afterend", panel);
    // 여는 누름이 곧바로 "바깥 누름" 으로 잡히지 않게 한 박자 뒤에 건다
    setTimeout(() => {
      document.addEventListener("pointerdown", outside, true);
      document.addEventListener("keydown", onKey, true);
    });
    panel.querySelector(".is-on, .mpick__cell, button")?.focus();
  });
}

/** 열린 판이 있으면 닫고 true. 같은 자리를 다시 누르면 접히게 할 때 쓴다. */
export function closePicker() {
  if (!closeOpen) return false;
  closeOpen(null);
  return true;
}
