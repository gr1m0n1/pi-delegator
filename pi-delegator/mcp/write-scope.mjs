import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const WRITE_TOOL_NAMES = new Set(["edit", "write", "apply_patch"]);
const INDIRECT_WRITE_TOOLS = new Set(["ctx_execute", "ctx_batch_execute", "shell", "bash", "terminal"]);

function inside(parent, child) {
  const rel = relative(parent, child);
  return Boolean(rel && rel !== "." && !rel.startsWith("..") && !isAbsolute(rel));
}

function realExistingOrParent(path) {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  if (parent === path) return realpathSync(parent);
  return realExistingOrParent(parent);
}

export function resolveWriteScope(root, allowedPaths) {
  const realRoot = realpathSync(root);
  return allowedPaths.map((entry) => {
    if (isAbsolute(entry)) throw new Error(`allowed path must be relative: ${entry}`);
    const absolute = resolve(root, entry);
    const real = realExistingOrParent(absolute);
    if (!inside(realRoot, real) && real !== realRoot) throw new Error(`allowed path escapes workspace after realpath: ${entry}`);
    if (absolute === realRoot) throw new Error(`allowed path equals workspace root after realpath: ${entry}`);
    return { requested: entry, absolute, real };
  });
}

export function assertWriteTargetAllowed(root, allowedPaths, targetPath) {
  if (!targetPath || typeof targetPath !== "string") throw new Error("write target path is required");
  if (isAbsolute(targetPath)) throw new Error(`write target must be relative: ${targetPath}`);
  const realRoot = realpathSync(root);
  const targetAbsolute = resolve(root, targetPath);
  const targetRealBase = realExistingOrParent(targetAbsolute);
  if (!inside(realRoot, targetRealBase) && targetRealBase !== realRoot) throw new Error(`write target escapes workspace after realpath: ${targetPath}`);
  for (const scope of resolveWriteScope(root, allowedPaths)) {
    if (targetAbsolute === scope.absolute || inside(scope.absolute, targetAbsolute)) return true;
  }
  throw new Error(`write target is outside allowed_paths: ${targetPath}`);
}

export function capabilityCeiling(role, allowedPaths, tools, strict = true) {
  const writer = role === "orchestrator" || role === "coder" || role === "tester";
  const requestedTools = new Set(tools);
  const blocked = [...requestedTools].filter((tool) => INDIRECT_WRITE_TOOLS.has(tool));
  if (writer && strict && blocked.length) {
    return {
      ok: false,
      reason: `strict writer mode cannot guarantee allowed_paths while these tools can execute arbitrary commands: ${blocked.join(", ")}`,
      tools: [],
    };
  }
  if (!writer) {
    return { ok: true, tools: [...requestedTools].filter((tool) => !WRITE_TOOL_NAMES.has(tool) && !INDIRECT_WRITE_TOOLS.has(tool)), allowedPaths: [] };
  }
  return { ok: true, tools: [...requestedTools], allowedPaths };
}