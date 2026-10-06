// availability.ts — P(active) (research 05 §1 step 8, §3.5: Questionable 71 % base rate, the
// practice trend refines it; plan 07 D2 / changelog OBJ-16: within 3 h of kickoff a provider-stamped
// game-day status wins and `p_active_basis = "yahoo_gameday_status"`), and which team-weeks of the
// official report are only a practice report and which carry the game-status designations
// (QA-1-021, QA-2-034). Pure.
import type { NflTeam } from "../../config/schema.js";
import { easternDate, kickoffMs } from "../league/schedule.js";
import type { Week } from "../league/types.js";
import {
  GAME_DAY_WINDOW_MS,
  INACTIVE_STATUS_CODES,
  INJURY_REPORT,
  P_ACTIVE,
  ROSTER_INACTIVE_THIS_WEEK,
  ROSTER_OUT_STATUSES,
} from "./constants.js";
import type { InjuryReport, NflGame, PActiveBasis } from "./types.js";

/** What P(active) is computed from. */
export interface AvailabilityInput {
  /** The official report row for the target week, or null (not listed). */
  readonly report: InjuryReport | null;
  /** Whether the injury dataset was loaded at all (null stamp → nothing is known). */
  readonly injuriesLoaded: boolean;
  /**
   * Whether this week's report is out for the player's team (QA-1-021: reports are published team by
   * team, Wednesday–Friday; the Thursday teams first). Omitted → `injuriesLoaded` (the old contract).
   */
  readonly reportPublished?: boolean;
  /**
   * Whether his team's GAME-STATUS report for this week is out — the one that carries the
   * designations (`reportStates` → `"final"`). Only it makes "no designation" mean "cleared to play":
   * a practice report alone does not (QA-2-034). Omitted → the old contract (a listed row, or a
   * published report, clears).
   */
  readonly reportFinal?: boolean;
  /**
   * Whether `priorReport` was looked up on an earlier game-status report of his team: the previous
   * week's (the old contract) or, with `reportFinal`, the newest one before this week.
   */
  readonly priorPublished?: boolean;
  /** The player's row on that earlier report, or null (not listed). */
  readonly priorReport?: InjuryReport | null;
  /**
   * The target week. With it, a designation older than INJURY_REPORT.carryWeeks is not carried:
   * availability is unknown (QA-1-021 — a look-ahead or rest-of-season week).
   */
  readonly week?: Week;
  /**
   * His newest row on a practice report after `priorReport`'s week, up to the target week — the
   * newest practice trend, which refines a carried Questionable. Omitted → `report`.
   */
  readonly practiceReport?: InjuryReport | null;
  /** The provider's roster status code (league.yaml `status`, Yahoo `status`), or null. */
  readonly platformStatus: string | null;
  /**
   * The player's NFL roster status that applies to this week (nflverse `roster_weekly.status` of his
   * newest row at or before the week; INA only from that same week), or null/omitted (QA-1-030).
   */
  readonly rosterStatus?: string | null;
  /**
   * A game-day status the provider stamped (Yahoo, within the game-day window). `undefined` = the
   * provider stamps none (ManualLeagueProvider — X1 has no game-day source, OBJ-29); `null` status =
   * stamped and active.
   */
  readonly gameDayStatus?: { readonly status: string | null } | undefined;
  /** The player's kickoff (ms) this week, or null. */
  readonly kickoffMs: number | null;
  readonly nowMs: number;
}

/** P(active) and its basis; `p` null only when nothing at all is known. */
export interface Availability {
  readonly p: number | null;
  readonly basis: PActiveBasis;
  /**
   * Set when this week's game-status report is not out yet for the player's team and his designation
   * was carried from that earlier week's report (QA-1-021) — the caller names it as an assumption.
   */
  readonly carried_from?: number;
  /**
   * Set when he is on this week's practice report but his team's game-status report is not out: no
   * designation yet, and his last game-status report did not designate him (QA-2-034) — named.
   */
  readonly designation_pending?: true;
  /**
   * Set instead of `designation_pending` when, in that same case, he did not practise on this week's
   * report for an injury (a rest day is not one): a new injury, not "cleared" — `p` is the practice
   * trend's Questionable-and-did-not-practise rate until his designation is out (QA-2-034) — named.
   */
  readonly dnp_pending?: true;
  /**
   * Set when his newest designation (from that week) is more than INJURY_REPORT.carryWeeks old and
   * nothing newer is out: `p` is null (unknown), never "cleared" (QA-1-021) — named.
   */
  readonly expired_from?: number;
}

/** P(active) from a report row's designation (Questionable refined by practice); null when none. */
function fromReport(r: InjuryReport): Availability | null {
  const d = designation(r.report_status);
  if (d === "out") return { p: P_ACTIVE.out, basis: "designation_base_rate" };
  if (d === "doubtful") return { p: P_ACTIVE.doubtful, basis: "designation_base_rate" };
  if (d === "questionable") {
    const lvl = practiceLevel(r);
    return lvl === null
      ? { p: P_ACTIVE.questionable, basis: "designation_base_rate" }
      : { p: P_ACTIVE.questionableByPractice[lvl], basis: "trend_model" };
  }
  return null;
}

/** The normalised report designation, from nflverse `report_status` (`Out`, `Doubtful`, …). */
function designation(s: string | null): "out" | "doubtful" | "questionable" | null {
  const v = (s ?? "").trim().toLowerCase();
  if (v === "out") return "out";
  if (v === "doubtful") return "doubtful";
  if (v === "questionable") return "questionable";
  return null;
}

/** The last practice participation level (nflverse `practice_status` text), or null. */
function practiceLevel(r: InjuryReport): "full" | "limited" | "dnp" | null {
  const last = r.practice.at(-1)?.status ?? "";
  const v = last.toLowerCase();
  if (v.includes("did not")) return "dnp";
  if (v.includes("limited")) return "limited";
  if (v.includes("full")) return "full";
  return null;
}

/** A rest day (nflverse "Not injury related - resting player", "Rest"): no injury behind a DNP. */
const REST_DAY_RE = /\brest(?:ing)?\b/i;

/**
 * Whether a row without a designation says he did not practise for an injury: his last practice
 * level is DNP and the reason given is not a rest day (QA-2-034).
 */
function injuredDnp(r: InjuryReport): boolean {
  if (practiceLevel(r) !== "dnp") return false;
  return !REST_DAY_RE.test(r.primary_injury ?? "") && !REST_DAY_RE.test(r.secondary_injury ?? "");
}

/** P(active) from a status code (`O`, `D`, `Q`, `IR`, …); null for a code that says nothing. */
function fromStatusCode(code: string | null): number | null {
  if (code === null) return null;
  const c = code.trim().toUpperCase();
  if (INACTIVE_STATUS_CODES.includes(c)) return P_ACTIVE.out;
  if (c === "D") return P_ACTIVE.doubtful;
  if (c === "Q") return P_ACTIVE.questionable;
  return null;
}

/** Whether an applicable NFL roster status means "will not play" (RES, CUT, RET, SUS, UFA, INA). */
export function isRosterOut(status: string | null): boolean {
  if (status === null) return false;
  const c = status.trim().toUpperCase();
  return ROSTER_OUT_STATUSES.includes(c) || c === ROSTER_INACTIVE_THIS_WEEK;
}

/**
 * P(active) for one player-week. Order: (1) a provider-stamped game-day status inside the game-day
 * window; (2) the official report's designation (Questionable refined by the last practice level —
 * `trend_model`); (2b) an NFL roster status that rules him out (reserve list, cut, retired,
 * suspended, unsigned, game-day inactive — QA-1-030); (3) the provider's roster status; (4) no
 * designation on his team's game-status report → active; (5) that report not out yet (a practice
 * report at most — QA-2-034 — or none) → his designation on the newest earlier game-status report
 * carried (`carried_from`; a carried Questionable refined by the newest practice level), unknown
 * once it is more than INJURY_REPORT.carryWeeks old (`expired_from`, p null), or active when that
 * report did not designate him (`designation_pending` when he is on this week's practice report) —
 * unless he did not practise on it for an injury: then not cleared, the Questionable-and-DNP trend
 * rate (`dnp_pending`, QA-2-034) (QA-1-021); (6) the dataset loaded but no earlier report out →
 * active, the same DNP exception applying; (7) nothing loaded →
 * `p: null`, basis `none` (the simulation then treats the player as active and the projection names
 * that assumption).
 */
export function pActive(input: AvailabilityInput): Availability {
  const gd = input.gameDayStatus;
  if (
    gd !== undefined &&
    input.kickoffMs !== null &&
    input.nowMs >= input.kickoffMs - GAME_DAY_WINDOW_MS
  ) {
    return {
      p: fromStatusCode(gd.status) ?? P_ACTIVE.noDesignation,
      basis: "yahoo_gameday_status",
    };
  }
  if (input.report !== null) {
    const r = fromReport(input.report);
    if (r !== null) return r;
  }
  if (isRosterOut(input.rosterStatus ?? null)) {
    return { p: P_ACTIVE.out, basis: "designation_base_rate" };
  }
  const fromPlatform = fromStatusCode(input.platformStatus);
  if (fromPlatform !== null) return { p: fromPlatform, basis: "designation_base_rate" };
  const published = input.reportPublished ?? input.injuriesLoaded;
  const final = input.reportFinal ?? (input.report !== null || published);
  if (final) return { p: P_ACTIVE.noDesignation, basis: "designation_base_rate" };
  // no designation on his last game-status report (or none out yet): active, unless this week's
  // practice report says he did not practise for an injury — a new injury is not "cleared"
  const pending: Availability =
    input.report === null
      ? { p: P_ACTIVE.noDesignation, basis: "designation_base_rate" }
      : injuredDnp(input.report)
        ? { p: P_ACTIVE.questionableByPractice.dnp, basis: "trend_model", dnp_pending: true }
        : { p: P_ACTIVE.noDesignation, basis: "designation_base_rate", designation_pending: true };
  if (input.priorPublished === true) {
    const prior = input.priorReport ?? null;
    const carried = prior === null ? null : fromReport(prior);
    if (prior === null || carried === null) return pending;
    if (input.week !== undefined && input.week - prior.week > INJURY_REPORT.carryWeeks) {
      return { p: null, basis: "none", expired_from: prior.week };
    }
    // a practice report since is newer evidence than the carried one's: it refines a Questionable
    const newer = input.practiceReport === undefined ? input.report : input.practiceReport;
    const lvl = newer === null ? null : practiceLevel(newer);
    if (designation(prior.report_status) === "questionable" && lvl !== null) {
      return {
        p: P_ACTIVE.questionableByPractice[lvl],
        basis: "trend_model",
        carried_from: prior.week,
      };
    }
    return { ...carried, carried_from: prior.week };
  }
  if (input.injuriesLoaded) return pending;
  return { p: null, basis: "none" };
}

/** Where a team's injury report for one week stands (QA-1-021, QA-2-034). */
export type ReportState = "none" | "practice" | "final";

/**
 * Each team's week-`week` report state from that week's rows (every team's) and games:
 * `"final"` once its game-status report is out — any of its rows carries a designation; or a team
 * whose game is on the same or a later Eastern date has one (a game day's game-status reports are
 * released together, the earlier game days' before them); or the release was built at most
 * INJURY_REPORT.gameStatusLeadMs before its kickoff (every game-status report is out by then, a
 * team with nobody designated included). Otherwise `"practice"` when it has rows (a practice report
 * only: no designations yet) and `"none"` when it has none (not published, or a bye). `asOfMs` is
 * the release's own stamp (null → never final by time). Rows of other seasons or weeks are ignored.
 */
export function reportStates(
  rows: readonly InjuryReport[],
  games: readonly NflGame[],
  season: number,
  week: Week,
  asOfMs: number | null,
): Map<NflTeam, ReportState> {
  const listed = new Set<NflTeam>();
  const designated = new Set<NflTeam>();
  for (const r of rows) {
    if (r.season !== season || r.week !== week) continue;
    listed.add(r.nfl_team);
    if (designation(r.report_status) !== null) designated.add(r.nfl_team);
  }
  const kickoff = new Map<NflTeam, number>();
  for (const g of games) {
    if (g.season !== season || g.week !== week) continue;
    const k = kickoffMs(g.kickoff);
    if (k === null) continue;
    for (const t of [g.home, g.away]) {
      const was = kickoff.get(t);
      if (was === undefined || k < was) kickoff.set(t, k);
    }
  }
  // the latest Eastern game date whose game-status reports are out (a designation is seen there)
  let lastOut: string | null = null;
  for (const t of designated) {
    const k = kickoff.get(t);
    if (k === undefined) continue;
    const d = easternDate(k);
    if (lastOut === null || d > lastOut) lastOut = d;
  }
  const out = new Map<NflTeam, ReportState>();
  for (const t of new Set([...listed, ...kickoff.keys()])) {
    const k = kickoff.get(t);
    const final =
      designated.has(t) ||
      (k !== undefined && lastOut !== null && easternDate(k) <= lastOut) ||
      (k !== undefined && asOfMs !== null && asOfMs >= k - INJURY_REPORT.gameStatusLeadMs);
    out.set(t, final ? "final" : listed.has(t) ? "practice" : "none");
  }
  return out;
}

/** What `pActive` reads about the official report for one player-week (QA-1-021, QA-2-034). */
export interface ReportContext {
  readonly report: InjuryReport | null;
  readonly reportPublished: boolean;
  readonly reportFinal: boolean;
  readonly priorPublished: boolean;
  readonly priorReport: InjuryReport | null;
  readonly practiceReport: InjuryReport | null;
  readonly week: Week;
}

/**
 * The report inputs of `pActive` for one player-week, read the one way every tool reads them: this
 * week's row and his team's report state; the newest EARLIER week whose game-status report is out for
 * his team that week (across byes and look-ahead weeks, QA-1-021) and his row on it; and his newest
 * row since then up to this week (the newest practice trend). `stateOf` gives a team's state in a
 * week (`reportStates`), `rowOf` his row in a week. `loaded` is whether the target week's injury
 * report was read at all. `team` null (no NFL team) has no report state.
 */
export function reportContext(
  week: Week,
  team: NflTeam | null,
  loaded: boolean,
  stateOf: (w: Week, team: NflTeam) => ReportState,
  rowOf: (w: Week) => InjuryReport | null,
): ReportContext {
  const state = (w: Week, t: NflTeam | null): ReportState => (t === null ? "none" : stateOf(w, t));
  let prior = week - 1;
  while (prior >= 1 && state(prior, rowOf(prior)?.nfl_team ?? team) !== "final") prior -= 1;
  let practiceReport: InjuryReport | null = null;
  for (let w = week; w > prior && practiceReport === null; w--) practiceReport = rowOf(w);
  return {
    report: rowOf(week),
    reportPublished: loaded && state(week, team) !== "none",
    reportFinal: loaded && state(week, team) === "final",
    priorPublished: loaded && prior >= 1,
    priorReport: prior >= 1 ? rowOf(prior) : null,
    practiceReport,
    week,
  };
}
