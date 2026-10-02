import type { WritePolicy } from "../core/types.js";

export type InvocationClassification = "read" | "write" | "unknown";

export type DestructiveOperation = {
  kind: "env-remove" | "import-replace";
  confirmationTarget: string;
  description: string;
  requiresAllowWrite: boolean;
};

export type ClassifiedInvocation = {
  command: string;
  classification: InvocationClassification;
  destructive?: DestructiveOperation;
};

export function requiresWriteApproval(
  policy: WritePolicy,
  invocation: ClassifiedInvocation,
): boolean {
  return (
    (policy === "require-allow-write" && invocation.classification !== "read") ||
    invocation.destructive?.requiresAllowWrite === true
  );
}

export function assertDestructiveConfirmation(
  invocation: ClassifiedInvocation,
  confirmDestructive?: string,
): void {
  const destructive = invocation.destructive;
  if (!destructive || confirmDestructive === destructive.confirmationTarget) return;

  throw new Error(
    `This operation can ${destructive.description}; pass --confirm-destructive ${destructive.confirmationTarget} to confirm.`,
  );
}

const READ_COMMANDS = new Set([
  "data",
  "logs",
  "function-spec",
  "insights",
  "export",
]);

const SAFE_ENV_COMMANDS = new Set(["list", "get"]);

function firstOperand(args: string[]): string | undefined {
  return args.find((arg) => !arg.startsWith("-"));
}

export function classifyConvexInvocation(
  requestedCommand: string,
  requestedArgs: string[],
  profileName: string,
): ClassifiedInvocation {
  let command = requestedCommand;
  let args = requestedArgs;

  if (command === "passthrough") {
    const index = args.findIndex((arg) => !arg.startsWith("-"));
    if (index === -1) {
      return { command: "", classification: "unknown" };
    }
    command = args[index];
    args = args.slice(index + 1);
  }

  if (command === "run") {
    return {
      command,
      classification: args.includes("--inline-query") ? "read" : "write",
    };
  }

  if (READ_COMMANDS.has(command)) {
    return { command, classification: "read" };
  }

  if (command === "env") {
    const operation = firstOperand(args);
    if (operation && SAFE_ENV_COMMANDS.has(operation)) {
      return { command, classification: "read" };
    }
    if (operation === "remove") {
      const operands = args.filter((arg) => !arg.startsWith("-"));
      const variable = operands[1];
      return {
        command,
        classification: "write",
        ...(variable
          ? {
              destructive: {
                kind: "env-remove" as const,
                confirmationTarget: variable,
                description: `remove environment variable ${variable}`,
                requiresAllowWrite: false,
              },
            }
          : {}),
      };
    }
    return { command, classification: operation === "set" ? "write" : "unknown" };
  }

  if (command === "import") {
    const replacesData = args.includes("--replace") || args.includes("--replace-all");
    return {
      command,
      classification: "write",
      ...(replacesData
        ? {
            destructive: {
              kind: "import-replace" as const,
              confirmationTarget: profileName,
              description: `replace data in profile ${profileName}`,
              requiresAllowWrite: true,
            },
          }
        : {}),
    };
  }

  if (command === "deploy" || command === "dev") {
    return { command, classification: "write" };
  }

  return { command, classification: "unknown" };
}

export function assertWritePolicy(input: {
  policy: WritePolicy;
  invocation: ClassifiedInvocation;
  writeApproved: boolean;
  confirmDestructive?: string;
}): void {
  const { policy, invocation, writeApproved, confirmDestructive } = input;

  if (policy === "read-only" && invocation.classification !== "read") {
    throw new Error(
      `Profile is read-only; “${invocation.command || "this command"}” is not an approved read command.`,
    );
  }

  if (
    policy === "require-allow-write" &&
    invocation.classification !== "read" &&
    !writeApproved
  ) {
    throw new Error(
      `Profile requires interactive write approval before running “${invocation.command || "this command"}”.`,
    );
  }

  const destructive = invocation.destructive;
  if (!destructive) return;

  if (destructive.requiresAllowWrite && !writeApproved) {
    throw new Error(
      `This operation can ${destructive.description}; interactive write approval is required.`,
    );
  }

  assertDestructiveConfirmation(invocation, confirmDestructive);
}
