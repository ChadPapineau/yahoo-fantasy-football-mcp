// common.ts — what the plan 07 §2 conventions need in every tool: league resolution against the
// allow-list (plan 02 §5 league scoping), stamps → envelope inputs through the ONE conversion
// (stampToInput; STALE_ONLY past a hard limit unless allow_stale — plan 01 §5.4), the never-loaded
// dataset answer (C-14 (c)), provenance tags for untrusted text (plan 02 §6.2), the crosswalk run
// behind every gsis id a tool shows (research 04 §D; plan 07 C1), and week/lock helpers (plan 07 B1).
import {
  SOURCE_REGISTRY,
  freshnessClass,
  isDatasetSourceId,
  type DatasetSourceId,
} from "../../config/freshness.js";
import type { NflTeam } from "../../config/schema.js";
import { ALL_WEEK_INDEXES } from "../../config/weeks.js";
import type { DatasetResult, DatasetStamp, NflGame } from "../../domain/analytics/types.js";
import { datasetCoverage, type Coverage } from "../../domain/league/coverage.js";
import {
  scheduleWarnings,
  tentativeWeeks,
  type TentativeWeek,
} from "../../domain/league/kickoff-status.js";
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
  humanAge,
  isUntrustedSource,
  stampToInput,
  type InputStamp,
  type UntrustedField,
} from "../envelope.js";
import {
  DATASET_NEVER_LOADED_HINT,
  FfError,
  REFRESH_IN_PROGRESS_HINT,
  refreshFailedHint,
  seasonNotPublishedHint,
} from "../errors.js";
import type { ToolContext } from "../define.js";
import { refreshRowOf } from "../refresh.js";

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

/** What judging a stamp needs from a call: its instant, its schedule view and refresh report. */
export type CallView = Pick<ToolContext, "nowMs" | "view" | "refresh">;

/**
 * The STALE_ONLY for a required input this call cannot serve (season-fresh §6.4): when its
 * answer-time refresh is still running (or another process's is), `refresh_in_progress` (ask again in
 * a minute); when it failed or is backing off, `refresh_failed` naming the code; otherwise the table's
 * error (or `fallback`).
 */
function staleOnly(ctx: CallView, source: string, fallback?: FfError): FfError {
  const row = isDatasetSourceId(source) ? refreshRowOf(ctx.refresh, source) : null;
  if (row?.outcome === "in_progress" || row?.outcome === "joined")
    return new FfError("STALE_ONLY", {
      variant: "refresh_in_progress",
      hint: REFRESH_IN_PROGRESS_HINT,
    });
  if (row?.outcome === "failed" || row?.outcome === "backoff")
    return new FfError("STALE_ONLY", {
      variant: "refresh_failed",
      hint: refreshFailedHint(source, row.code ?? row.outcome),
    });
  return fallback ?? new FfError("STALE_ONLY");
}

/**
 * A platform or dataset stamp as an envelope input — judged under the call's game calendar
 * (QA-2-037) — refusing an input past its class's hard limit with STALE_ONLY unless `allow_stale`
 * (plan 01 §5.4); an `omit`-class input past it is dropped.
 */
export function inputOf(
  ctx: CallView,
  stamp: PlatformStamp | DatasetStamp,
  allowStale: boolean,
): InputStamp | null {
  const input = stampToInput(stamp, ctx.nowMs, ctx.view.calendar);
  if (input.state === "expired" && !allowStale) {
    const cls = freshnessClass(
      "freshness_class" in stamp ? stamp.freshness_class : stamp.freshness,
    );
    if (cls.beyondHard === "omit") return null;
    throw staleOnly(ctx, stamp.source);
  }
  return input;
}

/** `inputOf` for a stamp that can never be `omit`-class (platform facts). */
export function platformInput(
  ctx: CallView,
  stamp: PlatformStamp,
  allowStale: boolean,
): InputStamp {
  const i = inputOf(ctx, stamp, allowStale);
  if (i === null) throw new FfError("INTERNAL");
  return i;
}

/** The hint for a current dataset whose file is missing or unreadable: a plain refresh repairs it. */
export function datasetUnreadableHint(source: DatasetSourceId): string {
  return `Run \`ff refresh ${source}\` in a terminal, then retry.`;
}

/**
 * The hint when the file holds other seasons but not the one asked for (and no check says why).
 * `--seasons` only for a season upstream is known to have (one before the season in progress); for
 * that season or a later one a plain refresh, which asks upstream and records a season it has not
 * published yet — the next answer then says so instead of asking for a refresh again.
 */
export function seasonMissingHint(
  source: DatasetSourceId,
  season: number,
  phaseSeason: number,
): string {
  return season < phaseSeason
    ? `No ${String(season)} data of ${source} is loaded: run \`ff refresh ${source} --seasons ${String(season)}\` in a terminal, then retry.`
    : `No ${String(season)} data of ${source} is loaded, and upstream may not have published it yet: run \`ff refresh ${source}\` in a terminal (it checks), then retry.`;
}

/** The note an optional source's unpublished season adds (season-fresh §3.3). */
export function notPublishedNote(source: DatasetSourceId, season: number, age: string): string {
  return `no ${String(season)} ${source} published upstream yet (checked ${age} ago)`;
}

/** Whole-second age of an instant at the call, as `humanAge` prints it. */
function ageOf(ctx: CallView, iso: string | null): string {
  const ms = iso === null ? Number.NaN : Date.parse(iso);
  return Number.isFinite(ms) ? humanAge(Math.max(0, Math.floor((ctx.nowMs - ms) / 1000))) : "?";
}

/** Whether the attached file of `source` covers `season` (season-fresh §3.3). */
export function coverageOf(
  ctx: Pick<ToolContext, "nowMs" | "view" | "services">,
  source: DatasetSourceId,
  stamp: DatasetStamp | null,
  season: number,
): Coverage {
  return datasetCoverage({
    stamp,
    season,
    phase: ctx.view.phase,
    check: ctx.services.seasonChecks.latest(source, season),
    hardLimitSeconds: freshnessClass(SOURCE_REGISTRY[source].freshness).hardLimitSeconds,
    nowMs: ctx.nowMs,
  });
}

/**
 * A covered stamp as an input: a finished season's data does not age (`complete` — an `expired`
 * judgment is served as `stale`, never STALE_ONLY); otherwise `inputOf`.
 */
function coveredInput(
  ctx: CallView,
  stamp: DatasetStamp,
  cov: Coverage,
  allowStale: boolean,
): InputStamp | null {
  if (cov.state === "complete") {
    const i = stampToInput(stamp, ctx.nowMs, ctx.view.calendar);
    return i.state === "expired" ? { ...i, state: "stale" } : i;
  }
  return inputOf(ctx, stamp, allowStale);
}

/** How a required read treats a season upstream has not published yet. */
export interface RequiredUse {
  /**
   * `fatal` (default): STALE_ONLY `season_not_published` naming the season; `note`: answer without
   * it, with the named note (the projections' trailing window reaches the previous season; D2's
   * September case).
   */
  readonly unpublished?: "fatal" | "note";
}

/**
 * The input of a REQUIRED dataset read of `season` (plan 07 §2; critic C-14 (c); QA-1-038;
 * season-fresh §3.3, §6.4): never an empty success. Not published upstream yet → STALE_ONLY
 * `season_not_published` (or, with `unpublished: "note"`, the named note); never loaded → STALE_ONLY
 * (`refresh_in_progress` / `refresh_failed` when this call's refresh says so, `dataset_unreadable`
 * when the refresh log lists a current file the server cannot attach, else the "run ff refresh"
 * hint); a file without that season → STALE_ONLY naming it; a finished season never expires.
 */
export function requiredSource<T>(
  ctx: ToolContext,
  source: DatasetSourceId,
  r: DatasetResult<T>,
  allowStale: boolean,
  season: number,
  use: RequiredUse = {},
): InputStamp | null {
  const cov = coverageOf(ctx, source, r.stamp, season);
  if (cov.state === "not_published") {
    if (use.unpublished !== "note")
      throw new FfError("STALE_ONLY", {
        variant: "season_not_published",
        hint: seasonNotPublishedHint(source, season, ageOf(ctx, cov.checked_at)),
      });
    ctx.notes.push(notPublishedNote(source, season, ageOf(ctx, cov.checked_at)));
    return r.stamp === null
      ? null
      : coveredInput(ctx, r.stamp, { ...cov, state: "complete" }, true);
  }
  if (r.stamp === null) {
    const unreadable = ctx.services.refreshLog.current().some((c) => c.source === source);
    throw staleOnly(
      ctx,
      source,
      unreadable
        ? new FfError("STALE_ONLY", {
            variant: "dataset_unreadable",
            hint: datasetUnreadableHint(source),
          })
        : new FfError("STALE_ONLY", { hint: DATASET_NEVER_LOADED_HINT }),
    );
  }
  if (cov.state === "missing")
    throw staleOnly(
      ctx,
      source,
      new FfError("STALE_ONLY", {
        hint: seasonMissingHint(source, season, ctx.view.phase.season),
      }),
    );
  return coveredInput(ctx, r.stamp, cov, allowStale);
}

/**
 * The input of an OPTIONAL dataset read of `season` (injuries, weekly rosters, the schedule as a
 * driver): null when never loaded or without that season; a season not published upstream yet adds
 * the named note (season-fresh §3.3).
 */
export function optionalSource<T>(
  ctx: ToolContext,
  source: DatasetSourceId,
  r: DatasetResult<T>,
  allowStale: boolean,
  season: number,
): InputStamp | null {
  const cov = coverageOf(ctx, source, r.stamp, season);
  if (cov.state === "not_published") {
    ctx.notes.push(notPublishedNote(source, season, ageOf(ctx, cov.checked_at)));
    return null;
  }
  if (r.stamp === null || cov.state === "missing") return null;
  return coveredInput(ctx, r.stamp, cov, allowStale);
}

/** Whether a source's season is loaded (covered or complete) — e.g. D2's "report loaded". */
export function seasonLoaded(
  ctx: ToolContext,
  source: DatasetSourceId,
  stamp: DatasetStamp | null,
  season: number,
): boolean {
  const st = coverageOf(ctx, source, stamp, season).state;
  return stamp !== null && (st === "covered" || st === "complete");
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
  // the provider's notes about defaults it applied (an end week from no schedule) reach the answer
  for (const n of got.value.notes ?? []) if (!ctx.notes.includes(n)) ctx.notes.push(n);
  const lc: LeagueContext = {
    ref,
    league: got.value,
    input: platformInput(ctx, got.stamp, allowStale),
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
  inputs.push(platformInput(ctx, s.stamp, allowStale));
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

/** A season's games, every week the data holds (memoised per call; no assumed season length). */
export function seasonGames(ctx: ToolContext, season: number): DatasetResult<NflGame> {
  return memo(ctx, `season:${String(season)}`, () =>
    ctx.services.datasets.schedules.games(season, ALL_WEEK_INDEXES),
  );
}

/**
 * The last week of `season` in the loaded schedule (postseason included), or null when the season
 * is not loaded — the bound every "until the end of the season" loop uses (season-fresh §2.6).
 */
export function lastWeekOf(ctx: Pick<ToolContext, "view">, season: number): Week | null {
  return ctx.view.schedule(season)?.last_week ?? null;
}

/**
 * Whether a week's platform scoring is still provisional (plan 01 §5.4; research 03 §D.2): it has
 * started and the next week's first kickoff has not passed. A week not yet started is not provisional.
 */
export function weekProvisional(ctx: ToolContext, season: number, week: Week): boolean {
  const first = ctx.services.datasets.schedules.firstKickoff(season, week);
  if (first === null || ctx.nowMs < Date.parse(first)) return false;
  const last = lastWeekOf(ctx, season);
  const next =
    last !== null && week < last
      ? ctx.services.datasets.schedules.firstKickoff(season, week + 1)
      : null;
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
    if (page === 0) inputs.push(platformInput(ctx, got.stamp, lc.allowStale));
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

// --- the season and the schedule notes (season-fresh §2.3, §5.2, §5.3) ----------------------------------

/**
 * The tentative weeks among `weeks` of `season` (placeholder week, TBD time, a flex window still
 * open) from the loaded schedule — any week the tool asks about, not only the next three.
 */
export function tentativeFor(
  ctx: Pick<ToolContext, "view" | "nowMs">,
  season: number,
  weeks: readonly Week[],
): TentativeWeek[] {
  if (weeks.length === 0) return [];
  const from = Math.min(...weeks);
  const wanted = new Set(weeks);
  return tentativeWeeks(
    {
      games: (s) => ctx.view.games(s),
      schedule: (s) => ctx.view.schedule(s),
      // the same rule over the requested season, from the first requested week
      phase: { ...ctx.view.phase, season, phase: "regular", week: from },
    },
    ctx.nowMs,
    Number.MAX_SAFE_INTEGER,
  ).filter((t) => wanted.has(t.week));
}

/**
 * The schedule notes of a result (season-fresh §5.2): kickoff changes detected in the last 7 days
 * for the requested season/weeks (and teams, when known), then the tentative weeks among them; at
 * most 3 lines and a count. Added to `ctx.notes`.
 */
export function addScheduleNotes(
  ctx: ToolContext,
  season: number,
  weeks: readonly Week[],
  teams: ReadonlySet<NflTeam> | null,
): void {
  const since = new Date(ctx.nowMs - SCHEDULE_NOTES_LOOKBACK_MS).toISOString();
  ctx.notes.push(
    ...scheduleWarnings({
      changes: ctx.services.scheduleChanges.recent(since, SCHEDULE_NOTES_MAX_ROWS),
      tentative: tentativeFor(ctx, season, weeks),
      season,
      weeks,
      teams,
      nowMs: ctx.nowMs,
    }),
  );
}

/** How far back the schedule notes read the change log (the warning window is 7 days). */
const SCHEDULE_NOTES_LOOKBACK_MS = 7 * 86_400_000;
/** The most change rows one result reads. */
const SCHEDULE_NOTES_MAX_ROWS = 200;

/**
 * The league-season notes of the analytics tools (season-fresh §12 B3): a league file for another
 * season than the NFL season in progress, or for a finished season. Silent while they agree (and in
 * the off-season for a league file of the next season — draft preparation).
 */
export function leagueSeasonNote(
  ctx: Pick<ToolContext, "view">,
  leagueSeason: number,
): string | null {
  const p = ctx.view.phase;
  if (p.phase === "offseason") {
    return leagueSeason <= p.season
      ? `league season ${String(leagueSeason)} is finished; recommendations describe a completed season`
      : null;
  }
  return leagueSeason === p.season
    ? null
    : `league season ${String(leagueSeason)} is not the NFL season in progress (${String(p.season)}, ${p.phase}): run the onboard Skill's new-season step`;
}

/** The note when a league week has no NFL games in the loaded schedule. */
export function noScheduleNote(season: number, week: Week): string {
  return `no ${String(season)} NFL schedule loaded for week ${String(week)}`;
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
