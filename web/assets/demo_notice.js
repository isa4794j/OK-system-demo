/**
 * 데모 안내 한 문장 — 이 저장소(데모)만 가지고 있는 파일이다.
 *
 * 로그인 화면(web/login.html 의 #login-demo, 계정 안내가 붙은 DEMO_LOGIN_NOTICE), PC 일지 작성(ui.js 의 안내 상자),
 * 폰 일지 작성(m/journal.js 의 작성 시트)이 모두 이 글을 쓴다. 고칠 때 한 곳만 고친다.
 */
export const DEMO_NOTICE =
  "데모입니다. 실제 개인정보를 입력하지 마세요. 데이터는 매일 초기화됩니다.";

/** 로그인 화면 전용 — 위 문장에 체험 계정과 막힌 기능을 덧붙인다(막는 곳: api/demo_guard.ts) */
export const DEMO_LOGIN_NOTICE = DEMO_NOTICE +
  " 체험 계정: 데모센터장(센터장)·데모복지사(종사자)·데모봉사자(봉사자, 휴대폰 /m)." +
  " 계정·비밀번호·문구 변경은 데모에서 막혀 있습니다.";
