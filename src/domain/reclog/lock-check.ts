// lock-check.ts — whether a logged recommendation's lock time still holds (season-fresh spec §5.4).
// Logged rows stay immutable; the mark is derived at read time from the week's current games and the
// recorded schedule changes. Pure.
import type { NflTeam } from "../../config/schema.js";
import type { NflGame, ScheduleChange } from "../analytics/types.js";
import type { IsoInstant, Week } from "../league/types.js";

/** `moved` = the kickoff that set the rec's deadline changed; `unknown` = nothing to check against. */
export type LockStatus = "current" | "moved" | "unknown";

/** The mark, with the old and new lock and when the move was detected (when known). */
export interface LockCheck {
  readonly status: LockStatus;
  readonly old_lock: IsoInstant | null;
  readonly new_lock: IsoInstant | null;
  readonly detected_at: IsoInstant | null;
}

const MOVE_KINDS = new Set(["kickoff", "gameday", "week", "removed"]);

const msOf = (v: string | null): number | null => {
  if (v === null) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
};
const isoOf = (ms: number): IsoInstant => new Date(ms).toISOString();

/** The most recently detected of `rows` (rows with an unreadable instant rank last), or null. */
function newestDetected(rows: readonly ScheduleChange[]): ScheduleChange | null {
  let best: ScheduleChange | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const r of rows) {
    const t = msOf(r.detected_at) ?? Number.NEGATIVE_INFINITY;
    if (best === null || t > bestMs) {
      best = r;
      bestMs = t;
    }
  }
  return best;
}

const UNKNOWN: LockCheck = Object.freeze({
  status: "unknown",
  old_lock: null,
  new_lock: null,
  detected_at: null,
});

/**
 * The lock mark of one recommendation (§5.4): `unknown` when it has no deadline or the week has no
 * games (for its subject teams, when known); `moved` when a kickoff/gameday/week/removed change of
 * its season-week (of a game of its subject teams, when known) has the rec's deadline as its old
 * value, or when the deadline matches no current kickoff of the week's games involving the
 * rec's subject teams (all games when the teams are unknown — pass null for a weekly-lock league,
 * whose deadline is the week's first kickoff); else `current`.
 */
export function lockCheck(
  rec: {
    readonly season: number;
    readonly week: Week;
    readonly latest_execution_time: IsoInstant | null;
    readonly recorded_at: IsoInstant;
    readonly subject_teams: ReadonlySet<NflTeam> | null;
  },
  weekGames: readonly NflGame[],
  changes: readonly ScheduleChange[],
): LockCheck {
  const deadline = msOf(rec.latest_execution_time);
  if (deadline === null || weekGames.length === 0) return UNKNOWN;
  const old = isoOf(deadline);

  const teams = rec.subject_teams;
  const involves = (x: { readonly away: NflTeam; readonly home: NflTeam }): boolean =>
    teams === null || teams.has(x.away) || teams.has(x.home);
  const ofWeek = changes.filter(
    (c) => c.season === rec.season && c.week === rec.week && involves(c),
  );
  const hit = newestDetected(
    ofWeek.filter((c) => MOVE_KINDS.has(c.kind) && msOf(c.old_value) === deadline),
  );
  if (hit !== null) {
    const next = hit.kind === "kickoff" ? msOf(hit.new_value) : null;
    return Object.freeze({
      status: "moved",
      old_lock: old,
      new_lock: next === null ? null : isoOf(next),
      detected_at: hit.detected_at,
    });
  }

  const games = weekGames.filter(
    (g) => g.season === rec.season && g.week === rec.week && involves(g),
  );
  if (games.length === 0) return UNKNOWN; // none of the subject teams plays that week
  const kickoffs = games.map((g) => msOf(g.kickoff)).filter((k): k is number => k !== null);
  if (kickoffs.includes(deadline))
    return Object.freeze({ status: "current", old_lock: null, new_lock: null, detected_at: null });
  // No current kickoff matches: the earliest kickoff still ahead of the recording is the new lock.
  const recorded = msOf(rec.recorded_at) ?? Number.NEGATIVE_INFINITY;
  const ahead = kickoffs.filter((k) => k >= recorded).sort((a, b) => a - b);
  const first = ahead[0];
  return Object.freeze({
    status: "moved",
    old_lock: old,
    new_lock: first === undefined ? null : isoOf(first),
    detected_at: newestDetected(ofWeek)?.detected_at ?? null,
  });
}
