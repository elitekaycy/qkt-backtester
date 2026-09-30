// Slim Monaco: the editor core plus its contributions (hover, suggest, find, folding), no bundled languages
// and no TypeScript/CSS/HTML workers. Highlighting comes from the TextMate grammar the running qkt prints, through Shiki.
import * as monaco from "monaco-editor/editor/editor.api.js";
import "monaco-editor/features/register.all.js";
import editorWorker from "monaco-editor/editor/editor.worker.js?worker";
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import yamlLang from "shiki/langs/yaml.mjs";
import githubDark from "shiki/themes/github-dark.mjs";
import githubLight from "shiki/themes/github-light.mjs";
import { shikiToMonaco } from "@shikijs/monaco";
import { parseVocabulary } from "@qkt-studio/core/vocabulary";
import { api } from "../api/client.js";
import { setVocabulary } from "./vocabulary.js";

(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = { getWorker: () => new editorWorker() };

export type Monaco = typeof monaco;
let ready: Promise<Monaco> | null = null;

export const themeFor = (t: "dark" | "light") => (t === "dark" ? "github-dark" : "github-light");

/**
 * Monaco with the qkt language as the running qkt describes it: its vocabulary (for completions and lint) and its
 * TextMate grammar (for highlighting) are fetched first, so no editor exists before they are known. A fetch that fails
 * leaves `ready` unset, and the next caller tries again.
 */
export function setupMonaco(): Promise<Monaco> {
  ready ??= (async () => {
    const [vocab, qktGrammar] = await Promise.all([api.qktVocabulary(), api.qktGrammar()]);
    setVocabulary(parseVocabulary(vocab));
    monaco.languages.register({ id: "qkt", extensions: [".qkt"] });
    monaco.languages.register({ id: "yaml", extensions: [".yaml", ".yml"] });
    monaco.languages.setLanguageConfiguration("qkt", {
      comments: { lineComment: "--", blockComment: ["/*", "*/"] },
      brackets: [["(", ")"], ["{", "}"], ["[", "]"]],
      autoClosingPairs: [{ open: "(", close: ")" }, { open: "{", close: "}" }, { open: "[", close: "]" }, { open: '"', close: '"', notIn: ["string"] }],
      surroundingPairs: [{ open: "(", close: ")" }, { open: '"', close: '"' }],
      wordPattern: /[A-Za-z_][\w]*/,
    });
    const hl = await createHighlighterCore({ engine: createJavaScriptRegexEngine(), themes: [githubDark, githubLight], langs: [{ ...qktGrammar, name: "qkt" } as never, yamlLang] });
    shikiToMonaco(hl, monaco);
    return monaco;
  })();
  ready.catch(() => { ready = null; });
  return ready;
}

export const languageFor = (path: string): string => (path.endsWith(".qkt") ? "qkt" : /\.ya?ml$/.test(path) ? "yaml" : "plaintext");

/**
 * A new strategy's text, on a stream the data source really has: the first of XAUUSD, EURUSD, BTCUSD, DEMOUSD with bars qkt
 * can read, else any such symbol; 15m when built, else its finest timeframe. A template on a symbol the user has no data
 * for would fail its very first run.
 */
export const QKT_TEMPLATE = (name: string, scan?: import("../api/types.js").ScanReport | null) => {
  const usable = (scan?.symbols ?? []).filter((x) => x.bars.some((b) => b.files > 0 && !b.qktReads));
  const sym = ["XAUUSD", "EURUSD", "BTCUSD", "DEMOUSD"].map((n) => usable.find((x) => x.symbol === n)).find(Boolean) ?? usable[0];
  const bars = sym?.bars.filter((b) => b.files > 0 && !b.qktReads) ?? [];
  const ms = (tf: string) => { const m = /^(\d+)([smhd])$/.exec(tf); return m ? Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2] as "s"] : Infinity; };
  const tf = bars.some((b) => b.tf === "15m") ? "15m" : [...bars].sort((x, y) => ms(x.tf) - ms(y.tf))[0]?.tf ?? "15m";
  const broker = bars.find((b) => b.tf === tf)?.broker ?? "BACKTEST";
  const symbol = sym?.symbol ?? "XAUUSD";
  const size = symbol === "DEMOUSD" ? "10" : "0.1";
  return `STRATEGY ${name} VERSION 1

SYMBOLS
    px = ${broker}:${symbol} EVERY ${tf}

PARAM fast = 9
PARAM slow = 21

RULES
    WHEN ema(px.close, fast) CROSSES ABOVE ema(px.close, slow)
     AND POSITION.px = 0
    THEN BUY px SIZING ${size} ; LOG "long entry"

    WHEN ema(px.close, fast) CROSSES BELOW ema(px.close, slow)
     AND POSITION.px > 0
    THEN CLOSE px ; LOG "exit"
`;
};

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
  const stopGuard = guardAgainstEscBlur(editor, vim, VimMode as unknown as VimApi);
  return () => { stopGuard(); vim.dispose(); };
}

type VimApi = { Vim: { exitInsertMode(cm: unknown): void; exitVisualMode(cm: unknown): void } };

/**
 * Browser extensions with their own vim keys (Vimium, Surfingkeys, Tridactyl) take Esc in any editable element: they swallow
 * the key and blur it. In a vim editor that Esc was meant for vim, so without this the editor loses focus AND stays in insert
 * mode. The key never reaches the page, so the blur is recognised by what it leaves behind: focus dropped to nothing (the
 * page body) with no click, no Tab and the window still focused, which only a script's blur() does. The editor then takes
 * focus back and leaves insert/visual mode, as the Esc intended. A click, Tab or Ctrl+M still moves focus out as usual.
 */
function guardAgainstEscBlur(editor: import("monaco-editor/editor/editor.api.js").editor.IStandaloneCodeEditor, vim: unknown, api: VimApi): () => void {
  let userMovedAt = 0;
  const moved = () => { userMovedAt = performance.now(); };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Tab" || e.key === "F6") moved(); };
  window.addEventListener("pointerdown", moved, true);
  window.addEventListener("keydown", onKey, true);
  const sub = editor.onDidBlurEditorText(() => {
    if (performance.now() - userMovedAt < 400) return;
    setTimeout(() => {
      const a = document.activeElement;
      if (!document.hasFocus() || (a && a !== document.body && a !== document.documentElement)) return;
      editor.focus();
      const st = (vim as { state?: { vim?: { insertMode?: boolean; visualMode?: boolean } } }).state?.vim;
      if (st?.insertMode) api.Vim.exitInsertMode(vim);
      else if (st?.visualMode) api.Vim.exitVisualMode(vim);
    }, 0);
  });
  return () => { sub.dispose(); window.removeEventListener("pointerdown", moved, true); window.removeEventListener("keydown", onKey, true); };
}
