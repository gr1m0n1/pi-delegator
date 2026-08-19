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
./pi-delegator/scripts/check_pi_setup.sh
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
./pi-delegator/scripts/install.sh --copilot
./pi-delegator/scripts/install.sh --codex
./pi-delegator/scripts/install.sh --claude
./pi-delegator/scripts/install.sh --all-clients
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

## MCP Timeouts

The local MCP server supports both a global timeout and a per-tool-call timeout:

- `PI_MCP_TIMEOUT_SECONDS`: default timeout for delegated MCP runs. If omitted, it defaults to `0`.
- `timeout_seconds`: optional timeout passed in an individual MCP tool call.

Timeout behavior is:

- `0` means no time limit.
- positive values are measured in seconds.
- if `PI_MCP_TIMEOUT_SECONDS` is greater than `0`, it acts as the maximum allowed timeout for any individual tool call.
- if `PI_MCP_TIMEOUT_SECONDS=0`, the global limit is disabled and each tool call may use either `0` or any positive value up to `7200`.

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
- direct Pi CLI: `./.pi-delegator/bin/pi`
- main agent: `./.pi-delegator/bin/pi-agent`
- local MCP server: `./.pi-delegator/bin/pi-mcp`

If you use Pixel Agents, `pi-delegator` emits lifecycle events using the `claude` hook by default so the agent activity is visible in the existing Pixel Agents UI. Override this with `PI_PIXEL_AGENTS_PROVIDER` if your setup uses a different hook name.

Agent runtime logs are written under `PI_AGENT_LOG_DIR` when set, or under the local Pi logs directory by default. The runtime keeps the aggregate `pi-agents.jsonl` file and also writes one independent log per agent under `agents/<agent>/events.jsonl`, for example `agents/coder-mcp/events.jsonl` or `agents/reviewer/events.jsonl`. Each agent folder also gets a `stdout.log` file with the final stdout captured from every completed or failed run for that agent, plus a `stderr.log` file when the runtime receives an error payload for that run.

## What This Repo Provides

- predefined agent profiles
- per-role model routing
- LiteLLM integration
- reproducible installation
- clear separation between source code and generated runtime
- a stable entry point for using Pi as a task delegator
