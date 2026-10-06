// qa2-045-scoring-brackets.test.ts — QA round 2 regression: QA-2-045. league.yaml can state the
// missed-FG penalties and yards-allowed brackets a league scores (plan 08 §3.1 `fg_miss_*`,
// `dst_ya_*`; plan 01 §8 "the same normalised shape the Yahoo normaliser produces"), the engine
// scores them, and what cannot be stated (a TE premium) gets a reason that says so, value-free.
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { score } from "../../../src/domain/scoring/engine.js";
import type { ScoringSettings, StatLine } from "../../../src/domain/scoring/types.js";
import { DST_YA_BINS, FG_MISS_BINS, OVERRIDES_HINT } from "../../../src/providers/manual/schema.js";
import {
  EXAMPLE_LEAGUE,
  edit,
  loadIssues,
  provider,
  tempLeague,
  type TempLeague,
} from "./helpers.js";

let t: TempLeague;
beforeEach(() => {
  t = tempLeague();
});
afterEach(() => {
  t.cleanup();
});

const ANCHOR = "    pass_int: -1\n";
const withOverrides = (lines: readonly string[]): string =>
  edit(ANCHOR, `${ANCHOR}${lines.map((l) => `    ${l}\n`).join("")}`);

async function settingsOf(text: string): Promise<ScoringSettings> {
  t.write(text);
  return (await provider(t.file).getScoringSettings(EXAMPLE_LEAGUE)).value;
}

const line = (pt: StatLine["position_type"], values: Record<string, number>): StatLine => ({
  values,
  present: Object.keys(values).sort(),
  position_type: pt,
  provisional: false,
  source: "nflverse",
});

// Yahoo's yards-allowed bins, and ESPN/Sleeper's finer ones
const YAHOO_YA: readonly [string, number][] = [
  ["dst_ya_0_99", 5],
  ["dst_ya_100_199", 3],
  ["dst_ya_200_299", 2],
  ["dst_ya_300_399", 0],
  ["dst_ya_400_499", -1],
  ["dst_ya_500p", -3],
];
const ESPN_YA: readonly [string, number][] = [
  ["dst_ya_0_99", 5],
  ["dst_ya_100_199", 3],
  ["dst_ya_200_299", 2],
  ["dst_ya_300_349", 0],
  ["dst_ya_350_399", -1],
  ["dst_ya_400_449", -3],
  ["dst_ya_450_499", -5],
  ["dst_ya_500_549", -6],
  ["dst_ya_550p", -7],
];
const bounds = (k: string): [number, number] => {
  const m = /^dst_ya_(\d+)(?:_(\d+)|p)$/.exec(k);
  if (m === null) throw new Error(k);
  return [Number(m[1]), m[2] === undefined ? Infinity : Number(m[2])];
};

describe("QA-2-045: missed-FG penalties and yards-allowed brackets in league.yaml", () => {
  it("every missed-FG bin loads, and a miss in that bin costs exactly its value; unlisted bins cost 0", async () => {
    for (const bin of FG_MISS_BINS) {
      const s = await settingsOf(withOverrides([`${bin}: -1`]));
      expect(s.brackets.some((f) => f.family === "fg_miss_distance")).toBe(true);
      for (const other of FG_MISS_BINS) {
        const pts = score(line("K", { [other]: 1 }), s).points_exact;
        expect(pts, `${bin} set, miss in ${other}`).toBe(other === bin ? -1 : 0);
      }
    }
  });

  it("any subset of missed-FG bins loads (non-adjacent ones too) and each miss costs its own value", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.subarray([...FG_MISS_BINS], { minLength: 1 }),
        fc.integer({ min: -5, max: 0 }),
        async (set, v) => {
          const s = await settingsOf(withOverrides(set.map((b) => `${b}: ${String(v)}`)));
          for (const b of FG_MISS_BINS)
            expect(score(line("K", { [b]: 2 }), s).points_exact).toBe(set.includes(b) ? 2 * v : 0);
        },
      ),
      { numRuns: 40 },
    );
  });

  it("yards-allowed brackets (Yahoo's and ESPN's) score the bin the yards fall in, for any yardage", async () => {
    for (const family of [YAHOO_YA, ESPN_YA]) {
      const s = await settingsOf(withOverrides(family.map(([k, v]) => `${k}: ${String(v)}`)));
      const base = score(line("DT", { dst_ya: 0 }), s).points_exact - (family[0]?.[1] ?? 0);
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 900 }), (ya) => {
          const hit = family.find(([k]) => {
            const [lo, hi] = bounds(k);
            return ya >= lo && ya <= hi;
          });
          expect(score(line("DT", { dst_ya: ya }), s).points_exact - base).toBe(hit?.[1]);
        }),
        { numRuns: 200 },
      );
    }
  });

  it("a file without them scores exactly as before (the settings hash is unchanged)", async () => {
    const before = await settingsOf(edit("", ""));
    const again = await settingsOf(withOverrides([]));
    expect(again.settings_hash).toBe(before.settings_hash);
    expect(before.brackets.map((f) => f.family)).not.toContain("fg_miss_distance");
    expect(before.brackets.map((f) => f.family)).not.toContain("dst_yards_allowed");
  });

  const drop = (family: readonly [string, number][], ...keys: string[]): string[] =>
    family.filter(([k]) => !keys.includes(k)).map(([k, v]) => `${k}: ${String(v)}`);
  it.each([
    ["a gap", drop(YAHOO_YA, "dst_ya_100_199")],
    ["an overlap", [...drop(YAHOO_YA), "dst_ya_300_349: 0"]],
    ["two open-ended bins", [...drop(ESPN_YA), "dst_ya_500p: -6"]],
    ["no open-ended last bin", drop(YAHOO_YA, "dst_ya_500p")],
    ["no bin from 0", drop(ESPN_YA, "dst_ya_0_99")],
    ["a single closed bin", ["dst_ya_0_99: 5"]],
  ])(
    "yards-allowed brackets with %s are an issue, not a silent last-bin score",
    async (_l, lines) => {
      const r = await loadIssues(t, withOverrides(lines));
      const issue = r.split("\n").find((l) => l.startsWith("scoring.overrides: "));
      expect(issue, r).toMatch(
        /^scoring\.overrides: yards-allowed brackets \(dst_ya_\*\) must run from 0/,
      );
      // value-free: only the fixed vocabulary of the reason, never the bins the file listed
      const named = issue?.match(/dst_ya_\d\w*/g) ?? [];
      expect(named.every((n) => ["dst_ya_0_99", "dst_ya_500p", "dst_ya_550p"].includes(n))).toBe(
        true,
      );
    },
  );

  it("a TE premium or any other unknown key says what overrides accept and what cannot be stated, never the key", async () => {
    for (const k of ["rec_te: 0.5", "te_premium: 0.5", "Zqxv_custom: 1"]) {
      const r = await loadIssues(t, withOverrides([k]), "Zqxv");
      expect(r).toContain(`scoring.overrides: unknown key(s) (1): ${OVERRIDES_HINT}`);
      expect(r).not.toContain(k.split(":")[0] ?? "");
    }
    expect(OVERRIDES_HINT).toMatch(/TE premium/);
    expect(OVERRIDES_HINT).toMatch(/fg_miss_0_19/);
    expect(OVERRIDES_HINT).toMatch(/dst_ya_0_99/);
  });

  it("the accepted yards-allowed bin names are exactly Yahoo's and ESPN/Sleeper's", () => {
    expect([...DST_YA_BINS].sort()).toEqual(
      [...new Set([...YAHOO_YA, ...ESPN_YA].map(([k]) => k))].sort(),
    );
  });
});
