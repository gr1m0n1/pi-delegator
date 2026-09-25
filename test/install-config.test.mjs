import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createConfig } from "../pi-delegator/mcp/server.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("installation refreshes examples and preserves active delegation and model configuration", async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), "pi-delegator-install-"));
  const runtime = join(targetRoot, ".pi-delegator");
  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: runtime,
    PI_MCP_ALLOWED_ROOT: targetRoot,
    LITELLM_BASE_URL: "http://127.0.0.1:4000/v1",
    LITELLM_API_KEY: "test-key",
  };
  const runScript = (name) => {
    const result = spawnSync(process.execPath, [join(projectRoot, `pi-delegator/scripts/${name}`)], {
      cwd: projectRoot,
      env,
      encoding: "utf8",
      timeout: 30000,
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  };

  try {
    runScript("sync_pi_installation.mjs");
    assert.equal(createConfig({ ...env, PI_MODELS_CATALOG_FILE: undefined }).modelCatalogFile, join(runtime, "models.example.json"));
    assert.equal(existsSync(join(runtime, "models.json")), false);
    runScript("render_pi_config.mjs");

    const delegationExample = await readFile(join(runtime, "delegation-sets.example.json"), "utf8");
    const modelsExample = await readFile(join(runtime, "models.example.json"), "utf8");
    assert.equal(delegationExample, await readFile(join(projectRoot, "pi-delegator/delegation-sets.json"), "utf8"));
    assert.equal(modelsExample, await readFile(join(projectRoot, "pi-delegator/models.json.template"), "utf8"));
    assert.equal(await readFile(join(runtime, "delegation-sets.json"), "utf8"), delegationExample);
    assert.equal(JSON.parse(await readFile(join(runtime, "models.json"), "utf8")).providers.litellm.baseUrl, env.LITELLM_BASE_URL);
    assert.equal(createConfig({ ...env, PI_MODELS_CATALOG_FILE: undefined }).modelCatalogFile, join(runtime, "models.json"));

    const customDelegation = '{"version":1,"sets":{"custom":{"delegation_percentage":42,"roles":{}}}}\n';
    const customModels = '{"providers":{"litellm":{"models":[{"id":"custom"}]}}}\n';
    await writeFile(join(runtime, "delegation-sets.json"), customDelegation);
    await writeFile(join(runtime, "models.json"), customModels);
    await writeFile(join(runtime, "delegation-sets.example.json"), "stale example");
    await writeFile(join(runtime, "models.example.json"), "stale example");

    runScript("render_pi_config.mjs");

    assert.equal(await readFile(join(runtime, "delegation-sets.json"), "utf8"), customDelegation);
    assert.equal(await readFile(join(runtime, "models.json"), "utf8"), customModels);
    assert.equal(await readFile(join(runtime, "delegation-sets.example.json"), "utf8"), delegationExample);
    assert.equal(await readFile(join(runtime, "models.example.json"), "utf8"), modelsExample);
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
  }
});
