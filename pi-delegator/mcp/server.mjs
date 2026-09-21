#!/usr/bin/env node

import { accessSync, appendFileSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename, delimiter, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import readline from "node:readline";

import { PiRpcHost } from "./pi-rpc-host.mjs";

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
  orchestrator: "orchestrator-mcp",
  researcher: "researcher-mcp",
  coder: "coder-mcp",
  tester: "tester-mcp",
  reviewer: "reviewer-mcp",
};
const MAX_TIMEOUT_SECONDS = 7200;
const MAX_ACTIVITY_EVENTS = 100;
const ACTIVE_SESSION_STALE_MS = integer(process.env.PI_ACTIVE_SESSION_STALE_MS, 90_000, 10_000, 3_600_000);
const FALLBACK_DELEGATION_SET = "default";
const SET_ROLES = ["research", "implement", "tests", "review", "orchestrate"];
const JEV_MODES = new Set(["off", "observe", "auto"]);
const JEV_PROVIDERS = new Set(["typesafe", "openrouter"]);
const JEV_DECISIONS = new Set(["delegation_set", "initial_role", "research_first", "request_sufficiency", "additional_review_focus"]);
const ROUTABLE_ROLES = new Set(["orchestrator", "researcher", "coder", "tester", "reviewer"]);
const REASONING_LEVELS = new Set(["none", "off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
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
  const launcher = resolve(env.PI_MCP_PI_AGENT || resolve(runtimeRoot, "bin/pi-agent"));
  return {
    root,
    runtimeRoot,
    launcher,
    launcherArgs: [],
    timeoutSeconds: normalizeTimeoutSeconds(env.PI_MCP_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS),
    maxOutputChars: integer(env.PI_MCP_MAX_OUTPUT_CHARS, 50000, 1000, 500000),
    delegationSetsFile: resolve(env.PI_DELEGATION_SETS_FILE || resolve(runtimeRoot, "delegation-sets.json")),
    modelCatalogFile: resolve(env.PI_MODELS_CATALOG_FILE || resolve(runtimeRoot, "models.json.template")),
    defaultDelegationSet: String(env.PI_DEFAULT_DELEGATION_SET || FALLBACK_DELEGATION_SET).trim() || FALLBACK_DELEGATION_SET,
    availableExternalTools,
    forceContextMode: booleanFlag(env.PI_FORCE_CONTEXT_MODE, true),
    repoVerityRequired: booleanFlag(env.PI_REPOVERITY_REQUIRED, false),
    rpcLauncher: env.PI_MCP_PI_RPC ? resolve(env.PI_MCP_PI_RPC) : launcher,
    rpcArgs: env.PI_MCP_RPC_ARGS === undefined
      ? ["--mode", "rpc"]
      : String(env.PI_MCP_RPC_ARGS).split(/\s+/).filter(Boolean),
    rpcSessionRoot: resolve(env.PI_MCP_RPC_SESSION_ROOT || resolve(runtimeRoot, "sessions", "mcp")),
    rpcHandshakeTimeoutMs: integer(env.PI_MCP_RPC_HANDSHAKE_TIMEOUT_MS, 90_000, 500, 300_000),
    rpcRequestTimeoutMs: normalizeTimeoutSeconds(env.PI_MCP_RPC_REQUEST_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS) * 1000,
    jevConfigFile: env.PI_JEV_CONFIG_FILE ? resolve(env.PI_JEV_CONFIG_FILE) : null,
    jevModeOverride: env.PI_JEV_MODE === undefined ? null : String(env.PI_JEV_MODE).trim(),
    jevApiKeyOverrides: {
      typesafe: env.TYPESAFE_API_KEY || "",
      openrouter: env.OPENROUTER_API_KEY || "",
    },
  };
}

function parseToolList(value) {
  return new Set(String(value || "").split(/[\s,]+/).map((entry) => entry.trim()).filter(Boolean));
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
    resolve(runtimeRoot, "mcp.json"),
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
  const candidates = [
    resolve(runtimeRoot, "mcp.json"),
    resolve(root, ".pi", "mcp.json"),
  ];
  return candidates.some((path) => repoVerityServerConfigured(path, env)) ? REPOVERITY_TOOLS : [];
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

function effectiveThinking(model, reasoning, config) {
  if (!model || reasoning === "none" || reasoning === "off") return "off";
  const document = parseJsonFile(config.modelCatalogFile, "Pi model catalog");
  const alias = model.replace(/^litellm\//, "");
  const entry = document?.providers?.litellm?.models?.find((candidate) => candidate.id === alias);
  if (entry?.reasoning !== true) return "off";
  return reasoning === "ultra" ? "max" : reasoning;
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
      const unknownOptions = Object.keys(options).filter((key) => !["model", "reasoning", "fallback"].includes(key));
      if (unknownOptions.length) throw new Error(`Unknown options in ${setName}.${role}: ${unknownOptions.join(", ")}`);
      let fallback = null;
      if (options.fallback !== undefined) {
        if (!options.fallback || typeof options.fallback !== "object" || Array.isArray(options.fallback)) {
          throw new Error(`Fallback in ${setName}.${role} must be an object`);
        }
        const unknownFallbackOptions = Object.keys(options.fallback).filter((key) => !["model", "reasoning"].includes(key));
        if (unknownFallbackOptions.length) {
          throw new Error(`Unknown fallback options in ${setName}.${role}: ${unknownFallbackOptions.join(", ")}`);
        }
        fallback = {
          model: normalizeModel(options.fallback.model, config),
          reasoning: validateReasoning(options.fallback.reasoning),
        };
      }
      roles[role] = {
        model: normalizeModel(options.model, config),
        reasoning: validateReasoning(options.reasoning),
        ...(fallback ? { fallback } : {}),
      };
    }
    parsed[setName.trim()] = { delegation_percentage: percentage, roles };
  }
  return parsed;
}

export function resolveDelegationOptions(role, args, config = createConfig()) {
  const selectedSet = cleanText(args.delegation_set, "delegation_set") || config.defaultDelegationSet;
  let configured = { model: "", reasoning: "", fallback: null };
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
    effectiveThinking: effectiveThinking(model, reasoning, config),
    fallback: configured.fallback
      ? {
          model: configured.fallback.model,
          reasoning: configured.fallback.reasoning,
          effectiveThinking: effectiveThinking(configured.fallback.model, configured.fallback.reasoning, config),
        }
      : null,
    roles: sets && selectedSet ? sets[selectedSet].roles : null,
  };
}

function validateJevMode(value, source) {
  const mode = String(value ?? "off").trim() || "off";
  if (!JEV_MODES.has(mode)) throw new Error(`${source} must be one of ${[...JEV_MODES].join(", ")}`);
  return mode;
}

function normalizeJevDecisionConfig(name, value = {}) {
  if (!JEV_DECISIONS.has(name)) throw new Error(`Unsupported Jev decision: ${name}`);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Jev decision ${name} must be an object`);
  }
  const allowed = new Set(["enabled", "allowed_values", "min_choice_probability", "min_confidence"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`Unknown options in Jev decision ${name}: ${unknown.join(", ")}`);
  const enabled = value.enabled === true;
  const allowedValues = value.allowed_values === undefined
    ? []
    : value.allowed_values;
  if (!Array.isArray(allowedValues) || allowedValues.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error(`Jev decision ${name}.allowed_values must be an array of non-empty strings`);
  }
  const minChoiceProbability = Number(value.min_choice_probability ?? 0.9);
  const minConfidence = Number(value.min_confidence ?? 0.8);
  if (!Number.isFinite(minChoiceProbability) || minChoiceProbability < 0 || minChoiceProbability > 1) {
    throw new Error(`Jev decision ${name}.min_choice_probability must be between 0 and 1`);
  }
  if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
    throw new Error(`Jev decision ${name}.min_confidence must be between 0 and 1`);
  }
  return {
    enabled,
    allowedValues: allowedValues.map((entry) => entry.trim()),
    minChoiceProbability,
    minConfidence,
  };
}

export function loadJevConfig(config = createConfig()) {
  const raw = config.jevConfigFile
    ? JSON.parse(readFileSync(config.jevConfigFile, "utf8"))
    : {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Jev config must be an object");
  const unknown = Object.keys(raw).filter((key) => !["version", "mode", "provider", "timeout_ms", "max_calls_per_task", "fallback", "decisions"].includes(key));
  if (unknown.length) throw new Error(`Unknown Jev config options: ${unknown.join(", ")}`);
  const mode = validateJevMode(config.jevModeOverride ?? raw.mode ?? "off", "Jev mode");
  const provider = raw.provider ?? { name: "typesafe", model: "jev-latest", api_key_env: "TYPESAFE_API_KEY" };
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) throw new Error("Jev provider must be an object");
  const providerName = String(provider.name ?? "").trim();
  if (!JEV_PROVIDERS.has(providerName)) throw new Error(`Jev provider.name must be one of ${[...JEV_PROVIDERS].join(", ")}`);
  const model = cleanText(provider.model ?? (providerName === "openrouter" ? "typesafe/jev-1.13" : "jev-latest"), "provider.model", true);
  const apiKeyEnv = cleanText(provider.api_key_env ?? (providerName === "openrouter" ? "OPENROUTER_API_KEY" : "TYPESAFE_API_KEY"), "provider.api_key_env", true);
  const decisions = {};
  const rawDecisions = raw.decisions ?? {};
  if (!rawDecisions || typeof rawDecisions !== "object" || Array.isArray(rawDecisions)) throw new Error("Jev decisions must be an object");
  for (const [name, value] of Object.entries(rawDecisions)) decisions[name] = normalizeJevDecisionConfig(name, value);
  for (const name of JEV_DECISIONS) {
    if (!decisions[name]) decisions[name] = normalizeJevDecisionConfig(name, { enabled: false });
  }
  const timeoutMs = integer(raw.timeout_ms, 1500, 100, 30000);
  const maxCallsPerTask = integer(raw.max_calls_per_task, 1, 1, 10);
  return {
    version: raw.version ?? 1,
    mode,
    provider: {
      name: providerName,
      model,
      apiKeyEnv,
      apiKey: config.jevApiKeyOverrides?.[providerName] || process.env[apiKeyEnv] || "",
    },
    timeoutMs,
    maxCallsPerTask,
    fallback: raw.fallback ?? "existing_behavior",
    decisions,
  };
}

function jevActivityLogPath(config) {
  return resolve(process.env.PI_AGENT_LOG_DIR || resolve(config.runtimeRoot, "logs"), "pi-jev-decisions.jsonl");
}

function logJevDecision(config, entry) {
  try {
    mkdirSync(dirname(jevActivityLogPath(config)), { recursive: true });
    appendFileSync(jevActivityLogPath(config), `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`);
  } catch {}
}

function normalizeJevDecisionResult(raw, allowedValues) {
  const choice = cleanText(raw?.choice ?? raw?.answer ?? raw?.value ?? "", "Jev choice");
  const probability = Number(raw?.probability ?? raw?.choice_probability ?? raw?.score ?? 0);
  const confidence = Number(raw?.confidence ?? raw?.confidence_score ?? probability);
  const reason = cleanText(raw?.reason ?? raw?.explanation ?? "", "Jev reason");
  if (!choice) return { choice: "", probability: 0, confidence: 0, reason, valid: false };
  const valid = allowedValues.length === 0 || allowedValues.includes(choice);
  return {
    choice,
    probability: Number.isFinite(probability) ? probability : 0,
    confidence: Number.isFinite(confidence) ? confidence : 0,
    reason,
    valid,
  };
}

async function withTimeout(promise, timeoutMs) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Jev decision timed out after ${timeoutMs}ms`)), timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function callJevProvider(jevConfig, decision, state, allowedValues) {
  if (!jevConfig.provider.apiKey) throw new Error(`Missing ${jevConfig.provider.apiKeyEnv}`);
  const question = {
    id: decision,
    type: "choice",
    choices: allowedValues,
    prompt: `Choose the best ${decision} for this Pi delegation request.`,
  };
  const body = {
    model: jevConfig.provider.model,
    state,
    questions: [question],
  };
  const endpoint = jevConfig.provider.name === "openrouter"
    ? "https://openrouter.ai/api/v1/alpha/decisions"
    : "https://api.typesafe.ai/v1/systemone";
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${jevConfig.provider.apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Jev provider ${jevConfig.provider.name} returned HTTP ${response.status}`);
  const data = await response.json();
  const answer = data?.answers?.[decision] ?? data?.answers?.[0] ?? data?.decisions?.[decision] ?? data?.choices?.[0] ?? data;
  return normalizeJevDecisionResult(answer, allowedValues);
}

async function decideWithJev(decision, state, config, defaults = {}) {
  const started = Date.now();
  const jevConfig = loadJevConfig(config);
  const decisionConfig = jevConfig.decisions[decision];
  const base = {
    decision,
    mode: jevConfig.mode,
    provider: jevConfig.provider.name,
    model: jevConfig.provider.model,
    question_version: 1,
  };
  if (jevConfig.mode === "off" || !decisionConfig?.enabled) {
    return { mode: jevConfig.mode, applied: false, fallbackCode: "disabled", recommendation: null };
  }
  try {
    const allowedValues = decisionConfig.allowedValues.length ? decisionConfig.allowedValues : defaults.allowedValues ?? [];
    const raw = config.jevDecisionClient
      ? await config.jevDecisionClient({ decision, state, allowedValues, jevConfig, decisionConfig })
      : await withTimeout(callJevProvider(jevConfig, decision, state, allowedValues), jevConfig.timeoutMs);
    const recommendation = normalizeJevDecisionResult(raw, allowedValues);
    const thresholdsMet = recommendation.valid &&
      recommendation.probability >= decisionConfig.minChoiceProbability &&
      recommendation.confidence >= decisionConfig.minConfidence;
    const applied = jevConfig.mode === "auto" && thresholdsMet;
    logJevDecision(config, {
      ...base,
      recommendation: recommendation.choice || null,
      applied_choice: applied ? recommendation.choice : null,
      confidence: recommendation.confidence,
      probability: recommendation.probability,
      duration_ms: Date.now() - started,
      fallback_code: applied ? null : (thresholdsMet ? "observe_mode" : "below_threshold"),
    });
    return {
      mode: jevConfig.mode,
      applied,
      fallbackCode: applied ? null : (thresholdsMet ? "observe_mode" : "below_threshold"),
      recommendation,
    };
  } catch (error) {
    logJevDecision(config, {
      ...base,
      recommendation: null,
      applied_choice: null,
      duration_ms: Date.now() - started,
      fallback_code: "error",
      error: error instanceof Error ? error.message : String(error),
    });
    return { mode: jevConfig.mode, applied: false, fallbackCode: "error", recommendation: null, error };
  }
}

async function resolveDelegationOptionsWithJev(role, args, config) {
  if (args.delegation_set !== undefined && args.delegation_set !== null && args.delegation_set !== "") {
    return { resolution: resolveDelegationOptions(role, args, config), decision: null };
  }
  const sets = loadDelegationSets(config);
  const decision = await decideWithJev("delegation_set", {
    task: cleanText(args.task, "task"),
    scope: cleanText(args.scope, "scope"),
    constraints: cleanText(args.constraints, "constraints"),
    role,
    available_delegation_sets: Object.keys(sets).sort(),
  }, config, { allowedValues: Object.keys(sets).sort() });
  const selectedArgs = decision.applied
    ? { ...args, delegation_set: decision.recommendation.choice }
    : args;
  return { resolution: resolveDelegationOptions(role, selectedArgs, config), decision };
}

async function selectRouteRole(args, config) {
  const allowedPathsPresent = Array.isArray(args.allowed_paths) && args.allowed_paths.length > 0;
  const decision = await decideWithJev("initial_role", {
    task: cleanText(args.task, "task", true),
    scope: cleanText(args.scope, "scope"),
    constraints: cleanText(args.constraints, "constraints"),
    expected_output: cleanText(args.expected_output, "expected_output"),
    allowed_paths_present: allowedPathsPresent,
  }, config, { allowedValues: [...ROUTABLE_ROLES] });
  const role = decision.applied && ROUTABLE_ROLES.has(decision.recommendation.choice)
    ? decision.recommendation.choice
    : (allowedPathsPresent ? "orchestrator" : "researcher");
  return { role, decision };
}

async function applyRoutePhaseDecisions(args, config, selectedRole) {
  const commonState = {
    task: cleanText(args.task, "task", true),
    scope: cleanText(args.scope, "scope"),
    constraints: cleanText(args.constraints, "constraints"),
    expected_output: cleanText(args.expected_output, "expected_output"),
    selected_role: selectedRole,
    allowed_paths_present: Array.isArray(args.allowed_paths) && args.allowed_paths.length > 0,
  };
  const sufficiency = await decideWithJev("request_sufficiency", commonState, config, {
    allowedValues: ["sufficient", "needs_clarification"],
  });
  if (sufficiency.applied && sufficiency.recommendation.choice === "needs_clarification") {
    return {
      role: selectedRole,
      decisions: { request_sufficiency: sufficiency },
      blocked: {
        text: [
          "STATUS: PARTIAL",
          "REASON: Jev recommended asking for clarification before delegation.",
          `JEV_REQUEST_SUFFICIENCY_RECOMMENDATION: ${sufficiency.recommendation.choice}`,
        ].join("\n"),
      },
    };
  }
  const researchFirst = await decideWithJev("research_first", commonState, config, {
    allowedValues: ["yes", "no"],
  });
  const role = researchFirst.applied && researchFirst.recommendation.choice === "yes" && WRITER_ROLES.has(selectedRole)
    ? "researcher"
    : selectedRole;
  const reviewFocus = await decideWithJev("additional_review_focus", { ...commonState, selected_role: role }, config, {
    allowedValues: ["none", "tests", "security", "architecture", "regression"],
  });
  return {
    role,
    decisions: {
      request_sufficiency: sufficiency,
      research_first: researchFirst,
      additional_review_focus: reviewFocus,
    },
    blocked: null,
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
    const optionalWhenUnavailable = group.name === "RepoVerity" && !config.repoVerityRequired;
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
    ? ` Pass model: \"${resolution.model}\" and thinking: \"${resolution.effectiveThinking}\" in the Agent call.${resolution.fallback ? ` If that call fails because the model is excluded or unavailable, retry once with model: \"${resolution.fallback.model}\" and thinking: \"${resolution.fallback.effectiveThinking}\".` : ""}`
    : "";
  const routing = role === "orchestrator"
    ? "Coordinate the task through Agent calls. Use the MCP agent types and role routing below only as needed. Do not perform task work in main."
    : `Call Agent exactly once in foreground with subagent_type \"${agentType}\".${agentParameters} Do not perform the delegated work in main.`;
  const setRouting = resolution.roles
    ? SET_ROLES.filter((profileRole) => profileRole !== "orchestrate").map((profileRole) => {
      const logicalRole = Object.entries(ROLE_PROFILE_KEYS).find(([, key]) => key === profileRole)?.[0];
      const options = resolution.roles[profileRole];
      const thinking = effectiveThinking(options.model, options.reasoning, config);
      const fallback = options.fallback
        ? `, fallback_model=${options.fallback.model}, fallback_thinking=${effectiveThinking(options.fallback.model, options.fallback.reasoning, config)}`
        : "";
      return `${logicalRole}: subagent_type=${ROLE_AGENT_TYPES[logicalRole]}, model=${options.model}, thinking=${thinking}, requested_reasoning=${options.reasoning}${fallback}`;
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
    ...(resolution.fallback ? [
      `ROLE_FALLBACK_MODEL: ${resolution.fallback.model}`,
      `ROLE_FALLBACK_REASONING_REQUESTED: ${resolution.fallback.reasoning || "unspecified"}`,
      `ROLE_FALLBACK_THINKING_EFFECTIVE: ${resolution.fallback.effectiveThinking}`,
    ] : []),
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
    reasoning: {
      type: "string",
      enum: [...REASONING_LEVELS],
      description: "Requested reasoning level; models without reasoning support use off.",
    },
    background: { type: "boolean", description: "Run the delegation in the background and return immediately with a run ID." },
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

function routeTool() {
  return {
    name: "pi_route",
    description: "Route a task through the most appropriate Pi specialist. Jev may choose the initial role only when enabled.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: commonProperties(true),
      required: ["task"],
    },
    role: "route",
  };
}

export const TOOL_DEFINITIONS = [
  routeTool(),
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
  {
    name: "pi_run_status",
    description: "Query the status of delegated runs.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    role: "run_status",
  },
  {
    name: "pi_run_wait",
    description: "Wait for a delegated run to complete.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "Run ID to wait for." },
        timeout_ms: { type: "integer", minimum: 1, description: "Maximum wait time in milliseconds." },
      },
      required: ["id"],
    },
    role: "run_wait",
  },
  {
    name: "pi_run_stop",
    description: "Stop a running delegation.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { id: { type: "string", description: "Run ID to stop." } },
      required: ["id"],
    },
    role: "run_stop",
  },
  {
    name: "pi_run_steer",
    description: "Send a steering message to a running delegation.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "Run ID to steer." },
        message: { type: "string", description: "Steering message." },
      },
      required: ["id", "message"],
    },
    role: "run_steer",
  },
  {
    name: "pi_run_resume",
    description: "Resume a stopped delegation.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "Run ID to resume." },
        message: { type: "string", description: "Resume message/context." },
      },
      required: ["id", "message"],
    },
    role: "run_resume",
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

function nativeRunStatus(entry) {
  const runDir = entry.async_dir;
  const id = entry.subagent_id;
  if (typeof runDir !== "string" || typeof id !== "string" || !isAbsolute(runDir)
    || basename(runDir) !== id || basename(dirname(runDir)) !== "async-subagent-runs") return null;
  try {
    const state = JSON.parse(readFileSync(resolve(runDir, "status.json"), "utf8")).state;
    if (state === "running" || state === "queued") return "running";
    if (state !== "complete") return state === "partial" ? "partial" : "blocked";
    try {
      const outputPath = resolve(runDir, "output-0.log");
      const output = statSync(outputPath).size <= 1_000_000 ? readFileSync(outputPath, "utf8") : "";
      return delegatedTaskStatus(output) ?? "partial";
    } catch {
      return "partial";
    }
  } catch {
    return null;
  }
}

function logNativeRunStart(config, { id, asyncDir, taskId, agent }) {
  try {
    const logDir = process.env.PI_AGENT_LOG_DIR || resolve(config.runtimeRoot, "logs");
    mkdirSync(logDir, { recursive: true });
    appendFileSync(resolve(logDir, "pi-agents.jsonl"), `${JSON.stringify({
      timestamp: new Date().toISOString(),
      event: "subagent_async_started",
      subagent_id: id,
      task_id: taskId,
      agent,
      async_dir: asyncDir,
      status: "started",
    })}\n`);
  } catch (error) {
    process.stderr.write(`[pi-delegator] Activity log warning: ${String(error)}\n`);
  }
}

export function activity(args = {}, config = createConfig()) {
  const limit = integer(args.limit, 20, 1, MAX_ACTIVITY_EVENTS);
  const { logPath, entries } = activityEntries(config, args);
  const activeBySession = new Map();
  const activeNativeRuns = new Map();
  for (const entry of entries) {
    if (entry.event === "subagent_async_started" && entry.subagent_id) {
      activeNativeRuns.set(entry.subagent_id, entry);
    } else if (entry.event === "subagent_async_completed" && entry.subagent_id) {
      activeNativeRuns.delete(entry.subagent_id);
    } else if (entry.event === "pixel_agent_session_started" && entry.session_id) {
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
  for (const [id, entry] of activeNativeRuns) {
    if (nativeRunStatus(entry) !== "running") activeNativeRuns.delete(id);
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
    active_count: activeBySession.size + activeNativeRuns.size,
    active_state_stale_after_ms: ACTIVE_SESSION_STALE_MS,
    active: [...activeBySession.values(), ...activeNativeRuns.values()].map((entry) => ({
      session_id: entry.session_id,
      subagent_id: entry.subagent_id,
      task_id: entry.task_id ?? null,
      agent: entry.agent ?? null,
      started_at: entry.timestamp ?? null,
    })),
    recent: entries.slice(-limit).map((entry) => entry.event === "subagent_async_started"
      ? { ...entry, status: nativeRunStatus(entry) ?? entry.status }
      : entry),
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
          effective_thinking: "Requested level when the selected LiteLLM model supports reasoning; otherwise off.",
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
        `force_context_mode: ${config.forceContextMode ? "yes" : "no"}`,
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

const rpcHosts = new Map();

function runIdFromSpawn(data) {
  const id = data?.details?.asyncId ?? data?.details?.runId;
  if (typeof id !== "string" || !id) throw new Error("Pi RPC spawn returned no async run ID");
  return id;
}

function readRunOutputFromStatus(statusText, id) {
  const runDir = /^Dir: (.+)$/m.exec(statusText)?.[1];
  const outputPath = /^Output: (.+)$/m.exec(statusText)?.[1];
  if (!runDir || !outputPath || !isAbsolute(runDir) || !isAbsolute(outputPath)) return null;
  if (basename(runDir) !== id || basename(dirname(runDir)) !== "async-subagent-runs") return null;
  try {
    const realDir = realpathSync(runDir);
    const realOutput = realpathSync(outputPath);
    const pathWithinRun = relative(realDir, realOutput);
    if (!pathWithinRun || pathWithinRun === ".." || pathWithinRun.startsWith(`..${sep}`) || isAbsolute(pathWithinRun)) return null;
    if (statSync(realOutput).size > 1_000_000) return null;
    return readFileSync(realOutput, "utf8").trim();
  } catch {
    return null;
  }
}

function delegatedTaskStatus(output) {
  const matches = [...output.matchAll(/^STATUS:\s*(COMPLETED|PARTIAL|BLOCKED)\s*$/gim)];
  return matches.length ? matches.at(-1)[1].toLowerCase() : null;
}

export async function waitForRun(host, id, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const remainingBeforeRequest = deadline - Date.now();
    if (remainingBeforeRequest <= 0) return { id, status: "running" };
    let data;
    try {
      data = await host.request("status", { id }, {
        timeoutMs: Math.min(10_000, remainingBeforeRequest),
        restartOnFailure: false,
      });
    } catch (error) {
      if (/timed out/.test(String(error))) {
        return { id, status: "running", reason: "Pi RPC status did not respond within the wait window" };
      }
      throw error;
    }
    const state = /^State: ([^\r\n]+)/m.exec(String(data?.text ?? ""))?.[1];
    if (!state) throw new Error(`Pi RPC status returned no state for run ${id}`);
    if (state !== "running" && state !== "queued") {
      const statusText = String(data.text ?? "");
      const output = state === "complete" ? readRunOutputFromStatus(statusText, id) : null;
      const taskStatus = state === "complete"
        ? delegatedTaskStatus(output ?? statusText) ?? "partial"
        : state === "partial" ? "partial" : "blocked";
      return {
        id,
        status: taskStatus,
        result: {
          kind: "text",
          text: output ?? statusText,
          statusText,
        },
      };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { id, status: "running" };
    await new Promise((resolve) => setTimeout(resolve, Math.min(2_000, remaining)));
  }
}

async function getRpcHost(config) {
  let host = rpcHosts.get(config);
  if (!host) {
    host = new PiRpcHost({
      command: config.rpcLauncher,
      args: config.rpcArgs ?? [],
      sessionRoot: config.rpcSessionRoot,
      handshakeTimeoutMs: config.rpcHandshakeTimeoutMs,
      requestTimeoutMs: config.rpcRequestTimeoutMs,
    });
    rpcHosts.set(config, host);
  }
  return host;
}

export async function shutdownRpcHost(config) {
  const host = rpcHosts.get(config);
  if (!host) return;
  rpcHosts.delete(config);
  await host.stop();
}

export function validateToolArguments(definition, args = {}) {
  const properties = definition.inputSchema?.properties ?? {};
  const required = definition.inputSchema?.required ?? [];
  const values = (args && typeof args === "object") ? args : {};
  const unknown = Object.keys(values).filter((key) => !(key in properties)).sort();
  if (unknown.length) throw new Error(`Unknown properties for ${definition.name}: ${unknown.join(", ")}`);
  for (const key of required) {
    if (values[key] === undefined || values[key] === null) throw new Error(`${key} is required`);
  }
  if (
    values.timeout_seconds !== undefined &&
    (!Number.isInteger(values.timeout_seconds) || values.timeout_seconds < 1 || values.timeout_seconds > MAX_TIMEOUT_SECONDS)
  ) {
    throw new Error(`timeout_seconds must be an integer between 1 and ${MAX_TIMEOUT_SECONDS}`);
  }
  if (values.reasoning !== undefined) validateReasoning(values.reasoning);
  if (values.background !== undefined && typeof values.background !== "boolean") {
    throw new Error("background must be a boolean");
  }
  return values;
}

const RUN_CONTROL_METHODS = {
  pi_run_status: "status",
  pi_run_wait: "wait",
  pi_run_stop: "stop",
  pi_run_steer: "steer",
  pi_run_resume: "resume",
};

async function spawnDelegation(host, definition, args, config, token, route = {}) {
  void token;
  const role = route.role || definition.role;
  const resolution = route.resolution || resolveDelegationOptions(role, args, config);
  const taskId = makeTaskId(args.task_id);
  const writer = WRITER_ROLES.has(role);
  const allowedPaths = writer
    ? normalizeAllowedPaths(args.allowed_paths ?? [], config.root, true)
    : [];
  const decisionLines = [];
  for (const [name, decision] of Object.entries(route.decisions ?? {})) {
    if (!decision) continue;
    decisionLines.push(`JEV_${name.toUpperCase()}_MODE: ${decision.mode}`);
    decisionLines.push(`JEV_${name.toUpperCase()}_RECOMMENDATION: ${decision.recommendation?.choice || "none"}`);
    decisionLines.push(`JEV_${name.toUpperCase()}_APPLIED: ${decision.applied ? "yes" : "no"}`);
    if (decision.fallbackCode) decisionLines.push(`JEV_${name.toUpperCase()}_FALLBACK: ${decision.fallbackCode}`);
  }
  const task = [
    `TASK_ID: ${taskId}`,
    `OBJECTIVE: ${cleanText(args.task, "task", true)}`,
    `SCOPE: ${cleanText(args.scope, "scope") || "Only the explicitly requested task."}`,
    `CONSTRAINTS: ${cleanText(args.constraints, "constraints") || "Follow repository instructions and report evidence."}`,
    `EXPECTED_OUTPUT: ${cleanText(args.expected_output, "expected_output") || "Evidence and terminal status."}`,
    ...(route.sourceTool ? [`ROUTED_FROM: ${route.sourceTool}`, `ROUTED_ROLE: ${role}`] : []),
    ...decisionLines,
    `DELEGATION_SET: ${resolution.set ?? "none"}`,
    `DELEGATION_PERCENTAGE_TARGET: ${resolution.percentage ?? "unspecified"}`,
    `ROLE_REASONING_REQUESTED: ${resolution.requestedReasoning || "unspecified"}`,
    ...(role === "orchestrator" && resolution.roles
      ? [`ROLE_ROUTING: ${Object.entries(resolution.roles).map(([profileRole, options]) => `${profileRole}=${options.model}:${options.reasoning}`).join(", ")}`]
      : []),
    writer
      ? `STRICT WRITE SCOPE: ${allowedPaths.join(", ")}. Do not modify other paths.`
      : "READ-ONLY: Do not create, edit, move, or delete files.",
  ].join("\n");
  const spawnParams = {
    agent: ROLE_AGENT_TYPES[role],
    task,
    model: `${resolution.model}:${resolution.effectiveThinking}`,
    context: "fresh",
  };
  const run = await host.request("spawn", spawnParams);
  const runId = runIdFromSpawn(run);
  logNativeRunStart(config, {
    id: runId,
    asyncDir: run.details?.asyncDir,
    taskId,
    agent: ROLE_AGENT_TYPES[role],
  });
  const modelLine = `${resolution.model}:${resolution.effectiveThinking}`;
  const routeLine = route.sourceTool ? `\nROLE: ${role}` : "";
  if (args.background === true) {
    return { content: [{ type: "text", text: `RUN_ID: ${runId}\nMODEL: ${modelLine}${routeLine}\nSTATUS: PARTIAL` }], isError: false };
  }
  const waited = await waitForRun(host, runId, (args.timeout_seconds ?? config.timeoutSeconds) * 1000);
  const statusLine = waited.status === "completed" ? "COMPLETED" : waited.status === "running" || waited.status === "partial" ? "PARTIAL" : "BLOCKED";
  const resultText = waited.result?.text ?? waited.reason ?? "Run is still active.";
  return {
    content: [{ type: "text", text: `RUN_ID: ${runId}\nMODEL: ${modelLine}${routeLine}\nSTATUS: ${statusLine}\n\n${resultText}` }],
    isError: statusLine === "BLOCKED",
  };
}

export async function callTool(name, args = {}, config = createConfig(), token = null) {
  const definition = TOOL_DEFINITIONS.find((candidate) => candidate.name === name);
  if (!definition) throw new Error(`Unknown tool: ${name}`);
  if (definition.role === "status") return status(config);
  if (definition.role === "sets") return delegationSets(config);
  if (definition.role === "activity") return activity(args, config);
  validateToolArguments(definition, args);
  const host = await getRpcHost(config);
  const controlMethod = RUN_CONTROL_METHODS[name];
  if (controlMethod) {
    const params = controlMethod === "status" ? {} : { id: args.id };
    if (controlMethod === "steer" || controlMethod === "resume") params.message = args.message;
    if (controlMethod === "wait" && args.timeout_ms !== undefined) params.timeout_ms = args.timeout_ms;
    const data = controlMethod === "wait"
      ? await waitForRun(host, params.id, args.timeout_ms ?? config.timeoutSeconds * 1000)
      : await host.request(controlMethod, params);
    return { content: [{ type: "text", text: JSON.stringify(data) }], isError: false };
  }
  if (definition.role === "route") {
    const routed = await selectRouteRole(args, config);
    const phased = await applyRoutePhaseDecisions(args, config, routed.role);
    if (phased.blocked) {
      return { content: [{ type: "text", text: phased.blocked.text }], isError: false };
    }
    if (WRITER_ROLES.has(phased.role) && (!Array.isArray(args.allowed_paths) || args.allowed_paths.length === 0)) {
      return {
        content: [{ type: "text", text: `STATUS: BLOCKED\nREASON: pi_route selected ${phased.role}, but allowed_paths is required before launching a writer.\nJEV_INITIAL_ROLE_RECOMMENDATION: ${routed.decision.recommendation?.choice || "none"}` }],
        isError: true,
      };
    }
    const { resolution, decision: setDecision } = await resolveDelegationOptionsWithJev(phased.role, args, config);
    return spawnDelegation(host, definition, args, config, token, {
      role: phased.role,
      resolution,
      sourceTool: "pi_route",
      decisions: { initial_role: routed.decision, ...phased.decisions, delegation_set: setDecision },
    });
  }
  const { resolution, decision } = await resolveDelegationOptionsWithJev(definition.role, args, config);
  return spawnDelegation(host, definition, args, config, token, {
    role: definition.role,
    resolution,
    decisions: { delegation_set: decision },
  });
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
