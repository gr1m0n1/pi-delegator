#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source_root="${project_root}/pi-delegator"
if [[ ! -d "${source_root}/scripts" && -d "${project_root}/.pi-delegator/scripts" ]]; then
  source_root="${project_root}/.pi-delegator"
fi
runtime_root="${PI_CODING_AGENT_DIR:-${project_root}/.pi-delegator}"
env_file="${PI_AGENT_ENV_FILE:-${runtime_root}/pi.env}"
if [[ -f "$env_file" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
fi
target_root="${PI_MCP_ALLOWED_ROOT:-${project_root}}"

nvm_script="${NVM_DIR:-${HOME}/.nvm}/nvm.sh"
if [[ -s "$nvm_script" ]]; then
  # shellcheck disable=SC1090
  source "$nvm_script"
  nvm use "${PI_NODE_VERSION:-22.22.1}" >/dev/null
fi

timeout 30s env PI_CODING_AGENT_DIR="${runtime_root}" PI_MCP_ALLOWED_ROOT="${target_root}" node "${source_root}/scripts/sync_pi_installation.mjs"

errors=0
check() {
  local label="$1"
  shift
  if timeout 30s "$@"; then
    printf 'OK   %s\n' "$label"
  else
    printf 'ERROR %s\n' "$label" >&2
    errors=$((errors + 1))
  fi
}

warn_check() {
  local label="$1"
  shift
  if timeout 30s "$@"; then
    printf 'OK   %s\n' "$label"
  else
    printf 'WARN %s\n' "$label" >&2
  fi
}

check "Pi installed" pi --version
check "Node compatible" node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'
check "agent file permissions" bash -c '! find "$1/agents" -type f -perm /022 -print -quit | grep -q .' _ "$source_root"
check "context-mode CLI" bash -c 'command -v context-mode >/dev/null'
check "context-mode MCP config" node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const path = `${process.argv[1]}/.mcp.json`;
  const config = JSON.parse(readFileSync(path, "utf8"));
  if (config?.mcpServers?.["context-mode"]?.command !== "context-mode") {
    throw new Error("missing mcpServers.context-mode.command");
  }
' "$runtime_root"
check "required Pi packages" node --input-type=module -e '
  import { existsSync, readFileSync } from "node:fs";
  const path = `${process.argv[1]}/settings.json`;
  const config = JSON.parse(readFileSync(path, "utf8"));
  const required = [
    ["npm:pi-subagents@0.65.0", "pi-subagents"],
    ["npm:context-mode", "context-mode"],
    ["npm:pi-lens@4.1.3", "pi-lens"],
    ["npm:@juicesharp/rpiv-ask-user-question@2.9.0", "@juicesharp/rpiv-ask-user-question"],
    ["npm:pi-web-access@0.27.0", "pi-web-access"],
  ];
  const missing = required.filter(([entry, module]) =>
    !config?.packages?.includes(entry)
    || !existsSync(`${process.argv[1]}/npm/node_modules/${module}/package.json`)
  ).map(([entry]) => entry);
  if (missing.length) throw new Error(`missing Pi packages: ${missing.join(", ")}`);
  if (config?.packages?.some((entry) => String(entry).startsWith("npm:@tintinweb/pi-subagents"))) {
    throw new Error("legacy @tintinweb/pi-subagents package must be removed");
  }
' "$runtime_root"
check "pi-subagents public exports" node --input-type=module -e '
  import { createRequire } from "node:module";
  import { readFileSync } from "node:fs";
  const require = createRequire(`${process.argv[1]}/npm/package.json`);
  const packageJson = JSON.parse(readFileSync(`${process.argv[1]}/npm/node_modules/pi-subagents/package.json`, "utf8"));
  const version = String(packageJson.version || "0.0.0").split(".").map((part) => Number.parseInt(part, 10));
  if ((version[0] ?? 0) < 0 || ((version[0] ?? 0) === 0 && (version[1] ?? 0) < 65)) {
    throw new Error(`pi-subagents >=0.65.0 is required; found ${packageJson.version || "unknown"}`);
  }
  for (const specifier of ["pi-subagents/delegation", "pi-subagents/preflight", "pi-subagents/background-work", "pi-subagents/control-channel", "pi-subagents/capability-ceiling", "pi-subagents/external-runs"]) {
    try {
      require.resolve(specifier);
    } catch (error) {
      throw new Error(`missing required pi-subagents export ${specifier}: ${error.message}`);
    }
  }
' "$runtime_root"
check "subagent extension policy" node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const agentDir = `${process.argv[1]}/agents`;
  const diagnosticRoles = new Set(["coder", "tester", "reviewer"]);
  for (const role of ["coder", "researcher", "tester", "reviewer"]) {
    for (const suffix of ["", "-mcp"]) {
      const name = `${role}${suffix}`;
      const body = readFileSync(`${agentDir}/${name}.md`, "utf8");
      if (!body.includes("ext:pi-agent-runtime") || !body.includes("ext:pi-lens/lens_diagnostics")) {
        throw new Error(`${name}: missing required extension selector`);
      }
      const extensionLine = body.match(/^extensions:\s*\[(.*)\]$/m)?.[1] ?? "";
      if (!extensionLine.includes("pi-agent-runtime") || !extensionLine.includes("pi-lens")) {
        throw new Error(`${name}: pi-lens is not loaded`);
      }
      const hasQuestionTool = body.includes("ext:rpiv-ask-user-question/ask_user_question");
      if (hasQuestionTool === Boolean(suffix)) {
        throw new Error(`${name}: structured-question UI policy mismatch`);
      }
      if (diagnosticRoles.has(role) && !body.includes("`lens_diagnostics` with `mode=all`")) {
        throw new Error(`${name}: missing mandatory final diagnostics`);
      }
      const hasWebAccess = body.includes("ext:pi-web-access/web_search")
        && body.includes("ext:pi-web-access/fetch_content")
        && body.includes("ext:pi-web-access/source_check")
        && extensionLine.includes("pi-web-access");
      if (hasWebAccess !== (role === "researcher")) {
        throw new Error(`${name}: web-access role policy mismatch`);
      }
    }
  }
' "$runtime_root"
check "web access hardening" node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const config = JSON.parse(readFileSync(`${process.argv[1]}/web-search.json`, "utf8"));
  if (config.provider !== "duckduckgo") throw new Error("web search provider must be explicit duckduckgo");
  if (config.allowBrowserCookies !== false) throw new Error("browser cookies must be disabled");
  if (config.fetchRouting?.allowRemoteHostedProviders !== false
    || JSON.stringify(config.fetchRouting?.providers) !== JSON.stringify(["http"])) {
    throw new Error("fetch routing must be direct HTTP only");
  }
  for (const feature of ["githubClone", "githubPrIssue", "youtube", "video"]) {
    if (config[feature]?.enabled !== false) throw new Error(`${feature} must be disabled`);
  }
' "$runtime_root"
repoverity_check=(node --input-type=module -e '
  import { accessSync, constants, readFileSync } from "node:fs";
  import { delimiter, isAbsolute, resolve } from "node:path";
  const fail = (message) => {
    console.error(message);
    process.exit(1);
  };
  const runtimeRoot = process.argv[1];
  const config = JSON.parse(readFileSync(`${runtimeRoot}/.mcp.json`, "utf8"));
  const server = config?.mcpServers?.repoverity;
  if (!server || typeof server.command !== "string") fail("missing mcpServers.repoverity");
  const args = Array.isArray(server.args) ? server.args : [];
  const arg = (name) => {
    const index = args.indexOf(name);
    return index >= 0 && typeof args[index + 1] === "string" ? args[index + 1] : "";
  };
  const tokenFile = arg("--token-file");
  if (!arg("--repository") || !arg("--remote-url") || !tokenFile) fail("incomplete RepoVerity gateway args");
  const commandExists = (command) => {
    const candidates = command.includes("/") || isAbsolute(command)
      ? [command]
      : String(process.env.PATH || "").split(delimiter).filter(Boolean).map((entry) => resolve(entry, command));
    for (const candidate of candidates) {
      try { accessSync(candidate, constants.R_OK | constants.X_OK); return true; } catch {}
    }
    return false;
  };
  if (!commandExists(server.command)) fail("RepoVerity gateway command is not executable");
  try {
    accessSync(resolve(tokenFile), constants.R_OK);
  } catch {
    fail("RepoVerity token file is not readable");
  }
' "$runtime_root")
if [[ "${PI_REPOVERITY_ENABLED:-1}" =~ ^(0|false|no|off)$ ]]; then
  printf 'SKIP RepoVerity MCP config (disabled)\n'
elif [[ "${PI_REPOVERITY_REQUIRED:-0}" =~ ^(1|true|yes|on)$ ]]; then
  check "RepoVerity MCP config" "${repoverity_check[@]}"
else
  warn_check "RepoVerity MCP config (optional)" "${repoverity_check[@]}"
fi

if [[ -n "${LITELLM_BASE_URL:-}" && -n "${LITELLM_API_KEY:-}" ]]; then
  export PI_CODING_AGENT_DIR="${runtime_root}"
  export PI_MCP_ALLOWED_ROOT="${target_root}"
  check "runtime config render" node "${source_root}/scripts/render_pi_config.mjs"
  check "LiteLLM models" node --input-type=module -e '
    const base = process.env.LITELLM_BASE_URL;
    const key = process.env.LITELLM_API_KEY;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(`${base.replace(/\/$/, "")}/models`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const ids = new Set((payload.data || []).map((item) => item.id));
      const required = ["llm-large", "llm-medium-devel", "llm-medium", "llm-small"];
      const missing = required.filter((id) => !ids.has(id));
      if (missing.length) throw new Error(`missing LiteLLM aliases: ${missing.join(", ")}`);
      console.log(`LiteLLM reachable; ${ids.size} model(s), required aliases present`);
    } finally {
      clearTimeout(timer);
    }
  '
  check "Pi model registry" "${runtime_root}/bin/pi-agent" --list-models litellm
else
  printf 'ERROR LiteLLM environment (set LITELLM_BASE_URL and LITELLM_API_KEY)\n' >&2
  errors=$((errors + 1))
fi

if ((errors)); then
  printf 'PI SETUP: ERROR (%d check(s) failed)\n' "$errors" >&2
  exit 1
fi
printf 'PI SETUP: OK\n'
