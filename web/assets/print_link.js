/**
 * 인쇄 화면 열기 — 새 창(탭)으로 /print 를 연다. 막히면 이 창에서 연다.
 * 무엇을 찍을지는 print.html 머리 주석.
 */
export function openPrint(query) {
  const url = `/print?${new URLSearchParams(query)}`;
  const opened = globalThis.open(url, "_blank");
  if (!opened) location.assign(url);
}
