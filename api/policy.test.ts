/**
 * 정책표 테스트
 *
 *   deno task test
 *
 * 이 표가 틀리면 뚫리거나 잠긴다. 특히 "표에 없으면 관리자만" 이 지켜지는지가 중요하다 —
 * 새 API 를 만들고 표에 적는 것을 잊었을 때 열려 있으면 안 된다.
 */
import { assertEquals } from "@std/assert";
import { requiredFor } from "./policy.ts";

const UUID = "0c80928a-2ed2-41ac-8cf5-353000bd950e";

Deno.test("로그인 자체는 로그인 없이 할 수 있다", () => {
  for (
    const path of [
      "/health",
      "/api/auth/state",
      "/api/auth/me",
      "/api/auth/login",
      "/api/auth/verify-code",
      "/api/auth/first-password",
      "/api/auth/bootstrap",
      "/api/auth/logout",
    ]
  ) {
    assertEquals(requiredFor(path, "POST").need, "공개", path);
  }
});

Deno.test("표에 없는 경로는 관리자만 — 잊으면 막히는 쪽으로 틀린다", () => {
  for (const path of ["/api/새로만든것", "/api/children-secret", "/api/", "/api/evaluations"]) {
    const found = requiredFor(path, "GET");
    assertEquals(found.need, "관리자", path);
    assertEquals(found.fallback, true, path);
  }
});

Deno.test("변경 기록과 경고 목록은 관리자만", () => {
  assertEquals(requiredFor("/api/audit", "GET").need, "관리자");
  assertEquals(requiredFor("/api/guard-warnings", "GET").need, "관리자");
});

Deno.test("계정 관리는 센터장 이상", () => {
  assertEquals(requiredFor("/api/accounts", "GET").need, "센터장");
  assertEquals(requiredFor(`/api/accounts/${UUID}`, "PATCH").need, "센터장");
  assertEquals(requiredFor(`/api/accounts/${UUID}/code`, "POST").need, "센터장");
  // 관리자 깃발은 경로가 따로 없다(같은 PATCH 의 필드) — 표가 아니라 핸들러가 가른다.
  // 예전에 여기서 /api/accounts/:id/admin 을 확인했는데, 그 경로는 라우팅에 없었다.
  // 없는 경로를 지키는 테스트는 통과해도 아무것도 지키지 않는다(api/accounts.test.ts).
  assertEquals(requiredFor(`/api/accounts/${UUID}/admin`, "PATCH").fallback, true);
});

Deno.test("같은 경로라도 메서드마다 등급이 다르다", () => {
  // 일지 작성자 드롭다운이 명단을 읽는다. 종사자도 필요하다.
  assertEquals(requiredFor("/api/staff", "GET").need, "종사자");
  // 등록·수정·삭제는 센터장 이상
  assertEquals(requiredFor("/api/staff", "POST").need, "센터장");
  assertEquals(requiredFor(`/api/staff/${UUID}`, "PATCH").need, "센터장");
  assertEquals(requiredFor(`/api/staff/${UUID}`, "DELETE").need, "센터장");
  // 하위 경로 읽기는 종사자
  assertEquals(requiredFor(`/api/staff/${UUID}/records-count`, "GET").need, "종사자");
});

Deno.test("업무 API 는 종사자 이상", () => {
  const paths = [
    "/api/children",
    `/api/children/${UUID}`,
    `/api/children/${UUID}/evaluation`,
    "/api/observations",
    `/api/observations/${UUID}/area`,
    "/api/journals",
    `/api/journals/${UUID}/extract`,
    `/api/journal-observations/${UUID}/merge`,
    "/api/schedules",
    "/api/resources",
    `/api/resources/${UUID}/merge`,
    `/api/resource-records/${UUID}`,
    "/api/resource-inbox",
    "/api/resource-stats",
    "/api/resource-categories",
    "/api/books",
    "/api/books/search",
    "/api/books/lookup",
  ];
  for (const path of paths) {
    assertEquals(requiredFor(path, "GET").need, "종사자", path);
  }
});

Deno.test("지금 있는 화면은 전부 PC 전용 — 모바일 계정은 아직 볼 것이 없다", () => {
  assertEquals(requiredFor("/api/children", "GET").pcOnly, true);
  assertEquals(requiredFor("/api/accounts", "GET").pcOnly, true);
  assertEquals(requiredFor("/api/audit", "GET").pcOnly, true);
  // 공개 경로는 폰에서도 열려야 한다 — 로그인 화면이 폰에서 안 열리면 안 된다
  assertEquals(requiredFor("/api/auth/login", "POST").pcOnly, false);
  assertEquals(requiredFor("/api/auth/me", "GET").pcOnly, false);
});

Deno.test("경로가 비슷해도 다른 것으로 읽지 않는다", () => {
  // /api/childrenX 는 /api/children 이 아니다
  assertEquals(requiredFor("/api/childrenX", "GET").fallback, true);
  assertEquals(requiredFor("/api/staffX", "GET").fallback, true);
  assertEquals(requiredFor("/api/booksX", "GET").fallback, true);
});

Deno.test("봉사자 폰 화면은 봉사 등급 + 모바일에서 열린다", () => {
  for (
    const path of [
      "/api/my/me",
      "/api/my/schedules",
      "/api/my/roster",
      "/api/my/journals",
      "/api/my/stats",
      "/api/my/children",
      `/api/my/schedules/${UUID}`,
    ]
  ) {
    const found = requiredFor(path, "GET");
    assertEquals(found.need, "봉사", path);
    // 이 값이 true 면 모바일 계정이 제 화면에서 막힌다 — 이 줄이 이 표의 요점이다
    assertEquals(found.pcOnly, false, path);
    assertEquals(found.fallback, false, path);
  }
});

Deno.test("문의 목록은 PC 쪽 — 봉사자는 보내기만 하고 못 읽는다", () => {
  assertEquals(requiredFor("/api/inquiries", "GET").need, "종사자");
  assertEquals(requiredFor(`/api/inquiries/${UUID}`, "PATCH").need, "종사자");
  // 보내는 자리는 /api/my 안에 있다
  assertEquals(requiredFor("/api/my/inquiries", "POST").need, "봉사");
});

Deno.test("이름이 my 로 시작한다고 열리지 않는다", () => {
  // /api/myself 는 /api/my 가 아니다
  assertEquals(requiredFor("/api/myself", "GET").fallback, true);
  assertEquals(requiredFor("/api/mystery", "GET").need, "관리자");
});

Deno.test("반기 관찰은 봉사자가 폰에서 여는 자리다", () => {
  const found = requiredFor(`/api/my/observations/${UUID}`, "PUT");
  assertEquals(found.need, "봉사");
  assertEquals(found.pcOnly, false);
  assertEquals(found.fallback, false);
});

Deno.test("설정은 읽기와 쓰기가 다르다", () => {
  // 관찰 영역·동의서 문구는 종사자도 읽는다(영역 고르는 칸, 설정 › 동의서)
  assertEquals(requiredFor("/api/settings/observation_areas", "GET").need, "종사자");
  assertEquals(requiredFor("/api/settings/consent_form", "GET").need, "종사자");
  // 바꾸는 것은 센터의 판단이다
  assertEquals(requiredFor("/api/settings/consent_form", "PUT").need, "센터장");
  assertEquals(requiredFor("/api/settings/volunteer_journal_scope", "PUT").need, "센터장");
  // 폰에서는 어느 쪽도 안 열린다
  assertEquals(requiredFor("/api/settings/consent_form", "GET").pcOnly, true);
});

Deno.test("봉사자 설정은 읽기도 센터장 이상 — 종사자 설정은 문의함·동의서뿐", () => {
  for (
    const key of ["volunteer_journal_scope", "half_observation_open", "half_observation_items"]
  ) {
    const found = requiredFor(`/api/settings/${key}`, "GET");
    assertEquals(found.need, "센터장", key);
    assertEquals(found.fallback, false, key);
    assertEquals(found.pcOnly, true, key);
  }
});

Deno.test("반기 관찰 항목은 관리자만 고친다 — 평가지표라 센터장보다 한 단계 위", () => {
  assertEquals(requiredFor("/api/settings/half_observation_items", "PUT").need, "관리자");
  // 읽기는 봉사자 설정 화면과 같이 센터장까지
  assertEquals(requiredFor("/api/settings/half_observation_items", "GET").need, "센터장");
  // 다른 설정은 그대로 센터장
  assertEquals(requiredFor("/api/settings/half_observation_open", "PUT").need, "센터장");
});

Deno.test("성장 추이는 아동 상세와 같은 등급", () => {
  const found = requiredFor(`/api/children/${UUID}/growth`, "GET");
  assertEquals(found.need, "종사자");
  assertEquals(found.pcOnly, true);
});

Deno.test("근거 [확인함] 은 종사자 이상 — PC 화면의 일이다", () => {
  const found = requiredFor(`/api/children/${UUID}/evaluation/evidence-check`, "POST");
  assertEquals(found.need, "종사자");
  assertEquals(found.pcOnly, true);
  assertEquals(found.fallback, false);
});

Deno.test("표지 사진 읽기는 도서 규칙을 따른다 — 종사자 이상·PC", () => {
  const found = requiredFor("/api/books/from-cover", "POST");
  assertEquals(found.need, "종사자");
  assertEquals(found.pcOnly, true);
  // 표에 적힌 /api/books 규칙에 걸린 것이지, 빠져서 기본값으로 떨어진 것이 아니다
  assertEquals(found.fallback, false);
});

Deno.test("시스템 점검은 관리자 전용이고, 표에 적힌 규칙으로 걸린다(기본값이 아니다)", () => {
  for (
    const [path, method] of [["/api/system-check", "POST"], ["/api/system-check/detail", "GET"]]
  ) {
    const found = requiredFor(path, method);
    assertEquals(found.need, "관리자", path);
    assertEquals(found.fallback, false, path);
    assertEquals(found.pcOnly, true, path);
  }
  // 비슷한 이름이 딸려 열리지 않는다
  assertEquals(requiredFor("/api/system-checkout", "GET").fallback, true);
});
