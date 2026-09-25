import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";

const child = spawn(process.execPath, ["pi-delegator/mcp/server.mjs"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PI_FORCE_CONTEXT_MODE: "0",
    PI_REPOVERITY_ENABLED: "0",
    PI_MCP_PI_RPC: process.env.PI_MCP_PI_RPC || process.execPath,
    PI_MCP_RPC_ARGS: process.env.PI_MCP_RPC_ARGS || "test/fixtures/fake-pi-rpc-host.mjs",
  },
  stdio: ["pipe", "pipe", "pipe"],
});

const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
const responses = [];
lines.on("line", (line) => responses.push(JSON.parse(line)));

function send(id, method, params = {}) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
}

send(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
send(2, "tools/list");
send(3, "tools/call", { name: "pi_run_status", arguments: {} });

const deadline = Date.now() + 3000;
while (responses.length < 3 && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

child.kill("SIGTERM");
await once(child, "close");

assert.equal(responses[0]?.result?.serverInfo?.name, "pi-delegator");
assert.ok(responses[1]?.result?.tools?.some((tool) => tool.name === "pi_run_wait"));
assert.match(responses[2]?.result?.content?.[0]?.text ?? "", /fixture-run/);