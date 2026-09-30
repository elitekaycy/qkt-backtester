import type { RunJson } from "../api/types.js";
import type { RunConfig } from "./store.js";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Pure: the top-bar settings a shown run used (its window and its tier) as a patch for `setCfg`, the setter the top
 * bar itself uses; null when the top bar already says the same. Applied whenever a run is put on screen (the store's
 * `selectRun`, the agent's `show` of a live variant), so the top bar, Run settings, the next Run and the view the agent
 * is told about all describe the run on the chart. A value missing or malformed in the record is left alone.
 * A run's parameters are not taken: they are per strategy (a variant's belong to its copy), and Run settings owns them.
 */
export function runCfgPatch(run: Pick<RunJson, "from" | "to" | "tier">, cfg: Pick<RunConfig, "from" | "to" | "tier">): Partial<RunConfig> | null {
  const from = DAY.test(run.from) ? run.from : cfg.from, to = DAY.test(run.to) ? run.to : cfg.to;
  const patch: Partial<RunConfig> = {};
  if (to > from) {
    if (from !== cfg.from) patch.from = from;
    if (to !== cfg.to) patch.to = to;
  }
  if ((run.tier === "draft" || run.tier === "full") && run.tier !== cfg.tier) patch.tier = run.tier;
  return Object.keys(patch).length ? patch : null;
}
