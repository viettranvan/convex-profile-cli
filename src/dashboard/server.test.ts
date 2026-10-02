import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";

import { createLoginServer } from "./server.js";

const deployment = { name: "sit-local", url: "http://127.0.0.1:3210", adminKey: "test-admin-key" };
let server: http.Server;
let port: number;

before(async () => {
  server = createLoginServer({ dashboardPort: 6790, deployment });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});

after(() => {
  server.close();
});

function request(headers: Record<string, string>, method = "GET"): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("login server returns the deployment to the dashboard origin", async () => {
  const res = await request({ Host: `127.0.0.1:${port}`, Origin: "http://127.0.0.1:6790" });
  assert.equal(res.status, 200);
  assert.equal(res.headers["access-control-allow-origin"], "http://127.0.0.1:6790");
  assert.deepEqual(JSON.parse(res.body), { deployments: [deployment] });
});

test("login server rejects other origins, missing origin, foreign hosts and non-GET", async () => {
  const host = `127.0.0.1:${port}`;
  for (const [headers, method] of [
    [{ Host: host, Origin: "https://evil.example" }, "GET"],
    [{ Host: host }, "GET"],
    [{ Host: `evil.example:${port}`, Origin: "http://127.0.0.1:6790" }, "GET"],
    [{ Host: host, Origin: "http://127.0.0.1:6790" }, "POST"],
  ] as const) {
    const res = await request(headers, method);
    assert.equal(res.status, 403);
    assert.ok(!res.body.includes(deployment.adminKey));
  }
});
