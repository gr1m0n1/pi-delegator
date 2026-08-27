import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { DelegationPolicy, dangerousCommand } from "./delegation-policy.mjs";

type PixelAgentsTarget = {
  hookUrl: string;
  token: string;
};

type PixelAgentsDiagnosticAgent = {
  id?: unknown;
  sessionId?: unknown;
  projectDir?: unknown;
};

type PendingDelegation = {
  taskId: string | null;
  sessionId: string;
  task: string;
  parentAgent: string;
  model: string | null;
  transcriptPath: string | null;
  workspaceCwd: string;
};

type ActiveSession = PendingDelegation & {
  agentType: string;
  startedAt: number;
};

type RuntimeState = {
  policy: DelegationPolicy;
  registeredLogger: boolean;
  registeredCleanup: boolean;
  started: Map<string, number>;
  pendingDelegations: Map<string, PendingDelegation[]>;
  taskIds: Map<string, string>;
  activeSessions: Map<string, ActiveSession>;
};

const stateKey = Symbol.for("etc-stack-v3:pi-agent-runtime");
const PIXEL_AGENTS_PROVIDER = process.env.PI_PIXEL_AGENTS_PROVIDER || "claude";
const PIXEL_AGENTS_CONFIG_PATH = join(homedir(), ".pixel-agents", "server.json");
const PIXEL_AGENTS_SERVERS_PATH = join(homedir(), ".pixel-agents", "servers");
const PIXEL_AGENTS_VSCODE_STATE_PATH = join(homedir(), ".pixel-agents", "vscode-state.json");
const PIXEL_AGENTS_TIMEOUT_MS = Math.max(250, Number.parseInt(process.env.PI_PIXEL_AGENTS_TIMEOUT_MS ?? "2000", 10) || 2000);
const CLAUDE_PROJECTS_ROOT = join(homedir(), ".claude", "projects");
const PI_RUNTIME_ROOT = resolve(process.env.PI_CODING_AGENT_DIR || join(process.cwd(), ".pi-delegator"));
const PI_SOURCE_ROOT = resolve(
  process.env.PI_DELEGATOR_SOURCE_ROOT
  || (existsSync(join(process.cwd(), "pi-delegator", "agents")) ? join(process.cwd(), "pi-delegator") : PI_RUNTIME_ROOT),
);
let cachedPixelAgentsWebSocket: Promise<PixelAgentsWebSocketConstructor | null> | null = null;
const shared = ((globalThis as Record<PropertyKey, unknown>)[stateKey] ??= {
  policy: new DelegationPolicy(Number.parseInt(process.env.MAX_SUBAGENT_CALLS ?? "12", 10) || 12),
  registeredLogger: false,
  registeredCleanup: false,
  started: new Map<string, number>(),
  pendingDelegations: new Map<string, PendingDelegation[]>(),
  taskIds: new Map<string, string>(),
  activeSessions: new Map<string, ActiveSession>(),
}) as RuntimeState;

type PixelAgentsWebSocketInstance = {
  send(data: string): void;
  close(): void;
  on(event: string, listener: (...args: unknown[]) => void): PixelAgentsWebSocketInstance;
};

type PixelAgentsWebSocketConstructor = new (
  url: string,
  options?: { headers?: Record<string, string> },
) => PixelAgentsWebSocketInstance;

function modelFor(agent: string): string | null {
  try {
    const body = readFileSync(join(PI_SOURCE_ROOT, "agents", `${agent}.md`), "utf8");
    return /^model:\s*(.+)$/m.exec(body)?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

function piLogDirectory(): string {
  return process.env.PI_AGENT_LOG_DIR || join(PI_RUNTIME_ROOT, "logs");
}

function appendLog(payload: Record<string, unknown>): void {
  try {
    const directory = piLogDirectory();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const line = `${JSON.stringify(payload)}\n`;
    appendFileSync(join(directory, "pi-agents.jsonl"), line, {
      encoding: "utf8",
      mode: 0o600,
    });
    const agentLogFile = agentLogPath(directory, payload);
    if (agentLogFile) {
      appendFileSync(agentLogFile, line, {
        encoding: "utf8",
        mode: 0o600,
      });
    }
  } catch (error) {
    process.stderr.write(`[pi-agent-runtime] logging warning: ${String(error)}\n`);
  }
}

function appendAgentStdout(agent: unknown, payload: { timestamp: string; status: string; taskId: string | null; sessionId: string | null; stdout: unknown }): void {
  try {
    const directory = piLogDirectory();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stdoutPath = agentStdoutPath(directory, agent);
    if (!stdoutPath) return;
    const body = typeof payload.stdout === "string" ? payload.stdout : payload.stdout == null ? "" : String(payload.stdout);
    const header = [
      `[${payload.timestamp}] status=${payload.status} task_id=${payload.taskId ?? "null"} session_id=${payload.sessionId ?? "null"}`,
      "",
    ].join("\n");
    const content = body.endsWith("\n") ? body : `${body}\n`;
    appendFileSync(stdoutPath, `${header}${content}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch (error) {
    process.stderr.write(`[pi-agent-runtime] stdout logging warning: ${String(error)}\n`);
  }
}

function appendAgentStderr(agent: unknown, payload: { timestamp: string; status: string; taskId: string | null; sessionId: string | null; stderr: unknown }): void {
  try {
    const directory = piLogDirectory();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stderrPath = agentStderrPath(directory, agent);
    if (!stderrPath) return;
    const body = typeof payload.stderr === "string" ? payload.stderr : payload.stderr == null ? "" : String(payload.stderr);
    if (!body.trim()) return;
    const header = [
      `[${payload.timestamp}] status=${payload.status} task_id=${payload.taskId ?? "null"} session_id=${payload.sessionId ?? "null"}`,
      "",
    ].join("\n");
    const content = body.endsWith("\n") ? body : `${body}\n`;
    appendFileSync(stderrPath, `${header}${content}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch (error) {
    process.stderr.write(`[pi-agent-runtime] stderr logging warning: ${String(error)}\n`);
  }
}

function agentLogPath(directory: string, payload: Record<string, unknown>): string | null {
  const agentDirectory = resolveAgentLogDirectory(directory, payload.agent, payload.delegated_to, payload.parent_agent);
  return agentDirectory ? join(agentDirectory, "events.jsonl") : null;
}

function agentStdoutPath(directory: string, agent: unknown): string | null {
  const agentDirectory = resolveAgentLogDirectory(directory, agent);
  return agentDirectory ? join(agentDirectory, "stdout.log") : null;
}

function agentStderrPath(directory: string, agent: unknown): string | null {
  const agentDirectory = resolveAgentLogDirectory(directory, agent);
  return agentDirectory ? join(agentDirectory, "stderr.log") : null;
}

function resolveAgentLogDirectory(directory: string, ...values: unknown[]): string | null {
  const agent =
    values
      .map((value) => sanitizeLogName(value))
      .find((value): value is string => Boolean(value));
  if (!agent) return null;
  const agentDirectory = join(directory, "agents", agent);
  mkdirSync(agentDirectory, { recursive: true, mode: 0o700 });
  return agentDirectory;
}

function sanitizeLogName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-");
  return normalized || null;
}

function taskId(result: unknown): string | null {
  return typeof result === "string"
    ? /\bTASK_ID:\s*(TASK-[A-Za-z0-9.-]+)/.exec(result)?.[1] ?? null
    : null;
}

function pixelAgentsStatePath(): string {
  return join(piLogDirectory(), "pixel-agents-active-sessions.json");
}

function pixelAgentsWorkspaceCwd(): string {
  const override = String(process.env.PI_PIXEL_AGENTS_WORKSPACE_CWD || "").trim();
  return override || process.cwd();
}

function loadPixelAgentsTarget(): PixelAgentsTarget | null {
  const targets = loadPixelAgentsTargets();
  return targets[0] ?? null;
}

function pixelAgentsWsUrl(hookUrl: string): string {
  return hookUrl.replace(/\/api\/hooks\/[^/]+$/, "/ws").replace(/^http/i, "ws");
}

async function loadPixelAgentsWebSocket(): Promise<PixelAgentsWebSocketConstructor | null> {
  if (cachedPixelAgentsWebSocket) return cachedPixelAgentsWebSocket;
  cachedPixelAgentsWebSocket = (async () => {
    const candidates = new Set<string>();
    const explicit = String(process.env.PI_PIXEL_AGENTS_WS_MODULE || "").trim();
    if (explicit) candidates.add(explicit);
    candidates.add(join(process.cwd(), "node_modules", "ws", "index.js"));
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
        const module = await import(pathToFileURL(candidate).href);
        const WebSocketCtor = (module.WebSocket ?? module.default) as PixelAgentsWebSocketConstructor | undefined;
        if (WebSocketCtor) return WebSocketCtor;
      } catch {
        // Keep trying fallbacks.
      }
    }

    return null;
  })();
  return cachedPixelAgentsWebSocket;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function loadPixelAgentsTargets(): PixelAgentsTarget[] {
  const targets = new Map<string, PixelAgentsTarget>();
  const pushTarget = (baseUrlValue: string, tokenValue: string) => {
    const baseUrl = baseUrlValue.trim();
    const token = tokenValue.trim();
    if (!baseUrl || !token) return;
    const stripped = baseUrl.replace(/\/+$/, "");
    const hookUrl = stripped.includes("/api/hooks/") ? stripped : `${stripped}/api/hooks/${PIXEL_AGENTS_PROVIDER}`;
    targets.set(`${hookUrl}::${token}`, { hookUrl, token });
  };

  if (existsSync(PIXEL_AGENTS_SERVERS_PATH)) {
    try {
      for (const fileName of readdirSync(PIXEL_AGENTS_SERVERS_PATH)) {
        if (!fileName.endsWith(".json")) continue;
        try {
          const config = JSON.parse(readFileSync(join(PIXEL_AGENTS_SERVERS_PATH, fileName), "utf8")) as Record<string, unknown>;
          const port = config.port;
          const pid = config.pid;
          const token = config.token;
          if (
            typeof port === "number"
            && Number.isInteger(port)
            && port > 0
            && typeof pid === "number"
            && Number.isInteger(pid)
            && pid > 0
            && processIsAlive(pid)
            && typeof token === "string"
            && token.trim()
          ) {
            pushTarget(`http://127.0.0.1:${port}`, token);
          }
        } catch {
          // Ignore malformed registry entries.
        }
      }
    } catch {
      // Ignore registry read failures and fall back to server.json / env.
    }
  }

  let baseUrl = String(process.env.PI_PIXEL_AGENTS_URL || "").trim();
  let token = String(process.env.PI_PIXEL_AGENTS_TOKEN || "").trim();

  if ((!baseUrl || !token) && existsSync(PIXEL_AGENTS_CONFIG_PATH)) {
    try {
      const config = JSON.parse(readFileSync(PIXEL_AGENTS_CONFIG_PATH, "utf8")) as Record<string, unknown>;
      if (!baseUrl && typeof config.port === "number" && Number.isInteger(config.port) && config.port > 0) {
        baseUrl = `http://127.0.0.1:${config.port}`;
      }
      if (!token && typeof config.token === "string" && config.token.trim()) {
        token = config.token.trim();
      }
    } catch {
      return [...targets.values()];
    }
  }

  pushTarget(baseUrl, token);
  return [...targets.values()];
}

function loadActivePixelAgentSessions(): Set<string> {
  try {
    const document = JSON.parse(readFileSync(pixelAgentsStatePath(), "utf8")) as { active_sessions?: unknown };
    const raw = Array.isArray(document?.active_sessions) ? document.active_sessions : [];
    return new Set(raw.filter((value): value is string => typeof value === "string" && value.trim().length > 0));
  } catch {
    return new Set();
  }
}

function persistActivePixelAgentSessions(): void {
  try {
    const statePath = pixelAgentsStatePath();
    mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
    writeFileSync(
      statePath,
      `${JSON.stringify({ active_sessions: [...new Set([...shared.activeSessions.values()].map((session) => session.sessionId))].sort() }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  } catch (error) {
    process.stderr.write(`[pi-agent-runtime] pixel agents state warning: ${String(error)}\n`);
  }
}

async function emitPixelAgentsEvent(payload: Record<string, unknown>): Promise<void> {
  const targets = loadPixelAgentsTargets();
  if (targets.length === 0) return;
  await Promise.all(targets.map(async (target) => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PIXEL_AGENTS_TIMEOUT_MS);
      await fetch(target.hookUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${target.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timer);
    } catch {
      return;
    }
  }));
}

async function closePixelAgentsSessions(sessionIds: string[], cwd: string): Promise<void> {
  if (sessionIds.length === 0) return;
  const WebSocketCtor = await loadPixelAgentsWebSocket();
  if (!WebSocketCtor) return;

  const wantedSessionIds = new Set(sessionIds);
  const wantedProjectDir = pixelAgentsProjectDirFromCwd(cwd);
  const targets = loadPixelAgentsTargets();

  await Promise.all(targets.map(async (target) => {
    const diagnostics = await new Promise<PixelAgentsDiagnosticAgent[]>((resolve) => {
      let settled = false;
      const ws = new WebSocketCtor(pixelAgentsWsUrl(target.hookUrl), {
        headers: {
          Authorization: `Bearer ${target.token}`,
        },
      });
      const finish = (agents: PixelAgentsDiagnosticAgent[]) => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          // Ignore close races.
        }
        resolve(agents);
      };

      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "requestDiagnostics" }));
      });
      ws.on("message", (raw: unknown) => {
        try {
          const text = typeof raw === "string" ? raw : String(raw);
          const message = JSON.parse(text) as { type?: unknown; agents?: unknown };
          if (message.type === "agentDiagnostics" && Array.isArray(message.agents)) {
            finish(message.agents as PixelAgentsDiagnosticAgent[]);
          }
        } catch {
          finish([]);
        }
      });
      ws.on("error", () => finish([]));
      setTimeout(() => finish([]), PIXEL_AGENTS_TIMEOUT_MS);
    });

    const ids = diagnostics
      .map((agent) => ({
        id: typeof agent.id === "number" ? agent.id : null,
        sessionId: typeof agent.sessionId === "string" ? agent.sessionId : "",
        projectDir: typeof agent.projectDir === "string" ? agent.projectDir : "",
      }))
      .filter((agent) => agent.id !== null)
      .filter((agent) => wantedSessionIds.has(agent.sessionId) || (!agent.sessionId && agent.projectDir === wantedProjectDir))
      .map((agent) => agent.id as number);

    if (ids.length === 0) return;

    await new Promise<void>((resolve) => {
      let opened = false;
      const ws = new WebSocketCtor(pixelAgentsWsUrl(target.hookUrl), {
        headers: {
          Authorization: `Bearer ${target.token}`,
        },
      });
      const finish = () => {
        try {
          ws.close();
        } catch {
          // Ignore close races.
        }
        resolve();
      };

      ws.on("open", () => {
        opened = true;
        for (const id of ids) {
          ws.send(JSON.stringify({ type: "closeAgent", id }));
        }
        setTimeout(finish, 250);
      });
      ws.on("error", () => finish());
      setTimeout(() => {
        if (!opened) finish();
      }, PIXEL_AGENTS_TIMEOUT_MS);
    });
  }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function taskDescription(prompt: string): string {
  const objective = /\bOBJECTIVE:\s*([\s\S]*?)(?:\n[A-Z_]+:|\s*$)/.exec(prompt)?.[1]?.trim();
  if (objective) return objective.slice(0, 500);
  return prompt.trim().slice(0, 500) || "Delegated task";
}

function pixelToolContext(agentType: string, task: string): { toolName: string; toolInput: Record<string, unknown> } {
  const role = pixelAgentRole(agentType);
  if (role === "research") return { toolName: "Grep", toolInput: { pattern: task } };
  if (role === "implement") return { toolName: "Edit", toolInput: { file_path: task } };
  if (role === "tests") return { toolName: "Bash", toolInput: { command: task } };
  if (role === "review") return { toolName: "Read", toolInput: { file_path: task } };
  return { toolName: "Task", toolInput: { description: task } };
}

function pixelAgentRole(agentType: string): "research" | "implement" | "tests" | "review" | "orchestrate" {
  if (agentType.includes("research")) return "research";
  if (agentType.includes("coder")) return "implement";
  if (agentType.includes("tester")) return "tests";
  if (agentType.includes("review")) return "review";
  return "orchestrate";
}

function pixelAgentsProjectDir(cwd: string): string {
  const sanitized = cwd.replace(/[^a-zA-Z0-9-]/g, "-");
  return join(CLAUDE_PROJECTS_ROOT, sanitized);
}

function preparePixelAgentsTranscript(cwd: string, sessionId: string): string | null {
  try {
    const projectDir = pixelAgentsProjectDir(cwd);
    mkdirSync(projectDir, { recursive: true, mode: 0o700 });
    const transcriptPath = join(projectDir, `${sessionId}.jsonl`);
    if (!existsSync(transcriptPath)) writeFileSync(transcriptPath, "", { encoding: "utf8", mode: 0o600 });
    return transcriptPath;
  } catch {
    return null;
  }
}

function pixelAgentsProjectDirFromCwd(cwd: string): string {
  const sanitized = cwd.replace(/[^a-zA-Z0-9-]/g, "-");
  return join(CLAUDE_PROJECTS_ROOT, sanitized);
}

function prunePixelAgentsVscodeState(sessionId: string): void {
  if (!existsSync(PIXEL_AGENTS_VSCODE_STATE_PATH)) return;
  try {
    const document = JSON.parse(readFileSync(PIXEL_AGENTS_VSCODE_STATE_PATH, "utf8")) as {
      agents?: Array<{ sessionId?: unknown; id?: unknown }>;
      seats?: Record<string, unknown>;
    };
    const agents = Array.isArray(document.agents) ? document.agents : [];
    const removedSeatIds = new Set(
      agents
        .filter((agent) => agent?.sessionId === sessionId)
        .map((agent) => String(agent?.id ?? ""))
        .filter((value) => value.length > 0),
    );
    const nextAgents = agents.filter((agent) => agent?.sessionId !== sessionId);
    if (nextAgents.length === agents.length && removedSeatIds.size === 0) return;

    const nextDocument: { agents: typeof nextAgents; seats?: Record<string, unknown> } = {
      ...document,
      agents: nextAgents,
    };
    if (document.seats && typeof document.seats === "object") {
      nextDocument.seats = Object.fromEntries(
        Object.entries(document.seats).filter(([seatId]) => !removedSeatIds.has(seatId)),
      );
    }

    writeFileSync(PIXEL_AGENTS_VSCODE_STATE_PATH, `${JSON.stringify(nextDocument, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch (error) {
    process.stderr.write(`[pi-agent-runtime] pixel agents vscode-state warning: ${String(error)}\n`);
  }
}

function removePixelAgentTranscript(cwd: string, sessionId: string, transcriptPath: string | null): void {
  const candidates = new Set<string>();
  if (transcriptPath) candidates.add(transcriptPath);
  candidates.add(join(pixelAgentsProjectDirFromCwd(cwd), `${sessionId}.jsonl`));
  for (const candidate of candidates) {
    try {
      rmSync(candidate, { force: true });
    } catch {
      // Ignore best-effort cleanup failures for transient transcript files.
    }
  }
}

function forcePixelAgentCleanupSync(session: Pick<ActiveSession, "workspaceCwd" | "sessionId" | "transcriptPath">): void {
  removePixelAgentTranscript(session.workspaceCwd, session.sessionId, session.transcriptPath);
  prunePixelAgentsVscodeState(session.sessionId);
}

function staleProjectPixelAgentSessionIds(cwd: string): string[] {
  if (!existsSync(PIXEL_AGENTS_VSCODE_STATE_PATH)) return [];
  try {
    const document = JSON.parse(readFileSync(PIXEL_AGENTS_VSCODE_STATE_PATH, "utf8")) as {
      agents?: Array<{ sessionId?: unknown; projectDir?: unknown }>;
    };
    const activeSessionIds = new Set([...shared.activeSessions.values()].map((session) => session.sessionId));
    const projectDir = pixelAgentsProjectDirFromCwd(cwd);
    const agents = Array.isArray(document.agents) ? document.agents : [];
    return [...new Set(
      agents
        .map((agent) => ({
          sessionId: typeof agent?.sessionId === "string" ? agent.sessionId : "",
          projectDir: typeof agent?.projectDir === "string" ? agent.projectDir : "",
        }))
        .filter((agent) => agent.sessionId.startsWith("pi-"))
        .filter((agent) => !activeSessionIds.has(agent.sessionId))
        .filter((agent) => !agent.projectDir || agent.projectDir === projectDir)
        .map((agent) => agent.sessionId),
    )];
  } catch {
    return [];
  }
}

async function settlePixelAgentCleanup(cwd: string, sessionId: string, transcriptPath: string | null): Promise<void> {
  const delays = [0, 300, 1200];
  for (const delay of delays) {
    if (delay > 0) await sleep(delay);
    removePixelAgentTranscript(cwd, sessionId, transcriptPath);
    prunePixelAgentsVscodeState(sessionId);
    for (const staleSessionId of staleProjectPixelAgentSessionIds(cwd)) {
      removePixelAgentTranscript(cwd, staleSessionId, null);
      prunePixelAgentsVscodeState(staleSessionId);
    }
  }
  await closePixelAgentsSessions([sessionId, ...staleProjectPixelAgentSessionIds(cwd)], cwd);
}

function stalePixelAgentSessionIds(cwd: string): string[] {
  if (!existsSync(PIXEL_AGENTS_VSCODE_STATE_PATH)) return [];
  try {
    const document = JSON.parse(readFileSync(PIXEL_AGENTS_VSCODE_STATE_PATH, "utf8")) as {
      agents?: Array<{ sessionId?: unknown; projectDir?: unknown }>;
    };
    const activeSessionIds = new Set([...shared.activeSessions.values()].map((session) => session.sessionId));
    const projectDir = pixelAgentsProjectDirFromCwd(cwd);
    const agents = Array.isArray(document.agents) ? document.agents : [];
    return agents
      .map((agent) => ({
        sessionId: typeof agent?.sessionId === "string" ? agent.sessionId : "",
        projectDir: typeof agent?.projectDir === "string" ? agent.projectDir : "",
      }))
      .filter((agent) => agent.sessionId.startsWith("pi-"))
      .filter((agent) => !activeSessionIds.has(agent.sessionId))
      .filter((agent) => !agent.projectDir || agent.projectDir === projectDir)
      .map((agent) => agent.sessionId);
  } catch {
    return [];
  }
}

async function reconcileStalePixelAgentSessions(cwd: string): Promise<void> {
  const staleSessionIds = stalePixelAgentSessionIds(cwd);
  if (staleSessionIds.length === 0) return;

  for (const sessionId of staleSessionIds) {
    const payload = {
      session_id: sessionId,
      hook_event_name: "SessionEnd",
      reason: "stale_cleanup",
      actor: "claude",
      delegated_to: "pi-cleanup",
      task: "Cleanup stale Pixel Agents session",
      cwd,
      source: "pi-cleanup",
    };
    await emitPixelAgentsEvent(payload);
    await sleep(150);
    await emitPixelAgentsEvent(payload);
    await settlePixelAgentCleanup(cwd, sessionId, null);
  }
}

function beginPixelAgentSession(subagentId: string, session: ActiveSession): boolean {
  const active = loadActivePixelAgentSessions();
  if (active.has(session.sessionId)) return false;
  shared.activeSessions.set(subagentId, session);
  persistActivePixelAgentSessions();
  return true;
}

function endPixelAgentSession(subagentId: string): ActiveSession | null {
  const session = shared.activeSessions.get(subagentId) ?? null;
  shared.activeSessions.delete(subagentId);
  persistActivePixelAgentSessions();
  return session;
}

async function emitPixelAgentSessionEnd(session: ActiveSession, reason: string): Promise<void> {
  const role = pixelAgentRole(session.agentType);
  const basePayload = {
    session_id: session.sessionId,
    actor: "claude",
    delegated_to: session.agentType,
    task: session.task,
    cwd: session.workspaceCwd,
    source: `pi-${role}`,
  };
  await emitPixelAgentsEvent({
    ...basePayload,
    hook_event_name: reason === "completed" || reason === "partial" ? "PostToolUse" : "PostToolUseFailure",
  });
  await emitPixelAgentsEvent({
    ...basePayload,
    hook_event_name: "Stop",
  });
  await emitPixelAgentsEvent({
    ...basePayload,
    hook_event_name: "SessionEnd",
    reason,
  });
  await sleep(250);
  await emitPixelAgentsEvent({
    ...basePayload,
    hook_event_name: "SessionEnd",
    reason,
  });
  await sleep(350);
  await emitPixelAgentsEvent({
    ...basePayload,
    hook_event_name: "SessionEnd",
    reason,
  });
  await settlePixelAgentCleanup(session.workspaceCwd, session.sessionId, session.transcriptPath);
}

function registerCleanupHandlers(): void {
  if (shared.registeredCleanup) return;
  shared.registeredCleanup = true;

  const clearSessions = () => {
    for (const session of shared.activeSessions.values()) {
      forcePixelAgentCleanupSync(session);
    }
    shared.activeSessions.clear();
    persistActivePixelAgentSessions();
  };

  process.on("exit", clearSessions);
  process.on("SIGINT", () => {
    clearSessions();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    clearSessions();
    process.exit(143);
  });
}

export default function piAgentRuntime(pi: ExtensionAPI) {
  pi.on("tool_call", async (event) => {
    if (event.toolName === "Agent") {
      const input = event.input as Record<string, unknown>;
      const prompt = String(input.prompt ?? "");
      const decision = shared.policy.request(prompt);
      if (!decision.allowed) return { block: true, reason: decision.reason };
      const delegatedTaskId = /\bTASK_ID:\s*(TASK-[A-Za-z0-9.-]+)/.exec(prompt)?.[1] ?? null;
      const agentType = String(input.subagent_type ?? "");
      const pending = shared.pendingDelegations.get(agentType) ?? [];
      pending.push({
        taskId: delegatedTaskId,
        sessionId: `pi-${agentType.replace(/[^a-zA-Z0-9_-]/g, "-")}-${randomUUID()}`,
        task: taskDescription(prompt),
        parentAgent: /\bPARENT_AGENT:\s*([A-Za-z0-9_-]+)/.exec(prompt)?.[1] ?? "main",
        model: typeof input.model === "string" && input.model.trim() ? input.model : modelFor(agentType),
        transcriptPath: null,
        workspaceCwd: pixelAgentsWorkspaceCwd(),
      });
      shared.pendingDelegations.set(agentType, pending);
      appendLog({
        timestamp: new Date().toISOString(),
        event: "delegation_requested",
        task_id: delegatedTaskId,
        parent_agent: /\bPARENT_AGENT:\s*([A-Za-z0-9_-]+)/.exec(prompt)?.[1] ?? "main",
        agent: input.subagent_type ?? null,
        model: input.model ?? modelFor(String(input.subagent_type ?? "")),
        tool_calls: 1,
        delegation_number: decision.number,
        status: "requested",
      });
    }

    if (event.toolName === "bash") {
      const command = String((event.input as Record<string, unknown>).command ?? "");
      if (dangerousCommand.test(command)) {
        return { block: true, reason: "Command blocked by Pi agent least-privilege policy" };
      }
    }
    return undefined;
  });

  if (shared.registeredLogger) return;
  shared.registeredLogger = true;
  registerCleanupHandlers();

  pi.events.on("subagents:started", async (event: { id: string; type: string }) => {
    shared.started.set(event.id, Date.now());
    const pending = shared.pendingDelegations.get(event.type) ?? [];
    const delegated = pending.shift();
    if (delegated?.taskId) shared.taskIds.set(event.id, delegated.taskId);
    shared.pendingDelegations.set(event.type, pending);
    if (!delegated) {
      appendLog({
        timestamp: new Date().toISOString(),
        event: "subagent_started_without_pending",
        subagent_id: event.id,
        agent: event.type,
        status: "orphaned",
      });
      return;
    }

    await reconcileStalePixelAgentSessions(delegated.workspaceCwd);
    const transcriptPath = preparePixelAgentsTranscript(delegated.workspaceCwd, delegated.sessionId);
    const session: ActiveSession = {
      ...delegated,
      transcriptPath,
      agentType: event.type,
      startedAt: Date.now(),
    };
    if (!beginPixelAgentSession(event.id, session)) return;
    appendLog({
      timestamp: new Date().toISOString(),
      event: "pixel_agent_session_started",
      subagent_id: event.id,
      task_id: delegated.taskId,
      session_id: session.sessionId,
      parent_agent: delegated.parentAgent,
      agent: event.type,
      transcript_path: transcriptPath,
      cwd: delegated.workspaceCwd,
      status: "started",
    });

    const { toolName, toolInput } = pixelToolContext(event.type, delegated.task);
    const role = pixelAgentRole(event.type);
    const basePayload = {
      session_id: session.sessionId,
      actor: "claude",
      delegated_to: event.type,
      task: delegated.task,
      cwd: delegated.workspaceCwd,
      source: `pi-${role}`,
    };

    await emitPixelAgentsEvent({
      ...basePayload,
      hook_event_name: "SessionStart",
      model_override: delegated.model,
      transcript_path: transcriptPath,
    });
    await sleep(150);
    await emitPixelAgentsEvent({
      ...basePayload,
      hook_event_name: "PreToolUse",
      tool_name: toolName,
      tool_input: {
        ...toolInput,
        profile: event.type,
        attempt: 1,
      },
    });
    await sleep(150);
    await emitPixelAgentsEvent({
      ...basePayload,
      hook_event_name: "PreToolUse",
      tool_name: toolName,
      tool_input: {
        ...toolInput,
        profile: event.type,
        attempt: 1,
      },
    });
  });

  const finish = async (event: Record<string, unknown>, terminalReason: string) => {
    const end = Date.now();
    const duration = Number(event.durationMs ?? 0);
    const start = shared.started.get(String(event.id)) ?? end - duration;
    const tokens = (event.tokens ?? {}) as Record<string, unknown>;
    const effectiveStatus = String(event.status ?? terminalReason ?? "unknown");
    const timestamp = new Date(end).toISOString();
    const resolvedTaskId = taskId(event.result) ?? shared.taskIds.get(String(event.id)) ?? null;
    const activeSession = shared.activeSessions.get(String(event.id)) ?? null;
    appendLog({
      timestamp,
      task_id: resolvedTaskId,
      parent_agent: "main",
      agent: event.type ?? null,
      model: modelFor(String(event.type ?? "")),
      start_time: new Date(start).toISOString(),
      end_time: new Date(end).toISOString(),
      duration_ms: duration,
      prompt_tokens: tokens.input ?? null,
      completion_tokens: tokens.output ?? null,
      total_tokens: tokens.total ?? null,
      tool_calls: event.toolUses ?? 0,
      cost: null,
      status: effectiveStatus,
      error: event.error ?? null,
    });
    appendAgentStdout(event.type, {
      timestamp,
      status: effectiveStatus,
      taskId: resolvedTaskId,
      sessionId: activeSession?.sessionId ?? null,
      stdout: event.result,
    });
    appendAgentStderr(event.type, {
      timestamp,
      status: effectiveStatus,
      taskId: resolvedTaskId,
      sessionId: activeSession?.sessionId ?? null,
      stderr: event.error,
    });
    if (activeSession) {
      endPixelAgentSession(String(event.id));
      await emitPixelAgentSessionEnd(activeSession, terminalReason);
    }
    shared.started.delete(String(event.id));
    shared.taskIds.delete(String(event.id));
  };

  pi.events.on("subagents:completed", (event: Record<string, unknown>) => finish(event, "completed"));
  pi.events.on("subagents:failed", (event: Record<string, unknown>) => finish(event, String(event.status ?? "failed")));
}
