import assert from "node:assert/strict";
import test from "node:test";

import {
  assertDestructiveConfirmation,
  assertWritePolicy,
  classifyConvexInvocation,
  requiresWriteApproval,
} from "./write-policy.js";

test("read-only profile allows recognized reads and inline queries", () => {
  for (const [command, args] of [
    ["data", ["users"]],
    ["env", ["list"]],
    ["run", ["--inline-query", "return 1"]],
    ["passthrough", ["function-spec"]],
  ] as const) {
    assert.doesNotThrow(() => assertWritePolicy({
      policy: "read-only",
      invocation: classifyConvexInvocation(command, [...args], "staging"),
      writeApproved: false,
    }));
  }
});

test("read-only profile blocks run even when approval is supplied", () => {
  const invocation = classifyConvexInvocation("run", ["users:delete", "{}"], "staging");
  assert.throws(
    () => assertWritePolicy({ policy: "read-only", invocation, writeApproved: false }),
    /read-only/,
  );
  assert.throws(
    () => assertWritePolicy({ policy: "read-only", invocation, writeApproved: true }),
    /read-only/,
  );
});

test("require-allow-write flags writes for interactive approval", () => {
  for (const invocation of [
    classifyConvexInvocation("run", ["users:update", "{}"], "dev"),
    classifyConvexInvocation("passthrough", ["some-future-command"], "dev"),
  ]) {
    assert.equal(requiresWriteApproval("require-allow-write", invocation), true);
    assert.throws(
      () => assertWritePolicy({ policy: "require-allow-write", invocation, writeApproved: false }),
      /interactive write approval/,
    );
    assert.doesNotThrow(() => assertWritePolicy({
      policy: "require-allow-write",
      invocation,
      writeApproved: true,
    }));
  }
  assert.equal(
    requiresWriteApproval("require-allow-write", classifyConvexInvocation("data", ["users"], "dev")),
    false,
  );
});

test("env remove requires its exact variable confirmation", () => {
  const invocation = classifyConvexInvocation("env", ["remove", "API_SECRET"], "staging");
  assert.throws(
    () => assertWritePolicy({
      policy: "allow",
      invocation,
      writeApproved: false,
      confirmDestructive: "OTHER_SECRET",
    }),
    /--confirm-destructive API_SECRET/,
  );
  assert.throws(
    () => assertDestructiveConfirmation(invocation, "OTHER_SECRET"),
    /--confirm-destructive API_SECRET/,
  );
  assert.doesNotThrow(() => assertDestructiveConfirmation(invocation, "API_SECRET"));
  assert.doesNotThrow(() => assertWritePolicy({
    policy: "allow",
    invocation,
    writeApproved: false,
    confirmDestructive: "API_SECRET",
  }));
});

test("replacement imports require approval and profile confirmation", () => {
  const invocation = classifyConvexInvocation("import", ["--replace-all", "backup.zip"], "staging");
  assert.equal(requiresWriteApproval("allow", invocation), true);
  assert.throws(
    () => assertWritePolicy({
      policy: "allow",
      invocation,
      writeApproved: false,
      confirmDestructive: "staging",
    }),
    /interactive write approval/,
  );
  assert.throws(
    () => assertWritePolicy({
      policy: "allow",
      invocation,
      writeApproved: true,
      confirmDestructive: "uat",
    }),
    /--confirm-destructive staging/,
  );
  assert.doesNotThrow(() => assertWritePolicy({
    policy: "allow",
    invocation,
    writeApproved: true,
    confirmDestructive: "staging",
  }));
});
