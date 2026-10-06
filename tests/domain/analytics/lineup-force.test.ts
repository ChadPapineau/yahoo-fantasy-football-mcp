// lineup-force.test.ts — QA-1-010 (reopened in round 2): a `force_start` the engine cannot honour is
// refused, never dropped silently. Two QBs forced into one QB seat, a forced player on IR, or a
// forced reserve whose game has started used to come back as an ordinary answer with the forced
// player benched and nothing said. Property: for any roster and any forced set, E2 either starts
// every forced player — in the recommended lineup AND in the rec that is logged — or refuses.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { AnalyticsError } from "../../../src/domain/analytics/errors.js";
import { analyzeLineup } from "../../../src/domain/analytics/lineup.js";
import { fixedClock } from "../../../src/domain/clock.js";
import { dist, LEAGUE_SLOTS, NOW, PAST, player, SUN_1PM, slotsOf } from "./helpers.js";

const clock = fixedClock(NOW);
const STARTING = (slot: string): boolean => slot !== "BN" && slot !== "IR";

function refused(f: () => unknown): boolean {
  try {
    f();
    return false;
  } catch (e) {
    if (e instanceof AnalyticsError && e.code === "invalid_request") {
      expect(e.detail).toEqual(["force_start"]);
      return true;
    }
    throw e;
  }
}

describe("QA-1-010 reopened — force_start is honoured or refused", () => {
  const ONE_QB = slotsOf([
    { name: "QB", count: 1 },
    { name: "BN", count: 4 },
    { name: "IR", count: 1 },
  ]);

  it("two QBs forced into one QB seat: refused", () => {
    const a = player("QB", 22, { slot: "QB" });
    const b = player("QB", 17, { slot: "BN" });
    expect(
      refused(() =>
        analyzeLineup({
          slots: ONE_QB,
          players: [a, b],
          opponent: null,
          force_start: [a.player_key, b.player_key],
          clock,
        }),
      ),
    ).toBe(true);
  });

  it("a forced player on IR, or a forced reserve already locked: refused", () => {
    const a = player("QB", 22, { slot: "QB" });
    const ir = player("QB", 17, { slot: "IR", status: "O" });
    const lockedBench = player("QB", 15, { slot: "BN", lock_at: PAST });
    for (const f of [ir, lockedBench])
      expect(
        refused(() =>
          analyzeLineup({
            slots: ONE_QB,
            players: [a, ir, lockedBench],
            opponent: null,
            force_start: [f.player_key],
            clock,
          }),
        ),
      ).toBe(true);
  });

  it("property: every forced player starts in recommended_lineup and rec.lineup, or E2 refuses", () => {
    const POS = ["QB", "WR", "RB", "TE"] as const;
    const cap: Record<string, number> = { QB: 1, WR: 2, RB: 2, TE: 1 };
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            pos: fc.constantFrom(...POS),
            mean: fc.integer({ min: 1, max: 30 }),
            w: fc.double({ min: 0.05, max: 1, noNaN: true }),
            where: fc.constantFrom("start", "bench", "bench", "ir"),
            locked: fc.boolean(),
            forced: fc.boolean(),
          }),
          { minLength: 1, maxLength: 12 },
        ),
        (specs) => {
          const taken = new Map<string, number>();
          let ir = 0;
          const players = specs.map((s) => {
            let slot = "BN";
            if (s.where === "start" && (taken.get(s.pos) ?? 0) < (cap[s.pos] ?? 0)) {
              taken.set(s.pos, (taken.get(s.pos) ?? 0) + 1);
              slot = s.pos;
            } else if (s.where === "ir" && ir < 2) {
              ir += 1;
              slot = "IR";
            }
            return player(s.pos, s.mean, {
              slot,
              status: slot === "IR" ? "O" : null,
              points: dist(s.mean, s.mean * s.w),
              lock_at: s.locked ? PAST : SUN_1PM,
            });
          });
          const force = players
            .filter((_, i) => specs[i]?.forced === true)
            .map((p) => p.player_key);
          let r: ReturnType<typeof analyzeLineup> | null = null;
          const no = refused(() => {
            r = analyzeLineup({
              slots: LEAGUE_SLOTS,
              players,
              opponent: null,
              force_start: force,
              clock,
              fills_in_swaps: true,
            });
          });
          if (no) return;
          const out = r as ReturnType<typeof analyzeLineup> | null;
          if (out === null) throw new Error("no result");
          const rec = new Set(
            out.recommended_lineup.filter((a) => STARTING(a.slot)).map((a) => a.player_key),
          );
          const logged = new Set(
            (out.rec.lineup ?? []).filter((a) => STARTING(a.slot)).map((a) => a.player_key),
          );
          for (const k of force) {
            expect(rec.has(k), `${k} recommended`).toBe(true);
            expect(logged.has(k), `${k} in the rec`).toBe(true);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
