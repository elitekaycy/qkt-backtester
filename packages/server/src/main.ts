import { existsSync } from "node:fs";
import { buildApp } from "./app.js";
import { registerBarsRoutes } from "./bars-routes.js";
import { registerCheckRoutes } from "./check-routes.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { Jobs, registerJobRoutes } from "./jobs.js";
import { registerLspBridge } from "./lsp-bridge.js";
import { registerRunRoutes } from "./run-routes.js";
import { Runner } from "./runner.js";
import { registerTerminal } from "./terminal.js";

export async function createStudio(cfg: ServerConfig) {
  const runner = new Runner(cfg);
  await runner.init();
  const jobs = new Jobs(cfg, runner);
  await jobs.init();
  const app = await buildApp(cfg, (a) => {
    registerRunRoutes(a, runner);
    registerBarsRoutes(a, cfg);
    registerCheckRoutes(a, cfg);
    registerJobRoutes(a, jobs);
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

async function main() {
  const cfg = loadConfig();
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
