/**
 * 공개 개인정보 처리방침 — GET /api/public/privacy (로그인 없이)
 * 글은 서버 설정에서 온다({센터} 는 서버가 채워 보낸다).
 */
import { renderPolicyDoc } from "./doc_render.js";

const paper = document.getElementById("paper");

document.getElementById("p-print").addEventListener("click", () => globalThis.print());

// 같은 창에서 연다 — [← 뒤로]는 온 화면(로그인 등)으로. 주소로 바로 왔으면 로그인 화면으로.
document.getElementById("p-back").addEventListener("click", () => {
  const fromHere = document.referrer && new URL(document.referrer).origin === location.origin;
  if (fromHere && history.length > 1) history.back();
  else location.assign("/login");
});

try {
  const response = await fetch("/api/public/privacy");
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `서버 오류 (HTTP ${response.status})`);
  document.getElementById("p-center").textContent = payload.center;
  document.title = `${payload.policy.title} · ${payload.center}`;
  paper.replaceChildren(renderPolicyDoc(payload.policy, { staffNotice: true }));
} catch (error) {
  const p = document.createElement("p");
  p.className = "paper__state paper__state--error";
  p.textContent = error instanceof TypeError ? "서버에 연결하지 못했습니다. 잠시 뒤 새로고침해 주세요." : error.message;
  paper.replaceChildren(p);
}
