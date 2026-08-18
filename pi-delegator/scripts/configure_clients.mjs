#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const projectRoot = resolve(sourceDir, "..");
const serverCommand = "./.pi-delegator/bin/pi-mcp";

function usage() {
  console.error("Usage: node configure_clients.mjs [--copilot] [--codex] [--claude] [--all-clients]");
  process.exit(2);
}

const flags = new Set(process.argv.slice(2));
const valid = new Set(["--copilot", "--codex", "--claude", "--all-clients"]);
if ([...flags].some((flag) => !valid.has(flag))) usage();
if (flags.size === 0) process.exit(0);
if (flags.has("--all-clients")) {
  flags.add("--copilot");
  flags.add("--codex");
  flags.add("--claude");
}

async function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function configureCopilot() {
  const path = resolve(projectRoot, ".vscode/mcp.json");
  const document = await readJson(path, {});
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  const servers = document.servers && typeof document.servers === "object" && !Array.isArray(document.servers)
    ? document.servers
    : {};
  servers["pi-delegator"] = {
    command: serverCommand,
    args: [],
  };
  document.servers = servers;
  await writeJson(path, document);
  console.log(`Configured GitHub Copilot MCP in ${path}`);
}

async function configureClaude() {
  const path = resolve(projectRoot, ".mcp.json");
  const document = await readJson(path, {});
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  const mcpServers = document.mcpServers && typeof document.mcpServers === "object" && !Array.isArray(document.mcpServers)
    ? document.mcpServers
    : {};
  mcpServers["pi-delegator"] = {
    type: "stdio",
    command: serverCommand,
    args: [],
  };
  document.mcpServers = mcpServers;
  await writeJson(path, document);
  console.log(`Configured Claude Code MCP in ${path}`);
}

function renderCodexBlock() {
  return [
    "# BEGIN pi-delegator managed MCP",
    '[mcp_servers."pi-delegator"]',
    `command = "${serverCommand}"`,
    "args = []",
    "# END pi-delegator managed MCP",
  ].join("\n");
}

async function configureCodex() {
  const path = resolve(projectRoot, ".codex/config.toml");
  await mkdir(dirname(path), { recursive: true });
  const begin = "# BEGIN pi-delegator managed MCP";
  const end = "# END pi-delegator managed MCP";
  const block = renderCodexBlock();
  let contents = existsSync(path) ? await readFile(path, "utf8") : "";
  if (contents.includes('[mcp_servers."pi-delegator"]') && !contents.includes(begin)) {
    throw new Error(`${path} already defines mcp_servers."pi-delegator" outside the managed block`);
  }
  const managed = new RegExp(`${begin}[\\s\\S]*?${end}\\n?`, "m");
  contents = contents.replace(managed, "").trimEnd();
  const next = contents ? `${contents}\n\n${block}\n` : `${block}\n`;
  await writeFile(path, next, "utf8");
  console.log(`Configured Codex MCP in ${path}`);
}

if (flags.has("--copilot")) await configureCopilot();
if (flags.has("--codex")) await configureCodex();
if (flags.has("--claude")) await configureClaude();
