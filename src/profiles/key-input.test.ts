import assert from "node:assert/strict";
import test from "node:test";

import { parseAdminKeyInput } from "./key-input.js";

test("parseAdminKeyInput distinguishes a direct key from an env reference", () => {
  assert.deepEqual(parseAdminKeyInput("dev:example-key"), {
    adminKey: "dev:example-key",
  });
  assert.deepEqual(parseAdminKeyInput("env:CONVEX_ADMIN_KEY"), {
    adminKeyEnv: "CONVEX_ADMIN_KEY",
  });
  assert.throws(() => parseAdminKeyInput("env:"), /variable name after env:/);
});
