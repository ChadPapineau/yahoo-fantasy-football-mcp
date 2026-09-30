// size-report.ts — plan 10 §2 ledger rows "Token sizes vs plan 07 §5.1" and "Per-turn fixed cost":
// tests/mcp/size.test.ts's measured numbers rendered as a Markdown table and appended to the CI job
// summary ($GITHUB_STEP_SUMMARY), where the ledger says they live; plan 07 §5.1 copies them.
import { appendFileSync } from "node:fs";

export interface ToolsListSize {
  readonly chars: number;
  readonly tokens_approx: number;
  readonly tokens_upper: number;
  readonly prompts_list_chars: number;
}
export interface SizeReport {
  results?: Record<string, { compact: number; full: number }>;
  tools_list_core?: ToolsListSize;
  tools_list_full?: ToolsListSize;
  skills_listing_chars?: number;
  obj07?: Record<string, { bare: number; wrapped: number; names: number }>;
}
export interface Ceilings {
  readonly core: number;
  readonly full: number;
  readonly skills: number;
}

const n = (x: number): string => (Number.isFinite(x) ? Math.round(x).toLocaleString("en-US") : "—");
/** A table cell: tool names are ours, but never let a `|` or newline break the table. */
const cell = (s: string): string => s.replace(/[|\r\n`]/g, " ");
const pct = (used: number, cap: number): string =>
  cap > 0 && Number.isFinite(used) ? `${((used / cap) * 100).toFixed(1)} %` : "—";

/** The report as GitHub-flavoured Markdown (deterministic: keys sorted). */
export function formatSizeReport(r: SizeReport, ceiling: Ceilings): string {
  const out: string[] = [
    "### Token economy — plan 07 §5.1 (tests/mcp/size.test.ts, fixture mode)",
    "",
  ];
  out.push(
    "| per-turn fixed cost | chars | ≈ tokens (4 c/t) | ≤ tokens (3 c/t) | ceiling | used |",
  );
  out.push("|---|---:|---:|---:|---:|---:|");
  for (const k of ["core", "full"] as const) {
    const t = r[`tools_list_${k}`];
    if (t === undefined) continue;
    out.push(
      `| tools/list \`${k}\` | ${n(t.chars)} | ${n(t.tokens_approx)} | ${n(t.tokens_upper)} | ${n(ceiling[k])} | ${pct(t.chars, ceiling[k])} |`,
    );
  }
  if (r.tools_list_core !== undefined)
    out.push(`| prompts/list | ${n(r.tools_list_core.prompts_list_chars)} | | | | |`);
  if (r.skills_listing_chars !== undefined)
    out.push(
      `| Skills listing | ${n(r.skills_listing_chars)} | | | ${n(ceiling.skills)} | ${pct(r.skills_listing_chars, ceiling.skills)} |`,
    );
  if (r.obj07 !== undefined) {
    out.push("", "| OBJ-07 player names | names | bare + path-listed | wrapped | Δ |");
    out.push("|---|---:|---:|---:|---:|");
    for (const k of Object.keys(r.obj07).sort()) {
      const o = r.obj07[k];
      if (o === undefined) continue;
      out.push(
        `| ${cell(k)} | ${n(o.names)} | ${n(o.bare)} | ${n(o.wrapped)} | +${pct(o.wrapped - o.bare, o.bare)} |`,
      );
    }
  }
  if (r.results !== undefined) {
    out.push("", "| tool (heaviest fixture call) | compact chars | full chars |");
    out.push("|---|---:|---:|");
    for (const k of Object.keys(r.results).sort()) {
      const v = r.results[k];
      if (v !== undefined) out.push(`| ${cell(k)} | ${n(v.compact)} | ${n(v.full)} |`);
    }
  }
  return `${out.join("\n")}\n`;
}

/**
 * Appends the table to `$GITHUB_STEP_SUMMARY` when it is set (CI); a no-op elsewhere. Returns whether
 * it wrote. A failed append never fails the suite — the numbers are also on the SIZE-REPORT line.
 */
export function writeSizeReport(
  r: SizeReport,
  ceiling: Ceilings,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const file = env.GITHUB_STEP_SUMMARY;
  if (file === undefined || file === "") return false;
  try {
    appendFileSync(file, `${formatSizeReport(r, ceiling)}\n`);
    return true;
  } catch {
    return false;
  }
}
