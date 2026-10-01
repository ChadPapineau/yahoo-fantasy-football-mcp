// common.ts — what the plan 07 §2 conventions need in every tool: league resolution against the
// allow-list (plan 02 §5 league scoping), stamps → envelope inputs through the ONE conversion
// (stampToInput; STALE_ONLY past a hard limit unless allow_stale — plan 01 §5.4), the never-loaded
// dataset answer (C-14 (c)), provenance tags for untrusted text (plan 02 §6.2), the crosswalk run
// behind every gsis id a tool shows (research 04 §D; plan 07 C1), and week/lock helpers (plan 07 B1).
import { freshnessClass, type DatasetSourceId } from "../../config/freshness.js";
import type { NflTeam } from "../../config/schema.js";
import type { DatasetResult, DatasetStamp, NflGame } from "../../domain/analytics/types.js";
import {
  buildRosterIndex,
  resolveCrosswalk,
  subjectOf,
  type CrosswalkResolution,
  type CrosswalkRun,
} from "../../domain/crosswalk/matcher.js";
import { normalizeTeam } from "../../domain/crosswalk/teams.js";
import { gsisFromManualKey, teamFromManualDefKey } from "../../domain/crosswalk/ids.js";
import type { NflRosterPlayer } from "../../domain/crosswalk/types.js";
import { isLocked, type LockMode } from "../../domain/league/schedule.js";
import type {
  League,
  LeagueRef,
  PlatformPlayer,
  PlatformStamp,
  ReadOptions,
  RosterSlots,
  Stamped,
  TeamRef,
  Week,
} from "../../domain/league/types.js";
import { positionTypeForLeaguePosition, withPositionType } from "../../domain/scoring/index.js";
import type { ProjectionSubject, ScoringSettings, StatLine } from "../../domain/scoring/types.js";
import { isProvisionalWeek } from "../../config/freshness.js";
import {
  isUntrustedSource,
  stampToInput,
  type InputStamp,
  type UntrustedField,
} from "../envelope.js";
import { DATASET_NEVER_LOADED_HINT, FfError } from "../errors.js";
import type { ToolContext } from "../define.js";

/** Which league and team a call is about, with the platform provenance of the league read. */
export interface LeagueContext {
  readonly ref: LeagueRef;
  readonly league: League;
  /** The league read's stamp as an envelope input. */
  readonly input: InputStamp;
  readonly allowStale: boolean;
}

function memo<T>(ctx: ToolContext, key: string, make: () => T): T {
  if (ctx.memo.has(key)) return ctx.memo.get(key) as T;
  const v = make();
  ctx.memo.set(key, v);
  return v;
}

/** Read options for a platform read (`force_refresh`/`allow_stale`, plan 07 §2). */
export function readOpts(args: {
  readonly force_refresh?: boolean | undefined;
  readonly allow_stale?: boolean | undefined;
}): ReadOptions {
  return {
    ...(args.force_refresh === true ? { force_refresh: true } : {}),
    ...(args.allow_stale === true ? { allow_stale: true } : {}),
  };
}

/**
 * A platform or dataset stamp as an envelope input — refusing an input past its class's hard limit
 * with STALE_ONLY unless `allow_stale` (plan 01 §5.4); an `omit`-class input past it is dropped.
 */
export function inputOf(
  stamp: PlatformStamp | DatasetStamp,
  nowMs: number,
  allowStale: boolean,
): InputStamp | null {
  const input = stampToInput(stamp, nowMs);
  if (input.state === "expired" && !allowStale) {
    const cls = freshnessClass(
      "freshness_class" in stamp ? stamp.freshness_class : stamp.freshness,
    );
    if (cls.beyondHard === "omit") return null;
    throw new FfError("STALE_ONLY");
  }
  return input;
}

/** `inputOf` for a stamp that can never be `omit`-class (platform facts). */
export function platformInput(
  stamp: PlatformStamp,
  nowMs: number,
  allowStale: boolean,
): InputStamp {
  const i = inputOf(stamp, nowMs, allowStale);
  if (i === null) throw new FfError("INTERNAL");
  return i;
}

/**
 * The input of a REQUIRED dataset read: a never-loaded dataset (stamp null) is STALE_ONLY with the
 * "run ff refresh" hint, never an empty success (plan 07 §2; critic C-14 (c)).
 */
export function requiredDataset<T>(
  r: DatasetResult<T>,
  nowMs: number,
  allowStale: boolean,
): InputStamp | null {
  if (r.stamp === null) throw new FfError("STALE_ONLY", { hint: DATASET_NEVER_LOADED_HINT });
  return inputOf(r.stamp, nowMs, allowStale);
}

/** The hint for a current dataset whose file is missing or unreadable: a plain refresh repairs it. */
export function datasetUnreadableHint(source: DatasetSourceId): string {
  return `Run \`ff refresh ${source}\` in a terminal, then retry.`;
}

/**
 * `requiredDataset` for a named source (QA-1-038): when nothing could be read but the refresh log
 * lists a current file for `source`, that file is missing or unreadable (a torn copy, a restore, a
 * disk problem) — not "never loaded" and not "older than its hard limit". The error says so and
 * names the one refresh that repairs it.
 */
export function requiredSource<T>(
  ctx: ToolContext,
  source: DatasetSourceId,
  r: DatasetResult<T>,
  allowStale: boolean,
): InputStamp | null {
  if (r.stamp === null && ctx.services.refreshLog.current().some((c) => c.source === source))
    throw new FfError("STALE_ONLY", {
      variant: "dataset_unreadable",
      hint: datasetUnreadableHint(source),
    });
  return requiredDataset(r, ctx.nowMs, allowStale);
}

/** The input of an OPTIONAL dataset read (injuries, weather): null when never loaded. */
export function optionalDataset<T>(
  r: DatasetResult<T>,
  nowMs: number,
  allowStale: boolean,
): InputStamp | null {
  return r.stamp === null ? null : inputOf(r.stamp, nowMs, allowStale);
}

/** Drops nulls. */
export function present<T>(xs: readonly (T | null | undefined)[]): T[] {
  return xs.filter((x): x is T => x !== null && x !== undefined);
}

/**
 * Resolves the league a call is about (plan 07 §2 `league_key?`): the operator's leagues ∩
 * FF_LEAGUE_KEYS; an argument outside that set is a coded VALIDATION (plan 02 §5), never a probe.
 */
export async function leagueContext(
  ctx: ToolContext,
  args: {
    readonly league_key?: string | undefined;
    readonly force_refresh?: boolean | undefined;
    readonly allow_stale?: boolean | undefined;
  },
): Promise<LeagueContext> {
  const key = `league:${args.league_key ?? ""}`;
  const cached = ctx.memo.get(key) as LeagueContext | undefined;
  if (cached !== undefined) return cached;
  const opts = readOpts(args);
  const allowStale = args.allow_stale === true;
  const refs = (await ctx.services.platform.listMyLeagues(opts)).value;
  const allowList = ctx.options.leagueKeys;
  const allowed = refs.filter((r) => allowList.length === 0 || allowList.includes(r.league_key));
  let ref: LeagueRef | undefined;
  if (args.league_key === undefined) {
    ref = allowed[0];
    if (ref === undefined) throw new FfError("NOT_FOUND");
  } else {
    ref = allowed.find((r) => r.league_key === args.league_key);
    if (ref === undefined)
      throw new FfError("VALIDATION", { field: "league_key", reason: "not_allowed" });
  }
  const got = await ctx.services.platform.getLeague(ref, opts);
  const lc: LeagueContext = {
    ref,
    league: got.value,
    input: platformInput(got.stamp, ctx.nowMs, allowStale),
    allowStale,
  };
  ctx.memo.set(key, lc);
  return lc;
}

/** A stamped platform read → its value, pushing its input onto `inputs`. */
export function take<T>(
  ctx: ToolContext,
  s: Stamped<T>,
  inputs: InputStamp[],
  allowStale: boolean,
): T {
  inputs.push(platformInput(s.stamp, ctx.nowMs, allowStale));
  return s.value;
}

/** The week a call means: the argument, else the league's current week. */
export function weekOf(lc: LeagueContext, week: number | undefined): Week {
  return week ?? lc.league.current_week;
}

/** The team a call means: the argument (checked against the league), else my team. */
export function teamOf(lc: LeagueContext, teamKey: string | undefined): TeamRef {
  if (teamKey === undefined) {
    if (lc.league.my_team === null) throw new FfError("NOT_FOUND");
    return lc.league.my_team;
  }
  if (!teamKey.startsWith(`${lc.ref.league_key}.t.`))
    throw new FfError("VALIDATION", { field: "team_key", reason: "not_in_league" });
  return { platform: lc.ref.platform, league_key: lc.ref.league_key, team_key: teamKey };
}

/** The lock mode the league reports (the manual provider sets `weekly_deadline: "weekly"`). */
export function lockModeOf(league: League): LockMode {
  return league.weekly_deadline === "weekly" ? "weekly" : "per_game";
}

/** The provenance tag of a platform text field (`manual.team.name`, `yahoo.player.name`, …). */
export function textSource(platform: string, field: string): string {
  const tag = `${platform}.${field}`;
  if (!isUntrustedSource(tag)) throw new FfError("INTERNAL");
  return tag;
}

/** A bare-field declaration. */
export function bare(path: string, source: string): UntrustedField {
  return { path, source };
}

// --- datasets -----------------------------------------------------------------------------------------

/** The week's scheduled games (memoised per call). */
export function weekGames(ctx: ToolContext, season: number, week: Week): DatasetResult<NflGame> {
  return memo(ctx, `games:${String(season)}:${String(week)}`, () =>
    ctx.services.datasets.schedules.games(season, [week]),
  );
}

/** Every week 1..22 of a season (for byes). */
export const ALL_WEEKS: readonly Week[] = Object.freeze(
  Array.from({ length: 22 }, (_, i) => i + 1),
);

/** A season's games (memoised per call). */
export function seasonGames(ctx: ToolContext, season: number): DatasetResult<NflGame> {
  return memo(ctx, `season:${String(season)}`, () =>
    ctx.services.datasets.schedules.games(season, ALL_WEEKS),
  );
}

/**
 * Whether a week's platform scoring is still provisional (plan 01 §5.4; research 03 §D.2): it has
 * started and the next week's first kickoff has not passed. A week not yet started is not provisional.
 */
export function weekProvisional(ctx: ToolContext, season: number, week: Week): boolean {
  const first = ctx.services.datasets.schedules.firstKickoff(season, week);
  if (first === null || ctx.nowMs < Date.parse(first)) return false;
  const next = week < 22 ? ctx.services.datasets.schedules.firstKickoff(season, week + 1) : null;
  return isProvisionalWeek(next === null ? null : Date.parse(next), ctx.nowMs);
}

/** Whether a week is final (it started and the next week's first kickoff has passed). */
export function weekFinal(ctx: ToolContext, season: number, week: Week): boolean {
  const first = ctx.services.datasets.schedules.firstKickoff(season, week);
  if (first === null || ctx.nowMs < Date.parse(first)) return false;
  return !weekProvisional(ctx, season, week);
}

/** The nflverse weekly roster of a season (memoised). */
export function rosterRows(ctx: ToolContext, season: number): DatasetResult<NflRosterPlayer> {
  return memo(ctx, `roster:${String(season)}`, () => ctx.services.rosterWeekly.latest(season));
}

// --- crosswalk ------------------------------------------------------------------------------------------

/** One platform player with its crosswalk resolution and projection subject. */
export interface ResolvedEntry {
  readonly player: PlatformPlayer;
  readonly resolution: CrosswalkResolution;
  readonly subject: ProjectionSubject | null;
  readonly gsis_id: string | null;
}

/** A crosswalk run over `players` (read-only: tools never persist pairs — decision). */
export function crosswalkRun(
  ctx: ToolContext,
  season: number,
  players: readonly PlatformPlayer[],
): { readonly run: CrosswalkRun; readonly byKey: ReadonlyMap<string, ResolvedEntry> } {
  const roster = rosterRows(ctx, season);
  const run = resolveCrosswalk({
    platform: ctx.services.platform.id,
    players,
    roster: buildRosterIndex(roster.rows),
    overrides: ctx.services.crosswalkOverrides,
    persisted: ctx.services.crosswalk,
    now: new Date(ctx.nowMs).toISOString(),
  });
  const byKey = new Map<string, ResolvedEntry>();
  for (const r of run.resolved) {
    const subject = subjectOf(r.resolution);
    byKey.set(r.player.ref.id, {
      player: r.player,
      resolution: r.resolution,
      subject,
      gsis_id: subject?.kind === "player" ? subject.gsis_id : null,
    });
  }
  return { run, byKey };
}

/** The most players a universe read pages through (100 per page). */
export const UNIVERSE_MAX_PAGES = 20;

/** Every player the platform lists (status A), resolved through the crosswalk (memoised per call). */
export async function leagueUniverse(
  ctx: ToolContext,
  lc: LeagueContext,
  inputs: InputStamp[],
): Promise<{ readonly run: CrosswalkRun; readonly byKey: ReadonlyMap<string, ResolvedEntry> }> {
  const key = `universe:${lc.ref.league_key}`;
  const cached = ctx.memo.get(key) as
    { run: CrosswalkRun; byKey: ReadonlyMap<string, ResolvedEntry> } | undefined;
  if (cached !== undefined) return cached;
  const players: PlatformPlayer[] = [];
  let offset = 0;
  for (let page = 0; page < UNIVERSE_MAX_PAGES; page++) {
    const got = await ctx.services.platform.listPlayers(
      lc.ref,
      { status: "A", position: null, search: null, sort: null, sort_type: null, sort_week: null },
      { limit: 100, offset },
    );
    if (page === 0) inputs.push(platformInput(got.stamp, ctx.nowMs, lc.allowStale));
    players.push(...got.value.items);
    if (!got.value.has_more || got.value.next_offset === null) break;
    offset = got.value.next_offset;
  }
  const out = crosswalkRun(ctx, lc.league.season, players);
  ctx.memo.set(key, out);
  return out;
}

/**
 * A player key's projection subject without the league universe: a `manual.p.<gsis>` key is the
 * gsis id itself and `manual.p.def-<team>` the team (plan 01 §8 X1 key rule).
 */
export function subjectFromKey(key: string): ProjectionSubject | null {
  const gsis = gsisFromManualKey(key);
  if (gsis !== null) return { kind: "player", gsis_id: gsis };
  const team = teamFromManualDefKey(key);
  return team === null ? null : { kind: "defense", nfl_team: team };
}

/** The nflverse team of a platform player (its abbreviation normalised), or null. */
export function nflTeamOf(p: PlatformPlayer): NflTeam | null {
  return normalizeTeam(p.team_abbr);
}

/** The player's lock instant from the week's games (null on bye / unknown kickoff). */
export function isPastLock(lockAt: string | null, nowMs: number): boolean {
  return isLocked(lockAt, nowMs);
}

/** Every slot name and eligible position the league knows (C2 `position` validation). */
export function leaguePositions(slots: RosterSlots): Set<string> {
  const out = new Set<string>();
  for (const s of slots.slots) {
    out.add(s.name);
    for (const e of s.eligible) out.add(e);
  }
  return out;
}

/** The settings digest read once per call. */
export async function scoringOf(
  ctx: ToolContext,
  lc: LeagueContext,
  inputs: InputStamp[],
): Promise<ScoringSettings> {
  const got = await ctx.services.platform.getScoringSettings(lc.ref);
  return take(ctx, got, inputs, lc.allowStale);
}

/** The roster slots read once per call. */
export async function slotsOf(
  ctx: ToolContext,
  lc: LeagueContext,
  inputs: InputStamp[],
): Promise<RosterSlots> {
  const got = await ctx.services.platform.getRosterSlots(lc.ref);
  return take(ctx, got, inputs, lc.allowStale);
}

/** A season year for Yahoo-free tools when no league is configured: the NFL season of `nowMs`. */
export function seasonOfInstant(nowMs: number): number {
  const d = new Date(nowMs);
  return d.getUTCMonth() < 2 ? d.getUTCFullYear() - 1 : d.getUTCFullYear();
}

/**
 * A player's stat line typed by his LEAGUE position (QA-1-018): nflverse types a line by its own
 * roster position, so a player the league lists as WR but nflverse as CB would score 0 under the
 * offence rules. The line keeps nflverse's type only when the league position maps to none.
 */
export function leagueTypedLine(
  line: StatLine,
  leaguePosition: string | null | undefined,
): StatLine {
  const pt = positionTypeForLeaguePosition(leaguePosition);
  return pt === null || pt === line.position_type ? line : withPositionType(line, pt);
}
