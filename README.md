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
- `pi-delegator/mcp/`: local MCP server
- `pi-delegator/scripts/`: installation, sync, rendering, and verification
- `.pi-delegator/`: the generated installation and unversioned local state

The model is simple:

- edit and version the source code in `pi-delegator/`
- generate and run the actual installation in `.pi-delegator/`

`.pi-delegator/` contains the generated executable wrappers, rendered configuration, the `pi-subagents` package, session data, and the rest of Pi's local runtime state.

## Quick Start

```bash
./pi-delegator/scripts/install.sh
./.pi-delegator/scripts/check_pi_setup.sh
./.pi-delegator/bin/pi-agent
./.pi-delegator/bin/pi
```

To install `.pi-delegator/` inside another repository or directory:

```bash
./pi-delegator/scripts/install.sh --install-dir /path/to/target-repo
cd /path/to/target-repo
./.pi-delegator/scripts/check_pi_setup.sh
./.pi-delegator/bin/pi-agent
./.pi-delegator/bin/pi
```

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

If no `delegation_set` is specified, `pi-delegator` uses the `default` set automatically. That set targets `50%` delegation and uses `llm-large` with `medium` reasoning for every role.

## Delegation Sets

- `default`: the safest general-purpose option. It uses `llm-large` with `medium` reasoning for every role and targets `50%` delegation when you do not specify anything else.
- `balanced`: a mixed profile for normal development work. It keeps the orchestrator strong, gives implementation more reasoning depth, and is a good default when you want active delegation without going all-in.
- `fast`: optimized for speed and lower reasoning cost. Use it for lighter tasks, quick inspections, or cases where turnaround matters more than depth.
- `deep`: optimized for heavy analysis and more ambitious delegation. Use it for harder implementation, broader reviews, or tasks where extra reasoning is worth the additional cost and latency.

If you also want the installer to configure local MCP clients, use one of these flags:

```bash
./.pi-delegator/scripts/install.sh --copilot
./.pi-delegator/scripts/install.sh --codex
./.pi-delegator/scripts/install.sh --claude
./.pi-delegator/scripts/install.sh --all-clients
```

This updates:

- `.vscode/mcp.json` for GitHub Copilot in VS Code
- `.codex/config.toml` for Codex
- `.mcp.json` for Claude Code in VS Code

## Flow

1. `install.sh` installs Pi and creates `.pi-delegator/`.
2. `sync_pi_installation.mjs` copies only what Pi needs into `.pi-delegator/`.
3. `render_pi_config.mjs` generates `models.json` and `subagents.json` from the local environment.
4. `check_pi_setup.sh` validates that Pi, Node, and LiteLLM are operational.
5. `./.pi-delegator/bin/pi-agent` runs the main orchestrator.
6. `./.pi-delegator/bin/pi-mcp` exposes delegation through MCP.
7. `configure_clients.mjs` can register the local MCP server in Copilot, Codex, and Claude Code when `install.sh` is executed with client flags.

Use `--install-dir DIR` or `--dir DIR` to choose a target repository or directory. The installer creates `DIR/.pi-delegator/`, and the generated MCP wrapper sets `PI_MCP_ALLOWED_ROOT` to `DIR` by default.

## MCP Timeouts

The local MCP server supports both a global timeout and a per-tool-call timeout:

- `PI_MCP_TIMEOUT_SECONDS`: default timeout for delegated MCP runs. If omitted, it defaults to `7200`.
- `timeout_seconds`: optional timeout passed in an individual MCP tool call.

Timeout behavior is:

- timeouts are measured in seconds.
- valid values are `1` through `7200`.
- omitted, invalid, or `0` timeout values fall back to `7200`.
- `PI_MCP_TIMEOUT_SECONDS` acts as the maximum allowed timeout for any individual tool call.

Subagents must emit their started lifecycle event within `PI_SUBAGENT_START_TIMEOUT_MS` (default and minimum `60000`). When this does not happen, Pi records `delegation_start_timeout` with terminal status `failed` and removes the pending delegation instead of leaving it queued indefinitely. On Pi session shutdown, active runtime sessions are recorded as `interrupted` and removed from the active-session state file.

While a subagent is active, Pi refreshes the active-session state every `PI_ACTIVE_SESSION_HEARTBEAT_MS` (default `15000`). `pi_activity` and the VS Code panel expire a state whose last heartbeat is older than `PI_ACTIVE_SESSION_STALE_MS` (default `90000`), so an abrupt process termination cannot leave a permanent active card.

## Repository Instruction Preflight

Before delegating work, the MCP server reads the target repository's root `AGENTS.md` when present. If those instructions require external MCP/tool families such as RepoVerity (`code_index_status`, `code_retrieve`, `code_search_exact`) or context-mode (`ctx_execute`, `ctx_batch_execute`), delegation is blocked unless the Pi runtime has those tools configured.

context-mode is managed by this runtime: `settings.json` installs `npm:context-mode`, `mcp.json` registers the MCP server command, and `install.sh` installs the `context-mode` CLI that Pi uses to start the server. When those files are present and the CLI is on `PATH`, all `ctx_*` tools are treated as available.

Context Mode is forced by default (`PI_FORCE_CONTEXT_MODE=1`). The MCP server requires `ctx_execute` and `ctx_batch_execute` before delegating, even when the target repository has no explicit context-mode rule. Delegated researcher/reviewer agents only receive `ctx_*` tools; coder/tester agents receive `ctx_*` plus `edit`/`write` for bounded file changes. Set `PI_FORCE_CONTEXT_MODE=0` only for an intentional local bypass.

RepoVerity is disabled by default (`PI_REPOVERITY_ENABLED=0`). Set it to `1` to integrate the gateway during sync; pi-delegator then copies a `repoverity` server from the target workspace's `.vscode/mcp.json` into the Pi runtime `mcp.json`. If no workspace MCP entry exists, set `PI_REPOVERITY_REPOSITORY`, `PI_REPOVERITY_REMOTE_URL`, `PI_REPOVERITY_TOKEN_FILE`, and optionally `PI_REPOVERITY_COMMAND`, `PI_REPOVERITY_LOGICAL_REF`, or `PI_REPOVERITY_SERVER_NAME` before running `sync_pi_installation.mjs` or `install.sh`. Set `PI_REPOVERITY_REQUIRED=1` only when enabled and missing RepoVerity should block delegation.

As an escape hatch for tool families managed outside pi-delegator, verified tools can still be declared with either environment variable:

```bash
PI_AVAILABLE_EXTERNAL_TOOLS=code_index_status,code_retrieve,code_search_exact
PI_AVAILABLE_MCP_TOOLS=code_index_status,code_retrieve,code_search_exact
```

Only set these after confirming the spawned Pi process can actually call those tools. Otherwise the safer behavior is to return `STATUS: BLOCKED` and report the missing MCP/tool names.

## Default Pi Packages

The generated runtime installs these packages by default:

- `@tintinweb/pi-subagents@0.17.0`: agent delegation, parallel workflows, nested-agent limits, and per-agent extension/tool scoping.
- `context-mode`: context-efficient repository inspection and command execution through `ctx_*` MCP tools.
- `pi-lens@4.1.3`: LSP, lint, formatting, type-checking, and structural diagnostics.
- `@juicesharp/rpiv-ask-user-question@2.9.0`: structured clarification questions in interactive sessions.
- `pi-web-access@0.27.0`: public web search, direct HTTP content extraction, and source verification for researcher profiles.

The package list is pinned in `pi-delegator/settings.json`. `install.sh` installs the same packages into `.pi-delegator/npm`, and `check_pi_setup.sh` verifies both the declarations and installed package files.

### Sub-Agent Package Policy

Sub-agent access is explicit rather than inherited implicitly. Each profile declares both the extension to load and the extension tool exposed to its model:

- all eight profiles load `pi-lens` and expose `lens_diagnostics`.
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
- `@earendil-works/pi-coding-agent`
- a LiteLLM/OpenAI-compatible gateway configured in `.pi-delegator/pi.env`

## Useful Commands

- install: `./pi-delegator/scripts/install.sh`
- verify: `./pi-delegator/scripts/check_pi_setup.sh`
- Pixel Agents smoke test: `node ./pi-delegator/scripts/test_pixel_agents.mjs`
- Pixel Agents smoke test against an external install: `node ./pi-delegator/scripts/test_pixel_agents.mjs --launcher /path/to/bin/pi-agent`
- Clear stale Pixel Agents sessions: `node ./pi-delegator/scripts/clear_pixel_agents_sessions.mjs`
- Install live VS Code activity view: `./pi-delegator/scripts/install.sh --activity-view`
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
