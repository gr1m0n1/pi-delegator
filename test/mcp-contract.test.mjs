import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  TOOL_DEFINITIONS,
  activity,
  buildPrompt,
  callTool,
  createConfig,
  loadJevConfig,
  loadDelegationSets,
  normalizeAllowedPaths,
  resolveDelegationOptions,
  shutdownRpcHost,
  validateToolArguments,
  waitForRun,
} from "../pi-delegator/mcp/server.mjs";
import { assertWriteTargetAllowed, capabilityCeiling } from "../pi-delegator/mcp/write-scope.mjs";

function fixtureConfig() {
  const root = mkdirSync(join(tmpdir(), `pi-delegator-test-${process.pid}-${Math.random().toString(16).slice(2)}`), { recursive: true });
  const delegationSetsFile = join(root, "delegation-sets.json");
  const modelCatalogFile = join(root, "models.json");
  writeFileSync(modelCatalogFile, JSON.stringify({
    providers: { litellm: { models: [{ id: "llm-large", reasoning: true }, { id: "llm-medium-devel", reasoning: false }, { id: "llm-medium", reasoning: false }] } },
  }));
  writeFileSync(delegationSetsFile, JSON.stringify({
    version: 1,
    sets: {
      default: {
        delegation_percentage: 50,
        roles: {
          research: { model: "llm-medium", reasoning: "low" },
          implement: { model: "llm-large", reasoning: "medium" },
          tests: { model: "llm-large", reasoning: "none" },
          review: { model: "llm-medium", reasoning: "minimal" },
          orchestrate: { model: "llm-large", reasoning: "high" },
        },
      },
      fast: {
        delegation_percentage: 75,
        roles: {
          research: { model: "llm-large", reasoning: "high" },
          implement: { model: "llm-medium-devel", reasoning: "low" },
          tests: { model: "llm-medium", reasoning: "low" },
          review: { model: "llm-medium", reasoning: "low" },
          orchestrate: { model: "llm-large", reasoning: "low" },
        },
      },
    },
  }));
  return {
    root,
    runtimeRoot: root,
    launcher: process.execPath,
    launcherArgs: [],
    rpcLauncher: process.execPath,
    rpcArgs: [],
    rpcSessionRoot: join(root, "sessions", "mcp"),
    rpcHandshakeTimeoutMs: 1000,
    rpcRequestTimeoutMs: 1000,
    timeoutSeconds: 30,
    maxOutputChars: 50000,
    delegationSetsFile,
    modelCatalogFile,
    defaultDelegationSet: "default",
    availableExternalTools: new Set(),
    forceContextMode: false,
    repoVerityEnabled: false,
    repoVerityRequired: false,
    repoVerityAvailability: "disabled",
    jevConfigFile: null,
    jevModeOverride: null,
    jevApiKeyOverrides: { typesafe: "", openrouter: "" },
  };
}

function fakeRpcHostScript(directory, terminalStatus = "COMPLETED") {
  const script = join(directory, "fake-mcp-rpc-host.mjs");
  writeFileSync(script, `
import readline from "node:readline";
import { writeFileSync } from "node:fs";
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function reply(requestId, data) {
  const payload = Buffer.from(JSON.stringify({ requestId, success: true, data }), "utf8").toString("base64url");
  process.stdout.write(JSON.stringify({ type: "extension_ui_request", method: "notify", message: "PI_DELEGATOR_RPC:" + payload }) + "\\n");
}
input.on("line", (line) => {
  const message = JSON.parse(line);
  const request = JSON.parse(Buffer.from(message.message.split(" ")[1], "base64url").toString("utf8"));
  process.stdout.write(JSON.stringify({ id: message.id, type: "response", command: "prompt", success: true }) + "\\n");
  if (request.method === "ping") reply(request.requestId, { capabilities: { status: true, spawn: true, wait: true, stop: true, steer: true, resume: true } });
  else if (request.method === "spawn") {
    if (!request.params.agent || !request.params.task) throw new Error("spawn requires agent and task");
    writeFileSync(${JSON.stringify(join(directory, "last-spawn.json"))}, JSON.stringify(request.params));
    reply(request.requestId, { text: "Async: researcher-mcp [run-native-1]", details: { asyncId: "run-native-1" } });
  }
  else if (request.method === "status") reply(request.requestId, request.params.id
    ? { text: "Run: run-native-1\\nState: complete\\n\\nnative done\\nSTATUS: ${terminalStatus}", details: { mode: "single", results: [] } }
    : { text: "Run: run-native-1", runs: [{ id: "run-native-1", status: "completed" }] });
  else reply(request.requestId, { id: request.params.id, status: request.method === "stop" ? "stopped" : "delivered" });
});
`);
  return script;
}

function writeJevConfig(config, document) {
  const path = join(config.root, "jev.json");
  writeFileSync(path, JSON.stringify(document));
  config.jevConfigFile = path;
  return path;
}

test("loadDelegationSets normalizes models and reasoning", () => {
  const sets = loadDelegationSets(fixtureConfig());
  assert.equal(sets.default.delegation_percentage, 50);
  assert.equal(sets.default.roles.research.model, "litellm/llm-medium");
  assert.equal(sets.default.roles.orchestrate.reasoning, "high");
});

test("loadDelegationSets accepts off as disabled reasoning", () => {
  const config = fixtureConfig();
  const document = JSON.parse(readFileSync(config.delegationSetsFile, "utf8"));
  document.sets.default.roles.research.reasoning = "off";
  writeFileSync(config.delegationSetsFile, JSON.stringify(document));

  const options = resolveDelegationOptions("researcher", {}, config);
  assert.equal(options.requestedReasoning, "off");
  assert.equal(options.effectiveThinking, "off");
});

test("loadDelegationSets rejects unknown role options", () => {
  const config = fixtureConfig();
  const document = JSON.parse(readFileSync(config.delegationSetsFile, "utf8"));
  document.sets.default.roles.research.extra = true;
  writeFileSync(config.delegationSetsFile, JSON.stringify(document));
  assert.throws(() => loadDelegationSets(config), /Unknown options in default\.research: extra/);
});

test("loadDelegationSets validates and preserves separated fallbacks", () => {
  const config = fixtureConfig();
  const document = JSON.parse(readFileSync(config.delegationSetsFile, "utf8"));
  document.sets.default.roles.implement.fallback = { model: "llm-medium-devel", reasoning: "low" };
  writeFileSync(config.delegationSetsFile, JSON.stringify(document));

  const options = resolveDelegationOptions("coder", {}, config);
  assert.equal(options.model, "litellm/llm-large");
  assert.equal(options.requestedReasoning, "medium");
  assert.deepEqual(options.fallback, {
    model: "litellm/llm-medium-devel",
    reasoning: "low",
    effectiveThinking: "off",
  });

  const prompt = buildPrompt("coder", { task: "Implement the fix", allowed_paths: ["src"] }, config, options);
  assert.match(String(prompt), /ROLE_FALLBACK_MODEL: litellm\/llm-medium-devel/);
  assert.match(String(prompt), /retry once with model: "litellm\/llm-medium-devel" and thinking: "off"/);
});

test("resolveDelegationOptions applies explicit overrides", () => {
  const options = resolveDelegationOptions("researcher", {
    model: "llm-large",
    reasoning: "xhigh",
    delegation_percentage: 75,
  }, fixtureConfig());
  assert.equal(options.model, "litellm/llm-large");
  assert.equal(options.requestedReasoning, "xhigh");
  assert.equal(options.percentage, 75);
  assert.equal(options.effectiveThinking, "xhigh");
});

test("loadJevConfig keeps Jev disabled by default and validates configured providers", () => {
  const config = fixtureConfig();
  assert.equal(loadJevConfig(config).mode, "off");
  writeJevConfig(config, {
    version: 1,
    mode: "observe",
    provider: { name: "openrouter", model: "typesafe/jev-1.13", api_key_env: "OPENROUTER_API_KEY" },
    decisions: { delegation_set: { enabled: true, allowed_values: ["default", "fast"] } },
  });
  const jev = loadJevConfig(config);
  assert.equal(jev.mode, "observe");
  assert.equal(jev.provider.name, "openrouter");
  assert.deepEqual(jev.decisions.delegation_set.allowedValues, ["default", "fast"]);
  writeJevConfig(config, { mode: "auto", provider: { name: "chat" } });
  assert.throws(() => loadJevConfig(config), /provider.name must be one of/);
  writeJevConfig(config, { mode: "auto", max_calls_per_task: 0 });
  assert.throws(() => loadJevConfig(config), /max_calls_per_task must be an integer/);
  writeJevConfig(config, { mode: "auto", fallback: "switch_provider" });
  assert.throws(() => loadJevConfig(config), /Unsupported Jev fallback/);
});

test("normalizeAllowedPaths deduplicates safe relative paths", () => {
  const config = fixtureConfig();
  assert.deepEqual(normalizeAllowedPaths(["pi-delegator/mcp", "./pi-delegator/mcp"], config.root, true), ["pi-delegator/mcp"]);
});

test("normalizeAllowedPaths rejects workspace escapes", () => {
  const config = fixtureConfig();
  assert.throws(() => normalizeAllowedPaths(["../outside"], config.root, true), /escapes or equals workspace root/);
  assert.throws(() => normalizeAllowedPaths([config.root], config.root, true), /allowed path must be relative/);
});

test("MCP tool schemas reject unknown properties", () => {
  const definition = TOOL_DEFINITIONS.find((tool) => tool.name === "pi_research");
  assert.throws(() => validateToolArguments(definition, { task: "Inspect README", unexpected: true }), /Unknown properties for pi_research: unexpected/);
});

test("MCP writer schemas require allowed_paths", () => {
  const definition = TOOL_DEFINITIONS.find((tool) => tool.name === "pi_implement");
  assert.throws(() => validateToolArguments(definition, { task: "Edit one file" }), /allowed_paths is required/);
});

test("pi_route schema accepts optional allowed_paths", () => {
  const definition = TOOL_DEFINITIONS.find((tool) => tool.name === "pi_route");
  validateToolArguments(definition, { task: "Route this task" });
  validateToolArguments(definition, { task: "Route this task", allowed_paths: ["src"] });
});

test("MCP schemas validate timeout and reasoning values", () => {
  const definition = TOOL_DEFINITIONS.find((tool) => tool.name === "pi_review");
  assert.throws(() => validateToolArguments(definition, { task: "Review", timeout_seconds: 9000 }), /timeout_seconds must be an integer/);
  assert.throws(() => validateToolArguments(definition, { task: "Review", reasoning: "extreme" }), /reasoning must be one of/);
  assert.throws(() => validateToolArguments(definition, { task: "Review", background: "yes" }), /background must be a boolean/);
});

test("real Pi launcher defaults to RPC mode", () => {
  const config = createConfig({
    PI_MCP_ALLOWED_ROOT: process.cwd(),
    PI_CODING_AGENT_DIR: join(process.cwd(), ".pi-delegator"),
  });
  assert.deepEqual(config.rpcArgs, ["--mode", "rpc"]);
  assert.equal(config.rpcHandshakeTimeoutMs, 90_000);
});

test("callTool routes background delegation through native RPC", async () => {
  const config = fixtureConfig();
  config.rpcArgs = [fakeRpcHostScript(config.root)];
  try {
    const result = await callTool("pi_research", { task: "Inspect README", background: true }, config);
    assert.equal(result.isError, false);
    assert.match(result.content[0].text, /RUN_ID: run-native-1/);
    assert.match(result.content[0].text, /MODEL: litellm\/llm-medium:off/);
    assert.match(result.content[0].text, /STATUS: PARTIAL/);
  } finally {
    await shutdownRpcHost(config);
  }
});

test("Jev observe records a delegation_set recommendation without applying it", async () => {
  const config = fixtureConfig();
  config.rpcArgs = [fakeRpcHostScript(config.root)];
  writeJevConfig(config, {
    mode: "observe",
    provider: { name: "typesafe", model: "jev-latest", api_key_env: "TYPESAFE_API_KEY" },
    decisions: { delegation_set: { enabled: true, allowed_values: ["default", "fast"], min_choice_probability: 0.8, min_confidence: 0.8 } },
  });
  config.jevDecisionClient = async () => ({ choice: "fast", probability: 0.95, confidence: 0.95 });
  try {
    const result = await callTool("pi_research", { task: "Inspect README", background: true }, config);
    assert.equal(result.isError, false);
    assert.match(result.content[0].text, /MODEL: litellm\/llm-medium:off/);
  } finally {
    await shutdownRpcHost(config);
  }
});

test("Jev auto can apply a delegation_set when no explicit set is provided", async () => {
  const config = fixtureConfig();
  config.rpcArgs = [fakeRpcHostScript(config.root)];
  writeJevConfig(config, {
    mode: "auto",
    provider: { name: "typesafe", model: "jev-latest", api_key_env: "TYPESAFE_API_KEY" },
    decisions: { delegation_set: { enabled: true, allowed_values: ["default", "fast"], min_choice_probability: 0.8, min_confidence: 0.8 } },
  });
  config.jevDecisionClient = async () => ({ choice: "fast", probability: 0.95, confidence: 0.95 });
  try {
    const result = await callTool("pi_research", { task: "Inspect README", background: true }, config);
    assert.equal(result.isError, false);
    assert.match(result.content[0].text, /MODEL: litellm\/llm-large:high/);
  } finally {
    await shutdownRpcHost(config);
  }
});

test("TypeSafe and OpenRouter receive a Choice map and apply the documented answer", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const provider of ["typesafe", "openrouter"]) {
      const config = fixtureConfig();
      config.rpcArgs = [fakeRpcHostScript(config.root)];
      config.jevApiKeyOverrides[provider] = "test-key";
      writeJevConfig(config, {
        mode: "auto",
        provider: { name: provider, model: provider === "typesafe" ? "jev-latest" : "typesafe/jev-1.13" },
        decisions: { delegation_set: { enabled: true, min_choice_probability: 0.8, min_confidence: 0.8 } },
      });
      globalThis.fetch = async (url, options) => {
        assert.equal(url, provider === "typesafe" ? "https://api.typesafe.ai/v1/systemone" : "https://openrouter.ai/api/alpha/decisions");
        assert.equal(options.headers.authorization, "Bearer test-key");
        const body = JSON.parse(options.body);
        assert.deepEqual(Object.keys(body.questions), ["delegation_set"]);
        assert.equal(body.questions.delegation_set.type, "choice");
        assert.deepEqual(Object.keys(body.questions.delegation_set.criteria), ["default", "fast"]);
        return { ok: true, json: async () => ({ answers: { delegation_set: {
          type: "choice", choice: "fast", probabilities: { default: 0.05, fast: 0.95 }, confidence: 0.9,
        } } }) };
      };
      try {
        const result = await callTool("pi_research", { task: "Inspect this", background: true }, config);
        assert.match(result.content[0].text, /MODEL: litellm\/llm-large:high/);
      } finally {
        await shutdownRpcHost(config);
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("malformed Jev responses fall back to the configured delegation set", async () => {
  const originalFetch = globalThis.fetch;
  const config = fixtureConfig();
  config.rpcArgs = [fakeRpcHostScript(config.root)];
  config.jevApiKeyOverrides.typesafe = "test-key";
  writeJevConfig(config, { mode: "auto", decisions: { delegation_set: { enabled: true } } });
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ answers: { delegation_set: { type: "choice", choice: "unknown", probabilities: { unknown: 1 }, confidence: 1 } } }) });
  try {
    const result = await callTool("pi_research", { task: "Inspect this", background: true }, config);
    assert.match(result.content[0].text, /MODEL: litellm\/llm-medium:off/);
    const log = readFileSync(join(config.root, "logs", "pi-jev-decisions.jsonl"), "utf8");
    assert.match(log, /"fallback_code":"invalid_response"/);
  } finally {
    globalThis.fetch = originalFetch;
    await shutdownRpcHost(config);
  }
});

test("pi_route enforces the configured Jev call limit", async () => {
  const config = fixtureConfig();
  config.rpcArgs = [fakeRpcHostScript(config.root)];
  writeJevConfig(config, {
    mode: "auto", max_calls_per_task: 1,
    decisions: {
      initial_role: { enabled: true },
      research_first: { enabled: true },
    },
  });
  const called = [];
  config.jevDecisionClient = async ({ decision }) => {
    called.push(decision);
    return { choice: decision === "initial_role" ? "coder" : "yes", probability: 0.95, confidence: 0.95 };
  };
  try {
    const result = await callTool("pi_route", { task: "Implement this", allowed_paths: ["src"], background: true }, config);
    assert.deepEqual(called, ["initial_role"]);
    assert.match(result.content[0].text, /ROLE: coder/);
    const log = readFileSync(join(config.root, "logs", "pi-jev-decisions.jsonl"), "utf8");
    assert.match(log, /"fallback_code":"call_limit"/);
  } finally {
    await shutdownRpcHost(config);
  }
});

test("pi_route sends an applied review focus through the orchestrator", async () => {
  const config = fixtureConfig();
  config.rpcArgs = [fakeRpcHostScript(config.root)];
  writeJevConfig(config, {
    mode: "auto", max_calls_per_task: 2,
    decisions: { initial_role: { enabled: true }, additional_review_focus: { enabled: true } },
  });
  config.jevDecisionClient = async ({ decision }) => ({
    choice: decision === "initial_role" ? "coder" : "security", probability: 0.95, confidence: 0.95,
  });
  try {
    const result = await callTool("pi_route", { task: "Implement this", task_id: "TASK-review", allowed_paths: ["src"], background: true }, config);
    assert.match(result.content[0].text, /ROLE: orchestrator/);
    const spawn = JSON.parse(readFileSync(join(config.root, "last-spawn.json"), "utf8"));
    assert.match(spawn.task, /REVIEW_FOCUS: Delegate a reviewer after the work and ask it to focus on security/);
    assert.match(spawn.task, /TASK_ID: TASK-review/);
  } finally {
    await shutdownRpcHost(config);
  }
});

test("explicit delegation_set bypasses Jev delegation_set selection", async () => {
  const config = fixtureConfig();
  config.rpcArgs = [fakeRpcHostScript(config.root)];
  writeJevConfig(config, {
    mode: "auto",
    provider: { name: "typesafe", model: "jev-latest", api_key_env: "TYPESAFE_API_KEY" },
    decisions: { delegation_set: { enabled: true, allowed_values: ["default", "fast"] } },
  });
  let called = false;
  config.jevDecisionClient = async () => {
    called = true;
    return { choice: "fast", probability: 1, confidence: 1 };
  };
  try {
    const result = await callTool("pi_research", { task: "Inspect README", delegation_set: "default", background: true }, config);
    assert.equal(result.isError, false);
    assert.equal(called, false);
    assert.match(result.content[0].text, /MODEL: litellm\/llm-medium:off/);
  } finally {
    await shutdownRpcHost(config);
  }
});

test("pi_route uses Jev initial_role for read-only routing", async () => {
  const config = fixtureConfig();
  config.rpcArgs = [fakeRpcHostScript(config.root)];
  writeJevConfig(config, {
    mode: "auto",
    provider: { name: "typesafe", model: "jev-latest", api_key_env: "TYPESAFE_API_KEY" },
    decisions: { initial_role: { enabled: true, allowed_values: ["researcher", "reviewer"], min_choice_probability: 0.8, min_confidence: 0.8 } },
  });
  config.jevDecisionClient = async () => ({ choice: "reviewer", probability: 0.95, confidence: 0.95 });
  try {
    const result = await callTool("pi_route", { task: "Review the proposed change", background: true }, config);
    assert.equal(result.isError, false);
    assert.match(result.content[0].text, /ROLE: reviewer/);
    assert.match(result.content[0].text, /MODEL: litellm\/llm-medium:off/);
  } finally {
    await shutdownRpcHost(config);
  }
});

test("pi_route blocks Jev-selected writer roles without allowed_paths", async () => {
  const config = fixtureConfig();
  config.rpcArgs = [fakeRpcHostScript(config.root)];
  writeJevConfig(config, {
    mode: "auto",
    provider: { name: "typesafe", model: "jev-latest", api_key_env: "TYPESAFE_API_KEY" },
    decisions: { initial_role: { enabled: true, allowed_values: ["coder"], min_choice_probability: 0.8, min_confidence: 0.8 } },
  });
  config.jevDecisionClient = async () => ({ choice: "coder", probability: 0.95, confidence: 0.95 });
  try {
    const result = await callTool("pi_route", { task: "Implement this", background: true }, config);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /allowed_paths is required/);
  } finally {
    await shutdownRpcHost(config);
  }
});

test("pi_route can ask for clarification before spawning", async () => {
  const config = fixtureConfig();
  config.rpcArgs = [fakeRpcHostScript(config.root)];
  writeJevConfig(config, {
    mode: "auto",
    provider: { name: "typesafe", model: "jev-latest", api_key_env: "TYPESAFE_API_KEY" },
    decisions: { request_sufficiency: { enabled: true, allowed_values: ["sufficient", "needs_clarification"], min_choice_probability: 0.8, min_confidence: 0.8 } },
  });
  config.jevDecisionClient = async ({ decision }) => {
    assert.equal(decision, "request_sufficiency");
    return { choice: "needs_clarification", probability: 0.95, confidence: 0.95 };
  };
  try {
    const result = await callTool("pi_route", { task: "Do the thing" }, config);
    assert.equal(result.isError, false);
    assert.match(result.content[0].text, /STATUS: PARTIAL/);
    assert.match(result.content[0].text, /asking for clarification/);
  } finally {
    await shutdownRpcHost(config);
  }
});

test("pi_route can run research before a Jev-selected writer role", async () => {
  const config = fixtureConfig();
  config.rpcArgs = [fakeRpcHostScript(config.root)];
  writeJevConfig(config, {
    mode: "auto",
    max_calls_per_task: 2,
    provider: { name: "typesafe", model: "jev-latest", api_key_env: "TYPESAFE_API_KEY" },
    decisions: {
      initial_role: { enabled: true, allowed_values: ["coder"], min_choice_probability: 0.8, min_confidence: 0.8 },
      research_first: { enabled: true, allowed_values: ["yes", "no"], min_choice_probability: 0.8, min_confidence: 0.8 },
    },
  });
  config.jevDecisionClient = async ({ decision }) => (
    decision === "initial_role"
      ? { choice: "coder", probability: 0.95, confidence: 0.95 }
      : { choice: "yes", probability: 0.95, confidence: 0.95 }
  );
  try {
    const result = await callTool("pi_route", { task: "Implement this", allowed_paths: ["src"], background: true }, config);
    assert.equal(result.isError, false);
    assert.match(result.content[0].text, /ROLE: orchestrator/);
    const spawn = JSON.parse(readFileSync(join(config.root, "last-spawn.json"), "utf8"));
    assert.match(spawn.task, /Delegate research first; use its findings as context for the coder task/);
  } finally {
    await shutdownRpcHost(config);
  }
});

test("callTool routes foreground delegation through native wait", async () => {
  const config = fixtureConfig();
  config.rpcArgs = [fakeRpcHostScript(config.root)];
  try {
    const result = await callTool("pi_review", { task: "Review README" }, config);
    assert.equal(result.isError, false);
    assert.match(result.content[0].text, /STATUS: COMPLETED/);
    assert.match(result.content[0].text, /native done/);
  } finally {
    await shutdownRpcHost(config);
  }
});

test("foreground delegation reports partial and blocked child outcomes", async () => {
  for (const [reported, isError] of [["PARTIAL", false], ["BLOCKED", true]]) {
    const config = fixtureConfig();
    config.rpcArgs = [fakeRpcHostScript(config.root, reported)];
    try {
      const result = await callTool("pi_review", { task: "Review README" }, config);
      assert.equal(result.isError, isError);
      assert.match(result.content[0].text, new RegExp(`^STATUS: ${reported}$`, "m"));
    } finally {
      await shutdownRpcHost(config);
    }
  }
});

test("native wait returns the completed child output", async () => {
  const config = fixtureConfig();
  const id = "run-native-output";
  const runDir = join(config.root, "async-subagent-runs", id);
  mkdirSync(runDir, { recursive: true });
  const outputPath = join(runDir, "output-0.log");
  writeFileSync(outputPath, "PI_DELEGATION_OK\nSTATUS: COMPLETED\n");
  const statusText = `Run: ${id}\nState: complete\nDir: ${runDir}\nOutput: ${outputPath}`;
  const result = await waitForRun({ request: async () => ({ text: statusText }) }, id, 1000);
  assert.equal(result.status, "completed");
  assert.equal(result.result.text, "PI_DELEGATION_OK\nSTATUS: COMPLETED");
  assert.equal(result.result.statusText, statusText);
});

test("native wait respects the delegated task's terminal status", async () => {
  for (const [reported, expected] of [["PARTIAL", "partial"], ["BLOCKED", "blocked"]]) {
    const result = await waitForRun({ request: async () => ({ text: `State: complete\nSTATUS: ${reported}` }) }, "run-native-status", 1000);
    assert.equal(result.status, expected);
  }
  const missing = await waitForRun({ request: async () => ({ text: "State: complete\nOutput unavailable" }) }, "run-native-status", 1000);
  assert.equal(missing.status, "partial");
});

test("activity reconciles native async runs with their status artifact", () => {
  const config = fixtureConfig();
  const id = "run-native-activity";
  const runDir = join(config.root, "async-subagent-runs", id);
  const logDir = join(config.root, "logs");
  mkdirSync(runDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, "pi-agents.jsonl"), `${JSON.stringify({
    timestamp: new Date().toISOString(), event: "subagent_async_started", subagent_id: id,
    task_id: "TASK-ACTIVITY", agent: "researcher-mcp", async_dir: runDir, status: "started",
  })}\n`);
  writeFileSync(join(runDir, "status.json"), JSON.stringify({ state: "running" }));
  let snapshot = JSON.parse(activity({ task_id: "TASK-ACTIVITY" }, config).content[0].text);
  assert.equal(snapshot.active_count, 1);
  writeFileSync(join(runDir, "output-0.log"), "STATUS: PARTIAL\n");
  writeFileSync(join(runDir, "status.json"), JSON.stringify({ state: "complete" }));
  snapshot = JSON.parse(activity({ task_id: "TASK-ACTIVITY" }, config).content[0].text);
  assert.equal(snapshot.active_count, 0);
  assert.equal(snapshot.recent.at(-1).status, "partial");
});

test("callTool exposes native run status control", async () => {
  const config = fixtureConfig();
  config.rpcArgs = [fakeRpcHostScript(config.root)];
  try {
    const result = await callTool("pi_run_status", {}, config);
    assert.equal(result.isError, false);
    assert.match(result.content[0].text, /run-native-1/);
  } finally {
    await shutdownRpcHost(config);
  }
});

test("callTool exposes native wait stop steer and resume controls", async () => {
  const config = fixtureConfig();
  config.rpcArgs = [fakeRpcHostScript(config.root)];
  try {
    const waited = await callTool("pi_run_wait", { id: "run-native-1", timeout_ms: 100 }, config);
    assert.match(waited.content[0].text, /completed/);
    const stopped = await callTool("pi_run_stop", { id: "run-native-1" }, config);
    assert.match(stopped.content[0].text, /stopped/);
    const steered = await callTool("pi_run_steer", { id: "run-native-1", message: "Focus the check" }, config);
    assert.match(steered.content[0].text, /delivered/);
    const resumed = await callTool("pi_run_resume", { id: "run-native-1", message: "Follow up" }, config);
    assert.match(resumed.content[0].text, /delivered/);
  } finally {
    await shutdownRpcHost(config);
  }
});

test("write scope rejects targets outside allowed paths", () => {
  const config = fixtureConfig();
  mkdirSync(join(config.root, "src"), { recursive: true });
  assert.equal(assertWriteTargetAllowed(config.root, ["src"], "src/file.txt"), true);
  assert.throws(() => assertWriteTargetAllowed(config.root, ["src"], "README.md"), /outside allowed_paths/);
  assert.equal(assertWriteTargetAllowed(config.root, ["new-file.txt"], "new-file.txt"), true);
  assert.throws(() => assertWriteTargetAllowed(config.root, ["new-file.txt"], "sibling.txt"), /outside allowed_paths/);
});

test("strict writer ceiling rejects indirect shell-capable tools", () => {
  const result = capabilityCeiling("coder", ["src"], new Set(["ctx_execute", "edit"]), true);
  assert.equal(result.ok, false);
  assert.match(result.reason, /ctx_execute/);
});

test("read-only ceiling removes mutation tools", () => {
  const result = capabilityCeiling("researcher", [], new Set(["ctx_search", "edit", "ctx_execute"]), true);
  assert.deepEqual(result.tools, ["ctx_search"]);
});
