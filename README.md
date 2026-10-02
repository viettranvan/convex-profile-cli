# convex-profile-cli

Named **Convex deployment profiles** for self-hosted URLs and Convex Cloud, with thin wrappers around the official [`convex`](https://www.npmjs.com/package/convex) CLI: `run`, `data`, `logs`, `env`, and more.

Manage local, self-hosted, and Convex Cloud deployments through named profiles in one local config file.

## Install

```bash
npm install -g convex-profile-cli
```

The official `convex` CLI ships as a dependency of this package. You do not
install it separately. If the selected project already has its own `convex`
dependency, that copy is used; otherwise the bundled copy is used.

### Source layout

`src/cli.ts` creates the Commander program. `src/core/types.ts` holds the
credential and write-policy types shared by the transports. The feature modules
are grouped by responsibility:

- `src/profiles/`: profile schema, local config storage, credential resolution,
  key input, wizard, and profile commands.
- `src/convex/`: official CLI process, table lookup, CLI write policy, and
  command dispatch.
- `src/mcp/`: profile-bound MCP server, target selection, write approval,
  table-result parsing, and shared result helpers.
- `src/dashboard/`: release lookup (tag or commit SHA), download/cache, and the
  loopback servers for the official self-hosted dashboard files and auto-login.

Tests live next to their modules. `npm test` passes the quoted recursive glob to
Node so tests in nested feature folders are included.

## Config

Profiles live at `~/.config/convex-profile-cli/config.json`.

In a terminal, start the setup wizard with:

```bash
convex-profile profile add
```

The profile name is a local alias for a target, such as `local`, `dev`, or `staging`; it does not select a Convex project or deployment by itself. The wizard asks you to choose **self-hosted** or **Cloud**. For self-hosted, enter the Convex API URL and admin key (or `env:VARIABLE_NAME`). For Cloud, enter the deployment reference shown in the dashboard (for example `dev/your-username`), then choose either your existing Convex CLI login or a deployment-scoped Cloud deploy key. Cloud does not need a URL.

Target type, Cloud authentication, and write policy use arrow-key selection menus; press Enter to choose. Admin-key and deploy-key input is masked while typing. A directly pasted key is stored in the local config file; use `env:VARIABLE_NAME` to keep the key value out of that file. The config directory and file are saved with owner-only permissions on macOS/Linux. `profile list` and `profile show` never print key values or environment-variable names.

A Cloud profile using a deploy key stores the deployment reference and the name of the environment variable holding the secret. A complete config has this shape:

```json
{
  "defaultProfile": "dev-cloud",
  "profiles": {
    "dev-cloud": {
      "deployment": "dev/your-username",
      "deployKeyEnv": "CONVEX_DEV_DEPLOY_KEY",
      "projectDir": "/path/to/your/app",
      "writePolicy": "require-allow-write"
    }
  }
}
```

At runtime, the profile CLI reads `CONVEX_DEV_DEPLOY_KEY` and passes its value to Convex CLI as `CONVEX_DEPLOY_KEY`. Set the variable in the shell or secret manager used to launch the CLI. If the profile has no deploy key, Cloud authentication uses the machine's existing `npx convex login` session.

The wizard also asks for a write policy: `allow`, `require-allow-write`, or `read-only` (default: `require-allow-write`). The policy is enforced by both the CLI wrapper and the profile-bound MCP server. The first profile becomes the default automatically. If no `--project-dir` is set, Convex runs in the current directory.

For scripts and agents, pass the profile name, target, and write policy as flags (no prompts). Self-hosted URL targets require an admin key. Cloud targets can use the user's Convex CLI login, or a deploy key supplied with `--deploy-key-env`. The named environment variable is mapped to `CONVEX_DEPLOY_KEY` when the profile runs:

```bash
# Self-hosted profile
convex-profile profile add local \
  --url http://127.0.0.1:3210 \
  --admin-key-env CONVEX_LOCAL_ADMIN_KEY \
  --write-policy allow \
  --project-dir /path/to/your/app \
  --default

convex-profile profile add dev \
  --url https://api.example.com \
  --admin-key-env CONVEX_DEV_ADMIN_KEY \
  --write-policy allow

convex-profile profile add staging \
  --url https://staging.example.com \
  --admin-key-env CONVEX_STAGING_ADMIN_KEY \
  --write-policy require-allow-write

# Convex Cloud, using an existing `npx convex login` session
convex-profile profile add dev-cloud \
  --deployment dev/your-username \
  --write-policy require-allow-write \
  --project-dir /path/to/your/app

# For an agent/CI without a Convex login, scope a deploy key to this deployment
convex-profile profile add dev-agent \
  --deployment dev/your-username \
  --deploy-key-env CONVEX_DEV_DEPLOY_KEY \
  --write-policy require-allow-write \
  --project-dir /path/to/your/app

convex-profile profile list
convex-profile profile list --json
convex-profile profile use dev

# Rotate a stored self-hosted admin key (masked prompt)
convex-profile profile edit local

# Non-interactive key rotation uses an environment variable reference
convex-profile profile edit local --admin-key-env CONVEX_LOCAL_ADMIN_KEY_ROTATED
convex-profile profile edit dev-agent --deploy-key-env CONVEX_DEV_DEPLOY_KEY

# In a terminal, remove asks for yes/no confirmation
convex-profile profile remove dev-agent

# Non-interactive removal requires repeating the exact profile name
convex-profile profile remove dev-agent --confirm dev-agent
```

`profile list --json` reports profile names, target, credential source, write policy, and default status. It never prints a key value or an environment-variable name.

`profile edit <name>` replaces the profile's credential while keeping its target, project directory, write policy, and default status. In a terminal, paste the replacement key into the masked prompt or enter `env:VARIABLE_NAME`. For non-interactive use, pass `--admin-key-env` for self-hosted or `--deploy-key-env` for Cloud. If a profile already references an environment variable, rotating that variable's value does not require editing the profile.

In a terminal, `profile remove <name>` asks for yes/no confirmation, defaulting to No. In non-interactive use, pass `--confirm <name>` with the exact same profile name. A missing or mismatched confirmation makes no changes. Removal deletes only the local profile entry (and clears it as the default if applicable); it does not delete the Convex deployment or revoke its deploy key.

## Usage

Global profile flag (or set default with `profile use`):

```bash
convex-profile -e local run routes/rbac:syncRoles '{}'
convex-profile -e local data users --limit 5 --format jsonl
convex-profile -e local logs --history 50
convex-profile -e local env list
```

### Self-hosted dashboard

This replaces running the `convex-dashboard` Docker container. Cloud profiles
use the official `npx convex dashboard` command instead.

**Version.** One dashboard version is shared by all self-hosted profiles. It
must match the backend image, because Convex
[recommends matching backend and dashboard versions](https://github.com/get-convex/convex-backend/blob/main/self-hosted/CHANGELOG.md)
and `latest` is not accepted. Pass the release tag, or the commit SHA used as
the backend Docker image tag (`ghcr.io/get-convex/convex-backend:<sha>`); a SHA
is resolved through the `precompiled-*` tags of `get-convex/convex-backend` on
GitHub. `version set` checks that the release has `dashboard.zip` but does not
download it:

```bash
convex-profile dashboard version set precompiled-2026-01-29-483f94d
convex-profile dashboard version set 483f94d26687b7f3354804bf23849df4f681cfc1
# Resolved commit 483f94d… to release precompiled-2026-01-29-483f94d.
convex-profile dashboard version show
```

The first `dashboard` run downloads and extracts the ZIP into
`~/.cache/convex-profile-cli/dashboard/<release-tag>/`; later runs use the
cache. After a backend upgrade, set the new matching version.

**Open.**

```bash
convex-profile -e local dashboard                # http://127.0.0.1:6790
convex-profile -e dev dashboard --port 6791      # a second dashboard in parallel
convex-profile -e local dashboard --no-open --manual-login
```

The dashboard server listens only on `127.0.0.1` (default port `6790`) and
rejects requests with another `Host` header. To open several profiles at once,
run one command per profile with different `--port` values; each port is a
separate browser origin, so their logins do not mix. Press `Ctrl+C` to stop the
servers and release the ports (`Ctrl+Z` only suspends the process and keeps the
port busy; use `fg` then `Ctrl+C`, or `kill <pid>`).

Browser: if `$BROWSER` is set, it opens the URL. Otherwise a Cursor/VS Code
terminal (`TERM_PROGRAM=vscode`) only prints the URL, so Cmd/Ctrl+Click opens it
in the IDE; other terminals open the system default browser. `--no-open` only
prints the URL.

**Login.** The dashboard logs in automatically through the same `?a=<port>&d=<name>`
lookup used by `convex dev --local`. While the command runs, a second server on
a random `127.0.0.1` port returns the profile's URL and admin key only to `GET`
requests from the dashboard origin. The URL carries the port, never the key,
and nothing is written to the clipboard or files. Any local process can still
query that port while the dashboard is open. The login lives in the tab's
`sessionStorage`, so open the printed URL with its query string: replacing the
host (`127.0.0.1` ↔ `localhost`) or dropping `?a=…` shows the login form again.
Pass `--manual-login` to skip the login server and type the URL and admin key
yourself.

**Write policy.** A `read-only` profile cannot open the dashboard because the
browser can write directly to Convex. `require-allow-write` asks for interactive
approval once; `allow` opens without a prompt. Both print that later dashboard
actions bypass the wrapper's write policy.

Before `data <table>` reads, `convex-profile` checks the table name against the selected deployment's table list. An exact name is used as entered; one unique close match is corrected with a notice (for example, `trimester` → `trimesters`). If the name is missing or has multiple close matches, the read stops and prints suggestions. The list is checked internally, so the full table inventory is not added to the agent's output. MCP keeps a per-deployment table-name cache for five minutes and refreshes it when a name does not match or a read returns an empty page.

Arbitrary convex subcommand:

```bash
convex-profile passthrough function-spec
```

### Write policy

For a `require-allow-write` profile, every write-capable or unclassified CLI command asks for approval in the terminal. The prompt names the profile and target and defaults to No. If the command has no interactive terminal, it is denied. No command-line flag can approve the write on the user's behalf.

| Profile policy | CLI behavior | MCP behavior |
|---------------|--------------|--------------|
| `allow` | Write commands run without wrapper approval. Recognized destructive actions still require their target confirmation; data replacement imports also prompt interactively. | Write tools pass through without an extra wrapper prompt. Convex MCP's production restrictions still apply. |
| `require-allow-write` | Write-capable or unknown commands require an interactive terminal confirmation. Non-interactive commands are denied. | Each write-capable or unknown tool call asks for approval through MCP elicitation. If the client cannot show the approval form, the call is denied. |
| `read-only` | Only recognized read commands run. `run --inline-query` is allowed; regular `run` is treated as a possible mutation. | Write tools are disabled and checked again at call time. `runOneoffQuery` remains available as a read-only query tool. |

The CLI cannot determine whether a named `run` function is a query, mutation, or action, so it treats `run <function>` as a write. `passthrough` is read-only only for commands the wrapper recognizes as reads; unknown passthrough commands are denied on read-only profiles and require terminal confirmation on `require-allow-write` profiles.

Recognized destructive operations need exact target confirmation. Import replacement also asks for an interactive approval; a non-interactive invocation is denied:

```bash
# env remove asks for terminal approval on require-allow-write profiles and checks the exact variable name
convex-profile -e staging --confirm-destructive PAYMENT_API_KEY env remove PAYMENT_API_KEY

# replacing imported data asks for terminal approval and checks the selected profile name
convex-profile -e staging --confirm-destructive staging import --replace-all backup.zip
```

Profile removal continues to use its own exact-name `profile remove <name> --confirm <name>` confirmation. For arbitrary mutations through `run`, the wrapper can require write approval but cannot infer which records the function may delete.

### MCP server per profile

Run one MCP entry per profile. `convex-profile mcp start` is the **outer**
MCP server your IDE talks to. It spawns the official `convex mcp start` child
for that profile and forwards tool calls after write-policy checks:

```bash
convex-profile -e local mcp start
```

The outer server is bound to the selected profile's target, credentials,
project directory (or the current directory if the profile has none), and write
policy. It rejects tool calls whose `deploymentSelector` does not match that
profile, and filters `status` so `availableDeployments` lists only the selected
target. There is no shared “current profile” inside one process, so add a
separate MCP server entry for each profile you want at the same time. Cloud
profiles with a deploy key pass `CONVEX_DEPLOY_KEY` to the child; Cloud
profiles without one use the Convex CLI login. Self-hosted credentials go
through a private temporary `--env-file` (restrictive permissions, removed when
the MCP server exits). Production override flags are never enabled
automatically.

Example Cursor / VS Code MCP configuration (after `npm install -g
convex-profile-cli`):

```json
{
  "mcpServers": {
    "convex-local": {
      "command": "convex-profile",
      "args": ["-e", "local", "-C", "/path/to/your/app", "mcp", "start"]
    },
    "convex-dev": {
      "command": "convex-profile",
      "args": ["-e", "dev", "-C", "/path/to/your/app", "mcp", "start"]
    }
  }
}
```

Pass `-C` (or set the profile's `projectDir`) so MCP does not depend on the
IDE's working directory. If the IDE was launched from the macOS GUI and
`convex-profile` is not on its `PATH`, use absolute paths to `node` and the
installed `dist/cli.js` (global install or clone):

```json
"convex-dev": {
  "command": "/Users/you/.nvm/versions/node/v22.21.0/bin/node",
  "args": [
    "/Users/you/.nvm/versions/node/v22.21.0/lib/node_modules/convex-profile-cli/dist/cli.js",
    "-e",
    "dev",
    "-C",
    "/path/to/your/app",
    "mcp",
    "start"
  ]
}
```

For a `require-allow-write` profile, the MCP client must support form elicitation for write approvals. Each modern-protocol approval is signed, expires after ten minutes, and is bound to the exact tool and arguments shown to the user; it can authorize one call only. If the client cannot collect approval, write calls fail closed. A `read-only` profile removes write tools from the official server and the wrapper also rejects calls to them. Convex MCP independently restricts production deployments by default; wrapper approvals do not turn off that protection.

## Commands

| Command | Description |
|--------|-------------|
| `profile add/list/use/show/edit/remove` | Manage profiles; `add` supports a terminal wizard and non-interactive flags |
| `run`, `data`, `logs`, `env`, … | Forward to the official Convex CLI with profile credentials |
| `passthrough` | Official Convex CLI with arbitrary args |
| `mcp start` | Start the official Convex MCP server behind a profile-aware write-policy proxy |
| `dashboard version set <tag-or-sha>` / `version show` | Resolve and save the shared self-hosted dashboard release, or print it |
| `dashboard [--port] [--no-open] [--manual-login]` | Open the self-hosted dashboard with auto-login; Cloud uses the official CLI |
| `config-path` | Print config file location |

## Compatibility

This package is **not** affiliated with Convex. CLI commands run the `convex`
binary from the selected project or from this package, with `--url` /
`--admin-key` for self-hosted profiles, or a Cloud deployment reference. MCP
uses Convex's `--env-file` for self-hosted credentials so the admin key does not
appear in process arguments. For Cloud deploy-key profiles, the wrapper sets
`CONVEX_DEPLOY_KEY` in the child process environment; Convex CLI uses that key
to scope the Cloud deployment. The self-hosted dashboard is the unmodified
`dashboard.zip` from Convex's GitHub releases, served locally.

## License

MIT
