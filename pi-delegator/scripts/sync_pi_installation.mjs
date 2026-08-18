#!/usr/bin/env node
import { chmod, copyFile, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const projectRoot = resolve(sourceDir, "..");
const installDir = resolve(process.env.PI_CODING_AGENT_DIR || `${projectRoot}/.pi-delegator`);
const workspaceMetadataFile = ".pixel-agents-workspace-root";
const managedFiles = [
  "APPEND_SYSTEM.md",
  "delegation-sets.json",
  "models.json.template",
  "pi.env.example",
  "settings.json",
  "subagents.json.template",
];
const managedDirectories = [
  "agents",
  "extensions",
  "mcp",
  "scripts",
];
const obsoleteDirectories = [
  "benchmarks",
  "docs",
  "tests",
];

const runtimeBinFiles = {
  pi: `#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)"
env_file="\${PI_AGENT_ENV_FILE:-\${project_root}/pi.env}"
if [[ -f "\$env_file" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "\$env_file"
  set +a
fi

nvm_script="\${NVM_DIR:-\${HOME}/.nvm}/nvm.sh"
if [[ ! -s "\$nvm_script" ]]; then
  echo "NVM not found at \$nvm_script" >&2
  exit 2
fi

# shellcheck disable=SC1090
source "\$nvm_script"
nvm use "\${PI_NODE_VERSION:-22.22.1}" >/dev/null

exec pi "\$@"
`,
  "pi-agent": `#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "\${BASH_SOURCE[0]}")/../.." && pwd)"
source_root="\${project_root}/pi-delegator"
env_file="\${PI_AGENT_ENV_FILE:-\${project_root}/.pi-delegator/pi.env}"
workspace_root_file="\${PI_CODING_AGENT_DIR:-\${project_root}/.pi-delegator}/${workspaceMetadataFile}"
if [[ -f "\$env_file" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "\$env_file"
  set +a
fi

export PI_CODING_AGENT_DIR="\${PI_CODING_AGENT_DIR:-\${project_root}/.pi-delegator}"
export PI_AGENT_LOG_DIR="\${PI_AGENT_LOG_DIR:-\${project_root}/.pi-delegator/logs}"
export PI_TELEMETRY="\${PI_TELEMETRY:-0}"
export PI_SKIP_VERSION_CHECK="\${PI_SKIP_VERSION_CHECK:-1}"
export MAX_SUBAGENT_CALLS="\${MAX_SUBAGENT_CALLS:-12}"
if [[ -z "\${PI_PIXEL_AGENTS_WORKSPACE_CWD:-}" && -f "\$workspace_root_file" ]]; then
  PI_PIXEL_AGENTS_WORKSPACE_CWD="$(head -n 1 "\$workspace_root_file" | tr -d '\r')"
  export PI_PIXEL_AGENTS_WORKSPACE_CWD
fi

nvm_script="\${NVM_DIR:-\${HOME}/.nvm}/nvm.sh"
if [[ -s "\$nvm_script" ]]; then
  # shellcheck disable=SC1090
  source "\$nvm_script"
  nvm use "\${PI_NODE_VERSION:-22.22.1}" >/dev/null
fi

if ! command -v pi >/dev/null 2>&1; then
  echo "Pi is not installed. Install @earendil-works/pi-coding-agent with Node >=22.19." >&2
  exit 2
fi

timeout 30s node "\${source_root}/scripts/sync_pi_installation.mjs"
timeout 30s node "\${source_root}/scripts/render_pi_config.mjs"

model="\${PI_MAIN_MODEL:-litellm/llm-large}"
debug=0
args=()
while (($#)); do
  case "$1" in
    --model)
      [[ $# -ge 2 ]] || { echo "--model requires a value" >&2; exit 2; }
      model="$2"
      shift 2
      ;;
    --debug)
      debug=1
      shift
      ;;
    *)
      args+=("$1")
      shift
      ;;
  esac
done

pi_args=(--approve --model "$model")
((debug)) && pi_args+=(--verbose)
cd "\${project_root}"
exec pi "\${pi_args[@]}" "\${args[@]}"
`,
  "pi-mcp": `#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "\${BASH_SOURCE[0]}")/../.." && pwd)"
source_root="\${project_root}/pi-delegator"
env_file="\${PI_AGENT_ENV_FILE:-\${project_root}/.pi-delegator/pi.env}"
workspace_root_file="\${PI_CODING_AGENT_DIR:-\${project_root}/.pi-delegator}/${workspaceMetadataFile}"
if [[ -f "\$env_file" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "\$env_file"
  set +a
fi

export PI_MCP_ALLOWED_ROOT="\${PI_MCP_ALLOWED_ROOT:-\${project_root}}"
if [[ -z "\${PI_PIXEL_AGENTS_WORKSPACE_CWD:-}" && -f "\$workspace_root_file" ]]; then
  PI_PIXEL_AGENTS_WORKSPACE_CWD="$(head -n 1 "\$workspace_root_file" | tr -d '\r')"
  export PI_PIXEL_AGENTS_WORKSPACE_CWD
fi

timeout 30s node "\${source_root}/scripts/sync_pi_installation.mjs"
exec node "\${project_root}/.pi-delegator/mcp/server.mjs"
`,
};

export async function syncPiInstallation() {
  await mkdir(installDir, { recursive: true, mode: 0o700 });

  for (const directory of obsoleteDirectories) {
    await rm(resolve(installDir, directory), { recursive: true, force: true });
  }

  for (const directory of managedDirectories) {
    await rm(resolve(installDir, directory), { recursive: true, force: true });
    await cp(resolve(sourceDir, directory), resolve(installDir, directory), { recursive: true });
  }

  for (const file of managedFiles) {
    await copyFile(resolve(sourceDir, file), resolve(installDir, file));
  }

  await writeFile(resolve(installDir, workspaceMetadataFile), `${projectRoot}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });

  const binDir = resolve(installDir, "bin");
  await rm(binDir, { recursive: true, force: true });
  await mkdir(binDir, { recursive: true, mode: 0o700 });
  for (const [name, contents] of Object.entries(runtimeBinFiles)) {
    const destination = resolve(binDir, name);
    await writeFile(destination, contents, { mode: 0o755 });
    await chmod(destination, 0o755);
  }

  await chmod(installDir, 0o700);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await syncPiInstallation();
}
