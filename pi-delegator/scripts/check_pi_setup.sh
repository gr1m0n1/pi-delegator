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

nvm_script="${NVM_DIR:-${HOME}/.nvm}/nvm.sh"
if [[ -s "$nvm_script" ]]; then
  # shellcheck disable=SC1090
  source "$nvm_script"
  nvm use "${PI_NODE_VERSION:-22.22.1}" >/dev/null
fi

timeout 30s env PI_CODING_AGENT_DIR="${runtime_root}" PI_MCP_ALLOWED_ROOT="${project_root}" node "${source_root}/scripts/sync_pi_installation.mjs"

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

check "Pi installed" pi --version
check "Node compatible" node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'
check "agent file permissions" bash -c '! find "$1/agents" -type f -perm /022 -print -quit | grep -q .' _ "$source_root"

if [[ -n "${LITELLM_BASE_URL:-}" && -n "${LITELLM_API_KEY:-}" ]]; then
  export PI_CODING_AGENT_DIR="${runtime_root}"
  export PI_MCP_ALLOWED_ROOT="${project_root}"
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
