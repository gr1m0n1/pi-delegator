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

## Runtime Configuration

The versioned configuration lives under `pi-delegator/`. The generated `.pi-delegator/` directory is local runtime state and should not be edited by hand. The wrappers load `.pi-delegator/pi.env` before synchronizing source files or starting Pi.

Important settings include:

```ini
PI_MAIN_MODEL=litellm/llm-large
PI_DEFAULT_DELEGATION_SET=default
PI_MAX_CONCURRENT=4
MAX_SUBAGENT_DEPTH=2
MAX_AGENT_TURNS=20
PI_MCP_TIMEOUT_SECONDS=0
PI_STRICT_WRITER_TOOLS=0
```

`PI_MCP_TIMEOUT_SECONDS=0` means that the MCP server uses its configured maximum of 7200 seconds. The value is not a 0-second timeout.

When using local models, these values give startup and activity tracking enough time for model loading and queueing:

```ini
PI_SUBAGENT_START_TIMEOUT_MS=300000
PI_ACTIVE_SESSION_HEARTBEAT_MS=30000
PI_ACTIVE_SESSION_STALE_MS=900000
```

Do not commit `.pi-delegator/pi.env` or token files. The installer creates the environment file with restricted permissions.

## MCP Timeouts

The local MCP server supports both a global timeout and a per-tool-call timeout:

- `PI_MCP_TIMEOUT_SECONDS`: default timeout for delegated MCP runs. If omitted, it defaults to `7200`.
- `timeout_seconds`: optional timeout passed in an individual MCP tool call.

Timeout behavior is:

- timeouts are measured in seconds.
- valid values are `1` through `7200`.
- omitted, invalid, or `0` timeout values fall back to `7200`.
- `PI_MCP_TIMEOUT_SECONDS` acts as the maximum allowed timeout for any individual tool call.

## Native MCP Delegation

The MCP tools keep their existing names and arguments, but execution is routed through a persistent native Pi RPC host instead of a one-shot `pi --print --no-session` process. The host is started on demand with `pi --mode rpc`, reuses `.pi-delegator/sessions/mcp/`, and is shut down with the MCP server.

Existing delegation tools now accept two additional optional fields:

- `background`: start the native run and return the opaque run id without waiting.
- `tool_budget`: hard maximum tool calls for the native `pi-subagents` run; values start at `1`.

Foreground calls wait for a terminal response and return the historical text fields plus `RUN_ID`, `DELEGATION_ACCOUNTING`, and `STRUCTURED_DETAILS`. The MCP server no longer decides success by parsing `STATUS:` prose from child stdout; terminal state, usage, model, thinking, and result details come from the native RPC response.

Asynchronous runs can be controlled with:

- `pi_run_status`: list runs or inspect one `id`.
- `pi_run_wait`: wait for an `id` for a bounded `timeout_ms` window without cancelling it.
- `pi_run_stop`: stop an active run and report stopped state.
- `pi_run_steer`: send live guidance and report native delivery state.
- `pi_run_resume`: revive or follow up an eligible persisted run.

Only `pi_run_status` is retried after a host restart. Mutating controls such as `stop`, `steer`, and `resume` are sent at most once.

Set `PI_MCP_RPC_ARGS` when a host wrapper needs arguments other than `--mode rpc`; it accepts either a JSON string array or a whitespace/comma separated list.

Subagents must emit their started lifecycle event within `PI_SUBAGENT_START_TIMEOUT_MS` (default and minimum `60000`). When this does not happen, Pi records `delegation_start_timeout` with terminal status `failed` and removes the pending delegation instead of leaving it queued indefinitely. On Pi session shutdown, active runtime sessions are recorded as `interrupted` and removed from the active-session state file.

While a subagent is active, Pi refreshes the active-session state every `PI_ACTIVE_SESSION_HEARTBEAT_MS` (default `15000`). `pi_activity` and the VS Code panel expire a state whose last heartbeat is older than `PI_ACTIVE_SESSION_STALE_MS` (default `90000`), so an abrupt process termination cannot leave a permanent active card.

## Repository Instruction Preflight

Before delegating work, the MCP server reads the target repository's root `AGENTS.md` when present. If those instructions require external MCP/tool families such as RepoVerity (`code_index_status`, `code_retrieve`, `code_search_exact`) or context-mode (`ctx_execute`, `ctx_batch_execute`), delegation is blocked unless the Pi runtime has those tools configured.

context-mode is managed by this runtime: `settings.json` installs `npm:context-mode`, `.mcp.json` registers the MCP server command, and `install.sh` installs the `context-mode` CLI that Pi uses to start the server. When those files are present and the CLI is on `PATH`, all `ctx_*` tools are treated as available.

Context Mode is forced by default (`PI_FORCE_CONTEXT_MODE=1`). The MCP server requires `ctx_execute` and `ctx_batch_execute` before delegating, even when the target repository has no explicit context-mode rule. Delegated researcher/reviewer agents only receive `ctx_*` tools; coder/tester agents receive `ctx_*` plus `edit`/`write` for bounded file changes. Set `PI_FORCE_CONTEXT_MODE=0` only for an intentional local bypass.

Writer delegations resolve `allowed_paths` against the real workspace root before launch, pass that scope to the child runtime, and block direct `edit`/`write` calls outside it. Symlinks and parent paths that escape the workspace are rejected. Set `PI_STRICT_WRITER_TOOLS=1` to fail closed when a writer would receive indirect shell-capable tools such as `ctx_execute` or `ctx_batch_execute`; with the default `0`, those tools remain available for compatibility and the response does not claim operating-system isolation.

RepoVerity is disabled by default (`PI_REPOVERITY_ENABLED=0`). Set it to `1` to integrate the gateway during sync; pi-delegator then copies a `repoverity` server from the target workspace's `.vscode/mcp.json` into the Pi runtime `.mcp.json`. If no workspace MCP entry exists, set `PI_REPOVERITY_REPOSITORY`, `PI_REPOVERITY_REMOTE_URL`, `PI_REPOVERITY_TOKEN_FILE`, and optionally `PI_REPOVERITY_COMMAND`, `PI_REPOVERITY_LOGICAL_REF`, or `PI_REPOVERITY_SERVER_NAME` before running `sync_pi_installation.mjs` or `install.sh`. Before each delegation, pi-delegator performs a short MCP handshake and reports `repoverity_availability` as `available`, `not_configured`, `probe_timeout`, or another failure reason. When RepoVerity is enabled but unavailable, it is removed from the delegated tool allowlist and Context Mode remains the fallback. Set `PI_REPOVERITY_REQUIRED=1` only when enabled and missing RepoVerity should block delegation.

As an escape hatch for tool families managed outside pi-delegator, verified tools can still be declared with either environment variable:

```bash
PI_AVAILABLE_EXTERNAL_TOOLS=code_index_status,code_retrieve,code_search_exact
PI_AVAILABLE_MCP_TOOLS=code_index_status,code_retrieve,code_search_exact
```

Only set these after confirming the spawned Pi process can actually call those tools. Otherwise the safer behavior is to return `STATUS: BLOCKED` and report the missing MCP/tool names.

### RepoVerity Availability

RepoVerity is optional. When `PI_REPOVERITY_ENABLED=1`, the runtime performs a short MCP `initialize` handshake before each delegated call:

```text
repoverity_enabled: yes
repoverity_availability: available
```

If the gateway is not configured or does not answer, the runtime reports the reason, removes `code_*` from the delegated allowlist, and continues with Context Mode. Typical values are `not_configured`, `probe_timeout`, `spawn_failed`, `server_exited`, or `initialize_failed`. Set `PI_REPOVERITY_REQUIRED=1` only when RepoVerity must be present; otherwise an unavailable gateway must remain a fallback condition rather than blocking every task.

The internal Pi bridge configuration is stored as `.pi-delegator/.mcp.json`. It is intentionally hidden from VS Code's MCP discovery so the client shows one `pi-delegator` server instead of a duplicate internal server. Pi receives its absolute path through `PI_MCP_CONFIG_PATH`, including when a subagent runs from a temporary directory.

## Default Pi Packages

The generated runtime installs these packages by default:

- `pi-subagents@0.65.0`: native agent delegation, async run control, launch preflight, capability ceilings, and structured lifecycle/result APIs.
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

## Observability

There are three levels of activity visibility:

1. The MCP server emits `notifications/progress` when the client supplies a progress token. Messages include delegation start, subagent start, lifecycle updates, and finish/failure.
2. The `pi_activity` MCP tool returns active sessions and recent JSONL events from the current runtime. It accepts `task_id`, `agent`, and `limit` filters.
3. The optional `Pi Delegator Activity` VS Code extension adds a sidebar view with active agents, recent events, and links to per-agent output. It watches `pi-agents.jsonl` and the active-session state file.

Install the view with:

```bash
./pi-delegator/scripts/install.sh --activity-view
```

Or install the generated VSIX manually:

```bash
code --install-extension pi-delegator/vscode-extension/pi-delegator-activity-0.1.0.vsix --force
```

Then run `Developer: Reload Window`, open the **Pi Delegator** icon in the activity bar, and use `Select Pi Delegator Runtime Log` when Pi runs in another workspace. For example:

```text
/home/sergien/contextmeup/RepoVerity/.pi-delegator/logs/pi-agents.jsonl
```

The panel derives the visual state from correlated `task_id`, `agent`, and `session_id` values. A historical `started` event is displayed as completed when its session is no longer active. A heartbeat older than `PI_ACTIVE_SESSION_STALE_MS` is ignored, preventing ghost running icons after abrupt process termination.

## Logs and Cleanup

The default log directory is `.pi-delegator/logs/`. It contains:

- `pi-agents.jsonl`: aggregate lifecycle events.
- `agents/<agent>/events.jsonl`: events for one profile.
- `agents/<agent>/stdout.log`: final output for completed or failed runs.
- `agents/<agent>/stderr.log`: error output when available.
- `pixel-agents-active-sessions.json`: authoritative active-session heartbeat state.

If a host or client is terminated unexpectedly, clean the visual and runtime state from the target workspace:

```bash
node ./.pi-delegator/scripts/clear_pixel_agents_sessions.mjs
```

This emits cleanup events, closes stale Pixel Agents sessions, removes transient transcripts, and reconciles the active-session state. The runtime also records `subagent_interrupted` on normal Pi shutdown.

## Testing

Run the baseline validation:

```bash
./.pi-delegator/scripts/check_pi_setup.sh
```

Test the local MCP server without invoking a model:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"pi_status","arguments":{}}}' \
	| ./.pi-delegator/bin/pi-mcp
```

Run the versioned unit and MCP smoke tests without LiteLLM, credentials, or network:

```bash
npm test
npm run test:mcp-smoke
```

The smoke test starts [test/fixtures/fake-pi-rpc-host.mjs](test/fixtures/fake-pi-rpc-host.mjs) instead of a model-backed Pi host and exercises the MCP JSON-RPC surface.

For a read-only delegation in the current repository:

```text
Use pi_research to read README.md and report its first Markdown heading.
Do not modify files. Return STATUS and evidence.
```

For a RepoVerity integration test, require `code_index_status` with `logical_ref=development` as the first repository operation. Check `snapshot_status`, `revision_kind`, `revision`, and `stale`. A healthy result has an active snapshot and `stale: false`.

The repository's setup check, MCP status, and delegation tests should be run from the workspace whose runtime is being tested. If the target is `/home/sergien/contextmeup/RepoVerity`, run its `.pi-delegator` wrappers rather than the generated runtime in this source repository.

## Troubleshooting

### Every delegated action is `BLOCKED`

Check `pi_status` first. If the parent has `ctx_*` and/or `code_*` but the child reports that both are missing, restart MCP and synchronize the runtime. The child profiles load `pi-agent-runtime` explicitly so dynamically registered MCP tools are copied into each child session.

### `ctx_execute_file` is blocked

Context Mode may restrict file paths to its `.pi-delegator` sandbox. This does not necessarily mean the repository cannot be inspected. The supported fallback is `ctx_execute` with an explicit repository `cwd`, still through Context Mode and still read-only.

### A completed task still shows a running icon

Reload the VS Code window and update the activity extension. The panel uses terminal events and active-session heartbeats, not the text of the historical `started` event alone. Run the cleanup script if the runtime was killed abruptly.

### A duplicate `pi-delegator` server appears in VS Code

There should be only one client declaration in `.vscode/mcp.json`. The internal runtime file must be `.pi-delegator/.mcp.json`, not `.pi-delegator/mcp.json`; the latter is automatically discovered by VS Code as a second server.

### RepoVerity is unavailable

With `PI_REPOVERITY_REQUIRED=0`, this is a normal optional condition. Inspect `repoverity_availability` in `pi_status`, verify the gateway command, repository, remote URL, and token-file path, then restart the MCP server. Context Mode remains the fallback. Never print or commit the token contents.

### The install command times out during npm packages

The package installation can take longer than a terminal wrapper's idle timeout, especially on a cold local environment. Check whether synchronization completed, then run the target `.pi-delegator/scripts/check_pi_setup.sh` separately before reinstalling packages.

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
