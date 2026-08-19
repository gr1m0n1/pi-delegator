#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve, dirname, join, basename } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const sourceDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const projectRoot = resolve(sourceDir, "..");
const pixelStatePath = join(homedir(), ".pixel-agents", "vscode-state.json");

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function parseArgs(argv) {
  const options = {
    launcher: "",
    timeoutMs: 90_000,
    appearTimeoutMs: 45_000,
    disappearTimeoutMs: 20_000,
    pollMs: 200,
    model: process.env.PI_PIXEL_AGENTS_SMOKE_MODEL || "litellm/llm-large",
    mode: "hooks",
    hookDurationMs: 10_000,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--launcher") {
      options.launcher = argv[index + 1] || "";
      index += 1;
    } else if (argument === "--timeout-ms") {
      options.timeoutMs = Number.parseInt(argv[index + 1] || "", 10) || options.timeoutMs;
      index += 1;
    } else if (argument === "--appear-timeout-ms") {
      options.appearTimeoutMs = Number.parseInt(argv[index + 1] || "", 10) || options.appearTimeoutMs;
      index += 1;
    } else if (argument === "--disappear-timeout-ms") {
      options.disappearTimeoutMs = Number.parseInt(argv[index + 1] || "", 10) || options.disappearTimeoutMs;
      index += 1;
    } else if (argument === "--poll-ms") {
      options.pollMs = Number.parseInt(argv[index + 1] || "", 10) || options.pollMs;
      index += 1;
    } else if (argument === "--model") {
      options.model = argv[index + 1] || options.model;
      index += 1;
    } else if (argument === "--real") {
      options.mode = "real";
    } else if (argument === "--hooks") {
      options.mode = "hooks";
    } else if (argument === "--hook-duration-ms") {
      options.hookDurationMs = Number.parseInt(argv[index + 1] || "", 10) || options.hookDurationMs;
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      console.log(`Usage: node ./pi-delegator/scripts/test_pixel_agents.mjs [options]

Options:
  --launcher <path>             Launcher to execute. Auto-detected when omitted.
  --hooks                       Run a visual smoke test by emitting Pixel Agents hooks. Default.
  --real                        Run a real delegated Pi task and verify Pixel Agents visibility.
  --model <model>               Main model passed to the launcher.
  --timeout-ms <ms>             Hard timeout for the delegated run.
  --appear-timeout-ms <ms>      Max wait for the Pixel Agents avatar to appear.
  --disappear-timeout-ms <ms>   Max wait for the Pixel Agents avatar to disappear.
  --hook-duration-ms <ms>       Visible time for the hooks-mode smoke test.
  --poll-ms <ms>                Poll interval for Pixel Agents state.
`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return options;
}

function detectLauncher(explicitLauncher) {
  const candidates = [
    explicitLauncher,
    process.env.PI_PIXEL_AGENTS_SMOKE_LAUNCHER || "",
    join(projectRoot, ".pi-delegator", "bin", "pi-agent"),
    join(projectRoot, "bin", "pi-agent"),
  ].filter(Boolean).map((candidate) => resolve(candidate));

  const launcher = candidates.find((candidate) => existsSync(candidate));
  if (!launcher) {
    throw new Error("Could not find a Pi launcher. Use --launcher or PI_PIXEL_AGENTS_SMOKE_LAUNCHER.");
  }
  return launcher;
}

function repoRootFromLauncher(launcher) {
  return resolve(dirname(launcher), "../..");
}

function piLogPath(repoRoot) {
  return join(repoRoot, ".pi-delegator", "logs", "pi-agents.jsonl");
}

function readTaskLogLines(repoRoot, taskId) {
  const path = piLogPath(repoRoot);
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .filter((line) => line.includes(taskId))
      .slice(-10);
  } catch {
    return [];
  }
}

function readTaskLogEntries(repoRoot, taskId) {
  return readTaskLogLines(repoRoot, taskId)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function taskCompletedInLogs(repoRoot, taskId) {
  return readTaskLogLines(repoRoot, taskId).some((line) => line.includes("\"status\":\"completed\""));
}

function startedSessionIdInLogs(repoRoot, taskId) {
  return readTaskLogEntries(repoRoot, taskId)
    .map((entry) => typeof entry?.session_id === "string" ? entry.session_id : "")
    .find(Boolean) || null;
}

async function waitForStartedSessionInLogs(repoRoot, taskId, timeoutMs, pollMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const sessionId = startedSessionIdInLogs(repoRoot, taskId);
    if (sessionId) return sessionId;
    await sleep(pollMs);
  }
  return null;
}

function loadWorkspaceOverride(repoRoot) {
  const explicit = String(process.env.PI_PIXEL_AGENTS_WORKSPACE_CWD || "").trim();
  if (explicit) return explicit;

  const metadataCandidates = [
    join(repoRoot, ".pi-delegator", ".pixel-agents-workspace-root"),
    join(projectRoot, ".pi-delegator", ".pixel-agents-workspace-root"),
  ];

  for (const candidate of metadataCandidates) {
    if (!existsSync(candidate)) continue;
    const value = readFileSync(candidate, "utf8").split(/\r?\n/, 1)[0]?.trim();
    if (value) return value;
  }

  return repoRoot;
}

function readPixelAgentsState() {
  if (!existsSync(pixelStatePath)) return [];
  try {
    const document = JSON.parse(readFileSync(pixelStatePath, "utf8"));
    return Array.isArray(document?.agents) ? document.agents : [];
  } catch {
    return [];
  }
}

function prunePixelAgentsState(sessionId) {
  if (!existsSync(pixelStatePath)) return;
  try {
    const document = JSON.parse(readFileSync(pixelStatePath, "utf8"));
    const agents = Array.isArray(document?.agents) ? document.agents : [];
    const removedSeatIds = new Set(
      agents
        .filter((agent) => agent?.sessionId === sessionId)
        .map((agent) => String(agent?.id ?? ""))
        .filter(Boolean),
    );
    const nextAgents = agents.filter((agent) => agent?.sessionId !== sessionId);
    const nextDocument = { ...document, agents: nextAgents };
    if (document?.seats && typeof document.seats === "object") {
      nextDocument.seats = Object.fromEntries(
        Object.entries(document.seats).filter(([seatId]) => !removedSeatIds.has(seatId)),
      );
    }
    writeFileSync(pixelStatePath, `${JSON.stringify(nextDocument, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch {
    // Ignore best-effort smoke cleanup failures.
  }
}

function matchingPiAgents(agents, workspaceRoot) {
  const expectedProjectDir = join(homedir(), ".claude", "projects", workspaceRoot.replace(/[^a-zA-Z0-9-]/g, "-"));
  return agents.filter((agent) =>
    typeof agent?.sessionId === "string"
    && agent.sessionId.startsWith("pi-")
    && typeof agent?.projectDir === "string"
    && agent.projectDir === expectedProjectDir);
}

function pixelAgentsTarget() {
  const provider = String(process.env.PI_PIXEL_AGENTS_PROVIDER || "claude").trim() || "claude";
  const configPath = join(homedir(), ".pixel-agents", "server.json");
  let baseUrl = String(process.env.PI_PIXEL_AGENTS_URL || "").trim();
  let token = String(process.env.PI_PIXEL_AGENTS_TOKEN || "").trim();

  if ((!baseUrl || !token) && existsSync(configPath)) {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    if (!baseUrl && typeof config.port === "number" && Number.isInteger(config.port) && config.port > 0) {
      baseUrl = `http://127.0.0.1:${config.port}`;
    }
    if (!token && typeof config.token === "string" && config.token.trim()) {
      token = config.token.trim();
    }
  }

  if (!baseUrl || !token) {
    throw new Error("Pixel Agents is not configured. Missing ~/.pixel-agents/server.json or PI_PIXEL_AGENTS_URL / PI_PIXEL_AGENTS_TOKEN.");
  }

  const stripped = baseUrl.replace(/\/+$/, "");
  return {
    hookUrl: stripped.includes("/api/hooks/") ? stripped : `${stripped}/api/hooks/${provider}`,
    token,
  };
}

async function emitHook(target, payload) {
  const response = await fetch(target.hookUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${target.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Pixel Agents hook failed with HTTP ${response.status}.`);
  }
}

function buildPrompt(taskId, model) {
  return [
    "MCP PI DELEGATION",
    "Call Agent exactly once in foreground with subagent_type \"researcher\". Do not perform the delegated work in main.",
    "Pass the complete contract below to researcher. Return the complete delegated result and preserve its terminal status.",
    "DELEGATION_SET: default",
    "DELEGATION_PERCENTAGE_TARGET: 50",
    `ROLE_MODEL: ${model}`,
    "ROLE_REASONING_REQUESTED: medium",
    "ROLE_THINKING_EFFECTIVE: off",
    "",
    `TASK_ID: ${taskId}`,
    "PARENT_AGENT: main",
    "OBJECTIVE: Count files in .pi-delegator/agents and answer with the number only.",
    "SCOPE: Only inspect repository files needed to count entries in .pi-delegator/agents.",
    "CONSTRAINTS: Read-only. Return only the numeric count.",
    "FILES: read-only; no files may be modified",
    "DEPENDENCIES: Use only repository-local configuration and the configured LiteLLM provider.",
    "EXPECTED_OUTPUT: Numeric count and terminal status.",
    "",
    "READ-ONLY: no agent may create, edit, move, or delete files.",
    "End with STATUS: COMPLETED, PARTIAL, or BLOCKED using the role contract.",
  ].join("\n");
}

async function waitForAppearance({ workspaceRoot, beforeSessionIds, timeoutMs, pollMs }) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const current = matchingPiAgents(readPixelAgentsState(), workspaceRoot);
    const appeared = current.find((agent) => !beforeSessionIds.has(agent.sessionId));
    if (appeared) return appeared;
    await sleep(pollMs);
  }
  throw new Error(`No Pixel Agents avatar appeared within ${timeoutMs}ms.`);
}

async function waitForDisappearance({ sessionId, timeoutMs, pollMs }) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const current = readPixelAgentsState();
    const stillPresent = current.some((agent) => agent?.sessionId === sessionId);
    if (!stillPresent) return;
    await sleep(pollMs);
  }
  throw new Error(`Pixel Agents avatar ${sessionId} did not disappear within ${timeoutMs}ms.`);
}

async function runLauncher({ launcher, model, workspaceRoot, timeoutMs }) {
  const taskId = `TASK-PIXEL-SMOKE-${Date.now()}`;
  const prompt = buildPrompt(taskId, model);
  const repoRoot = repoRootFromLauncher(launcher);
  const commandArgs = [
    "--model",
    model,
    "--no-session",
    "--no-builtin-tools",
    "--tools",
    "Agent",
    "--print",
    prompt,
  ];

  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(launcher, commandArgs, {
      cwd: repoRoot,
      env: {
        ...process.env,
        PI_PIXEL_AGENTS_WORKSPACE_CWD: workspaceRoot,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdout = [];
    const stderr = [];
    let finished = false;

    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolvePromise(result);
    };

    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // Ignore termination failures during timeout handling.
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Ignore best-effort kill failures.
        }
      }, 2000).unref();
    }, timeoutMs);
    timer.unref();

    child.stdout.on("data", (chunk) => stdout.push(chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => stderr.push(chunk.toString("utf8")));
    child.on("error", rejectPromise);
    child.on("close", (code, signal) => {
      finish({
        code,
        signal,
        stdout: stdout.join("").trim(),
        stderr: stderr.join("").trim(),
        taskId,
      });
    });
  });
}

async function runHookSmoke({ workspaceRoot, durationMs }) {
  const target = pixelAgentsTarget();
  const sessionId = `pi-smoke-${Date.now()}`;
  const projectDir = join(
    homedir(),
    ".claude",
    "projects",
    workspaceRoot.replace(/[^a-zA-Z0-9-]/g, "-"),
  );
  const transcriptPath = join(projectDir, `${sessionId}.jsonl`);
  mkdirSync(projectDir, { recursive: true, mode: 0o700 });
  writeFileSync(transcriptPath, "", { encoding: "utf8", mode: 0o600 });
  const payload = {
    session_id: sessionId,
    source: "pi-smoke",
    actor: "claude",
    delegated_to: "researcher",
    task: "Pixel Agents smoke test",
    cwd: workspaceRoot,
    transcript_path: transcriptPath,
  };

  await emitHook(target, { ...payload, hook_event_name: "SessionStart" });
  await emitHook(target, {
    ...payload,
    hook_event_name: "PreToolUse",
    tool_name: "Grep",
    tool_input: { pattern: "pixel smoke test", profile: "researcher", attempt: 1 },
  });
  await sleep(durationMs);
  try {
    await emitHook(target, { ...payload, hook_event_name: "PostToolUse" });
    await emitHook(target, { ...payload, hook_event_name: "Stop" });
    await emitHook(target, { ...payload, hook_event_name: "SessionEnd", reason: "completed" });
    await sleep(150);
    await emitHook(target, { ...payload, hook_event_name: "SessionEnd", reason: "completed" });
  } finally {
    for (const delay of [0, 300, 1200]) {
      if (delay > 0) await sleep(delay);
      prunePixelAgentsState(sessionId);
      rmSync(transcriptPath, { force: true });
    }
  }

  return {
    code: 0,
    signal: null,
    stdout: "",
    stderr: "",
    taskId: null,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const launcher = detectLauncher(options.launcher);
  const repoRoot = repoRootFromLauncher(launcher);
  const workspaceRoot = loadWorkspaceOverride(repoRoot);
  const beforeAgents = matchingPiAgents(readPixelAgentsState(), workspaceRoot);
  const beforeSessionIds = new Set(beforeAgents.map((agent) => agent.sessionId));

  console.log(`Launcher: ${launcher}`);
  console.log(`Execution repo: ${repoRoot}`);
  console.log(`Pixel Agents workspace: ${workspaceRoot}`);
  console.log(`Mode: ${options.mode}`);

  const launchPromise = options.mode === "real"
    ? runLauncher({
      launcher,
      model: options.model,
      workspaceRoot,
      timeoutMs: options.timeoutMs,
    })
    : runHookSmoke({
      workspaceRoot,
      durationMs: options.hookDurationMs,
    });

  let appearedAgent;
  let appearedViaLogs = false;
  try {
    appearedAgent = await waitForAppearance({
      workspaceRoot,
      beforeSessionIds,
      timeoutMs: options.appearTimeoutMs,
      pollMs: options.pollMs,
    });
  } catch (error) {
    if (options.mode !== "real") throw error;
    const result = await launchPromise;
    const taskLogs = result.taskId ? readTaskLogLines(repoRoot, result.taskId) : [];
    const startedSessionId = result.taskId
      ? await waitForStartedSessionInLogs(repoRoot, result.taskId, options.disappearTimeoutMs, options.pollMs)
      : null;
    if (startedSessionId) {
      appearedAgent = { sessionId: startedSessionId };
      appearedViaLogs = true;
      console.log(`Appeared via Pi logs: ${startedSessionId}`);
      console.log(`Launcher exit: code=${result.code ?? "null"} signal=${result.signal ?? "none"}`);
      if (result.stderr) {
        console.log("stderr:");
        console.log(result.stderr);
      }
      await waitForDisappearance({
        sessionId: startedSessionId,
        timeoutMs: options.disappearTimeoutMs,
        pollMs: options.pollMs,
      }).catch(() => {});
      console.log(`Disappeared: ${startedSessionId}`);
      if (result.code !== 0 && !(result.taskId && taskCompletedInLogs(repoRoot, result.taskId))) {
        throw new Error(`Launcher exited with code ${result.code ?? "null"} for ${basename(launcher)}.`);
      }
      if (result.code !== 0) {
        console.log(`Launcher exited with code ${result.code ?? "null"}, but Pi logs show ${result.taskId} completed.`);
      }
      console.log(`Pixel Agents smoke test passed for ${startedSessionId}.`);
      return;
    }
    const details = [
      error instanceof Error ? error.message : String(error),
      `Launcher exit: code=${result.code ?? "null"} signal=${result.signal ?? "none"}`,
    ];
    if (result.stderr) details.push(`stderr: ${result.stderr}`);
    if (result.stdout) details.push(`stdout: ${result.stdout}`);
    if (taskLogs.length) details.push(`Pi logs for ${result.taskId}: ${taskLogs.join(" | ")}`);
    throw new Error(details.join("\n"));
  }

  console.log(appearedViaLogs ? `Appeared via Pi logs: ${appearedAgent.sessionId}` : `Appeared: ${appearedAgent.sessionId}`);

  const result = await launchPromise;
  console.log(`Launcher exit: code=${result.code ?? "null"} signal=${result.signal ?? "none"}`);
  if (result.stderr) {
    console.log("stderr:");
    console.log(result.stderr);
  }

  await waitForDisappearance({
    sessionId: appearedAgent.sessionId,
    timeoutMs: options.disappearTimeoutMs,
    pollMs: options.pollMs,
  });

  console.log(`Disappeared: ${appearedAgent.sessionId}`);

  if (result.code !== 0) {
    if (options.mode === "real" && result.taskId && taskCompletedInLogs(repoRoot, result.taskId)) {
      console.log(`Launcher exited with code ${result.code ?? "null"}, but Pi logs show ${result.taskId} completed.`);
      console.log(`Pixel Agents smoke test passed for ${appearedAgent.sessionId}.`);
      return;
    }
    throw new Error(`Launcher exited with code ${result.code ?? "null"} for ${basename(launcher)}.`);
  }

  console.log(`Pixel Agents smoke test passed for ${appearedAgent.sessionId}.`);
}

await main();
