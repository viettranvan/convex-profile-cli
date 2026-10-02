import type { CallToolResult } from "@modelcontextprotocol/server";

export function denied(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

