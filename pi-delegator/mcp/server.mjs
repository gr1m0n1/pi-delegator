#!/usr/bin/env node

import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { delimiter, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import readline from "node:readline";
import { PiRpcHost } from "./pi-rpc-host.mjs";
import { capabilityCeiling, resolveWriteScope } from "./write-scope.mjs";

const SERVER_VERSION = "1.0.0";
const PROTOCOL_VERSION = "2024-11-05";
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(MODULE_DIR, "../..");
const WRITER_ROLES = new Set(["orchestrator", "coder", "tester"]);
const ROLE_TO_TOOL = {
  orchestrator: "pi_orchestrate",
  researcher: "pi_research",
  coder: "pi_implement",
  tester: "pi_tests",
  reviewer: "pi_review",
};
const ROLE_PROFILE_KEYS = {
  orchestrator: "orchestrate",
  researcher: "research",
  coder: "implement",
  tester: "tests",
  reviewer: "review",
};
const ROLE_AGENT_TYPES = {
  orchestrator: "delegate",
  researcher: "researcher-mcp",
  coder: "coder-mcp",
  tester: "tester-mcp",
  reviewer: "reviewer-mcp",
};
const MAX_TIMEOUT_SECONDS = 7200;
const MAX_ACTIVITY_EVENTS = 100;
const MAX_WAIT_MS = 7_200_000;
const ACTIVE_SESSION_STALE_MS = integer(process.env.PI_ACTIVE_SESSION_STALE_MS, 90_000, 10_000, 3_600_000);
const FALLBACK_DELEGATION_SET = "default";
const SET_ROLES = ["research", "implement", "tests", "review", "orchestrate"];
const REASONING_LEVELS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const REQUIRED_REPOSITORY_TOOL_GROUPS = [
  {
    name: "RepoVerity",
    triggers: [/\bRepoVerity\b/i, /\bcode_index_status\b/],
    tools: ["code_index_status", "code_retrieve", "code_search_exact"],
  },
  {
    name: "context-mode",
    triggers: [/\bcontext-mode\b/i, /\bctx_execute\b/, /\bctx_batch_execute\b/],
    tools: ["ctx_execute", "ctx_batch_execute"],
  },
];
const CONTEXT_MODE_TOOLS = [
  "ctx_batch_execute",
  "ctx_execute",
  "ctx_execute_file",
  "ctx_index",
  "ctx_search",
  "ctx_fetch_and_index",
  "ctx_stats",
  "ctx_doctor",
  "ctx_upgrade",
  "ctx_purge",
  "ctx_insight",
];
const REPOVERITY_TOOLS = [
  "code_retrieve",
  "code_search_exact",
  "code_find_symbol",
  "code_find_references",
  "code_trace",
  "code_impact",
  "code_get_snippets",
  "code_index_status",
];

const REPOVERITY_PROBE_TIMEOUT_MS = 3000;

function booleanFlag(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return !/^(0|false|no|off)$/i.test(String(value).trim());
}

function integer(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

function normalizeTimeoutSeconds(value, fallback) {
  return integer(value, fallback, 1, MAX_TIMEOUT_SECONDS);
}

export function createConfig(env = process.env) {
  const root = resolve(env.PI_MCP_ALLOWED_ROOT || DEFAULT_ROOT);
  const runtimeRoot = resolve(env.PI_CODING_AGENT_DIR || (existsSync(resolve(root, "bin/pi-agent")) ? root : resolve(root, ".pi-delegator")));
  const availableExternalTools = parseToolList(env.PI_AVAILABLE_EXTERNAL_TOOLS || env.PI_AVAILABLE_MCP_TOOLS || "");
  for (const toolName of configuredContextModeTools(root, runtimeRoot, env)) availableExternalTools.add(toolName);
  for (const toolName of configuredRepoVerityTools(root, runtimeRoot, env)) availableExternalTools.add(toolName);
  return {
    root,
    runtimeRoot,
    launcher: resolve(env.PI_MCP_PI_AGENT || resolve(runtimeRoot, "bin/pi-agent")),
    launcherArgs: [],
    rpcLauncher: resolve(env.PI_MCP_PI_RPC || resolve(runtimeRoot, "bin/pi")),
    rpcArgs: parseArgList(env.PI_MCP_RPC_ARGS, ["--mode", "rpc"]),
    rpcSessionRoot: resolve(env.PI_MCP_RPC_SESSION_ROOT || resolve(runtimeRoot, "sessions/mcp")),
    rpcHandshakeTimeoutMs: integer(env.PI_MCP_RPC_HANDSHAKE_TIMEOUT_MS, 10000, 100, 120000),
    rpcRequestTimeoutMs: integer(env.PI_MCP_RPC_REQUEST_TIMEOUT_MS, MAX_WAIT_MS, 100, MAX_WAIT_MS),
    timeoutSeconds: normalizeTimeoutSeconds(env.PI_MCP_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS),
    maxOutputChars: integer(env.PI_MCP_MAX_OUTPUT_CHARS, 50000, 1000, 500000),
    delegationSetsFile: resolve(env.PI_DELEGATION_SETS_FILE || resolve(runtimeRoot, "delegation-sets.json")),
    modelCatalogFile: resolve(env.PI_MODELS_CATALOG_FILE || resolve(runtimeRoot, "models.json.template")),
    defaultDelegationSet: String(env.PI_DEFAULT_DELEGATION_SET || FALLBACK_DELEGATION_SET).trim() || FALLBACK_DELEGATION_SET,
    availableExternalTools,
    forceContextMode: booleanFlag(env.PI_FORCE_CONTEXT_MODE, true),
    strictWriterTools: booleanFlag(env.PI_STRICT_WRITER_TOOLS, false),
    repoVerityEnabled: booleanFlag(env.PI_REPOVERITY_ENABLED, true),
    repoVerityRequired: booleanFlag(env.PI_REPOVERITY_REQUIRED, false),
    repoVerityAvailability: "unknown",
  };
}

const hosts = new WeakMap();
const activeHosts = new Set();

export function rpcHost(config = createConfig()) {
  let host = hosts.get(config);
  if (!host) {
    host = new PiRpcHost({
      command: config.rpcLauncher,
      args: config.rpcArgs,
      cwd: config.root,
      env: {
        PI_CODING_AGENT_DIR: config.runtimeRoot,
        PI_MCP_ALLOWED_ROOT: config.root,
        PI_MCP_CONFIG_PATH: resolve(config.runtimeRoot, ".mcp.json"),
        PI_SUBAGENTS_SESSION_ROOT: config.rpcSessionRoot,
      },
      sessionRoot: config.rpcSessionRoot,
      handshakeTimeoutMs: config.rpcHandshakeTimeoutMs,
      requestTimeoutMs: config.rpcRequestTimeoutMs,
    });
    hosts.set(config, host);
    activeHosts.add(host);
  }
  return host;
}

export async function shutdownRpcHost(config) {
  const host = hosts.get(config);
  if (!host) return;
  await host.stop();
  hosts.delete(config);
  activeHosts.delete(host);
}

async function shutdownAllRpcHosts() {
  const stopping = [...activeHosts].map((host) => host.stop().catch(() => undefined));
  activeHosts.clear();
  await Promise.all(stopping);
}

function parseToolList(value) {
  return new Set(String(value || "").split(/[\s,]+/).map((entry) => entry.trim()).filter(Boolean));
}

function parseArgList(value, fallback = []) {
  if (value === undefined || value === null || value === "") return fallback;
  const text = String(value).trim();
  if (!text) return fallback;
  if (text.startsWith("[")) {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) throw new Error("PI_MCP_RPC_ARGS must be a JSON string array");
    return parsed;
  }
  return text.split(/[\s,]+/).map((entry) => entry.trim()).filter(Boolean);
}

function commandExists(command, env = process.env) {
  if (!command || /[\/]/.test(command)) {
    try {
      accessSync(resolve(command), constants.R_OK | constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  for (const entry of String(env.PATH || "").split(delimiter)) {
    if (!entry) continue;
    try {
      accessSync(resolve(entry, command), constants.R_OK | constants.X_OK);
      return true;
    } catch {
      // Keep checking PATH entries.
    }
  }
  return false;
}

function contextModeServerConfigured(path, env = process.env) {
  if (!existsSync(path)) return false;
  let document;
  try {
    document = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
  const servers = document?.mcpServers;
  const server = servers && typeof servers === "object" && !Array.isArray(servers) ? servers["context-mode"] : null;
  if (!server || typeof server !== "object" || Array.isArray(server)) return false;
  const command = typeof server.command === "string" ? server.command.trim() : "";
  return commandExists(command, env);
}

function mcpServer(path, name) {
  if (!existsSync(path)) return null;
  let document;
  try {
    document = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  const servers = document?.mcpServers;
  const server = servers && typeof servers === "object" && !Array.isArray(servers) ? servers[name] : null;
  return server && typeof server === "object" && !Array.isArray(server) ? server : null;
}

function argumentValue(args, flag) {
  if (!Array.isArray(args)) return "";
  const index = args.findIndex((entry) => entry === flag);
  const value = index >= 0 ? args[index + 1] : "";
  return typeof value === "string" ? value.trim() : "";
}

function repoVerityServerConfigured(path, env = process.env) {
  const server = mcpServer(path, "repoverity");
  if (!server) return false;
  const command = typeof server.command === "string" ? server.command.trim() : "";
  const repository = argumentValue(server.args, "--repository");
  const remoteUrl = argumentValue(server.args, "--remote-url");
  const tokenFile = argumentValue(server.args, "--token-file");
  return Boolean(repository && remoteUrl && tokenFile)
    && commandExists(command, env)
    && existsSync(resolve(tokenFile));
}

function contextModePackageConfigured(path) {
  if (!existsSync(path)) return false;
  let document;
  try {
    document = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
  return Array.isArray(document?.packages) && document.packages.includes("npm:context-mode");
}

function configuredContextModeTools(root, runtimeRoot, env = process.env) {
  const candidates = [
    resolve(runtimeRoot, ".mcp.json"),
    resolve(root, ".pi", "mcp.json"),
  ];
  const settingsCandidates = [
    resolve(runtimeRoot, "settings.json"),
    resolve(root, ".pi", "settings.json"),
  ];
  return candidates.some((path) => contextModeServerConfigured(path, env))
    && settingsCandidates.some((path) => contextModePackageConfigured(path))
    ? CONTEXT_MODE_TOOLS
    : [];
}

function configuredRepoVerityTools(root, runtimeRoot, env = process.env) {
  if (!booleanFlag(env.PI_REPOVERITY_ENABLED, true)) return [];
  const candidates = [
    resolve(runtimeRoot, ".mcp.json"),
    resolve(root, ".pi", "mcp.json"),
  ];
  return candidates.some((path) => repoVerityServerConfigured(path, env)) ? REPOVERITY_TOOLS : [];
}

function configuredRepoVerityServer(config) {
  if (!config.repoVerityEnabled) return null;
  const candidates = [resolve(config.runtimeRoot, ".mcp.json"), resolve(config.root, ".pi", "mcp.json")];
  for (const path of candidates) {
    const server = mcpServer(path, "repoverity");
    if (server?.command) return server;
  }
  return null;
}

async function probeRepoVerity(config) {
  const server = configuredRepoVerityServer(config);
  if (!server) return { available: false, reason: "not_configured" };
  return await new Promise((resolveProbe) => {
    const child = spawn(server.command, Array.isArray(server.args) ? server.args : [], {
      cwd: typeof server.cwd === "string" && server.cwd ? server.cwd : config.root,
      env: { ...process.env, ...(server.env && typeof server.env === "object" ? server.env : {}) },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let buffer = "";
    let settled = false;
    const finish = (available, reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      resolveProbe({ available, reason });
    };
    const timer = setTimeout(() => finish(false, "probe_timeout"), REPOVERITY_PROBE_TIMEOUT_MS);
    timer.unref();
    child.on("error", () => finish(false, "spawn_failed"));
    child.on("exit", () => finish(false, "server_exited"));
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const response = JSON.parse(line);
          if (response.id === 1) finish(!response.error, response.error ? "initialize_failed" : "available");
        } catch {
          finish(false, "invalid_response");
        }
      }
    });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "pi-delegator-probe", version: SERVER_VERSION } },
    })}\n`);
  });
}

export async function refreshRepoVerityAvailability(config) {
  if (!config.repoVerityEnabled) {
    config.repoVerityAvailability = "disabled";
    config.availableExternalTools = new Set([...config.availableExternalTools].filter((tool) => !REPOVERITY_TOOLS.includes(tool)));
    return config.repoVerityAvailability;
  }
  const result = await probeRepoVerity(config);
  config.repoVerityAvailability = result.available ? "available" : result.reason;
  if (result.available) {
    for (const tool of REPOVERITY_TOOLS) config.availableExternalTools.add(tool);
  } else {
    for (const tool of REPOVERITY_TOOLS) config.availableExternalTools.delete(tool);
  }
  return config.repoVerityAvailability;
}

function parseJsonFile(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${label} at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validatePercentage(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) {
    throw new Error("delegation_percentage must be an integer between 0 and 100");
  }
  return value;
}

function validateReasoning(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || !REASONING_LEVELS.has(value.trim().toLowerCase())) {
    throw new Error(`reasoning must be one of: ${[...REASONING_LEVELS].join(", ")}`);
  }
  return value.trim().toLowerCase();
}

function allowedModels(config) {
  const document = parseJsonFile(config.modelCatalogFile, "Pi model catalog");
  const models = document?.providers?.litellm?.models;
  if (!Array.isArray(models)) throw new Error("Pi model catalog does not define providers.litellm.models");
  return new Set(models.map(({ id }) => id).filter((id) => typeof id === "string" && id));
}

function normalizeModel(value, config) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw new Error("model must be a string");
  const trimmed = value.trim();
  if (trimmed.length > 256 || /[\r\n\0]/.test(trimmed)) throw new Error("model is invalid");
  const alias = trimmed.startsWith("litellm/") ? trimmed.slice("litellm/".length) : trimmed;
  if (!allowedModels(config).has(alias)) {
    throw new Error(`model must be a configured LiteLLM alias; unknown alias: ${trimmed}`);
  }
  return `litellm/${alias}`;
}

export function loadDelegationSets(config = createConfig()) {
  const document = parseJsonFile(config.delegationSetsFile, "Pi delegation sets");
  if (!document || typeof document !== "object" || Array.isArray(document) || document.version !== 1) {
    throw new Error("Pi delegation sets must be an object with version 1");
  }
  if (!document.sets || typeof document.sets !== "object" || Array.isArray(document.sets)) {
    throw new Error("Pi delegation sets must define an object named sets");
  }
  const parsed = {};
  for (const [setName, setConfig] of Object.entries(document.sets)) {
    if (!setName.trim() || !setConfig || typeof setConfig !== "object" || Array.isArray(setConfig)) {
      throw new Error("Each Pi delegation set must have a name and object value");
    }
    const unknownSetFields = Object.keys(setConfig).filter((key) => !["delegation_percentage", "roles"].includes(key));
    if (unknownSetFields.length) throw new Error(`Unknown fields in delegation set ${setName}: ${unknownSetFields.join(", ")}`);
    const percentage = validatePercentage(setConfig.delegation_percentage);
    if (percentage === null) throw new Error(`Delegation set ${setName} must define delegation_percentage`);
    if (!setConfig.roles || typeof setConfig.roles !== "object" || Array.isArray(setConfig.roles)) {
      throw new Error(`Delegation set ${setName} must define roles`);
    }
    const roleNames = Object.keys(setConfig.roles);
    const missing = SET_ROLES.filter((role) => !roleNames.includes(role));
    const unknown = roleNames.filter((role) => !SET_ROLES.includes(role));
    if (missing.length || unknown.length) {
      throw new Error(`Invalid roles in delegation set ${setName}; missing=${missing.join(",") || "none"}, unknown=${unknown.join(",") || "none"}`);
    }
    const roles = {};
    for (const role of SET_ROLES) {
      const options = setConfig.roles[role];
      if (!options || typeof options !== "object" || Array.isArray(options)) {
        throw new Error(`Delegation role ${setName}.${role} must be an object`);
      }
      const unknownOptions = Object.keys(options).filter((key) => !["model", "reasoning"].includes(key));
      if (unknownOptions.length) throw new Error(`Unknown options in ${setName}.${role}: ${unknownOptions.join(", ")}`);
      roles[role] = {
        model: normalizeModel(options.model, config),
        reasoning: validateReasoning(options.reasoning),
      };
    }
    parsed[setName.trim()] = { delegation_percentage: percentage, roles };
  }
  return parsed;
}

export function resolveDelegationOptions(role, args, config = createConfig()) {
  const selectedSet = cleanText(args.delegation_set, "delegation_set") || config.defaultDelegationSet;
  let configured = { model: "", reasoning: "" };
  let configuredPercentage = null;
  let sets = null;
  if (selectedSet) {
    sets = loadDelegationSets(config);
    if (!sets[selectedSet]) throw new Error(`Unknown delegation_set ${selectedSet}; available: ${Object.keys(sets).sort().join(", ")}`);
    configured = sets[selectedSet].roles[ROLE_PROFILE_KEYS[role]];
    configuredPercentage = sets[selectedSet].delegation_percentage;
  }
  const model = normalizeModel(args.model || configured.model, config);
  const reasoning = validateReasoning(args.reasoning || configured.reasoning);
  const explicitPercentage = validatePercentage(args.delegation_percentage);
  const percentage = explicitPercentage === null ? configuredPercentage : explicitPercentage;
  return {
    set: selectedSet || null,
    percentage,
    model,
    requestedReasoning: reasoning,
    effectiveThinking: "off",
    roles: sets && selectedSet ? sets[selectedSet].roles : null,
  };
}

function cleanText(value, name, required = false) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new Error(`${name} is required`);
    return "";
  }
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const result = value.trim();
  if (required && !result) throw new Error(`${name} is required`);
  if (result.length > 30000) throw new Error(`${name} exceeds 30000 characters`);
  return result;
}

function makeTaskId(value) {
  if (value !== undefined && value !== null && value !== "") {
    const taskId = cleanText(value, "task_id", true);
    if (!/^TASK-[A-Za-z0-9.-]+$/.test(taskId)) {
      throw new Error("task_id must match TASK-[A-Za-z0-9.-]+");
    }
    return taskId;
  }
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `TASK-${stamp}-${Math.random().toString(16).slice(2, 8)}`;
}

function readRepositoryInstructions(root) {
  const path = resolve(root, "AGENTS.md");
  if (!existsSync(path)) return { path, text: "" };
  try {
    return { path, text: readFileSync(path, "utf8") };
  } catch (error) {
    throw new Error(`Cannot read repository instructions at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function repositoryInstructionPreflight(config = createConfig()) {
  const instructions = readRepositoryInstructions(config.root);
  const missing = [];
  for (const group of REQUIRED_REPOSITORY_TOOL_GROUPS) {
    const requiredByPolicy = config.forceContextMode && group.name === "context-mode";
    const optionalWhenUnavailable = group.name === "RepoVerity" && (!config.repoVerityEnabled || !config.repoVerityRequired);
    const requiredByInstructions = instructions.text && group.triggers.some((trigger) => trigger.test(instructions.text));
    if (!requiredByPolicy && !requiredByInstructions) continue;
    const missingTools = group.tools.filter((toolName) => !config.availableExternalTools.has(toolName));
    if (missingTools.length && !optionalWhenUnavailable) missing.push({ name: group.name, tools: missingTools });
  }
  return { ok: missing.length === 0, path: instructions.path, missing };
}

function blockedPreflightResult(preflight) {
  const lines = [
    "MCP_TOOL: pi_delegator_preflight",
    "STATUS: BLOCKED",
    `REASON: Repository policy or instructions require MCP/tool access that is not declared available to the Pi runtime.`,
    `INSTRUCTIONS: ${preflight.path}`,
    "MISSING:",
    ...preflight.missing.map((group) => `${group.name}: ${group.tools.join(", ")}`),
    "NEXT_ACTION: Configure those MCP/tool servers for the Pi runtime or set PI_AVAILABLE_EXTERNAL_TOOLS/PI_AVAILABLE_MCP_TOOLS to the exact tool names only after verifying Pi can call them. Set PI_FORCE_CONTEXT_MODE=0 only for an intentional local bypass.",
  ];
  return { content: [{ type: "text", text: lines.join("\n") }], isError: true };
}

export function normalizeAllowedPaths(paths, root, required) {
  if (paths === undefined || paths === null) {
    if (required) throw new Error("allowed_paths is required for this tool");
    return [];
  }
  if (!Array.isArray(paths) || paths.length === 0) {
    if (required) throw new Error("allowed_paths must contain at least one path");
    return [];
  }
  if (paths.length > 100) throw new Error("allowed_paths exceeds 100 entries");
  return [...new Set(paths.map((entry) => {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new Error("allowed_paths entries must be non-empty strings");
    }
    if (isAbsolute(entry)) throw new Error(`allowed path must be relative: ${entry}`);
    const absolute = resolve(root, entry);
    const rel = relative(root, absolute);
    if (!rel || rel === "." || rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`allowed path escapes or equals workspace root: ${entry}`);
    }
    return rel;
  }))];
}

export function buildPrompt(role, args, config, resolution = resolveDelegationOptions(role, args, config)) {
  const writer = WRITER_ROLES.has(role);
  const taskId = makeTaskId(args.task_id);
  const task = cleanText(args.task, "task", true);
  const scope = cleanText(args.scope, "scope") || "Only the explicitly requested task.";
  const repositoryInstructions = "Before any repository inspection, tool selection, test, or edit, read the root AGENTS.md when present and any applicable AGENTS.md files in affected directories; follow those instructions, including MCP/tool usage requirements. Use RepoVerity code_* tools first when available. If RepoVerity is unavailable and not explicitly required by runtime policy, continue with Context Mode. Use Context Mode tools for repository inspection, searches, file reads, command execution, and validation; do not use raw read, grep, find, ls, or bash when an equivalent ctx_* path exists. If required non-optional tools or MCP servers are unavailable, stop with BLOCKED and report what is missing.";
  const callerConstraints = cleanText(args.constraints, "constraints");
  const constraints = callerConstraints
    ? `${repositoryInstructions} ${callerConstraints}`
    : `${repositoryInstructions} Do not commit, push, merge, or perform destructive/system operations.`;
  const expected = cleanText(args.expected_output, "expected_output") || "Evidence, files changed, tests, risks, and terminal status.";
  const allowedPaths = normalizeAllowedPaths(args.allowed_paths, config.root, writer);
  const dynamicProfile = Boolean(resolution.set || resolution.model || resolution.requestedReasoning);
  const agentType = dynamicProfile ? ROLE_AGENT_TYPES[role] : role;
  const agent = role === "orchestrator" ? "the minimum necessary specialist agents" : agentType;
  const agentParameters = dynamicProfile && role !== "orchestrator"
    ? ` Pass model: \"${resolution.model}\" and thinking: \"${resolution.effectiveThinking}\" in the Agent call.`
    : "";
  const routing = role === "orchestrator"
    ? "Coordinate the task through Agent calls. Use the MCP agent types and role routing below only as needed. Do not perform task work in main."
    : `Call Agent exactly once in foreground with subagent_type \"${agentType}\".${agentParameters} Do not perform the delegated work in main.`;
  const setRouting = resolution.roles
    ? SET_ROLES.filter((profileRole) => profileRole !== "orchestrate").map((profileRole) => {
      const logicalRole = Object.entries(ROLE_PROFILE_KEYS).find(([, key]) => key === profileRole)?.[0];
      const options = resolution.roles[profileRole];
      return `${logicalRole}: subagent_type=${ROLE_AGENT_TYPES[logicalRole]}, model=${options.model}, thinking=off, requested_reasoning=${options.reasoning}`;
    })
    : [];

  return [
    "MCP PI DELEGATION",
    routing,
    `Pass the complete contract below to ${agent}. Return the complete delegated result and preserve its terminal status.`,
    `DELEGATION_SET: ${resolution.set ?? "none"}`,
    `DELEGATION_PERCENTAGE_TARGET: ${resolution.percentage ?? "unspecified"}`,
    `ROLE_MODEL: ${resolution.model || "agent profile default"}`,
    `ROLE_REASONING_REQUESTED: ${resolution.requestedReasoning || "unspecified"}`,
    `ROLE_THINKING_EFFECTIVE: ${resolution.effectiveThinking}`,
    ...(setRouting.length ? ["SET_ROLE_ROUTING:", ...setRouting] : []),
    "",
    `TASK_ID: ${taskId}`,
    "PARENT_AGENT: main",
    `OBJECTIVE: ${task}`,
    `SCOPE: ${scope}`,
    `CONSTRAINTS: ${constraints}`,
    `FILES: ${allowedPaths.length ? allowedPaths.join(", ") : "read-only; no files may be modified"}`,
    "DEPENDENCIES: Use only repository-local configuration and the configured LiteLLM provider.",
    `EXPECTED_OUTPUT: ${expected}`,
    "",
    writer
      ? `STRICT WRITE SCOPE: ${allowedPaths.join(", ")}. Stop with BLOCKED if work requires another path.`
      : "READ-ONLY: no agent may create, edit, move, or delete files.",
    "End with STATUS: COMPLETED, PARTIAL, or BLOCKED using the role contract.",
  ].join("\n");
}

function appendCapped(state, chunk, limit) {
  if (state.value.length >= limit) return;
  const text = chunk.toString("utf8");
  const remaining = limit - state.value.length;
  state.value += text.slice(0, remaining);
  if (text.length > remaining) state.truncated = true;
}

export function runPi(prompt, config, requestedTimeoutSeconds, selectedModel = "") {
  const configuredTimeout = normalizeTimeoutSeconds(config.timeoutSeconds, MAX_TIMEOUT_SECONDS);
  const requestedTimeout = normalizeTimeoutSeconds(requestedTimeoutSeconds, configuredTimeout);
  const timeoutSeconds = Math.min(requestedTimeout, configuredTimeout);
  const allowedTools = ["Agent", ...config.availableExternalTools].join(",");
  const args = [
    ...config.launcherArgs,
    ...(selectedModel ? ["--model", selectedModel] : []),
    "--no-session",
    "--no-builtin-tools",
    "--tools",
    allowedTools,
    "--print",
    prompt,
  ];

  return new Promise((resolveRun) => {
    const stdout = { value: "", truncated: false };
    const stderr = { value: "", truncated: false };
    const child = spawn(config.launcher, args, {
      cwd: config.root,
      env: process.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timedOut = false;
    let spawnError = null;
    const killChild = () => {
      try {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {}
      setTimeout(() => {
        try {
          if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {}
      }, 2000).unref();
    };
    const timer = timeoutSeconds > 0
      ? setTimeout(() => {
        timedOut = true;
        killChild();
      }, timeoutSeconds * 1000)
      : null;
    timer?.unref();

    child.stdout.on("data", (chunk) => appendCapped(stdout, chunk, config.maxOutputChars));
    child.stderr.on("data", (chunk) => appendCapped(stderr, chunk, Math.min(config.maxOutputChars, 20000)));
    child.on("error", (error) => { spawnError = error; });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolveRun({
        code,
        signal,
        timedOut,
        spawnError,
        stdout: stdout.value.trim(),
        stderr: stderr.value.trim(),
        truncated: stdout.truncated || stderr.truncated,
        timeoutSeconds,
      });
    });
  });
}

function progressToken(value) {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function nativeStatus(status) {
  if (["completed", "failed", "timed_out", "cancelled", "interrupted", "tool_budget_exhausted", "stopped"].includes(status)) return status;
  return "failed";
}

function nativeStatusLabel(status) {
  const normalized = nativeStatus(status);
  if (normalized === "completed") return "COMPLETED";
  if (normalized === "stopped" || normalized === "cancelled" || normalized === "interrupted") return "PARTIAL";
  return "BLOCKED";
}

function nativeResultText(result) {
  if (!result) return "No output returned by Pi.";
  if (typeof result.text === "string") return result.text;
  if (result.result?.kind === "text" && typeof result.result.text === "string") return result.result.text;
  if (result.result?.kind === "structured") return JSON.stringify(result.result.value, null, 2);
  if (typeof result.output === "string") return result.output;
  return JSON.stringify(result, null, 2);
}

function nativeAccounting(role, resolution, terminal) {
  const status = nativeStatus(terminal?.status);
  const completed = status === "completed";
  const usage = terminal?.usage && typeof terminal.usage === "object" ? terminal.usage : {};
  return {
    role: ROLE_PROFILE_KEYS[role],
    set: resolution.set,
    requested_percentage: resolution.percentage,
    attempted_units: 1,
    completed_units: completed ? 1 : 0,
    failed_units: completed ? 0 : 1,
    successful_percentage_for_this_unit: completed ? 100 : 0,
    outcome: status,
    run_id: terminal?.id ?? terminal?.runId ?? null,
    model: (terminal?.model ?? resolution.model) || null,
    requested_reasoning: resolution.requestedReasoning || null,
    effective_thinking: terminal?.thinking ?? resolution.effectiveThinking,
    usage,
    integrated_paths: [],
  };
}

function buildNativeTaskContract(role, args, config, resolution, taskId) {
  const writer = WRITER_ROLES.has(role);
  const task = cleanText(args.task, "task", true);
  const scope = cleanText(args.scope, "scope") || "Only the explicitly requested task.";
  const callerConstraints = cleanText(args.constraints, "constraints");
  const expected = cleanText(args.expected_output, "expected_output") || "Evidence, files changed, tests, risks, and terminal status.";
  const allowedPaths = normalizeAllowedPaths(args.allowed_paths, config.root, writer);
  const constraints = callerConstraints || "Do not commit, push, merge, or perform destructive/system operations.";
  return [
    `TASK_ID: ${taskId}`,
    `ROLE: ${role}`,
    `OBJECTIVE: ${task}`,
    `SCOPE: ${scope}`,
    `CONSTRAINTS: ${constraints}`,
    `FILES: ${allowedPaths.length ? allowedPaths.join(", ") : "read-only; no files may be modified"}`,
    writer
      ? `STRICT WRITE SCOPE: ${allowedPaths.join(", ")}. Stop with BLOCKED if work requires another path.`
      : "READ-ONLY: no agent may create, edit, move, or delete files.",
    `EXPECTED_OUTPUT: ${expected}`,
    "Return concise evidence, terminal status, files changed, tests, and risks.",
  ].join("\n");
}

function nativeSpawnParams(role, args, config, resolution, taskId) {
  const agent = ROLE_AGENT_TYPES[role] || role;
  const timeoutMs = normalizeTimeoutSeconds(args.timeout_seconds, config.timeoutSeconds) * 1000;
  const writer = WRITER_ROLES.has(role);
  const allowedPaths = normalizeAllowedPaths(args.allowed_paths, config.root, writer);
  if (writer) resolveWriteScope(config.root, allowedPaths);
  const ceiling = capabilityCeiling(role, allowedPaths, config.availableExternalTools, config.strictWriterTools);
  if (!ceiling.ok) throw new Error(`Writer preflight failed: ${ceiling.reason}`);
  return {
    agent,
    task: buildNativeTaskContract(role, args, config, resolution, taskId),
    context: "fresh",
    async: true,
    cwd: config.root,
    ...(resolution.model ? { model: `${resolution.model}:${resolution.effectiveThinking}` } : {}),
    timeoutMs,
    toolBudget: { hard: integer(args.tool_budget, 64, 1, 10000) },
    extensionBindings: {
      "pi-delegator/1": {
        mcpTool: ROLE_TO_TOOL[role],
        delegationSet: resolution.set,
        taskId,
        allowedTools: ceiling.tools,
        allowedPaths: ceiling.allowedPaths,
        workspaceRoot: config.root,
        strictWriteScope: config.strictWriterTools,
      },
    },
  };
}

async function runNativeDelegation(role, args, config, resolution, taskId) {
  const host = rpcHost(config);
  const spawned = await host.request("spawn", nativeSpawnParams(role, args, config, resolution, taskId), { restartOnFailure: false });
  const runId = spawned?.id ?? spawned?.runId;
  if (!runId) throw new Error("Pi RPC spawn did not return a run id");
  if (args.background === true) return { spawned, terminal: null };
  const terminal = await host.request("wait", { id: runId, timeoutMs: nativeSpawnParams(role, args, config, resolution, taskId).timeoutMs }, { restartOnFailure: false });
  return { spawned, terminal };
}

function formatNativeDelegation(role, resolution, spawned, terminal) {
  const result = terminal ?? spawned;
  const terminalStatus = terminal ? nativeStatusLabel(result.status) : "PARTIAL";
  const accounting = nativeAccounting(role, resolution, result);
  const details = [
    `MCP_TOOL: ${ROLE_TO_TOOL[role]}`,
    `DELEGATION_SET: ${resolution.set ?? "none"}`,
    `DELEGATION_PERCENTAGE_TARGET: ${resolution.percentage ?? "unspecified"}`,
    `MODEL: ${(result?.model ?? resolution.model) || "agent profile default"}`,
    `REASONING_REQUESTED: ${resolution.requestedReasoning || "unspecified"}`,
    `THINKING_EFFECTIVE: ${result?.thinking ?? resolution.effectiveThinking}`,
    `RUN_ID: ${result?.id ?? result?.runId ?? spawned?.id ?? spawned?.runId ?? "unknown"}`,
    `STATUS: ${terminalStatus}`,
    "RESULT:",
    terminal ? nativeResultText(result) : "Pi delegation started in background.",
    `DELEGATION_ACCOUNTING: ${JSON.stringify(accounting)}`,
    `STRUCTURED_DETAILS: ${JSON.stringify(result ?? {}, null, 2)}`,
  ];
  return { content: [{ type: "text", text: details.join("\n") }], isError: terminal ? nativeStatus(result.status) !== "completed" : false };
}

function activityLogPath(config) {
  return resolve(process.env.PI_AGENT_LOG_DIR || resolve(config.runtimeRoot, "logs"), "pi-agents.jsonl");
}

function eventProgressMessage(entry) {
  const agent = entry.agent || "subagent";
  if (entry.event === "delegation_requested") return `${agent}: delegation requested`;
  if (entry.event === "pixel_agent_session_started") return `${agent}: started`;
  if (entry.event === "delegation_start_timeout") return `${agent}: failed to start before timeout`;
  if (entry.status) return `${agent}: ${entry.status}`;
  return `${agent}: activity updated`;
}

function createProgressReporter(config, taskId, token) {
  const logPath = activityLogPath(config);
  let offset = existsSync(logPath) ? statSync(logPath).size : 0;
  let progress = 0;
  const publish = (message) => {
    if (token === null) return;
    progress += 1;
    send({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progressToken: token, progress, message },
    });
  };
  const poll = () => {
    if (!existsSync(logPath)) return;
    const contents = readFileSync(logPath);
    if (contents.length < offset) offset = 0;
    const added = contents.subarray(offset).toString("utf8");
    offset = contents.length;
    for (const line of added.split(/\r?\n/)) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (entry?.task_id === taskId) publish(eventProgressMessage(entry));
      } catch {
        // Ignore a partial or malformed log line; later lifecycle events still report progress.
      }
    }
  };
  const timer = token === null ? null : setInterval(poll, 250);
  timer?.unref();
  publish("Pi delegation started");
  return {
    stop(outcome) {
      if (timer) clearInterval(timer);
      poll();
      publish(`Pi delegation ${outcome}`);
    },
  };
}

let writerQueue = Promise.resolve();

function queueWriter(operation) {
  const pending = writerQueue.then(operation, operation);
  writerQueue = pending.catch(() => undefined);
  return pending;
}

export async function delegate(role, args, config = createConfig(), token = null) {
  await refreshRepoVerityAvailability(config);
  const preflight = repositoryInstructionPreflight(config);
  if (!preflight.ok) return blockedPreflightResult(preflight);
  const resolution = resolveDelegationOptions(role, args, config);
  const taskId = makeTaskId(args.task_id);
  const native = await runNativeDelegation(role, args, config, resolution, taskId);
  return formatNativeDelegation(role, resolution, native.spawned, native.terminal);
}

export async function delegateLegacy(role, args, config = createConfig(), token = null) {
  await refreshRepoVerityAvailability(config);
  const preflight = repositoryInstructionPreflight(config);
  if (!preflight.ok) return blockedPreflightResult(preflight);
  const resolution = resolveDelegationOptions(role, args, config);
  const taskId = makeTaskId(args.task_id);
  const prompt = buildPrompt(role, { ...args, task_id: taskId }, config, resolution);
  const reporter = createProgressReporter(config, taskId, token);
  const operation = () => runPi(prompt, config, args.timeout_seconds, resolution.model);
  const result = WRITER_ROLES.has(role) ? await queueWriter(operation) : await operation();
  reporter.stop(result.code === 0 ? "finished" : "failed");
  const ok = !result.spawnError && !result.timedOut && result.code === 0;
  const terminalStatus = [...result.stdout.matchAll(/\bSTATUS:\s*(COMPLETED|PARTIAL|BLOCKED)\b/g)].at(-1)?.[1] ?? null;
  const completed = ok && terminalStatus === "COMPLETED";
  const accounting = {
    role: ROLE_PROFILE_KEYS[role],
    set: resolution.set,
    requested_percentage: resolution.percentage,
    attempted_units: 1,
    completed_units: completed ? 1 : 0,
    failed_units: completed ? 0 : 1,
    successful_percentage_for_this_unit: completed ? 100 : 0,
    outcome: terminalStatus?.toLowerCase() ?? (ok ? "unknown" : "failed"),
    model: resolution.model || null,
    requested_reasoning: resolution.requestedReasoning || null,
    effective_thinking: resolution.effectiveThinking,
    integrated_paths: [],
  };
  const details = [
    `MCP_TOOL: ${ROLE_TO_TOOL[role]}`,
    `DELEGATION_SET: ${resolution.set ?? "none"}`,
    `DELEGATION_PERCENTAGE_TARGET: ${resolution.percentage ?? "unspecified"}`,
    `MODEL: ${resolution.model || "agent profile default"}`,
    `REASONING_REQUESTED: ${resolution.requestedReasoning || "unspecified"}`,
    `THINKING_EFFECTIVE: ${resolution.effectiveThinking}`,
    `EXIT_CODE: ${result.code ?? "null"}`,
    `SIGNAL: ${result.signal ?? "none"}`,
    `TIMEOUT_SECONDS: ${result.timeoutSeconds}`,
    `TRUNCATED: ${result.truncated ? "yes" : "no"}`,
  ];
  if (result.spawnError) details.push(`ERROR: ${result.spawnError.message}`);
  if (result.timedOut) details.push("STATUS: BLOCKED", "REASON: Pi delegation timed out");
  if (result.stderr) details.push("DIAGNOSTICS:", result.stderr);
  details.push("RESULT:", result.stdout || "No output returned by Pi.");
  details.push(`DELEGATION_ACCOUNTING: ${JSON.stringify(accounting)}`);
  return {
    content: [{ type: "text", text: details.join("\n") }],
    isError: !ok,
  };
}

function commonProperties(includePaths) {
  const properties = {
    task: { type: "string", description: "Concrete, verifiable delegated task." },
    task_id: { type: "string", description: "Optional TASK-* correlation ID; generated when omitted." },
    scope: { type: "string", description: "Exact directories, services, and limits." },
    constraints: { type: "string", description: "Safety, architecture, and execution constraints." },
    expected_output: { type: "string", description: "Required evidence and response format." },
    timeout_seconds: { type: "integer", minimum: 1, maximum: MAX_TIMEOUT_SECONDS, description: "Per-call timeout in seconds. Omit to use the configured default." },
    delegation_set: { type: "string", description: "Named set from .pi-delegator/delegation-sets.json." },
    delegation_percentage: {
      type: "integer",
      minimum: 0,
      maximum: 100,
      description: "Target percentage of eligible supervisor work to delegate; accounting metadata for this unit.",
    },
    model: { type: "string", description: "Optional configured LiteLLM model alias; overrides the selected set." },
    background: { type: "boolean", description: "Start the delegation asynchronously and return the run id without waiting for completion." },
    tool_budget: { type: "integer", minimum: 1, maximum: 10000, description: "Hard maximum tool calls for the native pi-subagents run." },
    reasoning: {
      type: "string",
      enum: [...REASONING_LEVELS],
      description: "Requested reasoning level; current Pi LiteLLM models clamp effective thinking to off.",
    },
  };
  if (includePaths) {
    properties.allowed_paths = {
      type: "array",
      minItems: 1,
      maxItems: 100,
      items: { type: "string" },
      description: "Relative paths that the delegated writer may modify.",
    };
  }
  return properties;
}

function tool(name, description, role, writer = false) {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: commonProperties(writer),
      required: writer ? ["task", "allowed_paths"] : ["task"],
    },
    role,
  };
}

export function validateToolArguments(definition, args = {}) {
  if (!definition || typeof definition !== "object") throw new Error("tool definition is required");
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("tool arguments must be an object");
  const schema = definition.inputSchema;
  if (!schema || typeof schema !== "object" || schema.type !== "object") return args;
  const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
    ? schema.properties
    : {};
  const allowed = new Set(Object.keys(properties));
  const unknown = Object.keys(args).filter((key) => !allowed.has(key));
  if (schema.additionalProperties === false && unknown.length) {
    throw new Error(`Unknown properties for ${definition.name}: ${unknown.join(", ")}`);
  }
  for (const required of Array.isArray(schema.required) ? schema.required : []) {
    if (args[required] === undefined || args[required] === null) throw new Error(`${required} is required`);
  }
  for (const [key, value] of Object.entries(args)) {
    const property = properties[key];
    if (!property || typeof property !== "object" || value === undefined || value === null) continue;
    if (property.type === "string" && typeof value !== "string") throw new Error(`${key} must be a string`);
    if (property.type === "boolean" && typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
    if (property.type === "integer" && (!Number.isInteger(value) || value < property.minimum || value > property.maximum)) {
      throw new Error(`${key} must be an integer between ${property.minimum} and ${property.maximum}`);
    }
    if (property.type === "array") {
      if (!Array.isArray(value)) throw new Error(`${key} must be an array`);
      if (Number.isInteger(property.minItems) && value.length < property.minItems) throw new Error(`${key} must contain at least ${property.minItems} item(s)`);
      if (Number.isInteger(property.maxItems) && value.length > property.maxItems) throw new Error(`${key} must contain at most ${property.maxItems} item(s)`);
    }
    if (Array.isArray(property.enum) && !property.enum.includes(value)) throw new Error(`${key} must be one of: ${property.enum.join(", ")}`);
  }
  return args;
}

function runControlTool(name, description, properties, required = []) {
  return {
    name,
    description,
    inputSchema: { type: "object", additionalProperties: false, properties, required },
    role: name.replace(/^pi_run_/, "run_"),
  };
}

export const TOOL_DEFINITIONS = [
  tool("pi_orchestrate", "Coordinate a multi-phase Pi workflow through specialist agents.", "orchestrator", true),
  tool("pi_research", "Delegate read-only repository research or diagnosis to Pi researcher.", "researcher"),
  tool("pi_implement", "Delegate a bounded implementation to Pi coder. Requires strict relative write paths.", "coder", true),
  tool("pi_tests", "Delegate test execution or bounded test edits to Pi tester. Requires strict relative write paths.", "tester", true),
  tool("pi_review", "Delegate an independent, read-only review to Pi reviewer.", "reviewer"),
  runControlTool("pi_run_status", "List native Pi runs or inspect one run by id.", {
    id: { type: "string", description: "Optional opaque run id." },
  }),
  runControlTool("pi_run_wait", "Wait for a native Pi run without cancelling it when the wait window expires.", {
    id: { type: "string", description: "Opaque run id returned by a background delegation." },
    timeout_ms: { type: "integer", minimum: 1, maximum: MAX_WAIT_MS, description: "Maximum wait window in milliseconds." },
  }, ["id"]),
  runControlTool("pi_run_stop", "Stop a native Pi run and report stopped state.", {
    id: { type: "string", description: "Opaque run id." },
  }, ["id"]),
  runControlTool("pi_run_steer", "Send guidance to a live native Pi run.", {
    id: { type: "string", description: "Opaque run id." },
    message: { type: "string", description: "Non-empty guidance to deliver or queue." },
  }, ["id", "message"]),
  runControlTool("pi_run_resume", "Resume an eligible native Pi run with a follow-up message.", {
    id: { type: "string", description: "Opaque run id." },
    message: { type: "string", description: "Non-empty follow-up task." },
  }, ["id", "message"]),
  {
    name: "pi_delegation_sets",
    description: "List the current Pi delegation sets, role models, reasoning metadata, percentages, and default.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    role: "sets",
  },
  {
    name: "pi_status",
    description: "Check the local Pi MCP launcher and configuration without calling a model.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    role: "status",
  },
  {
    name: "pi_activity",
    description: "Show active Pi subagents and recent lifecycle events inside the current Copilot chat.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        task_id: { type: "string", description: "Optional TASK-* correlation ID." },
        agent: { type: "string", description: "Optional agent profile, such as coder-mcp or reviewer-mcp." },
        limit: { type: "integer", minimum: 1, maximum: MAX_ACTIVITY_EVENTS, description: "Maximum recent events to return. Defaults to 20." },
      },
    },
    role: "activity",
  },
];

function activityEntries(config, args) {
  const logPath = resolve(process.env.PI_AGENT_LOG_DIR || resolve(config.runtimeRoot, "logs"), "pi-agents.jsonl");
  if (!existsSync(logPath)) return { logPath, entries: [] };
  const taskId = cleanText(args.task_id, "task_id");
  const agent = cleanText(args.agent, "agent");
  const entries = readFileSync(logPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const entry = JSON.parse(line);
        return entry && typeof entry === "object" ? [entry] : [];
      } catch {
        return [];
      }
    })
    .filter((entry) => !taskId || entry.task_id === taskId)
    .filter((entry) => !agent || entry.agent === agent);
  return { logPath, entries };
}

export function activity(args = {}, config = createConfig()) {
  const limit = integer(args.limit, 20, 1, MAX_ACTIVITY_EVENTS);
  const { logPath, entries } = activityEntries(config, args);
  const activeBySession = new Map();
  for (const entry of entries) {
    if (entry.event === "pixel_agent_session_started" && entry.session_id) {
      activeBySession.set(entry.session_id, entry);
    } else if (!entry.event || entry.event === "subagent_interrupted") {
      if (entry.session_id) {
        activeBySession.delete(entry.session_id);
        continue;
      }
      const legacySession = [...activeBySession.entries()].reverse().find(([, active]) =>
        active.task_id === entry.task_id && active.agent === entry.agent
      );
      if (legacySession) activeBySession.delete(legacySession[0]);
    }
  }
  const activeStatePath = resolve(dirname(logPath), "pixel-agents-active-sessions.json");
  if (existsSync(activeStatePath)) {
    try {
      const state = JSON.parse(readFileSync(activeStatePath, "utf8"));
      const activeSessionIds = new Set(Array.isArray(state?.active_sessions) ? state.active_sessions : []);
      const updatedAt = Date.parse(String(state?.updated_at ?? ""));
      const stateIsStale = !Number.isFinite(updatedAt) || Date.now() - updatedAt > ACTIVE_SESSION_STALE_MS;
      for (const sessionId of activeBySession.keys()) {
        if (stateIsStale || !activeSessionIds.has(sessionId)) activeBySession.delete(sessionId);
      }
    } catch {
      // Fall back to lifecycle-event reconciliation when runtime state is unreadable.
    }
  }
  const payload = {
    log_path: logPath,
    active_count: activeBySession.size,
    active_state_stale_after_ms: ACTIVE_SESSION_STALE_MS,
    active: [...activeBySession.values()].map((entry) => ({
      session_id: entry.session_id,
      task_id: entry.task_id ?? null,
      agent: entry.agent ?? null,
      started_at: entry.timestamp ?? null,
    })),
    recent: entries.slice(-limit),
  };
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

export function delegationSets(config = createConfig()) {
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        default: config.defaultDelegationSet || null,
        sets: loadDelegationSets(config),
        semantics: {
          requested_percentage: "Target share of eligible supervisor work delegated across the wider task.",
          successful_percentage_for_this_unit: "100 only when this MCP unit returns COMPLETED; otherwise 0.",
          effective_thinking: "off because current LiteLLM model catalog declares reasoning=false.",
        },
      }, null, 2),
    }],
  };
}

export async function status(config = createConfig()) {
  await refreshRepoVerityAvailability(config);
  const checks = [];
  for (const [label, path, mode] of [
    ["workspace", config.root, constants.R_OK],
    ["launcher", config.launcher, constants.R_OK | constants.X_OK],
    ["Pi settings", resolve(config.runtimeRoot, "settings.json"), constants.R_OK],
    ["Pi environment", resolve(config.runtimeRoot, "pi.env"), constants.R_OK],
  ]) {
    try {
      accessSync(path, mode);
      checks.push(`${label}: OK (${path})`);
    } catch {
      checks.push(`${label}: ${label === "Pi environment" ? "WARN" : "ERROR"} (${path})`);
    }
  }
  return {
    content: [{
      type: "text",
      text: [
        "PI MCP STATUS",
        ...checks,
        `timeout_seconds: ${config.timeoutSeconds}`,
        `max_output_chars: ${config.maxOutputChars}`,
        `runtime_root: ${config.runtimeRoot}`,
        `rpc_host_state: ${rpcHost(config).getState()}`,
        `rpc_session_root: ${config.rpcSessionRoot}`,
        `force_context_mode: ${config.forceContextMode ? "yes" : "no"}`,
        `repoverity_enabled: ${config.repoVerityEnabled ? "yes" : "no"}`,
        `repoverity_availability: ${config.repoVerityAvailability}`,
        `repoverity_required: ${config.repoVerityRequired ? "yes" : "no"}`,
        `delegation_sets_file: ${config.delegationSetsFile}`,
        `default_delegation_set: ${config.defaultDelegationSet || "none"}`,
        `available_external_tools: ${config.availableExternalTools.size ? [...config.availableExternalTools].sort().join(", ") : "none"}`,
        `tools: ${TOOL_DEFINITIONS.map(({ name }) => name).join(", ")}`,
        "Pi environment may be supplied through process variables instead of .pi-delegator/pi.env.",
      ].join("\n"),
    }],
  };
}

function controlArgs(args) {
  const id = cleanText(args.id, "id");
  const message = cleanText(args.message, "message");
  return { id, message, timeoutMs: integer(args.timeout_ms, 60_000, 1, MAX_WAIT_MS) };
}

async function runControl(role, args, config) {
  const host = rpcHost(config);
  const normalized = controlArgs(args);
  let method;
  let params;
  let options = { restartOnFailure: false };
  if (role === "run_status") {
    method = "status";
    params = normalized.id ? { id: normalized.id } : {};
    options = { idempotent: true };
  } else if (role === "run_wait") {
    method = "wait";
    params = { id: normalized.id, timeoutMs: normalized.timeoutMs };
  } else if (role === "run_stop") {
    method = "stop";
    params = { id: normalized.id };
  } else if (role === "run_steer") {
    method = "steer";
    params = { id: normalized.id, message: normalized.message };
  } else if (role === "run_resume") {
    method = "resume";
    params = { id: normalized.id, message: normalized.message };
  } else {
    throw new Error(`Unknown run control role: ${role}`);
  }
  const result = await host.request(method, params, options);
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: Boolean(result?.isError) };
}

export async function callTool(name, args = {}, config = createConfig(), token = null) {
  const definition = TOOL_DEFINITIONS.find((candidate) => candidate.name === name);
  if (!definition) throw new Error(`Unknown tool: ${name}`);
  validateToolArguments(definition, args);
  if (definition.role === "status") return status(config);
  if (definition.role === "sets") return delegationSets(config);
  if (definition.role === "activity") return activity(args, config);
  if (String(definition.role).startsWith("run_")) return runControl(definition.role, args, config);
  return delegate(definition.role, args, config, progressToken(token));
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handleMessage(message, config) {
  if (!message || typeof message !== "object" || !message.method) return;
  if (message.id === undefined || message.id === null) return;
  try {
    let result;
    switch (message.method) {
      case "initialize":
        result = {
          protocolVersion: message.params?.protocolVersion || PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "pi-delegator", version: SERVER_VERSION },
        };
        break;
      case "ping":
        result = {};
        break;
      case "tools/list":
        result = { tools: TOOL_DEFINITIONS.map(({ role: _role, ...definition }) => definition) };
        break;
      case "tools/call":
        result = await callTool(message.params?.name, message.params?.arguments ?? {}, config, message.params?._meta?.progressToken);
        break;
      default:
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
        return;
    }
    send({ jsonrpc: "2.0", id: message.id, result });
  } catch (error) {
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32602, message: error instanceof Error ? error.message : String(error) },
    });
  }
}

export function main(config = createConfig()) {
  if (!existsSync(config.root)) throw new Error(`PI_MCP_ALLOWED_ROOT does not exist: ${config.root}`);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      void shutdownAllRpcHosts().finally(() => process.exit(0));
    });
  }
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    void handleMessage(message, config);
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main();
