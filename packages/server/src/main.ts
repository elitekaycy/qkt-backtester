import { readdir } from "node:fs/promises";
import { scanCached } from "./data-scan.js";
import { scaffoldWorkspace } from "./scaffold.js";
import { existsSync } from "node:fs";
import { buildApp } from "./app.js";
import { registerBarsRoutes } from "./bars-routes.js";
import { registerCheckRoutes } from "./check-routes.js";
import { registerDataRoutes } from "./data-routes.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { Jobs, registerJobRoutes } from "./jobs.js";
import { registerLspBridge } from "./lsp-bridge.js";
import { registerRunRoutes } from "./run-routes.js";
import { Runner } from "./runner.js";
import { applySettings } from "./settings.js";
import { registerTerminal } from "./terminal.js";

export async function createStudio(cfg: ServerConfig) {
  await applySettings(cfg);
  const runner = new Runner(cfg);
  await runner.init();
  const jobs = new Jobs(cfg, runner);
  await jobs.init();
  const app = await buildApp(cfg, (a) => {
    registerRunRoutes(a, runner);
    registerBarsRoutes(a, cfg);
    registerCheckRoutes(a, cfg);
    registerJobRoutes(a, jobs);
    registerDataRoutes(a, cfg, runner, jobs);
    registerLspBridge(a, cfg);
    registerTerminal(a, cfg);
    a.get("/api/info", async () => ({
      workspace: cfg.workspace, dataRoot: cfg.dataRoot, terminal: cfg.terminal, tokenRequired: Boolean(cfg.token),
      hasConfig: existsSync(`${cfg.workspace}/qkt.config.yaml`), maxParallel: cfg.maxParallel,
    }));
  });
  app.addHook("onClose", async () => { await runner.close(); });
  return { app, runner, jobs };
}

/**
 * A brand-new workspace gets the whole project: config, instruments for the symbols in the data source, .env and a sample
 * strategy. "New" ignores what the studio itself creates (runs/, .qkt-studio/), so it must be judged before the runner starts
 * or a restart with an empty runs/ folder; anything of the user's means it is theirs and is left alone.
 */
export async function seedIfEmpty(cfg: ServerConfig): Promise<string[] | null> {
  const entries = (await readdir(cfg.workspace).catch(() => [] as string[])).filter((n) => n !== ".qkt-studio" && n !== "runs");
  if (entries.length) return null;
  const scan = await scanCached(cfg.dataRoot).catch(() => null);
  return (await scaffoldWorkspace(cfg.workspace, scan)).created;
}

async function main() {
  const cfg = loadConfig();
  const seeded = await seedIfEmpty(cfg);
  if (seeded) console.log(`qkt-backtester: seeded an empty workspace: ${seeded.join(", ")}`);
  const { app } = await createStudio(cfg);
  await app.listen({ port: cfg.port, host: cfg.host });
  console.log(`qkt-backtester listening on http://${cfg.host}:${cfg.port}  workspace=${cfg.workspace}  data=${cfg.dataRoot}  terminal=${cfg.terminal}${cfg.token ? "  (token required)" : ""}`);
  const stop = () => { void app.close().then(() => process.exit(0)); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
