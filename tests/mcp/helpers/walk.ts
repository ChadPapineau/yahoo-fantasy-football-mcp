// walk.ts — the plan 05 §2 `mcp/envelope` walker for tool outputs (plan 10 A6): every string in
// `data` is either wrapped (untrusted_text), listed by path in meta.untrusted_fields, a code (no
// whitespace), or on the tool's server-prose allow-list (fixed engine text); every object key passes
// the envelope's key grammar.
import { isUntrustedText, objectKeyViolations } from "../../../src/mcp/envelope.js";

/** One string leaf of `data`, outside wrappers, with its normalised path (`[]` for indices). */
export interface Leaf {
  readonly path: string;
  readonly value: string;
}

export function stringLeaves(data: unknown): Leaf[] {
  const out: Leaf[] = [];
  const walk = (v: unknown, p: string, depth: number): void => {
    if (depth > 40) return;
    if (typeof v === "string") {
      out.push({ path: p, value: v });
      return;
    }
    if (typeof v !== "object" || v === null || isUntrustedText(v)) return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, `${p}[]`, depth + 1);
      return;
    }
    for (const [k, x] of Object.entries(v)) walk(x, `${p}.${k}`, depth + 1);
  };
  walk(data, "data", 0);
  return out;
}

/** A code-like string: no whitespace, printable ASCII punctuation used by keys, dates and slots. */
export const CODE_LIKE = /^[A-Za-z0-9_:./+\-]*$/;

/** Server-authored prose paths (fixed engine/tool text, never third-party). */
export const SERVER_PROSE: ReadonlySet<string> = new Set([
  "data.assumptions[].text",
  "data.assumptions[].revisit_trigger",
  "data.projections[].assumptions[].text",
  "data.projections[].assumptions[].revisit_trigger",
  "data.rec.action",
  "data.rec.drivers[].name",
  "data.rec.assumptions[].text",
  "data.rec.assumptions[].revisit_trigger",
  "data.swaps[].option_value.verdict",
  "data.base_rates_note",
  "data.sample_size_caveats[]",
  // "n too small (k of 30)" — the fixed E13 literal
  "data.metrics.brier.p_active",
  "data.metrics.brier.p_win",
  "data.metrics.brier.p_win_given_bid",
  "data.metrics.brier.p_role_holds",
  // the fixed G1 placeholder for the store path (the real path is never shown)
  "data.store.path",
]);

/** The violations of the A6 rule in one envelope (empty = compliant). */
export function envelopeViolations(env: {
  data: unknown;
  meta: { untrusted_fields: readonly { path: string; source: string }[] };
}): string[] {
  const listed = new Set(env.meta.untrusted_fields.map((f) => f.path));
  const bad: string[] = [];
  for (const l of stringLeaves(env.data)) {
    if (listed.has(l.path)) continue;
    if (CODE_LIKE.test(l.value)) continue;
    if (SERVER_PROSE.has(l.path)) continue;
    bad.push(l.path);
  }
  return [...new Set([...bad, ...objectKeyViolations(env.data)])];
}
