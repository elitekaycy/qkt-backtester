// Slim Monaco: the editor core plus its contributions (hover, suggest, find, folding), no bundled languages
// and no TypeScript/CSS/HTML workers. Highlighting comes from qkt's own TextMate grammar through Shiki.
import * as monaco from "monaco-editor/editor/editor.api.js";
import "monaco-editor/features/register.all.js";
import editorWorker from "monaco-editor/editor/editor.worker.js?worker";
import { createHighlighter } from "shiki";
import { shikiToMonaco } from "@shikijs/monaco";
import qktGrammar from "./qkt.tmLanguage.json";

(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = { getWorker: () => new editorWorker() };

export type Monaco = typeof monaco;
let ready: Promise<Monaco> | null = null;

export const themeFor = (t: "dark" | "light") => (t === "dark" ? "github-dark" : "github-light");

export function setupMonaco(): Promise<Monaco> {
  ready ??= (async () => {
    monaco.languages.register({ id: "qkt", extensions: [".qkt"] });
    monaco.languages.register({ id: "yaml", extensions: [".yaml", ".yml"] });
    monaco.languages.setLanguageConfiguration("qkt", {
      comments: { lineComment: "--" },
      brackets: [["(", ")"], ["{", "}"], ["[", "]"]],
      autoClosingPairs: [{ open: "(", close: ")" }, { open: "{", close: "}" }, { open: "[", close: "]" }, { open: '"', close: '"', notIn: ["string"] }],
      surroundingPairs: [{ open: "(", close: ")" }, { open: '"', close: '"' }],
      wordPattern: /[A-Za-z_][\w]*/,
    });
    const hl = await createHighlighter({ themes: ["github-dark", "github-light"], langs: [{ ...(qktGrammar as object), name: "qkt" } as never, "yaml"] });
    shikiToMonaco(hl, monaco);
    return monaco;
  })();
  return ready;
}

export const languageFor = (path: string): string => (path.endsWith(".qkt") ? "qkt" : /\.ya?ml$/.test(path) ? "yaml" : "plaintext");

export const QKT_TEMPLATE = (name: string) => `STRATEGY ${name} VERSION 1

SYMBOLS
    gold = BACKTEST:XAUUSD EVERY 15m

PARAM fast = 9
PARAM slow = 21

RULES
    WHEN ema(gold.close, fast) CROSSES ABOVE ema(gold.close, slow)
     AND POSITION.gold = 0
    THEN BUY gold SIZING 0.1 ; LOG "long entry"

    WHEN ema(gold.close, fast) CROSSES BELOW ema(gold.close, slow)
     AND POSITION.gold > 0
    THEN CLOSE gold ; LOG "exit"
`;

export const CONFIG_TEMPLATE = `# qkt.config.yaml. qkt reads this file from the working directory of every run.
starting_balance: 10000
`;

export interface VimHandlers { save(): Promise<boolean> | boolean; saveAll(): Promise<unknown> | unknown; close(force: boolean): void; run(): void; say(msg: string): void }

let exDefined = false;
/** Vim keybindings (monaco-vim) with a status line. Returns a disposer. Loaded lazily so it costs nothing when off. */
export async function enableVim(editor: import("monaco-editor/editor/editor.api.js").editor.IStandaloneCodeEditor, statusEl: HTMLElement, h?: VimHandlers): Promise<() => void> {
  const { initVimMode, VimMode } = await import("monaco-vim");
  // monaco-vim knows `:w` but it does nothing, and it has no `:q`/`:wq`: wire the ones an editor user reaches for to the studio.
  if (h && !exDefined) {
    exDefined = true;
    const Vim = (VimMode as unknown as { Vim: { defineEx(name: string, short: string, fn: (cm: unknown, p: { argString?: string; line?: number }) => void): void } }).Vim;
    const cur = { h };
    (window as unknown as { __vimHandlers?: { h: VimHandlers } }).__vimHandlers = cur;
    const H = () => (window as unknown as { __vimHandlers: { h: VimHandlers } }).__vimHandlers.h;
    Vim.defineEx("write", "w", () => { void Promise.resolve(H().save()).then((ok) => ok && H().say("written")); });
    Vim.defineEx("wall", "wa", () => { void Promise.resolve(H().saveAll()).then(() => H().say("all files written")); });
    Vim.defineEx("wquit", "wq", () => { void Promise.resolve(H().save()).then((ok) => { if (ok) H().close(false); }); });
    Vim.defineEx("xit", "x", () => { void Promise.resolve(H().save()).then((ok) => { if (ok) H().close(false); }); });
    Vim.defineEx("exit", "exi", () => { void Promise.resolve(H().save()).then((ok) => { if (ok) H().close(false); }); });
    Vim.defineEx("quit", "q", (_cm, p) => H().close(Boolean(p.argString?.trim().startsWith("!"))));
    Vim.defineEx("bdelete", "bd", (_cm, p) => H().close(Boolean(p.argString?.trim().startsWith("!"))));
    Vim.defineEx("run", "ru", () => H().run());
  } else if (h) (window as unknown as { __vimHandlers: { h: VimHandlers } }).__vimHandlers.h = h;
  const vim = initVimMode(editor, statusEl);
  return () => vim.dispose();
}
