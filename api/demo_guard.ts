/**
 * 데모 전용 안전장치 — 이 저장소(데모)에만 있는 파일이다.
 *
 * 공개 데모는 누구나 같은 계정으로 들어온다. 한 방문자가 비밀번호를 바꾸거나 계정을 정지하면
 * 다른 방문자가 로그인하지 못하고, 문구를 고치면 모두의 화면이 바뀐다. 그래서 그런 쓰기만
 * **서버에서** 막는다(화면 버튼은 그대로 두어 기능 위치는 알 수 있게 — 누르면 아래 안내가 뜬다).
 *
 * 막는 목록은 이 파일 DEMO_BLOCKED 한 곳에 모은다. 데모 저장소 전용이라 환경변수 없이 고정한다.
 * 막지 않는 것: 일지·관찰·평가·자원·도서 등 일반 업무, 아동 삭제(새벽 초기화로 복구),
 * 운영 설정(child_delete_by_staff·봉사일지 공유 범위 등), 변경 기록·로그인 기록 보기.
 *
 * 장센터(관리자)는 공개하지 않는 계정이라 막지 않는다 — 데모를 손볼 사람이 쓴다.
 */
import { CENTER_NAME_KEY, CONSENT_FORM_KEY, PRIVACY_POLICY_KEY } from "../lib/documents.ts";

/** 공개 데모 계정 셋 — 이 이름으로 로그인한 요청에 아래 목록을 적용한다 */
export const DEMO_ACCOUNTS: readonly string[] = ["데모센터장", "데모복지사", "데모봉사자"];

export const DEMO_BLOCK_MESSAGE = "데모에서는 이 기능이 막혀 있습니다(매일 새벽 3시 초기화)";

type Block = {
  /** 무엇을 막는가 — 사람이 읽는 이름 */
  what: string;
  methods: readonly string[];
  path: RegExp;
  /** true 면 로그인하지 않은 요청에도 적용한다(공개 경로) */
  everyone?: boolean;
};

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export const DEMO_BLOCKED: readonly Block[] = [
  // 계정 관리 쓰기 — 직급·역할·정지·관리자 깃발은 PATCH /api/accounts/:id 안의 필드다
  {
    what: "계정 수정(로그인 이름·접속 권한·정지·해제·관리자 깃발)",
    methods: ["PATCH"],
    path: new RegExp(`^/api/accounts/${UUID}$`, "i"),
  },
  {
    what: "초대코드 발급·재발급·회수",
    methods: ["POST", "DELETE"],
    path: new RegExp(`^/api/accounts/${UUID}/code$`, "i"),
  },
  // 직원·봉사자 등록·수정·삭제 (직급·역할 변경 포함)
  { what: "직원·봉사자 등록", methods: ["POST"], path: /^\/api\/staff$/ },
  {
    what: "직원·봉사자 수정·삭제",
    methods: ["PATCH", "DELETE"],
    path: new RegExp(`^/api/staff/${UUID}$`, "i"),
  },
  // 비밀번호 — 첫 비밀번호 정하기(초대코드)와 첫 관리자 만들기. 로그인한 사람이 바꾸는 길은 없다
  {
    what: "비밀번호 정하기",
    methods: ["POST"],
    path: /^\/api\/auth\/first-password$/,
    everyone: true,
  },
  {
    what: "첫 관리자 만들기",
    methods: ["POST"],
    path: /^\/api\/auth\/bootstrap$/,
    everyone: true,
  },
  // 문구 저장 — 동의서·처리방침(직원 안내 문구 포함)·센터 이름. [기본 문구로] 저장도 같은 PUT 이다
  {
    what: "동의서·처리방침·센터 이름·직원 안내 문구 저장",
    methods: ["PUT"],
    path: new RegExp(
      `^/api/settings/(${CONSENT_FORM_KEY}|${PRIVACY_POLICY_KEY}|${CENTER_NAME_KEY})$`,
    ),
  },
];

/** 이 요청을 데모가 막는가 */
export function isDemoBlocked(method: string, pathname: string, loginName: string | null): boolean {
  const demo = loginName !== null && DEMO_ACCOUNTS.includes(loginName);
  return DEMO_BLOCKED.some((one) =>
    one.methods.includes(method) && one.path.test(pathname) && (demo || one.everyone === true)
  );
}

/** 막아야 하면 403 응답, 아니면 null */
export function demoRefusal(
  req: Request,
  pathname: string,
  loginName: string | null,
): Response | null {
  if (!isDemoBlocked(req.method, pathname, loginName)) return null;
  return Response.json({ error: DEMO_BLOCK_MESSAGE }, {
    status: 403,
    headers: { "cache-control": "no-store" },
  });
}
