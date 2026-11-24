import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createServer } from "node:net";
import { createServer as httpServer } from "node:http";
import { ServiceManager, localApi } from "../src/launcher/service-manager";
import { detectPython } from "../src/config/python-detect";
import { profile } from "./fixtures";

test("非 Helper HTTP 占用不可判定为 stopped，也不可 spawn 或停止", async () => {
  const server = httpServer((_req, res) => {
    res.statusCode = 404;
    res.end("other service");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const p = profile(path.join(os.tmpdir(), "not-a-real-app"));
    p.port = (server.address() as { port: number }).port;
    const manager = new ServiceManager(p, "2.0.0");
    assert.equal(await manager.version(), undefined);
    assert.equal(await manager.state(), "external");
    await assert.rejects(manager.start(), /端口/);
    await assert.rejects(manager.stop(), /外部/);
    manager.dispose();
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("外部服务可用但禁止停止，未向外部服务发送任何写请求", async () => {
  let posts = 0;
  const server = httpServer((req, res) => {
    if (req.method !== "GET") posts++;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        version: "99.0.0",
        pluginUpgradeRequired: true,
        serviceIdentity: { instanceId: "external", pid: 1 },
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const p = profile(path.join(os.tmpdir(), "unused-ielts-fixture"));
    p.port = (server.address() as { port: number }).port;
    const service = new ServiceManager(p, "2.0.0");
    assert.equal(await service.state(), "external");
    await service.start();
    await assert.rejects(service.stop(), /外部/);
    assert.equal(posts, 0);
    service.dispose();
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
test("临时程序启动→实例健康就绪→显式 route POST→stdin EOF 停服", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ielts-lifecycle-"));
  const p = profile(root);
  const reserve = createServer();
  await new Promise<void>((r) => reserve.listen(0, "127.0.0.1", r));
  p.port = (reserve.address() as { port: number }).port;
  await new Promise<void>((r) => reserve.close(() => r()));
  const py = await detectPython([process.env.IELTS_TEST_PYTHON || "python"]);
  p.pythonPath = py.path;
  const terminal = path.join(p.appRoot, "releases/4.0.0/terminal");
  await fs.mkdir(terminal, { recursive: true });
  await fs.mkdir(p.dataDir, { recursive: true });
  await fs.mkdir(p.studyRoot, { recursive: true });
  await fs.writeFile(
    path.join(p.appRoot, "current.json"),
    JSON.stringify({ version: "4.0.0" }),
  );
  await fs.writeFile(
    path.join(terminal, "IELTS_Vocab_Helper.py"),
    `import http.server,json,os,sys,threading\nport=int(sys.argv[sys.argv.index('--port')+1]); instance=sys.argv[sys.argv.index('--plugin-instance')+1]\nclass Handler(http.server.BaseHTTPRequestHandler):\n def log_message(self,*args): pass\n def do_GET(self):\n  value={'version':'4.0.0','pluginVersionReceived':os.environ['IELTS_PLUGIN_VERSION'],'serviceIdentity':{'instanceId':instance,'pid':os.getpid(),'port':port,'dataRoot':os.environ['IELTS_DATA_DIR'],'vaultRoot':os.environ['IELTS_VAULT']}}\n  self.send_response(200); self.end_headers(); self.wfile.write(json.dumps(value).encode())\n def do_POST(self):\n  data=json.loads(self.rfile.read(int(self.headers['Content-Length'])))\n  self.send_response(200); self.end_headers(); self.wfile.write(json.dumps({'ok':True,'topic_id':data['topic_id']}).encode())\nserver=http.server.HTTPServer(('127.0.0.1',port),Handler)\nthreading.Thread(target=server.serve_forever,daemon=True).start()\nsys.stdin.buffer.read()\nserver.shutdown();server.server_close()\n`,
  );
  const service = new ServiceManager(p, "2.0.0");
  try {
    await service.start();
    assert.equal(await service.state(), "owned");
    const version = await service.version();
    assert.equal(version?.serviceIdentity?.dataRoot, p.dataDir);
    const result = await localApi<{ ok: boolean; topic_id: string }>(
      p.port,
      "/api/vocabulary/route-inbox",
      { topic_id: "T02" },
    );
    assert.equal(result.topic_id, "T02");
    await service.stop();
    assert.equal(await service.state(), "stopped");
  } finally {
    service.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});
