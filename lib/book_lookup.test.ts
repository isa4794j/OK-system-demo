/**
 * ISBN 조회 테스트
 *
 *   deno task test
 *
 * 실제 API 를 부르지 않는다. fetch 를 갈아 끼워 응답 모양만 흉내낸다.
 * 키가 없어도, 인터넷이 없어도 돌아야 하는 검사다.
 *
 * [왜 감싼 모양을 두 가지로 시험하나]
 * 두 API 모두 칸 이름은 공개 문서에 있는데 감싸는 모양은 문서에 없다.
 * 그래서 book_lookup.ts 는 모양을 가정하지 않고 이름으로 찾는다.
 * 그 약속이 지켜지는지 보려고 일부러 다른 모양 두 가지를 넣어 본다.
 *
 * 오류 응답 두 가지는 실제로 받아 본 것이다(더미 키로 불러 확인).
 */
import { assertEquals, assertRejects } from "@std/assert";
import { BookLookupError, lookupByISBN } from "./book_lookup.ts";

const ISBN = "9788983921987";

Deno.env.set("NLK_API_KEY", "test-nlk");
Deno.env.set("DATA4LIBRARY_API_KEY", "test-d4l");

const real = globalThis.fetch;

/** url 이 어디로 가는지 보고 정해진 답을 준다. 답이 없으면 그 API 는 안 붙은 셈. */
function stubFetch(routes: { nlk?: unknown; d4l?: unknown; fail?: "nlk" | "d4l" }) {
  globalThis.fetch = (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const which = url.includes("nl.go.kr") ? "nlk" : "d4l";

    if (routes.fail === which) return Promise.reject(new TypeError("연결 실패"));

    const body = which === "nlk" ? routes.nlk : routes.d4l;
    if (body === undefined) return Promise.resolve(new Response("{}", { status: 200 }));
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  };
}

function restore() {
  globalThis.fetch = real;
}

/* ---------- 감싼 모양 ---------- */

Deno.test("감싼 모양이 달라도 칸 이름으로 찾는다", async () => {
  // 국중은 배열로 감싸고, 정보나루는 객체 안에 또 객체로 감쌌다고 해 본다
  stubFetch({
    nlk: {
      PAGE_NO: "1",
      TOTAL_COUNT: "1",
      docs: [{
        TITLE: "구름빵",
        AUTHOR: "백희나",
        PUBLISHER: "한솔수북",
        PUBLISH_PREDATE: "20040401",
        KDC: "813.8",
        TITLE_URL: "https://example.test/cover.jpg",
      }],
    },
    d4l: {
      response: {
        detail: [{ book: { bookname: "구름빵", description: "빵을 먹고 하늘을 나는 이야기." } }],
      },
    },
  });

  try {
    const found = await lookupByISBN(ISBN);
    assertEquals(found?.title, "구름빵");
    assertEquals(found?.author, "백희나");
    assertEquals(found?.publisher, "한솔수북");
    assertEquals(found?.published_year, 2004);
    assertEquals(found?.kdc, "813.8");
    assertEquals(found?.cover_url, "https://example.test/cover.jpg");
    assertEquals(found?.description, "빵을 먹고 하늘을 나는 이야기.");
    assertEquals(found?.sources, ["국립중앙도서관", "도서관 정보나루"]);
  } finally {
    restore();
  }
});

Deno.test("하이픈이 있어도 같은 책으로 본다", async () => {
  stubFetch({ nlk: { docs: [{ TITLE: "구름빵" }] } });
  try {
    const found = await lookupByISBN("978-89-8392-198-7");
    assertEquals(found?.isbn, ISBN);
  } finally {
    restore();
  }
});

/* ---------- 두 곳 합치기 ---------- */

Deno.test("국중에 있는 칸은 정보나루가 덮지 않는다", async () => {
  stubFetch({
    nlk: { docs: [{ TITLE: "국중 제목", AUTHOR: "국중 저자", KDC: "813.8" }] },
    d4l: {
      response: {
        detail: [{
          book: {
            bookname: "정보나루 제목",
            authors: "정보나루 저자",
            class_no: "800",
            description: "책소개",
          },
        }],
      },
    },
  });

  try {
    const found = await lookupByISBN(ISBN);
    assertEquals(found?.title, "국중 제목");
    assertEquals(found?.author, "국중 저자");
    assertEquals(found?.kdc, "813.8");
    // 국중에 없는 것만 정보나루로 채운다
    assertEquals(found?.description, "책소개");
  } finally {
    restore();
  }
});

Deno.test("국중이 못 찾으면 정보나루 것만으로 채운다", async () => {
  stubFetch({
    nlk: { PAGE_NO: "1", TOTAL_COUNT: "0", docs: [] },
    d4l: {
      response: {
        detail: [{
          book: {
            bookname: "정보나루 제목",
            authors: "정보나루 저자",
            publication_year: "2019",
            class_no: "813.8",
          },
        }],
      },
    },
  });

  try {
    const found = await lookupByISBN(ISBN);
    assertEquals(found?.title, "정보나루 제목");
    assertEquals(found?.published_year, 2019);
    assertEquals(found?.sources, ["도서관 정보나루"]);
  } finally {
    restore();
  }
});

Deno.test("한 곳이 죽어도 다른 곳이 찾았으면 그 결과를 쓴다", async () => {
  stubFetch({ fail: "nlk", d4l: { response: { detail: [{ book: { bookname: "정보나루만" } }] } } });
  try {
    const found = await lookupByISBN(ISBN);
    assertEquals(found?.title, "정보나루만");
    assertEquals(found?.sources, ["도서관 정보나루"]);
  } finally {
    restore();
  }
});

/* ---------- 없음과 실패는 다르다 ---------- */

Deno.test("둘 다 못 찾으면 없음(null)", async () => {
  stubFetch({ nlk: { TOTAL_COUNT: "0", docs: [] }, d4l: { response: { detail: [] } } });
  try {
    assertEquals(await lookupByISBN(ISBN), null);
  } finally {
    restore();
  }
});

Deno.test('정보나루의 "모르는 ISBN" 은 오류가 아니라 없음', async () => {
  // 실제로 받아 본 응답이다. 이름은 길이 탓처럼 보이지만 13자리 정상 번호에도 온다.
  stubFetch({
    nlk: { TOTAL_COUNT: "0", docs: [] },
    d4l: { response: { errCode: "isbnLengthErr", error: "ISBN을 확인해 주시기 바랍니다." } },
  });
  try {
    assertEquals(await lookupByISBN(ISBN), null);
  } finally {
    restore();
  }
});

Deno.test("키가 틀리면 없음이 아니라 auth 오류", async () => {
  // 실제로 받아 본 응답 모양이다
  stubFetch({
    nlk: { RESULT: "ERROR", ERR_CODE: "011", ERR_MESSAGE: "유효하지 않은 인증키 값입니다." },
    d4l: { response: { errCode: "authErr", error: "인증정보가 일치하지 않습니다." } },
  });

  try {
    const error = await assertRejects(() => lookupByISBN(ISBN), BookLookupError);
    assertEquals((error as BookLookupError).kind, "auth");
  } finally {
    restore();
  }
});

Deno.test("둘 다 연결이 안 되면 network 오류", async () => {
  globalThis.fetch = () => Promise.reject(new TypeError("연결 실패"));
  try {
    const error = await assertRejects(() => lookupByISBN(ISBN), BookLookupError);
    assertEquals((error as BookLookupError).kind, "network");
  } finally {
    restore();
  }
});

Deno.test("ISBN 이 10자리도 13자리도 아니면 부르지 않는다", async () => {
  let called = false;
  globalThis.fetch = () => {
    called = true;
    return Promise.resolve(new Response("{}"));
  };
  try {
    await assertRejects(() => lookupByISBN("12345"), BookLookupError);
    assertEquals(called, false);
  } finally {
    restore();
  }
});
