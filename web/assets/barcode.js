/**
 * ISBN 바코드 읽기 — 카메라로 책 뒤표지를 찍는다
 *
 * 책 뒤에 붙은 바코드는 EAN-13 이고, ISBN 인 것은 978 이나 979 로 시작한다.
 * 그 두 가지만 받는다. 다른 바코드(과자 봉지 같은 것)가 잡혀도 무시하고 계속 본다.
 *
 * [두 갈래로 읽는다]
 *   1. 브라우저에 BarcodeDetector 가 있으면 그것으로. 안드로이드 크롬이 여기 든다.
 *      브라우저가 직접 읽으니 받아 올 것이 없고 제일 빠르다.
 *   2. 없으면 ZXing 을 그때 한 번 불러다 쓴다. 아이폰 사파리와 데스크톱이 여기 든다.
 *      우리 서버에 넣어 둔 파일이다(web/assets/vendor). 바깥에서 받아 오지 않는다 —
 *      배포된 화면이 남의 CDN 이 살아 있는지에 매이면 안 되고, 같은 주소의 내용이
 *      조용히 바뀌는 것도 곤란하다. 다만 328KB 라 처음부터 내려보내지는 않는다.
 *      쓰지 않는 사람에게까지 지울 이유가 없어 [스캔]을 누른 순간에 받는다.
 *
 * 새 서비스도 키도 쓰지 않는다. 정적 파일 하나를 읽어 브라우저 안에서 푼다.
 * 못 불러오면 조용히 접고 손으로 넣게 둔다.
 *
 * [카메라는 안 남긴다]
 * 창을 닫는 모든 길에서 스트림을 끈다. 껐는지 아닌지 헷갈리지 않게 stop() 한 곳에 모은다.
 * 카메라가 켜진 채 남으면 사람이 알아채기 어렵고, 그건 사고다.
 */

/** ISBN 바코드. 978·979 로 시작하는 13자리다. */
const ISBN_EAN = /^97[89]\d{10}$/;

/**
 * ZXing 을 둔 곳. 판 번호가 파일 이름에 들어 있어 캐시가 옛것을 잡고 있을 일이 없다.
 * 어디서 받은 무엇인지는 web/assets/vendor/README.md 에 적어 두었다.
 */
const ZXING_URL = "/assets/vendor/zxing-0.21.3.min.js";

/** 한 번 받으면 다시 받지 않는다 */
let zxingLoading = null;

/**
 * 카메라를 쓸 수 있는 자리인가. [스캔] 버튼을 보일지 정하는 데 쓴다.
 *
 * https 나 localhost 가 아니면 브라우저가 카메라를 아예 안 준다.
 * 그 자리에서는 버튼을 보여 봐야 눌러도 안 되므로 처음부터 감춘다.
 */
export function scanSupported() {
  return Boolean(navigator.mediaDevices?.getUserMedia) && globalThis.isSecureContext;
}

function loadZxing() {
  if (globalThis.ZXing) return Promise.resolve(globalThis.ZXing);
  if (zxingLoading) return zxingLoading;

  zxingLoading = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = ZXING_URL;
    script.onload = () => resolve(globalThis.ZXing);
    script.onerror = () => {
      zxingLoading = null;
      reject(new Error("바코드 읽기 도구를 불러오지 못했습니다."));
    };
    document.head.append(script);
  });
  return zxingLoading;
}

/** 브라우저가 직접 읽을 수 있는가. 형식까지 물어본다 — 있다고 다 읽는 것은 아니다. */
async function nativeDetector() {
  if (!("BarcodeDetector" in globalThis)) return null;
  try {
    const formats = await globalThis.BarcodeDetector.getSupportedFormats();
    if (!formats.includes("ean_13")) return null;
    return new globalThis.BarcodeDetector({ formats: ["ean_13"] });
  } catch {
    return null;
  }
}

/* ---------- 창 ---------- */

function buildModal() {
  const modal = document.createElement("div");
  modal.className = "modal";

  const backdrop = document.createElement("div");
  backdrop.className = "modal__backdrop";

  const dialog = document.createElement("div");
  dialog.className = "modal__dialog modal__dialog--narrow scan";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", "ISBN 바코드 스캔");

  const title = document.createElement("h3");
  title.className = "card__title";
  title.textContent = "책 뒤표지의 바코드를 비춰 주세요";

  const video = document.createElement("video");
  video.className = "scan__video";
  video.playsInline = true;
  video.muted = true;

  // 어디에 맞추면 되는지 보여 주는 틀. 없으면 화면 가득 이리저리 움직이게 된다.
  const frame = document.createElement("div");
  frame.className = "scan__frame";

  const box = document.createElement("div");
  box.className = "scan__box";
  box.append(video, frame);

  const hint = document.createElement("p");
  hint.className = "form__hint";
  hint.textContent = "숫자 아래 줄무늬가 틀 안에 가득 차게 하면 잘 읽힙니다.";

  const actions = document.createElement("div");
  actions.className = "modal__actions modal__actions--end";

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn";
  cancel.textContent = "취소";
  actions.append(cancel);

  dialog.append(title, box, hint, actions);
  modal.append(backdrop, dialog);
  document.body.append(modal);

  return { modal, backdrop, video, hint, cancel };
}

/**
 * 카메라를 켜고 ISBN 바코드를 기다린다.
 *
 *   찾음        "9788953527058"
 *   취소·못 읽음 null
 *
 * 오류(카메라 거부, 도구 못 받음)는 던지지 않고 null 로 돌려준다.
 * 부르는 쪽은 "안 되면 손으로 넣는다" 하나만 하면 된다 — 갈래를 늘릴 이유가 없다.
 * 다만 왜 안 됐는지는 hint 줄에 잠깐 보여 주고 닫는다.
 */
export async function scanIsbn() {
  if (!scanSupported()) return null;

  const parts = buildModal();
  let stream = null;
  let stopped = false;
  /** ZXing 을 쓰는 갈래에서 읽기를 멈추는 함수. 브라우저가 직접 읽으면 없다. */
  let stopReader = null;

  /** 창을 닫는 모든 길이 여기로 온다. 카메라는 여기서만 끈다. */
  const stop = () => {
    stopped = true;
    stopReader?.();
    stopReader = null;
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
    parts.modal.remove();
    document.removeEventListener("keydown", onKey);
  };

  function onKey(event) {
    if (event.key === "Escape") finish(null);
  }

  let settle;
  const done = new Promise((resolve) => {
    settle = resolve;
  });
  const finish = (value) => {
    if (stopped) return;
    stop();
    settle(value);
  };

  parts.cancel.addEventListener("click", () => finish(null));
  parts.backdrop.addEventListener("click", () => finish(null));
  document.addEventListener("keydown", onKey);

  try {
    // 뒷면 카메라를 부탁한다. 없으면 브라우저가 알아서 다른 것을 준다.
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
    });
  } catch {
    parts.hint.textContent = "카메라를 쓸 수 없습니다. ISBN 을 손으로 넣어 주세요.";
    setTimeout(() => finish(null), 1800);
    return done;
  }

  parts.video.srcObject = stream;
  await parts.video.play().catch(() => {});

  const detector = await nativeDetector();
  if (detector) watchNative(detector, parts.video, finish, () => stopped);
  else {
    try {
      stopReader = await watchZxing(parts.video, stream, finish, () => stopped);
    } catch (error) {
      parts.hint.textContent = `${error.message} ISBN 을 손으로 넣어 주세요.`;
      setTimeout(() => finish(null), 2200);
    }
  }

  return done;
}

/** 브라우저가 직접 읽는 갈래. 프레임마다 한 번씩 물어본다. */
function watchNative(detector, video, finish, isStopped) {
  const tick = async () => {
    if (isStopped()) return;
    try {
      for (const found of await detector.detect(video)) {
        if (ISBN_EAN.test(found.rawValue)) {
          finish(found.rawValue);
          return;
        }
      }
    } catch {
      // 한 프레임 못 읽는 것은 흔한 일이다. 다음 프레임에서 다시 본다.
    }
    // rAF 는 창이 안 보일 때 안 돌아 멈춘 것처럼 보인다. 타이머로 돈다.
    setTimeout(tick, 200);
  };
  tick();
}

/**
 * ZXing 을 받아 읽는 갈래. 아이폰 사파리와 데스크톱이 여기 든다.
 * 읽기를 멈추는 함수를 돌려준다 — 창을 닫는 쪽에서 불러야 한다.
 */
async function watchZxing(video, stream, finish, isStopped) {
  const ZXing = await loadZxing();
  if (isStopped()) return null;

  // 찾을 형식을 EAN-13 하나로 못 박는다. 넓게 두면 엉뚱한 바코드에서 시간을 쓴다.
  const hints = new Map([
    [ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.EAN_13]],
  ]);
  const reader = new ZXing.BrowserMultiFormatReader(hints);

  reader.decodeFromStream(stream, video, (result) => {
    if (isStopped()) return;
    const text = result?.getText?.();
    // 다른 바코드(과자 봉지 같은 것)가 잡히면 그냥 넘긴다. 다음 프레임에서 다시 본다.
    if (text && ISBN_EAN.test(text)) finish(text);
    // 이 콜백은 계속 도는 것이 정상이라 멈추는 일은 stop() 이 맡는다.
  }).catch(() => {
    // 카메라가 도중에 끊기는 일이 있다. 창을 닫는 것으로 충분하다.
  });

  return () => reader.reset();
}
