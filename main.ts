/**
 * OK-system 서버 진입점
 *
 * 역할: HTTP 요청을 받아 /api 핸들러 또는 /web 정적 파일로 넘긴다.
 * 이 파일은 Supabase를 직접 부르지 않는다.
 */
import { serveDir } from "@std/http/file-server";
import { fromFileUrl } from "@std/path";
import { routeApi } from "./api/mod.ts";
import { demoRefusal } from "./api/demo_guard.ts";
import { checkAccess, isEnforcing, resolveSession, toRequestUser } from "./api/guard.ts";
import { runWithUser } from "./lib/request_context.ts";
import { drainBeforeExit } from "./lib/background.ts";
import { SHUTDOWN_WAIT_MS, shutdownGracefully } from "./lib/shutdown.ts";
import {
  startIntervalSweep,
  SWEEP_CRON_NAME,
  sweepMode,
  sweepUnanalyzed,
} from "./lib/analysis_sweep.ts";
import { needsConsent } from "./api/consent.ts";

const WEB_ROOT = fromFileUrl(new URL("./web/", import.meta.url));

/** 확장자 없이 부르는 주소. 주소창에 ".html" 이 붙어 있는 것은 군더더기다. */
const PRETTY: Record<string, string> = {
  "/login": "/login.html",
  "/m": "/m.html",
  "/print": "/print.html",
  "/privacy": "/privacy.html",
};

function goTo(where: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location: where, "cache-control": "no-store" },
  });
}

/**
 * 요청 하나를 처리한다.
 *
 * 순서가 정해져 있다.
 *   1. 쿠키에서 "지금 누구인가" 를 알아낸다
 *   2. 정책표로 이 요청을 받아도 되는지 본다 (AUTH_ENFORCE 가 false 면 경고만)
 *   3. 컨텍스트에 담고 라우팅으로 넘긴다 — 감사 로그가 그 이름을 쓴다
 *
 * 세션을 푸는 데 실패해도 요청을 막지 않는다. 그건 "로그인 안 한 사람" 과 같고,
 * 관문이 그 다음을 판단한다. 다만 서버 로그에는 남긴다.
 */
async function handleApi(req: Request, pathname: string): Promise<Response | null> {
  let found = null;
  try {
    found = await resolveSession(req);
  } catch (error) {
    console.error("[세션 확인]", error);
  }
  const account = found?.account ?? null;

  const blocked = await checkAccess(req, pathname, account);
  if (blocked) return blocked;

  // 데모 전용 — 계정·비밀번호·문구 쓰기를 막는다(api/demo_guard.ts)
  const demoBlocked = demoRefusal(req, pathname, account?.login_name ?? null);
  if (demoBlocked) return demoBlocked;

  const user = found
    ? toRequestUser(found.account, { id: found.session_id, active_role: found.active_role })
    : null;
  return await runWithUser(user, async () => {
    const response = routeApi(req, pathname);
    return response ? await response : null;
  });
}

async function handler(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);

  // 1) 서버 API
  if (pathname === "/health" || pathname.startsWith("/api/")) {
    const apiResponse = await handleApi(req, pathname);
    if (apiResponse) return apiResponse;
  }

  // 2) 화면을 열기 전에 누구인지 보고 갈래를 정한다.
  //
  // 본 화면(index.html)은 열리자마자 API 를 예닐곱 개 부른다. 세션이 없으면
  // 그것이 전부 401 이 되고, 화면은 빈 채로 오류만 늘어놓는다.
  // 봉사자에게는 그 API 가 전부 403 이라 더 나쁘다 — 아예 제 화면으로 보낸다.
  //
  // 로그인 페이지와 정적 자산은 여기서 걸지 않는다 — 로그인 화면이 제 CSS 를
  // 못 받으면 흰 화면이 된다.
  const home = pathname === "/" || pathname === "/index.html";
  const print = pathname === "/print" || pathname === "/print.html";
  if (home || print || pathname === "/m" || pathname === "/login") {
    const found = await resolveSession(req).catch(() => null);
    // 034 뒤 아직 개인정보 처리 동의 전인 사람 — 로그인 화면이 한 번 묻는다(api/consent.ts).
    // 확인이 실패하면 막지 않는다(동의 칸 확인 하나 때문에 센터 전체가 못 들어오면 안 된다).
    const consent = found ? await needsConsent(found.account.id).catch(() => false) : false;

    // 이미 들어와 있는 사람에게 로그인 화면을 다시 보여 줄 이유가 없다.
    // 뒤로 가기로 되돌아오거나 주소를 직접 친 경우가 여기 든다 —
    // 그때 로그인 화면이 뜨면 "로그아웃됐나" 하고 놀란다.
    if (pathname === "/login") {
      if (found && !consent) return goTo(found.account.access_kind === "모바일" ? "/m" : "/");
    } else {
      if (!found && (await isEnforcing())) return goTo("/login");
      if (consent) return goTo("/login");

      // 봉사자 계정은 PC 화면에서 할 수 있는 것이 없다. 제 화면으로 보낸다.
      // 반대는 막지 않는다 — 종사자가 "봉사자에게 뭐가 보이나" 를 확인할 길이 있어야 한다.
      if ((home || print) && found?.account.access_kind === "모바일") return goTo("/m");
    }
  }

  // 3) 정적 화면 ( "/" 는 web/index.html )
  //
  // serveDir 는 경로를 파일 이름 그대로 찾는다. "/login" 은 web/login 이라는 파일을
  // 찾다가 없어서 404 다. 확장자를 붙여 다시 부른다 —
  // 주소창에 ".html" 이 붙어 있는 것은 사람이 보기에 군더더기다.
  const wanted = PRETTY[pathname] ?? pathname;
  const fileRequest = wanted === pathname ? req : new Request(new URL(wanted, req.url), req);

  // 이상한 경로("//etc/passwd", "C:/…", "%00", "..%2f")는 serveDir 가 500 으로 끝내거나 예외를 던진다.
  // 내용이 새지는 않지만 "없는 파일" 과 다르게 보일 까닭이 없다 — 404 로 통일한다(1차 전수 점검).
  let fileResponse: Response;
  try {
    fileResponse = await serveDir(fileRequest, {
      fsRoot: WEB_ROOT,
      quiet: true,
      showDirListing: false,
      showIndex: true,
    });
  } catch {
    fileResponse = new Response(null, { status: 500 });
  }
  // 경로를 고쳐 다시 가라는 리다이렉트("..%2f.env" → "/.env")도 같은 부류다. 끝 "/" 붙이기만 남긴다.
  // (304 "안 바뀜" 은 리다이렉트가 아니다 — 위치 헤더가 있는 것만 본다)
  const location = fileResponse.headers.get("location");
  const moved = location && fileResponse.status >= 300 && fileResponse.status < 400
    ? new URL(location, req.url).pathname
    : null;
  if (moved !== null && moved !== `${pathname}/`) {
    fileResponse = new Response(null, { status: 500 });
  }
  if (fileResponse.status >= 500) {
    fileResponse = new Response("Not Found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  // serveDir는 etag와 last-modified만 붙이고 cache-control은 두지 않는다.
  // 그러면 브라우저가 나름의 기준으로 "아직 신선하다"고 판단해
  // 서버에 물어보지도 않고 옛 파일을 쓸 수 있다.
  // 화면을 고쳐도 반영이 안 되고, 배포 후에도 옛 index.html이 남는다.
  //
  // no-cache는 "쓰지 마라"가 아니라 "쓰기 전에 반드시 물어봐라"라는 뜻이다.
  // 안 바뀌었으면 304로 끝나므로 비용은 거의 없다.
  if (!fileResponse.headers.has("cache-control")) {
    // serveDir 가 돌려주는 리다이렉트(Response.redirect)는 헤더가 잠겨 있다 — 복사본에 붙인다
    const headers = new Headers(fileResponse.headers);
    headers.set("cache-control", "no-cache");
    fileResponse = new Response(fileResponse.body, {
      status: fileResponse.status,
      statusText: fileResponse.statusText,
      headers,
    });
  }
  return fileResponse;
}

// 미분석 봉사일지 안전망 — 10분마다(lib/analysis_sweep.ts). 어디서 돌릴지는 sweepMode 가 정한다.
//   Deno Deploy 운영 → Deno.cron (배포할 때 정의를 찾아 스스로 부른다 — 모듈 맨 위에서 등록해야 찾는다.
//     Deno.cron 은 아직 불안정 API 라 deno.json 의 unstable: ["cron"] 이 켜져 있어야 한다)
//   컨테이너(애저 Container Apps, ANALYSIS_SWEEP=interval) → 앱 안 setInterval (컨테이너에서는 Deno.cron 이 돌지 않는다)
//   그 밖(로컬·미리보기·브랜치) → 끔. 같은 DB 를 여러 곳이 함께 돌면 같은 일지에 AI 를 두 번 부를 수 있다.
// 등록이 실패해도 서버는 떠야 한다 — 안전망 하나 때문에 앱 전체가 멈추면 안 된다.
const sweep = sweepMode(Deno.env);
if (sweep === "deploy-cron") {
  if (typeof Deno.cron === "function") {
    try {
      Deno.cron(SWEEP_CRON_NAME, "*/10 * * * *", async () => {
        try {
          await sweepUnanalyzed();
        } catch (error) {
          console.error("[cron] 미분석 봉사일지 안전망 실패", error);
        }
      });
    } catch (error) {
      console.error("[cron] 미분석 봉사일지 안전망 등록 실패", error);
    }
  } else {
    console.error("[cron] Deno.cron 을 쓸 수 없어 미분석 봉사일지 안전망을 등록하지 못했습니다.");
  }
} else if (sweep === "interval") {
  startIntervalSweep();
}

// 꺼질 때(Deploy 는 SIGINT 뒤 5초를 준다) 응답 뒤에 돌던 일을 잠깐 기다리고, 못 끝낸 것은 로그에 남긴다.
// 컨테이너(Container Apps)는 SIGTERM 으로 끈다 — 같은 처리. (윈도에서는 SIGTERM 을 받을 수 없어 건너뛴다)
// 처리 중인 요청은 끝까지 답한 뒤 끈다(lib/shutdown.ts).
// Deno Deploy는 Deno.serve를 그대로 인식한다. 로컬에서는 PORT(기본 8000)를 쓴다.
const server = Deno.serve({ port: Number(Deno.env.get("PORT") ?? 8000) }, handler);
const waitMs = Deno.env.get("DENO_DEPLOY") === "true"
  ? SHUTDOWN_WAIT_MS.deploy
  : SHUTDOWN_WAIT_MS.container;
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  if (signal === "SIGTERM" && Deno.build.os === "windows") continue;
  Deno.addSignalListener(signal, async () => {
    if (stopping) return;
    stopping = true;
    console.log(`[shutdown] ${signal} — 처리 중인 요청·남은 일을 기다린 뒤 종료`);
    await shutdownGracefully(server, drainBeforeExit, waitMs);
    Deno.exit(0);
  });
}
