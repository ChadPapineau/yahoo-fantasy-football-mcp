// schedules.ts — `nflverse:schedules` (plan 01 §5.2 schedules row: kickoff, roof, lines; plan 10
// §3.1a): `schedules/games.parquet` (one file, every season since 1999) → `ds_games` for the run's
// seasons + the checked-in `ds_venues` reference (src/sources/venues.ts), in one dataset file so
// the reader joins them without crossing files. Kickoff: Eastern wall time → UTC (derive.ts, DST
// aware). Lines: spread_line is + = HOME favoured (nflverse dictionary; research 04 §C). The publish
// warns about venue facts the table may get wrong (a roof past the table's vintage, a neutral-site
// game resolved to the home team's stadium).
import type { GameLines } from "../../domain/analytics/types.js";
import {
  impliedPoints,
  kickoffUtcFromEastern,
  normalizeRoof,
} from "../../store/datasets/derive.js";
import { DS_GAMES, DS_VENUES } from "../../store/datasets/tables.js";
import type { DataSource } from "../source.js";
import { REFERENCE_VINTAGES } from "../../config/reference-vintage.js";
import { resolveVenueId, venueById, venueRows } from "../venues.js";
import { eachRow, makeNflverseSource } from "./base.js";
import { TableLoader, asInt, asReal, buildRow } from "./rows.js";

type Raw = Readonly<Record<string, unknown>>;

/** The derived ds_games columns (tables.ts derivations). */
export const GAME_DERIVATIONS: Readonly<Record<string, (raw: Raw) => unknown>> = Object.freeze({
  kickoff_utc: (r: Raw) => kickoffUtcFromEastern(r.gameday, r.gametime),
  roof: (r: Raw) => normalizeRoof(r.roof),
  venue_id: (r: Raw) => resolveVenueId(r.game_id, r.stadium_id, r.stadium),
});

/** One upstream games row → a ds_games row. */
export function gameRow(raw: Raw): Record<string, string | number | null> {
  return buildRow(DS_GAMES, raw, GAME_DERIVATIONS);
}

/** A game's betting lines as the reader exposes them, minus the stamp's `as_of`. */
export type GameLinesView = Omit<GameLines, "as_of">;

/**
 * The lines of a games / ds_games row: null when spread, total and both moneylines are all null
 * (READER_QUERIES ScheduleReader.games mapping), else the implied team totals
 * home = (total + spread) / 2, away = (total − spread) / 2 — positive spread = home favoured, so the
 * favourite always gets the larger total.
 */
export function gameLines(row: Raw): GameLinesView | null {
  const spread = asReal(row.spread_line);
  const total = asReal(row.total_line);
  const away = asInt(row.away_moneyline);
  const home = asInt(row.home_moneyline);
  if (spread === null && total === null && away === null && home === null) return null;
  return {
    spread_line: spread,
    total_line: total,
    implied: impliedPoints(spread, total),
    moneyline: { away, home },
  };
}

/**
 * A ds_games row as the publish-time venue checks read it (season, home_team, location, venue_id,
 * roof, game_type; anything else is ignored).
 */
export type VenueCheckRow = Readonly<Record<string, unknown>>;

const INDOOR = new Set(["dome", "closed"]);

/**
 * The publish-time venue checks (§4.6), one warning line per season with a finding:
 * - for a season past the venue table's vintage (REFERENCE_VINTAGES.venues), a game whose own roof
 *   says indoors/outdoors against what a fixed-roof or open-air venue's table entry says (the game
 *   row wins in the reader and the weather sources; the table may describe a stadium as it was);
 * - a game marked `location = "Neutral"` that resolved to its home team's usual home venue (the
 *   venue most of the team's non-neutral home games that season are at; a Super Bowl aside) — a
 *   neutral-site game whose real venue was not resolved, so its zone, coordinates and weather would
 *   be wrong.
 */
export function venueWarnings(rows: readonly VenueCheckRow[]): string[] {
  const vintage = REFERENCE_VINTAGES.venues.verified_through_season;
  const roofOff = new Map<number, number>();
  const homeVenues = new Map<string, Map<string, number>>();
  const neutral: { season: number; home: string; venue: string }[] = [];
  for (const r of rows) {
    const season = asInt(r.season);
    const venueId = typeof r.venue_id === "string" ? r.venue_id : null;
    const home = typeof r.home_team === "string" ? r.home_team : null;
    if (season === null || venueId === null || home === null) continue;
    const roof = typeof r.roof === "string" ? r.roof.trim().toLowerCase() : null;
    const venue = venueById(venueId);
    if (season > vintage && roof !== null && roof !== "" && venue !== null && !venue.retractable) {
      if (INDOOR.has(roof) !== INDOOR.has(venue.roof_default))
        roofOff.set(season, (roofOff.get(season) ?? 0) + 1);
    }
    // a Super Bowl may be played at a finalist's own stadium (e.g. at SoFi in February 2022)
    if (r.location === "Neutral") {
      if (r.game_type !== "SB") neutral.push({ season, home, venue: venueId });
    } else {
      const key = `${String(season)}|${home}`;
      const counts = homeVenues.get(key) ?? new Map<string, number>();
      counts.set(venueId, (counts.get(venueId) ?? 0) + 1);
      homeVenues.set(key, counts);
    }
  }
  const usual = (season: number, home: string): string | null => {
    const counts = homeVenues.get(`${String(season)}|${home}`);
    if (counts === undefined) return null;
    let best: string | null = null;
    let n = 0;
    for (const [v, c] of [...counts].sort(([a], [b]) => (a < b ? -1 : 1)))
      if (c > n) {
        best = v;
        n = c;
      }
    return best;
  };
  const neutralOff = new Map<number, number>();
  for (const g of neutral)
    if (usual(g.season, g.home) === g.venue)
      neutralOff.set(g.season, (neutralOff.get(g.season) ?? 0) + 1);
  const out: string[] = [];
  for (const [season, n] of [...roofOff].sort(([a], [b]) => a - b))
    out.push(
      `ds_games: ${String(n)} game(s) whose roof disagrees with the venue table (season ${String(season)})`,
    );
  for (const [season, n] of [...neutralOff].sort(([a], [b]) => a - b))
    out.push(
      `ds_games: ${String(n)} neutral-site game(s) resolved to the home team's own stadium (season ${String(season)})`,
    );
  return out;
}

/** The schedules DataSource. */
export const schedulesSource: DataSource = makeNflverseSource({
  id: "nflverse:schedules",
  tag: "schedules",
  file: { all: "games.parquet" },
  async publish(files, into) {
    const games = new TableLoader(into, DS_GAMES);
    const venues = new TableLoader(into, DS_VENUES);
    let unknownVenue = 0;
    let noKickoff = 0;
    const checked: VenueCheckRow[] = [];
    await eachRow("nflverse:schedules", files, (raw, file) => {
      // games.parquet holds every season: rows outside the file's season are the documented
      // row_filter, not an anomaly, so they are not counted.
      if (file.season !== null && asInt(raw.season) !== file.season) return;
      const row = gameRow(raw);
      if (!games.add(row)) return;
      if (row.venue_id === null) unknownVenue++;
      if (row.kickoff_utc === null) noKickoff++;
      checked.push(row);
    });
    for (const v of venueRows()) venues.add(v);
    const warnings: string[] = [];
    if (unknownVenue > 0) {
      warnings.push(
        `ds_games: ${String(unknownVenue)} game(s) at a venue not in src/sources/venues.ts`,
      );
    }
    if (noKickoff > 0)
      warnings.push(`ds_games: ${String(noKickoff)} game(s) without a kickoff time`);
    warnings.push(...venueWarnings(checked));
    return { loaders: [games, venues], warnings };
  },
});
