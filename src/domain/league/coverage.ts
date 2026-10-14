// coverage.ts — whether a dataset file covers the season a read asks for (season-fresh spec §3.3):
// a new season that upstream has not published yet is a named, non-fatal state (`not_published`,
// from a recent season_check), never an outage, and a finished season's data does not age
// (`complete`). Pure: the stamp, the phase and the season_check row come in.
import type { DatasetStamp, SeasonCheckRow } from "../analytics/types.js";
import type { SeasonPhase } from "./season.js";
import type { IsoInstant } from "./types.js";

/**
 * `covered` — the file holds the season (or its seasons are unknown): judged by `stampState`;
 * `complete` — covered and before the phase season: an `expired` judgment is served as `stale`;
 * `not_published` — not in the file, and the latest season_check says upstream has not published it
 * (checked within the class's hard limit);
 * `missing` — otherwise (never loaded, or the season simply absent).
 */
export type CoverageState = "covered" | "complete" | "not_published" | "missing";

/** A read's coverage, with the instant it rests on (the stamp's or the season check's). */
export interface Coverage {
  readonly state: CoverageState;
  readonly season: number;
  readonly checked_at: IsoInstant | null;
}

/** The coverage of `season` by a source's attached file (§3.3). */
export function datasetCoverage(i: {
  readonly stamp: DatasetStamp | null;
  readonly season: number;
  readonly phase: SeasonPhase;
  readonly check: SeasonCheckRow | null;
  readonly hardLimitSeconds: number | null;
  readonly nowMs: number;
}): Coverage {
  const { stamp, season, check } = i;
  if (stamp !== null && (stamp.seasons === undefined || stamp.seasons.includes(season)))
    return Object.freeze({
      state: season < i.phase.season ? "complete" : "covered",
      season,
      checked_at: stamp.checked_at,
    });
  if (
    check !== null &&
    check.season === season &&
    check.status === "not_published" &&
    (stamp === null || check.source === stamp.source)
  ) {
    const at = Date.parse(check.checked_at);
    const recent =
      Number.isFinite(at) &&
      (i.hardLimitSeconds === null || i.nowMs - at <= i.hardLimitSeconds * 1000);
    if (recent)
      return Object.freeze({ state: "not_published", season, checked_at: check.checked_at });
  }
  return Object.freeze({ state: "missing", season, checked_at: null });
}
