// schedules.ts — `nflverse:schedules` (plan 01 §5.2 schedules row: kickoff, roof, lines; plan 10
// §3.1a): `schedules/games.parquet` (one file, every season since 1999) → `ds_games` for the run's
// seasons + the checked-in `ds_venues` reference (src/sources/venues.ts), in one dataset file so
// the reader joins them without crossing files. Kickoff: Eastern wall time → UTC (derive.ts, DST
// aware). Lines: spread_line is + = HOME favoured (nflverse dictionary; research 04 §C).
import type { GameLines } from "../../domain/analytics/types.js";
import {
  impliedPoints,
  kickoffUtcFromEastern,
  normalizeRoof,
} from "../../store/datasets/derive.js";
import { DS_GAMES, DS_VENUES } from "../../store/datasets/tables.js";
import type { DataSource } from "../source.js";
import { resolveVenueId, venueRows } from "../venues.js";
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
    await eachRow("nflverse:schedules", files, (raw, file) => {
      // games.parquet holds every season: rows outside the file's season are the documented
      // row_filter, not an anomaly, so they are not counted.
      if (file.season !== null && asInt(raw.season) !== file.season) return;
      const row = gameRow(raw);
      if (!games.add(row)) return;
      if (row.venue_id === null) unknownVenue++;
      if (row.kickoff_utc === null) noKickoff++;
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
    return { loaders: [games, venues], warnings };
  },
});
