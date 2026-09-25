#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const sourceDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const projectRoot = resolve(sourceDir, "..");
const runtimeRoot = resolve(process.env.PI_CODING_AGENT_DIR || projectRoot);
const targetRoot = resolve(process.env.PI_MCP_ALLOWED_ROOT || resolve(runtimeRoot, ".."));
const provider = process.env.PI_PIXEL_AGENTS_PROVIDER || "claude";
const pixelConfigPath = join(homedir(), ".pixel-agents", "server.json");
const vscodeStatePath = join(homedir(), ".pixel-agents", "vscode-state.json");
const claudeProjectsRoot = join(homedir(), ".claude", "projects");
const workspaceMetadataPath = join(runtimeRoot, ".pixel-agents-workspace-root");
const activeSessionsPath = join(runtimeRoot, "logs", "pixel-agents-active-sessions.json");

function workspaceRoot() {
  const explicit = String(process.env.PI_PIXEL_AGENTS_WORKSPACE_CWD || "").trim();
  if (explicit) return explicit;
  if (existsSync(workspaceMetadataPath)) {
    const value = readFileSync(workspaceMetadataPath, "utf8").split(/\r?\n/, 1)[0]?.trim();
    if (value) return resolve(value);
  }
  return targetRoot;
}

const trackedWorkspaceRoot = workspaceRoot();
const sanitizedProject = trackedWorkspaceRoot.replace(/[^a-zA-Z0-9-]/g, "-");
const projectDir = join(claudeProjectsRoot, sanitizedProject);

function pixelAgentsWsUrl(hookUrl) {
  return hookUrl.replace(/\/api\/hooks\/[^/]+$/, "/ws").replace(/^http/i, "ws");
}

async function loadWsModule() {
  const candidates = new Set();
  const explicit = String(process.env.PI_PIXEL_AGENTS_WS_MODULE || "").trim();
  if (explicit) candidates.add(explicit);
  candidates.add(join(projectRoot, "node_modules", "ws", "index.js"));
  const npxRoot = join(homedir(), ".npm", "_npx");
  if (existsSync(npxRoot)) {
    try {
      for (const entry of readdirSync(npxRoot)) {
        candidates.add(join(npxRoot, entry, "node_modules", "ws", "index.js"));
      }
    } catch {
      // Ignore optional ws lookup failures.
    }
  }

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const mod = await import(pathToFileURL(candidate).href);
      return mod.WebSocket ?? mod.default ?? null;
    } catch {
      // Keep trying fallbacks.
    }
  }

  return null;
}

function stalePiSessionIdsFromVscodeState() {
  if (!existsSync(vscodeStatePath)) return [];
  try {
    const document = JSON.parse(readFileSync(vscodeStatePath, "utf8"));
    return (Array.isArray(document?.agents) ? document.agents : [])
      .map((agent) => ({
        sessionId: typeof agent?.sessionId === "string" ? agent.sessionId : "",
        projectDir: typeof agent?.projectDir === "string" ? agent.projectDir : "",
      }))
      .filter((agent) => agent.sessionId.startsWith("pi-"))
      .filter((agent) => !agent.projectDir || agent.projectDir === projectDir)
      .map((agent) => agent.sessionId);
  } catch {
    return [];
  }
}

function loadTarget() {
  const config = JSON.parse(readFileSync(pixelConfigPath, "utf8"));
  const baseUrl = `http://127.0.0.1:${config.port}`;
  const stripped = baseUrl.replace(/\/+$/, "");
  return {
    hookUrl: stripped.includes("/api/hooks/") ? stripped : `${stripped}/api/hooks/${provider}`,
    token: String(config.token),
  };
}

async function emit(target, payload) {
  const response = await fetch(target.hookUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${target.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Pixel Agents cleanup hook failed with HTTP ${response.status}`);
  }
}

async function closeLiveAgents(target, sessionIds) {
  if (sessionIds.length === 0) return;
  const WebSocketCtor = await loadWsModule();
  if (!WebSocketCtor) return;

  const diagnostics = await new Promise((resolve) => {
    let settled = false;
    const ws = new WebSocketCtor(pixelAgentsWsUrl(target.hookUrl), {
      headers: {
        Authorization: `Bearer ${target.token}`,
      },
    });
    const finish = (agents) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // Ignore close races.
      }
      resolve(Array.isArray(agents) ? agents : []);
    };

    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "requestDiagnostics" }));
    });
    ws.on("message", (raw) => {
      try {
        const message = JSON.parse(typeof raw === "string" ? raw : String(raw));
        if (message.type === "agentDiagnostics") {
          finish(message.agents);
          return;
        }
      } catch {
        // Fall through to empty diagnostics.
      }
      finish([]);
    });
    ws.on("error", () => finish([]));
    setTimeout(() => finish([]), 2000);
  });

  const wanted = new Set(sessionIds);
  const ids = diagnostics
    .map((agent) => ({
      id: typeof agent?.id === "number" ? agent.id : null,
      sessionId: typeof agent?.sessionId === "string" ? agent.sessionId : "",
      projectDir: typeof agent?.projectDir === "string" ? agent.projectDir : "",
    }))
    .filter((agent) => agent.id !== null)
    .filter((agent) => wanted.has(agent.sessionId) || (!agent.sessionId && agent.projectDir === projectDir))
    .map((agent) => agent.id);

  if (ids.length === 0) return;

  await new Promise((resolve) => {
    let settled = false;
    const ws = new WebSocketCtor(pixelAgentsWsUrl(target.hookUrl), {
      headers: {
        Authorization: `Bearer ${target.token}`,
      },
    });
    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // Ignore close races.
      }
      resolve();
    };

    ws.on("open", () => {
      for (const id of ids) {
        ws.send(JSON.stringify({ type: "closeAgent", id }));
      }
      setTimeout(finish, 250);
    });
    ws.on("error", finish);
    setTimeout(finish, 2000);
  });
}

function pruneVscodeState(sessionIds) {
  if (!existsSync(vscodeStatePath) || sessionIds.length === 0) return;
  try {
    const stale = new Set(sessionIds);
    const document = JSON.parse(readFileSync(vscodeStatePath, "utf8"));
    const agents = Array.isArray(document?.agents) ? document.agents : [];
    const removedSeatIds = new Set(
      agents
        .filter((agent) => stale.has(String(agent?.sessionId ?? "")))
        .map((agent) => String(agent?.id ?? ""))
        .filter((value) => value.length > 0),
    );
    const nextAgents = agents.filter((agent) => !stale.has(String(agent?.sessionId ?? "")));
    const nextDocument = { ...document, agents: nextAgents };
    if (document?.seats && typeof document.seats === "object") {
      nextDocument.seats = Object.fromEntries(
        Object.entries(document.seats).filter(([seatId]) => !removedSeatIds.has(seatId)),
      );
    }
    writeFileSync(vscodeStatePath, `${JSON.stringify(nextDocument, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch {
    // Ignore non-critical UI cleanup failures.
  }
}

function pruneActiveSessions(sessionIds) {
  if (!existsSync(activeSessionsPath) || sessionIds.length === 0) return;
  try {
    const stale = new Set(sessionIds);
    const document = JSON.parse(readFileSync(activeSessionsPath, "utf8"));
    const activeSessions = Array.isArray(document?.active_sessions) ? document.active_sessions : [];
    const next = activeSessions.filter((sessionId) => !stale.has(sessionId));
    writeFileSync(activeSessionsPath, `${JSON.stringify({ active_sessions: next }, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch {
    // Ignore non-critical local state cleanup failures.
  }
}

async function settleCleanup(sessionIds) {
  for (const delay of [0, 300, 1200]) {
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    for (const sessionId of sessionIds) {
      rmSync(join(projectDir, `${sessionId}.jsonl`), { force: true });
    }
    pruneVscodeState(sessionIds);
    pruneActiveSessions(sessionIds);
  }
}

async function main() {
  if (!existsSync(pixelConfigPath)) {
    throw new Error("Pixel Agents server.json not found.");
  }
  if (!existsSync(projectDir)) {
    console.log("No Pixel Agents project directory found for this repo.");
    return;
  }

  const target = loadTarget();
  const transcriptSessionIds = existsSync(projectDir)
    ? readdirSync(projectDir)
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => name.replace(/\.jsonl$/, ""))
        .filter((name) => name.startsWith("pi-"))
    : [];
  const activeSessionIds = existsSync(activeSessionsPath)
    ? JSON.parse(readFileSync(activeSessionsPath, "utf8"))?.active_sessions ?? []
    : [];
  const sessionIds = [...new Set([...transcriptSessionIds, ...stalePiSessionIdsFromVscodeState(), ...activeSessionIds])]
    .filter((sessionId) => typeof sessionId === "string" && sessionId.startsWith("pi-"));

  for (const sessionId of sessionIds) {
    const payload = {
      session_id: sessionId,
      hook_event_name: "SessionEnd",
      reason: "cleanup",
      actor: "claude",
      delegated_to: "pi-cleanup",
      task: "Cleanup stale Pixel Agents session",
      cwd: targetRoot,
      source: "pi-cleanup",
    };
    await emit(target, {
      ...payload,
      hook_event_name: "Stop",
    });
    await emit(target, payload);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await emit(target, payload);
    await new Promise((resolve) => setTimeout(resolve, 350));
    await emit(target, payload);
  }

  await closeLiveAgents(target, sessionIds);
  await settleCleanup(sessionIds);

  console.log(`Sent cleanup SessionEnd events for ${sessionIds.length} session(s).`);
}

await main();
