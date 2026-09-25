// Probe: run qkt as a child in its own process group; stream + classify output live; cancel mid-run.
// Usage: node probe-runner.mjs <workspaceDir>
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";

const cwd = process.argv[2];
const runDir = "/tmp/probe_cancel_run";
fs.rmSync(runDir, { recursive: true, force: true });
const args = ["backtest", "strategies/xau-ema.qkt", "--config", "qkt.config.yaml", "--from", "2026-02-02", "--to", "2026-03-31",
  "--no-fetch", "--allow-incomplete", "--report-dir", runDir];
const t0 = performance.now();
const child = spawn("qkt", args, { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
const ev = { fills: 0, orders: 0, logs: 0, warn: 0, coverage: null, first: null, firstFill: null };
const line = (s) => {
  if (ev.first === null) ev.first = performance.now() - t0;
  if (/order filled/.test(s)) { ev.fills++; if (ev.firstFill === null) ev.firstFill = performance.now() - t0; }
  else if (/submit /.test(s)) ev.orders++;
  else if (/tick coverage/.test(s)) ev.coverage = s.trim();
  else if (/WARNING/.test(s)) ev.warn++;
  else ev.logs++;
};
for (const st of [child.stdout, child.stderr]) {
  let rest = "";
  st.on("data", (d) => { const parts = (rest + d).split("\n"); rest = parts.pop(); parts.forEach(line); });
}
const exited = new Promise((r) => child.on("exit", (c, s) => r({ code: c, signal: s })));
await new Promise((r) => setTimeout(r, 9000));
console.log(`t=${((performance.now() - t0) / 1000).toFixed(1)}s live: first-output=${ev.first?.toFixed(0)}ms first-fill=${ev.firstFill?.toFixed(0)}ms fills=${ev.fills} orders=${ev.orders} coverage="${ev.coverage}"`);
const k0 = performance.now();
process.kill(-child.pid, "SIGTERM");
const r = await Promise.race([exited, new Promise((res) => setTimeout(() => res("timeout"), 5000))]);
console.log(`SIGTERM to process group -> ${JSON.stringify(r)} after ${(performance.now() - k0).toFixed(0)}ms`);
if (r === "timeout") { process.kill(-child.pid, "SIGKILL"); console.log("needed SIGKILL"); }
console.log("partial run dir exists:", fs.existsSync(runDir), fs.existsSync(runDir) ? fs.readdirSync(runDir) : "");
const left = execSync("pgrep -f 'probe_cancel_run' || true").toString().trim().split("\n").filter((p) => p && Number(p) !== process.pid);
console.log("leftover qkt processes:", left.length ? left.join(",") : "none");
