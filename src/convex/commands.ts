import { Command } from "commander";
import { confirm, isCancel } from "@clack/prompts";

import { loadConfig } from "../profiles/config-store.js";
import { resolveProfile } from "../profiles/credentials.js";
import { targetLabel, type ResolvedCredentials } from "../core/types.js";
import { startMcpServer } from "../mcp/server.js";
import { listConvexTables, runConvex } from "./spawn.js";
import { parseDataTableRequest, replaceDataTableName, resolveTableName } from "./table-lookup.js";
import { requestInteractiveWriteApproval } from "./write-approval.js";
import {
  assertDestructiveConfirmation,
  assertWritePolicy,
  classifyConvexInvocation,
  requiresWriteApproval,
} from "./write-policy.js";

const CONVEX_COMMANDS = [
  "run",
  "data",
  "logs",
  "env",
  "function-spec",
  "insights",
  "export",
  "import",
  "deploy",
  "dev",
  "codegen",
] as const;

export function registerConvexCommands(program: Command): void {
  function resolveSelectedProfile(opts: { profile?: string; projectDir?: string }): ResolvedCredentials {
    const creds = resolveProfile(loadConfig(), opts.profile);
    if (opts.projectDir) {
      creds.projectDir = opts.projectDir;
    }
    return creds;
  }

  async function requestWriteApproval(
    profileName: string,
    target: string,
    command: string,
    commandArgs: string[],
    invocation: ReturnType<typeof classifyConvexInvocation>,
  ): Promise<void> {
    let operation = invocation.destructive?.description ?? `run Convex command "${invocation.command}"`;
    if (!invocation.destructive && invocation.command === "run") {
      const runArgs = command === "passthrough" ? commandArgs.slice(1) : commandArgs;
      const functionName = runArgs.find((arg) => !arg.startsWith("-"));
      if (functionName) operation = `run Convex function "${functionName}"`;
    } else if (!invocation.destructive && invocation.command === "env") {
      const envArgs = command === "passthrough" ? commandArgs.slice(1) : commandArgs;
      const variable = envArgs[0] === "set" ? envArgs[1] : undefined;
      if (variable) operation = `set Convex environment variable "${variable}"`;
    } else if (!invocation.destructive && invocation.command === "import") {
      const importArgs = command === "passthrough" ? commandArgs.slice(1) : commandArgs;
      const tableIndex = importArgs.indexOf("--table");
      const tableName = tableIndex >= 0 ? importArgs[tableIndex + 1] : undefined;
      const mode = importArgs.includes("--append")
        ? "append"
        : "import";
      operation = tableName
        ? `${mode} data into Convex table "${tableName}"`
        : "import Convex data";
    }

    await requestInteractiveWriteApproval({
      interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
      profileName,
      target,
      operation,
      prompt: async (message) => {
        const answer = await confirm({ message, initialValue: false });
        return !isCancel(answer) && answer;
      },
    });
  }

  async function runWithProfile(command: string, commandArgs: string[]): Promise<void> {
    const opts = program.opts<{
      profile?: string;
      projectDir?: string;
      confirmDestructive?: string;
    }>();
    const creds = resolveSelectedProfile(opts);
    const invocation = classifyConvexInvocation(command, commandArgs, creds.profileName);
    if (creds.writePolicy === "read-only" && invocation.classification !== "read") {
      assertWritePolicy({
        policy: creds.writePolicy,
        invocation,
        writeApproved: false,
        confirmDestructive: opts.confirmDestructive,
      });
    }
    assertDestructiveConfirmation(invocation, opts.confirmDestructive);
    const needsApproval = requiresWriteApproval(creds.writePolicy, invocation);
    if (needsApproval) {
      await requestWriteApproval(creds.profileName, targetLabel(creds), command, commandArgs, invocation);
    }
    assertWritePolicy({
      policy: creds.writePolicy,
      invocation,
      writeApproved: needsApproval,
      confirmDestructive: opts.confirmDestructive,
    });

    let convexArgs = command === "passthrough" ? [...commandArgs] : [command, ...commandArgs];
    const dataArgs = command === "data"
      ? [...commandArgs]
      : command === "passthrough" && commandArgs[0] === "data"
        ? commandArgs.slice(1)
        : undefined;
    if (dataArgs) {
      const request = parseDataTableRequest(dataArgs);
      if (request) {
        const availableTables = await listConvexTables(creds, request.component);
        const resolution = resolveTableName(request.tableName, availableTables);
        if (resolution.kind === "ambiguous") {
          throw new Error(
            `Table name "${request.tableName}" is ambiguous for profile "${creds.profileName}". ` +
              `Choose one exact name: ${resolution.suggestions.join(", ")}. No data query was run.`,
          );
        }
        if (resolution.kind === "missing") {
          const suggestions = resolution.suggestions.length
            ? ` Close matches: ${resolution.suggestions.join(", ")}.`
            : " No close match was found.";
          throw new Error(
            `Table "${request.tableName}" does not exist in profile "${creds.profileName}".` +
              `${suggestions} No data query was run.`,
          );
        }
        if (resolution.kind === "corrected") {
          const correctedDataArgs = replaceDataTableName(
            dataArgs,
            request,
            resolution.tableName,
          );
          convexArgs = ["data", ...correctedDataArgs];
          process.stderr.write(
            `convex-profile: table "${request.tableName}" was not found; using the unique close match "${resolution.tableName}".\n`,
          );
        }
      }
    }

    const code = await runConvex(creds, convexArgs);
    process.exit(code);
  }

  const mcp = program.command("mcp").description("Run the official Convex MCP server for a profile");
  mcp
    .command("start")
    .description("Start a profile-bound Convex MCP server with write-policy enforcement")
    .action(async () => {
      const opts = program.opts<{
        profile?: string;
        projectDir?: string;
        confirmDestructive?: string;
      }>();
      if (opts.confirmDestructive) {
        throw new Error(
          "MCP write approvals are requested per tool call; --confirm-destructive applies only to CLI commands.",
        );
      }
      await startMcpServer(resolveSelectedProfile(opts));
    });

  for (const sub of CONVEX_COMMANDS) {
    const command = program
      .command(sub)
      .description(`Run \`npx convex ${sub}\` with the selected profile`)
      .allowUnknownOption(true)
      .allowExcessArguments(true);
    command.action(async () => {
      await runWithProfile(sub, command.args);
    });
  }

  const passthrough = program
    .command("passthrough")
    .description("Run arbitrary `npx convex <args...>` with the selected profile")
    .allowUnknownOption(true)
    .allowExcessArguments(true);
  passthrough.action(async () => {
    await runWithProfile("passthrough", passthrough.args);
  });

}
