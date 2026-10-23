import { assertEquals } from "@std/assert";
import { shutdownGracefully } from "./shutdown.ts";

Deno.test("꺼질 때 처리 중인 요청은 끝까지 답한다(느린 요청 + 백그라운드 일)", async () => {
  let bgDone = false;
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, async () => {
    await new Promise((r) => setTimeout(r, 400));
    return new Response("끝까지");
  });
  const { port } = server.addr as Deno.NetAddr;
  const inflight = fetch(`http://127.0.0.1:${port}/`).then(async (r) => [r.status, await r.text()]);
  await new Promise((r) => setTimeout(r, 50)); // 요청이 들어간 뒤에 끈다
  const result = await shutdownGracefully(server, async () => {
    await new Promise((r) => setTimeout(r, 100));
    bgDone = true;
  }, 5000);
  assertEquals(result, "done");
  assertEquals(await inflight, [200, "끝까지"]);
  assertEquals(bgDone, true);
});

Deno.test("한도를 넘기면 기다리지 않고 timeout", async () => {
  const result = await shutdownGracefully(
    { shutdown: () => new Promise<void>(() => {}) },
    () => Promise.resolve(),
    50,
  );
  assertEquals(result, "timeout");
});
