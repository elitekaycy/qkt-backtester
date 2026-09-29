import { z } from "zod";
const rule = z.union([z.number().int().positive(), z.string().min(1)]).optional().describe("rule number (1-based) or text in the rule; default: every BUY/SELL rule");
const level = z.union([z.number().positive(), z.string()]).optional();
/** The operations of @qkt-studio/core `Change`, as the model sees them. */
export const changeSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set_bracket"), rule, stop: level, target: level }),
  z.object({ op: z.literal("set_param"), name: z.string(), value: z.union([z.number(), z.string(), z.boolean()]) }),
  z.object({ op: z.literal("set_sizing"), rule, sizing: z.string() }),
  z.object({ op: z.literal("add_condition"), rule, expr: z.string(), mode: z.enum(["and", "or"]).optional() }),
  z.object({ op: z.literal("remove_condition"), rule, match: z.string() }),
  z.object({ op: z.literal("exclude"), rule, dates: z.array(z.string()).optional(), weekdays: z.array(z.union([z.string(), z.number().int()])).optional(), hours_utc: z.array(z.number().int()).optional(), calendar_window: z.tuple([z.number().int(), z.number().int(), z.number().int(), z.number().int()]).optional() }),
  z.object({ op: z.literal("add_rule"), source: z.string() }),
  z.object({ op: z.literal("remove_rule"), match: z.string() }),
  z.object({ op: z.literal("add_symbol"), alias: z.string(), symbol: z.string(), tf: z.string() }),
  z.object({ op: z.literal("replace_text"), find: z.string(), replace: z.string() }),
  z.object({ op: z.literal("source"), text: z.string() }),
]);
export const changesSchema = z.array(changeSchema).min(1).max(20).describe("operations applied in order; see dsl_reference for expressions");
