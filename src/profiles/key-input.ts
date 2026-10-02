export function isEnvironmentVariableName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

export function parseAdminKeyInput(input: string):
  | { adminKey: string; adminKeyEnv?: never }
  | { adminKey?: never; adminKeyEnv: string } {
  if (input.startsWith("env:")) {
    const adminKeyEnv = input.slice("env:".length).trim();
    if (!isEnvironmentVariableName(adminKeyEnv)) {
      throw new Error("Enter a valid variable name after env: (for example env:CONVEX_ADMIN_KEY).");
    }
    return { adminKeyEnv };
  }
  return { adminKey: input };
}

export function parseDeployKeyInput(input: string):
  | { deployKey: string; deployKeyEnv?: never }
  | { deployKey?: never; deployKeyEnv: string } {
  if (input.startsWith("env:")) {
    const deployKeyEnv = input.slice("env:".length).trim();
    if (!isEnvironmentVariableName(deployKeyEnv)) {
      throw new Error("Enter a valid environment variable name after env: (for example env:CONVEX_DEPLOY_KEY).");
    }
    return { deployKeyEnv };
  }
  return { deployKey: input };
}
