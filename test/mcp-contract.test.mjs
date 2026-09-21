import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  TOOL_DEFINITIONS,
  activity,
  callTool,
  createConfig,
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
    providers: { litellm: { models: [{ id: "llm-large", reasoning: true }, { id: "llm-medium", reasoning: false }] } },
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
  };
}

function fakeRpcHostScript(directory, terminalStatus = "COMPLETED") {
  const script = join(directory, "fake-mcp-rpc-host.mjs");
  writeFileSync(script, `
import readline from "node:readline";
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

test("loadDelegationSets normalizes models and reasoning", () => {
  const sets = loadDelegationSets(fixtureConfig());
  assert.equal(sets.default.delegation_percentage, 50);
  assert.equal(sets.default.roles.research.model, "litellm/llm-medium");
  assert.equal(sets.default.roles.orchestrate.reasoning, "high");
});

test("loadDelegationSets rejects unknown role options", () => {
  const config = fixtureConfig();
  const document = JSON.parse(readFileSync(config.delegationSetsFile, "utf8"));
  document.sets.default.roles.research.extra = true;
  writeFileSync(config.delegationSetsFile, JSON.stringify(document));
  assert.throws(() => loadDelegationSets(config), /Unknown options in default\.research: extra/);
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
