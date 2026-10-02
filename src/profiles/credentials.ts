import type { ResolvedCredentials } from "../core/types.js";
import { isEnvironmentVariableName } from "./key-input.js";
import type { Config, Profile } from "./schema.js";

export function adminKeySource(
  profile: Profile,
): "environment variable" | "inline key" | "Convex CLI login" | "not configured" {
  const inlineKey = profile.url
    ? profile.adminKey
    : profile.deployKey ?? profile.adminKey;
  const keyEnv = profile.url
    ? profile.adminKeyEnv
    : profile.deployKeyEnv ?? profile.adminKeyEnv;

  if (inlineKey) {
    return "inline key";
  }
  if (!keyEnv) {
    return profile.deployment ? "Convex CLI login" : "not configured";
  }
  // Older wizard versions could save a pasted key as the env-var name.
  return isEnvironmentVariableName(keyEnv)
    ? "environment variable"
    : "inline key";
}

export function resolveAdminKey(profile: Profile): string | undefined {
  if (profile.adminKey) {
    return profile.adminKey;
  }
  if (profile.adminKeyEnv) {
    if (!isEnvironmentVariableName(profile.adminKeyEnv)) {
      // Recover keys entered into the env-var prompt by an older wizard.
      return profile.adminKeyEnv;
    }
    const value = process.env[profile.adminKeyEnv];
    if (!value) {
      throw new Error("The admin-key environment variable required by this profile is not set.");
    }
    return value;
  }
  return undefined;
}

export function resolveDeployKey(profile: Profile): string | undefined {
  if (profile.deployKey) {
    return profile.deployKey;
  }
  if (profile.deployKeyEnv) {
    if (!isEnvironmentVariableName(profile.deployKeyEnv)) {
      throw new Error("Deploy-key environment variable name is invalid.");
    }
    const value = process.env[profile.deployKeyEnv];
    if (!value) {
      throw new Error("The deploy-key environment variable required by this profile is not set.");
    }
    return value;
  }

  // Profiles created before Cloud deploy keys had their own fields may have
  // saved a Cloud key in adminKey/adminKeyEnv. Continue to resolve those.
  if (profile.adminKey) {
    return profile.adminKey;
  }
  if (profile.adminKeyEnv) {
    if (!isEnvironmentVariableName(profile.adminKeyEnv)) {
      return profile.adminKeyEnv;
    }
    const value = process.env[profile.adminKeyEnv];
    if (!value) {
      throw new Error("The deploy-key environment variable required by this profile is not set.");
    }
    return value;
  }
  return undefined;
}

export function resolveProfile(
  config: Config,
  profileName?: string,
): ResolvedCredentials {
  const name = profileName ?? config.defaultProfile;
  if (!name) {
    throw new Error(
      "No profile selected. Use --profile <name>, `convex-profile profile use <name>`, or set defaultProfile in config.",
    );
  }
  const profile = config.profiles[name];
  if (!profile) {
    throw new Error(`Unknown profile "${name}". Run \`convex-profile profile list\`.`);
  }
  return {
    profileName: name,
    url: profile.url,
    deployment: profile.deployment,
    adminKey: profile.url ? resolveAdminKey(profile) : undefined,
    deployKey: profile.deployment ? resolveDeployKey(profile) : undefined,
    projectDir: profile.projectDir,
    writePolicy: profile.writePolicy ?? "require-allow-write",
  };
}

