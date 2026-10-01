// availability.ts — P(active) (research 05 §1 step 8, §3.5: Questionable 71 % base rate, the
// practice trend refines it; plan 07 D2 / changelog OBJ-16: within 3 h of kickoff a provider-stamped
// game-day status wins and `p_active_basis = "yahoo_gameday_status"`). Pure.
import { GAME_DAY_WINDOW_MS, INACTIVE_STATUS_CODES, P_ACTIVE } from "./constants.js";
import type { InjuryReport, PActiveBasis } from "./types.js";

/** What P(active) is computed from. */
export interface AvailabilityInput {
  /** The official report row for the target week, or null (not listed). */
  readonly report: InjuryReport | null;
  /** Whether the injury dataset was loaded at all (null stamp → nothing is known). */
  readonly injuriesLoaded: boolean;
  /**
   * Whether this week's report is out for the player's team (QA-1-021: reports are published team by
   * team, Wednesday–Friday; the Thursday teams first). Omitted → `injuriesLoaded` (the old contract).
   * Only a published report makes "not listed" mean "cleared to play".
   */
  readonly reportPublished?: boolean;
  /** Whether the previous week's report was published for the player's team. */
  readonly priorPublished?: boolean;
  /** The player's row on the previous week's report, or null (not listed). */
  readonly priorReport?: InjuryReport | null;
  /** The provider's roster status code (league.yaml `status`, Yahoo `status`), or null. */
  readonly platformStatus: string | null;
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
   * Set when this week's report is not out yet for the player's team and his designation was carried
   * from that earlier week's report (QA-1-021) — the caller names it as an assumption.
   */
  readonly carried_from?: number;
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

/** P(active) from a status code (`O`, `D`, `Q`, `IR`, …); null for a code that says nothing. */
function fromStatusCode(code: string | null): number | null {
  if (code === null) return null;
  const c = code.trim().toUpperCase();
  if (INACTIVE_STATUS_CODES.includes(c)) return P_ACTIVE.out;
  if (c === "D") return P_ACTIVE.doubtful;
  if (c === "Q") return P_ACTIVE.questionable;
  return null;
}

/**
 * P(active) for one player-week. Order: (1) a provider-stamped game-day status inside the game-day
 * window; (2) the official report's designation (Questionable refined by the last practice level —
 * `trend_model`); (3) the provider's roster status; (4) not listed on his team's published report →
 * active; (5) his team's report for this week not out yet → last week's designation carried
 * (`carried_from`), or active when he was not on it (QA-1-021); (6) the dataset loaded but neither
 * report out (a look-ahead week) → active; (7) nothing loaded → `p: null`, basis `none` (the
 * simulation then treats the player as active and the projection names that assumption).
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
  const fromPlatform = fromStatusCode(input.platformStatus);
  if (fromPlatform !== null) return { p: fromPlatform, basis: "designation_base_rate" };
  const published = input.reportPublished ?? input.injuriesLoaded;
  if (input.report !== null || published) {
    return { p: P_ACTIVE.noDesignation, basis: "designation_base_rate" };
  }
  if (input.priorPublished === true) {
    const prior = input.priorReport ?? null;
    const carried = prior === null ? null : fromReport(prior);
    if (prior !== null && carried !== null) return { ...carried, carried_from: prior.week };
    return { p: P_ACTIVE.noDesignation, basis: "designation_base_rate" };
  }
  if (input.injuriesLoaded) return { p: P_ACTIVE.noDesignation, basis: "designation_base_rate" };
  return { p: null, basis: "none" };
}
