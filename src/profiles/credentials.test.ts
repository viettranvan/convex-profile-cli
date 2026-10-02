import assert from "node:assert/strict";
import test from "node:test";

import { adminKeySource, resolveAdminKey, resolveProfile } from "./credentials.js";
import type { Config } from "./schema.js";

test("resolveAdminKey reads from env when adminKeyEnv is set", () => {
  process.env.TEST_CONVEX_ADMIN = "dev:key";
  assert.equal(
    resolveAdminKey({ url: "http://127.0.0.1:3210", adminKeyEnv: "TEST_CONVEX_ADMIN" }),
    "dev:key",
  );
  delete process.env.TEST_CONVEX_ADMIN;
});

test("resolveProfile uses defaultProfile when name omitted", () => {
  const config: Config = {
    defaultProfile: "local",
    profiles: {
      local: {
        url: "http://127.0.0.1:3210",
        adminKey: "dev:abc",
      },
    },
  };
  const resolved = resolveProfile(config);
  assert.equal(resolved.profileName, "local");
  assert.equal(resolved.url, "http://127.0.0.1:3210");
});

test("admin key source redacts values and recognizes a key saved by the old wizard", () => {
  const oldWizardValue = "dev|example-key-value";

  assert.equal(adminKeySource({ adminKeyEnv: "CONVEX_ADMIN_KEY" }), "environment variable");
  assert.equal(adminKeySource({ adminKeyEnv: oldWizardValue }), "inline key");
  assert.equal(resolveAdminKey({ adminKeyEnv: oldWizardValue }), oldWizardValue);
});

test("missing admin-key env error does not expose the variable name", () => {
  const envName = "TEST_MISSING_CONVEX_ADMIN";
  delete process.env[envName];

  assert.throws(
    () => resolveAdminKey({ adminKeyEnv: envName }),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("not set") &&
      !error.message.includes(envName),
  );
});
