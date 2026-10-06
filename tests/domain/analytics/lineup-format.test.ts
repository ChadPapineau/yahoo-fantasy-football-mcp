// lineup-format.test.ts — QA-2-043: a league without head-to-head matchups (points-only, roto) has
// no opponent to beat, so E2 never reports a win probability there and its objective is forced to
// mean (plan 07 E2: "points leagues force objective: mean"; research 05 §3 format sensitivity) —
// whatever objective is asked for and whatever opponent the league file lists.
import { describe, expect, it } from "vitest";
import { analyzeLineup } from "../../../src/domain/analytics/lineup.js";
import type { Objective } from "../../../src/domain/analytics/types.js";
import { fixedClock } from "../../../src/domain/clock.js";
import { complete, dist, LEAGUE_SLOTS, NOW, player, recTextsFit } from "./helpers.js";

const clock = fixedClock(NOW);

function league() {
  const players = [
    player("QB", 21, { slot: "QB", points: dist(21, 9) }),
    player("WR", 14, { slot: "WR", points: dist(14, 8) }),
    player("WR", 12, { slot: "BN", points: dist(12, 11) }),
    player("RB", 13, { slot: "RB", points: dist(13, 7) }),
  ];
  const opponent = complete([
    player("QB", 18, { slot: "QB", nfl_team: "KC" }),
    player("WR", 15, { slot: "WR", nfl_team: "KC" }),
  ]);
  return { players, opponent };
}

describe("QA-2-043 — no head-to-head matchups: no P(win), objective mean", () => {
  const OBJECTIVES: readonly (Objective | undefined)[] = [undefined, "mean", "pwin", "blend"];
  for (const objective of OBJECTIVES)
    for (const withOpponent of [true, false])
      it(`objective ${String(objective)}, opponent ${withOpponent ? "listed" : "absent"}`, () => {
        const { players, opponent } = league();
        const r = analyzeLineup({
          slots: LEAGUE_SLOTS,
          players,
          opponent: withOpponent ? opponent : null,
          head_to_head: false,
          ...(objective === undefined ? {} : { objective }),
          clock,
        });
        expect(r.objective_used).toBe("mean");
        expect(r.rec.decision_metric).toBe("expected_points");
        expect([r.p_win_before, r.p_win_after, r.p_win_interval]).toEqual([null, null, null]);
        expect(r.mode).toBe("neutral");
        const a = r.rec.assumptions.find((x) => x.text.startsWith("a points-only league"));
        expect(a, JSON.stringify(r.rec.assumptions)).toBeDefined();
        if (objective === "pwin" || objective === "blend")
          expect(a?.text).toContain(`(not ${objective})`);
        // never sent to add an opponents entry that would not help
        expect(r.rec.assumptions.some((x) => x.text.startsWith("no opponent for this week"))).toBe(
          false,
        );
        expect(recTextsFit(r.rec)).toBe(true);
      });

  it("a head-to-head league with the same opponent keeps P(win) and honours pwin", () => {
    const { players, opponent } = league();
    for (const h2h of [true, undefined]) {
      const r = analyzeLineup({
        slots: LEAGUE_SLOTS,
        players,
        opponent,
        ...(h2h === undefined ? {} : { head_to_head: h2h }),
        objective: "pwin",
        clock,
      });
      expect(r.objective_used).toBe("pwin");
      expect(r.p_win_before).not.toBeNull();
    }
  });
});
