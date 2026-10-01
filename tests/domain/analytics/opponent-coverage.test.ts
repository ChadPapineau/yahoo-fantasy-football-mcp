// opponent-coverage.test.ts — QA-1-043: a win probability is never computed against empty seats
// scored 0. An opponent typed in partially (one QB) fills only some starting seats — P(win) 1.0 with
// interval [1, 1] from missing data: E3 refuses (NOT_FOUND, naming the empty seats), E2 `pwin`
// refuses, and E2 `mean` withholds P(win) and says which seats are empty. An opponent missing only his
// K/DEF (the usual omission) gets a named stand-in at my own starter's projection there, so P(win)
// is close to the full-roster number instead of inflated (0.75 → 0.88 in the report).
import { describe, expect, it } from "vitest";
import { AnalyticsError } from "../../../src/domain/analytics/errors.js";
import { analyzeLineup, type LineupPlayer } from "../../../src/domain/analytics/lineup.js";
import { analyzeMatchupPre } from "../../../src/domain/analytics/matchup.js";
import { fixedClock, seededRng } from "../../../src/domain/clock.js";
import { dist, LEAGUE_SLOTS, NOW, player } from "./helpers.js";

const clock = fixedClock(NOW);

/** A full starting nine in their slots (QB, WR×2, RB×2, TE, W/R/T, K, DEF). */
function nine(slotted = true): LineupPlayer[] {
  const s = (slot: string) => (slotted ? slot : "BN");
  return [
    player("QB", 20, { slot: s("QB") }),
    player("WR", 14, { slot: s("WR") }),
    player("WR", 12, { slot: s("WR") }),
    player("RB", 13, { slot: s("RB") }),
    player("RB", 11, { slot: s("RB") }),
    player("TE", 9, { slot: s("TE") }),
    player("WR", 10, { slot: s("W/R/T") }),
    player("K", 8, { slot: s("K"), points: dist(8, 3) }),
    player("DEF", 7, { slot: s("DEF"), points: dist(7, 4) }),
  ];
}
const mine = nine();
const full = nine();
const noKdef = full.filter((p) => p.positions[0] !== "K" && p.positions[0] !== "DEF");
const qbOnly = full.filter((p) => p.positions[0] === "QB");

const e3 = (opponent: LineupPlayer[]) =>
  analyzeMatchupPre({
    slots: LEAGUE_SLOTS,
    players: mine,
    opponent,
    clock,
    rng: seededRng(1),
    method: "normal",
  });

const refusal = (f: () => unknown): AnalyticsError => {
  try {
    f();
  } catch (e) {
    if (e instanceof AnalyticsError) return e;
    throw e;
  }
  throw new Error("expected a refusal");
};

describe("QA-1-043 — P(win) needs the opponent's full starting lineup", () => {
  it("E3: a full opponent gives a number; a partial one is refused, naming the empty seats", () => {
    expect(e3(full).p_win).toBeGreaterThan(0);
    const e = refusal(() => e3(qbOnly));
    expect(e.code).toBe("incomplete_opponent");
    expect(e.ffCode).toBe("NOT_FOUND");
    expect([...e.detail].sort()).toEqual(["RB", "RB", "TE", "W/R/T", "WR", "WR"]);
  });

  it("E3: an opponent missing only his K and DEF — stand-ins, named; P(win) not inflated", () => {
    const whole = e3(full);
    const partial = e3(noKdef);
    // full's K/DEF match mine (8, 7) by construction, so the stand-ins reproduce the full number
    expect(partial.p_win).toBeCloseTo(whole.p_win, 2);
    expect(partial.mu_o).toBeCloseTo(whole.mu_o, 6);
    expect(
      partial.rec.assumptions.some((a) =>
        a.text.startsWith("the opponent's listed players leave his K, DEF slot empty"),
      ),
    ).toBe(true);
  });

  it("E2 mean: P(win) withheld (never 1.0 from missing data), the empty seats named", () => {
    const r = analyzeLineup({ slots: LEAGUE_SLOTS, players: mine, opponent: qbOnly, clock });
    expect(r.p_win_before).toBeNull();
    expect(r.p_win_after).toBeNull();
    expect(r.p_win_interval).toBeNull();
    expect(r.mode).toBe("neutral");
    expect(
      r.rec.assumptions.some((a) =>
        a.text.startsWith("the opponent's listed players leave starting slots empty"),
      ),
    ).toBe(true);
    const ok = analyzeLineup({ slots: LEAGUE_SLOTS, players: mine, opponent: full, clock });
    expect(ok.p_win_before).not.toBeNull();
  });

  it("E2 pwin / blend: an empty skill seat falls back to mean with P(win) withheld, said so", () => {
    for (const objective of ["pwin", "blend"] as const) {
      const d = analyzeLineup({
        slots: LEAGUE_SLOTS,
        players: mine,
        opponent: qbOnly,
        objective,
        clock,
      });
      expect(d.objective_used).toBe("mean");
      expect([d.p_win_before, d.p_win_after, d.p_win_interval]).toEqual([null, null, null]);
      expect(d.rec.decision_metric).toBe("expected_points");
      expect(
        d.rec.assumptions.some((a) => a.text.includes(`the objective is mean (not ${objective})`)),
      ).toBe(true);
      // K/DEF-only gaps: the stand-ins reproduce the full-roster number
      const r = analyzeLineup({
        slots: LEAGUE_SLOTS,
        players: mine,
        opponent: noKdef,
        objective,
        clock,
      });
      const w = analyzeLineup({
        slots: LEAGUE_SLOTS,
        players: mine,
        opponent: full,
        objective,
        clock,
      });
      expect(r.objective_used).toBe(objective);
      expect(r.p_win_before).toBeCloseTo(w.p_win_before ?? Number.NaN, 2);
    }
    expect(() =>
      analyzeLineup({
        slots: LEAGUE_SLOTS,
        players: mine,
        opponent: null,
        objective: "pwin",
        clock,
      }),
    ).toThrow(AnalyticsError);
  });

  it("an opponent whose listed players sit on his bench still fills his seats (best legal lineup)", () => {
    expect(e3(nine(false)).p_win).toBeGreaterThan(0);
  });
});
