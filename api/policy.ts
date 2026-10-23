/**
 * 정책표 — 어느 경로에 어떤 등급이 필요한가
 *
 * [표에 없으면 관리자만]
 * 기본값이 "열림" 이면 새 API 를 만들고 여기 적는 것을 잊었을 때 뚫린 채로 조용히 산다.
 * 기본값이 "관리자만" 이면 잊은 순간 403 이 나서 눈에 띈다.
 * 틀려도 안전한 쪽으로 틀리게 해 둔다.
 *
 * [메서드마다 다르다]
 * 같은 경로라도 읽기와 쓰기가 다른 등급인 자리가 있다.
 * GET /api/staff 는 일지 작성자 드롭다운이 쓰므로 종사자도 필요하지만,
 * POST /api/staff(직원 등록)는 센터장 이상이다.
 *
 * [봉사자 세부 범위는 여기 없다]
 * "본인 것만" 은 행을 봐야 아는 규칙이라 관문이 못 한다(6단계, 모바일과 함께).
 * 지금 이 표는 등급까지만 정한다.
 */
import type { Level } from "../lib/permission.ts";

/** 로그인 없이도 되는 자리. 로그인 자체는 로그인 없이 할 수 있어야 한다. */
export const PUBLIC = "공개" as const;

/** 로그인만 하면 되는 자리. 등급을 가리지 않는다. */
export const ANY = "로그인" as const;

export type Need = typeof PUBLIC | typeof ANY | Level;

type Rule = {
  /** 경로. 정규식이면 통째로 맞아야 한다. */
  path: string | RegExp;
  /** 이 메서드들만. 안 주면 전부. */
  methods?: string[];
  need: Need;
  /**
   * PC 화면 전용인가. 모바일 계정(봉사자)은 아직 볼 화면이 없다.
   * 6단계에서 봉사자용 경로가 생기면 그 경로들만 false 로 둔다.
   */
  pcOnly?: boolean;
};

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/**
 * 위에서부터 처음 맞는 줄이 이긴다.
 * 좁은 규칙(메서드를 가리는 것)을 넓은 규칙보다 먼저 둔다.
 */
const RULES: Rule[] = [
  /* ---------- 공개 ---------- */
  { path: "/health", need: PUBLIC },
  { path: "/api/auth/state", need: PUBLIC },
  { path: "/api/auth/me", need: PUBLIC },
  { path: "/api/auth/login", need: PUBLIC },
  { path: "/api/auth/verify-code", need: PUBLIC },
  { path: "/api/auth/first-password", need: PUBLIC },
  { path: "/api/auth/bootstrap", need: PUBLIC },
  { path: "/api/auth/logout", need: PUBLIC },
  // 동의 — 상태 묻기는 공개(세션 없으면 "필요 없음"), 기록은 로그인한 누구나(폰 포함)
  { path: "/api/auth/consent", methods: ["GET"], need: PUBLIC },
  { path: "/api/auth/consent", methods: ["POST"], need: ANY, pcOnly: false },
  // 개인정보 처리방침 — 로그인 전에 읽을 수 있어야 한다
  { path: "/api/public/privacy", methods: ["GET"], need: PUBLIC },

  /* ---------- 관리자 ---------- */
  // 변경 기록에는 before/after 가 값째 들어 있다. 아동 신원도 그 안에 있다.
  { path: "/api/audit", need: "관리자" },
  // 경고 목록에는 누가 어디에 접근하려 했는지가 들어 있다.
  { path: "/api/guard-warnings", need: "관리자" },
  // 시스템 점검. 표에 없어도 기본값이 관리자지만, 기본값으로 떨어진 것과
  // 일부러 관리자로 둔 것을 점검 화면이 가를 수 있게 한 줄로 적어 둔다.
  { path: /^\/api\/system-check(\/|$)/, need: "관리자" },
  // 반기 관찰 항목은 평가지표다. 센터장도 아니고 최상위만 바꾼다.
  // 읽기(GET)는 아래 설정 규칙을 따라 종사자까지 열린다.
  { path: "/api/settings/half_observation_items", methods: ["PUT"], need: "관리자" },
  // 관찰 영역도 분류 기준이라 관리자만 바꾼다(읽기는 종사자까지 — 영역 고르는 칸이 쓴다).
  { path: "/api/settings/observation_areas", methods: ["PUT"], need: "관리자" },

  /* ---------- 봉사 이상 · 폰에서 열리는 유일한 묶음 ---------- */
  //
  // pcOnly: false 라야 모바일 계정이 들어온다.
  // "본인 것만" 은 행을 봐야 아는 규칙이라 여기서 못 한다 — api/my.ts 가 판단한다.
  { path: /^\/api\/my(\/|$)/, need: "봉사", pcOnly: false },

  // 문의 목록은 PC 쪽이다. 봉사자는 /api/my/inquiries 로 보내기만 하고 못 읽는다.
  { path: /^\/api\/inquiries(\/|$)/, need: "종사자" },

  /* ---------- 센터장 이상 ---------- */
  // 봉사자 설정(폰에 무엇이 보이나)은 읽기도 센터장 이상 — 그 화면(설정 › 봉사자 설정)이 센터장 몫이다.
  // 봉사자 폰은 이 주소가 아니라 서버 안(api/my.ts)에서 값을 읽는다.
  { path: "/api/settings/volunteer_journal_scope", methods: ["GET"], need: "센터장" },
  { path: "/api/settings/half_observation_open", methods: ["GET"], need: "센터장" },
  { path: "/api/settings/half_observation_items", methods: ["GET"], need: "센터장" },
  // 그 밖의 설정은 읽는 것과 바꾸는 것이 다르다. 지금 값(관찰 영역·동의서 문구)은 종사자도 봐야 하고,
  // 바꾸는 것은 센터의 판단이라 센터장 이상이다.
  { path: /^\/api\/settings(\/|$)/, methods: ["GET"], need: "종사자" },
  { path: /^\/api\/settings(\/|$)/, need: "센터장" },

  { path: "/api/accounts", methods: ["GET"], need: "센터장" },
  // 관리자 깃발(is_admin)만은 관리자다. 같은 PATCH 안의 필드 하나라 경로로는 못 가른다 —
  // api/accounts.ts 의 handleAccountUpdate 가 요청 본문을 보고 판단한다.
  { path: new RegExp(`^/api/accounts/(${UUID})(/code)?$`, "i"), need: "센터장" },
  // 명단 등록·수정·삭제. 읽기는 아래에서 종사자에게 열린다.
  { path: "/api/staff", methods: ["POST"], need: "센터장" },
  { path: new RegExp(`^/api/staff/(${UUID})$`, "i"), methods: ["PATCH", "DELETE"], need: "센터장" },

  /* ---------- 종사자 이상 (업무 전부) ---------- */
  // 근거 [확인함]. 아래 아동 규칙에 걸려도 같은 등급이지만, 쓰기라서 한 줄로 적어 둔다 —
  // 이 표를 읽는 사람이 "누가 확인을 누를 수 있나" 를 여기서 바로 본다.
  {
    path: new RegExp(`^/api/children/(${UUID})/evaluation/evidence-check$`, "i"),
    methods: ["POST"],
    need: "종사자",
  },

  { path: /^\/api\/staff(\/|$)/, need: "종사자" },
  { path: /^\/api\/children(\/|$)/, need: "종사자" },
  { path: /^\/api\/observations(\/|$)/, need: "종사자" },
  { path: /^\/api\/journals(\/|$)/, need: "종사자" },
  { path: /^\/api\/journal-observations(\/|$)/, need: "종사자" },
  { path: /^\/api\/schedules(\/|$)/, need: "종사자" },
  { path: /^\/api\/resources(\/|$)/, need: "종사자" },
  { path: /^\/api\/resource-records(\/|$)/, need: "종사자" },
  { path: /^\/api\/resource-inbox(\/|$)/, need: "종사자" },
  { path: /^\/api\/resource-stats(\/|$)/, need: "종사자" },
  { path: /^\/api\/resource-categories(\/|$)/, need: "종사자" },
  { path: /^\/api\/books(\/|$)/, need: "종사자" },
];

/**
 * 표의 줄들 — 판단용이 아니다. 판단은 requiredFor 로만 한다.
 * 시스템 점검이 "표에는 있는데 실제 경로가 없는 줄" 을 찾는 데 쓴다.
 */
export function policyRules(): ReadonlyArray<Readonly<Pick<Rule, "path" | "methods">>> {
  return RULES;
}

export type Decision = {
  need: Need;
  pcOnly: boolean;
  /** 표에 없어서 기본값으로 떨어진 자리인가. 경고 로그에 적어 둔다. */
  fallback: boolean;
};

/**
 * 이 요청에 필요한 등급. 표에 없으면 관리자만이다.
 *
 * pcOnly 는 종사자 이상이 필요한 자리에 기본으로 붙인다 —
 * 지금 있는 화면이 전부 PC 화면이기 때문이다.
 * 6단계에서 봉사자용 경로가 생기면 그 줄에 pcOnly: false 를 적는다.
 */
export function requiredFor(pathname: string, method: string): Decision {
  for (const rule of RULES) {
    const pathHit = typeof rule.path === "string"
      ? rule.path === pathname
      : rule.path.test(pathname);
    if (!pathHit) continue;
    if (rule.methods && !rule.methods.includes(method)) continue;

    const need = rule.need;
    const pcOnly = rule.pcOnly ??
      (need !== PUBLIC && need !== ANY && need !== "봉사");
    return { need, pcOnly, fallback: false };
  }

  return { need: "관리자", pcOnly: true, fallback: true };
}
