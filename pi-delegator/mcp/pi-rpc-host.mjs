import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 7_200_000;
const DEFAULT_START_QUEUE_LIMIT = 100;
const REQUIRED_CAPABILITIES = ["status", "spawn", "steer", "stop", "resume"];

export class PiRpcHost {
  constructor(options) {
    this.command = options.command;
    this.args = options.args ?? [];
    this.cwd = options.cwd;
    this.env = options.env ?? {};
    this.sessionRoot = options.sessionRoot;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.startQueueLimit = options.startQueueLimit ?? DEFAULT_START_QUEUE_LIMIT;
    this.state = "stopped";
    this.child = null;
    this.buffer = "";
    this.requestId = 0;
    this.pending = new Map();
    this.starting = null;
    this.queuedDuringStart = 0;
    this.capabilities = null;
    this.methods = new Set();
  }

  getState() {
    return this.state;
  }

  async request(method, params = {}, options = {}) {
    const idempotent = method === "ping" || method === "status" || options.idempotent === true;
    try {
      await this.ensureStarted();
      return await this.send(method, params, options.timeoutMs ?? this.requestTimeoutMs);
    } catch (error) {
      if (!idempotent || options.restartOnFailure === false) throw error;
      await this.restart();
      return await this.send(method, params, options.timeoutMs ?? this.requestTimeoutMs);
    }
  }

  async stop() {
    if (this.state === "stopped") return;
    this.state = "stopping";
    const child = this.child;
    this.child = null;
    this.starting = null;
    this.rejectAll(new Error("Pi RPC host stopped"));
    if (child) {
      try {
        child.kill("SIGTERM");
      } catch {
        // best effort
      }
    }
    this.state = "stopped";
  }

  async restart() {
    await this.stop();
    await this.ensureStarted();
  }

  async ensureStarted() {
    if (this.state === "ready" && this.child) return;
    if (this.state === "starting" && this.starting) {
      this.queuedDuringStart += 1;
      if (this.queuedDuringStart > this.startQueueLimit) throw new Error("Pi RPC host start queue limit exceeded");
      return this.starting;
    }
    if (this.state === "stopping") throw new Error("Pi RPC host is stopping");
    this.state = "starting";
    this.queuedDuringStart = 0;
    this.starting = this.startProcess();
    return this.starting;
  }

  async startProcess() {
    if (!this.command) throw new Error("Pi RPC host command is not configured");
    if (this.sessionRoot) mkdirSync(this.sessionRoot, { recursive: true, mode: 0o700 });
    const child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.buffer = "";
    child.stdout.on("data", (chunk) => this.onData(chunk));
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8").trim();
      if (text) this.lastStderr = text;
    });
    child.on("error", (error) => this.onExit(error));
    child.on("exit", (code, signal) => this.onExit(new Error(`Pi RPC host exited: code=${code ?? "null"} signal=${signal ?? "none"}`)));
    try {
      const ping = await this.send("ping", {}, this.handshakeTimeoutMs);
      this.capabilities = ping && typeof ping === "object" ? ping.capabilities ?? null : null;
      this.methods = new Set(Array.isArray(ping?.methods) ? ping.methods : []);
      const missing = REQUIRED_CAPABILITIES.filter((capability) => !this.hasCapability(capability));
      if (missing.length) throw new Error(`Pi RPC host is missing required capabilities: ${missing.join(", ")}`);
      this.state = "ready";
    } catch (error) {
      this.state = "failed";
      try {
        child.kill("SIGTERM");
      } catch {
        // best effort
      }
      throw error;
    } finally {
      this.starting = null;
      this.queuedDuringStart = 0;
    }
  }

  send(method, params, timeoutMs) {
    if (!this.child || !this.child.stdin.writable) throw new Error("Pi RPC host is not running");
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`Pi RPC request timed out: ${method}`));
          }, timeoutMs)
        : null;
      timer?.unref();
      this.pending.set(id, { resolve, reject, timer, method });
      const request = Buffer.from(JSON.stringify({ requestId: String(id), method, params }), "utf8").toString("base64url");
      this.child.stdin.write(`${JSON.stringify({ id: String(id), type: "prompt", message: `/pi-delegator-rpc ${request}` })}\n`, (error) => {
        if (!error) return;
        this.rejectOne(id, error);
      });
    });
  }

  onData(chunk) {
    this.buffer += chunk.toString("utf8");
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      this.handleLine(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  handleLine(line) {
    if (!line) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;
    if (message.type === "extension_ui_request" && message.method === "notify" && typeof message.message === "string" && message.message.startsWith("PI_DELEGATOR_RPC:")) {
      this.handleRpcNotification(message.message.slice("PI_DELEGATOR_RPC:".length));
      return;
    }
    const id = Number.parseInt(String(message.id ?? ""), 10);
    if (!Number.isSafeInteger(id)) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    if (message.type === "response" && message.command === "prompt" && !message.success) {
      this.rejectOne(id, new Error(message.error || `Pi RPC command failed: ${pending.method}`));
    }
  }

  handleRpcNotification(encoded) {
    let payload;
    try {
      payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    } catch {
      return;
    }
    const id = Number.parseInt(String(payload.requestId ?? ""), 10);
    if (!Number.isSafeInteger(id)) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    if (!payload.success) pending.reject(new Error(payload.error || `Pi RPC request failed: ${pending.method}`));
    else pending.resolve(payload.data ?? {});
  }

  hasCapability(name) {
    if (this.methods.has(name)) return true;
    if (!this.capabilities || typeof this.capabilities !== "object") return false;
    if (name === "spawn" && this.capabilities.asyncSpawn === true) return true;
    return this.capabilities[name] === true;
  }

  onExit(error) {
    if (this.child) this.child = null;
    if (this.state !== "stopping") this.state = "failed";
    this.rejectAll(error instanceof Error ? error : new Error(String(error)));
  }

  rejectOne(id, error) {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    pending.reject(error);
  }

  rejectAll(error) {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}