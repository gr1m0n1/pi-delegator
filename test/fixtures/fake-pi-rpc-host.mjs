#!/usr/bin/env node
import readline from "node:readline";

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function reply(requestId, data) {
  const payload = Buffer.from(JSON.stringify({ requestId, success: true, data }), "utf8").toString("base64url");
  process.stdout.write(`${JSON.stringify({ type: "extension_ui_request", method: "notify", message: `PI_DELEGATOR_RPC:${payload}` })}\n`);
}

input.on("line", (line) => {
  const message = JSON.parse(line);
  const request = JSON.parse(Buffer.from(message.message.split(" ")[1], "base64url").toString("utf8"));
  process.stdout.write(`${JSON.stringify({ id: message.id, type: "response", command: "prompt", success: true })}\n`);
  if (request.method === "ping") {
    reply(request.requestId, { capabilities: { status: true, spawn: true, wait: true, stop: true, steer: true, resume: true } });
  } else if (request.method === "spawn") {
    reply(request.requestId, { id: "fixture-run", status: "running", model: request.params.model ?? null, thinking: request.params.thinking ?? null });
  } else if (request.method === "wait") {
    reply(request.requestId, { id: request.params.id, status: "completed", result: { kind: "text", text: "fixture complete" } });
  } else if (request.method === "status") {
    reply(request.requestId, { runs: [{ id: "fixture-run", status: "completed" }] });
  } else if (request.method === "stop") {
    reply(request.requestId, { id: request.params.id, status: "stopped" });
  } else if (request.method === "steer") {
    reply(request.requestId, { id: request.params.id, deliveryStatus: "delivered" });
  } else if (request.method === "resume") {
    reply(request.requestId, { id: `${request.params.id}-resume`, status: "running" });
  } else {
    reply(request.requestId, {});
  }
});