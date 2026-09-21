# pi-delegator

`pi-delegator` is a harness for running [Pi](https://pi.dev/) as a local sub-agent system on top of a LiteLLM/OpenAI-compatible backend.

Its purpose is to turn a base Pi installation into a ready-to-use environment with:

- a main orchestrator
- specialized agents such as `coder`, `researcher`, `tester`, and `reviewer`
- delegation rules and anti-loop limits
- MCP integration so other tools can delegate tasks into Pi
- a clean separation between versioned source code and the generated local installation

In other words, this repository does not reimplement Pi. It prepares, configures, and packages Pi so it can be used as a multi-agent execution engine inside this workspace.

## How It Is Organized

- `pi-delegator/`: the project's versioned source
- `pi-delegator/agents/`: prompts and sub-agent profiles
- `pi-delegator/extensions/`: runtime hooks and guardrails
- `pi-delegator/mcp/`: local MCP server (`server.mjs`) plus the native Pi RPC host client (`pi-rpc-host.mjs`)
- `test/`: versioned `node:test` suites for the MCP contract, write scope, and the RPC host
- `pi-delegator/scripts/`: installation, sync, rendering, and verification
- `.pi-delegator/`: the generated installation and unversioned local state

The model is simple:

- edit and version the source code in `pi-delegator/`
- generate and run the actual installation in `.pi-delegator/`

`.pi-delegator/` contains the generated executable wrappers, rendered configuration, the `pi-subagents` package, session data, and the rest of Pi's local runtime state.

## Quick Start

```bash
PI_SUBAGENTS_PACKAGE=pi-subagents@0.65.0 ./pi-delegator/scripts/install.sh
# Edit .pi-delegator/pi.env with your LiteLLM endpoint and API key.
./.pi-delegator/scripts/check_pi_setup.sh
./.pi-delegator/bin/pi-agent
```

To install `.pi-delegator/` inside another repository or directory:

```bash
PI_SUBAGENTS_PACKAGE=pi-subagents@0.65.0 ./pi-delegator/scripts/install.sh --install-dir /path/to/target-repo
cd /path/to/target-repo
# Edit .pi-delegator/pi.env with your LiteLLM endpoint and API key.
./.pi-delegator/scripts/check_pi_setup.sh
./.pi-delegator/bin/pi-agent
```

The package override is required because `install.sh` still defaults to the legacy `@tintinweb/pi-subagents@0.17.0`, while the checked-in Pi settings and setup check require `pi-subagents@0.65.0`. The installer requires `nvm` and installs Node `22.22.1`, `@earendil-works/pi-coding-agent@0.84.2`, context-mode, and the configured Pi packages. Run `./.pi-delegator/bin/pi` if you want the direct Pi CLI instead of the configured orchestrator.

## Configuration

The installer copies [`pi.env.example`](pi-delegator/pi.env.example) to the target repository's `.pi-delegator/pi.env` only when that file does not exist. Edit **the generated `pi.env` in the target repository** before running the setup check or starting `pi-agent`. It is local, unversioned runtime state; keep the API key there rather than in a tracked config file. The launchers and setup check source this file. Values defined in it override previously exported variables of the same name; use `PI_AGENT_ENV_FILE` to select a different environment file.

| Setting in `.pi-delegator/pi.env` | What it controls |
| --- | --- |
| `LITELLM_BASE_URL`, `LITELLM_API_KEY` | Required gateway URL (absolute `http(s)` URL, usually ending in `/v1`) and API key. The setup check validates connectivity and the available models. |
| `PI_MAIN_MODEL` | Model for `pi-agent`; defaults to `litellm/llm-large`. It must exist in the LiteLLM gateway and the Pi model catalog. |
| `PI_DEFAULT_DELEGATION_SET` | Named set used when an MCP call does not select one; defaults to `default`. |
| `PI_MAX_CONCURRENT`, `MAX_AGENT_TURNS`, `MAX_SUBAGENT_DEPTH` | Rendered into `subagents.json`; defaults are `4`, `20`, and `2`, respectively. |
| `MAX_SUBAGENT_CALLS` | Maximum delegation calls available to the orchestrator; defaults to `12`. |
| `PI_FORCE_CONTEXT_MODE`, `PI_REPOVERITY_REQUIRED` | Tool preflight policy. See [Repository Instruction Preflight](#repository-instruction-preflight) for its current limits. |

Configuration files have different update rules:

| File | Where to edit it and what happens on sync or restart |
| --- | --- |
| [`models.json.template`](pi-delegator/models.json.template) → `.pi-delegator/models.example.json` | Versioned template and refreshed example. On the first `pi-agent` launch, `render_pi_config.mjs` renders `.pi-delegator/models.json` using `LITELLM_BASE_URL` and `LITELLM_API_KEY`. Later launches preserve the active file; after changing the gateway credentials, update or remove the active file to render it again. |
| [`subagents.json.template`](pi-delegator/subagents.json.template) → `.pi-delegator/subagents.json` | `pi-agent` renders the active file on each launch from the three limits above. Change those limits in `pi.env` or change the template for versioned defaults. |
| [`delegation-sets.json`](pi-delegator/delegation-sets.json) → `.pi-delegator/delegation-sets.example.json` | Sync refreshes the example and creates `.pi-delegator/delegation-sets.json` only if absent. Edit the active file for local model routing; reinstalling preserves it. The model IDs in it must match the active model catalog and gateway. |
| [`settings.json`](pi-delegator/settings.json) → `.pi-delegator/settings.json` | Pi package declarations are copied from source on sync. Keep the installed package version aligned with the declaration; the current installer needs `PI_SUBAGENTS_PACKAGE=pi-subagents@0.65.0`. |
| `.pi-delegator/mcp.json` | Managed Pi MCP configuration is regenerated on sync. It registers context-mode and, when configured, RepoVerity. Edit the source workspace's `.vscode/mcp.json` or the RepoVerity environment variables instead of this generated file. |

The source templates and active files serve different purposes. In particular, editing `pi.env` does not update an existing `models.json` automatically. The rendered model file contains the API key, so keep the runtime directory private.

### MCP clients and optional integrations

To register the local `pi-delegator` MCP server in a client, pass one or more flags during installation (also works with `--install-dir DIR`):

```bash
PI_SUBAGENTS_PACKAGE=pi-subagents@0.65.0 ./pi-delegator/scripts/install.sh --all-clients
```

Use `--copilot`, `--codex`, or `--claude` individually. They update the target repository's `.vscode/mcp.json`, `.codex/config.toml`, or `.mcp.json`, respectively. For an existing installation, run `node ./pi-delegator/scripts/configure_clients.mjs --all-clients` from this source repository with `PI_MCP_ALLOWED_ROOT` and `PI_CODING_AGENT_DIR` pointing at the target repository and runtime.

RepoVerity is optional. During sync, the Pi runtime copies the `repoverity` server entry from the target repository's `.vscode/mcp.json` when present. Otherwise, set `PI_REPOVERITY_REPOSITORY`, `PI_REPOVERITY_REMOTE_URL`, and `PI_REPOVERITY_TOKEN_FILE` before sync; `PI_REPOVERITY_COMMAND`, `PI_REPOVERITY_LOGICAL_REF`, and `PI_REPOVERITY_SERVER_NAME` are optional. Environment configuration takes precedence over the VS Code entry. Verify that the server points to the **target repository**. Set `PI_REPOVERITY_REQUIRED=1` to require it during preflight; see the limitation below for the RPC path.

Jev decision routing is off by default. To try it, copy [the example](pi-delegator/jev-config.example.json) to a local JSON file, set `PI_JEV_CONFIG_FILE` to its absolute path in `pi.env`, and set `PI_JEV_MODE=observe` to log recommendations or `PI_JEV_MODE=auto` to apply recommendations that pass the configured thresholds. The example uses OpenRouter and needs `OPENROUTER_API_KEY`; the server also supports a Typesafe provider with `TYPESAFE_API_KEY`. Jev failures fall back to the existing routing behavior. See [the Jev proposal](docs/jev-propuesta.md) for the decisions and modes.

## Example Prompt

Once `pi-agent` is running, you can give it a task like this:

```text
Execute this task using only the `pi-delegator` MCP, with `delegation_set=balanced`
and a target delegation percentage of `50%`.

Analyze the authentication flow in this repository, identify the files involved,
implement the smallest safe fix for any broken token refresh logic, run the
relevant tests, and finish with a summary of changes, risks, and next steps.
```

This kind of prompt works well because it gives Pi a clear objective, a bounded implementation scope, and an expected final output.

If no `delegation_set` is specified, `pi-delegator` uses the `default` set automatically. That set targets `50%` delegation. Its role-specific models and reasoning levels are defined in `pi-delegator/delegation-sets.json`.

## Delegation Sets

- `default`: `50%` delegation; `llm-large` with `xhigh` reasoning for orchestration and implementation, and `llm-medium` with reasoning off for research, tests, and review.
- `balanced`: `60%` delegation, with `llm-medium-devel` at `high` reasoning for implementation.
- `fast`: `75%` delegation, with `low` reasoning for every role.
- `deep`: `90%` delegation, with `high` or `xhigh` reasoning for research, implementation, review, and orchestration.

## Flow

1. `install.sh` installs Pi and creates `.pi-delegator/`.
2. `sync_pi_installation.mjs` refreshes `.pi-delegator/delegation-sets.example.json` and `.pi-delegator/models.example.json`. It creates `delegation-sets.json` from the example only when the active file is missing.
3. When `pi-agent` starts, `render_pi_config.mjs` creates `models.json` from the local environment only when it is missing, and rewrites `subagents.json` from the template and environment limits.
4. `check_pi_setup.sh` validates that Pi, Node, and LiteLLM are operational.
5. `./.pi-delegator/bin/pi-agent` runs the main orchestrator.
6. `./.pi-delegator/bin/pi-mcp` exposes delegation through MCP over a persistent native Pi RPC host.
7. `configure_clients.mjs` registers the local MCP server in Copilot, Codex, and Claude Code when `install.sh` is executed with client flags.

Use `--install-dir DIR` or `--dir DIR` to choose a target repository or directory. The installer creates `DIR/.pi-delegator/`, and the generated MCP wrapper sets `PI_MCP_ALLOWED_ROOT` to `DIR` by default.

## MCP Timeouts

The local MCP server supports both a global timeout and a per-tool-call timeout:

- `PI_MCP_TIMEOUT_SECONDS`: default timeout for delegated MCP runs. If omitted, it defaults to `7200`.
- `timeout_seconds`: optional timeout passed in an individual MCP tool call.

Timeout behavior is:

- timeouts are measured in seconds.
- valid values are `1` through `7200`.
- omitted or invalid `PI_MCP_TIMEOUT_SECONDS` values fall back to `7200`.
- an explicit `timeout_seconds` outside the valid range is rejected. A valid per-call value controls the foreground wait; it does not stop the underlying run when the wait expires.

Subagents must emit their started lifecycle event within `PI_SUBAGENT_START_TIMEOUT_MS` (default and minimum `60000`). When this does not happen, Pi records `delegation_start_timeout` with terminal status `failed` and removes the pending delegation instead of leaving it queued indefinitely. On Pi session shutdown, active runtime sessions are recorded as `interrupted` and removed from the active-session state file.

While a subagent is active, Pi refreshes the active-session state every `PI_ACTIVE_SESSION_HEARTBEAT_MS` (default `15000`). `pi_activity` and the VS Code panel expire a state whose last heartbeat is older than `PI_ACTIVE_SESSION_STALE_MS` (default `90000`), so an abrupt process termination cannot leave a permanent active card.

## Native Pi RPC Execution

Delegations no longer spawn an ephemeral Pi process per call. The MCP server keeps one persistent **Pi RPC host** per server process: it starts on demand, performs a `ping` handshake that requires the `status`, `spawn`, `steer`, `stop`, and `resume` capabilities, and is reused for every subsequent request in that workspace.

- Task tools (`pi_orchestrate`, `pi_research`, `pi_implement`, `pi_tests`, `pi_review`) resolve their delegation options (model, reasoning/thinking, percentage) and then issue a native `spawn`. Foreground calls follow up with `wait` inline; passing `background: true` returns immediately with the run ID (`STATUS: PARTIAL`).
- Run-control tools operate on those stable run IDs:
  - `pi_run_status`: list current runs.
  - `pi_run_wait`: block until a run completes (optional `timeout_ms`).
  - `pi_run_stop`, `pi_run_steer` (`message`), and `pi_run_resume` (`message`) control an in-flight or stopped run. Because the host is persistent, these keep working across MCP tool calls.
- Idempotent requests such as `status` are retried once after a host crash; non-idempotent failures surface to the caller instead of silently restarting work.

The RPC host process and its sessions are configured through environment variables:

| Variable | Purpose |
| --- | --- |
| `PI_MCP_PI_RPC` | Launcher command for the RPC host. Defaults to the same launcher as delegations (`bin/pi-agent`). Point it at a fixture (for example, `node`) in tests. |
| `PI_MCP_RPC_ARGS` | Space-separated arguments passed to the RPC host launcher. Defaults to `--mode rpc`; the smoke test overrides it with `test/fixtures/fake-pi-rpc-host.mjs`. |
| `PI_MCP_RPC_SESSION_ROOT` | Session storage for the host. Defaults to `.pi-delegator/sessions/mcp/`. |
| `PI_MCP_RPC_HANDSHAKE_TIMEOUT_MS` | Handshake timeout in milliseconds (default `90000`, minimum `500`). |
| `PI_MCP_RPC_REQUEST_TIMEOUT_SECONDS` | Per-request timeout in seconds; valid values are `1` through `7200`, defaulting to `7200`. |

## Repository Instruction Preflight

The server has a repository-instruction preflight that reads the target repository's root `AGENTS.md` and checks required MCP tool families. The current MCP `tools/call` delegation path uses the Pi RPC host and does not invoke that preflight. Check the delegated Pi runtime's tools before relying on repository instructions that require RepoVerity or Context Mode.

context-mode is managed by this runtime: `settings.json` declares `npm:context-mode`, `.pi-delegator/mcp.json` registers the MCP server command, and `install.sh` installs the `context-mode` CLI that Pi uses to start the server. When those files are present and the CLI is on `PATH`, all `ctx_*` tools are treated as available by the preflight.

`PI_FORCE_CONTEXT_MODE=1` is the default for the preflight, but it is not currently enforced by the RPC delegation path. Agent profiles list their allowed tools, including `ctx_*` tools and, for writer profiles, `edit`/`write`.

RepoVerity is integrated when available, but optional by default. The configuration sources and required variables are described in [MCP clients and optional integrations](#mcp-clients-and-optional-integrations).

As an escape hatch for tool families managed outside pi-delegator, verified tools can still be declared with either environment variable:

```bash
PI_AVAILABLE_EXTERNAL_TOOLS=code_index_status,code_retrieve,code_search_exact
PI_AVAILABLE_MCP_TOOLS=code_index_status,code_retrieve,code_search_exact
```

Only set these after confirming the spawned Pi process can actually call those tools. These declarations affect preflight availability checks; they do not install tools.

## Default Pi Packages

`pi-delegator/settings.json` declares these Pi packages:

- `pi-subagents@0.65.0`: native agent delegation and async run control.
- `context-mode`: context-efficient repository inspection and command execution through `ctx_*` MCP tools.
- `pi-lens@4.1.3`: LSP, lint, formatting, type-checking, and structural diagnostics.
- `@juicesharp/rpiv-ask-user-question@2.9.0`: structured clarification questions in interactive sessions.
- `pi-web-access@0.27.0`: public web search, direct HTTP content extraction, and source verification for researcher profiles.

`install.sh` currently defaults to the legacy `@tintinweb/pi-subagents@0.17.0` independently of `settings.json`. Set `PI_SUBAGENTS_PACKAGE=pi-subagents@0.65.0` during installation, as shown above. The setup check verifies the package declaration, installed `pi-subagents` package, minimum version, and required public exports.

### Sub-Agent Package Policy

Sub-agent access is explicit rather than inherited implicitly. Each profile declares both the extension to load and the extension tool exposed to its model:

- all eight specialist profiles load `pi-lens` and expose `lens_diagnostics`.
- `coder`, `tester`, and `reviewer`, including their MCP variants, must call `lens_diagnostics` with `mode=all` before finishing and must resolve or report blocking diagnostics.
- interactive profiles expose `ask_user_question` when clarification is required.
- MCP profiles do not expose `ask_user_question`, because delegated MCP runs have no interactive UI and the extension rejects UI-less calls.
- researcher profiles expose `web_search`, `fetch_content`, and `source_check` for public HTTP(S) sources only. The managed configuration uses explicit keyless DuckDuckGo search, direct HTTP fetches, no browser cookies, no hosted fetch providers, and disables GitHub cloning, PR/issue specialization, YouTube, and local video analysis.
- `pi-agent-runtime` remains loaded for lifecycle logging, MCP bridging, delegation policy, and safety checks.

Run the setup check after changing packages or agent frontmatter:

```bash
./.pi-delegator/scripts/check_pi_setup.sh
```

Successful enforcement includes these checks:

```text
OK   required Pi packages
OK   subagent extension policy
OK   web access hardening
PI SETUP: OK
```

## Requirements

- `nvm`
- Node `22.22.1`
- `@earendil-works/pi-coding-agent` (installed by `install.sh`)
- a LiteLLM/OpenAI-compatible gateway configured in `.pi-delegator/pi.env`

## Useful Commands

- install: `PI_SUBAGENTS_PACKAGE=pi-subagents@0.65.0 ./pi-delegator/scripts/install.sh`
- verify: `./.pi-delegator/scripts/check_pi_setup.sh` (after editing `.pi-delegator/pi.env`)
- Pixel Agents smoke test: `node ./pi-delegator/scripts/test_pixel_agents.mjs`
- Pixel Agents smoke test against an external install: `node ./pi-delegator/scripts/test_pixel_agents.mjs --launcher /path/to/bin/pi-agent`
- Clear stale Pixel Agents sessions: `node ./pi-delegator/scripts/clear_pixel_agents_sessions.mjs`
- Install live VS Code activity view: `./pi-delegator/scripts/install.sh --activity-view`
- run the test suite (MCP contract, write scope, RPC host): `npm test`
- end-to-end MCP stdio smoke against the fixture RPC host: `npm run test:mcp-smoke`
- direct Pi CLI: `./.pi-delegator/bin/pi`
- main agent: `./.pi-delegator/bin/pi-agent`
- local MCP server: `./.pi-delegator/bin/pi-mcp`

If you use Pixel Agents, `pi-delegator` emits lifecycle events using the `claude` hook by default so the agent activity is visible in the existing Pixel Agents UI. Override this with `PI_PIXEL_AGENTS_PROVIDER` if your setup uses a different hook name.

Agent runtime logs are written under `PI_AGENT_LOG_DIR` when set, or under the local Pi logs directory by default. The runtime keeps the aggregate `pi-agents.jsonl` file and also writes one independent log per agent under `agents/<agent>/events.jsonl`, for example `agents/coder-mcp/events.jsonl` or `agents/reviewer/events.jsonl`. Each agent folder also gets a `stdout.log` file with the final stdout captured from every completed or failed run for that agent, plus a `stderr.log` file when the runtime receives an error payload for that run.

If a client or host terminates Pi before its subagent lifecycle completes, run `node ./.pi-delegator/scripts/clear_pixel_agents_sessions.mjs` from the target workspace. It closes the visual Pixel Agents session, deletes stale transcripts, and reconciles `pixel-agents-active-sessions.json` so the activity panel and `pi_activity` no longer show a ghost subagent.

From Copilot chat, call the `pi_activity` MCP tool to inspect active subagents and recent lifecycle events without leaving VS Code. It accepts optional `task_id` and `agent` filters plus a `limit` from 1 to 100. For example, ask Copilot: `Use pi_activity to show the active Pi subagents and the last 20 events.` The tool reads local runtime logs only and does not call a model.

Delegated MCP calls emit `notifications/progress` while Pi is running when the client provides a progress token. Compatible Copilot clients render those lifecycle updates on the active MCP call. For a persistent per-agent view, install the Pi Delegator Activity extension with `--activity-view`; it adds a Pi Delegator section to the VS Code activity bar and refreshes automatically when `.pi-delegator/logs/pi-agents.jsonl` changes. When Pi runs in a different workspace, use the panel's `Select Pi Delegator Runtime Log` button and choose that workspace's `.pi-delegator/logs/pi-agents.jsonl` once; the selected path is saved in workspace settings.

## What This Repo Provides

- predefined agent profiles
- per-role model routing
- LiteLLM integration
- reproducible installation
- clear separation between source code and generated runtime
- a stable entry point for using Pi as a task delegator
