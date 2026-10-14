// season-agnostic.test.ts — the season-agnostic rule as a guard (season-fresh spec §12 B1, wave 2;
// CONTRIBUTING § Workflow): no code under src/ names a season year or decides a game day by weekday.
// A TypeScript-AST scan of src/**/*.ts: no numeric literal in 2015–2040 outside the two vintage-
// stamped reference tables, and no getDay()/getUTCDay() outside the D3 display helper. Season facts
// come from the schedule data (src/domain/league/season.ts) or a table stamped
// verified_through_season (src/config/reference-vintage.ts).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { ROOT } from "./helpers.js";

/** The vintage-stamped reference tables: the only place a season year may be written. */
const YEAR_ALLOWED = new Set(["src/config/reference-vintage.ts", "src/config/flex-rules.ts"]);
/** The D3 display helper that names a game's weekday (display only, never a game-day rule). */
const WEEKDAY_ALLOWED = new Set(["src/mcp/tools/datasets.ts"]);
const YEAR_MIN = 2015;
const YEAR_MAX = 2040;

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...tsFiles(p));
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** Every violation in one source text, as `file:line: what`. */
export function seasonAgnosticViolations(rel: string, text: string): string[] {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: string[] = [];
  const at = (n: ts.Node): string =>
    `${rel}:${String(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1)}`;
  const visit = (n: ts.Node): void => {
    if (ts.isNumericLiteral(n) && !YEAR_ALLOWED.has(rel)) {
      const v = Number(n.text.replace(/_/g, ""));
      if (Number.isInteger(v) && v >= YEAR_MIN && v <= YEAR_MAX)
        out.push(`${at(n)}: season-like literal ${n.text}`);
    }
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      (n.expression.name.text === "getDay" || n.expression.name.text === "getUTCDay") &&
      !WEEKDAY_ALLOWED.has(rel)
    )
      out.push(`${at(n)}: weekday rule ${n.expression.name.text}()`);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe("season-agnostic source (no year literals, no weekday game days)", () => {
  it("src/**/*.ts names no season year outside the vintage tables and no weekday outside D3's display", () => {
    const violations: string[] = [];
    for (const file of tsFiles(path.join(ROOT, "src"))) {
      const rel = path.relative(ROOT, file).split(path.sep).join("/");
      violations.push(...seasonAgnosticViolations(rel, readFileSync(file, "utf8")));
    }
    expect(violations).toEqual([]);
  });

  it("the guard sees the patterns it bans (non-vacuity)", () => {
    const legacy = [
      "export const GAME_DAYS: readonly number[] = Object.freeze([4, 0, 1]);",
      "const off = GAME_DAYS.includes(new Date(basisMs).getDay());",
      "const sat = new Date(ms).getUTCDay() === 6;",
      "if (season >= 2026) warn();",
      "const big = 2_030;",
    ].join("\n");
    expect(seasonAgnosticViolations("src/config/freshness.ts", legacy)).toEqual([
      "src/config/freshness.ts:2: weekday rule getDay()",
      "src/config/freshness.ts:3: weekday rule getUTCDay()",
      "src/config/freshness.ts:4: season-like literal 2026",
      "src/config/freshness.ts:5: season-like literal 2030",
    ]);
    // the allowed places, and numbers that are not seasons
    expect(seasonAgnosticViolations("src/config/reference-vintage.ts", "const v = 2026;")).toEqual(
      [],
    );
    expect(seasonAgnosticViolations("src/mcp/tools/datasets.ts", "d.getUTCDay();")).toEqual([]);
    expect(
      seasonAgnosticViolations("src/x.ts", "const a = 2100, b = 1999, c = 2014.5, d = 22;"),
    ).toEqual([]);
    // a year in a comment or a string is documentation, not a rule
    expect(seasonAgnosticViolations("src/x.ts", '// read 2026-10-13\nconst s = "2026";')).toEqual(
      [],
    );
  });
});
