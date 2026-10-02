import { Command } from "commander";
import { confirm, isCancel } from "@clack/prompts";

import { targetLabel } from "../core/types.js";
import { runConvex } from "../convex/spawn.js";
import { requestInteractiveWriteApproval } from "../convex/write-approval.js";
import { loadConfig, saveConfig } from "../profiles/config-store.js";
import { resolveProfile } from "../profiles/credentials.js";
import { checkDashboardRelease, ensureDashboardDownloaded, resolveDashboardReleaseTag } from "./download.js";
import { serveDashboard } from "./server.js";

export function registerDashboardCommands(program: Command): void {
  const dashboard = program
    .command("dashboard")
    .description("Open the Convex dashboard for the selected profile (self-hosted: local server; Cloud: official CLI)")
    .addHelpText(
      "after",
      `
Self-hosted profiles serve the official dashboard build for the shared release
tag on 127.0.0.1. The ZIP is downloaded once per tag into
~/.cache/convex-profile-cli/dashboard/<release-tag>/.

Login: the dashboard logs in automatically. A second 127.0.0.1 server on a
random port hands the profile's URL and admin key only to the dashboard origin
while this command runs; the key never appears in the URL. Pass --manual-login
to type the deployment URL and admin key yourself.

Browser: $BROWSER is used when set. Otherwise, inside a Cursor/VS Code
terminal the URL is only printed (Cmd/Ctrl+Click opens it in the IDE);
elsewhere the system default browser opens.

Write policy: read-only profiles cannot open the dashboard. require-allow-write
asks for approval once; allow prints a warning. Changes made in the dashboard
bypass the CLI write policy.

Examples:
  convex-profile dashboard version set precompiled-2026-01-29-483f94d
  convex-profile dashboard version set 483f94d26687b7f3354804bf23849df4f681cfc1
  convex-profile dashboard version show
  convex-profile -e sit-local dashboard
  convex-profile -e sit-dev dashboard --port 6791 --no-open`,
    );
  const version = dashboard
    .command("version")
    .description("Show or set the dashboard release tag shared by all self-hosted profiles");

  version.command("set <release-tag-or-sha>")
    .description("Resolve the release, check that it has dashboard.zip, then save it as the shared tag (no download yet)")
    .addHelpText(
      "after",
      `
Pass either the release tag (precompiled-2026-01-29-483f94d) or the commit SHA
used as the backend Docker image tag (483f94d26687b7f3354804bf23849df4f681cfc1,
at least 7 characters). A SHA is looked up in the get-convex/convex-backend
release tags on GitHub. "latest" is not accepted because Convex does not
guarantee compatibility between different backend and dashboard versions.`,
    )
    .action(async (input: string) => {
      const tag = await resolveDashboardReleaseTag(input);
      if (tag !== input.trim()) process.stdout.write(`Resolved commit ${input.trim()} to release ${tag}.\n`);
      await checkDashboardRelease(tag);
      const config = loadConfig();
      saveConfig({ ...config, dashboardVersion: tag });
      process.stdout.write(`Dashboard version set to ${tag}. The ZIP will download when you open a dashboard.\n`);
    });

  version.command("show")
    .description("Print the shared dashboard release tag, or how to set one")
    .action(() => {
      const tag = loadConfig().dashboardVersion;
      process.stdout.write(tag ? `${tag}\n` : "No dashboard version set. Run `convex-profile dashboard version set <release-tag>`.\n");
    });

  dashboard.option("--port <number>", "Port for the self-hosted dashboard server on 127.0.0.1", "6790")
    .option("--no-open", "Print the dashboard URL without opening a browser")
    .option("--manual-login", "Do not pass the admin key to the dashboard; log in by hand")
    .action(async (options: { port: string; open: boolean; manualLogin?: boolean }) => {
      const port = Number(options.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("Dashboard port must be an integer from 1 to 65535.");
      }

      const config = loadConfig();
      const opts = program.opts<{ profile?: string; projectDir?: string }>();
      const creds = resolveProfile(config, opts.profile);
      if (opts.projectDir) creds.projectDir = opts.projectDir;

      if (creds.url && !config.dashboardVersion) {
        throw new Error("No dashboard version set. Run `convex-profile dashboard version set <release-tag>` first.");
      }

      if (creds.writePolicy === "read-only") {
        throw new Error(`Profile "${creds.profileName}" is read-only. Dashboard access is denied because its UI can write directly to Convex.`);
      }
      if (creds.writePolicy === "require-allow-write") {
        await requestInteractiveWriteApproval({
          interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
          profileName: creds.profileName,
          target: targetLabel(creds),
          operation: "open the dashboard (later UI writes bypass the CLI write policy)",
          prompt: async (message) => {
            const answer = await confirm({ message, initialValue: false });
            return !isCancel(answer) && answer;
          },
        });
      } else {
        process.stderr.write(
          `Warning: changes made in the dashboard bypass the CLI write policy for profile "${creds.profileName}".\n`,
        );
      }

      if (creds.deployment) {
        const code = await runConvex(creds, ["dashboard"]);
        process.exitCode = code;
        return;
      }
      if (!creds.url) throw new Error("The selected profile has no self-hosted URL.");
      if (!config.dashboardVersion) throw new Error("No dashboard version set.");
      process.stdout.write(`Preparing Convex dashboard ${config.dashboardVersion}...\n`);
      const directory = await ensureDashboardDownloaded(config.dashboardVersion);
      await serveDashboard({
        directory,
        port,
        backendUrl: creds.url,
        profileName: creds.profileName,
        adminKey: options.manualLogin ? undefined : creds.adminKey,
        open: options.open,
      });
      process.exit(0);
    });
}
