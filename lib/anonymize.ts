/**
 * 가명화 — AI로 텍스트를 보내기 전에 실명을 토큰으로 바꾸고, 응답에서 되돌린다.
 *
 * 이 파일은 순수 함수만 둔다. DB에 접근하지 않는다.
 * 이름 목록은 반드시 인자로 받는다. 그래야 DB 없이 테스트할 수 있고,
 * 개인정보를 다루는 이 로직을 눈으로 검증할 수 있다.
 * (명단을 읽어 넘겨주는 일은 lib/roster.ts 가 맡는다)
 *
 * [현장 표기]
 * 일지에 이름이 늘 풀네임으로 적히지 않는다. 가려 쓰고(김*준, 윤0원),
 * 성을 떼고(길동), 학년을 붙인다(윤0원(중1)). 예전에는 풀네임만 찾았기 때문에
 * 이런 표기가 통째로 새어 나갔고 관찰도 뽑히지 않았다.
 * 그래서 명단의 이름 하나에서 쓸 수 있는 표기를 모두 만들어 두고 찾는다.
 * 표기는 이름의 글자 수를 가정하지 않고 실제 이름에서 만든다 — 외자도 복성도 깨지지 않게.
 *
 * [누구인지 못 가리면 추측하지 않는다]
 * 한 표기가 두 사람 이상과 맞으면(김0준 → 김하준·김서준, 동명이인 서지안 둘)
 * 괄호 학년으로 좁혀 보고, 그래도 안 갈리면 한 무리에 토큰 하나를 준다.
 * ambiguous 로 표시해 두면 부르는 쪽이 "아동 확인 필요"로 남겨 사람에게 묻는다.
 * 아무 쪽에나 붙이면 남의 기록이 되므로, 기계는 여기서 멈춘다.
 *
 * [토큰 모양]
 * 【아동1】처럼 괄호로 감싼다. 감싸지 않으면 모델이 "아동1"을 "그 아이"로
 * 바꿔 쓰거나 "아동12"의 앞부분과 헷갈린다. 괄호는 글 속에서 눈에 띄어
 * 모델이 손대지 말아야 할 덩어리라는 것도 분명해진다.
 *
 * 한글 조사 처리
 *   이름 뒤에 붙는 조사는 앞말의 받침에 따라 모양이 달라진다.
 *   ("테스원이" / "테스투가")
 *   이름을 토큰으로 바꾸면 앞말이 바뀌므로 조사도 다시 맞춰야 한다.
 *   그대로 두면 "【종사자1】가" 같은 어색한 말이 나오고, AI가 읽기도 나빠진다.
 *   되돌릴 때도 같은 이유로 다시 맞춘다.
 */

/* ---------- 타입 ---------- */

export type PersonKind = "child" | "staff";

/** 이름 목록의 한 사람 */
export type RegisteredPerson = {
  id: string;
  name: string;
  kind: PersonKind;
  /** 직원일 때만: 멘토 / 봉사자 / 종사자. 토큰 앞머리에 쓰인다. */
  role?: string;
  /**
   * 학년 숫자. 초1=1 … 초6=6, 중1=7 … 중3=9, 고1=10 … 고3=12. 모르면 null.
   * 괄호 표기(초4)(4학년)로 같은 표기를 쓰는 사람을 갈라낼 때만 쓴다.
   */
  grade?: number | null;
  /**
   * 지금 다니고 있는가. 이름이 통째로 가려진 표기("00이가")의 후보를 고를 때만 쓴다.
   * 가려진 표기는 누구인지 알 방법이 없어 명단 전체가 후보인데, 종결한 아이까지
   * 고르라고 늘어놓으면 고르기가 어려워진다.
   * 값을 주지 않으면 다니는 것으로 본다 — 후보가 좁아지다 못해 비는 일이 없게.
   */
  enrolled?: boolean;
};

/** 토큰 하나에 대한 기록 */
export type MaskEntry = {
  /** 글 속에 들어가는 토큰. 예: "【아동1】" */
  code: string;
  /** 되돌릴 때 쓸 글자. 한 사람이면 실명, 여러 명이면 글에 적혀 있던 표기 그대로. */
  name: string;
  kind: PersonKind;
  role?: string;
  /** 이 토큰이 가리키는 사람들의 id. 둘 이상이면 누구인지 가리지 못한 것이다. */
  people: string[];
  /** 누구인지 가리지 못했는가 */
  ambiguous: boolean;
};

export type MaskMap = {
  byCode: Record<string, MaskEntry>;
  /** 실명 → 토큰. 같은 이름을 쓰는 사람이 둘 이상이면 여기 없다(가릴 수 없어서). */
  byName: Record<string, string>;
  entries: MaskEntry[];
};

export type HideResult = {
  masked: string;
  map: MaskMap;
  /**
   * 안전망: 치환 후에도 남아 있는 실명·가림 표기.
   * 비어 있지 않으면 AI로 보내면 안 된다.
   */
  leaks: string[];
};

/* ---------- 받침 판별 ---------- */

const HANGUL_FIRST = 0xac00;
const HANGUL_LAST = 0xd7a3;

/** 숫자를 읽었을 때의 받침. "아동1"은 "아동일"이므로 ㄹ 받침으로 본다. */
const DIGIT_FINAL: Record<string, { has: boolean; isRieul: boolean }> = {
  "0": { has: true, isRieul: false }, // 영 / 십 / 백
  "1": { has: true, isRieul: true }, // 일
  "2": { has: false, isRieul: false }, // 이
  "3": { has: true, isRieul: false }, // 삼
  "4": { has: false, isRieul: false }, // 사
  "5": { has: false, isRieul: false }, // 오
  "6": { has: true, isRieul: false }, // 육
  "7": { has: true, isRieul: true }, // 칠
  "8": { has: true, isRieul: true }, // 팔
  "9": { has: false, isRieul: false }, // 구
};

/**
 * 마지막 글자에 받침이 있는지, 그 받침이 ㄹ인지 본다.
 *
 * 토큰은 괄호로 끝나므로(【아동1】) 소리 나는 마지막 글자까지 거슬러 올라간다.
 * 괄호를 그대로 보면 늘 받침이 있는 쪽으로 읽혀 "【아동2】이" 같은 말이 된다.
 */
function finalConsonant(word: string): { has: boolean; isRieul: boolean } {
  const chars = [...word.trimEnd()];
  let last = "";
  for (let i = chars.length - 1; i >= 0; i--) {
    const code = chars[i].codePointAt(0) ?? 0;
    const isHangul = code >= HANGUL_FIRST && code <= HANGUL_LAST;
    if (isHangul || chars[i] in DIGIT_FINAL) {
      last = chars[i];
      break;
    }
  }
  if (!last) return { has: true, isRieul: false };

  const code = last.codePointAt(0) ?? 0;
  if (code >= HANGUL_FIRST && code <= HANGUL_LAST) {
    // 한글 음절은 (초성, 중성, 종성)이 규칙적으로 합쳐진 코드다.
    // 종성 자리가 0이면 받침이 없고, 8이면 ㄹ이다.
    const jongseong = (code - HANGUL_FIRST) % 28;
    return { has: jongseong !== 0, isRieul: jongseong === 8 };
  }
  return DIGIT_FINAL[last];
}

/* ---------- 조사 ---------- */

type JosaPair = {
  /** 앞말에 받침이 있을 때의 모양 */
  withFinal: string;
  /** 받침이 없을 때의 모양 */
  withoutFinal: string;
  /** ㄹ 받침은 받침 없는 쪽 모양을 쓴다 (서울로, 아동1로) */
  rieulTakesVowelForm?: boolean;
};

/** 앞말에 따라 모양이 바뀌는 조사 */
const JOSA_PAIRS: JosaPair[] = [
  { withFinal: "이라도", withoutFinal: "라도" },
  { withFinal: "이랑", withoutFinal: "랑" },
  { withFinal: "이라", withoutFinal: "라" },
  { withFinal: "이며", withoutFinal: "며" },
  { withFinal: "이나", withoutFinal: "나" },
  { withFinal: "으로", withoutFinal: "로", rieulTakesVowelForm: true },
  { withFinal: "이", withoutFinal: "가" },
  { withFinal: "은", withoutFinal: "는" },
  { withFinal: "을", withoutFinal: "를" },
  { withFinal: "과", withoutFinal: "와" },
  { withFinal: "아", withoutFinal: "야" },
];

/** 모양이 바뀌지 않는 조사 */
const JOSA_PLAIN = [
  "에게서",
  "한테서",
  "께서",
  "에게",
  "한테",
  "에서",
  "께",
  "까지",
  "부터",
  "보다",
  "처럼",
  "같이",
  "마저",
  "조차",
  "밖에",
  "하고",
  "의",
  "도",
  "만",
  "에",
  // 이름 뒤에 붙는 부름말·집 — 조사는 아니지만 이름을 떼어 내는 자리는 같다(1차 전수 점검 2026-09-17)
  //   도윤씨 / 도윤님 / 도윤쌤 / 도윤샘 / 도윤군 / 도윤양 / 도윤네(도윤이네)
  "선생님",
  "씨",
  "님",
  "쌤",
  "샘",
  "군",
  "양",
  "네",
];

/**
 * 조사 뒤에 조사가 또 붙는 꼴. "도윤한테도" "서준이하고는" "하늘이네랑"
 * 몇 번까지 이어 볼지. 셋이면 현장 표기는 다 덮고, 낱말 속을 파고들 일은 없다.
 */
const JOSA_CHAIN_MAX = 3;

type JosaCandidate = { text: string; pair: JosaPair | null };

/** 긴 조사부터 살펴야 "이랑"을 "이"로 잘못 끊지 않는다. */
const JOSA_CANDIDATES: JosaCandidate[] = [
  ...JOSA_PAIRS.flatMap((pair) => [
    { text: pair.withFinal, pair },
    { text: pair.withoutFinal, pair },
  ]),
  ...JOSA_PLAIN.map((text) => ({ text, pair: null })),
].sort((a, b) => b.text.length - a.text.length);

/**
 * 이름 사이에 들어갈 수 있는 공백. 등록은 "응우옌 티 마이" 인데 일지에는 "응우옌티마이" 로 적는 일이
 * (그 반대도) 흔하다. 줄바꿈은 넣지 않는다 — 그건 다른 문장이다.
 */
const NAME_SPACE = /[  	]/;

/**
 * text 의 index 자리에서 word 가 시작하는가. 글자 사이의 공백은 건너뛴다(맨 앞 공백은 건너뛰지 않는다).
 * 맞으면 끝난 자리(다음 인덱스), 아니면 -1.
 *
 * 공백을 건너뛴 경우에는 **앞이 끊긴 자리**에서만 인정한다.
 * 안 그러면 앞 낱말의 끝소리가 이름 첫 글자와 같을 때 그것까지 먹는다
 * ("장면에서 지안이" 의 "서 지안" 을 "서지안" 으로 본 사고 — 2026-09-18).
 */
function spanAt(text: string, index: number, word: string): number {
  let i = index;
  let first = true;
  for (const ch of word) {
    if (!first) {
      while (i < text.length && NAME_SPACE.test(text[i])) i += 1;
    }
    if (text[i] !== ch) return -1;
    i += 1;
    first = false;
  }
  // 공백을 건너뛰었는가 — 건너뛰었다면 앞이 끊긴 자리여야 한다
  if (i - index > word.length && !isBoundary(text[index - 1])) return -1;
  return i;
}

/** 글자가 이어지지 않고 끊기는 자리인지 (공백·문장부호·끝) */
function isBoundary(ch: string | undefined): boolean {
  if (ch === undefined) return true;
  return !/[0-9A-Za-z가-힣]/.test(ch);
}

/**
 * text의 index 자리에서 시작하는 조사를 찾는다.
 *
 * 조사 뒤가 또 글자로 이어지면 조사로 보지 않는다.
 * "테스원은행에 갔다"의 "은"은 조사가 아니라 은행의 첫 글자다.
 */
function matchJosa(text: string, index: number, depth = 1): JosaCandidate | null {
  for (const candidate of JOSA_CANDIDATES) {
    if (!text.startsWith(candidate.text, index)) continue;
    const next = index + candidate.text.length;
    // 뒤가 끊기거나, 조사가 또 이어지면(한테+도) 조사다
    if (!isBoundary(text[next]) && !(depth < JOSA_CHAIN_MAX && matchJosa(text, next, depth + 1))) {
      continue;
    }
    return candidate;
  }
  return null;
}

/** 조사를 새 앞말에 맞는 모양으로 바꾼다. */
function inflect(candidate: JosaCandidate, word: string): string {
  if (!candidate.pair) return candidate.text;

  const { has, isRieul } = finalConsonant(word);
  if (candidate.pair.rieulTakesVowelForm && isRieul) return candidate.pair.withoutFinal;
  return has ? candidate.pair.withFinal : candidate.pair.withoutFinal;
}

/* ---------- 표기 변형 ---------- */

/**
 * 이름 가운데를 가릴 때 현장에서 쓰는 글자들.
 * 새 표기가 보이면 여기에만 더하면 된다.
 */
export const MASK_CHARS = ["*", "0", "O", "o", "○", "●", "x", "X"] as const;

/**
 * 두 글자 성.
 * 성을 늘 한 글자로 보면 "남궁길동"의 이름을 "궁길동"으로 떼어 내 엉뚱한 표기가 된다.
 */
const COMPOUND_SURNAMES = [
  "남궁",
  "황보",
  "제갈",
  "사공",
  "선우",
  "서문",
  "독고",
  "동방",
  "어금",
  "강전",
];

/** 그 이름에서 성이 몇 글자인지. 성을 떼면 이름이 한 글자도 안 남는 경우는 뺀다. */
function surnameLength(name: string): number {
  if (name.length >= 3 && COMPOUND_SURNAMES.includes(name.slice(0, 2))) return 2;
  return 1;
}

/**
 * 가운데 글자를 가린 표기들.
 *
 * 어느 자리가 "가운데"인지는 글자 수에 따라 다르다. 세 글자면 한 자리,
 * 네 글자면 두 자리다. 그래서 첫 글자와 끝 글자를 뺀 모든 자리를 하나씩 가려 본다.
 * 두 글자 이름은 가릴 가운데가 없어 아무것도 만들지 않는다 — 깨지지 않고 그냥 없다.
 */
function maskedForms(word: string): string[] {
  const out: string[] = [];
  const chars = [...word];
  for (let i = 1; i < chars.length - 1; i++) {
    for (const mask of MASK_CHARS) {
      out.push([...chars.slice(0, i), mask, ...chars.slice(i + 1)].join(""));
    }
  }
  return out;
}

type Notation = {
  text: string;
  /**
   * 앞뒤가 끊긴 자리에서만 잡는다.
   * 성을 뗀 짧은 표기("지안")는 다른 이름이나 낱말 속에 그대로 들어 있을 수 있다.
   * "이준수"에서 "이준"을 떼 가는 일을 막으려면 뒤가 끊기는지도 봐야 한다.
   */
  strict: boolean;
};

/**
 * 이름 뒤에 붙는 "이".
 *
 * 조사가 아니라 이름에 붙어 부르기 좋게 만드는 소리다. 받침으로 끝나는 이름에만 붙는다.
 *   서준이가 / 서준이는 / 서준이를 / 서준이도 / 서준이랑 / 서준이와 / 서준이한테 / 서준이에게
 *   서아가   / 서아는   (받침이 없으면 붙지 않는다)
 *
 * 이 "이"만 떼어 내면 나머지는 이미 있는 조사 목록(JOSA_PAIRS·JOSA_PLAIN)이 받는다.
 * 그래서 "이가" "이는" 같은 짝을 따로 늘어놓지 않는다 —
 * 조사를 하나 더 넣고 싶으면 그 두 목록에만 넣으면 "이-" 붙은 꼴까지 함께 늘어난다.
 *
 * 뒤에 조사나 괄호 학년이 와야 이름의 "이"로 본다.
 *
 * 뒤가 끊기면("도현이 - ", "테스원이 왔다") 이름의 "이"인지 주격조사 "이"인지
 * 글자만으로는 가릴 수 없다. 그때는 먹지 않고 조사로 넘긴다 —
 * 어차피 조사로 읽어도 표기는 잡히고, 잘못 먹으면 "【아동1】 왔다"가 되어 말이 깨진다.
 * "조민준이해했다"의 "이"도 뒤가 글자로 이어지므로 여기서 걸러진다.
 */
const NAME_SUFFIX = "이";

/**
 * word 뒤에 붙은 이름의 "이"를 몇 글자 먹을지. 없으면 0.
 * tail 은 word 가 끝나는 자리다.
 */
function nameSuffixLength(word: string, text: string, tail: number): number {
  if (text[tail] !== NAME_SUFFIX) return 0;
  if (!finalConsonant(word).has) return 0;

  const next = tail + NAME_SUFFIX.length;
  if (matchJosa(text, next)) return NAME_SUFFIX.length;
  if (readGradeParen(text, next)) return NAME_SUFFIX.length;
  return 0;
}

/** 이름 하나에서 나올 수 있는 표기를 모두 만든다. */
export function notationsOf(name: string): Notation[] {
  const trimmed = name?.trim() ?? "";
  if (!trimmed) return [];

  const out: Notation[] = [{ text: trimmed, strict: false }];
  for (const masked of maskedForms(trimmed)) out.push({ text: masked, strict: false });

  // 성을 뗀 표기. 한 글자만 남으면 만들지 않는다 — 아무 데나 걸린다.
  const given = trimmed.slice(surnameLength(trimmed));
  if ([...given].length >= 2) {
    out.push({ text: given, strict: true });
    for (const masked of maskedForms(given)) out.push({ text: masked, strict: true });

    // 부르는 이름 — 이름이 길면 뒤쪽 두·세 글자로 부른다("응우옌티마이" → 마이·티마이, "김이나라" → 나라).
    // 성 길이를 한 글자(복성은 두 글자)로 보는 규칙은 세 글자 한국 이름에 맞춰져 있어서,
    // 그보다 긴 이름·외국계 이름에서는 성을 떼도 부르는 이름이 안 나온다(2026-09-18 점검).
    // 세 글자 이름은 성 뗀 표기가 이미 그 두 글자라 여기서 늘어나는 것이 없다.
    const chars = [...given];
    for (const size of [3, 2]) {
      if (chars.length > size) out.push({ text: chars.slice(-size).join(""), strict: true });
    }

    // 이름 자리를 통째로 가린 표기("김00", "김**").
    // 성이 남아 있어 아무 데서나 온 가림 표기보다 후보가 훨씬 좁다.
    // 뒤가 끊기는지 보는 이유: "김000원" 같은 글에서 앞 두 자만 떼 가지 않게.
    const head = trimmed.slice(0, surnameLength(trimmed));
    for (const mask of MASK_CHARS) {
      out.push({ text: head + mask.repeat([...given].length), strict: true });
    }
  }

  // 띄어 등록한 이름("응우옌 티 마이")은 붙여 쓴 표기도 같은 이름이다.
  // 반대(붙여 등록 · 띄어 쓴 글)는 표기를 늘리지 않고 맞출 때 공백을 건너뛴다(spanAt).
  for (const one of [...out]) {
    const tight = one.text.replace(/[  	]+/g, "");
    if (tight !== one.text && tight.length > 0) out.push({ text: tight, strict: one.strict });
  }

  // 같은 표기가 두 번 들어가면 넓게 보는 쪽(strict=false)을 남긴다
  const best = new Map<string, Notation>();
  for (const one of out) {
    const found = best.get(one.text);
    if (!found || (found.strict && !one.strict)) best.set(one.text, one);
  }
  return [...best.values()];
}

/* ---------- 괄호 학년 ---------- */

/** 학교급이 시작하는 학년 숫자. 초1=1, 중1=7, 고1=10. */
const LEVEL_BASE: Record<string, { base: number; max: number }> = {
  "초": { base: 0, max: 6 },
  "중": { base: 6, max: 3 },
  "고": { base: 9, max: 3 },
};

/** 괄호 안에서 읽어 낼 수 있는 길이. "(초등학교 3학년)" 정도까지만 본다. */
const PAREN_MAX = 12;

/**
 * 표기 뒤에 붙은 괄호 학년을 읽는다. "(초4)" "(중1)" "(3학년)" "(초등 4학년)"
 *
 * 읽어 낸 값은 "이 학년일 수 있다"는 후보 집합이다.
 * "3학년"처럼 학교급이 없으면 초3·중3·고3 중 무엇인지 알 수 없으므로 셋 다 넣는다.
 * 좁히는 데만 쓰므로 넓게 잡아도 위험하지 않다 — 못 좁히면 사람에게 묻는다.
 *
 * 괄호는 글에 그대로 둔다. 지우면 사람이 읽을 때 맥락이 사라지고,
 * 학년만으로는 누구인지 알 수 없어 가릴 이유도 없다.
 */
function readGradeParen(text: string, index: number): Set<number> | null {
  if (text[index] !== "(" && text[index] !== "（") return null;

  const close = text.slice(index, index + PAREN_MAX + 2).search(/[)）]/);
  if (close < 1) return null;

  const inside = text.slice(index + 1, index + close).replace(/\s+/g, "");
  const grades = new Set<number>();

  // "초4" "중1" "고2" "초등4"
  const leveled = /^(초|중|고)(?:등|등학교|학교)?(\d{1,2})(?:학년)?$/.exec(inside);
  if (leveled) {
    const level = LEVEL_BASE[leveled[1]];
    const n = Number(leveled[2]);
    if (n >= 1 && n <= level.max) grades.add(level.base + n);
    return grades.size > 0 ? grades : null;
  }

  // "3학년" — 학교급이 없다. 초·중·고 어느 쪽인지 모르므로 다 담는다.
  const plain = /^(\d{1,2})학년$/.exec(inside);
  if (plain) {
    const n = Number(plain[1]);
    for (const level of Object.values(LEVEL_BASE)) {
      if (n >= 1 && n <= level.max) grades.add(level.base + n);
    }
    return grades.size > 0 ? grades : null;
  }

  return null;
}

/* ---------- 이름 등록부 ---------- */

/** 토큰 앞머리. 아동은 "아동", 직원은 역할 이름. */
function labelOf(person: RegisteredPerson): string {
  if (person.kind === "child") return "아동";
  return person.role ?? "직원";
}

function tokenText(label: string, index: number): string {
  return `【${label}${index}】`;
}

type Context = {
  people: Map<string, RegisteredPerson>;
  /** 표기 → 그 표기를 쓸 수 있는 사람 id들. 긴 표기부터 보도록 정렬해 둔다. */
  notations: Array<Notation & { ids: string[] }>;
  /** 사람 id → 그 사람만 가리키는 토큰 */
  tokenByPerson: Map<string, string>;
  /** 여러 명이 걸린 표기에 준 토큰. 열쇠는 정렬한 id 목록. */
  tokenByGroup: Map<string, string>;
  /** 지금 다니는 아동 id. 이름이 통째로 가려진 표기의 후보가 된다. */
  enrolledChildren: string[];
  counters: Map<string, number>;
  map: MaskMap;
};

/**
 * 명단에서 표기 사전과 토큰을 만든다.
 *
 * 토큰은 넘겨받은 순서대로 붙는다(아동1, 아동2 …).
 * 글에 나오는 순서가 아니라 명단 순서라, 같은 명단을 쓰는 한
 * 여러 글에서 같은 사람이 늘 같은 토큰을 받는다.
 *
 * 여러 명이 걸리는 표기의 토큰은 글을 훑다가 만나면 그때 붙인다.
 * 어느 무리가 실제로 나올지는 글을 봐야 알 수 있기 때문이다.
 */
function buildContext(people: RegisteredPerson[]): Context {
  const map: MaskMap = { byCode: {}, byName: {}, entries: [] };
  const ctx: Context = {
    people: new Map(),
    notations: [],
    tokenByPerson: new Map(),
    tokenByGroup: new Map(),
    enrolledChildren: [],
    counters: new Map(),
    map,
  };

  const byNotation = new Map<string, { strict: boolean; ids: string[] }>();
  /** 같은 이름을 쓰는 사람이 둘 이상이면 byName 에서 뺀다 */
  const nameCount = new Map<string, number>();

  for (const person of people) {
    const name = person.name?.trim();
    if (!name || ctx.people.has(person.id)) continue;

    ctx.people.set(person.id, { ...person, name });
    nameCount.set(name, (nameCount.get(name) ?? 0) + 1);
    if (person.kind === "child" && person.enrolled !== false) ctx.enrolledChildren.push(person.id);

    const label = labelOf(person);
    const next = (ctx.counters.get(label) ?? 0) + 1;
    ctx.counters.set(label, next);

    const code = tokenText(label, next);
    ctx.tokenByPerson.set(person.id, code);

    const entry: MaskEntry = {
      code,
      name,
      kind: person.kind,
      role: person.role,
      people: [person.id],
      ambiguous: false,
    };
    map.byCode[code] = entry;
    map.entries.push(entry);
    map.byName[name] = code;

    for (const notation of notationsOf(name)) {
      const found = byNotation.get(notation.text);
      if (found) {
        if (!found.ids.includes(person.id)) found.ids.push(person.id);
        // 한 표기라도 넓게 잡히는 쪽이 있으면 넓게 본다
        found.strict = found.strict && notation.strict;
      } else {
        byNotation.set(notation.text, { strict: notation.strict, ids: [person.id] });
      }
    }
  }

  // 같은 이름이 둘 이상이면 이름만으로는 토큰을 고를 수 없다
  for (const [name, count] of nameCount) {
    if (count > 1) delete map.byName[name];
  }

  ctx.notations = [...byNotation.entries()]
    .map(([text, value]) => ({ text, strict: value.strict, ids: value.ids }))
    .sort((a, b) => b.text.length - a.text.length);

  return ctx;
}

/**
 * 그 무리에 새 토큰을 붙인다. 사람별 토큰과 같은 번호 흐름을 쓴다.
 *
 * anon 은 이름이 통째로 가려진 표기다. 후보가 한 명으로 좁혀져도 확정하지 않는다.
 * 그 한 명이라는 근거가 표기 안에 없기 때문이다 — 명단이 그렇게 생겼을 뿐이다.
 */
function groupToken(ctx: Context, ids: string[], notation: string, anon = false): string {
  const key = anon ? `anon:${notation}:${[...ids].sort().join(",")}` : [...ids].sort().join(",");
  const existing = ctx.tokenByGroup.get(key);
  if (existing) return existing;

  const first = ctx.people.get(ids[0])!;
  const label = labelOf(first);
  const next = (ctx.counters.get(label) ?? 0) + 1;
  ctx.counters.set(label, next);

  const code = tokenText(label, next);
  const entry: MaskEntry = {
    code,
    // 누구인지 모르므로 실명을 고를 수 없다. 글에 적혀 있던 표기를 그대로 돌려준다.
    name: notation,
    kind: first.kind,
    role: first.role,
    people: [...ids],
    ambiguous: true,
  };

  ctx.map.byCode[code] = entry;
  ctx.map.entries.push(entry);
  ctx.tokenByGroup.set(key, code);
  return code;
}

/* ---------- 표기 찾기 ---------- */

type Hit = { length: number; code: string };

/** 괄호 학년이 있으면 그 학년인 사람만 남긴다. 아무도 안 남으면 좁히지 않는다. */
function narrowByGrade(ctx: Context, ids: string[], grades: Set<number> | null): string[] {
  if (!grades) return ids;

  const narrowed = ids.filter((id) => {
    const grade = ctx.people.get(id)?.grade;
    return typeof grade === "number" && grades.has(grade);
  });
  // 아무도 안 남으면 괄호가 우리가 모르는 값이라는 뜻이다.
  // 그때는 좁히지 않는다. 잘못 좁혀 엉뚱한 한 명으로 확정하는 것보다 낫다.
  return narrowed.length > 0 ? narrowed : ids;
}

/**
 * index 자리에서 시작하는 사람 표기를 찾는다.
 *
 * 긴 표기부터 본다. "김하준"과 "하준"이 함께 있으면 짧은 쪽이 먼저 걸려
 * "김" + 토큰으로 잘려 나가기 때문이다. "이서준이가"에서 "이서준"이 "서준"보다
 * 먼저 잡히는 것도 같은 이유다 — 긴 이름을 먼저 맞추고 남는 것을 조사로 본다.
 *
 * 표기 뒤에는 이름의 "이"(서준이가)와 괄호 학년이 붙을 수 있다.
 * "이"는 먹어서 없애고, 괄호는 글에 그대로 두되 후보를 좁히는 데 쓴다.
 */
function matchAt(ctx: Context, text: string, index: number): Hit | null {
  for (const notation of ctx.notations) {
    // 이름 사이 공백은 건너뛰고 맞춘다 — "응우옌 티 마이" 로 등록하고 "응우옌티마이" 로 적어도(그 반대도) 같은 사람
    const matched = spanAt(text, index, notation.text);
    if (matched < 0) continue;

    const tail = matched;
    const end = tail + nameSuffixLength(notation.text, text, tail);

    if (notation.strict) {
      // 앞뒤가 끊긴 자리에서만. 다른 이름이나 낱말 속을 파고들지 않게.
      if (!isBoundary(text[index - 1])) continue;
      if (!isBoundary(text[end]) && !matchJosa(text, end)) continue;
    }

    let ids = notation.ids;
    if (ids.length > 1) ids = narrowByGrade(ctx, ids, readGradeParen(text, end));

    const code = ids.length === 1
      ? ctx.tokenByPerson.get(ids[0])!
      : groupToken(ctx, ids, notation.text);

    return { length: end - index, code };
  }

  return matchAnonRun(ctx, text, index);
}

/** 이름 자리가 통째로 가려진 표기로 보려면 가림문자가 몇 자 이어져야 하는지. */
const ANON_MIN = 2;

/**
 * 이름이 통째로 가려진 표기. "00이가", "**(초3)", "○○는"
 *
 * 명단에서 만든 표기가 아니다. 글자만으로는 성도 이름도 알 수 없으므로
 * 누구인지 절대 가릴 수 없다 — 늘 "확인 필요"로 남기고 사람에게 묻는다.
 * 후보는 지금 다니는 아동 전부, 괄호 학년이 있으면 그 학년만.
 *
 * 뒤에 조사나 이름의 "이", 괄호 학년이 붙어야 사람으로 본다.
 * 덜렁 "00" 만 있는 것은 잡지 않는다 — 전화번호·수량·날짜가 훨씬 많다.
 * 앞도 끊겨 있어야 한다. "100이 넘는"의 "00"을 사람으로 보면 안 되기 때문이다.
 *
 * 같은 글자가 이어진 것만 본다("00" "**"). 현장에서 섞어 쓰지 않고,
 * 섞어 잡으면 오탐만 늘어난다.
 */
function matchAnonRun(ctx: Context, text: string, index: number): Hit | null {
  const mask = text[index];
  if (!(MASK_CHARS as readonly string[]).includes(mask)) return null;
  if (!isBoundary(text[index - 1])) return null;

  let run = 1;
  while (text[index + run] === mask) run += 1;
  if (run < ANON_MIN) return null;

  const tail = index + run;
  const suffix = nameSuffixLength(mask.repeat(run), text, tail);
  const end = tail + suffix;

  const grades = readGradeParen(text, end);
  if (!suffix && !grades && !matchJosa(text, end)) return null;

  const ids = narrowByGrade(ctx, ctx.enrolledChildren, grades);
  if (ids.length === 0) return null;

  // 후보가 하나로 좁혀져도 확정하지 않는다. 표기 자체에 그 아이라는 근거가 없다.
  return { length: end - index, code: groupToken(ctx, ids, text.slice(index, tail), true) };
}

/* ---------- 치환 공통 ---------- */

/**
 * 찾을 말들을 긴 것부터 훑어 바꾼다. show() 가 쓴다.
 *
 * 토큰을 정규식으로 만들지 않고 startsWith로 훑는다.
 * 토큰 안에 정규식 특수문자가 들어가도 사고가 나지 않게 하기 위해서다.
 */
function replaceAll(
  text: string,
  targets: string[],
  replacementOf: (matched: string) => string,
): string {
  const sorted = [...targets].sort((a, b) => b.length - a.length);
  if (sorted.length === 0) return text;

  let out = "";
  let i = 0;

  while (i < text.length) {
    const matched = sorted.find((target) => text.startsWith(target, i));

    if (!matched) {
      out += text[i];
      i += 1;
      continue;
    }

    const replacement = replacementOf(matched);
    out += replacement;
    i += matched.length;

    // 바로 뒤의 조사를 새 앞말에 맞춰 다시 쓴다
    const josa = matchJosa(text, i);
    if (josa) {
      out += inflect(josa, replacement);
      i += josa.text.length;
    }
  }

  return out;
}

/* ---------- hide / show ---------- */

/**
 * 텍스트에서 등록된 사람의 표기를 토큰으로 바꾼다.
 *
 * 같은 사람은 어떤 표기로 적혀 있든(홍길동·홍*동·길동) 같은 토큰이 된다.
 * 글에 한 번도 안 나온 사람의 토큰도 map에는 들어 있다.
 * (같은 명단이면 토큰이 늘 같도록 명단 순서로 붙이기 때문)
 */
export function hide(text: string, people: RegisteredPerson[]): HideResult {
  const ctx = buildContext(people);

  let masked = "";
  let i = 0;

  while (i < text.length) {
    const hit = matchAt(ctx, text, i);
    if (!hit) {
      masked += text[i];
      i += 1;
      continue;
    }

    masked += hit.code;
    i += hit.length;

    const josa = matchJosa(text, i);
    if (josa) {
      masked += inflect(josa, hit.code);
      i += josa.text.length;
    }
  }

  return { masked, map: ctx.map, leaks: findLeaks(masked, people) };
}

/**
 * 토큰을 사람 이름으로 되돌린다. 조사도 이름에 맞춰 다시 쓴다.
 *
 * 한 사람으로 가려진 토큰은 실명으로 돌아온다.
 * 그래서 "김*준이 왔다"는 "김하준이 왔다"로 돌아온다 — 표기가 아니라 사람으로 돌아온다.
 * 누구인지 못 가린 토큰은 글에 적혀 있던 표기 그대로 돌아온다. 없는 이름을 지어내지 않는다.
 */
export function show(text: string, map: MaskMap): string {
  return replaceAll(text, Object.keys(map.byCode), (code) => map.byCode[code].name);
}

/* ---------- 안전망 ---------- */

/**
 * 텍스트에 실명이나 가림 표기가 남아 있는지 본다. 남아 있으면 그 표기들을 돌려준다.
 *
 * hide() 결과에 하나라도 남으면 AI로 보내면 안 된다.
 *
 * 성이 남는 표기(홍길동·홍*동)는 글 어디에 있든 본다.
 * 성을 뗀 짧은 표기("지안")는 낱말로 떨어져 있을 때만 본다(strictLeak) —
 * 두 글자짜리는 다른 낱말 속에 얼마든지 들어 있어서, 아무 데서나 잡으면
 * 멀쩡한 일지가 통째로 분석되지 않는다.
 */
export function findLeaks(text: string, people: RegisteredPerson[]): string[] {
  const found = new Set<string>();

  for (const person of people) {
    const name = person?.name?.trim();
    if (!name) continue;
    for (const notation of notationsOf(name)) {
      if (notation.strict) {
        if (strictLeak(text, notation.text)) found.add(notation.text);
        continue;
      }
      if (looseLeak(text, notation.text)) found.add(notation.text);
    }
  }
  return [...found];
}

/**
 * 성을 뗀 표기(도윤·도*)가 조사·부름말과 붙어 남았는가 — hide() 와 다른 길로 본다.
 *
 * hide() 의 조사 목록(JOSA_CANDIDATES)에 빠진 말이 있으면 hide 도 못 가리고, 같은 목록을 쓰는
 * 안전망도 못 잡는다(1차 전수 점검에서 "도윤하고" 가 그렇게 샜다). 그래서 여기는 목록을 따로 둔다.
 *
 * 멀쩡한 글을 막지 않게 좁게 본다: 앞이 끊기고, 뒤가 끊기거나 아래 말들로만 이어진 뒤 끊겨야 한다.
 * 두 글자 이름이 낱말 속에 든 것("서준비") 은 뒤가 목록에 없는 글자라 잡지 않는다.
 */
export const LEAK_TAILS = [
  "이라도",
  "이랑",
  "이라",
  "이며",
  "이나",
  "으로",
  "에게서",
  "한테서",
  "께서",
  "에게",
  "한테",
  "에서",
  "하고",
  "까지",
  "부터",
  "보다",
  "처럼",
  "같이",
  "마저",
  "조차",
  "밖에",
  "선생님",
  "라도",
  "랑",
  "라",
  "며",
  "나",
  "로",
  "이",
  "가",
  "은",
  "는",
  "을",
  "를",
  "과",
  "와",
  "아",
  "야",
  "께",
  "의",
  "도",
  "만",
  "에",
  "씨",
  "님",
  "쌤",
  "샘",
  "군",
  "양",
  "네",
].sort((a, b) => b.length - a.length);

/** 어디든 남아 있으면 샌 것 — 공백만 다른 표기도 같은 표기로 본다(spanAt). */
function looseLeak(text: string, word: string): boolean {
  for (let at = 0; at < text.length; at += 1) {
    if (spanAt(text, at, word) >= 0) return true;
  }
  return false;
}

function strictLeak(text: string, word: string): boolean {
  const wordChar = /[0-9A-Za-z가-힣]/;
  for (let at = 0; at < text.length; at += 1) {
    const end = spanAt(text, at, word);
    if (end < 0) continue;
    if (at > 0 && wordChar.test(text[at - 1])) continue;
    let i = end;
    for (let step = 0; step <= 4; step++) {
      if (i >= text.length || !wordChar.test(text[i])) return true;
      const tail = LEAK_TAILS.find((one) => text.startsWith(one, i));
      if (!tail) break;
      i += tail.length;
    }
  }
  return false;
}

/**
 * 오류 문구에 싣는 이름 표기. 첫 글자와 끝 글자만 남긴다(김*준, 남**호, 이*).
 *
 * 가명화 실패 문구는 서버 로그와 502 응답(화면) 양쪽으로 나간다.
 * 실명을 막으려던 자리가 실명을 흘리면 안 된다. 사람이 어떤 표기인지 짐작할 만큼만 둔다.
 */
export function maskForMessage(name: string): string {
  const chars = [...name];
  if (chars.length <= 1) return "*";
  if (chars.length === 2) return `${chars[0]}*`;
  return `${chars[0]}${"*".repeat(chars.length - 2)}${chars[chars.length - 1]}`;
}

/**
 * 실명이 남아 있으면 예외를 던지고, 없으면 가려진 텍스트를 돌려준다.
 * AI 호출 직전에 이걸 통과시켜 쓴다.
 *
 *   const safe = assertNoLeak(hide(text, people));
 *   await askAI(safe);
 *
 * 문구에는 남은 표기를 가린 채 싣는다(maskForMessage).
 */
export function assertNoLeak(result: { masked: string; leaks: string[] }): string {
  if (result.leaks.length > 0) {
    throw new Error(
      `가명화에 실패했습니다. 실명이 남아 있습니다: ${result.leaks.map(maskForMessage).join(", ")}`,
    );
  }
  return result.masked;
}
