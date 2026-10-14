// kickoff-status.ts — which kickoffs may still move (season-fresh spec §5.3, §5.2): a placeholder
// week (data-driven: ≥ 4 regular-season games all at one instant, or every kickoff unknown — the
// final week's release before the NFL sets its times), a flex window (advisory, from the
// vintage-stamped FLEX_RULES), and a TBD time. Plus the fixed-vocabulary warning lines the tools add
// for kickoff changes and tentative weeks: NFL abbreviations, numbers and Eastern times only, never
// third-party text. Pure: time comes in as epoch ms.
import { flexDeadlineMs } from "../../config/flex-rules.js";
import { easternClockOf, isIsoDate, easternWallTimeMs } from "../../config/game-calendar.js";
import type { NflTeam } from "../../config/schema.js";
import type { NflGame, ScheduleChange } from "../analytics/types.js";
import type { ScheduleView } from "./calendar.js";
import { isRegularGame, type SeasonSchedule } from "./season.js";
import type { IsoInstant, Week } from "./types.js";

/** Why a kickoff may still move. */
export type TentativeReason = "placeholder_week" | "flex_window" | "tbd_time";

/** One game's kickoff status. */
export interface KickoffStatus {
  readonly tentative: boolean;
  readonly reason: TentativeReason | null;
  /** When a flex window closes (flex_window only); null otherwise. */
  readonly until: IsoInstant | null;
}

/** A week whose kickoffs may still move. */
export interface TentativeWeek {
  readonly season: number;
  readonly week: Week;
  readonly reason: TentativeReason;
  readonly until: IsoInstant | null;
}

/** A placeholder week has at least this many games at one instant. */
export const PLACEHOLDER_MIN_GAMES = 4;
/** At most this many schedule warning lines per result (then a count). */
export const SCHEDULE_WARNING_MAX = 3;
/** Kickoff changes older than this are not repeated in tool warnings. */
export const SCHEDULE_WARNING_LOOKBACK_MS = 7 * 86_400_000;
/** The cap on any one warning line (met by construction: fixed vocabulary and bounded labels). */
export const SCHEDULE_WARNING_MAX_CHARS = 400;

const iso = (ms: number): IsoInstant => new Date(ms).toISOString();
const NOT_TENTATIVE: KickoffStatus = Object.freeze({ tentative: false, reason: null, until: null });

function kickoffMsOf(g: NflGame): number | null {
  if (g.kickoff === null) return null;
  const k = Date.parse(g.kickoff);
  return Number.isFinite(k) ? k : null;
}

/**
 * The regular-season weeks of `season` whose kickoffs are placeholders: ≥ 4 games all at one
 * instant, or every kickoff unknown. Stops being a placeholder as soon as the data shows set times.
 */
export function placeholderWeeks(games: readonly NflGame[], season: number): ReadonlySet<Week> {
  const byWeek = new Map<Week, NflGame[]>();
  for (const g of games) {
    if (g.season !== season || !isRegularGame(g)) continue;
    const list = byWeek.get(g.week) ?? [];
    list.push(g);
    byWeek.set(g.week, list);
  }
  const out = new Set<Week>();
  for (const [week, list] of byWeek) {
    const ks = list.map(kickoffMsOf);
    if (ks.every((k) => k === null)) out.add(week);
    else if (list.length >= PLACEHOLDER_MIN_GAMES && ks.every((k) => k !== null && k === ks[0]))
      out.add(week);
  }
  return out;
}

/**
 * A game's kickoff status at `nowMs`: a game already kicked off is settled; a regular-season game of
 * a placeholder week is `placeholder_week`; an unknown time is `tbd_time`; a game before its flex
 * deadline is `flex_window` (until the deadline); otherwise settled.
 */
export function kickoffStatus(
  game: NflGame,
  ctx: {
    readonly nowMs: number;
    readonly schedule: SeasonSchedule | null;
    readonly placeholders: ReadonlySet<Week>;
  },
): KickoffStatus {
  const k = kickoffMsOf(game);
  if (k !== null && ctx.nowMs >= k) return NOT_TENTATIVE;
  if (isRegularGame(game) && ctx.placeholders.has(game.week))
    return Object.freeze({ tentative: true, reason: "placeholder_week", until: null });
  if (k === null) return Object.freeze({ tentative: true, reason: "tbd_time", until: null });
  const deadline = flexDeadlineMs({
    week: game.week,
    game_type: typeof game.game_type === "string" ? game.game_type : null,
    kickoff_ms: k,
    last_reg_week: ctx.schedule?.last_reg_week ?? null,
  });
  if (deadline !== null && ctx.nowMs < deadline)
    return Object.freeze({ tentative: true, reason: "flex_window", until: iso(deadline) });
  return NOT_TENTATIVE;
}

const REASON_RANK: Readonly<Record<TentativeReason, number>> = Object.freeze({
  placeholder_week: 0,
  tbd_time: 1,
  flex_window: 2,
});

/**
 * The tentative weeks of the phase season from the current week on (preseason: from week 1), at
 * most `limit`. A week's reason is its strongest game reason (placeholder > TBD > flex); a flex
 * week's `until` is its latest game deadline (when the whole week is settled). Postseason and
 * offseason: none.
 */
export function tentativeWeeks(
  view: Pick<ScheduleView, "games" | "schedule" | "phase">,
  nowMs: number,
  limit: number,
): TentativeWeek[] {
  const { phase } = view;
  if (limit <= 0 || (phase.phase !== "preseason" && phase.phase !== "regular")) return [];
  const season = phase.season;
  const games = view.games(season);
  const schedule = view.schedule(season);
  const from = phase.phase === "regular" ? (phase.week ?? 1) : 1;
  const placeholders = placeholderWeeks(games, season);
  const byWeek = new Map<Week, NflGame[]>();
  for (const g of games) {
    if (g.season !== season || !isRegularGame(g) || g.week < from) continue;
    const list = byWeek.get(g.week) ?? [];
    list.push(g);
    byWeek.set(g.week, list);
  }
  const out: TentativeWeek[] = [];
  for (const [week, weekGames] of [...byWeek.entries()].sort((a, b) => a[0] - b[0])) {
    let best: TentativeReason | null = null;
    let until: number | null = null;
    for (const g of weekGames) {
      const st = kickoffStatus(g, { nowMs, schedule, placeholders });
      if (st.reason === null) continue;
      if (best === null || REASON_RANK[st.reason] < REASON_RANK[best]) best = st.reason;
      if (st.until !== null) until = Math.max(until ?? 0, Date.parse(st.until));
    }
    if (best === null) continue;
    out.push(
      Object.freeze({
        season,
        week,
        reason: best,
        until: best === "flex_window" && until !== null ? iso(until) : null,
      }),
    );
    if (out.length >= limit) break;
  }
  return out;
}

// --- warning text (fixed vocabulary) ----------------------------------------------------------------

/** `Sat 2026-12-19 20:20 ET` for an ISO instant; `TBD` for null; `unknown` for anything else. */
export function easternLabel(value: string | null): string {
  if (value === null) return "TBD";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return "unknown";
  const c = easternClockOf(ms);
  const hh = String(c.hour).padStart(2, "0");
  const mm = String(c.minute).padStart(2, "0");
  return `${c.weekday} ${c.date} ${hh}:${mm} ET`;
}

/** `Sat 2026-12-19` for an Eastern date; `TBD` for null; `unknown` for anything else. */
export function easternDayLabel(value: string | null): string {
  if (value === null) return "TBD";
  if (!isIsoDate(value)) return "unknown";
  return `${easternClockOf(easternWallTimeMs(value, 12, 0)).weekday} ${value}`;
}

const VENUE_ID_RE = /^[A-Z]{3}\d{2}$/;
const venueLabel = (v: string | null): string =>
  v === null ? "none" : VENUE_ID_RE.test(v) ? v : "unknown";
const weekLabel = (v: string | null): string => (v !== null && /^\d{1,2}$/.test(v) ? v : "?");
const detectedLabel = (v: string): string => {
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? iso(ms).replace(/\.000Z$/, "Z") : "unknown";
};

/** `CHI@BUF` (NFL abbreviations from the typed row). */
export function matchupLabel(c: { readonly away: NflTeam; readonly home: NflTeam }): string {
  return `${c.away}@${c.home}`;
}

/** One kickoff-change line (≤ 400 chars, NFL abbreviations and ET only; no third-party text). */
export function kickoffChangeWarning(c: ScheduleChange): string {
  const game = `${matchupLabel(c)} (week ${String(c.week)})`;
  const detected = `(detected ${detectedLabel(c.detected_at)})`;
  switch (c.kind) {
    case "kickoff":
      return `kickoff changed for ${game}: ${easternLabel(c.old_value)} → ${easternLabel(c.new_value)} ${detected}; lock times use the new kickoff`;
    case "gameday":
      return `game date changed for ${game}: ${easternDayLabel(c.old_value)} → ${easternDayLabel(c.new_value)} ${detected}; lock times use the new date`;
    case "venue":
      return `venue changed for ${game}: ${venueLabel(c.old_value)} → ${venueLabel(c.new_value)} ${detected}`;
    case "added":
      return `game added: ${game} at ${easternLabel(c.new_value)} ${detected}; lock times include it`;
    case "removed":
      return `game removed: ${game}, was ${easternLabel(c.old_value)} ${detected}; lock times no longer include it`;
    case "week":
      return `${matchupLabel(c)} moved from week ${weekLabel(c.old_value)} to week ${weekLabel(c.new_value)} ${detected}; lock times use the new week`;
  }
}

/** One tentative-week line (≤ 400 chars). */
export function tentativeWeekWarning(t: TentativeWeek): string {
  const w = String(t.week);
  switch (t.reason) {
    case "placeholder_week":
      return `week ${w} kickoff times are placeholders until the NFL sets them; lock times may move`;
    case "flex_window":
      return `week ${w} kickoff times may still be flexed until ${easternLabel(t.until)}; re-check after then`;
    case "tbd_time":
      return `week ${w} has kickoff times still to be set (TBD); lock times may move once they are`;
  }
}

/** Whether a change concerns one of `weeks` (a week move counts for both its old and new week). */
function changeInWeeks(c: ScheduleChange, weeks: ReadonlySet<Week>): boolean {
  if (weeks.has(c.week)) return true;
  return c.kind === "week" && c.old_value !== null && weeks.has(Number(c.old_value));
}

/**
 * The schedule notes for one tool result (§5.2): kickoff changes detected ≤ 7 days ago for the
 * requested season/weeks (and teams, when known) — newest first — then the tentative weeks among
 * the requested ones; at most 3 lines, then `… <n> more schedule notes`.
 */
export function scheduleWarnings(i: {
  readonly changes: readonly ScheduleChange[];
  readonly tentative: readonly TentativeWeek[];
  readonly season: number;
  readonly weeks: readonly Week[];
  readonly teams: ReadonlySet<NflTeam> | null;
  readonly nowMs: number;
}): string[] {
  const weeks = new Set(i.weeks);
  const since = i.nowMs - SCHEDULE_WARNING_LOOKBACK_MS;
  const changes = i.changes
    .filter((c) => {
      const at = Date.parse(c.detected_at);
      return (
        c.season === i.season &&
        Number.isFinite(at) &&
        at >= since &&
        changeInWeeks(c, weeks) &&
        (i.teams === null || i.teams.has(c.away) || i.teams.has(c.home))
      );
    })
    .sort(
      (a, b) =>
        Date.parse(b.detected_at) - Date.parse(a.detected_at) ||
        a.week - b.week ||
        a.game_id.localeCompare(b.game_id) ||
        a.kind.localeCompare(b.kind),
    );
  const lines = [
    ...changes.map(kickoffChangeWarning),
    ...i.tentative
      .filter((t) => t.season === i.season && weeks.has(t.week))
      .map(tentativeWeekWarning),
  ];
  const unique = [...new Set(lines)];
  if (unique.length <= SCHEDULE_WARNING_MAX) return unique;
  const more = unique.length - SCHEDULE_WARNING_MAX;
  return [
    ...unique.slice(0, SCHEDULE_WARNING_MAX),
    `… ${String(more)} more schedule note${more === 1 ? "" : "s"}`,
  ];
}
