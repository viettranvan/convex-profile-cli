import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  createRequestStateCodec,
  inputResponse,
  type ElicitRequestFormParams,
  type ServerContext,
} from "@modelcontextprotocol/server";
import type { McpApprovalState } from "./target.js";
import { targetLabel, type ResolvedCredentials } from "../core/types.js";

export function stringArgument(
  args: Record<string, unknown>,
  candidates: string[],
): string | undefined {
  for (const candidate of candidates) {
    const value = args[candidate];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function callDescription(
  toolName: string,
  args: Record<string, unknown>,
): string {
  if (toolName === "envRemove") {
    const variable = stringArgument(args, ["name", "variable", "variableName", "envVar"]);
    return variable ? `remove environment variable ${variable}` : "remove an environment variable";
  }
  if (toolName === "envSet") {
    const variable = stringArgument(args, ["name", "variable", "variableName", "envVar"]);
    return variable ? `set environment variable ${variable}` : "set an environment variable";
  }
  if (toolName === "run") {
    const functionName = stringArgument(args, ["functionName", "name", "function"]);
    return functionName ? `run function ${functionName}` : "run a Convex function";
  }
  return `call tool ${toolName}`;
}

export function approvalMessage(
  credentials: ResolvedCredentials,
  toolName: string,
  args: Record<string, unknown>,
): string {
  return (
    `Approve ${callDescription(toolName, args)} for profile "${credentials.profileName}" ` +
    `(${targetLabel(credentials)})? Choose Approve to continue.`
  );
}

export const approvalSchema: ElicitRequestFormParams["requestedSchema"] = {
  type: "object",
  properties: {
    decision: {
      type: "string",
      title: "Write approval",
      enum: ["approve", "deny"],
      enumNames: ["Approve this operation", "Deny this operation"],
    },
  },
  required: ["decision"],
};

export async function legacyApproval(
  context: ServerContext,
  credentials: ResolvedCredentials,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpApprovalState> {
  try {
    const response = await context.mcpReq.elicitInput({
      mode: "form",
      message: approvalMessage(credentials, toolName, args),
      requestedSchema: approvalSchema,
    });
    return response.action === "accept" && response.content?.decision === "approve"
      ? "approved"
      : "declined";
  } catch {
    // The legacy client did not advertise elicitation or could not show it.
    return "unsupported";
  }
}

export function modernApproval(
  context: ServerContext,
): McpApprovalState {
  const response = inputResponse(context.mcpReq.inputResponses, "writeApproval");
  if (response.kind === "missing") return "pending";
  return response.kind === "elicit" &&
    response.action === "accept" &&
    response.content?.decision === "approve"
    ? "approved"
    : "declined";
}

interface WriteApprovalRequestState {
  toolName: string;
  argsFingerprint: string;
  approvalId: string;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Bind a modern MCP elicitation approval to the exact tool call. MCP requestState
 * is client-carried, so the SDK codec authenticates it and this guard also
 * makes each approval one-use. The fingerprint is keyed to avoid exposing
 * hashes of low-entropy values such as environment variable contents.
 */
export function createWriteApprovalGuard(
  credentials: Pick<ResolvedCredentials, "profileName">,
) {
  const ttlSeconds = 600;
  const stateKey = randomBytes(32);
  const fingerprintKey = randomBytes(32);
  const pending = new Map<string, number>();
  const codec = createRequestStateCodec<WriteApprovalRequestState>({
    key: stateKey,
    ttlSeconds,
    bind: (context) =>
      `convex-profile-write-approval\0${credentials.profileName}\0${context.mcpReq.method}\0${context.sessionId ?? ""}`,
  });

  const fingerprint = (toolName: string, args: Record<string, unknown>) =>
    createHmac("sha256", fingerprintKey)
      .update(toolName)
      .update("\0")
      .update(stableJson(args))
      .digest("hex");

  const pruneExpired = () => {
    const now = Date.now();
    for (const [id, expiresAt] of pending) {
      if (expiresAt <= now) pending.delete(id);
    }
  };

  const readState = (context: ServerContext): WriteApprovalRequestState | undefined => {
    const state = context.mcpReq.requestState<unknown>();
    if (!state || typeof state !== "object") return undefined;
    const candidate = state as Partial<WriteApprovalRequestState>;
    return typeof candidate.toolName === "string" &&
      typeof candidate.argsFingerprint === "string" &&
      typeof candidate.approvalId === "string"
      ? candidate as WriteApprovalRequestState
      : undefined;
  };

  return {
    verify: codec.verify,
    async mint(
      context: ServerContext,
      toolName: string,
      args: Record<string, unknown>,
    ): Promise<string | undefined> {
      pruneExpired();
      if (pending.size >= 256) return undefined;
      const approvalId = randomUUID();
      pending.set(approvalId, Date.now() + ttlSeconds * 1000);
      try {
        return await codec.mint(
          { toolName, argsFingerprint: fingerprint(toolName, args), approvalId },
          context,
        );
      } catch (error) {
        pending.delete(approvalId);
        throw error;
      }
    },
    consume(
      context: ServerContext,
      toolName: string,
      args: Record<string, unknown>,
    ): boolean {
      pruneExpired();
      const state = readState(context);
      if (!state) return false;
      const expiresAt = pending.get(state.approvalId);
      if (expiresAt === undefined) return false;
      pending.delete(state.approvalId);
      const expected = Buffer.from(fingerprint(toolName, args), "hex");
      const actual = Buffer.from(state.argsFingerprint, "hex");
      return expiresAt > Date.now() &&
        state.toolName === toolName &&
        actual.length === expected.length &&
        timingSafeEqual(actual, expected);
    },
    discard(context: ServerContext): void {
      const state = readState(context);
      if (state) pending.delete(state.approvalId);
    },
  };
}
