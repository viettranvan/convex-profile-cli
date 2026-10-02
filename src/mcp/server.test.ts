import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import {
  buildMcpArgs,
  createSelfHostedMcpEnvFile,
  createWriteApprovalGuard,
  decideMcpToolCall,
  emptyDataPage,
  extractMcpTableNames,
  filterStatusResult,
  isProfileDeploymentSelector,
  isReadOnlyMcpTool,
} from "./server.js";
import type { ServerContext } from "@modelcontextprotocol/server";

test("MCP cloud profile selects its deployment and project directory", () => {
  assert.deepEqual(
    buildMcpArgs({
      profileName: "dev-cloud",
      deployment: "dev/viettran",
      projectDir: "/work/app",
      writePolicy: "allow",
    }),
    ["convex", "mcp", "start", "--deployment", "dev/viettran", "--project-dir", "/work/app"],
  );
});

test("MCP Cloud deploy-key profile lets the key scope the deployment", () => {
  assert.deepEqual(
    buildMcpArgs({
      profileName: "dev-key",
      deployment: "dev/viettran",
      deployKey: "scoped-key",
      writePolicy: "require-allow-write",
    }),
    ["convex", "mcp", "start"],
  );
});

test("MCP self-hosted profile passes URL and admin key", () => {
  const credentials = {
    profileName: "local",
    url: "http://127.0.0.1:3210",
    adminKey: "local-secret",
    writePolicy: "allow" as const,
  };
  assert.deepEqual(
    buildMcpArgs(credentials, "/tmp/convex-profile-mcp/profile.env"),
    ["convex", "mcp", "start", "--env-file", "/tmp/convex-profile-mcp/profile.env"],
  );
  assert.throws(() => buildMcpArgs(credentials), /private --env-file/);
  assert.equal(JSON.stringify(buildMcpArgs(credentials, "/tmp/profile.env")).includes("local-secret"), false);
});

test("self-hosted MCP credentials use a private temporary env file", async () => {
  const envFile = await createSelfHostedMcpEnvFile({
    profileName: "local",
    url: "http://127.0.0.1:3210",
    adminKey: "local-secret",
    writePolicy: "allow",
  });
  try {
    const file = await fs.stat(envFile.path);
    const content = await fs.readFile(envFile.path, "utf8");
    assert.equal(file.mode & 0o777, 0o600);
    assert.match(content, /CONVEX_SELF_HOSTED_URL=/);
    assert.match(content, /CONVEX_SELF_HOSTED_ADMIN_KEY=/);
    assert.equal(content.includes("local-secret"), true);
  } finally {
    await envFile.cleanup();
  }
});

test("read-only MCP disables write tools and still exposes one-off read queries", () => {
  assert.deepEqual(
    buildMcpArgs({
      profileName: "staging",
      deployment: "staging",
      writePolicy: "read-only",
    }),
    ["convex", "mcp", "start", "--deployment", "staging", "--disable-tools", "run,envSet,envRemove"],
  );
  assert.equal(isReadOnlyMcpTool("runOneoffQuery"), true);
  assert.equal(isReadOnlyMcpTool("run"), false);
  assert.equal(isReadOnlyMcpTool("envRemove"), false);
});

test("MCP tool-call policy fails closed without an approval", () => {
  assert.equal(decideMcpToolCall("allow", "run"), "forward");
  assert.equal(decideMcpToolCall("require-allow-write", "data"), "forward");
  assert.equal(decideMcpToolCall("require-allow-write", "run"), "request-approval");
  assert.equal(decideMcpToolCall("require-allow-write", "run", "approved"), "forward");
  assert.equal(decideMcpToolCall("require-allow-write", "envRemove", "declined"), "deny");
  assert.equal(decideMcpToolCall("require-allow-write", "envSet", "unsupported"), "deny");
  assert.equal(decideMcpToolCall("read-only", "runOneoffQuery"), "forward");
  assert.equal(decideMcpToolCall("read-only", "run", "approved"), "deny");
});

test("modern MCP approval is signed, bound to exact tool arguments, and one-use", async () => {
  const guard = createWriteApprovalGuard({ profileName: "staging" });
  const makeContext = (state?: unknown) => ({
    sessionId: "test-session",
    mcpReq: {
      method: "tools/call",
      requestState: () => state,
    },
  }) as unknown as ServerContext;
  const originalArgs = { name: "PAYMENT_API_KEY", value: "secret-value", nested: { b: 2, a: 1 } };
  assert.equal(guard.consume(makeContext(), "envSet", originalArgs), false);
  const wireState = await guard.mint(makeContext(), "envSet", originalArgs);
  assert.ok(wireState);
  assert.equal(wireState.includes("secret-value"), false);
  await assert.rejects(() => guard.verify(`${wireState}tampered`, makeContext()));

  const echoedContext = makeContext(await guard.verify(wireState, makeContext()));
  assert.equal(
    guard.consume(echoedContext, "envSet", { nested: { a: 1, b: 2 }, value: "secret-value", name: "PAYMENT_API_KEY" }),
    true,
  );
  assert.equal(guard.consume(echoedContext, "envSet", originalArgs), false);

  const changedCallState = await guard.mint(makeContext(), "envSet", originalArgs);
  assert.ok(changedCallState);
  const changedCallContext = makeContext(await guard.verify(changedCallState, makeContext()));
  assert.equal(
    guard.consume(changedCallContext, "envSet", { ...originalArgs, value: "different-value" }),
    false,
  );
});

test("table preflight reads structured table names and recognizes empty data pages", () => {
  assert.deepEqual(
    extractMcpTableNames({ structuredContent: { tables: { trimesters: {}, users: {} } }, content: [] }),
    ["trimesters", "users"],
  );
  assert.equal(
    emptyDataPage({ structuredContent: { page: [], isDone: true }, content: [] }),
    true,
  );
  assert.equal(
    emptyDataPage({ content: [
      { type: "text", text: "Resolved the requested table name." },
      { type: "text", text: JSON.stringify({ page: [] }) },
    ] }),
    true,
  );
  assert.deepEqual(
    extractMcpTableNames({ content: [
      { type: "text", text: "Table inventory follows." },
      { type: "text", text: JSON.stringify({ tables: { trimesters: {} } }) },
    ] }),
    ["trimesters"],
  );
  assert.throws(() => extractMcpTableNames({ content: [{ type: "text", text: "not JSON" }] }));
});

test("profile-bound MCP accepts only its configured deployment selector and project", () => {
  const encode = (projectDir: string, deployment: unknown) =>
    `deploymentSelector:${Buffer.from(JSON.stringify({ projectDir, deployment })).toString("base64")}`;
  const credentials = {
    profileName: "dev-cloud",
    deployment: "dev/viettran",
    projectDir: "/work/app",
    writePolicy: "require-allow-write" as const,
  };

  assert.equal(
    isProfileDeploymentSelector(
      encode("/work/app", { kind: "deploymentSelector", selector: "dev/viettran" }),
      credentials,
    ),
    true,
  );
  assert.equal(
    isProfileDeploymentSelector(
      encode("/work/app", { kind: "prod" }),
      credentials,
    ),
    false,
  );
  assert.equal(
    isProfileDeploymentSelector(
      encode("/other/project", { kind: "deploymentSelector", selector: "dev/viettran" }),
      credentials,
    ),
    false,
  );
});

test("profile-bound status output exposes only the selected deployment", () => {
  const encode = (deployment: unknown) =>
    `deploymentSelector:${Buffer.from(JSON.stringify({
      projectDir: "/work/app",
      deployment,
    })).toString("base64")}`;
  const credentials = {
    profileName: "dev-cloud",
    deployment: "dev/viettran",
    projectDir: "/work/app",
    writePolicy: "require-allow-write" as const,
  };
  const result = filterStatusResult(
    {
      structuredContent: {
        availableDeployments: [
          {
            kind: "deploymentSelector",
            deploymentSelector: encode({ kind: "deploymentSelector", selector: "dev/viettran" }),
            url: "https://dev.example.convex.cloud",
          },
          {
            kind: "prod",
            deploymentSelector: encode({ kind: "prod" }),
            url: "https://prod.example.convex.cloud",
          },
        ],
      },
      content: [],
    } as Parameters<typeof filterStatusResult>[0],
    credentials,
  );

  const output = result.structuredContent as { availableDeployments: Array<{ kind: string }> };
  assert.equal(output.availableDeployments.length, 1);
  assert.equal(output.availableDeployments[0].kind, "deploymentSelector");
});

test("self-hosted and deploy-key profiles accept only the scoped MCP selector", () => {
  const encode = (projectDir: string, deployment: unknown) =>
    `unspecified:${Buffer.from(JSON.stringify({ projectDir, deployment })).toString("base64")}`;

  assert.equal(
    isProfileDeploymentSelector(
      encode("/work/local", { kind: "unspecified" }),
      {
        profileName: "local",
        url: "http://127.0.0.1:3210",
        adminKey: "secret",
        projectDir: "/work/local",
        writePolicy: "allow",
      },
    ),
    true,
  );
  assert.equal(
    isProfileDeploymentSelector(
      encode("/work/app", { kind: "unspecified" }),
      {
        profileName: "dev-key",
        deployment: "dev/viettran",
        deployKey: "scoped-key",
        projectDir: "/work/app",
        writePolicy: "allow",
      },
    ),
    true,
  );
});
