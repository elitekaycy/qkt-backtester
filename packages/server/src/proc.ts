import { spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";

export interface SpawnOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Kill the whole process group after this long. */
  timeoutMs?: number;
  /** Mirror raw output to these files (created by the caller's directory). */
  logFiles?: { out: string; err: string };
  /** Written to the child's stdin, which is then closed; without it stdin is ignored. */
  input?: string;
  onLine?: (line: string, stream: "out" | "err") => void;
}

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  /** Bounded copies of the output for error parsing. */
  stdout: string;
  stderr: string;
}

export interface ProcHandle {
  pid: number;
  exited: Promise<ExitInfo>;
  /** SIGTERM the process group, escalate to SIGKILL after graceMs. Resolves once the child is gone. */
  kill(graceMs?: number): Promise<void>;
}

const KEEP_BYTES = 1024 * 1024;

function bounded(prev: string, chunk: string): string {
  const next = prev + chunk;
  return next.length > KEEP_BYTES ? next.slice(next.length - KEEP_BYTES) : next;
}

/**
 * Start a child in its own process group (so a JVM and anything it forked die together) and stream its
 * output line by line. Only ever signals the group it created.
 */
export function spawnGroup(bin: string, args: string[], opts: SpawnOptions): ProcHandle {
  const child = spawn(bin, args, { cwd: opts.cwd, env: opts.env ?? process.env, detached: true, stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
  // a child that exits before reading its input must not crash the studio with EPIPE
  if (opts.input !== undefined) { child.stdin!.on("error", () => undefined); child.stdin!.end(opts.input); }
  const files: { out?: WriteStream; err?: WriteStream } = {};
  if (opts.logFiles) { files.out = createWriteStream(opts.logFiles.out); files.err = createWriteStream(opts.logFiles.err); }

  let stdout = "", stderr = "", timedOut = false, done = false;
  const rest = { out: "", err: "" };
  const feed = (stream: "out" | "err", chunk: Buffer) => {
    const s = chunk.toString("utf8");
    files[stream]?.write(chunk);
    if (stream === "out") stdout = bounded(stdout, s); else stderr = bounded(stderr, s);
    if (!opts.onLine) return;
    const parts = (rest[stream] + s).split("\n");
    rest[stream] = parts.pop() ?? "";
    for (const p of parts) opts.onLine(p.replace(/\r$/, ""), stream);
  };
  child.stdout!.on("data", (c: Buffer) => feed("out", c));
  child.stderr!.on("data", (c: Buffer) => feed("err", c));

  const exited = new Promise<ExitInfo>((resolve) => {
    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true; done = true;
      if (timer) clearTimeout(timer);
      for (const k of ["out", "err"] as const) if (rest[k] && opts.onLine) opts.onLine(rest[k], k);
      files.out?.end(); files.err?.end();
      resolve({ code, signal, timedOut, stdout, stderr });
    };
    child.on("error", (e) => { stderr = bounded(stderr, `spawn error: ${e.message}\n`); finish(127, null); });
    child.on("close", (code, signal) => finish(code, signal));
  });

  const pid = child.pid ?? -1;
  const killGroup = (sig: NodeJS.Signals) => { try { process.kill(-pid, sig); } catch { /* already gone */ } };
  const kill = async (graceMs = 3000) => {
    if (done || pid < 0) return;
    killGroup("SIGTERM");
    const t = setTimeout(() => killGroup("SIGKILL"), graceMs);
    try { await exited; } finally { clearTimeout(t); }
  };
  const timer: NodeJS.Timeout | null = opts.timeoutMs ? setTimeout(() => { timedOut = true; void kill(2000); }, opts.timeoutMs) : null;
  return { pid, exited, kill };
}

/** Run a short command to completion. */
export async function execQkt(bin: string, args: string[], opts: Omit<SpawnOptions, "onLine" | "logFiles">): Promise<ExitInfo> {
  return spawnGroup(bin, args, opts).exited;
}
