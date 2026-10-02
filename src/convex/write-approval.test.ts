import assert from "node:assert/strict";
import test from "node:test";

import { requestInteractiveWriteApproval } from "./write-approval.js";

test("write approval fails closed without an interactive terminal", async () => {
  let prompted = false;
  await assert.rejects(
    requestInteractiveWriteApproval({
      interactive: false,
      profileName: "staging",
      target: "https://staging.example.com",
      operation: "run Convex function \"users:update\"",
      prompt: async () => {
        prompted = true;
        return true;
      },
    }),
    /requires interactive write approval/,
  );
  assert.equal(prompted, false);
});

test("write approval stops when the user declines", async () => {
  await assert.rejects(
    requestInteractiveWriteApproval({
      interactive: true,
      profileName: "uat",
      target: "Cloud deployment staging/uat",
      operation: "run Convex function \"users:update\"",
      prompt: async (message) => {
        assert.match(message, /profile "uat"/);
        assert.match(message, /Cloud deployment staging\/uat/);
        return false;
      },
    }),
    /Write cancelled/,
  );
});

test("write approval proceeds only after an affirmative prompt response", async () => {
  await assert.doesNotReject(
    requestInteractiveWriteApproval({
      interactive: true,
      profileName: "dev",
      target: "self-hosted http://127.0.0.1:3210",
      operation: "set Convex environment variable \"PAYMENT_KEY\"",
      prompt: async () => true,
    }),
  );
});
