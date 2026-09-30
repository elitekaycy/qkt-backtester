import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerConfig } from "../src/config.js";

/** The local qkt data store the existing api tests use; tests that need real bars skip without it. */
export const realData = path.join(os.homedir(), ".qkt", "data");
export const haveData = existsSync(path.join(realData, "bars", "BACKTEST", "XAUUSD", "15m", "2024-10-30.bin"));
/** The qkt these tests run: `QKT_BIN`, else `qkt` on PATH. It must be one that prints its vocabulary (0.54+). */
export const qktBin = process.env.QKT_BIN || "qkt";
export const testConfig = (workspace: string, extra: Partial<ServerConfig> = {}): ServerConfig =>
  ({ workspace, dataRoot: realData, qktBin, port: 0, host: "127.0.0.1", maxParallel: 4, terminal: "restricted", ...extra });
/** A qkt binary to run: tests that parse or run DSL skip without it (the CI unit job has none). */
export const haveQkt = (() => { try { execFileSync(qktBin, ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();

/** The stand-in `claude` CLI (replays scenarios, calls the real /api/mcp); see test/fixtures/fake-claude. */
export const fakeClaude = fileURLToPath(new URL("./fixtures/fake-claude/fake-claude.mjs", import.meta.url));
