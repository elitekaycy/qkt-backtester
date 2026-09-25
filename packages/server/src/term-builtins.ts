import { promises as fs } from "node:fs";
import path from "node:path";
import { JailError, resolveInJail, toRel } from "./jail.js";

/** Shell-like conveniences for the restricted terminal (no shell is involved): every path stays inside the workspace. */
export const BUILTINS = new Set(["help", "pwd", "ls", "ll", "cd", "cat", "head", "tail", "echo", "tree"]);

export const HELP = [
  "Restricted terminal: qkt commands plus a few file helpers, all confined to the workspace.",
  "  qkt <parse|backtest|sweep|walkforward|data|fetch|experiment|version> ...",
  "  ls [-l] [path]   list files      cd [path]   change folder     pwd",
  "  cat|head|tail <file>             tree [path] outline           echo ...",
  "  clear            clear the screen (or Ctrl+L)",
].join("\r\n");

const fmtSize = (n: number) => (n < 1024 ? `${n}` : n < 1048576 ? `${(n / 1024).toFixed(1)}K` : `${(n / 1048576).toFixed(1)}M`);
const HIDDEN = new Set([".qkt-studio", ".git", "node_modules"]);

export interface TermSession { cwd: string /* relative to the workspace, "" = root */ }

async function target(ws: string, sess: TermSession, arg: string | undefined): Promise<string> {
  const rel = path.posix.normalize(path.posix.join(sess.cwd || ".", arg ?? "."));
  return resolveInJail(ws, rel === "." ? "" : rel);
}

/** Runs one builtin. Returns the text to print (CRLF line ends) and an exit code. */
export async function runBuiltin(words: string[], ws: string, sess: TermSession): Promise<{ out: string; code: number }> {
  const [cmd, ...args] = words;
  try {
    switch (cmd) {
      case "help": return { out: HELP, code: 0 };
      case "pwd": return { out: "/" + sess.cwd, code: 0 };
      case "echo": return { out: args.join(" "), code: 0 };
      case "cd": {
        const abs = await target(ws, sess, args[0]);
        if (!(await fs.stat(abs)).isDirectory()) return { out: `cd: not a directory: ${args[0]}`, code: 1 };
        sess.cwd = toRel(await fs.realpath(ws), await fs.realpath(abs));
        return { out: "", code: 0 };
      }
      case "ls": case "ll": {
        const long = cmd === "ll" || args.includes("-l") || args.includes("-la") || args.includes("-al");
        const all = args.includes("-a") || args.includes("-la") || args.includes("-al");
        const p = args.find((a) => !a.startsWith("-"));
        const abs = await target(ws, sess, p);
        const st = await fs.stat(abs);
        if (!st.isDirectory()) return { out: path.basename(abs), code: 0 };
        const ents = (await fs.readdir(abs, { withFileTypes: true })).filter((e) => (all || !e.name.startsWith(".") || e.name === ".env" ) && !HIDDEN.has(e.name)).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
        if (!long) return { out: ents.map((e) => (e.isDirectory() ? e.name + "/" : e.name)).join("  "), code: 0 };
        const rows = await Promise.all(ents.map(async (e) => { const s = await fs.stat(path.join(abs, e.name)).catch(() => null); return `${e.isDirectory() ? "d" : "-"}  ${fmtSize(s?.size ?? 0).padStart(7)}  ${s ? s.mtime.toISOString().slice(0, 16).replace("T", " ") : "?"}  ${e.name}${e.isDirectory() ? "/" : ""}`; }));
        return { out: rows.join("\r\n"), code: 0 };
      }
      case "cat": case "head": case "tail": {
        const nIdx = args.indexOf("-n");
        const n = nIdx >= 0 ? Math.max(1, Number(args[nIdx + 1]) || 10) : 10;
        const file = args.filter((a, i) => !a.startsWith("-") && (nIdx < 0 || i !== nIdx + 1))[0];
        if (!file) return { out: `${cmd}: missing file`, code: 1 };
        const abs = await target(ws, sess, file);
        const st = await fs.stat(abs);
        if (st.isDirectory()) return { out: `${cmd}: ${file}: is a directory`, code: 1 };
        if (st.size > 2_000_000) return { out: `${cmd}: ${file}: too large to print (${fmtSize(st.size)})`, code: 1 };
        const lines = (await fs.readFile(abs, "utf8")).replace(/\r?\n$/, "").split(/\r?\n/);
        return { out: (cmd === "cat" ? lines : cmd === "head" ? lines.slice(0, n) : lines.slice(-n)).join("\r\n"), code: 0 };
      }
      case "tree": {
        const abs = await target(ws, sess, args[0]);
        const out: string[] = [];
        const walk = async (dir: string, prefix: string, depth: number) => {
          if (depth > 3 || out.length > 400) return;
          const ents = (await fs.readdir(dir, { withFileTypes: true })).filter((e) => !e.name.startsWith(".") && !HIDDEN.has(e.name) && !(depth === 0 && e.name === "runs")).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
          for (const [i, e] of ents.entries()) {
            out.push(`${prefix}${i === ents.length - 1 ? "└─ " : "├─ "}${e.name}${e.isDirectory() ? "/" : ""}`);
            if (e.isDirectory()) await walk(path.join(dir, e.name), prefix + (i === ents.length - 1 ? "   " : "│  "), depth + 1);
          }
        };
        await walk(abs, "", 0);
        return { out: out.join("\r\n") || "(empty)", code: 0 };
      }
    }
  } catch (e) {
    if (e instanceof JailError) return { out: `${cmd}: ${e.message}`, code: 1 };
    const err = e as NodeJS.ErrnoException;
    return { out: `${cmd}: ${err.code === "ENOENT" ? "no such file or directory" : err.message}`, code: 1 };
  }
  return { out: `${cmd}: not a builtin`, code: 127 };
}
