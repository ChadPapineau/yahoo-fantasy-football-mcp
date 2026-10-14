// flex-rules.ts — the NFL's flexible-scheduling notice periods as dated, vintage-stamped data
// (season-fresh spec §5.3, §2.7). Advisory only: a game inside its flex window is reported as
// tentative ("may still be flexed until …"); the flags never change the refresh cadence or a lock
// time. Past `verified_through_season` the table still works and `pastVintage` says so
// (src/config/reference-vintage.ts). The slot comes from the kickoff's Eastern weekday and time.
import { easternClockOf } from "./game-calendar.js";

/** The schedule slots a flex rule can cover. `final_week` = every game of the last REG week. */
export type FlexSlot = "sun_night" | "mon_night" | "thu_night" | "sun_day" | "final_week";

/** One rule: games in `slot` during `weeks` can be moved with at least `notice_days` of notice. */
export interface FlexRule {
  readonly slot: FlexSlot;
  readonly weeks: readonly [number, number] | "last_reg_week";
  readonly notice_days: number;
}

/**
 * The rules (nfl.com flexible-scheduling procedures, read 2026-10-13): Sunday night weeks 5–13 with
 * 12 days' notice and 14–17 with 6; the season's final week with 6 (its Saturday and Sunday times
 * are set late); Monday night weeks 12–17 with 12; Thursday night weeks 13–17 with 21; Sunday
 * daytime games (13:00/16:05/16:25 ET, or into primetime) weeks 5–13 with 12 and 14–17 with 6.
 */
export const FLEX_RULES: Readonly<{
  verified_through_season: number;
  source: string;
  checked_on: string;
  rules: readonly FlexRule[];
}> = Object.freeze({
  verified_through_season: 2026,
  source: "nfl.com flexible-scheduling procedures",
  checked_on: "2026-10-13",
  rules: Object.freeze([
    Object.freeze({ slot: "sun_night", weeks: Object.freeze([5, 13] as const), notice_days: 12 }),
    Object.freeze({ slot: "sun_night", weeks: Object.freeze([14, 17] as const), notice_days: 6 }),
    Object.freeze({ slot: "final_week", weeks: "last_reg_week", notice_days: 6 }),
    Object.freeze({ slot: "mon_night", weeks: Object.freeze([12, 17] as const), notice_days: 12 }),
    Object.freeze({ slot: "thu_night", weeks: Object.freeze([13, 17] as const), notice_days: 21 }),
    Object.freeze({ slot: "sun_day", weeks: Object.freeze([5, 13] as const), notice_days: 12 }),
    Object.freeze({ slot: "sun_day", weeks: Object.freeze([14, 17] as const), notice_days: 6 }),
  ] satisfies FlexRule[]),
});

/** What `flexDeadlineMs` needs to know about a game. */
export interface FlexGame {
  readonly week: number;
  /** `REG` | `WC` | `DIV` | `CON` | `SB`; null/unknown is judged as a regular-season game. */
  readonly game_type: string | null;
  readonly kickoff_ms: number | null;
  /** The season's last regular-season week (from the schedule), or null when unknown. */
  readonly last_reg_week: number | null;
}

/** Primetime starts at 19:00 ET (Sunday/Monday/Thursday night slots). */
const NIGHT_HOUR_ET = 19;
const DAY_MS = 86_400_000;

/** The non-final slot of a kickoff from its Eastern weekday and hour, or null (no rule covers it). */
export function flexSlotOf(kickoffMs: number): Exclude<FlexSlot, "final_week"> | null {
  const c = easternClockOf(kickoffMs);
  switch (c.weekday) {
    case "Sun":
      return c.hour >= NIGHT_HOUR_ET ? "sun_night" : "sun_day";
    case "Mon":
      return "mon_night";
    case "Thu":
      return c.hour >= NIGHT_HOUR_ET ? "thu_night" : null;
    default:
      return null;
  }
}

/**
 * The instant after which the kickoff can no longer be flexed: kickoff − the minimum notice of the
 * rules covering its slot and week (the final REG week's rule covers every game of that week); null
 * when no rule covers the game (weeks 1–4, a postseason game, a TBD kickoff, an uncovered slot).
 * Whether the deadline has passed is the caller's judgment (it holds the clock).
 */
export function flexDeadlineMs(g: FlexGame): number | null {
  if (g.kickoff_ms === null || !Number.isFinite(g.kickoff_ms)) return null;
  if (g.game_type !== null && g.game_type !== "REG") return null;
  const slot = flexSlotOf(g.kickoff_ms);
  let notice: number | null = null;
  for (const r of FLEX_RULES.rules) {
    const covers =
      r.weeks === "last_reg_week"
        ? g.last_reg_week !== null && g.week === g.last_reg_week
        : r.slot === slot && g.week >= r.weeks[0] && g.week <= r.weeks[1];
    if (covers && (notice === null || r.notice_days < notice)) notice = r.notice_days;
  }
  return notice === null ? null : g.kickoff_ms - notice * DAY_MS;
}
