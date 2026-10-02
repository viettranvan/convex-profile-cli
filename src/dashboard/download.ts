import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import AdmZip from "adm-zip";

import { DASHBOARD_RELEASE_TAG } from "../profiles/schema.js";

const INVALID_VERSION_MESSAGE =
  "Dashboard version must be a Convex release tag such as precompiled-2026-01-29-483f94d, or the backend image commit SHA.";
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;

export function dashboardAssetUrl(tag: string): string {
  if (!DASHBOARD_RELEASE_TAG.test(tag)) {
    throw new Error(INVALID_VERSION_MESSAGE);
  }
  return `https://github.com/get-convex/convex-backend/releases/download/${tag}/dashboard.zip`;
}

export function dashboardCachePath(tag: string): string {
  dashboardAssetUrl(tag);
  return path.join(os.homedir(), ".cache", "convex-profile-cli", "dashboard", tag);
}

const COMMIT_SHA = /^[0-9a-f]{7,40}$/;
const RELEASE_TAG_REFS_URL =
  "https://api.github.com/repos/get-convex/convex-backend/git/matching-refs/tags/precompiled-";

export type TagRef = { ref: string; object: { sha: string; type: string } };

export function findReleaseTagForCommit(refs: TagRef[], commitSha: string): string {
  const sha = commitSha.toLowerCase();
  const matches = refs
    .filter((entry) => {
      const tag = entry.ref.replace(/^refs\/tags\//, "");
      if (!DASHBOARD_RELEASE_TAG.test(tag)) return false;
      if (entry.object.type === "commit") return entry.object.sha.startsWith(sha);
      // Annotated tags point at a tag object, so fall back to the short SHA in the tag name.
      return sha.startsWith(tag.slice(tag.lastIndexOf("-") + 1));
    })
    .map((entry) => entry.ref.replace(/^refs\/tags\//, ""));
  const unique = [...new Set(matches)];
  if (unique.length === 0) {
    throw new Error(`No Convex precompiled release was found for commit ${commitSha}.`);
  }
  if (unique.length > 1) {
    throw new Error(
      `Commit ${commitSha} matches several releases: ${unique.join(", ")}. Use a longer SHA or the release tag.`,
    );
  }
  return unique[0];
}

/** Accept a release tag as-is, or resolve a backend image commit SHA to its release tag. */
export async function resolveDashboardReleaseTag(input: string): Promise<string> {
  const value = input.trim();
  if (DASHBOARD_RELEASE_TAG.test(value)) return value;
  if (!COMMIT_SHA.test(value.toLowerCase())) throw new Error(INVALID_VERSION_MESSAGE);
  const response = await fetch(RELEASE_TAG_REFS_URL, {
    headers: { Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    throw new Error(`Could not look up Convex release tags on GitHub (HTTP ${response.status}).`);
  }
  return findReleaseTagForCommit((await response.json()) as TagRef[], value);
}

export async function checkDashboardRelease(tag: string): Promise<void> {
  const response = await fetch(dashboardAssetUrl(tag), {
    method: "HEAD",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    throw new Error(`Convex dashboard.zip was not found for release ${tag} (HTTP ${response.status}).`);
  }
}

function assertSafeEntries(zip: AdmZip): void {
  let uncompressedBytes = 0;
  if (zip.getEntries().length > 5000) {
    throw new Error("Dashboard archive contains too many files.");
  }
  for (const entry of zip.getEntries()) {
    const name = entry.entryName.replaceAll("\\", "/");
    const segments = name.split("/");
    if (!name || name.startsWith("/") || segments.includes("..") || /^[A-Za-z]:/.test(name)) {
      throw new Error("Dashboard archive contains an unsafe path.");
    }
    // Do not follow links supplied by the archive.
    if (((entry.header.attr >>> 16) & 0o170000) === 0o120000) {
      throw new Error("Dashboard archive contains a symbolic link.");
    }
    uncompressedBytes += entry.header.size;
    if (uncompressedBytes > 200 * 1024 * 1024) {
      throw new Error("Dashboard archive exceeds the 200 MB extraction limit.");
    }
  }
}

async function downloadArchive(tag: string): Promise<Buffer> {
  const response = await fetch(dashboardAssetUrl(tag), { signal: AbortSignal.timeout(60000) });
  if (!response.ok || !response.body) {
    throw new Error(`Could not download dashboard.zip for ${tag} (HTTP ${response.status}).`);
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (declaredLength > MAX_ARCHIVE_BYTES) {
    throw new Error("Dashboard archive exceeds the 50 MB download limit.");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > MAX_ARCHIVE_BYTES) {
      throw new Error("Dashboard archive exceeds the 50 MB download limit.");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function ensureDashboardDownloaded(tag: string): Promise<string> {
  const target = dashboardCachePath(tag);
  if (fs.existsSync(path.join(target, "index.html"))) return target;

  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = fs.mkdtempSync(path.join(parent, `.download-${tag}-`));
  try {
    const archive = new AdmZip(await downloadArchive(tag));
    assertSafeEntries(archive);
    archive.extractAllTo(temporary, true);
    if (!fs.existsSync(path.join(temporary, "index.html"))) {
      throw new Error("Downloaded dashboard archive has no index.html.");
    }
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(temporary, target);
    return target;
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}
