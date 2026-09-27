import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client.js";
import type { PortfolioListing } from "../api/client.js";
import { useStore } from "../state/store.js";
import { CONFIG_TEMPLATE, QKT_TEMPLATE } from "../editor/monaco.js";
import type { TreeEntry } from "../api/client.js";
import { Tip } from "../ui/Tip.js";
import { ChevronRight, EyeOff, FileCode2, FileCog, FilePlus, FileText, Folder, FolderOpen, KeyRound, Layers, Pencil, Plus, RefreshCw, SlidersHorizontal, Trash2, TriangleAlert, Wand2 } from "../ui/icons.js";

interface Row { e: TreeEntry; depth: number; member?: { alias: string; hold: boolean; exists: boolean; portfolio: string } }

/** What the standard project files are for, shown as tooltips and in the help line. */
const FILE_HELP: Record<string, string> = {
  "qkt.config.yaml": "Account, risk halts and execution model for every run. Values may use ${VAR} from .env.",
  "instruments.yaml": "Per-symbol contract size, lot step, commission, swap and slippage points used for sizing and P&L.",
  ".env": "Variables for ${VAR} / ${VAR:-default} in qkt.config.yaml. Keep secrets here. Git-ignored.",
  ".env.example": "A template for .env that is safe to share.",
  ".gitignore": "Keeps .env, runs/ and studio state out of git.",
};
const PIN = ["qkt.config.yaml", "instruments.yaml", ".env", ".env.example", ".gitignore"];
const STANDARD = ["qkt.config.yaml", "instruments.yaml", ".env", ".env.example", ".gitignore"];

/** Root order: strategies, other folders, the project files in a fixed order (config first), everything else, runs last. */
function orderRoot(list: TreeEntry[]): TreeEntry[] {
  const rank = (e: TreeEntry) => (e.path === "runs" ? 9 : e.type === "dir" ? (e.path === "strategies" ? 0 : 1) : PIN.includes(e.name) ? 2 : 3);
  return [...list].sort((a, b) => rank(a) - rank(b) || (rank(a) === 2 ? PIN.indexOf(a.name) - PIN.indexOf(b.name) : a.name.localeCompare(b.name)));
}

function FileIcon({ e, open, portfolio }: { e: TreeEntry; open?: boolean; portfolio?: boolean }) {
  if (e.type === "dir") return e.path === "runs" ? <Folder size={16} className="ficon run" /> : open ? <FolderOpen size={16} className="ficon dir" /> : <Folder size={16} className="ficon dir" />;
  if (portfolio) return <Layers size={16} className="ficon portfolio" />;
  if (e.name.endsWith(".qkt")) return <FileCode2 size={16} className="ficon qkt" />;
  if (e.name === "instruments.yaml") return <SlidersHorizontal size={16} className="ficon instr" />;
  if (e.name === ".env" || e.name.startsWith(".env.")) return <KeyRound size={16} className="ficon env" />;
  if (e.name === ".gitignore") return <EyeOff size={16} className="ficon dir" />;
  if (/\.ya?ml$/.test(e.name)) return <FileCog size={16} className="ficon yaml" />;
  return <FileText size={16} className="ficon dir" />;
}

export function newStrategy(dir = "strategies") {
  const raw = window.prompt("Name of the new strategy", "my_strategy");
  if (!raw) return;
  const name = raw.replace(/\.qkt$/i, "").replace(/[^\w.-]+/g, "_");
  void useStore.getState().createEntry(`${dir}/${name}.qkt`, "file", QKT_TEMPLATE(name));
}

/** IMPORT + RUN lines for each ticked strategy, relative to `dir` (portfolio.qkt lives beside its children by default). */
function PORTFOLIO_TEMPLATE(name: string, members: Array<{ path: string; alias: string }>): string {
  const imports = members.map((m) => `IMPORT '${m.path}' AS ${m.alias}`).join("\n");
  const runs = members.map((m) => `    RUN ${m.alias}`).join("\n");
  return `PORTFOLIO ${name} VERSION 1

${imports}

RULES
${runs}
`;
}

export function newPortfolio(candidates: string[], dir = "strategies") {
  const raw = window.prompt("Name of the new portfolio", "my_portfolio");
  if (!raw) return;
  const name = raw.replace(/\.qkt$/i, "").replace(/[^\w.-]+/g, "_");
  if (!candidates.length) { useStore.getState().toast("error", "No strategy files to add. Create one first."); return; }
  const picked = window.prompt(`Strategies to run (comma-separated, relative to ${dir}/):`, candidates.slice(0, Math.min(3, candidates.length)).join(", "));
  if (!picked) return;
  const members = picked.split(",").map((s) => s.trim()).filter(Boolean).map((rel) => {
    const alias = rel.replace(/^.*\//, "").replace(/\.qkt$/i, "").replace(/[^\w]+/g, "_") || "s";
    return { path: rel.endsWith(".qkt") ? rel : `${rel}.qkt`, alias };
  });
  if (!members.length) return;
  void useStore.getState().createEntry(`${dir}/${name}.qkt`, "file", PORTFOLIO_TEMPLATE(name, members));
}

/** New file of any kind. The standard project files come from the workspace templates; anything else is created empty. */
export async function newFile() {
  const raw = window.prompt("File name (for example instruments.yaml, .env, notes.md or strategies/x.qkt)", "");
  const name = raw?.trim().replace(/^\/+/, "");
  if (!name) return;
  if (/\.qkt$/i.test(name) && !name.includes("/")) return newStrategy();
  if (STANDARD.includes(name)) {
    const r = await api.scaffold([name]).catch((e) => { useStore.getState().toast("error", (e as Error).message); return null; });
    if (!r) return;
    await useStore.getState().refreshTree("");
    if (r.created.includes(name)) void useStore.getState().openFile(name); else useStore.getState().toast("info", `${name} already exists`);
    return;
  }
  void useStore.getState().createEntry(name, "file", "");
}

export function FilesSection() {
  const tree = useStore((s) => s.tree), expanded = useStore((s) => s.expanded), activePath = useStore((s) => s.activePath), info = useStore((s) => s.info);
  const store = useStore.getState;
  const listRef = useRef<HTMLDivElement>(null);
  const [portfolios, setPortfolios] = useState<{ byPath: Map<string, PortfolioListing>; usedIn: Record<string, string[]> }>({ byPath: new Map(), usedIn: {} });
  const [openPortfolios, setOpenPortfolios] = useState<Set<string>>(new Set());
  const refreshPortfolios = () => void api.portfolios().then((r) => setPortfolios({ byPath: new Map(r.portfolios.map((p) => [p.path, p])), usedIn: r.usedIn })).catch(() => {});

  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (dir: string, depth: number) => {
      for (const e of dir === "" ? orderRoot(tree[""] ?? []) : tree[dir] ?? []) {
        out.push({ e, depth });
        if (e.type === "dir" && expanded[e.path]) walk(e.path, depth + 1);
        else if (e.type === "file") {
          const p = portfolios.byPath.get(e.path);
          if (p && openPortfolios.has(e.path)) for (const m of p.members) out.push({ e: { path: m.rel ?? `${e.path}#${m.alias}`, name: m.alias, type: "file", size: 0, mtimeMs: 0 }, depth: depth + 1, member: { alias: m.alias, hold: m.hold, exists: m.exists, portfolio: e.path } });
        }
      }
    };
    walk("", 0);
    return out;
  }, [tree, expanded, portfolios, openPortfolios]);
  const root = tree[""] ?? [];
  const [missing, setMissing] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  useEffect(() => { void api.scaffoldMissing().then((r) => setMissing(r.missing)).catch(() => setMissing([])); }, [root.length, root.map((e) => e.name).join("|")]);
  useEffect(refreshPortfolios, [tree]);
  async function addMissing() {
    setAdding(true);
    try {
      const r = await api.scaffold([...missing, ...(missing.includes(".env") ? [".env.example", ".gitignore"] : [])]); setMissing(r.missing);
      await store().refreshTree(""); await store().refreshTree("strategies");
      store().toast("info", r.created.length ? `Added ${r.created.join(", ")}` : "Nothing to add");
      const first = ["qkt.config.yaml", "instruments.yaml"].find((f) => r.created.includes(f));
      if (first) void store().openFile(first);
    } catch (e) { store().toast("error", (e as Error).message); } finally { setAdding(false); }
  }

  const isPortfolio = (path: string) => portfolios.byPath.has(path);
  const togglePortfolio = (path: string) => setOpenPortfolios((s) => { const n = new Set(s); if (n.has(path)) n.delete(path); else n.add(path); return n; });
  const activate = (r: Row) => {
    if (r.member) { if (r.member.exists) void store().openFile(r.e.path); return; }
    if (r.e.type === "dir") { void store().toggleDir(r.e.path); return; }
    void store().openFile(r.e.path);
  };
  const rename = (e: TreeEntry) => { const n = window.prompt("Rename to", e.path); if (n && n !== e.path) void store().renameEntry(e.path, n); };
  const remove = (e: TreeEntry) => { if (window.confirm(`Delete ${e.path}${e.type === "dir" ? " and everything in it" : ""}?`)) void store().removeEntry(e.path); };

  const onKey = (ev: React.KeyboardEvent, i: number) => {
    const focusRow = (j: number) => listRef.current?.querySelectorAll<HTMLElement>("[role='treeitem']")[Math.max(0, Math.min(rows.length - 1, j))]?.focus();
    const r = rows[i]!;
    if (ev.key === "ArrowDown") { ev.preventDefault(); focusRow(i + 1); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); focusRow(i - 1); }
    else if (ev.key === "Home") { ev.preventDefault(); focusRow(0); } else if (ev.key === "End") { ev.preventDefault(); focusRow(rows.length - 1); }
    else if (ev.key === "ArrowRight" && (r.e.type === "dir" || isPortfolio(r.e.path))) { ev.preventDefault(); const openIt = r.e.type === "dir" ? !expanded[r.e.path] : !openPortfolios.has(r.e.path); if (openIt) (r.e.type === "dir" ? store().toggleDir(r.e.path) : togglePortfolio(r.e.path)); else focusRow(i + 1); }
    else if (ev.key === "ArrowLeft") { ev.preventDefault(); if (r.e.type === "dir" && expanded[r.e.path]) void store().toggleDir(r.e.path); else if (isPortfolio(r.e.path) && openPortfolios.has(r.e.path)) togglePortfolio(r.e.path); else { const p = r.member ? r.member.portfolio : r.e.path.includes("/") ? r.e.path.slice(0, r.e.path.lastIndexOf("/")) : ""; const j = rows.findIndex((x) => x.e.path === p); if (j >= 0) focusRow(j); } }
    else if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); activate(r); }
    else if (ev.key === "F2" && !r.e.path.startsWith("runs")) { ev.preventDefault(); rename(r.e); }
    else if (ev.key === "Delete" && !r.e.path.startsWith("runs")) { ev.preventDefault(); remove(r.e); }
  };

  return (
    <>
      <div className="side-head">
        <h2>Files</h2>
        <Tip label="New strategy" side="bottom"><button className="btn ghost icon sm" aria-label="New strategy" onClick={() => newStrategy()}><Plus size={16} /></button></Tip>
        <Tip label="New portfolio (run several strategies as one book)" side="bottom">
          <button className="btn ghost icon sm" aria-label="New portfolio" onClick={() => newPortfolio(rows.filter((r) => !r.member && r.e.type === "file" && r.e.name.endsWith(".qkt") && !portfolios.byPath.has(r.e.path)).map((r) => r.e.path.replace(/^strategies\//, "")))}><Layers size={15} /></button>
        </Tip>
        <Tip label="New file (config, instruments, .env…)" side="bottom"><button className="btn ghost icon sm" aria-label="New file" onClick={() => void newFile()}><FilePlus size={15} /></button></Tip>
        <Tip label="Refresh" side="bottom"><button className="btn ghost icon sm" aria-label="Refresh files" onClick={() => { void store().refreshTree(""); for (const p of Object.keys(store().expanded)) if (store().expanded[p] && p) void store().refreshTree(p); }}><RefreshCw size={14} /></button></Tip>
      </div>
      <div className="side-scroll">
        {missing.length > 0 && info && (
          <div className="banner warn files-banner" role="status">
            <div className="grow">
              <b>Missing project files</b>
              <div className="ink2" style={{ fontSize: "var(--fs-xs)" }}>{missing.join(", ")}</div>
              <div className="muted" style={{ fontSize: "var(--fs-xs)" }}>Config holds account, risk and execution; instruments.yaml holds contract size and lot rules; .env feeds ${"{VAR}"} in the config.</div>
            </div>
            <button className="btn sm" disabled={adding} onClick={() => void addMissing()}><Wand2 size={14} />{adding ? "Adding…" : "Add missing"}</button>
          </div>
        )}
        <div className="tree" role="tree" aria-label="Workspace files" ref={listRef}>
          {rows.map((row, i) => {
            const { e, depth, member } = row;
            const isRuns = e.path === "runs" || e.path.startsWith("runs/");
            const portfolio = !member && isPortfolio(e.path);
            const open = member ? false : e.type === "dir" ? expanded[e.path] : portfolio && openPortfolios.has(e.path);
            const usedIn = !member && !portfolio ? (portfolios.usedIn[e.path] ?? []) : [];
            const help = member
              ? `${e.name}: ${member.exists ? e.path : "file not found"}${member.hold ? " · HOLD (keeps its position when the portfolio deactivates it)" : ""}`
              : portfolio ? `${e.path}: portfolio of ${portfolios.byPath.get(e.path)!.members.length} strategies` : e.type === "file" && FILE_HELP[e.path] ? `${e.path}: ${FILE_HELP[e.path]}` : e.path;
            return (
              <div key={member ? `${member.portfolio}#${member.alias}` : e.path} role="treeitem" aria-level={depth + 1} aria-expanded={e.type === "dir" || portfolio ? !!open : undefined} aria-selected={!member && activePath === e.path} tabIndex={i === 0 ? 0 : -1}
                className={`tree-row${member ? " member" : ""}`} style={{ paddingLeft: 6 + depth * 14 }} title={help} onClick={() => activate(row)} onKeyDown={(ev) => onKey(ev, i)}>
                {Array.from({ length: depth }, (_, g) => <span key={g} className="tree-guide" style={{ left: 13 + g * 14 }} />)}
                <span className={`twist${open ? " open" : ""}`} onClick={(ev) => { if (portfolio) { ev.stopPropagation(); togglePortfolio(e.path); } }}>{e.type === "dir" || portfolio ? <ChevronRight size={14} /> : null}</span>
                <FileIcon e={e} open={!!open} portfolio={portfolio} />
                <span className="name" style={{ color: isRuns ? "var(--ink-3)" : member && !member.exists ? "var(--loss-ink)" : undefined }}>{e.name}</span>
                {member?.hold && <span className="badge sm" title="Keeps its position when the portfolio deactivates it">HOLD</span>}
                {member && !member.exists && <Tip label="Strategy file not found" side="right"><TriangleAlert size={13} className="loss" /></Tip>}
                {!member && usedIn.length > 0 && <Tip label={`Used in ${usedIn.length} portfolio${usedIn.length > 1 ? "s" : ""}: ${usedIn.map((p) => p.split("/").pop()).join(", ")}`} side="right"><span className="badge sm" style={{ display: "inline-flex", alignItems: "center", gap: 2 }}><Layers size={11} />{usedIn.length}</span></Tip>}
                {!isRuns && !member && (
                  <span className="acts" onClick={(ev) => ev.stopPropagation()}>
                    {e.type === "dir" && <Tip label="New strategy here" side="bottom"><button className="btn ghost icon sm" aria-label={`New strategy in ${e.name}`} onClick={() => newStrategy(e.path)}><Plus size={13} /></button></Tip>}
                    <Tip label="Rename (F2)" side="bottom"><button className="btn ghost icon sm" aria-label={`Rename ${e.name}`} onClick={() => rename(e)}><Pencil size={13} /></button></Tip>
                    <Tip label="Delete" side="bottom"><button className="btn ghost icon sm" aria-label={`Delete ${e.name}`} onClick={() => remove(e)}><Trash2 size={13} /></button></Tip>
                  </span>
                )}
              </div>
            );
          })}
          {rows.length === 0 && <div className="empty"><b>This workspace is empty.</b>Create a strategy with the + button.</div>}
        </div>
      </div>
      {info && <div className="side-foot" title={info.workspace}><span className="mono" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{info.workspace}</span></div>}
    </>
  );
}
