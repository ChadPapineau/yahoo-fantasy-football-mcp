// helpers.ts — synthetic league pieces for the analytics unit/property tests: the fixture league's
// slot table, Dists of a given mean/width, and LineupPlayers.
import type { LineupPlayer } from "../../../src/domain/analytics/lineup.js";
import { buildRosterSlots, defineSlot } from "../../../src/domain/league/slots.js";
import type { RosterSlot, RosterSlots } from "../../../src/domain/league/types.js";
import type { Dist, DistBasis } from "../../../src/domain/scoring/types.js";
import type { NflTeam } from "../../../src/config/schema.js";

export const NOW = Date.parse("2026-09-27T12:00:00Z");
export const PAST = "2026-09-25T00:15:00.000Z"; // Thursday night (ET) — already locked
export const SUN_1PM = "2026-09-27T17:00:00.000Z";
export const SUN_425 = "2026-09-27T20:25:00.000Z";
export const THU = PAST; // Thursday 8:15 pm ET (locked at NOW; open at TUESDAY)
export const TUESDAY = Date.parse("2026-09-22T12:00:00Z");
export const MON = "2026-09-29T00:15:00.000Z"; // Monday 8:15 pm ET

export function slotsOf(defs: readonly { name: string; count: number }[]): RosterSlots {
  return buildRosterSlots(
    defs.map((d) => {
      const s = defineSlot(d);
      if (typeof s === "string") throw new Error(`bad slot ${d.name}: ${s}`);
      return s satisfies RosterSlot;
    }),
  );
}

/** The fixture league's slots: QB, WR×2, RB×2, TE, W/R/T, K, DEF, BN×6, IR×2. */
export const LEAGUE_SLOTS = slotsOf([
  { name: "QB", count: 1 },
  { name: "WR", count: 2 },
  { name: "RB", count: 2 },
  { name: "TE", count: 1 },
  { name: "W/R/T", count: 1 },
  { name: "K", count: 1 },
  { name: "DEF", count: 1 },
  { name: "BN", count: 6 },
  { name: "IR", count: 2 },
]);

/** A Dist with the given mean and half-width (p10 = mean − w, p90 = mean + w). */
export function dist(mean: number, w = mean * 0.6, basis: DistBasis = "position_cv"): Dist {
  return {
    mean,
    p10: mean - w,
    p25: mean - w / 2,
    p50: mean,
    p75: mean + w / 2,
    p90: mean + w,
    p_zero: 0,
    basis,
  };
}

let seq = 0;
/** A LineupPlayer (defaults: unlocked Sunday 1 pm, active, bench). */
export function player(
  position: string,
  mean: number,
  over: Partial<LineupPlayer> = {},
): LineupPlayer {
  seq += 1;
  return {
    player_key: `manual.p.00-${String(1000000 + seq).padStart(7, "0")}`,
    name: `Player ${String(seq)}`,
    positions: [position],
    status: null,
    nfl_team: "BUF" satisfies NflTeam,
    gsis_id: null,
    slot: "BN",
    lock_at: SUN_1PM,
    points: dist(mean),
    p_active: 1,
    role_games: 3,
    ...over,
  };
}
