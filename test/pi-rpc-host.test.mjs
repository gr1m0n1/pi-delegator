import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PiRpcHost } from "../pi-delegator/mcp/pi-rpc-host.mjs";

function tempDir() {
  return mkdirSync(join(tmpdir(), `pi-rpc-host-test-${process.pid}-${Math.random().toString(16).slice(2)}`), { recursive: true });
}

function fakeHostScript(directory, behavior = "normal") {
  const script = join(directory, `fake-host-${behavior}.mjs`);
  writeFileSync(script, `
import readline from "node:readline";
const behavior = ${JSON.stringify(behavior)};
let count = 0;
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function commandReply(id, success = true, error) { process.stdout.write(JSON.stringify({ id, type: "response", command: "prompt", success, error }) + "\\n"); }
function rpcReply(requestId, data, error) {
  const payload = Buffer.from(JSON.stringify({ requestId, success: !error, data, error }), "utf8").toString("base64url");
  process.stdout.write(JSON.stringify({ type: "extension_ui_request", method: "notify", message: "PI_DELEGATOR_RPC:" + payload }) + "\\n");
}
input.on("line", (line) => {
  const message = JSON.parse(line);
  const encoded = message.message.split(" ")[1];
  const request = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  count += 1;
  commandReply(message.id);
  if (behavior === "bad-handshake" && request.method === "ping") rpcReply(request.requestId, undefined, "no handshake");
  else if (behavior === "crash-after-ping" && count > 1) process.exit(19);
  else if (request.method === "ping") rpcReply(request.requestId, { capabilities: { status: true, spawn: behavior === "disabled-capability" ? false : true, wait: true, stop: true, steer: true, resume: true } });
  else if (request.method === "status") rpcReply(request.requestId, { ok: true, state: "running" });
  else if (request.method === "spawn") rpcReply(request.requestId, { id: "run-1", status: "running" });
  else if (request.method === "wait") rpcReply(request.requestId, { id: request.params.id, status: "completed", result: { kind: "text", text: "done" } });
  else rpcReply(request.requestId, { ok: true, method: request.method, params: request.params });
});
`);
  return script;
}

test("PiRpcHost starts lazily and reuses one process", async () => {
  const directory = tempDir();
  const host = new PiRpcHost({ command: process.execPath, args: [fakeHostScript(directory)], cwd: directory, sessionRoot: join(directory, "sessions") });
  assert.equal(host.getState(), "stopped");
  assert.deepEqual(await host.request("status"), { ok: true, state: "running" });
  assert.equal(host.getState(), "ready");
  assert.deepEqual(await host.request("wait", { id: "run-1" }), { id: "run-1", status: "completed", result: { kind: "text", text: "done" } });
  await host.stop();
  assert.equal(host.getState(), "stopped");
});

test("PiRpcHost rejects invalid handshakes", async () => {
  const directory = tempDir();
  const host = new PiRpcHost({ command: process.execPath, args: [fakeHostScript(directory, "bad-handshake")], cwd: directory, handshakeTimeoutMs: 500 });
  await assert.rejects(() => host.request("status"), /no handshake|exited/);
  assert.equal(host.getState(), "failed");
});

test("PiRpcHost rejects explicitly disabled required capabilities", async () => {
  const directory = tempDir();
  const host = new PiRpcHost({ command: process.execPath, args: [fakeHostScript(directory, "disabled-capability")], cwd: directory });
  await assert.rejects(() => host.request("spawn", {}, { restartOnFailure: false }), /missing required capabilities: spawn/);
});

test("PiRpcHost retries idempotent status after a crash", async () => {
  const directory = tempDir();
  const first = fakeHostScript(directory, "crash-after-ping");
  const second = fakeHostScript(directory, "normal");
  let command = first;
  const host = new PiRpcHost({ command: process.execPath, args: [], cwd: directory });
  host.args = [command];
  await assert.rejects(() => host.request("spawn", { task: "work" }, { restartOnFailure: false }), /exited/);
  command = second;
  host.args = [command];
  assert.deepEqual(await host.request("status"), { ok: true, state: "running" });
  await host.stop();
});