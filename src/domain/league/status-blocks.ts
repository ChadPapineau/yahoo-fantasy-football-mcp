// status-blocks.ts — the `season` and `schedule` blocks G1 (`ff_get_status`) and `ff status` both
// print (season-fresh spec §4.5, §5.2, §8.9): built here once, so the two surfaces agree by
// construction. Pure: the schedule view, the season checks, the recent changes and the instant come in.
import { freshnessClass, SOURCE_REGISTRY, type DatasetSourceId } from "../../config/freshness.js";
import {
  inHotWindow,
  type CalendarBasis,
  type CalendarFallbackReason,
} from "../../config/game-calendar.js";
import { pastVintage, type VintageWarning } from "../../config/reference-vintage.js";
import { TOOL_INPUT_WEEK_MAX } from "../../config/weeks.js";
import type { ScheduleChange, ScheduleChangeKind, SeasonCheckRow } from "../analytics/types.js";
import type { ScheduleView } from "./calendar.js";
import { matchupLabel, type TentativeWeek } from "./kickoff-status.js";
import type { SeasonPhaseName } from "./season.js";
import type { IsoInstant, Week } from "./types.js";

/** At most this many not-published seasons in the season block. */
export const NOT_PUBLISHED_MAX = 10;
/** At most this many recent changes in the schedule block (then a count). */
export const RECENT_CHANGES_MAX = 10;

/** One not-published season. */
export interface NotPublishedEntry {
  readonly source: DatasetSourceId;
  readonly season: number;
  readonly checked_at: IsoInstant;
}

/** Where the NFL season is, and whether the league file and reference tables keep up with it. */
export interface SeasonBlock {
  readonly nfl_season: number;
  readonly phase: SeasonPhaseName;
  readonly basis: "schedule" | "bootstrap";
  readonly week: Week | null;
  readonly next_kickoff: IsoInstant | null;
  readonly league_season: number | null;
  /** null without a league file; false when the league file is for another season (§4.5 row 23). */
  readonly league_matches: boolean | null;
  /** Phase-season files upstream has not published yet (a recent season_check), ≤ 10. */
  readonly not_published: readonly NotPublishedEntry[];
  readonly reference_past_vintage: readonly VintageWarning[];
  /** A loaded season's last week exceeds the tool-input bound (contract-2 reopen trigger). */
  readonly week_bound_exceeded: boolean;
}

/**
 * The season block. `league_matches`: equal seasons in preseason, regular season and postseason; in
 * the offseason the league file may hold the finished season or the next one (draft preparation).
 */
export function seasonBlock(
  view: ScheduleView,
  leagueSeason: number | null,
  checks: readonly SeasonCheckRow[],
  nowMs: number,
): SeasonBlock {
  const p = view.phase;
  const notPublished = checks
    .filter((c) => {
      if (c.status !== "not_published" || c.season !== p.season) return false;
      const at = Date.parse(c.checked_at);
      const hard = freshnessClass(SOURCE_REGISTRY[c.source].freshness).hardLimitSeconds;
      return Number.isFinite(at) && (hard === null || nowMs - at <= hard * 1000);
    })
    .sort((a, b) => a.source.localeCompare(b.source) || a.season - b.season)
    .slice(0, NOT_PUBLISHED_MAX)
    .map((c) => Object.freeze({ source: c.source, season: c.season, checked_at: c.checked_at }));
  return Object.freeze({
    nfl_season: p.season,
    phase: p.phase,
    basis: p.basis,
    week: p.week,
    next_kickoff: p.next_kickoff,
    league_season: leagueSeason,
    league_matches:
      leagueSeason === null
        ? null
        : p.phase === "offseason"
          ? leagueSeason === p.season || leagueSeason === p.season + 1
          : leagueSeason === p.season,
    not_published: Object.freeze(notPublished),
    reference_past_vintage: pastVintage(p.season),
    week_bound_exceeded: view.seasons.some(
      (s) => s.last_week !== null && s.last_week > TOOL_INPUT_WEEK_MAX,
    ),
  });
}

/** One recent change as the status surfaces print it. */
export interface RecentChange {
  /** `CHI@BUF` */
  readonly game: string;
  readonly season: number;
  readonly week: Week;
  readonly kind: ScheduleChangeKind;
  readonly old: string | null;
  readonly new: string | null;
  readonly detected_at: IsoInstant;
}

/** The game calendar's state and what changed recently. */
export interface ScheduleBlock {
  readonly calendar: CalendarBasis;
  readonly fallback_reason: CalendarFallbackReason | null;
  readonly in_window: boolean;
  readonly next_kickoff: IsoInstant | null;
  /** Newest first, ≤ 10. */
  readonly recent_changes: readonly RecentChange[];
  readonly recent_changes_more: number;
  /** ≤ 3. */
  readonly tentative_weeks: readonly TentativeWeek[];
}

/** The schedule block from the view and the recent changes (the caller picks the window). */
export function scheduleBlock(
  view: ScheduleView,
  changes: readonly ScheduleChange[],
  nowMs: number,
): ScheduleBlock {
  const sorted = [...changes].sort(
    (a, b) =>
      Date.parse(b.detected_at) - Date.parse(a.detected_at) ||
      a.season - b.season ||
      a.week - b.week ||
      a.game_id.localeCompare(b.game_id) ||
      a.kind.localeCompare(b.kind),
  );
  return Object.freeze({
    calendar: view.calendar.basis,
    fallback_reason: view.calendar.reason,
    in_window: inHotWindow(view.calendar, nowMs),
    next_kickoff: view.phase.next_kickoff,
    recent_changes: Object.freeze(
      sorted.slice(0, RECENT_CHANGES_MAX).map((c) =>
        Object.freeze({
          game: matchupLabel(c),
          season: c.season,
          week: c.week,
          kind: c.kind,
          old: c.old_value,
          new: c.new_value,
          detected_at: c.detected_at,
        }),
      ),
    ),
    recent_changes_more: Math.max(0, sorted.length - RECENT_CHANGES_MAX),
    tentative_weeks: Object.freeze(view.tentative.slice(0, 3)),
  });
}
