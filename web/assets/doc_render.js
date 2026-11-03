/**
 * 문서 그리기 한 벌 — 관찰일지·평가서·동의서·처리방침
 *
 * 인쇄 화면(print.js)·설정의 동의서 미리보기(documents.js)·공개 처리방침(privacy.js)이 같은 것을 쓴다.
 * 모양은 doc.css(.doc …). 글은 전부 textContent 로 넣는다(사람이 적은 글이다).
 *
 * 문구(동의서·처리방침)는 서버 설정에서 온다 — 여기에는 틀만 있고 업체 이름이 없다.
 */
import { gradeNumber } from "./grade.js";

/** {센터} → 센터 이름 (서버 lib/documents.ts fillCenter 와 같은 규칙) */
export function fillCenter(text, center) {
  return String(text ?? "").replaceAll("{센터}", center);
}

function node(tag, className, text) {
  const one = document.createElement(tag);
  if (className) one.className = className;
  if (text !== undefined && text !== null) one.textContent = text;
  return one;
}

/**
 * 기관이 채워야 하는 자리(`[기관 입력: …]`)를 눈에 띄게 그린다.
 * 모양은 서버 lib/documents.ts 의 blank()·BLANK_PATTERN 과 같은 것이다.
 *
 * 글은 여전히 textContent 로만 넣는다 — 사람이 적은 글에 innerHTML 을 쓰지 않는다.
 * 사람이 그 자리를 자기 기관 값으로 바꿔 쓰면 패턴이 안 걸려 표시도 사라진다.
 */
const BLANK_RE = /\[기관 입력:[^\]]*\]/g;

function blankParts(parent, text) {
  const whole = String(text ?? "");
  let last = 0;
  for (const found of whole.matchAll(BLANK_RE)) {
    if (found.index > last) {
      parent.append(document.createTextNode(whole.slice(last, found.index)));
    }
    parent.append(node("span", "doc__blank", found[0]));
    last = found.index + found[0].length;
  }
  if (last === 0) {
    parent.textContent = whole;
    return parent;
  }
  if (last < whole.length) parent.append(document.createTextNode(whole.slice(last)));
  return parent;
}

/** node() 와 같지만 글 안의 자리표시를 표시해 넣는다 */
function markedNode(tag, className, text) {
  return blankParts(node(tag, className), text);
}

/** "초등학교 4학년" — 기준일(기간의 학년도)로 센다 */
export function gradeFull(birthDate, when = new Date()) {
  const grade = gradeNumber(birthDate, when);
  if (grade === null) return "-";
  if (grade < 1) return "미취학";
  if (grade <= 6) return `초등학교 ${grade}학년`;
  if (grade <= 9) return `중학교 ${grade - 6}학년`;
  if (grade <= 12) return `고등학교 ${grade - 9}학년`;
  return "졸업";
}

/** "2026-03-05" → "2026. 3. 5." */
export function dateLong(iso) {
  if (!iso) return "";
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  return `${y}. ${m}. ${d}.`;
}

/** 결재란 — 왼쪽 세로 "결재" + 생활복지사 | 센터장, 아래 서명 빈 칸 */
function signBox() {
  const table = node("table", "doc__sign");
  table.setAttribute("aria-label", "결재란");
  const head = node("tr");
  const label = node("th", "doc__sign-label");
  label.rowSpan = 2;
  label.append(node("span", null, "결"), document.createElement("br"), node("span", null, "재"));
  head.append(label, node("th", null, "생활복지사"), node("th", null, "센터장"));
  const blank = node("tr");
  blank.append(node("td", "doc__sign-cell"), node("td", "doc__sign-cell"));
  table.append(head, blank);
  return table;
}

function titleBlock(title, withSign) {
  const head = node("header", "doc__head");
  head.append(node("span", "doc__head-side"), node("h1", "doc__title", title));
  head.append(withSign ? signBox() : node("span", "doc__head-side"));
  return head;
}

/**
 * 관찰일지·평가서.
 *   info  { name, grade, period, date, author }
 *   rows  [{ name, lines?: [{ date, tag, text }], text?: string }]
 *         lines 가 있으면 날짜별 줄, 없으면 text 문단. 둘 다 비면 empty 문구.
 */
export function renderRecordDoc({ title, center, info, rows, empty = "기록 없음" }) {
  const doc = node("article", "doc doc--record");
  doc.append(titleBlock(title, true));

  const table = node("table", "doc__info");
  const row = (...cells) => {
    const tr = node("tr");
    tr.append(...cells);
    table.append(tr);
  };
  const th = (text) => node("th", null, text);
  const td = (text, span = 1) => {
    const cell = node("td", null, text);
    cell.colSpan = span;
    return cell;
  };
  row(th("아동명"), td(info.name), th("학년"), td(info.grade));
  row(th("기간"), td(info.period, 3));
  row(th("작성일"), td(info.date), th("작성자"), td(info.author));
  doc.append(table);

  const body = node("table", "doc__body");
  for (const one of rows) {
    const tr = node("tr", "doc__row");
    const content = node("td", "doc__content");
    if (one.lines?.length) {
      tr.classList.add("doc__row--lines");
      for (const line of one.lines) {
        const p = node("p", "doc__line");
        p.append(node("span", "doc__date", line.date));
        p.append(node("span", "doc__tag", line.tag ? `[${line.tag}]` : ""));
        p.append(node("span", "doc__text", line.text));
        content.append(p);
      }
    } else if (one.text?.trim()) {
      content.append(node("p", "doc__para", one.text.trim()));
    } else {
      content.append(node("p", "doc__empty", empty));
    }
    tr.append(node("th", "doc__area", one.name), content);
    body.append(tr);
  }
  doc.append(body);
  doc.append(node("footer", "doc__foot", center));
  return doc;
}

/** 동의서 — 저장된 문구(consent_form) 그대로. 항목마다 한 덩어리(페이지 중간에서 안 끊긴다) */
export function renderConsentDoc(form, center) {
  const fill = (text) => fillCenter(text, center);
  const doc = node("article", "doc doc--consent");
  doc.append(titleBlock(fill(form.title), false));
  if (form.intro?.trim()) doc.append(node("p", "doc__intro", fill(form.intro)));

  for (const section of form.sections ?? []) {
    const box = node("section", "doc__section");
    box.append(node("h2", "doc__section-title", fill(section.title)));
    const table = node("table", "doc__rows");
    for (const row of section.rows ?? []) {
      const tr = node("tr");
      tr.append(
        node("th", null, fill(row.label)),
        markedNode("td", null, fill(row.text)),
      );
      table.append(tr);
    }
    box.append(table);
    if (section.choice) {
      const choice = node("p", "doc__choice");
      choice.append(node("span", null, "□ 동의함"), node("span", null, "□ 동의하지 않음"));
      box.append(choice);
    }
    doc.append(box);
  }

  const end = node("section", "doc__end");
  if (form.notes?.trim()) end.append(node("p", "doc__notes", fill(form.notes)));
  if (form.confirm?.trim()) end.append(node("p", "doc__confirm", fill(form.confirm)));
  end.append(node("p", "doc__dateline", "20        년        월        일"));
  const signs = node("div", "doc__signs");
  for (const line of form.signs ?? []) signs.append(node("p", null, fill(line)));
  end.append(signs);
  if (form.addressee?.trim()) end.append(node("p", "doc__addressee", fill(form.addressee)));
  doc.append(end);
  return doc;
}

/** 처리방침 — 서버가 {센터} 를 이미 채워 보낸다 */
export function renderPolicyDoc(policy, { staffNotice = false } = {}) {
  const doc = node("article", "doc doc--policy");
  doc.append(node("h1", "doc__title doc__title--plain", policy.title));
  if (policy.intro?.trim()) doc.append(node("p", "doc__intro", policy.intro));
  for (const section of policy.sections ?? []) {
    const box = node("section", "doc__section doc__section--plain");
    box.append(node("h2", "doc__section-title", section.title));
    box.append(markedNode("p", "doc__para", section.body));
    doc.append(box);
  }
  if (staffNotice) {
    const box = node("section", "doc__section doc__section--plain");
    box.append(node("h2", "doc__section-title", "직원·봉사자 로그인 안내"));
    box.append(node("p", "doc__para", policy.staff_notice));
    box.append(node("p", "doc__para doc__para--strong", `☑ ${policy.staff_agree}`));
    doc.append(box);
  }
  return doc;
}
