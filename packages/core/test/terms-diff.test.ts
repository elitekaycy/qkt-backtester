import { describe, it, expect } from "vitest";
import { parseInstruments, termsDifferences } from "../src/instruments.js";

const A = `futures:
  - root: CME:ES
    multiplier: 50
    tickSize: 0.25
    margin: { initial: 25713, maintenance: 23375, basis: per_contract }
    roll: { daysBeforeExpiry: 7, atUtc: "00:00", adjust: panama }
  - root: CME:NQ
    multiplier: 20
options:
  - root: DERIBIT:BTC_USDC
    contractSize: 1
    chains: trade
`;

describe("termsDifferences: what the data source's instruments.yaml says that the workspace's does not", () => {
  const a = parseInstruments(A);
  it("is empty for the same terms, whatever the order", () => {
    expect(termsDifferences(a, parseInstruments(A))).toEqual({});
  });
  it("names the fields that differ for a root both declare", () => {
    const b = parseInstruments(A.replace("multiplier: 50", "multiplier: 5").replace("initial: 25713", "initial: 1"));
    expect(termsDifferences(a, b)).toEqual({ "CME:ES": ["margin", "multiplier"] });
  });
  it("says when a root is declared on one side only", () => {
    const b = parseInstruments(A.replace(/  - root: CME:NQ\n    multiplier: 20\n/, ""));
    expect(termsDifferences(a, b)).toEqual({ "CME:NQ": ["only in the data source"] });
    expect(termsDifferences(b, a)).toEqual({ "CME:NQ": ["only in the workspace"] });
  });
  it("covers options roots too", () => {
    const b = parseInstruments(A.replace("chains: trade", "chains: book"));
    expect(termsDifferences(a, b)).toEqual({ "DERIBIT:BTC_USDC": ["chains"] });
  });
});
