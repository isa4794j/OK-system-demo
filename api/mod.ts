/**
 * 브라우저가 호출하는 서버 API 라우팅.
 * 앞으로 추가되는 엔드포인트는 여기에 등록한다.
 *
 * 처리할 경로가 아니면 null을 반환해 main.ts가 정적 파일로 넘기게 한다.
 */
import { handleHealth } from "./health.ts";
import {
  handleAuthMe,
  handleAuthState,
  handleBootstrap,
  handleFirstPassword,
  handleLogin,
  handleLogout,
  handleVerifyCode,
} from "./auth.ts";
import {
  handleAccountsList,
  handleAccountUpdate,
  handleIssueCode,
  handleRevokeCode,
} from "./accounts.ts";
import { handleWarningsClear, handleWarningsList } from "./guard_warnings.ts";
import { handleSystemCheck, handleSystemCheckDetail } from "./system_check.ts";
import { handleInquiriesCount, handleInquiriesList, handleInquirySeen } from "./inquiries.ts";
import { handleSettingGet, handleSettingSave } from "./settings.ts";
import { handleConsentAgree, handleConsentState, handlePublicPrivacy } from "./consent.ts";
import { handleChildGrowth } from "./growth.ts";
import { featureClosed, HALF_OBSERVATION_ENABLED } from "../lib/features.ts";
import {
  handleMyChildren,
  handleMyInquiries,
  handleMyInquiryCreate,
  handleMyJournalCreate,
  handleMyJournalDelete,
  handleMyJournals,
  handleMyJournalUpdate,
  handleMyMe,
  handleMyObservationGet,
  handleMyObservationSave,
  handleMyRoleSelect,
  handleMyRoster,
  handleMyScheduleCreate,
  handleMyScheduleDelete,
  handleMySchedules,
  handleMyScheduleUpdate,
  handleMyStats,
} from "./my.ts";
import {
  handleResourceBatch,
  handleResourceCategoriesGet,
  handleResourceCategoriesSave,
  handleResourceCreate,
  handleResourceDelete,
  handleResourceMerge,
  handleResourceRecordCount,
  handleResourceReject,
  handleResourcesFromPhoto,
  handleResourcesList,
  handleResourceSplit,
  handleResourceUpdate,
} from "./resources.ts";
import {
  handleInboxRestore,
  handleJournalResources,
  handleResourceExtract,
  handleResourceInbox,
  handleResourceRecordDelete,
  handleResourceRecordUpdate,
  handleResourceResolve,
} from "./resource_records.ts";
import { handleResourceStats } from "./resource_stats.ts";
import { handleAuditList } from "./audit.ts";
import {
  handleBookCreate,
  handleBookDelete,
  handleBookFromCover,
  handleBookImportMatch,
  handleBookImportParse,
  handleBookLookup,
  handleBookRefresh,
  handleBookSearch,
  handleBooksList,
  handleBookUpdate,
} from "./books.ts";
import {
  handleChildCreate,
  handleChildDelete,
  handleChildGet,
  handleChildRecordsCount,
  handleChildrenList,
  handleChildUpdate,
} from "./children.ts";
import {
  handleStaffCreate,
  handleStaffDelete,
  handleStaffList,
  handleStaffRecordsCount,
  handleStaffScheduled,
  handleStaffUpdate,
} from "./staff.ts";
import {
  handleScheduleCreate,
  handleScheduleDelete,
  handleSchedulesList,
  handleScheduleUpdate,
} from "./schedules.ts";
import {
  handleEvaluationDraft,
  handleEvaluationGet,
  handleEvaluationSave,
  handleEvidenceCheck,
} from "./evaluations.ts";
import {
  handleJournalCreate,
  handleJournalDelete,
  handleJournalExtract,
  handleJournalObservations,
  handleJournalResolve,
  handleJournalsList,
  handleJournalUpdate,
  handleMissingJournals,
} from "./journals.ts";
import {
  handleJournalObsDelete,
  handleJournalObsMerge,
  handleJournalObsSplit,
  handleJournalObsUpdate,
} from "./journal_observations.ts";
import {
  handleImportableList,
  handleObservationAreaUpdate,
  handleObservationContentUpdate,
  handleObservationCreate,
  handleObservationDelete,
  handleObservationImport,
  handleObservationMerge,
  handleObservationsList,
  handleObservationSplit,
} from "./observations.ts";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** /api/observations/<uuid>/<area|content|split|merge> */
const OBSERVATION_SUB = new RegExp(
  `^/api/observations/(${UUID})/(area|content|split|merge)$`,
  "i",
);

/** /api/journal-observations/<uuid> */
const JOURNAL_OBS_ONE = new RegExp(`^/api/journal-observations/(${UUID})$`, "i");

/** /api/journal-observations/<uuid>/<merge|split> */
const JOURNAL_OBS_SUB = new RegExp(`^/api/journal-observations/(${UUID})/(merge|split)$`, "i");

/** /api/children/<uuid>/importable */
const CHILD_IMPORTABLE = new RegExp(`^/api/children/(${UUID})/importable$`, "i");

/** /api/children/<uuid>/growth */
const CHILD_GROWTH = new RegExp(`^/api/children/(${UUID})/growth$`, "i");

/** /api/children/<uuid>/evaluation */
const CHILD_EVALUATION = new RegExp(`^/api/children/(${UUID})/evaluation$`, "i");

/** /api/children/<uuid>/evaluation/evidence-check */
const CHILD_EVIDENCE_CHECK = new RegExp(
  `^/api/children/(${UUID})/evaluation/evidence-check$`,
  "i",
);

/** /api/children/<uuid>/evaluation/draft */
const CHILD_EVAL_DRAFT = new RegExp(`^/api/children/(${UUID})/evaluation/draft$`, "i");

/** /api/schedules/<uuid> */
const SCHEDULE_ONE = new RegExp(`^/api/schedules/(${UUID})$`, "i");

/** /api/staff/<uuid> */
const STAFF_ONE = new RegExp(`^/api/staff/(${UUID})$`, "i");

/** /api/staff/<uuid>/records-count */
const STAFF_COUNT = new RegExp(`^/api/staff/(${UUID})/records-count$`, "i");

/** /api/children/<uuid> */
const CHILD_ONE = new RegExp(`^/api/children/(${UUID})$`, "i");

/** /api/children/<uuid>/records-count */
const CHILD_COUNT = new RegExp(`^/api/children/(${UUID})/records-count$`, "i");

/** /api/resources/<uuid> */
const RESOURCE_ONE = new RegExp(`^/api/resources/(${UUID})$`, "i");

/** /api/books/<uuid> */
const BOOK_ONE = new RegExp(`^/api/books/(${UUID})$`, "i");

/** /api/books/<uuid>/refresh */
const BOOK_REFRESH = new RegExp(`^/api/books/(${UUID})/refresh$`, "i");

/** /api/resources/<uuid>/<merge|split|reject|record-count> */
const RESOURCE_SUB = new RegExp(
  `^/api/resources/(${UUID})/(merge|split|reject|record-count)$`,
  "i",
);

/** /api/observations/<uuid> */
const OBSERVATION_ONE = new RegExp(`^/api/observations/(${UUID})$`, "i");

/** /api/journals/<uuid> */
const JOURNAL_ONE = new RegExp(`^/api/journals/(${UUID})$`, "i");

/** /api/journals/<uuid>/<extract|observations|extract-resources|resources> */
const JOURNAL_SUB = new RegExp(
  `^/api/journals/(${UUID})/(extract|observations|extract-resources|resources|resolve|resolve-resources)$`,
  "i",
);

/** /api/resource-records/<uuid> */
const RESOURCE_RECORD_ONE = new RegExp(`^/api/resource-records/(${UUID})$`, "i");

/** /api/my/schedules/<uuid> */
const MY_SCHEDULE_ONE = new RegExp(`^/api/my/schedules/(${UUID})$`, "i");

/** /api/my/journals/<uuid> */
const MY_JOURNAL_ONE = new RegExp(`^/api/my/journals/(${UUID})$`, "i");

/** /api/my/observations/<아동 uuid> */
const MY_OBSERVATION_ONE = new RegExp(`^/api/my/observations/(${UUID})$`, "i");

/** /api/inquiries/<uuid>/seen */
const INQUIRY_SEEN = new RegExp(`^/api/inquiries/(${UUID})/seen$`, "i");

/** /api/settings/<열쇠> — 열리는 열쇠는 api/settings.ts 안의 표가 정한다 */
const SETTING_ONE = /^\/api\/settings\/([a-z0-9_]{1,60})$/i;

/** /api/accounts/<uuid> */
const ACCOUNT_ONE = new RegExp(`^/api/accounts/(${UUID})$`, "i");

/** /api/accounts/<uuid>/code */
const ACCOUNT_CODE = new RegExp(`^/api/accounts/(${UUID})/code$`, "i");

function methodNotAllowed(allowed: string): Promise<Response> {
  return Promise.resolve(
    Response.json({ error: `이 주소는 ${allowed} 만 받습니다.` }, {
      status: 405,
      headers: { "allow": allowed, "cache-control": "no-store" },
    }),
  );
}

export function routeApi(req: Request, pathname: string): Promise<Response> | null {
  if (pathname === "/health" && req.method === "GET") {
    return handleHealth();
  }

  // 인증. 4단계에서 관문이 붙어도 이 경로들은 "공개" 로 남는다 —
  // 로그인 자체는 로그인 없이 할 수 있어야 한다.
  if (pathname === "/api/auth/state") {
    return req.method === "GET" ? handleAuthState() : methodNotAllowed("GET");
  }
  // 개인정보 동의 — 상태는 공개(세션 없으면 needed:false), 기록은 로그인한 사람(폰 포함)
  if (pathname === "/api/auth/consent") {
    if (req.method === "GET") return handleConsentState(req);
    if (req.method === "POST") return handleConsentAgree(req);
    return methodNotAllowed("GET, POST");
  }
  // 처리방침 — 로그인 화면 하단 링크가 연다(공개)
  if (pathname === "/api/public/privacy") {
    return req.method === "GET" ? handlePublicPrivacy() : methodNotAllowed("GET");
  }
  if (pathname === "/api/auth/me") {
    return req.method === "GET" ? handleAuthMe(req) : methodNotAllowed("GET");
  }
  if (pathname === "/api/auth/login") {
    return req.method === "POST" ? handleLogin(req) : methodNotAllowed("POST");
  }
  if (pathname === "/api/auth/verify-code") {
    return req.method === "POST" ? handleVerifyCode(req) : methodNotAllowed("POST");
  }
  if (pathname === "/api/auth/first-password") {
    return req.method === "POST" ? handleFirstPassword(req) : methodNotAllowed("POST");
  }
  if (pathname === "/api/auth/bootstrap") {
    return req.method === "POST" ? handleBootstrap(req) : methodNotAllowed("POST");
  }
  if (pathname === "/api/auth/logout") {
    return req.method === "POST" ? handleLogout(req) : methodNotAllowed("POST");
  }

  // 봉사자 폰 화면. 좁은 문이라 한자리에 모아 둔다.
  if (pathname.startsWith("/api/my/")) {
    if (pathname === "/api/my/me") {
      return req.method === "GET" ? handleMyMe() : methodNotAllowed("GET");
    }
    if (pathname === "/api/my/role") {
      return req.method === "POST" ? handleMyRoleSelect(req) : methodNotAllowed("POST");
    }
    if (pathname === "/api/my/roster") {
      return req.method === "GET" ? handleMyRoster(req) : methodNotAllowed("GET");
    }
    if (pathname === "/api/my/stats") {
      return req.method === "GET" ? handleMyStats(req) : methodNotAllowed("GET");
    }
    if (pathname === "/api/my/children") {
      // 반기별 관찰 숨김(lib/features.ts) — 메서드 갈래(405)는 남겨 정책표 점검이 경로를 찾게 한다
      if (req.method !== "GET") return methodNotAllowed("GET");
      return HALF_OBSERVATION_ENABLED ? handleMyChildren(req) : featureClosed();
    }
    if (pathname === "/api/my/inquiries") {
      if (req.method === "GET") return handleMyInquiries();
      if (req.method === "POST") return handleMyInquiryCreate(req);
      return methodNotAllowed("GET, POST");
    }
    if (pathname === "/api/my/schedules") {
      if (req.method === "GET") return handleMySchedules(req);
      if (req.method === "POST") return handleMyScheduleCreate(req);
      return methodNotAllowed("GET, POST");
    }
    if (pathname === "/api/my/journals") {
      if (req.method === "GET") return handleMyJournals(req);
      if (req.method === "POST") return handleMyJournalCreate(req);
      return methodNotAllowed("GET, POST");
    }

    const mySchedule = MY_SCHEDULE_ONE.exec(pathname);
    if (mySchedule) {
      if (req.method === "PATCH") return handleMyScheduleUpdate(req, mySchedule[1]);
      if (req.method === "DELETE") return handleMyScheduleDelete(mySchedule[1]);
      return methodNotAllowed("PATCH, DELETE");
    }

    const myObservation = MY_OBSERVATION_ONE.exec(pathname);
    if (myObservation) {
      if (req.method !== "GET" && req.method !== "PUT") return methodNotAllowed("GET, PUT");
      if (!HALF_OBSERVATION_ENABLED) return featureClosed();
      if (req.method === "GET") return handleMyObservationGet(req, myObservation[1]);
      return handleMyObservationSave(req, myObservation[1]);
    }

    const myJournal = MY_JOURNAL_ONE.exec(pathname);
    if (myJournal) {
      if (req.method === "PATCH") return handleMyJournalUpdate(req, myJournal[1]);
      if (req.method === "DELETE") return handleMyJournalDelete(myJournal[1]);
      return methodNotAllowed("PATCH, DELETE");
    }
    return null;
  }

  // 문의함 — 봉사자가 폰에서 보낸 불편사항. 종사자가 읽는다.
  if (pathname === "/api/inquiries") {
    return req.method === "GET" ? handleInquiriesList() : methodNotAllowed("GET");
  }
  if (pathname === "/api/inquiries/count") {
    return req.method === "GET" ? handleInquiriesCount() : methodNotAllowed("GET");
  }
  const inquirySeen = INQUIRY_SEEN.exec(pathname);
  if (inquirySeen) {
    return req.method === "POST" ? handleInquirySeen(inquirySeen[1]) : methodNotAllowed("POST");
  }

  // 센터가 정하는 값. 열리는 열쇠는 api/settings.ts 안의 표가 정한다.
  const setting = SETTING_ONE.exec(pathname);
  if (setting) {
    if (req.method === "GET") return handleSettingGet(setting[1]);
    if (req.method === "PUT") return handleSettingSave(req, setting[1]);
    return methodNotAllowed("GET, PUT");
  }

  // 시스템 점검 — 읽기만 한다. 관리자만 본다.
  if (pathname === "/api/system-check") {
    return req.method === "POST" ? handleSystemCheck() : methodNotAllowed("POST");
  }
  if (pathname === "/api/system-check/detail") {
    return req.method === "GET" ? handleSystemCheckDetail(req) : methodNotAllowed("GET");
  }

  // 관문 경고 — 잠갔으면 막혔을 요청. 관리자만 본다.
  if (pathname === "/api/guard-warnings") {
    if (req.method === "GET") return handleWarningsList();
    if (req.method === "DELETE") return handleWarningsClear();
    return methodNotAllowed("GET, DELETE");
  }

  // 계정 관리. ★ 5단계에서 관리자·센터장 전용으로 잠긴다(api/accounts.ts 주석 참고).
  if (pathname === "/api/accounts") {
    return req.method === "GET" ? handleAccountsList() : methodNotAllowed("GET");
  }

  const accountCode = ACCOUNT_CODE.exec(pathname);
  if (accountCode) {
    if (req.method === "POST") return handleIssueCode(req, accountCode[1]);
    if (req.method === "DELETE") return handleRevokeCode(accountCode[1]);
    return methodNotAllowed("POST, DELETE");
  }

  const accountOne = ACCOUNT_ONE.exec(pathname);
  if (accountOne) {
    return req.method === "PATCH"
      ? handleAccountUpdate(req, accountOne[1])
      : methodNotAllowed("PATCH");
  }
  if (pathname === "/api/children") {
    if (req.method === "GET") return handleChildrenList();
    if (req.method === "POST") return handleChildCreate(req);
    return methodNotAllowed("GET, POST");
  }

  const childCount = CHILD_COUNT.exec(pathname);
  if (childCount) {
    return req.method === "GET" ? handleChildRecordsCount(childCount[1]) : methodNotAllowed("GET");
  }

  const childOne = CHILD_ONE.exec(pathname);
  if (childOne) {
    if (req.method === "GET") return handleChildGet(childOne[1]);
    if (req.method === "PATCH") return handleChildUpdate(req, childOne[1]);
    if (req.method === "DELETE") return handleChildDelete(childOne[1]);
    return methodNotAllowed("GET, PATCH, DELETE");
  }
  if (pathname === "/api/staff") {
    if (req.method === "GET") return handleStaffList(req);
    if (req.method === "POST") return handleStaffCreate(req);
    return methodNotAllowed("GET, POST");
  }

  if (pathname === "/api/schedules") {
    if (req.method === "GET") return handleSchedulesList(req);
    if (req.method === "POST") return handleScheduleCreate(req);
    return methodNotAllowed("GET, POST");
  }

  const scheduleOne = SCHEDULE_ONE.exec(pathname);
  if (scheduleOne) {
    if (req.method === "PATCH") return handleScheduleUpdate(req, scheduleOne[1]);
    if (req.method === "DELETE") return handleScheduleDelete(scheduleOne[1]);
    return methodNotAllowed("PATCH, DELETE");
  }

  // /api/staff/<uuid> 보다 먼저 본다. "scheduled" 는 uuid 규칙에 걸리지 않지만
  // 읽는 순서를 분명히 해 둔다.
  if (pathname === "/api/staff/scheduled") {
    return req.method === "GET" ? handleStaffScheduled(req) : methodNotAllowed("GET");
  }

  const staffCount = STAFF_COUNT.exec(pathname);
  if (staffCount) {
    return req.method === "GET" ? handleStaffRecordsCount(staffCount[1]) : methodNotAllowed("GET");
  }

  const staffOne = STAFF_ONE.exec(pathname);
  if (staffOne) {
    if (req.method === "PATCH") return handleStaffUpdate(req, staffOne[1]);
    if (req.method === "DELETE") return handleStaffDelete(staffOne[1]);
    return methodNotAllowed("PATCH, DELETE");
  }

  if (pathname === "/api/resources") {
    if (req.method === "GET") return handleResourcesList(req);
    if (req.method === "POST") return handleResourceCreate(req);
    return methodNotAllowed("GET, POST");
  }

  // /api/resources/<uuid> 보다 먼저 본다. uuid 규칙에 걸리지 않지만 순서를 분명히 해 둔다.
  if (pathname === "/api/resources/batch") {
    return req.method === "POST" ? handleResourceBatch(req) : methodNotAllowed("POST");
  }
  if (pathname === "/api/resources/from-photo") {
    return req.method === "POST" ? handleResourcesFromPhoto(req) : methodNotAllowed("POST");
  }

  const resourceOne = RESOURCE_ONE.exec(pathname);
  if (resourceOne) {
    if (req.method === "PATCH") return handleResourceUpdate(req, resourceOne[1]);
    if (req.method === "DELETE") return handleResourceDelete(resourceOne[1]);
    return methodNotAllowed("PATCH, DELETE");
  }

  const resourceSub = RESOURCE_SUB.exec(pathname);
  if (resourceSub) {
    const [, id, action] = resourceSub;
    if (action === "record-count") {
      return req.method === "GET" ? handleResourceRecordCount(id) : methodNotAllowed("GET");
    }
    if (action === "merge") {
      return req.method === "POST" ? handleResourceMerge(req, id) : methodNotAllowed("POST");
    }
    if (action === "split") {
      return req.method === "POST" ? handleResourceSplit(req, id) : methodNotAllowed("POST");
    }
    return req.method === "POST" ? handleResourceReject(id) : methodNotAllowed("POST");
  }

  if (pathname === "/api/resource-inbox") {
    return req.method === "GET" ? handleResourceInbox() : methodNotAllowed("GET");
  }
  if (pathname === "/api/resource-inbox/restore") {
    return req.method === "POST" ? handleInboxRestore(req) : methodNotAllowed("POST");
  }

  // ★ 관리자 전용 — 로그인이 생기면 여기서 권한을 본다
  if (pathname === "/api/audit") {
    return req.method === "GET" ? handleAuditList(req) : methodNotAllowed("GET");
  }

  if (pathname === "/api/books") {
    if (req.method === "GET") return handleBooksList(req);
    if (req.method === "POST") return handleBookCreate(req);
    return methodNotAllowed("GET, POST");
  }

  // /api/books/<uuid> 보다 먼저 본다. "lookup" 은 uuid 규칙에 걸리지 않지만 순서를 분명히 해 둔다.
  if (pathname === "/api/books/lookup") {
    return req.method === "GET" ? handleBookLookup(req) : methodNotAllowed("GET");
  }
  if (pathname === "/api/books/import/match") {
    return req.method === "POST" ? handleBookImportMatch(req) : methodNotAllowed("POST");
  }
  if (pathname === "/api/books/import/parse") {
    return req.method === "POST" ? handleBookImportParse(req) : methodNotAllowed("POST");
  }
  if (pathname === "/api/books/from-cover") {
    return req.method === "POST" ? handleBookFromCover(req) : methodNotAllowed("POST");
  }

  if (pathname === "/api/books/search") {
    return req.method === "GET" ? handleBookSearch(req) : methodNotAllowed("GET");
  }

  const bookRefresh = BOOK_REFRESH.exec(pathname);
  if (bookRefresh) {
    return req.method === "POST"
      ? handleBookRefresh(req, bookRefresh[1])
      : methodNotAllowed("POST");
  }

  const bookOne = BOOK_ONE.exec(pathname);
  if (bookOne) {
    if (req.method === "PATCH") return handleBookUpdate(req, bookOne[1]);
    if (req.method === "DELETE") return handleBookDelete(bookOne[1]);
    return methodNotAllowed("PATCH, DELETE");
  }

  if (pathname === "/api/resource-stats") {
    return req.method === "GET" ? handleResourceStats(req) : methodNotAllowed("GET");
  }

  // 카테고리는 자원의 하위 자원이 아니라 설정이라 /api/resources 아래에 두지 않는다
  if (pathname === "/api/resource-categories") {
    if (req.method === "GET") return handleResourceCategoriesGet();
    if (req.method === "PUT") return handleResourceCategoriesSave(req);
    return methodNotAllowed("GET, PUT");
  }

  if (pathname === "/api/observations") {
    if (req.method === "GET") return handleObservationsList(req);
    if (req.method === "POST") return handleObservationCreate(req);
    return methodNotAllowed("GET, POST");
  }

  // /api/observations/<uuid>/... 보다 먼저 봐야 한다.
  // "import"는 uuid가 아니라 저 규칙에 걸리지 않지만, 읽는 순서를 분명히 해 둔다.
  if (pathname === "/api/observations/import") {
    return req.method === "POST" ? handleObservationImport(req) : methodNotAllowed("POST");
  }

  const importable = CHILD_IMPORTABLE.exec(pathname);
  if (importable) {
    return req.method === "GET" ? handleImportableList(importable[1]) : methodNotAllowed("GET");
  }

  const evidenceCheck = CHILD_EVIDENCE_CHECK.exec(pathname);
  if (evidenceCheck) {
    return req.method === "POST"
      ? handleEvidenceCheck(req, evidenceCheck[1])
      : methodNotAllowed("POST");
  }

  const evalDraft = CHILD_EVAL_DRAFT.exec(pathname);
  if (evalDraft) {
    return req.method === "POST"
      ? handleEvaluationDraft(req, evalDraft[1])
      : methodNotAllowed("POST");
  }

  const growth = CHILD_GROWTH.exec(pathname);
  if (growth) {
    if (req.method !== "GET") return methodNotAllowed("GET");
    return HALF_OBSERVATION_ENABLED ? handleChildGrowth(growth[1]) : featureClosed();
  }

  const evaluation = CHILD_EVALUATION.exec(pathname);
  if (evaluation) {
    if (req.method === "GET") return handleEvaluationGet(req, evaluation[1]);
    if (req.method === "PUT") return handleEvaluationSave(req, evaluation[1]);
    return methodNotAllowed("GET, PUT");
  }

  const observationOne = OBSERVATION_ONE.exec(pathname);
  if (observationOne) {
    return req.method === "DELETE"
      ? handleObservationDelete(observationOne[1])
      : methodNotAllowed("DELETE");
  }

  const observationSub = OBSERVATION_SUB.exec(pathname);
  if (observationSub) {
    const [, id, action] = observationSub;
    if (action === "area") {
      return req.method === "PATCH"
        ? handleObservationAreaUpdate(req, id)
        : methodNotAllowed("PATCH");
    }
    if (action === "content") {
      return req.method === "PATCH"
        ? handleObservationContentUpdate(req, id)
        : methodNotAllowed("PATCH");
    }
    if (action === "merge") {
      return req.method === "POST" ? handleObservationMerge(req, id) : methodNotAllowed("POST");
    }
    return req.method === "POST" ? handleObservationSplit(req, id) : methodNotAllowed("POST");
  }

  const journalObsSub = JOURNAL_OBS_SUB.exec(pathname);
  if (journalObsSub) {
    const [, id, action] = journalObsSub;
    if (req.method !== "POST") return methodNotAllowed("POST");
    return action === "merge" ? handleJournalObsMerge(req, id) : handleJournalObsSplit(req, id);
  }

  const journalObsOne = JOURNAL_OBS_ONE.exec(pathname);
  if (journalObsOne) {
    if (req.method === "PATCH") return handleJournalObsUpdate(req, journalObsOne[1]);
    if (req.method === "DELETE") return handleJournalObsDelete(journalObsOne[1]);
    return methodNotAllowed("PATCH, DELETE");
  }

  if (pathname === "/api/journals") {
    if (req.method === "GET") return handleJournalsList(req);
    if (req.method === "POST") return handleJournalCreate(req);
    return methodNotAllowed("GET, POST");
  }

  // /api/journals/<uuid> 보다 먼저 본다. "missing" 은 uuid 규칙에 걸리지 않지만
  // 읽는 순서를 분명히 해 둔다.
  if (pathname === "/api/journals/missing") {
    return req.method === "GET" ? handleMissingJournals(req) : methodNotAllowed("GET");
  }

  const journalOne = JOURNAL_ONE.exec(pathname);
  if (journalOne) {
    if (req.method === "PATCH") return handleJournalUpdate(req, journalOne[1]);
    if (req.method === "DELETE") return handleJournalDelete(journalOne[1]);
    return methodNotAllowed("PATCH, DELETE");
  }

  const journalSub = JOURNAL_SUB.exec(pathname);
  if (journalSub) {
    const [, id, action] = journalSub;
    if (action === "extract") {
      return req.method === "POST" ? handleJournalExtract(id) : methodNotAllowed("POST");
    }
    if (action === "extract-resources") {
      return req.method === "POST" ? handleResourceExtract(id) : methodNotAllowed("POST");
    }
    if (action === "resources") {
      return req.method === "GET" ? handleJournalResources(id) : methodNotAllowed("GET");
    }
    if (action === "resolve") {
      return req.method === "POST" ? handleJournalResolve(req, id) : methodNotAllowed("POST");
    }
    if (action === "resolve-resources") {
      return req.method === "POST" ? handleResourceResolve(req, id) : methodNotAllowed("POST");
    }
    return req.method === "GET" ? handleJournalObservations(id) : methodNotAllowed("GET");
  }

  const recordOne = RESOURCE_RECORD_ONE.exec(pathname);
  if (recordOne) {
    if (req.method === "PATCH") return handleResourceRecordUpdate(req, recordOne[1]);
    if (req.method === "DELETE") return handleResourceRecordDelete(recordOne[1]);
    return methodNotAllowed("PATCH, DELETE");
  }

  // /api/ 아래의 나머지는 정적 파일로 넘기지 않고 여기서 끝낸다.
  // (오타난 API 주소가 index.html을 받아 조용히 실패하는 것을 막는다)
  if (pathname.startsWith("/api/")) {
    return Promise.resolve(
      Response.json({ error: "존재하지 않는 API입니다." }, { status: 404 }),
    );
  }

  return null;
}
