/**
 * 익명화 전수 — AI·서버 없이 lib/anonymize.ts 만 돌린다.
 *
 * A. 실제 명단(재원+종결 아동, 직원 전부)으로 표기(전체·성 뗀 이름·받침+이·가운데 가림·끝까지 가림)
 *    × 조사·학년·문장 모양을 만들어 hide → 새는 표기(leaks) 0, 성 뗀 이름이 그대로 남은 것(residual) 0 인지.
 * B. 비정형 이름(두 글자 성·외국 이름·네 글자·띄어 등록)을 명단에 더해 같은 검사 + 뒤쪽 두·세 글자 표기.
 * 실명은 출력하지 않는다(개수와 가린 예시만). 새는 것이 하나라도 있으면 종료 코드 1.
 *
 *   unset DATABASE_URL; deno run -A --env-file db/tools/verify/anon.ts
 */
import { listPeopleToMask } from "../../../lib/roster.ts";
import {
  assertNoLeak,
  hide,
  MASK_CHARS,
  maskForMessage,
  type RegisteredPerson,
} from "../../../lib/anonymize.ts";

const roster = await listPeopleToMask();
// B. 비정형 이름 — 실제 명단 뒤에 붙인다(아동이 먼저라는 명단 순서는 유지하지 않아도 된다: 이름이 겹치지 않는다)
const IRREGULAR = ["남궁민수", "김이나라", "응우옌티마이", "무함마드", "응우옌 반 안", "제갈윤서"];
const people: RegisteredPerson[] = [
  ...roster,
  ...IRREGULAR.map((name, i) => ({ id: `irregular-${i}`, name, kind: "child" as const })),
];
const kids = people.filter((p) => p.kind === "child");
const COMPOUND = ["남궁", "황보", "제갈", "사공", "선우", "서문", "독고", "동방"];
const sur = (n: string) => (n.length >= 3 && COMPOUND.includes(n.slice(0, 2)) ? 2 : 1);
const hasBatchim = (s: string) => {
  const c = s.charCodeAt(s.length - 1) - 0xac00;
  return c >= 0 && c <= 11171 && c % 28 !== 0;
};
const JOSA = [
  "이",
  "가",
  "은",
  "는",
  "을",
  "를",
  "랑",
  "이랑",
  "한테",
  "에게",
  "와",
  "과",
  "의",
  "도",
  "하고",
  "께서",
  "처럼",
  "씨",
  "님",
  "쌤",
  "샘",
  "군",
  "양",
  "네",
  "선생님",
  "한테도",
  "하고는",
  "에게만",
  "까지도",
  "부터는",
  "랑은",
  "네랑",
  "보다",
  "마저",
  "조차",
  "밖에",
  "에게서",
  "한테서",
  "라도",
  "이나",
  "으로",
  "로",
  "아",
  "야",
];
const GRADE = ["(초4)", "(중1)", "(3학년)", "(초등 5학년)"];
let cases = 0;
let leaked = 0;
let residual = 0;
const leakSamples: string[] = [];
const residualSamples: string[] = [];
const dupNames = new Set(
  people.map((p) => p.name).filter((n, i, a) => a.indexOf(n) !== i),
);
for (const p of people) {
  const name = p.name.trim();
  const s = sur(name);
  const given = name.slice(s);
  const forms: string[] = [name];
  const chars = [...name];
  for (let i = 1; i < chars.length - 1; i++) {
    for (const m of MASK_CHARS) {
      forms.push([...chars.slice(0, i), m, ...chars.slice(i + 1)].join(""));
    }
  }
  if (IRREGULAR.includes(name)) {
    const bare = name.replace(/s+/g, "");
    forms.push(bare, bare.slice(-2), bare.slice(-3));
    if (name.includes(" ")) forms.push(name.split(/s+/).join(""));
  }
  if ([...given].length >= 2) {
    forms.push(given);
    if (hasBatchim(given)) forms.push(given + "이");
    for (const m of ["*", "0", "O", "○"]) {
      forms.push(name.slice(0, s) + m.repeat([...given].length));
    }
  }
  for (const f of forms) {
    const variants = [
      `오늘 ${f} 왔다.`,
      ...JOSA.map((j) => `${f}${j} 블록을 쌓았다.`),
      ...GRADE.map((g) => `${f}${g}가 도왔다.`),
      `${f} 학생과 ${f}, ${f}!`,
      `"${f}"`,
      `${f}\n다음 줄`,
    ];
    for (const text of variants) {
      cases++;
      const r = hide(text, people);
      if (r.leaks.length) {
        leaked++;
        if (leakSamples.length < 5) {
          leakSamples.push(`${maskForMessage(name)} ← ${r.leaks.map(maskForMessage).join(",")}`);
        }
      }
      // findLeaks 가 보지 않는 성 뗀 표기까지 — 이름(2자 이상)이 낱말 경계에 그대로 남았나
      if ([...given].length >= 2) {
        const re = new RegExp(`(^|[^가-힣])${given}(이)?(?=[^가-힣]|$|${JOSA.join("|")})`);
        if (re.test(r.masked.replace(/【[^】]*】/g, "#")) && !dupNames.has(name)) {
          residual++;
          if (residualSamples.length < 8) {
            residualSamples.push(
              `${maskForMessage(name)} 표기 "${maskForMessage(f)}" → ${
                r.masked.replace(given, maskForMessage(given)).slice(0, 40)
              }`,
            );
          }
        }
      }
    }
  }
}
// 동명이인 → 토큰 하나, ambiguous
const dupOut: string[] = [];
for (const n of dupNames) {
  const r = hide(`${n}가 왔다.`, people);
  const e = Object.values(r.map.byCode).find((x) => r.masked.includes(x.code));
  dupOut.push(
    `${
      maskForMessage(n)
    } ambiguous=${e?.ambiguous} people=${e?.people.length} leaks=${r.leaks.length}`,
  );
}
// 전부 가림 — "00이가", "**가"
const allMask = ["00이가 울었다.", "**가 울었다.", "○○이는 웃었다.", "OO랑 놀았다."].map((t) => {
  const r = hide(t, people);
  const e = Object.values(r.map.byCode).find((x) => r.masked.includes(x.code));
  return `${t.slice(0, 4)} → ${r.masked.slice(0, 12)} ambiguous=${e?.ambiguous ?? "-"} 후보 ${
    e?.people.length ?? 0
  } (재원 ${kids.filter((k) => k.enrolled !== false).length})`;
});
// 실패 문구 — 실명이 안 실리는지
let failMessage = "";
try {
  assertNoLeak({ masked: "x", leaks: [kids[0].name] });
} catch (e) {
  failMessage = (e as Error).message;
}
console.log(JSON.stringify(
  {
    people: people.length,
    irregular: IRREGULAR.length,
    children: kids.length,
    ended_children: kids.filter((k) => k.enrolled === false).length,
    duplicate_names: dupNames.size,
    cases,
    leaked,
    leakSamples,
    residual,
    residualSamples,
    dupOut,
    allMask,
    fail_message_has_real_name: failMessage.includes(kids[0].name),
    fail_message: failMessage.replace(kids[0].name, "(실명)"),
  },
  null,
  1,
));
if (leaked || residual || failMessage.includes(kids[0].name)) Deno.exit(1);
Deno.exit(0);
