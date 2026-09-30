// injuries.ts — `nflverse:injuries` (plan 01 §5.2 injuries row; plan 10 §3.1a):
// `injuries/injuries_{season}.parquet` → `ds_injuries`. The file has ONE practice status per
// player-week and no timestamp column (observed 2026-09-30), so the reader's `practice` is a single
// `week` entry and `as_of` is the release stamp (tables.ts READER_QUERIES InjuryReader.reports).
import { DS_INJURIES } from "../../store/datasets/tables.js";
import type { DataSource } from "../source.js";
import { eachRow, inFileSeason, makeNflverseSource } from "./base.js";
import { TableLoader, asInt, buildRow } from "./rows.js";

/** The injuries DataSource. */
export const injuriesSource: DataSource = makeNflverseSource({
  id: "nflverse:injuries",
  tag: "injuries",
  file: (season) => `injuries_${String(season)}.parquet`,
  async publish(files, into) {
    const injuries = new TableLoader(into, DS_INJURIES);
    await eachRow("nflverse:injuries", files, (raw, file) => {
      if (inFileSeason(injuries, asInt(raw.season), file)) injuries.add(buildRow(DS_INJURIES, raw));
    });
    return { loaders: [injuries], warnings: [] };
  },
});
