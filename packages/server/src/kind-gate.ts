import { lintFieldKinds, type Diagnostic, type KindContext, type QktVocabulary } from "@qkt-studio/core";
import { derivativesCached, kindContextOf } from "./derivatives-scan.js";

/**
 * qkt parses `fx.dte` on a CFD (or `es.iv` on a future) and then backtests with zero trades and no error: the field is
 * undefined there, so the rule never fires. The DSL stays one language for every instrument, so the studio refuses it where
 * qkt does not: in the editor's check and as a failed parse step of a run, like an unknown alias.
 */
export async function kindContextFor(dataRoot: string): Promise<KindContext> {
  return kindContextOf(await derivativesCached(dataRoot).catch(() => undefined));
}

/** The field-by-kind errors of a strategy, or []. */
export function fieldKindErrors(source: string, ctx: KindContext, vocabulary?: QktVocabulary): Diagnostic[] {
  return lintFieldKinds(source, ctx, vocabulary).filter((d) => d.severity === "error");
}
