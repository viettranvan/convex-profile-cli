export const WRITE_POLICIES = [
  "allow",
  "require-allow-write",
  "read-only",
] as const;

export type WritePolicy = (typeof WRITE_POLICIES)[number];

export type ResolvedCredentials = {
  profileName: string;
  url?: string;
  deployment?: string;
  adminKey?: string;
  deployKey?: string;
  projectDir?: string;
  writePolicy: WritePolicy;
};

export function targetLabel(credentials: ResolvedCredentials): string {
  return credentials.url
    ? `self-hosted ${credentials.url}`
    : `Cloud deployment ${credentials.deployment}`;
}
