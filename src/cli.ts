import { Command } from "commander";

import { registerConvexCommands } from "./convex/commands.js";
import { registerDashboardCommands } from "./dashboard/commands.js";
import { registerProfileCommands } from "./profiles/commands.js";

async function main(): Promise<void> {
  const program = new Command();

  program
    .name("convex-profile")
    .description(
      "Named Convex deployment profiles and wrappers around the official `npx convex` CLI.",
    )
    .version("0.1.0")
    .option("-e, --profile <name>", "Profile to use (overrides default)")
    .option(
      "-C, --project-dir <path>",
      "Working directory for convex (overrides profile projectDir)",
    )
    .option(
      "--confirm-destructive <target>",
      "Confirm a recognized destructive target, such as an env variable or profile name",
    )
    .showHelpAfterError();

  registerProfileCommands(program);
  registerConvexCommands(program);
  registerDashboardCommands(program);

  await program.parseAsync(process.argv);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});
