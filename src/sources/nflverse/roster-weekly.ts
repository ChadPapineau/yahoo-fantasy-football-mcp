// roster-weekly.ts — `nflverse:roster_weekly` (research 04 §D: the crosswalk's id source; plan 10
// §3.1a): `weekly_rosters/roster_weekly_{season}.parquet` → `ds_roster_weekly` with gsis_id and the
// platform ids (yahoo/sleeper/espn/pfr/…). Empty ids become NULL (an empty id must never match a
// lookup); rows without a gsis_id are dropped and counted (5 in the 2026 file).
import { isoDate } from "../../store/datasets/derive.js";
import { DS_ROSTER_WEEKLY } from "../../store/datasets/tables.js";
import type { DataSource } from "../source.js";
import { eachRow, inFileSeason, makeNflverseSource } from "./base.js";
import { TableLoader, asInt, buildRow } from "./rows.js";

type Raw = Readonly<Record<string, unknown>>;

/** The derived ds_roster_weekly columns. */
export const ROSTER_DERIVATIONS: Readonly<Record<string, (raw: Raw) => unknown>> = Object.freeze({
  birth_date: (r: Raw) => isoDate(r.birth_date),
});

/** The weekly-roster DataSource. */
export const rosterWeeklySource: DataSource = makeNflverseSource({
  id: "nflverse:roster_weekly",
  tag: "weekly_rosters",
  file: (season) => `roster_weekly_${String(season)}.parquet`,
  async publish(files, into) {
    const roster = new TableLoader(into, DS_ROSTER_WEEKLY);
    await eachRow("nflverse:roster_weekly", files, (raw, file) => {
      if (inFileSeason(roster, asInt(raw.season), file)) {
        roster.add(buildRow(DS_ROSTER_WEEKLY, raw, ROSTER_DERIVATIONS));
      }
    });
    return { loaders: [roster], warnings: [] };
  },
});
