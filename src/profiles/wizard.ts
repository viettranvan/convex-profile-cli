import { isCancel, password, select, text } from "@clack/prompts";

import { parseAdminKeyInput, parseDeployKeyInput } from "./key-input.js";
import type { WritePolicy } from "../core/types.js";
import { ProfileSchema, type Profile } from "./schema.js";

export type AddProfileOptions = {
  url?: string;
  deployment?: string;
  adminKey?: string;
  adminKeyEnv?: string;
  deployKey?: string;
  deployKeyEnv?: string;
  projectDir?: string;
  writePolicy?: WritePolicy;
  default?: boolean;
};

const TARGET_TYPES = [
  { label: "Self-hosted", value: "self-hosted", hint: "API URL and admin key" },
  { label: "Cloud", value: "cloud", hint: "Deployment reference, CLI login, or deploy key" },
] as const;

const CLOUD_AUTH_CHOICES = [
  { label: "Use existing Convex CLI login", value: "login", hint: "Uses `npx convex login` on this machine" },
  { label: "Use a Cloud deploy key", value: "deploy-key", hint: "Scoped to this Cloud deployment" },
] as const;

const WRITE_POLICY_CHOICES = [
  { label: "Allow writes", value: "allow", hint: "allow" },
  {
    label: "Require explicit write approval",
    value: "require-allow-write",
    hint: "require-allow-write (default)",
  },
  { label: "Read-only", value: "read-only", hint: "read-only" },
] as const satisfies readonly { label: string; value: WritePolicy; hint?: string }[];

export async function promptProfile(
  initialName: string | undefined,
  options: AddProfileOptions,
): Promise<{ name: string; profile: Profile; makeDefault: boolean }> {
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  if (options.url && options.deployment) {
    throw new Error("Choose one target: --url for self-hosted or --deployment for Cloud.");
  }
  if (options.adminKey && options.adminKeyEnv) {
    throw new Error("Choose one credential source: --admin-key or --admin-key-env.");
  }
  if (options.deployKey && options.deployKeyEnv) {
    throw new Error("Choose one Cloud credential source: --deploy-key or --deploy-key-env.");
  }
  if (options.url && (options.deployKey || options.deployKeyEnv)) {
    throw new Error("Cloud deploy keys require --deployment and cannot be used with --url.");
  }
  if (options.deployment && (options.adminKey || options.adminKeyEnv) &&
      (options.deployKey || options.deployKeyEnv)) {
    throw new Error("Use either Cloud deploy-key options or legacy --admin-key options, not both.");
  }

  const hasSelfHostedCredentials = Boolean(options.adminKey || options.adminKeyEnv);
  const isComplete =
    Boolean(initialName) &&
    Boolean(options.url || options.deployment) &&
    (!options.url || hasSelfHostedCredentials) &&
    Boolean(options.writePolicy);

  if (!interactive && !isComplete) {
    throw new Error(
      "Non-interactive profile add requires <name>, exactly one of --url or --deployment, and --write-policy; --url also requires --admin-key or --admin-key-env. Cloud may optionally use --deploy-key-env.",
    );
  }

  let name = initialName?.trim();
  let url = options.url;
  let deployment = options.deployment;
  let adminKey = options.adminKey;
  let adminKeyEnv = options.adminKeyEnv;
  let deployKey = options.deployKey;
  let deployKeyEnv = options.deployKeyEnv;
  let projectDir = options.projectDir;
  let writePolicy = options.writePolicy;
  let makeDefault = options.default ?? false;

  if (!isComplete) {
    name ||= await promptTextRequired(
      "Profile name (a local alias, e.g. dev or staging)",
      "dev",
    );

    if (!url && !deployment) {
      const targetType = requirePromptValue(
        await select<"self-hosted" | "cloud">({
          message: "Choose target type:",
          initialValue: "self-hosted",
          options: [...TARGET_TYPES],
        }),
      );
      if (targetType === "self-hosted") {
        url = await promptTextRequired(
          "Self-hosted Convex API URL",
          "http://127.0.0.1:3210",
        );
      } else {
        deployment = await promptTextRequired(
          "Convex Cloud deployment reference",
          "dev, dev/your-username, or prod",
        );
      }
    }

    if (url && (deployKey || deployKeyEnv)) {
      throw new Error("Cloud deploy keys require a deployment reference and cannot be used with --url.");
    }
    if (deployment && !deployKey && !deployKeyEnv && (adminKey || adminKeyEnv)) {
      // Accept the previously documented admin-key flags as aliases for a
      // Cloud deploy key, but store them using the correct Cloud fields.
      deployKey = adminKey;
      deployKeyEnv = adminKeyEnv;
      adminKey = undefined;
      adminKeyEnv = undefined;
    }
    if (deployment && (adminKey || adminKeyEnv) && (deployKey || deployKeyEnv)) {
      throw new Error("Use either Cloud deploy-key options or legacy --admin-key options, not both.");
    }

    if (deployment && !deployKey && !deployKeyEnv && !adminKey && !adminKeyEnv) {
      const cloudAuth = requirePromptValue(
        await select<"login" | "deploy-key">({
          message: "Choose Cloud authentication:",
          initialValue: "login",
          options: [...CLOUD_AUTH_CHOICES],
        }),
      );
      if (cloudAuth === "deploy-key") {
        const keyInput = await promptSecretRequired(
          "Paste Cloud deploy key (or type env:VARIABLE_NAME):",
          "Deploy key is required.",
        );
        const parsedKey = parseDeployKeyInput(keyInput);
        deployKey = parsedKey.deployKey;
        deployKeyEnv = parsedKey.deployKeyEnv;
      }
    }

    if (url && !adminKey && !adminKeyEnv) {
      const keyInput = await promptSecretRequired(
        "Paste self-hosted admin key (or type env:VARIABLE_NAME):",
        "Admin key is required.",
      );
      const parsedKey = parseAdminKeyInput(keyInput);
      adminKey = parsedKey.adminKey;
      adminKeyEnv = parsedKey.adminKeyEnv;
    }

    if (!writePolicy) {
      writePolicy = requirePromptValue<WritePolicy>(
        await select<WritePolicy>({
          message: "Choose write policy:",
          initialValue: "require-allow-write",
          options: [...WRITE_POLICY_CHOICES],
        }),
      );
    }
  }

  if (deployment && !deployKey && !deployKeyEnv && (adminKey || adminKeyEnv)) {
    // Backward compatibility for profiles created with the earlier
    // --admin-key-env Cloud instructions.
    deployKey = adminKey;
    deployKeyEnv = adminKeyEnv;
    adminKey = undefined;
    adminKeyEnv = undefined;
  }
  if (url && (deployKey || deployKeyEnv)) {
    throw new Error("Cloud deploy keys require a deployment reference and cannot be used with --url.");
  }
  if (deployment && (adminKey || adminKeyEnv)) {
    throw new Error("Cloud profiles use --deploy-key or --deploy-key-env, not --admin-key options.");
  }

  if (!name) {
    throw new Error("Profile name cannot be empty.");
  }

  const profile = ProfileSchema.parse({
    url,
    deployment,
    adminKey,
    adminKeyEnv,
    deployKey,
    deployKeyEnv,
    projectDir,
    writePolicy,
  });

  return { name, profile, makeDefault };
}

function requirePromptValue<T>(value: T | symbol): T {
  if (isCancel(value)) {
    throw new Error("Profile setup cancelled.");
  }
  return value as T;
}

async function promptTextRequired(message: string, placeholder: string): Promise<string> {
  const value = requirePromptValue(
    await text({
      message,
      placeholder,
      validate(value) {
        if (!(value ?? "").trim()) return `${message} is required.`;
      },
    }),
  );
  return (value as string).trim();
}

export async function promptSecretRequired(message: string, requiredError: string): Promise<string> {
  return requirePromptValue(
    await password({
      message,
      mask: "•",
      validate(value) {
        if (!value) return requiredError;
      },
    }),
  ) as string;
}
