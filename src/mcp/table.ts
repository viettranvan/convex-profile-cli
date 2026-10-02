import type { CallToolResult } from "@modelcontextprotocol/server";
import { denied } from "./responses.js";

function structuredPayload(result: CallToolResult, key: string): unknown {
  if (result.structuredContent) return result.structuredContent;
  for (const textBlock of result.content) {
    if (textBlock.type !== "text") continue;
    try {
      const parsed = JSON.parse(textBlock.text) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && key in parsed) return parsed;
    } catch {
      // Check the next text block; the official result may include a notice first.
    }
  }
  return undefined;
}

export function extractMcpTableNames(result: CallToolResult): string[] {
  if (result.isError) throw new Error("Convex MCP table lookup failed.");
  const payload = structuredPayload(result, "tables");
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Convex MCP returned no structured table list.");
  }
  const tables = (payload as Record<string, unknown>).tables;
  if (!tables || typeof tables !== "object" || Array.isArray(tables)) {
    throw new Error("Convex MCP returned no structured table list.");
  }
  return Object.keys(tables).sort();
}

export function emptyDataPage(result: CallToolResult): boolean {
  const structured = structuredPayload(result, "page");
  return Boolean(
    structured &&
      typeof structured === "object" &&
      Array.isArray((structured as Record<string, unknown>).page) &&
      ((structured as Record<string, unknown>).page as unknown[]).length === 0,
  );
}

export function tableNameFailure(
  requested: string,
  profileName: string,
  kind: "missing" | "ambiguous",
  suggestions: string[],
): CallToolResult {
  const details = kind === "ambiguous"
    ? `Choose one exact table name: ${suggestions.join(", ")}.`
    : suggestions.length
      ? `Close matches: ${suggestions.join(", ")}.`
      : "No close match was found.";
  return denied(
    `Table name "${requested}" ${kind === "ambiguous" ? "is ambiguous" : "does not exist"} ` +
      `in profile "${profileName}". ${details} No data query was run.`,
  );
}
