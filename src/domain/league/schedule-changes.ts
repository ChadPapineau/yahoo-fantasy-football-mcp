// schedule-changes.ts — kickoff-change detection between two schedules releases (season-fresh spec
// §5.1): flexed kickoffs, date moves, venue moves, added and removed games, and week moves (a
// removed + added pair of the same matchup within ±3 weeks — nflverse game ids encode the week).
// Only games of seasons present in both files and kicking off no earlier than 24 h ago are compared
// (history corrections are ignored). Every value is fixed-vocabulary — an ISO instant, an Eastern
// date, a venue id or a week number — never third-party free text. Pure.
import {
  easternClockOf,
  easternDateOf,
  easternWallTimeMs,
  isIsoDate,
} from "../../config/game-calendar.js";
import {
  GAME_ID_RE,
  type NflGame,
  type ScheduleChange,
  type ScheduleChangeKind,
} from "../analytics/types.js";
import { gameInstantsMs } from "./season.js";
import type { IsoInstant } from "./types.js";

/** Games whose (old or new) kickoff is older than this are history: never compared. */
export const CHANGE_LOOKBACK_MS = 24 * 3_600_000;
/** A removed + added pair of the same matchup within this many weeks is one week move. */
export const WEEK_PAIR_RANGE = 3;
/** Notifications cover games kicking off within this horizon. */
export const NOTIFY_HORIZON_MS = 14 * 86_400_000;
/** This many moved games in one week collapse to one "schedule set" line. */
export const WEEK_SET_COLLAPSE = 8;
/** The cap on a notification's text. */
export const NOTIFICATION_MAX_CHARS = 200;

const KIND_ORDER: readonly ScheduleChangeKind[] = [
  "week",
  "kickoff",
  "gameday",
  "venue",
  "added",
  "removed",
];
const VENUE_ID_RE = /^[A-Z]{3}\d{2}$/;

const isoOf = (ms: number): IsoInstant => new Date(ms).toISOString();

function kickoffMs(g: NflGame): number | null {
  if (g.kickoff === null) return null;
  const k = Date.parse(g.kickoff);
  return Number.isFinite(k) ? k : null;
}

/** The game's kickoff as a canonical ISO instant, or null (TBD). */
const kickoffValue = (g: NflGame): string | null => {
  const k = kickoffMs(g);
  return k === null ? null : isoOf(k);
};

/** The game's Eastern date: its `gameday` when valid, else the kickoff's Eastern date. */
function gamedayValue(g: NflGame): string | null {
  if (typeof g.gameday === "string" && isIsoDate(g.gameday)) return g.gameday;
  const k = kickoffMs(g);
  return k === null ? null : easternDateOf(k);
}

const venueValue = (g: NflGame): string | null =>
  g.stadium_id !== null && VENUE_ID_RE.test(g.stadium_id) ? g.stadium_id : null;

/**
 * The rows comparing one game across two releases (`a` is the game after the change; its id and
 * week label the rows). A kickoff row carries any date move; a gameday row is added only when a
 * kickoff is unknown on one side (a TBD game whose date moved).
 */
function compareGames(b: NflGame, a: NflGame, row: RowFactory): ScheduleChange[] {
  const out: ScheduleChange[] = [];
  if (b.week !== a.week) out.push(row(a, "week", String(b.week), String(a.week)));
  const kb = kickoffValue(b);
  const ka = kickoffValue(a);
  if (kb !== ka) out.push(row(a, "kickoff", kb, ka));
  const db = gamedayValue(b);
  const da = gamedayValue(a);
  if ((kb === null || ka === null) && db !== da) out.push(row(a, "gameday", db, da));
  const vb = venueValue(b);
  const va = venueValue(a);
  if (vb !== va) out.push(row(a, "venue", vb, va));
  return out;
}

type RowFactory = (
  g: NflGame,
  kind: ScheduleChangeKind,
  oldValue: string | null,
  newValue: string | null,
) => ScheduleChange;

/** Valid ids of the comparable seasons, keyed by game id. */
function index(games: readonly NflGame[], seasons: ReadonlySet<number>): Map<string, NflGame> {
  const m = new Map<string, NflGame>();
  for (const g of games)
    if (seasons.has(g.season) && GAME_ID_RE.test(g.game_id)) m.set(g.game_id, g);
  return m;
}

/**
 * The changes from `before` to `after` (§5.1). Compares only seasons present in both files and
 * games whose old or new kickoff is ≥ now − 24 h (a game with no known instant is compared).
 * Sorted by season, week, game id and kind.
 */
export function diffSchedules(
  before: readonly NflGame[],
  after: readonly NflGame[],
  ctx: {
    readonly nowMs: number;
    readonly detectedAt: IsoInstant;
    readonly releaseUpdatedAt: IsoInstant | null;
  },
): ScheduleChange[] {
  const sb = new Set(before.map((g) => g.season));
  const common = new Set(after.map((g) => g.season).filter((s) => sb.has(s)));
  const B = index(before, common);
  const A = index(after, common);
  const cutoff = ctx.nowMs - CHANGE_LOOKBACK_MS;
  const current = (g: NflGame): boolean => {
    const at = gameInstantsMs(g);
    return at === null || at.hi >= cutoff;
  };
  const row: RowFactory = (g, kind, oldValue, newValue) =>
    Object.freeze({
      detected_at: ctx.detectedAt,
      release_updated_at: ctx.releaseUpdatedAt,
      season: g.season,
      week: g.week,
      game_id: g.game_id,
      away: g.away,
      home: g.home,
      kind,
      old_value: oldValue,
      new_value: newValue,
    });

  const out: ScheduleChange[] = [];
  const removed: NflGame[] = [];
  const added: NflGame[] = [];
  for (const [id, b] of B) {
    const a = A.get(id);
    if (a === undefined) {
      if (current(b)) removed.push(b);
    } else if (current(b) || current(a)) out.push(...compareGames(b, a, row));
  }
  for (const [id, a] of A) if (!B.has(id) && current(a)) added.push(a);

  // pair week moves: the closest same-matchup added game within ±WEEK_PAIR_RANGE weeks
  const byId = (x: NflGame, y: NflGame): number =>
    x.season - y.season || x.week - y.week || x.game_id.localeCompare(y.game_id);
  removed.sort(byId);
  added.sort(byId);
  const paired = new Set<NflGame>();
  for (const r of removed) {
    let best: NflGame | null = null;
    for (const a of added) {
      if (paired.has(a) || a.season !== r.season || a.away !== r.away || a.home !== r.home)
        continue;
      const d = Math.abs(a.week - r.week);
      if (d > WEEK_PAIR_RANGE) continue;
      if (best === null || d < Math.abs(best.week - r.week)) best = a;
    }
    if (best === null) out.push(row(r, "removed", kickoffValue(r), null));
    else {
      paired.add(best);
      out.push(...compareGames(r, best, row));
    }
  }
  for (const a of added) if (!paired.has(a)) out.push(row(a, "added", null, kickoffValue(a)));

  return out.sort(
    (x, y) =>
      x.season - y.season ||
      x.week - y.week ||
      x.game_id.localeCompare(y.game_id) ||
      KIND_ORDER.indexOf(x.kind) - KIND_ORDER.indexOf(y.kind),
  );
}

// --- the collapsed informational notification ---------------------------------------------------

/** `Sat 20:20` (Eastern) for an ISO kickoff value; `TBD` when there is none. */
function shortEt(value: string | null): string {
  const ms = value === null ? Number.NaN : Date.parse(value);
  if (!Number.isFinite(ms)) return "TBD";
  const c = easternClockOf(ms);
  return `${c.weekday} ${String(c.hour).padStart(2, "0")}:${String(c.minute).padStart(2, "0")}`;
}

/** The instants a change is about (its old and new kickoff or date), for the 14-day horizon. */
function changeInstants(c: ScheduleChange): number[] {
  const out: number[] = [];
  for (const v of [c.old_value, c.new_value]) {
    if (v === null) continue;
    if (c.kind === "gameday") {
      if (isIsoDate(v)) out.push(easternWallTimeMs(v, 0, 0), easternWallTimeMs(v, 23, 59));
    } else if (c.kind === "kickoff" || c.kind === "added" || c.kind === "removed") {
      const ms = Date.parse(v);
      if (Number.isFinite(ms)) out.push(ms);
    }
  }
  return out;
}

/** An Eastern date value, or `TBD`. */
const dayLabel = (v: string | null): string => (v !== null && isIsoDate(v) ? v : "TBD");

/** Which row describes a game in a notification (only rows that carry an instant). */
const LEAD_RANK: Readonly<Record<ScheduleChangeKind, number>> = Object.freeze({
  kickoff: 0,
  added: 1,
  removed: 2,
  gameday: 3,
  week: 4,
  venue: 5,
});

/** One game's short description from its lead row (a kickoff, added, removed or gameday row). */
function describe(lead: ScheduleChange): string {
  const game = `${lead.away}@${lead.home}`;
  switch (lead.kind) {
    case "kickoff":
      return `${game} ${shortEt(lead.old_value)} → ${shortEt(lead.new_value)}${lead.new_value === null ? "" : " ET"}`;
    case "added":
      return `${game} added ${shortEt(lead.new_value)} ET`;
    case "removed":
      return `${game} removed (was ${shortEt(lead.old_value)} ET)`;
    default:
      return `${game} ${dayLabel(lead.old_value)} → ${dayLabel(lead.new_value)}`;
  }
}

/** One game's changes inside the notification horizon. */
interface GameGroup {
  readonly week: number;
  lead: ScheduleChange;
  first: number;
}

/** One line of the notification: a game, or a whole week collapsed. */
interface Segment {
  readonly at: number;
  readonly games: number;
  readonly collapsed: boolean;
  readonly text: string;
}

/**
 * One collapsed notification line (≤ 200 chars) for the changes to games kicking off within 14 days
 * of `nowMs` (the old or the new kickoff), or null when there is none: `NFL schedule changed: CHI@BUF
 * Sat 20:20 → Sun 13:00 ET (+2 more)`; a week with 8 or more moved games reads `Week <w> schedule
 * set: <n> games moved`. Venue-only and week-number rows carry no instant of their own and are left
 * to G1 and the tool warnings (a week move always comes with its kickoff row).
 */
export function changeNotificationText(
  changes: readonly ScheduleChange[],
  nowMs: number,
): string | null {
  const games = new Map<string, GameGroup>();
  const byWeek = new Map<string, GameGroup[]>();
  for (const c of changes) {
    const inside = changeInstants(c).filter((ms) => ms >= nowMs && ms <= nowMs + NOTIFY_HORIZON_MS);
    if (inside.length === 0) continue;
    const first = Math.min(...inside);
    const g = games.get(c.game_id);
    if (g === undefined) {
      const fresh: GameGroup = { week: c.week, lead: c, first };
      games.set(c.game_id, fresh);
      const key = `${String(c.season)}:${String(c.week)}`;
      byWeek.set(key, [...(byWeek.get(key) ?? []), fresh]);
    } else {
      if (LEAD_RANK[c.kind] < LEAD_RANK[g.lead.kind]) g.lead = c;
      g.first = Math.min(g.first, first);
    }
  }
  const segments: Segment[] = [];
  for (const list of byWeek.values()) {
    const at = Math.min(...list.map((g) => g.first));
    if (list.length >= WEEK_SET_COLLAPSE)
      segments.push({
        at,
        games: list.length,
        collapsed: true,
        text: `Week ${String(list[0]?.week)} schedule set: ${String(list.length)} games moved`,
      });
    else
      for (const g of list)
        segments.push({ at: g.first, games: 1, collapsed: false, text: describe(g.lead) });
  }
  if (segments.length === 0) return null;
  const order = (a: Segment, b: Segment): number => a.at - b.at || a.text.localeCompare(b.text);
  const head = segments.reduce((a, b) => (order(b, a) < 0 ? b : a));
  const more = segments.reduce((n, x) => n + x.games, 0) - head.games;
  const suffix = more > 0 ? ` (+${String(more)} more)` : "";
  // fixed vocabulary only (abbreviations, weekdays, times, dates, counts): well under the cap
  return `${head.collapsed ? head.text : `NFL schedule changed: ${head.text}`}${suffix}`;
}
