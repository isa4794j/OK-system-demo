# vendor — 남이 만든 파일을 그대로 둔 자리

여기 있는 것은 우리가 쓴 코드가 아니다. 고치지 않는다.
판을 올릴 일이 있으면 아래 방법으로 통째로 새로 받고, 이 문서의 판 번호와
해시를 함께 고친다.

바깥에서 실행 시점에 받아 오지 않고 저장소에 넣어 두는 이유:

- 배포된 화면이 바깥 CDN 이 살아 있는지에 매이지 않는다.
- 어느 날 같은 주소의 내용이 조용히 바뀌는 일이 없다.
- 센터 망에서 바깥 주소가 막혀 있어도 동작한다.

## zxing-0.21.3.min.js

바코드(EAN-13) 읽기. `web/assets/barcode.js` 가 [스캔]을 누른 순간에만 불러온다
(328KB 라 처음부터 내려보내지 않는다). 브라우저에 `BarcodeDetector` 가 있으면
이 파일은 아예 받지 않는다 — 안드로이드 크롬이 그렇다.

| | |
| --- | --- |
| 이름 | [@zxing/library](https://github.com/zxing-js/library) |
| 판 | 0.21.3 |
| 라이선스 | MIT |
| 받은 곳 | `https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js` |
| sha256 | `d7cc8f69dd70bdcf3ac00c9ae572bf2acb9f4132ba379c72df842e4db918652d` |
| 전역 이름 | `ZXing` (UMD) |

다시 받으려면:

```
deno eval 'const r = await fetch("https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js"); await Deno.writeTextFile("web/assets/vendor/zxing-0.21.3.min.js", await r.text());'
```

받은 뒤 해시가 위와 같은지 본다:

```
deno eval 'const t = await Deno.readTextFile("web/assets/vendor/zxing-0.21.3.min.js"); console.log([...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))].map((b) => b.toString(16).padStart(2, "0")).join(""));'
```
