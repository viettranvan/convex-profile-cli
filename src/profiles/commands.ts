import { confirm, isCancel } from "@clack/prompts";
import { Command, Option } from "commander";

import { adminKeySource as getAdminKeySource } from "./credentials.js";
import { loadConfig, saveConfig, upsertProfile, configPath } from "./config-store.js";
import { promptProfile, promptSecretRequired, type AddProfileOptions } from "./wizard.js";
import { parseAdminKeyInput, parseDeployKeyInput } from "./key-input.js";
import { WRITE_POLICIES } from "../core/types.js";
import { ProfileSchema, type Profile } from "./schema.js";

export function registerProfileCommands(program: Command): void {
  const profileCmd = program
    .command("profile")
    .description("Manage saved deployment profiles");

  profileCmd
    .command("list")
    .description("List profiles with their target and write policy")
    .option("--json", "Print profile metadata as JSON (credentials are redacted)")
    .action((opts: { json?: boolean }) => {
      const config = loadConfig();
      const names = Object.keys(config.profiles).sort();
      const profiles = names.map((name) => {
        const profile = config.profiles[name];
        return {
          name,
          target: profile.url
            ? { type: "url" as const, value: profile.url }
            : { type: "deployment" as const, value: profile.deployment! },
          credentialSource: getAdminKeySource(profile),
          projectDir: profile.projectDir,
          writePolicy: profile.writePolicy ?? "require-allow-write",
          default: config.defaultProfile === name,
        };
      });

      if (opts.json) {
        console.log(JSON.stringify(profiles, null, 2));
        return;
      }
      if (names.length === 0) {
        console.log("No profiles. Run: convex-profile profile add");
        return;
      }

      const rows = profiles.map((profile) => [
        profile.name,
        profile.target.type === "url"
          ? profile.target.value
          : `deployment:${profile.target.value}`,
        profile.credentialSource,
        profile.writePolicy,
        profile.default ? "*" : "",
      ]);
      const headers = ["PROFILE", "TARGET", "KEY SOURCE", "WRITE POLICY", "DEFAULT"];
      const widths = headers.map((header, index) =>
        Math.max(header.length, ...rows.map((row) => row[index].length)),
      );
      console.log(headers.map((header, index) => header.padEnd(widths[index])).join("  "));
      for (const row of rows) {
        console.log(row.map((value, index) => value.padEnd(widths[index])).join("  "));
      }
      console.log("\n* = default profile");
      console.log(`\nConfig: ${configPath()}`);
    });

  profileCmd
    .command("show")
    .argument("[name]", "Profile name (default: current default)")
    .description("Show one profile (credentials are redacted)")
    .action((name?: string) => {
      const config = loadConfig();
      const profileName = name ?? config.defaultProfile;
      if (!profileName) {
        throw new Error("No profile selected. Pass a profile name or set a default profile.");
      }
      const p = config.profiles[profileName];
      if (!p) {
        throw new Error(`Unknown profile "${profileName}". Run \`convex-profile profile list\`.`);
      }
      console.log(JSON.stringify(
        {
          name: profileName,
          url: p.url,
          deployment: p.deployment,
          credentialSource: getAdminKeySource(p),
          projectDir: p.projectDir,
          writePolicy: p.writePolicy ?? "require-allow-write",
        },
        null,
        2,
      ));
    });

  profileCmd
    .command("use")
    .argument("<name>", "Profile name")
    .description("Set the default profile")
    .action((name: string) => {
      const config = loadConfig();
      if (!config.profiles[name]) {
        console.error(`Unknown profile "${name}"`);
        process.exit(1);
      }
      saveConfig({ ...config, defaultProfile: name });
      console.log(`Default profile: ${name}`);
    });

  profileCmd
    .command("add")
    .argument("[name]", "Profile name (prompted when omitted in a terminal)")
    .option("--url <url>", "Convex API URL (self-hosted)")
    .option("--deployment <ref>", "Convex Cloud deployment reference (instead of --url)")
    .option("--admin-key <key>", "Self-hosted admin key (required with --url)")
    .option(
      "--admin-key-env <var>",
      "Environment variable containing the self-hosted admin key (required with --url)",
    )
    .option("--deploy-key <key>", "Cloud deploy key (prefer --deploy-key-env to keep it out of config)")
    .option(
      "--deploy-key-env <var>",
      "Environment variable containing the Cloud deploy key; passed as CONVEX_DEPLOY_KEY",
    )
    .option("--project-dir <path>", "Default project directory for this profile")
    .addOption(
      new Option("--write-policy <policy>", "Write policy (required for non-interactive setup)")
        .choices([...WRITE_POLICIES]),
    )
    .option("--default", "Set as default profile")
    .description("Add or update a profile (interactive in a terminal)")
    .action(
      async (name: string | undefined, opts: AddProfileOptions) => {
        const added = await promptProfile(name, opts);
        let config = loadConfig();
        config = upsertProfile(config, added.name, added.profile);
        const becomesDefault = added.makeDefault || !config.defaultProfile;
        if (becomesDefault) {
          config.defaultProfile = added.name;
        }
        saveConfig(config);
        const authNote =
          added.profile.deployment && !added.profile.deployKey && !added.profile.deployKeyEnv
            ? "; uses Convex CLI login"
            : "";
        console.log(
          `Saved profile "${added.name}" (${added.profile.writePolicy ?? "require-allow-write"}${becomesDefault ? "; default" : ""}${authNote}) → ${configPath()}`,
        );
      },
    );

  profileCmd
    .command("remove")
    .argument("<name>", "Profile name")
    .option(
      "--confirm <profile-name>",
      "Skip the prompt after exact-name confirmation (required when non-interactive)",
    )
    .description("Remove a saved local profile (does not delete its Convex deployment)")
    .action(async (name: string, opts: { confirm?: string }) => {
      const config = loadConfig();
      if (!config.profiles[name]) {
        console.error(`Unknown profile "${name}"`);
        process.exit(1);
      }

      if (opts.confirm !== undefined && opts.confirm !== name) {
        throw new Error(`Confirmation did not match profile name "${name}". No changes made.`);
      }
      if (opts.confirm === undefined) {
        const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
        if (!interactive) {
          throw new Error(
            `Non-interactive removal requires --confirm "${name}". No changes made.`,
          );
        }
        const answer = await confirm({
          message: `Remove saved profile "${name}"? This will not delete its Convex deployment or revoke its deploy key.`,
          initialValue: false,
        });
        if (isCancel(answer) || !answer) {
          console.log("Profile removal cancelled. No changes made.");
          return;
        }
      }
      const { [name]: _removed, ...rest } = config.profiles;
      const next: typeof config = { ...config, profiles: rest };
      if (next.defaultProfile === name) {
        delete next.defaultProfile;
      }
      saveConfig(next);
      console.log(`Removed profile "${name}"`);
    });

  profileCmd
    .command("edit")
    .argument("<name>", "Profile name")
    .option("--admin-key-env <var>", "Set the self-hosted admin key from this environment variable")
    .option("--deploy-key-env <var>", "Set the Cloud deploy key from this environment variable")
    .description("Update profile credentials without changing its target or settings")
    .action(
      async (
        name: string,
        opts: { adminKeyEnv?: string; deployKeyEnv?: string },
      ) => {
        const config = loadConfig();
        const existing = config.profiles[name];
        if (!existing) {
          throw new Error(`Unknown profile "${name}". Run \`convex-profile profile list\`.`);
        }
        if (opts.adminKeyEnv && opts.deployKeyEnv) {
          throw new Error("Choose --admin-key-env for self-hosted or --deploy-key-env for Cloud.");
        }
        if (existing.url && opts.deployKeyEnv) {
          throw new Error("This profile is self-hosted; use --admin-key-env.");
        }
        if (existing.deployment && opts.adminKeyEnv) {
          throw new Error("This profile targets Cloud; use --deploy-key-env.");
        }

        const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
        if (!interactive && !opts.adminKeyEnv && !opts.deployKeyEnv) {
          const flag = existing.url ? "--admin-key-env" : "--deploy-key-env";
          throw new Error(
            `Non-interactive credential updates require ${flag} <var>. No changes made.`,
          );
        }

        let credentialFields: Partial<Profile>;
        if (existing.url) {
          const parsed = opts.adminKeyEnv
            ? parseAdminKeyInput(`env:${opts.adminKeyEnv}`)
            : parseAdminKeyInput(await promptSecretRequired(
                "Paste replacement self-hosted admin key (or type env:VARIABLE_NAME):",
                "Admin key is required.",
              ));
          credentialFields = parsed;
        } else {
          const parsed = opts.deployKeyEnv
            ? parseDeployKeyInput(`env:${opts.deployKeyEnv}`)
            : parseDeployKeyInput(await promptSecretRequired(
                "Paste replacement Cloud deploy key (or type env:VARIABLE_NAME):",
                "Deploy key is required.",
              ));
          credentialFields = parsed;
        }

        const updated = ProfileSchema.parse({
          ...existing,
          adminKey: undefined,
          adminKeyEnv: undefined,
          deployKey: undefined,
          deployKeyEnv: undefined,
          ...credentialFields,
        });
        saveConfig(upsertProfile(config, name, updated));
        console.log(
          `Updated credentials for profile "${name}" (${getAdminKeySource(updated)}); target and settings kept → ${configPath()}`,
        );
      },
    );

  program
    .command("config-path")
    .description("Print path to profiles config file")
    .action(() => {
      console.log(configPath());
    });

}
