// size-report.test.ts — tests/mcp/helpers/size-report.ts (plan 10 §2 ledger: the size.test.ts numbers
// reach the CI job summary): the table's content, determinism, hostile values, and the
// $GITHUB_STEP_SUMMARY append (temp files only; unset → nothing written anywhere).
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatSizeReport, writeSizeReport, type SizeReport } from "./helpers/size-report.js";

const CEIL = { core: 20_000, full: 35_000, skills: 4_500 } as const;
const REPORT: SizeReport = {
  results: {
    ff_get_status: { compact: 1200, full: 1900 },
    ff_analyze_lineup: { compact: 7000, full: 9800 },
  },
  tools_list_core: {
    chars: 19_483,
    tokens_approx: 4871,
    tokens_upper: 6495,
    prompts_list_chars: 812,
  },
  skills_listing_chars: 1650,
  obj07: {
    ff_list_players: { bare: 18_559, wrapped: 21_373, names: 100 },
    ff_get_roster: { bare: 6942, wrapped: 8349, names: 16 },
  },
};

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "ff-size-report-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("formatSizeReport", () => {
  it("renders the per-turn cost against its ceiling, OBJ-07 bare vs wrapped, and every tool", () => {
    const md = formatSizeReport(REPORT, CEIL);
    expect(md).toContain("| tools/list `core` | 19,483 | 4,871 | 6,495 | 20,000 | 97.4 % |");
    expect(md).toContain("| prompts/list | 812 |");
    expect(md).toContain("| Skills listing | 1,650 | | | 4,500 | 36.7 % |");
    expect(md).toContain("| ff_list_players | 100 | 18,559 | 21,373 | +15.2 % |");
    expect(md).toContain("| ff_get_roster | 16 | 6,942 | 8,349 | +20.3 % |");
    expect(md).toContain("| ff_analyze_lineup | 7,000 | 9,800 |");
    // no `full` row when it was not measured (Phase 1a measures core)
    expect(md).not.toContain("tools/list `full`");
  });

  it("is deterministic and key-order independent (rows sorted)", () => {
    const shuffled: SizeReport = {
      ...REPORT,
      results: {
        ff_analyze_lineup: { compact: 7000, full: 9800 },
        ff_get_status: { compact: 1200, full: 1900 },
      },
    };
    expect(formatSizeReport(shuffled, CEIL)).toBe(formatSizeReport(REPORT, CEIL));
    const md = formatSizeReport(REPORT, CEIL);
    expect(md.indexOf("ff_analyze_lineup |")).toBeLessThan(md.indexOf("ff_get_status |"));
  });

  it("an empty report is a heading, not a crash", () => {
    const md = formatSizeReport({}, CEIL);
    expect(md).toMatch(/^### Token economy/);
    expect(md).not.toContain("ff_");
  });

  it("hostile values: NaN/Infinity print as —, a zero ceiling divides nothing, a | or newline cannot break the table", () => {
    const md = formatSizeReport(
      {
        tools_list_core: {
          chars: Number.NaN,
          tokens_approx: Infinity,
          tokens_upper: -Infinity,
          prompts_list_chars: 0,
        },
        results: { "evil|name\n| injected | row": { compact: 1, full: 2 } },
        obj07: { x: { bare: 0, wrapped: 5, names: 0 } },
      },
      { core: 0, full: 0, skills: 0 },
    );
    expect(md).toContain("| tools/list `core` | — | — | — | 0 | — |");
    expect(md).toContain("| evil name   injected   row | 1 | 2 |");
    expect(md).toContain("| x | 0 | 0 | 5 | +— |");
    for (const line of md
      .trim()
      .split("\n")
      .filter((l) => l.startsWith("|")))
      expect(line.endsWith("|"), line).toBe(true);
  });
});

describe("writeSizeReport", () => {
  it("appends to $GITHUB_STEP_SUMMARY (keeping what an earlier step wrote)", () => {
    const f = path.join(dir, "summary.md");
    writeFileSync(f, "earlier step\n");
    expect(writeSizeReport(REPORT, CEIL, { GITHUB_STEP_SUMMARY: f })).toBe(true);
    const body = readFileSync(f, "utf8");
    expect(body.startsWith("earlier step\n### Token economy")).toBe(true);
    expect(body).toContain("19,483");
  });

  it("unset or empty → writes nothing and says so", () => {
    expect(writeSizeReport(REPORT, CEIL, {})).toBe(false);
    expect(writeSizeReport(REPORT, CEIL, { GITHUB_STEP_SUMMARY: "" })).toBe(false);
  });

  it("an unwritable summary never throws (the SIZE-REPORT log line still carries the numbers)", () => {
    const ro = path.join(dir, "ro");
    writeFileSync(ro, "");
    chmodSync(ro, 0o400);
    expect(writeSizeReport(REPORT, CEIL, { GITHUB_STEP_SUMMARY: ro })).toBe(false);
    expect(
      writeSizeReport(REPORT, CEIL, {
        GITHUB_STEP_SUMMARY: path.join(dir, "no", "such", "dir", "f"),
      }),
    ).toBe(false);
    expect(readFileSync(ro, "utf8")).toBe("");
  });
});
