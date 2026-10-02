import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ResolvedCredentials, WritePolicy } from "../core/types.js";

const READ_ONLY_TOOLS = new Set([
  "status",
  "data",
  "tables",
  "runOneoffQuery",
  "functionSpec",
  "logs",
  "insights",
  "envList",
  "envGet",
]);

export const PROFILE_TOOLS = new Set([
  "status",
  "data",
  "tables",
  "runOneoffQuery",
  "functionSpec",
  "run",
  "logs",
  "insights",
  "envList",
  "envGet",
  "envSet",
  "envRemove",
]);

const DISABLE_WRITE_TOOLS = "run,envSet,envRemove";

export type McpCallDecision = "forward" | "request-approval" | "deny";
export type McpApprovalState = "pending" | "approved" | "declined" | "unsupported";

export function buildMcpArgs(
  credentials: ResolvedCredentials,
  selfHostedEnvFile?: string,
): string[] {
  const args = ["convex", "mcp", "start"];
  if (credentials.url) {
    if (!selfHostedEnvFile) {
      throw new Error("A private --env-file is required to start a self-hosted MCP profile.");
    }
    args.push("--env-file", selfHostedEnvFile);
  } else if (credentials.deployment && !credentials.deployKey) {
    args.push("--deployment", credentials.deployment);
  }
  if (credentials.projectDir) {
    args.push("--project-dir", credentials.projectDir);
  }
  if (credentials.writePolicy === "read-only") {
    args.push("--disable-tools", DISABLE_WRITE_TOOLS);
  }
  return args;
}

export async function createSelfHostedMcpEnvFile(
  credentials: ResolvedCredentials,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  if (!credentials.url || !credentials.adminKey) {
    throw new Error("Self-hosted MCP profiles require both a URL and admin key.");
  }

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "convex-profile-mcp-"));
  const envPath = path.join(directory, "profile.env");
  try {
    await fs.chmod(directory, 0o700);
    const contents = [
      `CONVEX_SELF_HOSTED_URL=${JSON.stringify(credentials.url)}`,
      `CONVEX_SELF_HOSTED_ADMIN_KEY=${JSON.stringify(credentials.adminKey)}`,
      "",
    ].join("\n");
    await fs.writeFile(envPath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fs.chmod(envPath, 0o600);
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }

  return {
    path: envPath,
    cleanup: async () => fs.rm(directory, { recursive: true, force: true }),
  };
}

export function isReadOnlyMcpTool(name: string): boolean {
  return READ_ONLY_TOOLS.has(name);
}

export function isProfileDeploymentSelector(
  selector: string,
  credentials: ResolvedCredentials,
): boolean {
  const separator = selector.indexOf(":");
  if (separator === -1 || !credentials.projectDir) return false;
  try {
    const payload = JSON.parse(
      Buffer.from(selector.slice(separator + 1), "base64").toString("utf8"),
    ) as { projectDir?: unknown; deployment?: unknown };
    if (payload.projectDir !== credentials.projectDir || !payload.deployment || typeof payload.deployment !== "object") {
      return false;
    }
    const deployment = payload.deployment as Record<string, unknown>;
    if (!credentials.url && credentials.deployment && !credentials.deployKey) {
      return deployment.kind === "deploymentSelector" &&
        deployment.selector === credentials.deployment;
    }
    return deployment.kind === "unspecified";
  } catch {
    return false;
  }
}

export function decideMcpToolCall(
  policy: WritePolicy,
  toolName: string,
  approval: McpApprovalState = "pending",
): McpCallDecision {
  const safeRead = isReadOnlyMcpTool(toolName);
  if (policy === "read-only") return safeRead ? "forward" : "deny";
  if (policy === "require-allow-write" && !safeRead) {
    return approval === "approved" ? "forward" : approval === "pending" ? "request-approval" : "deny";
  }
  return "forward";
}

