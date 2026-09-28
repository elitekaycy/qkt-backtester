import { describe, it, expect } from "vitest";
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ScanReport } from "../api/types.js";
import { localCompletions } from "./completions.js";
import { declSnippets, expandSnippet, fileSnippets, orderSnippets, ruleSnippets, streamSnippet } from "./snippets.js";

const scan = { symbols: [
  { symbol: "XAUUSD", bars: [{ broker: "BACKTEST", tf: "15m", files: 3 }, { broker: "BACKTEST", tf: "60m", files: 3, qktReads: "1h" }] },
  { symbol: "BTCUSD", bars: [{ broker: "BACKTEST", tf: "1h", files: 3 }] },
] } as unknown as ScanReport;

const HEAD = "STRATEGY s VERSION 1\n\nSYMBOLS\n    px = BACKTEST:XAUUSD EVERY 15m\n    btc = BACKTEST:BTCUSD EVERY 1h\n";
const RULE = "    WHEN px.close > 1\n    THEN BUY px SIZING 1\n";
const indent = (s: string, pad: string) => s.split("\n").map((l) => pad + l).join("\n");

/** Every snippet, expanded with its defaults and placed where the editor offers it: a whole file each. */
const files: Array<[string, string]> = [
  ...fileSnippets(scan).map((s) => [`file ${s.label}`, expandSnippet(s.body)] as [string, string]),
  ["stream", `STRATEGY s VERSION 1\n\nSYMBOLS\n    ${expandSnippet(streamSnippet(scan).body)}\n\nRULES\n    WHEN px.close > 1\n    THEN BUY px SIZING 1\n`],
  ...declSnippets("px").map((s) => [s.label, `${HEAD}\n${expandSnippet(s.body)}\n\nRULES\n${RULE}`] as [string, string]),
  ...ruleSnippets(["px", "btc"]).map((s) => [s.label, `${HEAD}\nRULES\n${indent(expandSnippet(s.body), "    ")}\n`] as [string, string]),
  ...orderSnippets(["px", "btc"]).map((s) => [s.label, `${HEAD}\nRULES\n    WHEN px.close > 1\n    THEN ${expandSnippet(s.body).split("\n").join("\n    ")}\n`] as [string, string]),
];

describe("snippets", () => {
  it("fill every tab stop and mirror from the defaults", () => {
    expect(expandSnippet("${1:a} = ${2|X,Y|}:${3:S} and $1 ${1:a}")).toBe("a = X:S and a a");
    for (const [, src] of files) expect(src).not.toMatch(/\$\{?\d/);
  });
  it("offer the data source's symbols and only the timeframes qkt can read", () => {
    const body = streamSnippet(scan).body;
    expect(body).toContain("XAUUSD,BTCUSD");
    expect(body).not.toContain("60m");
  });
  it("appear only where they are valid", () => {
    const ask = (t: string) => { const l = t.split("\n"); return localCompletions(t, l.length, l[l.length - 1]!.length + 1, scan).items.map((i) => i.label); };
    expect(ask("")).toEqual(["strategy", "portfolio"]);
    expect(ask(`${HEAD}    `)).toEqual(["stream"]);
    expect(ask(`${HEAD}\n`)).toEqual(expect.arrayContaining(["PARAM", "LET", "RULES"]));
    const rules = ask(`${HEAD}\nRULES\n    `);
    expect(rules).toEqual(expect.arrayContaining(["WHEN", "rule", "cross entry", "for each"]));
    expect(rules).not.toContain("LET");
    expect(ask(`${HEAD}\nRULES\n    WHEN px.close > 1\n    `)).toEqual(["THEN", "AND", "OR"]);
    expect(ask(`${HEAD}\nRULES\n    WHEN px.close > 1\n    THEN `)).toEqual(expect.arrayContaining(["BUY", "BUY with bracket", "SELL with bracket"]));
  });
});

const haveQkt = (() => { try { execSync("qkt --version", { stdio: "ignore" }); return true; } catch { return false; } })();
describe.skipIf(!haveQkt)("snippets parse with qkt", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "qkt-snippets-"));
  // the files the portfolio template imports
  for (const f of ["first", "second"]) writeFileSync(path.join(dir, `${f}.qkt`), `${HEAD}\nRULES\n${RULE}`.replace("STRATEGY s", `STRATEGY ${f}`));
  it.each(files)("%s", (name, src) => {
    const f = path.join(dir, `${name.replace(/\W+/g, "_")}.qkt`);
    writeFileSync(f, src);
    let out = "";
    try { out = execFileSync("qkt", ["parse", f], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { out = String((e as { stdout?: string; stderr?: string }).stdout ?? "") + String((e as { stderr?: string }).stderr ?? ""); throw new Error(`${name} does not parse:\n${out}\n---\n${src}`); }
    expect(out).toMatch(/ok/);
  }, 60_000);
});
