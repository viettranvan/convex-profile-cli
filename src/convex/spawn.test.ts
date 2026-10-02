import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildConvexArgs, buildConvexEnv, parseConvexTableNames, resolveConvexBin } from "./spawn.js";

test("resolveConvexBin uses the bundled convex when the project has none", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cpc-convex-"));
  writeFileSync(path.join(dir, "package.json"), "{}");
  const bin = resolveConvexBin(dir);
  assert.ok(existsSync(bin), bin);
});

test("Cloud profile without a deploy key uses the deployment reference and CLI login", () => {
  assert.deepEqual(
    buildConvexArgs({ profileName: "dev-cloud", deployment: "dev", writePolicy: "allow" }, ["run", "todos:list"]),
    ["convex", "run", "todos:list", "--deployment", "dev"],
  );
});

test("Cloud deploy key scopes Convex CLI through CONVEX_DEPLOY_KEY", () => {
  assert.deepEqual(
    buildConvexArgs(
      { profileName: "dev-agent", deployment: "dev", deployKey: "scoped-deploy-key", writePolicy: "allow" },
      ["env", "list"],
    ),
    ["convex", "env", "list"],
  );
  assert.equal(
    buildConvexEnv(
      { profileName: "dev-agent", deployment: "dev", deployKey: "scoped-deploy-key", writePolicy: "allow" },
      { PATH: "/bin", CONVEX_DEPLOY_KEY: "wrong-shell-key" },
    ).CONVEX_DEPLOY_KEY,
    "scoped-deploy-key",
  );
});

test("profile target clears conflicting target variables inherited from the shell", () => {
  const env = buildConvexEnv(
    { profileName: "local", url: "http://127.0.0.1:3210", adminKey: "profile-key", writePolicy: "allow" },
    {
      PATH: "/bin",
      CONVEX_DEPLOY_KEY: "wrong-key",
      CONVEX_DEPLOYMENT: "prod/someone-else",
      CONVEX_SELF_HOSTED_URL: "https://other.example",
      CONVEX_SELF_HOSTED_ADMIN_KEY: "wrong-admin-key",
    },
  );
  assert.equal(env.CONVEX_DEPLOY_KEY, undefined);
  assert.equal(env.CONVEX_DEPLOYMENT, undefined);
  assert.equal(env.CONVEX_SELF_HOSTED_URL, undefined);
  assert.equal(env.CONVEX_SELF_HOSTED_ADMIN_KEY, undefined);
});

test("Convex table listing parser keeps one name per nonempty output line", () => {
  assert.deepEqual(
    parseConvexTableNames("\nacademicYears\r\ntrimesters\nusers\n"),
    ["academicYears", "trimesters", "users"],
  );
});

test("Self-hosted URL profile still requires and forwards its admin key", () => {
  assert.deepEqual(
    buildConvexArgs(
      { profileName: "local", url: "http://127.0.0.1:3210", adminKey: "self-hosted-key", writePolicy: "allow" },
      ["run", "todos:list"],
    ),
    [
      "convex",
      "run",
      "todos:list",
      "--url",
      "http://127.0.0.1:3210",
      "--admin-key",
      "self-hosted-key",
    ],
  );
  assert.throws(
    () => buildConvexArgs({ profileName: "local", url: "http://127.0.0.1:3210", writePolicy: "allow" }, ["env", "list"]),
    /require an admin key/,
  );
});
