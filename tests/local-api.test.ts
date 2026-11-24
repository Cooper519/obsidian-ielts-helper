import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { localApi } from "../src/launcher/service-manager";
async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
test("renderer fetch 不可用时，健康 GET 与显式 JSON POST 仍通过 Node 回环 HTTP，无预检或 Origin", async () => {
  const observed: {
    method: string | undefined;
    origin: string | undefined;
    body: string;
  }[] = [];
  const server = createServer((req, res) => {
    let text = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (text += chunk));
    req.on("end", () => {
      observed.push({
        method: req.method,
        origin: req.headers.origin,
        body: text,
      });
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify(
          req.method === "GET"
            ? { version: "4.0.0" }
            : { ok: true, topic_id: JSON.parse(text).topic_id },
        ),
      );
    });
  });
  const port = await listen(server);
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw Error("模拟 app://obsidian.md renderer CORS 失败");
  };
  try {
    assert.equal(
      (await localApi<{ version: string }>(port, "/api/version")).version,
      "4.0.0",
    );
    assert.equal(
      (
        await localApi<{ topic_id: string }>(
          port,
          "/api/vocabulary/route-inbox",
          { topic_id: "T02" },
        )
      ).topic_id,
      "T02",
    );
    assert.deepEqual(observed, [
      { method: "GET", origin: undefined, body: "" },
      { method: "POST", origin: undefined, body: '{"topic_id":"T02"}' },
    ]);
  } finally {
    globalThis.fetch = original;
    await close(server);
  }
});
test("本地 HTTP 拒绝跳转、非成功状态和非法 JSON，不请求 Location", async () => {
  let targetHits = 0;
  const target = createServer((_req, res) => {
    targetHits++;
    res.end("{}");
  });
  const targetPort = await listen(target);
  const server = createServer((req, res) => {
    if (req.url === "/api/redirect") {
      res.writeHead(302, { Location: `http://127.0.0.1:${targetPort}/target` });
      res.end();
    } else if (req.url === "/api/error") {
      res.statusCode = 401;
      res.end("{}");
    } else res.end("非 JSON");
  });
  const port = await listen(server);
  try {
    await assert.rejects(localApi(port, "/api/redirect"), /302/);
    assert.equal(targetHits, 0);
    await assert.rejects(localApi(port, "/api/error"), /401/);
    await assert.rejects(localApi(port, "/api/invalid"));
  } finally {
    await close(server);
    await close(target);
  }
});
test("本地 HTTP 总期限覆盖一直不响应的连接，拒绝非本地路径输入", async () => {
  const server = createServer(() => {});
  const port = await listen(server);
  try {
    await assert.rejects(localApi(port, "/api/hang"), /超时/);
    await assert.rejects(
      localApi(port, "http://example.com/api/version"),
      /路径/,
    );
    await assert.rejects(localApi(port, "//example.com/api/version"), /路径/);
  } finally {
    await close(server);
  }
});
