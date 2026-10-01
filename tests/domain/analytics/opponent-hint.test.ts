// opponent-hint.test.ts — QA-1-069: under the manual league "no opponent" has two causes — no
// `opponents:` entry for the week (the usual one: the roster is already under other_teams), or an
// entry whose team lists no players. E2's assumption names both, so a user is not sent to re-type a
// roster that is already in the file.
import { describe, expect, it } from "vitest";
import { analyzeLineup } from "../../../src/domain/analytics/lineup.js";
import { fixedClock } from "../../../src/domain/clock.js";
import { LEAGUE_SLOTS, NOW, player, recTextsFit } from "./helpers.js";

describe("QA-1-069 — E2 names what is missing when there is no opponent", () => {
  it("the assumption names the opponents entry and the team's players", () => {
    const r = analyzeLineup({
      slots: LEAGUE_SLOTS,
      players: [player("QB", 20, { slot: "QB" })],
      opponent: null,
      clock: fixedClock(NOW),
    });
    const a = r.rec.assumptions.find((x) => x.text.startsWith("no opponent"));
    expect(a?.text).toContain("opponents");
    expect(a?.revisit_trigger).toContain("opponents");
    expect(a?.revisit_trigger).toContain("other_teams");
    expect(a?.revisit_trigger).not.toBe("the opponent's roster is added to league.yaml");
    expect(recTextsFit(r.rec)).toBe(true);
  });
});
