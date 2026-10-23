/**
 * 가명화 테스트
 *
 *   deno task test
 *
 * 사람이 눈으로 보는 표는 lib/anonymize_demo.ts 에서 찍는다.
 *
 * 여기서 가장 중요한 것은 두 가지다.
 *   1. 현장에서 쓰는 표기(김*준, 윤0원, 길동, 윤0원(중1))가 전부 잡히는가
 *   2. 누구인지 못 가릴 때 추측하지 않는가
 */
import { assertEquals } from "@std/assert";
import {
  assertNoLeak,
  findLeaks,
  hide,
  LEAK_TAILS,
  maskForMessage,
  type RegisteredPerson,
  show,
} from "./anonymize.ts";

const PEOPLE: RegisteredPerson[] = [
  { id: "c1", name: "테스원", kind: "child" }, // 원: 받침 있음
  { id: "c2", name: "테스투", kind: "child" }, // 투: 받침 없음
  { id: "c3", name: "김하늘", kind: "child" },
  { id: "s1", name: "김멘토", kind: "staff", role: "멘토" },
  { id: "s2", name: "이복지", kind: "staff", role: "종사자" },
  { id: "s3", name: "박봉사", kind: "staff", role: "봉사자" },
];

// 토큰: 아동1=테스원 아동2=테스투 아동3=김하늘 멘토1=김멘토 종사자1=이복지 봉사자1=박봉사

Deno.test("토큰은 종류와 역할에 따라 붙는다", () => {
  const { map } = hide("", PEOPLE);
  assertEquals(map.byName, {
    "테스원": "【아동1】",
    "테스투": "【아동2】",
    "김하늘": "【아동3】",
    "김멘토": "【멘토1】",
    "이복지": "【종사자1】",
    "박봉사": "【봉사자1】",
  });
});

Deno.test("조사가 토큰에 맞게 바뀐다", () => {
  const cases: Array<[string, string]> = [
    // 아동1(일: 받침 있음) — 이/은/을/과. 닫는 괄호가 아니라 그 앞의 소리로 가린다.
    ["테스원이 왔다", "【아동1】이 왔다"],
    ["테스원은 조용했다", "【아동1】은 조용했다"],
    ["테스원을 불렀다", "【아동1】을 불렀다"],
    ["테스원과 놀았다", "【아동1】과 놀았다"],
    ["테스원으로 정했다", "【아동1】로 정했다"],
    ["테스원이랑 짝이 되었다", "【아동1】이랑 짝이 되었다"],

    // 아동2(이: 받침 없음) — 가/는/를/와
    ["테스투가 웃었다", "【아동2】가 웃었다"],
    ["테스투는 늦었다", "【아동2】는 늦었다"],
    ["테스투를 만났다", "【아동2】를 만났다"],
    ["테스투와 앉았다", "【아동2】와 앉았다"],

    // 받침 유무가 바뀌는 경우 — 조사도 따라 바뀌어야 한다
    ["김하늘이 도왔다", "【아동3】이 도왔다"],
    ["이복지가 기록했다", "【종사자1】이 기록했다"],
    ["박봉사가 함께했다", "【봉사자1】이 함께했다"],

    // 변하지 않는 조사는 그대로
    ["테스원에게 물었다", "【아동1】에게 물었다"],
    ["테스투의 가방", "【아동2】의 가방"],
    ["테스원에서부터", "【아동1】에서부터"],
  ];

  for (const [input, expected] of cases) {
    assertEquals(hide(input, PEOPLE).masked, expected, `입력: ${input}`);
  }
});

Deno.test("같은 이름은 몇 번 나와도 같은 토큰", () => {
  const text = "테스원이 왔다. 테스원은 앉았고, 테스원을 도왔다.";
  assertEquals(
    hide(text, PEOPLE).masked,
    "【아동1】이 왔다. 【아동1】은 앉았고, 【아동1】을 도왔다.",
  );
});

Deno.test("아동과 직원이 섞여도 각각 제 토큰으로", () => {
  const text = "김멘토가 테스원과 이복지에게 말했다. 박봉사는 테스투를 도왔다.";
  assertEquals(
    hide(text, PEOPLE).masked,
    "【멘토1】이 【아동1】과 【종사자1】에게 말했다. 【봉사자1】은 【아동2】를 도왔다.",
  );
});

/* ---------- 현장 표기 ---------- */

const 반: RegisteredPerson[] = [
  { id: "k1", name: "김하준", kind: "child", grade: 2 }, // 초2
  { id: "k2", name: "윤채원", kind: "child", grade: 7 }, // 중1
  { id: "k3", name: "남궁길동", kind: "child", grade: 4 }, // 초4
];

Deno.test("가운데를 가린 표기를 잡는다", () => {
  for (const mask of ["*", "0", "O", "o", "○", "●", "x", "X"]) {
    const text = `김${mask}준이 왔다`;
    assertEquals(hide(text, 반).masked, "【아동1】이 왔다", `가림문자: ${mask}`);
  }
});

Deno.test("성을 뗀 표기를 잡는다", () => {
  assertEquals(hide("하준이 왔다", 반).masked, "【아동1】이 왔다");
  assertEquals(hide("채원과 놀았다", 반).masked, "【아동2】와 놀았다");
});

Deno.test("성을 뗀 표기는 다른 낱말 속을 파고들지 않는다", () => {
  // "하준"이 더 긴 말의 일부일 때 떼어 가면 안 된다.
  // (풀네임은 이 규칙을 두지 않는다 — "테스원은행"의 "테스원"은 가려야 하기 때문이다)
  assertEquals(hide("하준희가 왔다", 반).masked, "하준희가 왔다");
  assertEquals(hide("이하준이 왔다", 반).masked, "이하준이 왔다");
});

Deno.test("괄호 학년이 붙어도 잡고, 괄호는 글에 그대로 둔다", () => {
  assertEquals(hide("윤0원(중1)-음계 연습", 반).masked, "【아동2】(중1)-음계 연습");
  assertEquals(hide("김0준(초2)-음계 연습", 반).masked, "【아동1】(초2)-음계 연습");
  assertEquals(hide("하준(2학년)이 왔다", 반).masked, "【아동1】(2학년)이 왔다");
});

Deno.test("복성과 외자도 깨지지 않는다", () => {
  // 성이 두 글자다. 이름은 "길동" 이지 "궁길동" 이 아니다.
  assertEquals(hide("길동이 왔다", 반).masked, "【아동3】이 왔다");
  assertEquals(hide("남궁*동이 왔다", 반).masked, "【아동3】이 왔다");

  // 두 글자 이름은 가릴 가운데가 없다. 아무것도 만들지 않되 풀네임은 잡힌다.
  const 외자: RegisteredPerson[] = [{ id: "x", name: "홍길", kind: "child" }];
  assertEquals(hide("홍길이 왔다", 외자).masked, "【아동1】이 왔다");
});

Deno.test("한 사람의 표기가 여러 가지여도 토큰은 하나다", () => {
  const text = "김하준이 왔다. 김*준은 앉았고, 하준을 도왔다.";
  assertEquals(
    hide(text, 반).masked,
    "【아동1】이 왔다. 【아동1】은 앉았고, 【아동1】을 도왔다.",
  );
});

/* ---------- 이름 뒤의 "이" ---------- */

Deno.test('이름 뒤의 "이" 를 먹고 조사를 이어 붙인다', () => {
  // 김하준(준: 받침 있음) → 【아동1】(일: 받침 있음)
  const cases: Array<[string, string]> = [
    ["하준이가 왔다", "【아동1】이 왔다"],
    ["하준이는 앉았다", "【아동1】은 앉았다"],
    ["하준이를 불렀다", "【아동1】을 불렀다"],
    ["하준이도 왔다", "【아동1】도 왔다"],
    ["하준이랑 놀았다", "【아동1】이랑 놀았다"],
    ["하준이와 놀았다", "【아동1】과 놀았다"],
    ["하준이한테 물었다", "【아동1】한테 물었다"],
    ["하준이에게 물었다", "【아동1】에게 물었다"],
    // 풀네임·가림 표기 뒤에도 똑같이
    ["김하준이가 왔다", "【아동1】이 왔다"],
    ["김*준이는 앉았다", "【아동1】은 앉았다"],
  ];
  for (const [input, expected] of cases) {
    assertEquals(hide(input, 반).masked, expected, `입력: ${input}`);
  }
});

Deno.test('받침 없는 이름에는 "이" 가 붙지 않는다', () => {
  const people: RegisteredPerson[] = [{ id: "a", name: "김서아", kind: "child" }];
  // "서아가" 는 그대로 조사다. "서아이가" 같은 말은 쓰지 않는다.
  assertEquals(hide("서아가 왔다", people).masked, "【아동1】이 왔다");
});

Deno.test('뒤가 끊긴 "이" 는 조사로 둔다', () => {
  // "도현이 - " 의 "이" 가 이름의 일부인지 주격조사인지는 글자로 가릴 수 없다.
  // 먹어 버리면 "【아동1】 왔다" 가 되어 말이 깨지므로 조사로 넘긴다.
  assertEquals(hide("하준이 왔다", 반).masked, "【아동1】이 왔다");
});

Deno.test("이름 조각이 다른 낱말에 이어지면 잡지 않는다", () => {
  const people: RegisteredPerson[] = [{ id: "a", name: "김서준", kind: "child" }];
  // "준서준비물" — 앞이 안 끊겨서, "서준비물" — 뒤가 안 끊겨서
  assertEquals(hide("준서준비물을 챙겼다", people).masked, "준서준비물을 챙겼다");
  assertEquals(hide("서준비물을 챙겼다", people).masked, "서준비물을 챙겼다");
  // "이"가 뒤로 이어지는 것도 이름의 "이" 가 아니다
  assertEquals(hide("서준이해했다", people).masked, "서준이해했다");
});

/* ---------- 이름이 통째로 가려진 표기 ---------- */

const 재원: RegisteredPerson[] = [
  { id: "a", name: "김하준", kind: "child", grade: 2 },
  { id: "b", name: "윤채원", kind: "child", grade: 7 },
  { id: "c", name: "옛아이", kind: "child", grade: 6, enrolled: false },
];

/** 그 글에서 쓰인 첫 토큰의 기록을 꺼낸다 */
function usedEntry(text: string, people: RegisteredPerson[]) {
  const r = hide(text, people);
  const code = r.masked.slice(r.masked.indexOf("【"), r.masked.indexOf("】") + 1);
  return { masked: r.masked, entry: r.map.byCode[code] };
}

Deno.test("이름이 통째로 가려진 표기는 확인 필요로 잡는다", () => {
  for (const text of ["00이가 왔다", "**는 앉았다", "○○(초2) 왔다"]) {
    const { entry } = usedEntry(text, 재원);
    assertEquals(entry?.ambiguous, true, `입력: ${text}`);
    // 종결한 아이는 후보에 넣지 않는다
    assertEquals(entry?.people.includes("c"), false, `입력: ${text}`);
  }
});

Deno.test("가려진 표기도 괄호 학년으로 후보를 좁힌다 — 다만 확정하지는 않는다", () => {
  const { entry } = usedEntry("00이(초2) 블록을 쌓았다", 재원);
  assertEquals(entry?.people, ["a"]);
  // 후보가 하나여도 그 아이라는 근거가 표기 안에 없다. 사람이 확인해야 한다.
  assertEquals(entry?.ambiguous, true);
});

Deno.test("조사도 괄호도 없는 가림 표기는 잡지 않는다", () => {
  // 전화번호·수량·날짜가 훨씬 많다
  for (const text of ["00 왔다", "010-0000-0000 으로 연락", "합계 00 원"]) {
    assertEquals(hide(text, 재원).masked, text, `입력: ${text}`);
  }
});

Deno.test("숫자에 이어진 가림 표기는 잡지 않는다", () => {
  assertEquals(hide("100이 넘는 책을 읽었다", 재원).masked, "100이 넘는 책을 읽었다");
  assertEquals(hide("2500이랑 3000", 재원).masked, "2500이랑 3000");
});

Deno.test("가림문자 한 자는 잡지 않는다", () => {
  assertEquals(hide("0이 왔다", 재원).masked, "0이 왔다");
  assertEquals(hide("*가 왔다", 재원).masked, "*가 왔다");
});

Deno.test("성이 남은 가림 표기는 그 성의 아이들로 좁힌다", () => {
  const people: RegisteredPerson[] = [
    { id: "a", name: "김하준", kind: "child" },
    { id: "b", name: "김서아", kind: "child" },
    { id: "c", name: "윤채원", kind: "child" },
  ];
  const { entry } = usedEntry("김00이가 왔다", people);
  assertEquals(entry?.people, ["a", "b"]);
  assertEquals(entry?.ambiguous, true);
});

/* ---------- 누구인지 못 가릴 때 ---------- */

const 헷갈림: RegisteredPerson[] = [
  { id: "a", name: "김하준", kind: "child", grade: 2 }, // 초2
  { id: "b", name: "김서준", kind: "child", grade: 5 }, // 초5
  { id: "c", name: "이영희", kind: "child", grade: 3 },
];

Deno.test("한 표기가 두 아동과 맞으면 추측하지 않는다", () => {
  const result = hide("김0준이 이영희와 놀았다", 헷갈림);

  const entry = result.map.entries.find((e) => e.ambiguous);
  assertEquals(entry?.people, ["a", "b"]);
  // 누구인지 모르므로 실명이 아니라 글에 적혀 있던 표기로 돌아온다
  assertEquals(entry?.name, "김0준");
  assertEquals(show(result.masked, result.map), "김0준이 이영희와 놀았다");
});

Deno.test("괄호 학년이 있으면 그걸로 좁혀 확정한다", () => {
  const result = hide("김0준(초2)이 왔다", 헷갈림);

  const token = result.map.byName["김하준"];
  assertEquals(result.masked, `${token}(초2)이 왔다`);
  assertEquals(result.map.byCode[token].ambiguous, false);
});

Deno.test("괄호 학년이 아무와도 안 맞으면 좁히지 않는다", () => {
  // 초6 인 김?준 은 없다. 잘못 좁혀 한 명으로 확정하느니 사람에게 묻는다.
  const result = hide("김0준(초6)이 왔다", 헷갈림);
  const entry = result.map.entries.find((e) => e.ambiguous);
  assertEquals(entry?.people, ["a", "b"]);
});

Deno.test("동명이인은 한 토큰으로 묶고 표시를 남긴다", () => {
  const 쌍둥이: RegisteredPerson[] = [
    { id: "a", name: "김철수", kind: "child", grade: 3 },
    { id: "b", name: "김철수", kind: "child", grade: 5 },
    { id: "c", name: "이영희", kind: "child" },
  ];
  const result = hide("김철수가 이영희와 놀았다", 쌍둥이);

  const entry = result.map.entries.find((e) => e.ambiguous);
  assertEquals(entry?.people, ["a", "b"]);

  // 이름만으로는 토큰을 고를 수 없으므로 byName 에 두지 않는다
  assertEquals(result.map.byName["김철수"], undefined);

  // 어차피 같은 이름이라 왕복은 어긋나지 않는다
  assertEquals(show(result.masked, result.map), "김철수가 이영희와 놀았다");
});

Deno.test("동명이인도 괄호 학년이 있으면 갈린다", () => {
  const 쌍둥이: RegisteredPerson[] = [
    { id: "a", name: "김철수", kind: "child", grade: 3 },
    { id: "b", name: "김철수", kind: "child", grade: 5 },
  ];
  const result = hide("김철수(초5)가 왔다", 쌍둥이);

  const entry = result.map.byCode[result.masked.slice(0, result.masked.indexOf("】") + 1)];
  assertEquals(entry.ambiguous, false);
  assertEquals(entry.people, ["b"]);
});

/* ---------- 겹침·왕복·안전망 ---------- */

Deno.test("긴 이름을 먼저 바꿔 짧은 이름과 겹치지 않는다", () => {
  const people: RegisteredPerson[] = [
    { id: "a", name: "김민", kind: "child" },
    { id: "b", name: "김민수", kind: "child" },
  ];
  const result = hide("김민수와 김민이 함께 왔다", people);
  assertEquals(result.masked, "【아동2】와 【아동1】이 함께 왔다");
  assertEquals(result.leaks, []);
});

Deno.test("조사 뒤에 한글이 이어지면 조사로 보지 않는다", () => {
  const people: RegisteredPerson[] = [{ id: "a", name: "테스원", kind: "child" }];
  // "은행"의 은은 조사가 아니다 — 건드리면 안 된다
  assertEquals(hide("테스원은행에 갔다", people).masked, "【아동1】은행에 갔다");
});

Deno.test("hide → show 왕복이 원문과 같다", () => {
  const texts = [
    "테스원이 왔다",
    "테스투가 웃었다",
    "김멘토가 테스원과 이복지에게 말했다",
    "테스원은 조용했고 테스투는 늦었다",
    "박봉사가 테스투를 도왔다",
    "테스원에게 물었더니 테스투의 가방이라고 했다",
    "김하늘이 테스원으로 정했다",
    "테스원이랑 테스투랑 셋이 놀았다",
    "이복지가 기록했고 김멘토가 확인했다",
    "테스원, 테스투, 김하늘이 모두 참여했다",
    "등록되지 않은 이름은 그대로 남는다",
    "테스원이 왔다. 테스원은 앉았고, 테스원을 도왔다.",
  ];

  for (const text of texts) {
    const result = hide(text, PEOPLE);
    assertEquals(show(result.masked, result.map), text, `왕복 실패: ${text}`);
  }
});

Deno.test("가려 쓴 표기는 사람으로 돌아온다", () => {
  // 왕복해도 "김*준"이 아니라 "김하준"이 된다.
  // 기록에는 표기가 아니라 누구인지가 남아야 하기 때문이다.
  const result = hide("김*준이 왔다", 반);
  assertEquals(show(result.masked, result.map), "김하준이 왔다");
});

Deno.test("안전망: 실명과 가림 표기가 남으면 leaks에 잡힌다", () => {
  const clean = hide("테스원이 왔다", PEOPLE);
  assertEquals(clean.leaks, []);
  assertEquals(assertNoLeak(clean), "【아동1】이 왔다");

  // 성이 남는 표기는 새면 잡아낸다
  assertEquals(findLeaks("테스원이 왔다", PEOPLE), ["테스원"]);
  // 없는 자리를 가린 표기라 성 붙은 표기로는 안 잡히지만, 뒤의 "하늘이" 는 성 뗀 이름이라 잡는다
  assertEquals(findLeaks("김*하늘이 왔다", PEOPLE), ["하늘"]);
  assertEquals(findLeaks("김*늘이 왔다", PEOPLE), ["김*늘"]);
  assertEquals(findLeaks("【아동1】이 왔다", PEOPLE), []);
});

Deno.test("assertNoLeak은 실명이 남으면 던진다", () => {
  const broken = {
    masked: "테스원이 왔다",
    map: { byCode: {}, byName: {}, entries: [] },
    leaks: ["테스원"],
  };
  let message = "";
  try {
    assertNoLeak(broken);
  } catch (error) {
    message = (error as Error).message;
  }
  // 던지되, 문구에 실명은 싣지 않는다 — 서버 로그와 화면으로 나가는 문장이다
  assertEquals(message.startsWith("가명화에 실패했습니다"), true);
  assertEquals(message.includes("테스원"), false);
  assertEquals(message.includes("테*원"), true);
});

Deno.test("오류 문구의 이름은 첫 글자와 끝 글자만 남긴다", () => {
  assertEquals(maskForMessage("김민준"), "김*준");
  assertEquals(maskForMessage("남궁민호"), "남**호");
  assertEquals(maskForMessage("이안"), "이*");
  assertEquals(maskForMessage("김"), "*");
  // 이미 가린 표기는 모양이 그대로다
  assertEquals(maskForMessage("김*늘"), "김*늘");
});

Deno.test("이름 목록이 비어도 안전하다", () => {
  const result = hide("아무 이름도 등록되지 않았다", []);
  assertEquals(result.masked, "아무 이름도 등록되지 않았다");
  assertEquals(result.leaks, []);
  assertEquals(show(result.masked, result.map), "아무 이름도 등록되지 않았다");
});

Deno.test("정규식 특수문자가 든 이름도 안전하다", () => {
  const people: RegisteredPerson[] = [{ id: "a", name: "김(철)수", kind: "child" }];
  const result = hide("김(철)수가 왔다", people);
  // 토큰이 "일"로 끝나 받침이 있으므로 "가"가 "이"로 바뀐다
  assertEquals(result.masked, "【아동1】이 왔다");
  assertEquals(result.leaks, []);
});

/* ---------- 1차 전수 점검(2026-09-17): 성 뗀 이름 + 조사·부름말 ---------- */

const KIDS: RegisteredPerson[] = [
  { id: "k1", name: "강도윤", kind: "child" }, // 윤: 받침 있음
  { id: "k2", name: "김서아", kind: "child" }, // 아: 받침 없음
  { id: "k3", name: "남궁민호", kind: "child" }, // 복성
];

const TAILS = [
  "이",
  "가",
  "은",
  "는",
  "을",
  "를",
  "과",
  "와",
  "랑",
  "이랑",
  "하고",
  "한테",
  "에게",
  "에게서",
  "한테서",
  "께서",
  "부터",
  "까지",
  "처럼",
  "보다",
  "같이",
  "마저",
  "조차",
  "밖에",
  "의",
  "도",
  "만",
  "에",
  "아",
  "야",
  "라도",
  "이나",
  "으로",
  "로",
  "씨",
  "님",
  "쌤",
  "샘",
  "군",
  "양",
  "네",
  "선생님",
  // 이어 붙은 꼴
  "한테도",
  "하고는",
  "에게만",
  "까지도",
  "부터는",
  "랑은",
  "네랑",
  "쌤이",
  "님께",
];

Deno.test("성 뗀 이름 + 조사·부름말은 전부 가려지고 안전망에도 안 남는다", () => {
  for (const [given, withSuffix] of [["도윤", true], ["서아", false], ["민호", false]] as const) {
    const forms = withSuffix ? [given, `${given}이`] : [given];
    for (const form of forms) {
      for (const tail of TAILS) {
        const text = `오늘 ${form}${tail} 블록을 쌓았다.`;
        const result = hide(text, KIDS);
        assertEquals(
          result.masked.includes(given),
          false,
          `가리지 못함: ${text} → ${result.masked}`,
        );
        assertEquals(result.leaks, [], `안전망에 남음: ${text}`);
      }
    }
  }
});

Deno.test("안전망은 hide 와 따로 성 뗀 이름 + 조사를 잡는다", () => {
  // hide 를 거치지 않은 글 — 안전망 혼자 잡아야 한다
  for (const tail of TAILS) {
    assertEquals(findLeaks(`오늘 도윤${tail} 왔다`, KIDS), ["도윤"], tail);
  }
  // 낱말 속·토큰 속은 잡지 않는다
  assertEquals(findLeaks("서아름다운 날", KIDS), []);
  assertEquals(findLeaks("도윤기 선생님", KIDS), []);
  assertEquals(
    findLeaks("【아동1】하고 【멘토2】", [{
      id: "m",
      name: "김멘토",
      kind: "staff",
      role: "멘토",
    }]),
    [],
  );
});

Deno.test("안전망의 꼬리 목록은 hide 가 가리는 꼬리를 모두 품는다", () => {
  for (const tail of LEAK_TAILS) {
    const result = hide(`오늘 도윤${tail} 왔다`, KIDS);
    assertEquals(result.masked.includes("도윤"), false, `hide 가 못 가리는 꼬리: ${tail}`);
  }
});

/* ---------- 비정형 이름 (2026-09-18 점검) ---------- */

const ODD_NAMES: RegisteredPerson[] = [
  { id: "c1", name: "남궁민수", kind: "child" },
  { id: "c2", name: "김이나라", kind: "child" },
  { id: "c3", name: "응우옌티마이", kind: "child" },
  { id: "c4", name: "무함마드", kind: "child" },
  { id: "c5", name: "김빛", kind: "child" },
];

Deno.test("긴 이름은 뒤쪽 두·세 글자로 불러도 가려진다", () => {
  const cases: Array<[string, string]> = [
    ["남궁민수가 왔다", "남궁민수"], // 복성 — 성 두 글자
    ["민수는 블록을 쌓았다", "민수"],
    ["김이나라가 책을 읽었다", "김이나라"],
    ["나라가 노래했다", "나라"], // 성1+이름3 — 뒤 두 글자
    ["응우옌티마이가 왔다", "응우옌티마이"],
    ["마이랑 그림을 그렸다", "마이"], // 외국계 — 성 길이를 못 재도 부르는 이름은 잡는다
    ["티마이 어머니가 오셨다", "티마이"],
    ["무함마드가 축구를 했다", "무함마드"],
  ];
  for (const [text, gone] of cases) {
    const result = hide(text, ODD_NAMES);
    assertEquals(result.masked.includes(gone), false, text);
    assertEquals(result.leaks, [], text);
    assertEquals(findLeaks(text, ODD_NAMES).length > 0, true, `안전망이 원문을 잡아야: ${text}`);
  }
});

Deno.test("띄어쓰기가 달라도 같은 이름으로 본다", () => {
  const spaced: RegisteredPerson[] = [{ id: "s", name: "응우옌 티 마이", kind: "child" }];
  const tight: RegisteredPerson[] = [{ id: "t", name: "응우옌티마이", kind: "child" }];
  for (
    const [people, text] of [
      [spaced, "응우옌 티 마이가 왔다"],
      [spaced, "응우옌티마이가 왔다"],
      [tight, "응우옌 티 마이가 왔다"],
      [tight, "응우옌티마이가 왔다"],
    ] as const
  ) {
    const result = hide(text, people);
    assertEquals(/응우옌|마이/.test(result.masked), false, text);
    assertEquals(result.leaks, [], text);
  }
});

Deno.test("공백을 건너뛰는 맞추기는 앞이 끊긴 자리에서만 — 앞 낱말 끝소리를 먹지 않는다", () => {
  const people: RegisteredPerson[] = [{ id: "a", name: "서지안", kind: "child" }];
  // "장면에서 지안이" 의 "서 지안" 을 이름으로 보면 앞 낱말이 잘린다(실데이터에서 잡힌 사고)
  const result = hide("장면에서 지안이 웃었다", people);
  assertEquals(result.masked.startsWith("장면에서 "), true, result.masked);
  assertEquals(result.masked.includes("지안"), false, result.masked);
});

Deno.test("두 글자 이름은 성 뗀 한 글자를 만들지 않는다(설계)", () => {
  const result = hide("김빛이 왔다", ODD_NAMES);
  assertEquals(result.masked.includes("김빛"), false);
  // "빛" 하나만 적힌 글은 가리지도, 막지도 않는다 — 한 글자는 아무 데나 걸린다
  assertEquals(hide("빛이 웃었다", ODD_NAMES).masked, "빛이 웃었다");
  assertEquals(findLeaks("빛나는 하루", ODD_NAMES), []);
});
