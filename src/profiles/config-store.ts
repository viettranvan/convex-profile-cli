import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ConfigSchema, type Config, type Profile } from "./schema.js";

const CONFIG_DIR = path.join(os.homedir(), ".config", "convex-profile-cli");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

export function configPath(): string {
  return CONFIG_FILE;
}

export function loadConfig(): Config {
  if (!fs.existsSync(CONFIG_FILE)) {
    return { profiles: {} };
  }
  const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as unknown;
  return ConfigSchema.parse(raw);
}

export function saveConfig(config: Config): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const parsed = ConfigSchema.parse(config);
  fs.chmodSync(CONFIG_DIR, 0o700);
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(parsed, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.chmodSync(CONFIG_FILE, 0o600);
}

export function upsertProfile(config: Config, name: string, profile: Profile): Config {
  return {
    ...config,
    profiles: { ...config.profiles, [name]: profile },
  };
}
