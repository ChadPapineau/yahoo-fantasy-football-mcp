// fixtures.ts — NflGame + slot fixtures for the league-model tests: real 2026 week-1 kickoffs (nflverse
// schedules, CC-BY 4.0; ET wall times converted to UTC by hand, EDT = UTC−4) including the
// Wednesday opener, the Melbourne Thursday game and Monday night, plus the week-4 London game.
import type { NflTeam } from "../../../src/config/schema.js";
import type { NflGame } from "../../../src/domain/analytics/types.js";
import { buildRosterSlots, defineSlot } from "../../../src/domain/league/slots.js";
import type { RosterSlot } from "../../../src/domain/league/types.js";

/** Builds a game with the fields the league model reads; everything else neutral. */
export function game(
  game_id: string,
  week: number,
  away: NflTeam,
  home: NflTeam,
  kickoff: string | null,
  opts: { season?: number; is_final?: boolean; stadium_id?: string | null } = {},
): NflGame {
  return {
    game_id,
    season: opts.season ?? 2026,
    week,
    kickoff,
    away,
    home,
    stadium_id: opts.stadium_id ?? null,
    stadium: null,
    venue_tz: null,
    roof: null,
    surface: null,
    divisional: null,
    rest_days: { away: null, home: null },
    lines: null,
    is_final: opts.is_final ?? false,
    score: null,
  };
}

/** 2026 week 1 (all 16 games). */
export const WEEK1: readonly NflGame[] = [
  game("2026_01_NE_SEA", 1, "NE", "SEA", "2026-09-10T00:20:00.000Z"), // Wed 20:20 ET
  game("2026_01_SF_LA", 1, "SF", "LA", "2026-09-11T00:35:00.000Z", { stadium_id: "MEL00" }), // Thu, Melbourne
  game("2026_01_CHI_CAR", 1, "CHI", "CAR", "2026-09-13T17:00:00.000Z"),
  game("2026_01_TB_CIN", 1, "TB", "CIN", "2026-09-13T17:00:00.000Z"),
  game("2026_01_NO_DET", 1, "NO", "DET", "2026-09-13T17:00:00.000Z"),
  game("2026_01_BUF_HOU", 1, "BUF", "HOU", "2026-09-13T17:00:00.000Z"),
  game("2026_01_BAL_IND", 1, "BAL", "IND", "2026-09-13T17:00:00.000Z"),
  game("2026_01_CLE_JAX", 1, "CLE", "JAX", "2026-09-13T17:00:00.000Z"),
  game("2026_01_ATL_PIT", 1, "ATL", "PIT", "2026-09-13T17:00:00.000Z"),
  game("2026_01_NYJ_TEN", 1, "NYJ", "TEN", "2026-09-13T17:00:00.000Z"),
  game("2026_01_ARI_LAC", 1, "ARI", "LAC", "2026-09-13T20:25:00.000Z"),
  game("2026_01_MIA_LV", 1, "MIA", "LV", "2026-09-13T20:25:00.000Z"),
  game("2026_01_GB_MIN", 1, "GB", "MIN", "2026-09-13T20:25:00.000Z"),
  game("2026_01_WAS_PHI", 1, "WAS", "PHI", "2026-09-13T20:25:00.000Z"),
  game("2026_01_DAL_NYG", 1, "DAL", "NYG", "2026-09-14T00:20:00.000Z"), // Sun night
  game("2026_01_DEN_KC", 1, "DEN", "KC", "2026-09-15T00:15:00.000Z"), // Mon 20:15 ET
];

/** Selected week-4 games: the London (Tottenham) 09:30 ET game and a late Sunday game. */
export const WEEK4_PART: readonly NflGame[] = [
  game("2026_04_IND_WAS", 4, "IND", "WAS", "2026-10-04T13:30:00.000Z", { stadium_id: "LON02" }),
  game("2026_04_X_LATE", 4, "BUF", "KC", "2026-10-04T20:25:00.000Z"),
  game("2026_04_X_MNF", 4, "DET", "SEA", "2026-10-06T00:15:00.000Z"),
];

/** Defines a slot or throws (fixtures only). */
export function slot(name: string, count = 1, eligible?: string[]): RosterSlot {
  const r = defineSlot({ name, count, eligible });
  if (typeof r === "string") throw new Error(`fixture slot ${name}: ${r}`);
  return r;
}

/** The validation league's slots (QB, WR×2, RB×2, TE, W/R/T, K, DEF, BN×6, IR×2). */
export const VALIDATION_SLOTS = buildRosterSlots([
  slot("QB"),
  slot("WR", 2),
  slot("RB", 2),
  slot("TE"),
  slot("W/R/T"),
  slot("K"),
  slot("DEF"),
  slot("BN", 6),
  slot("IR", 2),
]);
