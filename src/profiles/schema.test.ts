import assert from "node:assert/strict";
import test from "node:test";

import { ConfigSchema, ProfileSchema } from "./schema.js";

test("ConfigSchema supplies the write-policy default for existing profiles", () => {
  const config = ConfigSchema.parse({
    profiles: {
      local: {
        url: "http://127.0.0.1:3210",
        adminKeyEnv: "CONVEX_ADMIN_KEY",
      },
    },
  });

  assert.equal(config.profiles.local.writePolicy, "require-allow-write");
});

test("ProfileSchema preserves the selected write policy", () => {
  const profile = ProfileSchema.parse({
    url: "https://staging.example.com",
    adminKeyEnv: "CONVEX_ADMIN_KEY_STAGING",
    writePolicy: "read-only",
  });

  assert.equal(profile.writePolicy, "read-only");
});

test("Cloud deployment profiles may rely on the Convex CLI login", () => {
  const profile = ProfileSchema.parse({ deployment: "dev" });
  assert.equal(profile.deployment, "dev");
  assert.equal(profile.adminKey, undefined);
  assert.equal(profile.adminKeyEnv, undefined);
  assert.throws(
    () => ProfileSchema.parse({ url: "http://127.0.0.1:3210" }),
    /Self-hosted URL profiles need adminKey or adminKeyEnv/,
  );
});

