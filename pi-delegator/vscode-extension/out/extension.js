"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const activeSessionStaleMs = 90_000;
class ActivityItem extends vscode.TreeItem {
    constructor(label, description, collapsibleState = vscode.TreeItemCollapsibleState.None) {
        super(label, collapsibleState);
        this.description = description;
    }
}
class ActivityProvider {
    changed = new vscode.EventEmitter();
    onDidChangeTreeData = this.changed.event;
    snapshot = { logPath: undefined, runtimeRoot: undefined, active: [], recent: [] };
    refreshTimer;
    refresh() {
        this.snapshot = this.readSnapshot();
        this.changed.fire(undefined);
    }
    scheduleRefresh() {
        if (this.refreshTimer)
            clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => this.refresh(), 100);
    }
    getTreeItem(item) {
        return item;
    }
    getChildren(item) {
        if (!item) {
            if (!this.snapshot.logPath)
                return [new ActivityItem("No Pi runtime log found")];
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
            const activeTasks = new Set(this.snapshot.active
                .map((entry) => activityKey(entry))
                .filter(Boolean));
            const terminalStatuses = new Map();
            for (const entry of this.snapshot.recent) {
                if (!isTerminalEvent(entry))
                    continue;
                const status = entry.status || (entry.event === "subagent_async_completed" ? "completed" : "interrupted");
                for (const key of terminalKeys(entry)) {
                    if (key)
                        terminalStatuses.set(key, status);
                }
            }
            return this.snapshot.recent.slice().reverse().map((entry) => {
                const keys = terminalKeys(entry);
                const key = activityKey(entry);
                const started = entry.event === "pixel_agent_session_started" || entry.event === "subagent_async_started";
                const running = started
                    && Boolean((entry.event === "subagent_async_started"
                        ? entry.subagent_id && activeSubagents.has(entry.subagent_id)
                        : entry.session_id ? activeSessions.has(entry.session_id) : key && activeTasks.has(key))
                        && !keys.some((key) => terminalStatuses.has(key)));
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
    logUri() {
        return this.snapshot.logPath;
    }
    agentOutputUri(agent) {
        return this.snapshot.runtimeRoot && agent
            ? vscode.Uri.joinPath(this.snapshot.runtimeRoot, "logs", "agents", agent, "stdout.log")
            : undefined;
    }
    agentItem(entry, status) {
        const agent = entry.agent || "Pi";
        const task = entry.task_id || "unassigned";
        const item = new ActivityItem(agent, `${status}  ${task}`);
        item.contextValue = "piDelegator.agent";
        item.iconPath = new vscode.ThemeIcon(status === "running" || status === "started" ? "sync~spin" : status === "completed" ? "pass" : "circle-outline");
        item.command = { command: "piDelegatorActivity.openAgentOutput", title: "Open Pi Agent Output", arguments: [item] };
        return item;
    }
    readSnapshot() {
        const logPath = discoveredLogPath();
        if (!logPath)
            return { logPath: undefined, runtimeRoot: undefined, active: [], recent: [] };
        const runtimeRoot = vscode.Uri.file((0, node_path_1.dirname)((0, node_path_1.dirname)(logPath.fsPath)));
        let entries;
        try {
            entries = (0, node_fs_1.readFileSync)(logPath.fsPath, "utf8")
                .split(/\r?\n/)
                .flatMap((line) => {
                try {
                    const entry = JSON.parse(line);
                    return entry && typeof entry === "object" ? [entry] : [];
                }
                catch {
                    return [];
                }
            });
        }
        catch {
            return { logPath, runtimeRoot, active: [], recent: [] };
        }
        entries = entries.flatMap((entry) => {
            if (entry.event !== "subagent_async_started")
                return [entry];
            const terminal = nativeRunTerminal(entry);
            return terminal ? [entry, { ...entry, event: "subagent_async_completed", ...terminal }] : [entry];
        });
        const activeBySession = new Map();
        for (const entry of entries) {
            if (entry.event === "pixel_agent_session_started" && entry.session_id)
                activeBySession.set(entry.session_id, entry);
            if (entry.event === "subagent_async_started" && entry.subagent_id)
                activeBySession.set(`async:${entry.subagent_id}`, entry);
            else if (entry.event === "subagent_async_completed" && entry.subagent_id)
                activeBySession.delete(`async:${entry.subagent_id}`);
            else if (isTerminalEvent(entry)) {
                if (entry.session_id)
                    activeBySession.delete(entry.session_id);
                if (entry.subagent_id)
                    activeBySession.delete(`async:${entry.subagent_id}`);
            }
        }
        let activeIds;
        let stateIsStale = true;
        try {
            const statePath = vscode.Uri.joinPath(runtimeRoot, "logs", "pixel-agents-active-sessions.json");
            const state = JSON.parse((0, node_fs_1.readFileSync)(statePath.fsPath, "utf8"));
            activeIds = new Set(Array.isArray(state.active_sessions) ? state.active_sessions : []);
            const updatedAt = Date.parse(String(state.updated_at ?? ""));
            stateIsStale = !Number.isFinite(updatedAt) || Date.now() - updatedAt > activeSessionStaleMs;
        }
        catch {
            // Older runtimes do not yet persist an authoritative active-session file.
        }
        for (const [key, entry] of [...activeBySession.entries()]) {
            const observed = key.startsWith("async:")
                ? nativeRunState(entry) === "running" || isRecentEvent(entry)
                : activeIds && !stateIsStale ? activeIds.has(key) : isRecentEvent(entry);
            if (!observed)
                activeBySession.delete(key);
        }
        return { logPath, runtimeRoot, active: [...activeBySession.values()], recent: entries.slice(-50) };
    }
}
function activityKey(entry) {
    return entry.task_id && entry.agent ? `${entry.task_id}:${entry.agent}` : undefined;
}
function nativeRunState(entry) {
    const runDir = entry.async_dir;
    if (!runDir || !entry.subagent_id || !(0, node_path_1.isAbsolute)(runDir)
        || (0, node_path_1.basename)(runDir) !== entry.subagent_id || (0, node_path_1.basename)((0, node_path_1.dirname)(runDir)) !== "async-subagent-runs")
        return undefined;
    try {
        const state = JSON.parse((0, node_fs_1.readFileSync)((0, node_path_1.resolve)(runDir, "status.json"), "utf8"));
        return typeof state.state === "string" ? state.state : undefined;
    }
    catch {
        return undefined;
    }
}
function nativeRunTerminal(entry) {
    const state = nativeRunState(entry);
    if (!state || state === "running" || state === "queued")
        return undefined;
    let status = state === "partial" ? "partial" : "blocked";
    if (state === "complete") {
        status = "partial";
        try {
            const outputPath = (0, node_path_1.resolve)(entry.async_dir, "output-0.log");
            const output = (0, node_fs_1.statSync)(outputPath).size <= 1_000_000 ? (0, node_fs_1.readFileSync)(outputPath, "utf8") : "";
            const matches = [...output.matchAll(/^STATUS:\s*(COMPLETED|PARTIAL|BLOCKED)\s*$/gim)];
            if (matches.length)
                status = matches.at(-1)[1].toLowerCase();
        }
        catch {
            // A finished process without a readable task result remains partial.
        }
    }
    return { status, timestamp: new Date().toISOString() };
}
function terminalKeys(entry) {
    if (entry.event === "subagent_async_started" || entry.event === "subagent_async_completed") {
        return entry.subagent_id ? [`async:${entry.subagent_id}`] : [];
    }
    const key = entry.session_id || activityKey(entry);
    return key ? [key] : [];
}
function isRecentEvent(entry) {
    const timestamp = Date.parse(String(entry.timestamp ?? ""));
    return Number.isFinite(timestamp) && Date.now() - timestamp <= activeSessionStaleMs;
}
function isTerminalEvent(entry) {
    return entry.event === "subagent_interrupted"
        || entry.event === "subagent_async_completed"
        || !entry.event && ["completed", "partial", "failed", "blocked", "cancelled", "aborted", "stopped"].includes(String(entry.status).toLowerCase());
}
function configuredLogPath() {
    const configured = vscode.workspace.getConfiguration("piDelegator.activity").get("logPath")?.trim();
    if (configured)
        return vscode.Uri.file(configured);
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri;
    return workspace ? vscode.Uri.joinPath(workspace, ".pi-delegator", "logs", "pi-agents.jsonl") : undefined;
}
function discoveredLogPath() {
    const configured = vscode.workspace.getConfiguration("piDelegator.activity").get("logPath")?.trim();
    if (configured)
        return vscode.Uri.file(configured);
    for (const workspace of vscode.workspace.workspaceFolders ?? []) {
        const localLog = vscode.Uri.joinPath(workspace.uri, ".pi-delegator", "logs", "pi-agents.jsonl");
        if ((0, node_fs_1.existsSync)(localLog.fsPath))
            return localLog;
        const runtimeMarker = vscode.Uri.joinPath(workspace.uri, ".pi-delegator", ".pixel-agents-workspace-root");
        try {
            const targetRoot = (0, node_fs_1.readFileSync)(runtimeMarker.fsPath, "utf8").trim();
            const targetLog = vscode.Uri.file((0, node_path_1.resolve)(targetRoot, ".pi-delegator", "logs", "pi-agents.jsonl"));
            if ((0, node_fs_1.existsSync)(targetLog.fsPath))
                return targetLog;
        }
        catch {
            // This workspace does not contain a pi-delegator managed external runtime.
        }
    }
    return configuredLogPath();
}
function activate(context) {
    const provider = new ActivityProvider();
    const view = vscode.window.createTreeView("piDelegator.activity", { treeDataProvider: provider, showCollapseAll: true });
    const refresh = () => provider.scheduleRefresh();
    const watchLogs = (vscode.workspace.workspaceFolders ?? []).map((workspace) => vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspace.uri, ".pi-delegator/logs/*")));
    for (const watcher of watchLogs) {
        context.subscriptions.push(watcher, watcher.onDidChange(refresh), watcher.onDidCreate(refresh), watcher.onDidDelete(refresh));
    }
    const configuredLog = vscode.workspace.getConfiguration("piDelegator.activity").get("logPath")?.trim();
    if (configuredLog) {
        const watcher = vscode.workspace.createFileSystemWatcher(configuredLog);
        context.subscriptions.push(watcher, watcher.onDidChange(refresh), watcher.onDidCreate(refresh), watcher.onDidDelete(refresh));
    }
    const poll = setInterval(refresh, 5_000);
    context.subscriptions.push(view, { dispose: () => clearInterval(poll) });
    context.subscriptions.push(vscode.commands.registerCommand("piDelegatorActivity.refresh", () => provider.refresh()));
    context.subscriptions.push(vscode.commands.registerCommand("piDelegatorActivity.openLog", async () => {
        const uri = provider.logUri() || configuredLogPath();
        if (uri)
            await vscode.window.showTextDocument(uri, { preview: false });
    }));
    context.subscriptions.push(vscode.commands.registerCommand("piDelegatorActivity.openAgentOutput", async (item) => {
        const agent = typeof item?.label === "string" ? item.label : "";
        const uri = provider.agentOutputUri(agent);
        if (uri)
            await vscode.window.showTextDocument(uri, { preview: false });
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
        if (!logPath)
            return;
        await vscode.workspace.getConfiguration("piDelegator.activity").update("logPath", logPath.fsPath, vscode.ConfigurationTarget.Workspace);
        provider.refresh();
    }));
    provider.refresh();
}
function deactivate() { }
//# sourceMappingURL=extension.js.map