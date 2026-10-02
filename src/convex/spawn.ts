import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import type { ResolvedCredentials } from "../core/types.js";

function convexBinFrom(require: NodeJS.Require): string | undefined {
  try {
    const manifestPath = require.resolve("convex/package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { bin?: string | Record<string, string> };
    const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.convex;
    return bin ? path.join(path.dirname(manifestPath), bin) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Prefer the project's own `convex` so CLI behavior matches the app's version;
 * fall back to the copy installed with this package instead of letting npx download one.
 */
export function resolveConvexBin(projectDir: string): string {
  const bin = convexBinFrom(createRequire(path.join(path.resolve(projectDir), "package.json")))
    ?? convexBinFrom(createRequire(import.meta.url));
  if (!bin) throw new Error("Could not find the `convex` package. Reinstall convex-profile-cli.");
  return bin;
}

/** Turn `["convex", ...rest]` into a node command for the resolved Convex CLI. */
export function convexCommand(args: string[], projectDir: string): { command: string; args: string[] } {
  return { command: process.execPath, args: [resolveConvexBin(projectDir), ...args.slice(1)] };
}

export function buildConvexArgs(
  creds: ResolvedCredentials,
  convexArgs: string[],
): string[] {
  const args = ["convex", ...convexArgs];
  if (creds.url) {
    if (!creds.adminKey) {
      throw new Error("Self-hosted URL profiles require an admin key.");
    }
    args.push("--url", creds.url, "--admin-key", creds.adminKey);
  } else if (creds.deployment) {
    // A Cloud deploy key already scopes Convex CLI to its deployment. Avoid
    // sending a second deployment selector that could disagree with the key.
    if (!creds.deployKey) {
      args.push("--deployment", creds.deployment);
    }
  }
  return args;
}

export function buildConvexEnv(
  creds: ResolvedCredentials,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...base };
  // Do not let shell-level target settings silently override the selected
  // profile. This matters especially for MCP's --env-file, whose values may
  // otherwise lose to already-set process environment variables.
  delete env.CONVEX_DEPLOY_KEY;
  delete env.CONVEX_DEPLOYMENT;
  delete env.CONVEX_SELF_HOSTED_URL;
  delete env.CONVEX_SELF_HOSTED_ADMIN_KEY;
  if (creds.deployKey) {
    env.CONVEX_DEPLOY_KEY = creds.deployKey;
  }
  return env;
}

export function parseConvexTableNames(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** List table names using Convex's official read-only `data` listing. */
export async function listConvexTables(
  creds: ResolvedCredentials,
  component?: string,
): Promise<string[]> {
  const convexArgs = ["data", ...(component ? ["--component", component] : [])];
  const args = buildConvexArgs(creds, convexArgs);
  const cwd = creds.projectDir ?? process.cwd();
  const env = buildConvexEnv(creds);

  const convex = convexCommand(args, cwd);

  return new Promise((resolve, reject) => {
    const child = spawn(convex.command, convex.args, {
      cwd,
      stdio: ["ignore", "pipe", "inherit"],
      shell: false,
      env,
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 5_000_000) {
        child.kill();
        reject(new Error("Convex table listing exceeded the 5 MB safety limit."));
      }
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (signal || code !== 0) {
        reject(new Error("Could not list tables for the selected Convex profile."));
        return;
      }
      resolve(parseConvexTableNames(stdout));
    });
  });
}

export async function runConvex(
  creds: ResolvedCredentials,
  convexArgs: string[],
): Promise<number> {
  const args = buildConvexArgs(creds, convexArgs);
  const cwd = creds.projectDir ?? process.cwd();
  const env = buildConvexEnv(creds);

  const convex = convexCommand(args, cwd);

  return new Promise((resolve, reject) => {
    const child = spawn(convex.command, convex.args, {
      cwd,
      stdio: "inherit",
      shell: false,
      env,
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (signal) {
        resolve(1);
        return;
      }
      resolve(code ?? 1);
    });
  });
}
