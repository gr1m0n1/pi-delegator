#!/usr/bin/env node

import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import readline from "node:readline";

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
  researcher: "researcher-mcp",
  coder: "coder-mcp",
  tester: "tester-mcp",
  reviewer: "reviewer-mcp",
};
const FALLBACK_DELEGATION_SET = "default";
const SET_ROLES = ["research", "implement", "tests", "review", "orchestrate"];
const REASONING_LEVELS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

function integer(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

function normalizeTimeoutSeconds(value, fallback) {
  if (value === 0 || value === "0") return 0;
  return integer(value, fallback, 1, 7200);
}

export function createConfig(env = process.env) {
  const root = resolve(env.PI_MCP_ALLOWED_ROOT || DEFAULT_ROOT);
  return {
    root,
    launcher: resolve(env.PI_MCP_PI_AGENT || resolve(root, ".pi-delegator/bin/pi-agent")),
    launcherArgs: [],
    timeoutSeconds: normalizeTimeoutSeconds(env.PI_MCP_TIMEOUT_SECONDS, 0),
    maxOutputChars: integer(env.PI_MCP_MAX_OUTPUT_CHARS, 50000, 1000, 500000),
    delegationSetsFile: resolve(env.PI_DELEGATION_SETS_FILE || resolve(root, ".pi-delegator/delegation-sets.json")),
    defaultDelegationSet: String(env.PI_DEFAULT_DELEGATION_SET || FALLBACK_DELEGATION_SET).trim() || FALLBACK_DELEGATION_SET,
  };
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
  const document = parseJsonFile(resolve(config.root, ".pi-delegator/models.json.template"), "Pi model catalog");
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
  const constraints = cleanText(args.constraints, "constraints") || "Follow repository instructions; do not commit, push, merge, or perform destructive/system operations.";
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
  const normalizedRequestedTimeout = normalizeTimeoutSeconds(requestedTimeoutSeconds, config.timeoutSeconds);
  const timeoutSeconds = config.timeoutSeconds === 0
    ? normalizedRequestedTimeout
    : normalizedRequestedTimeout === 0
      ? 0
      : Math.min(normalizedRequestedTimeout, config.timeoutSeconds);
  const args = [
    ...config.launcherArgs,
    ...(selectedModel ? ["--model", selectedModel] : []),
    "--no-session",
    "--no-builtin-tools",
    "--tools",
    "Agent",
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

let writerQueue = Promise.resolve();

function queueWriter(operation) {
  const pending = writerQueue.then(operation, operation);
  writerQueue = pending.catch(() => undefined);
  return pending;
}

export async function delegate(role, args, config = createConfig()) {
  const resolution = resolveDelegationOptions(role, args, config);
  const prompt = buildPrompt(role, args, config, resolution);
  const operation = () => runPi(prompt, config, args.timeout_seconds, resolution.model);
  const result = WRITER_ROLES.has(role) ? await queueWriter(operation) : await operation();
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
    timeout_seconds: { type: "integer", minimum: 0, maximum: 7200, description: "0 disables the timeout." },
    delegation_set: { type: "string", description: "Named set from .pi-delegator/delegation-sets.json." },
    delegation_percentage: {
      type: "integer",
      minimum: 0,
      maximum: 100,
      description: "Target percentage of eligible supervisor work to delegate; accounting metadata for this unit.",
    },
    model: { type: "string", description: "Optional configured LiteLLM model alias; overrides the selected set." },
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

export const TOOL_DEFINITIONS = [
  tool("pi_orchestrate", "Coordinate a multi-phase Pi workflow through specialist agents.", "orchestrator", true),
  tool("pi_research", "Delegate read-only repository research or diagnosis to Pi researcher.", "researcher"),
  tool("pi_implement", "Delegate a bounded implementation to Pi coder. Requires strict relative write paths.", "coder", true),
  tool("pi_tests", "Delegate test execution or bounded test edits to Pi tester. Requires strict relative write paths.", "tester", true),
  tool("pi_review", "Delegate an independent, read-only review to Pi reviewer.", "reviewer"),
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
];

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

export function status(config = createConfig()) {
  const checks = [];
  for (const [label, path, mode] of [
    ["workspace", config.root, constants.R_OK],
    ["launcher", config.launcher, constants.R_OK | constants.X_OK],
    ["Pi settings", resolve(config.root, ".pi-delegator/settings.json"), constants.R_OK],
    ["Pi environment", resolve(config.root, ".pi-delegator/pi.env"), constants.R_OK],
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
        `delegation_sets_file: ${config.delegationSetsFile}`,
        `default_delegation_set: ${config.defaultDelegationSet || "none"}`,
        `tools: ${TOOL_DEFINITIONS.map(({ name }) => name).join(", ")}`,
        "Pi environment may be supplied through process variables instead of .pi-delegator/pi.env.",
      ].join("\n"),
    }],
  };
}

export async function callTool(name, args = {}, config = createConfig()) {
  const definition = TOOL_DEFINITIONS.find((candidate) => candidate.name === name);
  if (!definition) throw new Error(`Unknown tool: ${name}`);
  if (definition.role === "status") return status(config);
  if (definition.role === "sets") return delegationSets(config);
  return delegate(definition.role, args, config);
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
        result = await callTool(message.params?.name, message.params?.arguments ?? {}, config);
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
