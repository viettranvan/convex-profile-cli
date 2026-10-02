import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import path from "node:path";
import {
  fromJsonSchema,
  inputRequired,
  McpServer,
  type CallToolResult,
  type JsonSchemaType,
  type Tool,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { buildConvexEnv, convexCommand } from "../convex/spawn.js";
import { resolveTableName } from "../convex/table-lookup.js";
import { targetLabel, type ResolvedCredentials } from "../core/types.js";
import {
  approvalMessage,
  approvalSchema,
  createWriteApprovalGuard,
  legacyApproval,
  modernApproval,
  stringArgument,
} from "./approval.js";
import { denied } from "./responses.js";
import { emptyDataPage, extractMcpTableNames, tableNameFailure } from "./table.js";
import {
  buildMcpArgs,
  createSelfHostedMcpEnvFile,
  decideMcpToolCall,
  isProfileDeploymentSelector,
  isReadOnlyMcpTool,
  PROFILE_TOOLS,
  type McpApprovalState,
} from "./target.js";

export { createWriteApprovalGuard } from "./approval.js";
export { emptyDataPage, extractMcpTableNames } from "./table.js";
export {
  buildMcpArgs,
  createSelfHostedMcpEnvFile,
  decideMcpToolCall,
  isProfileDeploymentSelector,
  isReadOnlyMcpTool,
} from "./target.js";
export type { McpApprovalState } from "./target.js";

export function filterStatusResult(
  result: CallToolResult,
  credentials: ResolvedCredentials,
): CallToolResult {
  const structured = result.structuredContent;
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) {
    return result;
  }
  const status = structured as Record<string, unknown>;
  if (!Array.isArray(status.availableDeployments)) return result;

  const availableDeployments = status.availableDeployments.filter((deployment) => {
    if (!deployment || typeof deployment !== "object" || Array.isArray(deployment)) return false;
    const selector = (deployment as Record<string, unknown>).deploymentSelector;
    return typeof selector === "string" && isProfileDeploymentSelector(selector, credentials);
  });
  const filtered = { ...status, availableDeployments };
  return {
    ...result,
    structuredContent: filtered,
    content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }],
  };
}

function serverForProfile(
  credentials: ResolvedCredentials,
  childClient: Client,
  tools: Tool[],
  era: "legacy" | "modern",
  projectDir: string,
): McpServer {
  const approvalGuard = createWriteApprovalGuard(credentials);
  const tableNamesCache = new Map<string, { names: string[]; expiresAt: number }>();
  const pendingTableLookups = new Map<string, Promise<string[]>>();
  const getTableNames = async (selector: string, refresh = false): Promise<string[]> => {
    const cached = tableNamesCache.get(selector);
    if (!refresh && cached && cached.expiresAt > Date.now()) return cached.names;
    const pending = pendingTableLookups.get(selector);
    if (pending) return pending;
    const lookup = childClient
      .callTool({
        name: "tables",
        arguments: { deploymentSelector: selector },
      })
      .then(extractMcpTableNames)
      .then((names) => {
        tableNamesCache.set(selector, { names, expiresAt: Date.now() + 5 * 60_000 });
        return names;
      })
      .finally(() => pendingTableLookups.delete(selector));
    pendingTableLookups.set(selector, lookup);
    return lookup;
  };
  const server = new McpServer(
    { name: "convex-profile-cli", version: "0.1.0" },
    { requestState: { verify: approvalGuard.verify } },
  );

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.name === "data"
          ? `${tool.description ?? ""}\n\nThe profile wrapper verifies table names and may correct one unique close typo before reading.`
          : tool.description,
        inputSchema: fromJsonSchema<Record<string, unknown>>(tool.inputSchema as JsonSchemaType),
        annotations: tool.annotations,
        icons: tool.icons,
        _meta: tool._meta,
      },
      async (args, context): Promise<CallToolResult | ReturnType<typeof inputRequired>> => {
        const normalizedArgs = { ...(args as Record<string, unknown>) };
        if (tool.name === "status") {
          // Convex MCP's status tool accepts a caller-supplied project directory.
          // Pin it here so this profile cannot be redirected to another project.
          normalizedArgs.projectDir = projectDir;
        } else if (
          typeof normalizedArgs.deploymentSelector !== "string" ||
          !isProfileDeploymentSelector(normalizedArgs.deploymentSelector, credentials)
        ) {
          return denied(
            `Tool call denied: profile "${credentials.profileName}" is fixed to its configured project and deployment.`,
          );
        }

        if (!PROFILE_TOOLS.has(tool.name)) {
          return denied(`Tool "${tool.name}" is not in the profile-bound Convex tool set.`);
        }

        let correctedFrom: string | undefined;
        let tableNames: string[] | undefined;
        if (tool.name === "data") {
          const selector = normalizedArgs.deploymentSelector as string;
          const requestedTable = stringArgument(normalizedArgs, ["tableName"]);
          if (!requestedTable) return denied("A tableName is required for this data read.");
          try {
            const cachedBeforeLookup = tableNamesCache.get(selector);
            const hadFreshCache = Boolean(cachedBeforeLookup && cachedBeforeLookup.expiresAt > Date.now());
            tableNames = await getTableNames(selector);
            let resolution = resolveTableName(requestedTable, tableNames);
            // If a fresh cache has no exact/near match, refresh once before refusing;
            // the deployment may have gained a table since the previous lookup.
            if (hadFreshCache && resolution.kind !== "exact") {
              const refreshed = await getTableNames(selector, true);
              tableNames = refreshed;
              resolution = resolveTableName(requestedTable, refreshed);
            }
            if (resolution.kind === "missing" || resolution.kind === "ambiguous") {
              return tableNameFailure(
                requestedTable,
                credentials.profileName,
                resolution.kind,
                resolution.suggestions,
              );
            }
            if (resolution.kind === "corrected") {
              correctedFrom = requestedTable;
              normalizedArgs.tableName = resolution.tableName;
            }
          } catch {
            return denied(
              `Could not verify table name for profile "${credentials.profileName}". No data query was run.`,
            );
          }
        }
        let approval: McpApprovalState = "pending";

        if (credentials.writePolicy === "require-allow-write" && !isReadOnlyMcpTool(tool.name)) {
          if (era === "legacy") {
            approval = await legacyApproval(context, credentials, tool.name, normalizedArgs);
          } else {
            approval = modernApproval(context);
            if (approval === "pending") {
              approvalGuard.discard(context);
              const requestState = await approvalGuard.mint(context, tool.name, normalizedArgs);
              if (!requestState) {
                return denied("Write approval limit reached. Retry after pending approvals expire.");
              }
              return inputRequired({
                inputRequests: {
                  writeApproval: inputRequired.elicit({
                    message: approvalMessage(credentials, tool.name, normalizedArgs),
                    requestedSchema: approvalSchema,
                  }),
                },
                requestState,
              });
            }
            if (approval === "approved" && !approvalGuard.consume(context, tool.name, normalizedArgs)) {
              approval = "declined";
            } else if (approval === "declined") {
              approvalGuard.discard(context);
            }
          }
        }

        const decision = decideMcpToolCall(credentials.writePolicy, tool.name, approval);
        if (decision === "deny") {
          const reason = approval === "unsupported"
            ? "the MCP client does not support user approval"
            : approval === "declined"
              ? "the user declined or cancelled"
              : "the profile is read-only";
          return denied(
            `Write denied for profile "${credentials.profileName}" (${targetLabel(credentials)}): ${reason}.`,
          );
        }

        if (decision === "request-approval") {
          return denied("Write approval was not collected for this tool call.");
        }

        const result = await childClient.callTool({ name: tool.name, arguments: normalizedArgs });
        if (tool.name === "status") return filterStatusResult(result, credentials);
        if (tool.name === "data") {
          const selector = normalizedArgs.deploymentSelector as string;
          const tableName = normalizedArgs.tableName as string;
          if (emptyDataPage(result)) {
            try {
              tableNames = await getTableNames(selector, true);
            } catch {
              return denied(
                `Could not recheck table name for profile "${credentials.profileName}" after an empty result.`,
              );
            }
            if (!tableNames.includes(tableName)) {
              return tableNameFailure(tableName, credentials.profileName, "missing", []);
            }
          }
          if (correctedFrom) {
            return {
              ...result,
              content: [
                {
                  type: "text",
                  text: `Table "${correctedFrom}" was not found; read from the unique close match "${tableName}".`,
                },
                ...result.content,
              ],
            };
          }
        }
        return result;
      },
    );
  }

  return server;
}

export async function startMcpServer(credentials: ResolvedCredentials): Promise<void> {
  const projectDir = path.resolve(credentials.projectDir ?? process.cwd());
  const pinnedCredentials: ResolvedCredentials = { ...credentials, projectDir };
  const selfHostedEnvFile = pinnedCredentials.url
    ? await createSelfHostedMcpEnvFile(pinnedCredentials)
    : undefined;
  const convex = convexCommand(buildMcpArgs(pinnedCredentials, selfHostedEnvFile?.path), projectDir);
  const childTransport = new StdioClientTransport({
    command: convex.command,
    args: convex.args,
    env: Object.fromEntries(
      Object.entries(buildConvexEnv(pinnedCredentials)).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    cwd: projectDir,
    stderr: "inherit",
  });
  const childClient = new Client({ name: "convex-profile-cli-proxy", version: "0.1.0" });
  let serverHandle: ReturnType<typeof serveStdio> | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await Promise.allSettled([
      ...(serverHandle ? [serverHandle.close()] : []),
      childClient.close(),
    ]);
    await selfHostedEnvFile?.cleanup();
  };

  try {
    childTransport.onclose = () => void selfHostedEnvFile?.cleanup();
    await childClient.connect(childTransport);
    const childTools = (await childClient.listTools()).tools;
    const tools = childTools.filter((tool) =>
      PROFILE_TOOLS.has(tool.name) &&
      (pinnedCredentials.writePolicy !== "read-only" || isReadOnlyMcpTool(tool.name)),
    );

    process.stderr.write(
      `convex-profile: MCP profile "${pinnedCredentials.profileName}" (${pinnedCredentials.writePolicy}) → ${targetLabel(pinnedCredentials)}\n`,
    );
    serverHandle = serveStdio(
      (context) => serverForProfile(pinnedCredentials, childClient, tools, context.era, projectDir),
      { legacy: "serve", onerror: (error) => process.stderr.write(`${error.message}\n`) },
    );

    process.stdin.once("end", () => void close());
    process.stdin.once("close", () => void close());
    process.once("SIGINT", () => void close());
    process.once("SIGTERM", () => void close());
  } catch (error) {
    await close();
    throw error;
  }
}
