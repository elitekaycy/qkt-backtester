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

/** Vim keybindings (monaco-vim) with a status line. Returns a disposer. Loaded lazily so it costs nothing when off. */
export async function enableVim(editor: import("monaco-editor/editor/editor.api.js").editor.IStandaloneCodeEditor, statusEl: HTMLElement): Promise<() => void> {
  const { initVimMode } = await import("monaco-vim");
  const vim = initVimMode(editor, statusEl);
  return () => vim.dispose();
}
