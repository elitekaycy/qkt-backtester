import type { editor, languages, IPosition, IRange } from "monaco-editor/editor/editor.api.js";
import type { Monaco } from "./monaco.js";
import { wsUrl } from "../api/client.js";
import type { Diagnostic } from "../api/types.js";
import { useStore } from "../state/store.js";
import { localCompletions } from "./completions.js";

interface LspDiag { range: { start: { line: number; character: number }; end: { line: number; character: number } }; severity?: number; message: string; code?: string | number }
type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

// LSP CompletionItemKind -> Monaco CompletionItemKind names.
const KIND: Record<number, keyof typeof import("monaco-editor/editor/editor.api.js").languages.CompletionItemKind> = {
  1: "Text", 2: "Method", 3: "Function", 4: "Constructor", 5: "Field", 6: "Variable", 7: "Class", 8: "Interface", 9: "Module", 10: "Property",
  11: "Unit", 12: "Value", 13: "Enum", 14: "Keyword", 15: "Snippet", 16: "Color", 17: "File", 18: "Reference", 19: "Folder", 20: "EnumMember",
  21: "Constant", 22: "Struct", 23: "Event", 24: "Operator", 25: "TypeParameter",
};

/**
 * Thin LSP client for `qkt lsp`, spoken over the studio's WebSocket bridge. Only what qkt implements is wired:
 * full-document sync, diagnostics, hover and completion. It reconnects with backoff and replays every open
 * document after a reconnect, so a restarted language server is invisible to the user.
 */
export class LspClient {
  private ws: WebSocket | null = null;
  private ready = false;
  private closed = false;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private queue: string[] = [];
  private docs = new Map<string, { version: number; text: string }>();
  private backoff = 500;
  onStatus: (s: "connecting" | "ready" | "down") => void = () => {};

  constructor(private monaco: Monaco, private rootPath: string, private onDiagnostics: (uri: string, diags: Diagnostic[], raw: LspDiag[]) => void) {}

  uriFor(path: string): string { return `file://${this.rootPath}/${path}`; }

  connect(): void {
    if (this.closed) return;
    this.onStatus("connecting");
    const ws = new WebSocket(wsUrl("/ws/lsp"));
    this.ws = ws;
    ws.onopen = () => {
      void this.request("initialize", { processId: null, rootUri: `file://${this.rootPath}`, capabilities: {} }, 10_000).then(() => {
        this.notify("initialized", {});
        this.ready = true;
        this.backoff = 500;
        for (const [uri, d] of this.docs) this.notify("textDocument/didOpen", { textDocument: { uri, languageId: "qkt", version: d.version, text: d.text } });
        for (const m of this.queue.splice(0)) ws.send(m);
        this.onStatus("ready");
      }).catch(() => ws.close());
    };
    ws.onmessage = (ev) => this.handle(String(ev.data));
    ws.onclose = () => {
      this.ready = false;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("lsp connection closed")); }
      this.pending.clear();
      if (this.ws === ws) this.ws = null;
      if (this.closed) return;
      this.onStatus("down");
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 5000);
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  dispose(): void { this.closed = true; this.ws?.close(); }

  /** Resolve once the connection is ready (or after `ms`): a completion asked for during a reconnect waits instead of returning nothing. */
  private whenReady(ms: number): Promise<boolean> {
    if (this.ready) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => { if (this.ready) resolve(true); else if (this.closed || Date.now() - t0 >= ms) resolve(false); else setTimeout(tick, 100); };
      tick();
    });
  }

  private send(msg: object, force = false): void {
    const s = JSON.stringify({ jsonrpc: "2.0", ...msg });
    if (this.ws && this.ws.readyState === WebSocket.OPEN && (this.ready || force)) this.ws.send(s);
    else if (!force) this.queue.push(s);
  }
  private notify(method: string, params: object): void { this.send({ method, params }, method === "initialized"); }
  private request<T = any>(method: string, params: object, timeoutMs = 5000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`lsp ${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params }, method === "initialize");
    });
  }

  private handle(text: string): void {
    let m: { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: any };
    try { m = JSON.parse(text); } catch { return; }
    if (m.id !== undefined && this.pending.has(m.id)) {
      const p = this.pending.get(m.id)!;
      this.pending.delete(m.id); clearTimeout(p.timer);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
    } else if (m.method === "textDocument/publishDiagnostics") {
      const raw: LspDiag[] = m.params.diagnostics ?? [];
      this.onDiagnostics(m.params.uri, raw.map(toDiagnostic), raw);
    }
  }

  open(path: string, text: string): void {
    const uri = this.uriFor(path);
    this.docs.set(uri, { version: 1, text });
    this.notify("textDocument/didOpen", { textDocument: { uri, languageId: "qkt", version: 1, text } });
  }
  change(path: string, text: string): void {
    const uri = this.uriFor(path);
    const d = this.docs.get(uri);
    if (!d) return this.open(path, text);
    d.version++; d.text = text;
    this.notify("textDocument/didChange", { textDocument: { uri, version: d.version }, contentChanges: [{ text }] });
  }
  close(path: string): void {
    const uri = this.uriFor(path);
    if (this.docs.delete(uri)) this.notify("textDocument/didClose", { textDocument: { uri } });
  }

  // ---- Monaco providers ------------------------------------------------------------------------------------
  register(): { dispose(): void } {
    const m = this.monaco;
    const toRange = (model: editor.ITextModel, p: IPosition): IRange => {
      const w = model.getWordUntilPosition(p);
      return { startLineNumber: p.lineNumber, endLineNumber: p.lineNumber, startColumn: w.startColumn, endColumn: w.endColumn };
    };
    const pathOf = (model: editor.ITextModel) => model.uri.path.startsWith(this.rootPath) ? model.uri.path.slice(this.rootPath.length + 1) : model.uri.path;
    const completion = m.languages.registerCompletionItemProvider("qkt", {
      triggerCharacters: [".", " ", ":"],
      provideCompletionItems: async (model, position): Promise<languages.CompletionList> => {
        const path = pathOf(model), cur = model.getValue(), range = toRange(model, position);
        // context-specific items first (fields after `gold.`, symbols and timeframes from the data source, actions after THEN...);
        // they come from the studio itself, so they still work while the language server is starting or reconnecting
        const loc = path.endsWith(".qkt") ? localCompletions(cur, position.lineNumber, position.column, useStore.getState().scan) : { items: [], exclusive: false };
        const kindOf = (k: string) => m.languages.CompletionItemKind[(k === "field" ? "Field" : k === "alias" ? "Variable" : k === "symbol" ? "Constant" : k === "timeframe" ? "Unit" : k === "snippet" ? "Snippet" : "Keyword") as keyof typeof m.languages.CompletionItemKind];
        const mine: languages.CompletionItem[] = loc.items.map((i) => ({
          label: { label: i.label, detail: i.detail ? `  ${i.detail}` : undefined }, kind: kindOf(i.kind), documentation: i.doc, insertText: i.insert,
          insertTextRules: i.snippet ? m.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined, filterText: i.label, sortText: `0${i.sort}`, range,
        }));
        if (loc.exclusive) return { suggestions: mine };
        let lspItems: any[] = [];
        if (await this.whenReady(loc.items.length ? 300 : 4000)) {
          try {
            // The editor sends changes after a short pause, but a completion is asked for at once: without this the server
            // would answer for the text as it was a keystroke ago (the cursor is past the end of its line) and return nothing.
            const known = this.docs.get(this.uriFor(path));
            if (!known || known.text !== cur) this.change(path, cur);
            const res = await this.request<{ items?: any[] } | any[] | null>("textDocument/completion", { textDocument: { uri: this.uriFor(path) }, position: { line: position.lineNumber - 1, character: position.column - 1 } }, 8000);
            lspItems = Array.isArray(res) ? res : res?.items ?? [];
          } catch { /* keep the local items */ }
        }
        const taken = new Set(loc.items.map((i) => i.label.toLowerCase()));
        return {
          suggestions: [...mine, ...lspItems.filter((it) => !taken.has(String(it.label).toLowerCase())).map((it) => ({
            label: it.label,
            kind: m.languages.CompletionItemKind[KIND[it.kind ?? 1] ?? "Text"],
            detail: it.detail,
            documentation: typeof it.documentation === "string" ? it.documentation : it.documentation?.value,
            insertText: it.insertText ?? it.label,
            insertTextRules: it.insertTextFormat === 2 ? m.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
            filterText: it.filterText, sortText: `1${it.sortText ?? it.label}`, range,
          }))],
        };
      },
    });
    const hover = m.languages.registerHoverProvider("qkt", {
      provideHover: async (model, position) => {
        if (!this.ready) return null;
        try {
          const res = await this.request<{ contents?: { value?: string } | string } | null>("textDocument/hover", { textDocument: { uri: this.uriFor(pathOf(model)) }, position: { line: position.lineNumber - 1, character: position.column - 1 } });
          const c = res?.contents;
          const value = typeof c === "string" ? c : c?.value;
          return value ? { contents: [{ value }] } : null;
        } catch { return null; }
      },
    });
    return { dispose: () => { completion.dispose(); hover.dispose(); } };
  }
}

export function toDiagnostic(d: LspDiag): Diagnostic {
  const sameLine = d.range.start.line === d.range.end.line;
  return {
    severity: d.severity === 2 ? "warning" : d.severity === 3 || d.severity === 4 ? "info" : "error",
    code: String(d.code ?? "lsp"), message: d.message, line: d.range.start.line + 1, col: d.range.start.character + 1,
    endCol: sameLine ? Math.max(d.range.end.character + 1, d.range.start.character + 2) : d.range.start.character + 2,
  };
}

/** Diagnostics -> Monaco markers (both are 1-based). */
export function toMarkers(m: Monaco, list: Diagnostic[]): editor.IMarkerData[] {
  return list.map((d) => ({
    severity: d.severity === "error" ? m.MarkerSeverity.Error : d.severity === "warning" ? m.MarkerSeverity.Warning : m.MarkerSeverity.Info,
    message: d.message, startLineNumber: d.line, startColumn: d.col, endLineNumber: d.line, endColumn: Math.max(d.endCol, d.col + 1), code: d.code,
  }));
}
