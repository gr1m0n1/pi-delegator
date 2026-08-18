#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source_root="${project_root}/pi-delegator"
runtime_root="${PI_CODING_AGENT_DIR:-${project_root}/.pi-delegator}"
node_version="${PI_NODE_VERSION:-22.22.1}"
pi_version="${PI_CODING_AGENT_VERSION:-0.84.2}"
subagents_package="${PI_SUBAGENTS_PACKAGE:-npm:@tintinweb/pi-subagents@0.17.0}"
env_example="${source_root}/pi.env.example"
env_file="${runtime_root}/pi.env"
client_flags=()

while (($#)); do
  case "$1" in
    --copilot|--codex|--claude|--all-clients)
      client_flags+=("$1")
      shift
      ;;
    --help|-h)
      cat <<'EOF'
Usage: ./pi-delegator/scripts/install.sh [--copilot] [--codex] [--claude] [--all-clients]

Optional integrations:
  --copilot      Update .vscode/mcp.json
  --codex        Update .codex/config.toml
  --claude       Update .mcp.json
  --all-clients  Configure all three
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

nvm_script="${NVM_DIR:-${HOME}/.nvm}/nvm.sh"
if [[ ! -s "$nvm_script" ]]; then
  echo "NVM not found at $nvm_script" >&2
  exit 2
fi

# shellcheck disable=SC1090
source "$nvm_script"

echo "[1/6] Ensure Node ${node_version}"
nvm install "${node_version}" >/dev/null
nvm use "${node_version}" >/dev/null

echo "[2/6] Ensure Pi runtime directory"
mkdir -p "${runtime_root}"
chmod 700 "${runtime_root}"

echo "[3/6] Install Pi coding agent ${pi_version}"
timeout 180s npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@${pi_version}"

echo "[4/6] Sync source into ${runtime_root}"
timeout 30s node "${source_root}/scripts/sync_pi_installation.mjs"

echo "[5/6] Install Pi subagents package"
timeout 180s env PI_CODING_AGENT_DIR="${runtime_root}" pi install "${subagents_package}" --approve

if [[ ! -f "${env_file}" ]]; then
  echo "[6/6] Create ${env_file} from example"
  cp "${env_example}" "${env_file}"
  chmod 600 "${env_file}"
else
  echo "[6/6] Keep existing ${env_file}"
fi

if ((${#client_flags[@]})); then
  echo "[7/7] Configure client integrations"
  timeout 30s node "${source_root}/scripts/configure_clients.mjs" "${client_flags[@]}"
fi

cat <<EOF
Install complete.

Next:
1. Edit ${env_file}
2. Run ./pi-delegator/scripts/check_pi_setup.sh
3. Start ./.pi-delegator/bin/pi-agent
4. Or run Pi directly with ./.pi-delegator/bin/pi
EOF
