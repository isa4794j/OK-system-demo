/**
 * 데이터 스냅샷 — 탭을 두 번째 열 때부터 바로 보이게
 *
 * [왜 파일이 아니라 데이터를 저장하나]
 * 서비스워커로 파일을 캐시하면 빨라지지만, 한 번 잘못 캐시되면 고친 화면이
 * 폰에 영영 안 온다. 폰에서는 앱을 지웠다 까는 것 말고는 빠져나올 길이 없다.
 * 그래서 코드는 늘 서버에서 새로 받고, 대신 마지막으로 성공한 응답만 저장한다.
 * 잘못돼도 다음 요청이 덮어쓴다 — 눌어붙지 않는다.
 *
 * [서버가 늘 이긴다]
 * 스냅샷은 보여 주기용이다. 탭을 열면 바로 그리고, 동시에 서버에 묻고,
 * 답이 오면 조용히 갈아 끼운다. 등록·수정은 스냅샷을 건드리지 않고
 * 반드시 서버를 다녀온다.
 *
 * [남의 데이터가 남지 않게]
 * 계정마다 열쇠를 나눈다. 로그아웃하거나 다른 사람이 로그인하면 전부 지운다.
 * 공용 기기에서 앞사람 일정이 잠깐이라도 비치면 안 된다.
 *
 * localStorage 를 쓴다. IndexedDB 는 이만한 양에 과하고, 비동기라
 * "탭을 열자마자 그린다" 는 목적에 오히려 방해가 된다.
 */

const PREFIX = "ok.m.";

/** 이 열쇠들이 누구 것인지. 계정이 바뀌면 전부 지운다. */
const OWNER_KEY = `${PREFIX}owner`;

/** 이만큼 지나면 "오래됐다" 고 본다. 하루면 일정도 일지도 바뀌었을 만하다. */
const STALE_MS = 24 * 60 * 60 * 1000;

function safe(run, fallback = null) {
  try {
    return run();
  } catch {
    // 사파리 비공개 모드나 저장 공간이 꽉 찬 경우. 스냅샷은 있으면 좋은 것이지
    // 없으면 안 되는 것이 아니므로 조용히 없는 셈 친다.
    return fallback;
  }
}

/**
 * 이 기기에 담긴 것이 누구 것인지 확인하고, 다르면 전부 지운다.
 * 앱이 뜰 때 한 번, 로그인한 사람을 안 뒤에 부른다.
 */
export function claimFor(staffId) {
  safe(() => {
    if (localStorage.getItem(OWNER_KEY) === staffId) return;
    clearAll();
    localStorage.setItem(OWNER_KEY, staffId);
  });
}

/** 로그아웃·계정 전환. 남김없이 지운다. */
export function clearAll() {
  safe(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(PREFIX)) localStorage.removeItem(key);
    }
  });
}

/**
 * 저장된 것을 읽는다. 없으면 null.
 * 함께 담아 둔 저장 시각으로 "오래됐는지" 를 알려 준다.
 */
export function read(name) {
  return safe(() => {
    const raw = localStorage.getItem(PREFIX + name);
    if (!raw) return null;

    const box = JSON.parse(raw);
    if (!box || typeof box.at !== "number") return null;

    return {
      data: box.data,
      at: box.at,
      stale: Date.now() - box.at > STALE_MS,
    };
  });
}

/** 서버에서 온 것을 담아 둔다. 실패해도 화면은 그대로 돈다. */
export function write(name, data) {
  safe(() => {
    localStorage.setItem(PREFIX + name, JSON.stringify({ at: Date.now(), data }));
  });
}

/** "9월 10일 15:20에 받은 것" 처럼 사람 말로. 오래된 화면임을 알릴 때 쓴다. */
export function whenText(at) {
  const then = new Date(at);
  const month = then.getMonth() + 1;
  const day = then.getDate();
  const hour = String(then.getHours()).padStart(2, "0");
  const minute = String(then.getMinutes()).padStart(2, "0");
  return `${month}월 ${day}일 ${hour}:${minute}`;
}
