import * as vscode from "vscode";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";

type ActivityEvent = {
  timestamp?: string;
  event?: string;
  session_id?: string;
  task_id?: string;
  agent?: string;
  status?: string;
  duration_ms?: number;
  subagent_id?: string;
  async_dir?: string;
};

type ActivitySnapshot = {
  logPath: vscode.Uri | undefined;
  runtimeRoot: vscode.Uri | undefined;
  active: ActivityEvent[];
  recent: ActivityEvent[];
};

const activeSessionStaleMs = 90_000;

class ActivityItem extends vscode.TreeItem {
  constructor(label: string, description?: string, collapsibleState = vscode.TreeItemCollapsibleState.None) {
    super(label, collapsibleState);
    this.description = description;
  }
}

class ActivityProvider implements vscode.TreeDataProvider<ActivityItem> {
  private readonly changed = new vscode.EventEmitter<ActivityItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private snapshot: ActivitySnapshot = { logPath: undefined, runtimeRoot: undefined, active: [], recent: [] };
  private refreshTimer: NodeJS.Timeout | undefined;

  refresh(): void {
    this.snapshot = this.readSnapshot();
    this.changed.fire(undefined);
  }

  scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refresh(), 100);
  }

  getTreeItem(item: ActivityItem): vscode.TreeItem {
    return item;
  }

  getChildren(item?: ActivityItem): ActivityItem[] {
    if (!item) {
      if (!this.snapshot.logPath) return [new ActivityItem("No Pi runtime log found")];
      return [
        new ActivityItem(`Active (${this.snapshot.active.length})`, undefined, vscode.TreeItemCollapsibleState.Expanded),
        new ActivityItem("Recent", undefined, vscode.TreeItemCollapsibleState.Collapsed),
      ];
    }
    const label = typeof item.label === "string" ? item.label : item.label?.label ?? "";
    if (label.startsWith("Active")) {
      return this.snapshot.active.length
        ? this.snapshot.active.map((entry) => this.agentItem(entry, "running"))
        : [new ActivityItem("No active subagents")];
    }
    if (label === "Recent") {
      const activeSessions = new Set(this.snapshot.active.map((entry) => entry.session_id).filter(Boolean));
      const activeSubagents = new Set(this.snapshot.active.map((entry) => entry.subagent_id).filter(Boolean));
      const activeTasks = new Set(
        this.snapshot.active
          .map((entry) => activityKey(entry))
          .filter(Boolean),
      );
      const terminalStatuses = new Map<string, string>();
      for (const entry of this.snapshot.recent) {
        if (!isTerminalEvent(entry)) continue;
        const status = entry.status || (entry.event === "subagent_async_completed" ? "completed" : "interrupted");
        for (const key of terminalKeys(entry)) {
          if (key) terminalStatuses.set(key, status);
        }
      }
      return this.snapshot.recent.slice().reverse().map((entry) => {
        const keys = terminalKeys(entry);
        const key = activityKey(entry);
        const started = entry.event === "pixel_agent_session_started" || entry.event === "subagent_async_started";
        const running = started
          && Boolean(
            (entry.event === "subagent_async_started"
              ? entry.subagent_id && activeSubagents.has(entry.subagent_id)
              : entry.session_id ? activeSessions.has(entry.session_id) : key && activeTasks.has(key))
            && !keys.some((key) => terminalStatuses.has(key)),
          );
        const status = running
          ? "running"
          : started
            ? keys.map((key) => terminalStatuses.get(key)).find(Boolean) || "unknown"
            : entry.status || entry.event || "updated";
        return this.agentItem(entry, status);
      });
    }
    return [];
  }

  logUri(): vscode.Uri | undefined {
    return this.snapshot.logPath;
  }

  agentOutputUri(agent: string): vscode.Uri | undefined {
    return this.snapshot.runtimeRoot && agent
      ? vscode.Uri.joinPath(this.snapshot.runtimeRoot, "logs", "agents", agent, "stdout.log")
      : undefined;
  }

  private agentItem(entry: ActivityEvent, status: string): ActivityItem {
    const agent = entry.agent || "Pi";
    const task = entry.task_id || "unassigned";
    const item = new ActivityItem(agent, `${status}  ${task}`);
    item.contextValue = "piDelegator.agent";
    item.iconPath = new vscode.ThemeIcon(status === "running" || status === "started" ? "sync~spin" : status === "completed" ? "pass" : "circle-outline");
    item.command = { command: "piDelegatorActivity.openAgentOutput", title: "Open Pi Agent Output", arguments: [item] };
    return item;
  }

  private readSnapshot(): ActivitySnapshot {
    const logPath = discoveredLogPath();
    if (!logPath) return { logPath: undefined, runtimeRoot: undefined, active: [], recent: [] };
    const runtimeRoot = vscode.Uri.file(dirname(dirname(logPath.fsPath)));
    let entries: ActivityEvent[];
    try {
      entries = readFileSync(logPath.fsPath, "utf8")
        .split(/\r?\n/)
        .flatMap((line: string) => {
          try {
            const entry = JSON.parse(line);
            return entry && typeof entry === "object" ? [entry as ActivityEvent] : [];
          } catch {
            return [];
          }
        });
    } catch {
      return { logPath, runtimeRoot, active: [], recent: [] };
    }
    entries = entries.flatMap((entry) => {
      if (entry.event !== "subagent_async_started") return [entry];
      const terminal = nativeRunTerminal(entry);
      return terminal ? [entry, { ...entry, event: "subagent_async_completed", ...terminal }] : [entry];
    });
    const activeBySession = new Map<string, ActivityEvent>();
    for (const entry of entries) {
      if (entry.event === "pixel_agent_session_started" && entry.session_id) activeBySession.set(entry.session_id, entry);
      if (entry.event === "subagent_async_started" && entry.subagent_id) activeBySession.set(`async:${entry.subagent_id}`, entry);
      else if (entry.event === "subagent_async_completed" && entry.subagent_id) activeBySession.delete(`async:${entry.subagent_id}`);
      else if (isTerminalEvent(entry)) {
        if (entry.session_id) activeBySession.delete(entry.session_id);
        if (entry.subagent_id) activeBySession.delete(`async:${entry.subagent_id}`);
      }
    }
    let activeIds: Set<unknown> | undefined;
    let stateIsStale = true;
    try {
      const statePath = vscode.Uri.joinPath(runtimeRoot, "logs", "pixel-agents-active-sessions.json");
      const state = JSON.parse(readFileSync(statePath.fsPath, "utf8"));
      activeIds = new Set(Array.isArray(state.active_sessions) ? state.active_sessions : []);
      const updatedAt = Date.parse(String(state.updated_at ?? ""));
      stateIsStale = !Number.isFinite(updatedAt) || Date.now() - updatedAt > activeSessionStaleMs;
    } catch {
      // Older runtimes do not yet persist an authoritative active-session file.
    }
    for (const [key, entry] of [...activeBySession.entries()]) {
      const observed = key.startsWith("async:")
        ? nativeRunState(entry) === "running" || isRecentEvent(entry)
        : activeIds && !stateIsStale ? activeIds.has(key) : isRecentEvent(entry);
      if (!observed) activeBySession.delete(key);
    }
    return { logPath, runtimeRoot, active: [...activeBySession.values()], recent: entries.slice(-50) };
  }
}

function activityKey(entry: ActivityEvent): string | undefined {
  return entry.task_id && entry.agent ? `${entry.task_id}:${entry.agent}` : undefined;
}

function nativeRunState(entry: ActivityEvent): string | undefined {
  const runDir = entry.async_dir;
  if (!runDir || !entry.subagent_id || !isAbsolute(runDir)
    || basename(runDir) !== entry.subagent_id || basename(dirname(runDir)) !== "async-subagent-runs") return undefined;
  try {
    const state = JSON.parse(readFileSync(resolve(runDir, "status.json"), "utf8"));
    return typeof state.state === "string" ? state.state : undefined;
  } catch {
    return undefined;
  }
}

function nativeRunTerminal(entry: ActivityEvent): Pick<ActivityEvent, "status" | "timestamp"> | undefined {
  const state = nativeRunState(entry);
  if (!state || state === "running" || state === "queued") return undefined;
  let status = state === "partial" ? "partial" : "blocked";
  if (state === "complete") {
    status = "partial";
    try {
      const outputPath = resolve(entry.async_dir!, "output-0.log");
      const output = statSync(outputPath).size <= 1_000_000 ? readFileSync(outputPath, "utf8") : "";
      const matches = [...output.matchAll(/^STATUS:\s*(COMPLETED|PARTIAL|BLOCKED)\s*$/gim)];
      if (matches.length) status = matches.at(-1)![1].toLowerCase();
    } catch {
      // A finished process without a readable task result remains partial.
    }
  }
  return { status, timestamp: new Date().toISOString() };
}

function terminalKeys(entry: ActivityEvent): string[] {
  if (entry.event === "subagent_async_started" || entry.event === "subagent_async_completed") {
    return entry.subagent_id ? [`async:${entry.subagent_id}`] : [];
  }
  const key = entry.session_id || activityKey(entry);
  return key ? [key] : [];
}

function isRecentEvent(entry: ActivityEvent): boolean {
  const timestamp = Date.parse(String(entry.timestamp ?? ""));
  return Number.isFinite(timestamp) && Date.now() - timestamp <= activeSessionStaleMs;
}

function isTerminalEvent(entry: ActivityEvent): boolean {
  return entry.event === "subagent_interrupted"
    || entry.event === "subagent_async_completed"
    || !entry.event && ["completed", "partial", "failed", "blocked", "cancelled", "aborted", "stopped"].includes(String(entry.status).toLowerCase());
}

function configuredLogPath(): vscode.Uri | undefined {
  const configured = vscode.workspace.getConfiguration("piDelegator.activity").get<string>("logPath")?.trim();
  if (configured) return vscode.Uri.file(configured);
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri;
  return workspace ? vscode.Uri.joinPath(workspace, ".pi-delegator", "logs", "pi-agents.jsonl") : undefined;
}

function discoveredLogPath(): vscode.Uri | undefined {
  const configured = vscode.workspace.getConfiguration("piDelegator.activity").get<string>("logPath")?.trim();
  if (configured) return vscode.Uri.file(configured);
  for (const workspace of vscode.workspace.workspaceFolders ?? []) {
    const localLog = vscode.Uri.joinPath(workspace.uri, ".pi-delegator", "logs", "pi-agents.jsonl");
    if (existsSync(localLog.fsPath)) return localLog;
    const runtimeMarker = vscode.Uri.joinPath(workspace.uri, ".pi-delegator", ".pixel-agents-workspace-root");
    try {
      const targetRoot = readFileSync(runtimeMarker.fsPath, "utf8").trim();
      const targetLog = vscode.Uri.file(resolve(targetRoot, ".pi-delegator", "logs", "pi-agents.jsonl"));
      if (existsSync(targetLog.fsPath)) return targetLog;
    } catch {
      // This workspace does not contain a pi-delegator managed external runtime.
    }
  }
  return configuredLogPath();
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new ActivityProvider();
  const view = vscode.window.createTreeView("piDelegator.activity", { treeDataProvider: provider, showCollapseAll: true });
  const refresh = () => provider.scheduleRefresh();
  const watchLogs = (vscode.workspace.workspaceFolders ?? []).map((workspace) =>
    vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspace.uri, ".pi-delegator/logs/*"))
  );
  for (const watcher of watchLogs) {
    context.subscriptions.push(watcher, watcher.onDidChange(refresh), watcher.onDidCreate(refresh), watcher.onDidDelete(refresh));
  }
  const configuredLog = vscode.workspace.getConfiguration("piDelegator.activity").get<string>("logPath")?.trim();
  if (configuredLog) {
    const watcher = vscode.workspace.createFileSystemWatcher(configuredLog);
    context.subscriptions.push(watcher, watcher.onDidChange(refresh), watcher.onDidCreate(refresh), watcher.onDidDelete(refresh));
  }
  const poll = setInterval(refresh, 5_000);
  context.subscriptions.push(view, { dispose: () => clearInterval(poll) });
  context.subscriptions.push(vscode.commands.registerCommand("piDelegatorActivity.refresh", () => provider.refresh()));
  context.subscriptions.push(vscode.commands.registerCommand("piDelegatorActivity.openLog", async () => {
    const uri = provider.logUri() || configuredLogPath();
    if (uri) await vscode.window.showTextDocument(uri, { preview: false });
  }));
  context.subscriptions.push(vscode.commands.registerCommand("piDelegatorActivity.openAgentOutput", async (item?: ActivityItem) => {
    const agent = typeof item?.label === "string" ? item.label : "";
    const uri = provider.agentOutputUri(agent);
    if (uri) await vscode.window.showTextDocument(uri, { preview: false });
  }));
  context.subscriptions.push(vscode.commands.registerCommand("piDelegatorActivity.selectLog", async () => {
    const selection = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: "Monitor Pi Activity",
      filters: { "Pi activity log": ["jsonl"] },
    });
    const logPath = selection?.[0];
    if (!logPath) return;
    await vscode.workspace.getConfiguration("piDelegator.activity").update("logPath", logPath.fsPath, vscode.ConfigurationTarget.Workspace);
    provider.refresh();
  }));
  provider.refresh();
}

export function deactivate(): void {}
