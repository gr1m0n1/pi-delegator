#!/usr/bin/env node
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { syncPiInstallation } from "./sync_pi_installation.mjs";

const sourceDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const projectRoot = resolve(sourceDir, "..");
const runtime = resolve(process.env.PI_CODING_AGENT_DIR || `${projectRoot}/.pi-delegator`);
const required = ["LITELLM_BASE_URL", "LITELLM_API_KEY"];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(", ")}`);
  process.exit(2);
}

let baseUrl;
try {
  baseUrl = new URL(process.env.LITELLM_BASE_URL);
  if (!/^https?:$/.test(baseUrl.protocol)) throw new Error("unsupported protocol");
} catch {
  console.error("LITELLM_BASE_URL must be an absolute http(s) URL");
  process.exit(2);
}

const integer = (name, fallback, min, max) => {
  const raw = process.env[name] || String(fallback);
  if (!/^\d+$/.test(raw)) {
    console.error(`${name} must be an integer between ${min} and ${max}`);
    process.exit(2);
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    console.error(`${name} must be an integer between ${min} and ${max}`);
    process.exit(2);
  }
  return String(value);
};

async function atomicWrite(path, contents) {
  const temporary = `${path}.tmp-${process.pid}`;
  try {
    await writeFile(temporary, contents, { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

await syncPiInstallation();
await mkdir(runtime, { recursive: true, mode: 0o700 });
const modelTemplate = await readFile(`${sourceDir}/models.json.template`, "utf8");
const models = modelTemplate
  .replaceAll("__LITELLM_BASE_URL__", baseUrl.href.replace(/\/$/, ""))
  .replaceAll("$LITELLM_BASE_URL", baseUrl.href.replace(/\/$/, ""))
  .replaceAll("__LITELLM_API_KEY__", process.env.LITELLM_API_KEY)
  .replaceAll("$LITELLM_API_KEY", process.env.LITELLM_API_KEY);
JSON.parse(models);
if (/__[A-Z0-9_]+__/.test(models)) throw new Error("unresolved placeholder in models.json");
await atomicWrite(`${runtime}/models.json`, models);

const subagentTemplate = await readFile(`${sourceDir}/subagents.json.template`, "utf8");
const subagents = subagentTemplate
  .replaceAll("__PI_MAX_CONCURRENT__", integer("PI_MAX_CONCURRENT", 4, 1, 32))
  .replaceAll("__MAX_AGENT_TURNS__", integer("MAX_AGENT_TURNS", 20, 1, 200))
  .replaceAll("__MAX_SUBAGENT_DEPTH__", integer("MAX_SUBAGENT_DEPTH", 2, 1, 8));
JSON.parse(subagents);
if (/__[A-Z0-9_]+__/.test(subagents)) throw new Error("unresolved placeholder in subagents.json");
await atomicWrite(`${runtime}/subagents.json`, subagents);
await chmod(runtime, 0o700);
console.log(`Rendered Pi runtime configuration in ${runtime}`);
