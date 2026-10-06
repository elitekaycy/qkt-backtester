import type { QktResult } from "./results.js";
import type { RoundTrip } from "./roundtrips.js";

/**
 * What a futures or options run writes beside the CFD files. qkt writes each file only when it has rows ("a run without
 * futures writes none of them"), so a section is present exactly when its file had data: the UI branches on that, never on
 * guessing from the instrument kind. Shapes follow docs/reference/cli-commands.md "Backtest Report Artifacts" (qkt 0.55);
 * timestamps are epoch ms, money in the root's currency unless named otherwise.
 */
export interface RollRow {
  ts: number; stream: string; strategy: string; from: string; to: string; quantity: number; multiplier: number;
  fromReference: number; toReference: number; /** The price gap between the two contracts at the roll. */ gap: number;
  fromFill: number; toFill: number; fees: number; rollCost: number;
}
/** The contract and price behind one fill of a continuous stream. */
export interface ContractFill { ts: number; strategy: string; stream: string; orderId: string; contract: string; side: "BUY" | "SELL"; quantity: number; contractPrice: number; streamPrice: number }
export interface SettlementRow { ts: number; strategy: string; contract: string; side: "BUY" | "SELL"; quantity: number; price: number; deliveryPriceKnown: boolean }
export interface MarginDay { date: string; marginUsed: number; maintenance: number; equity: number; marginCall: boolean }
export interface LiquidationRow { ts: number; strategy: string; symbol: string; side: "BUY" | "SELL"; quantity: number; price: number; fee: number; equity: number; maintenance: number }
export interface StructureLeg { side: "BUY" | "SELL"; quantity: number; symbol: string; entry: number }
export interface StructureRow {
  openedAt: number | null; closedAt: number | null; strategy: string; structure: string; alias: string;
  /** `CLOSED`, `UNWOUND` or `SETTLED`; null while the structure is still open at the end of the run. */
  outcome: "CLOSED" | "UNWOUND" | "SETTLED" | null;
  legs: StructureLeg[]; credit: number | null; realized: number | null;
}
export interface FinancingRow { component: string; paid: number; netPnlImpact: number }

/** The gross-to-net bridge: preCostPnL = totalPnL + commissionPaid + swapPaid + rollCostsPaid + fundingPaid. */
export interface CostBridge {
  totalPnl: number; commission: number; swap: number; rollCosts: number; funding: number; preCostPnl: number;
}

export interface RunDerivatives {
  /** Which sections carry rows, in display order. Mirrors `meta.derivatives`. */
  sections: DerivativesSection[];
  rolls?: RollRow[];
  contracts?: ContractFill[];
  settlements?: SettlementRow[];
  margin?: MarginDay[];
  liquidations?: LiquidationRow[];
  structures?: StructureRow[];
  /** Non-zero financing components (swap, funding, ...) from financing.csv. */
  financing?: FinancingRow[];
  costs?: CostBridge;
}
export type DerivativesSection = "rolls" | "contracts" | "settlements" | "margin" | "liquidations" | "structures" | "financing" | "costs";

function splitLine(line: string): string[] {
  if (!line.includes('"')) return line.split(",");
  const out: string[] = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/** Rows of a qkt CSV as header-keyed records; a file with no rows (or no header) is []. */
function records(text: string): Array<Record<string, string>> {
  const lines = text.split(/\r?\n/).filter((l) => l.length);
  if (lines.length < 2) return [];
  const head = splitLine(lines[0]!);
  return lines.slice(1).map((l) => { const f = splitLine(l); const o: Record<string, string> = {}; head.forEach((h, i) => { o[h] = f[i] ?? ""; }); return o; });
}
const n = (s: string | undefined) => (s === undefined || s === "" ? 0 : Number(s));
const nn = (s: string | undefined) => (s === undefined || s === "" ? null : Number(s));
const side = (s: string | undefined): "BUY" | "SELL" => (s === "SELL" ? "SELL" : "BUY");

export const parseRolls = (text: string): RollRow[] => records(text).map((r) => ({
  ts: n(r.timestamp), stream: r.stream!, strategy: r.strategy!, from: r.from!, to: r.to!, quantity: n(r.quantity), multiplier: n(r.multiplier),
  fromReference: n(r.fromReference), toReference: n(r.toReference), gap: n(r.gap), fromFill: n(r.fromFill), toFill: n(r.toFill), fees: n(r.fees), rollCost: n(r.rollCost),
}));
export const parseContracts = (text: string): ContractFill[] => records(text).map((r) => ({
  ts: n(r.timestamp), strategy: r.strategy!, stream: r.stream!, orderId: r.orderId!, contract: r.contract!, side: side(r.side), quantity: n(r.quantity), contractPrice: n(r.contractPrice), streamPrice: n(r.streamPrice),
}));
export const parseSettlements = (text: string): SettlementRow[] => records(text).map((r) => ({
  ts: n(r.timestamp), strategy: r.strategy!, contract: r.contract!, side: side(r.side), quantity: n(r.quantity), price: n(r.price), deliveryPriceKnown: r.deliveryPriceKnown === "true",
}));
export const parseMarginDaily = (text: string): MarginDay[] => records(text).map((r) => ({
  date: r.date!, marginUsed: n(r.marginUsed), maintenance: n(r.maintenance), equity: n(r.equity), marginCall: r.marginCall === "true",
}));
export const parseLiquidations = (text: string): LiquidationRow[] => records(text).map((r) => ({
  ts: n(r.timestamp), strategy: r.strategy!, symbol: r.symbol!, side: side(r.side), quantity: n(r.quantity), price: n(r.price), fee: n(r.fee), equity: n(r.equity), maintenance: n(r.maintenance),
}));
export const parseFinancing = (text: string): FinancingRow[] => records(text).map((r) => ({ component: r.component!, paid: n(r.paid), netPnlImpact: n(r.netPnlImpact) }));

/** `SELL 0.10 DERIBIT:BTC_USDC_9OCT26_82000_P @ 645.00000000;BUY ...` */
export function parseLegs(text: string): StructureLeg[] {
  return text.split(";").map((p) => /^\s*(BUY|SELL)\s+(\S+)\s+(\S+)\s+@\s+(\S+)\s*$/.exec(p)).filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ side: m[1] as "BUY" | "SELL", quantity: Number(m[2]), symbol: m[3]!, entry: Number(m[4]) }));
}
export const parseStructures = (text: string): StructureRow[] => records(text).map((r) => ({
  openedAt: nn(r.openedAt), closedAt: nn(r.closedAt), strategy: r.strategy!, structure: r.structure!, alias: r.alias!,
  outcome: r.outcome === "CLOSED" || r.outcome === "UNWOUND" || r.outcome === "SETTLED" ? r.outcome : null,
  legs: parseLegs(r.legs ?? ""), credit: nn(r.credit), realized: nn(r.realized),
}));

/**
 * The cost bridge, only when the run has a cost qkt reports for futures: `rollCostsPaid` and `fundingPaid` appear in
 * result.json only on those runs (a CFD run has neither key), which keeps a CFD summary exactly as it was.
 */
export function costBridge(result: QktResult): CostBridge | null {
  const g = result.global as unknown as Record<string, unknown>;
  if (g.rollCostsPaid === undefined && g.fundingPaid === undefined) return null;
  const v = (k: string) => Number(g[k] ?? 0) || 0;
  const rollCosts = v("rollCostsPaid"), funding = v("fundingPaid"), commission = v("commissionPaid"), swap = v("swapPaid"), totalPnl = v("totalPnL");
  return { totalPnl, commission, swap, rollCosts, funding, preCostPnl: totalPnl + commission + swap + rollCosts + funding };
}

/** The derivatives sections of a run from the text of each file qkt wrote (undefined = the file is absent). */
export function buildDerivatives(files: Partial<Record<"rolls" | "contracts" | "settlements" | "margin" | "liquidations" | "structures" | "financing", string>>, result: QktResult): RunDerivatives | null {
  const rep: RunDerivatives = { sections: [] };
  const put = <K extends Exclude<DerivativesSection, "costs">>(key: K, rows: NonNullable<RunDerivatives[K]>) => { if (rows.length) { (rep as unknown as Record<string, unknown>)[key] = rows; rep.sections.push(key); } };
  if (files.rolls !== undefined) put("rolls", parseRolls(files.rolls));
  if (files.contracts !== undefined) put("contracts", parseContracts(files.contracts));
  if (files.settlements !== undefined) put("settlements", parseSettlements(files.settlements));
  if (files.margin !== undefined) put("margin", parseMarginDaily(files.margin));
  if (files.liquidations !== undefined) put("liquidations", parseLiquidations(files.liquidations));
  if (files.structures !== undefined) put("structures", parseStructures(files.structures));
  // financing.csv always has a `swap` row on every run: only a component that charged something is worth showing, and only on a run that has derivatives
  if (files.financing !== undefined) {
    const used = parseFinancing(files.financing).filter((r) => r.paid !== 0 && r.component !== "swap");
    if (used.length) { rep.financing = used; rep.sections.push("financing"); }
  }
  const costs = costBridge(result);
  if (costs) { rep.costs = costs; rep.sections.push("costs"); }
  return rep.sections.length ? rep : null;
}

/**
 * Put the contracts behind each trip of a continuous stream onto the trip. A roll closes the old contract and reopens the new
 * one inside qkt, so trades.csv carries no fill for it: the signed strategy position (and so the trip) spans the roll, and the
 * rolls it carried are counted from rolls.csv. `contract` is the contract of the first fill in the trip, `exitContract` of the
 * last, from contracts.csv. Trips of other streams are untouched, so a CFD run's trips stay exactly as paired.
 */
export function attachContracts(trips: RoundTrip[], contracts: ContractFill[], rolls: RollRow[]): void {
  if (!contracts.length && !rolls.length) return;
  const by = (rows: Array<{ ts: number; strategy: string; stream: string }>) => {
    const m = new Map<string, typeof rows>();
    for (const r of rows) { const k = `${r.strategy}\u0000${r.stream}`; const a = m.get(k); if (a) a.push(r); else m.set(k, [r]); }
    for (const a of m.values()) a.sort((x, y) => x.ts - y.ts);
    return m;
  };
  const cMap = by(contracts), rMap = by(rolls);
  const lower = (a: Array<{ ts: number }>, t: number) => { let lo = 0, hi = a.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid]!.ts < t) lo = mid + 1; else hi = mid; } return lo; };
  for (const t of trips) {
    const k = `${t.strategy}\u0000${t.symbol}`;
    const c = cMap.get(k) as ContractFill[] | undefined, r = rMap.get(k) as RollRow[] | undefined;
    if (!c && !r) continue;
    const end = t.exitTs ?? Number.POSITIVE_INFINITY;
    if (c) {
      const i = lower(c, t.entryTs);
      if (c[i] && c[i]!.ts <= end) {
        t.contract = c[i]!.contract;
        let j = i; while (c[j + 1] && c[j + 1]!.ts <= end) j++;
        t.exitContract = c[j]!.contract;
      }
    }
    if (r) {
      const i = lower(r, t.entryTs);
      let cnt = 0; for (let j = i; r[j] && r[j]!.ts <= end; j++) cnt++;
      if (cnt) t.rolls = cnt;
    }
  }
}
