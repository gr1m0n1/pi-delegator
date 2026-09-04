#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source_root="${project_root}/pi-delegator"
if [[ ! -d "${source_root}/scripts" && -d "${project_root}/.pi-delegator/scripts" ]]; then
  source_root="${project_root}/.pi-delegator"
fi
node_version="${PI_NODE_VERSION:-22.22.1}"
pi_version="${PI_CODING_AGENT_VERSION:-0.84.2}"
subagents_package="${PI_SUBAGENTS_PACKAGE:-npm:@tintinweb/pi-subagents@0.17.0}"
context_mode_package="${PI_CONTEXT_MODE_PACKAGE:-npm:context-mode}"
pi_lens_package="npm:pi-lens@4.1.3"
ask_user_package="npm:@juicesharp/rpiv-ask-user-question@2.9.0"
web_access_package="npm:pi-web-access@0.27.0"
env_example="${source_root}/pi.env.example"
client_flags=()
activity_view=0
target_root="${PI_DELEGATOR_TARGET_ROOT:-${project_root}}"

while (($#)); do
  case "$1" in
    --install-dir|--dir)
      [[ $# -ge 2 ]] || { echo "$1 requires a value" >&2; exit 2; }
      target_root="$(realpath -m "$2")"
      shift 2
      ;;
    --copilot|--codex|--claude|--all-clients)
      client_flags+=("$1")
      shift
      ;;
    --activity-view)
      activity_view=1
      shift
      ;;
    --help|-h)
      cat <<'EOF'
Usage: install.sh [--install-dir DIR] [--copilot] [--codex] [--claude] [--all-clients] [--activity-view]

Options:
  --install-dir DIR  Install .pi-delegator inside DIR instead of the current repo
  --dir DIR          Alias for --install-dir

Optional integrations:
  --copilot      Update .vscode/mcp.json
  --codex        Update .codex/config.toml
  --claude       Update .mcp.json
  --all-clients  Configure all three
  --activity-view Build and install the Pi Delegator Activity VS Code extension
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

target_root="$(realpath -m "${target_root}")"
runtime_root="${target_root}/.pi-delegator"
env_file="${runtime_root}/pi.env"

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
mkdir -p "${target_root}"
mkdir -p "${runtime_root}"
chmod 700 "${runtime_root}"

echo "[3/7] Install Pi coding agent ${pi_version}"
timeout 180s npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@${pi_version}"

echo "[4/7] Install context-mode CLI"
timeout 180s npm install -g --ignore-scripts "${context_mode_package#npm:}"

echo "[5/7] Sync source into ${runtime_root}"
timeout 30s env PI_CODING_AGENT_DIR="${runtime_root}" PI_MCP_ALLOWED_ROOT="${target_root}" node "${source_root}/scripts/sync_pi_installation.mjs"

echo "[6/7] Install Pi packages"
npm_root="${runtime_root}/npm"
mkdir -p "${npm_root}"
if [[ ! -f "${npm_root}/package.json" ]]; then
  printf '%s\n' '{"name":"pi-extensions","private":true}' > "${npm_root}/package.json"
fi
timeout 300s npm install --prefix "${npm_root}" --save-exact \
  "${subagents_package#npm:}" \
  "${context_mode_package#npm:}" \
  "${pi_lens_package#npm:}" \
  "${ask_user_package#npm:}" \
  "${web_access_package#npm:}"

if [[ ! -f "${env_file}" ]]; then
  echo "[7/7] Create ${env_file} from example"
  cp "${env_example}" "${env_file}"
  chmod 600 "${env_file}"
else
  echo "[7/7] Keep existing ${env_file}"
fi

if ((${#client_flags[@]})); then
  echo "[8/8] Configure client integrations"
  timeout 30s env PI_CODING_AGENT_DIR="${runtime_root}" PI_MCP_ALLOWED_ROOT="${target_root}" node "${source_root}/scripts/configure_clients.mjs" "${client_flags[@]}"
fi

if ((activity_view)); then
  echo "[9/9] Install Pi Delegator Activity extension"
  extension_dir="${source_root}/vscode-extension"
  timeout 180s npm install --prefix "${extension_dir}"
  timeout 60s npm run --prefix "${extension_dir}" compile
  timeout 60s npm run --prefix "${extension_dir}" package
  extension_file="${extension_dir}/pi-delegator-activity-0.1.0.vsix"
  code_command="${VSCODE_CLI:-code}"
  command -v "${code_command}" >/dev/null || { echo "VS Code CLI not found: ${code_command}" >&2; exit 2; }
  timeout 30s "${code_command}" --install-extension "${extension_file}" --force
fi

printf -v runtime_root_q '%q' "${runtime_root}"
printf -v target_root_q '%q' "${target_root}"

cat <<EOF
Install complete.

Next:
1. Edit ${env_file}
2. Run PI_CODING_AGENT_DIR=${runtime_root_q} PI_MCP_ALLOWED_ROOT=${target_root_q} ${runtime_root}/scripts/check_pi_setup.sh
3. Start ${runtime_root}/bin/pi-agent
4. Or run Pi directly with ${runtime_root}/bin/pi
EOF
