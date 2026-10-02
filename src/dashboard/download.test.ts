import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ConfigSchema } from "../profiles/schema.js";
import { dashboardAssetUrl, dashboardCachePath, findReleaseTagForCommit, type TagRef } from "./download.js";

const TAG = "precompiled-2026-10-01-d2ca853";

test("dashboardAssetUrl points at the release's dashboard.zip", () => {
  assert.equal(
    dashboardAssetUrl(TAG),
    `https://github.com/get-convex/convex-backend/releases/download/${TAG}/dashboard.zip`,
  );
});

test("dashboard release tags reject latest and path-like values", () => {
  for (const tag of ["latest", "../precompiled-2026-10-01-d2ca853", "precompiled-2026-10-01-d2ca853/x", ""]) {
    assert.throws(() => dashboardAssetUrl(tag), /Convex release tag/);
    assert.throws(() => dashboardCachePath(tag), /Convex release tag/);
  }
});

test("dashboardCachePath keeps one cache directory per tag outside the project", () => {
  assert.equal(
    dashboardCachePath(TAG),
    path.join(os.homedir(), ".cache", "convex-profile-cli", "dashboard", TAG),
  );
});

const REFS: TagRef[] = [
  {
    ref: "refs/tags/precompiled-2026-01-29-483f94d",
    object: { type: "commit", sha: "483f94d26687b7f3354804bf23849df4f681cfc1" },
  },
  {
    ref: "refs/tags/precompiled-2026-01-30-483f94e",
    object: { type: "commit", sha: "483f94e00000000000000000000000000000000a" },
  },
  {
    ref: "refs/tags/precompiled-2026-02-01-abc1234",
    object: { type: "tag", sha: "ffffffffffffffffffffffffffffffffffffffff" },
  },
];

test("findReleaseTagForCommit maps a Docker image commit SHA to its release tag", () => {
  assert.equal(
    findReleaseTagForCommit(REFS, "483f94d26687b7f3354804bf23849df4f681cfc1"),
    "precompiled-2026-01-29-483f94d",
  );
  assert.equal(findReleaseTagForCommit(REFS, "483F94D"), "precompiled-2026-01-29-483f94d");
});

test("findReleaseTagForCommit uses the tag name for annotated tags", () => {
  assert.equal(
    findReleaseTagForCommit(REFS, "abc1234999999999999999999999999999999999"),
    "precompiled-2026-02-01-abc1234",
  );
});

test("findReleaseTagForCommit rejects unknown or ambiguous SHAs", () => {
  assert.throws(() => findReleaseTagForCommit(REFS, "0000000"), /No Convex precompiled release/);
  const ambiguous: TagRef[] = [
    ...REFS,
    { ref: "refs/tags/precompiled-2026-03-01-483f94d", object: { type: "commit", sha: "483f94d1111111111111111111111111111111111" } },
  ];
  assert.throws(() => findReleaseTagForCommit(ambiguous, "483f94d"), /several releases/);
});

test("ConfigSchema stores one shared dashboard version", () => {
  assert.equal(ConfigSchema.parse({ dashboardVersion: TAG, profiles: {} }).dashboardVersion, TAG);
  assert.throws(() => ConfigSchema.parse({ dashboardVersion: "latest", profiles: {} }));
});
