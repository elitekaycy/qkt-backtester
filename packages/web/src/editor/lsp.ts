import type { editor, languages, IPosition, IRange } from "monaco-editor/editor/editor.api.js";
import type { Monaco } from "./monaco.js";
import { wsUrl } from "../api/client.js";
import type { Diagnostic } from "../api/types.js";

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
      triggerCharacters: [".", " "],
      provideCompletionItems: async (model, position): Promise<languages.CompletionList> => {
        if (!this.ready) return { suggestions: [] };
        try {
          const res = await this.request<{ items?: any[] } | any[] | null>("textDocument/completion", { textDocument: { uri: this.uriFor(pathOf(model)) }, position: { line: position.lineNumber - 1, character: position.column - 1 } });
          const items = Array.isArray(res) ? res : res?.items ?? [];
          const range = toRange(model, position);
          return {
            suggestions: items.map((it) => ({
              label: it.label,
              kind: m.languages.CompletionItemKind[KIND[it.kind ?? 1] ?? "Text"],
              detail: it.detail,
              documentation: typeof it.documentation === "string" ? it.documentation : it.documentation?.value,
              insertText: it.insertText ?? it.label,
              insertTextRules: it.insertTextFormat === 2 ? m.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
              filterText: it.filterText, sortText: it.sortText, range,
            })),
          };
        } catch { return { suggestions: [] }; }
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
