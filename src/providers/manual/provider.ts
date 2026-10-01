// provider.ts — ManualLeagueProvider: the FantasyPlatform over <config>/league.yaml (plan 01 §8 X1
// and A-12; plan 10 §3.1a platform seam; plan 07 A1–A5/B1/B2/C1/C2 as the manual league can serve
// them; plan 02 §3.3 0600 file in a 0700 dir, identifiers never logged). Every read re-reads the
// file (O_NOFOLLOW, 0600, size-capped), returns Stamped<T> (class manual_league, as_of = file mtime),
// and answers what the YAML lacks with the contract's empty result — never an invented value; the
// tool adds the MANUAL_* warning from `capabilities().read_features` (critic C-14).
import { lstatSync, statSync } from "node:fs";
import path from "node:path";
import { NFL_TEAMS, type NflTeam } from "../../config/schema.js";
import { ensureSecureDir, PathSecurityError, readSecureFile } from "../../config/paths.js";
import type { ScheduleReader, NflGame } from "../../domain/analytics/types.js";
import type { Clock } from "../../domain/clock.js";
import { nameKey } from "../../domain/crosswalk/normalize.js";
import type { RosterWeeklyReader } from "../../domain/crosswalk/types.js";
import {
  byeWeekOf,
  byeWeeks,
  gamesOfWeek,
  isLocked,
  lockAtFor,
  firstKickoff,
  leagueWeeks,
  weekEndsAt,
  weekPosition,
  kickoffMs,
} from "../../domain/league/schedule.js";
import { eligibleSlotNames, slotByName } from "../../domain/league/slots.js";
import { manualPlayerKeyFor } from "../../domain/league/types.js";
import {
  LeagueFileError,
  readOnlyCapabilities,
  type FantasyPlatform,
  type League,
  type LeagueRef,
  type Matchup,
  type MatchupTeam,
  type Page,
  type PageOf,
  type PlatformCapabilities,
  type PlatformPlayer,
  type PlatformStatLine,
  type PlayerOwnership,
  type PlayerQuery,
  type PlayerRef,
  type Roster,
  type RosterEntry,
  type RosterSlots,
  type Stamped,
  type Standing,
  type StatsQuery,
  type TeamRef,
  type Transaction,
  type TxnQuery,
  type Week,
  type ReadFeatures,
  type ScoringSettings,
} from "../platform.js";
import {
  normalizeLeague,
  type ManualLeagueData,
  type ManualPlayer,
  type ManualTeam,
} from "./normalize.js";
import { MAX_LEAGUE_FILE_BYTES, parseLeagueYaml } from "./parse.js";
import { issuesOf, leagueFileSchema } from "./schema.js";

/** Every week number the schedule may hold (plan 02 §5 bound). */
const ALL_WEEKS: readonly Week[] = Object.freeze(Array.from({ length: 22 }, (_, i) => i + 1));

/** A request for a league, team or week this file does not hold → NOT_FOUND (plan 01 §4.3). */
export class ManualNotFoundError extends Error {
  readonly ffCode = "NOT_FOUND" as const;
  constructor(what: "league" | "team") {
    super(`manual league: unknown ${what}`);
    this.name = "ManualNotFoundError";
  }
}

/**
 * Where identifiers are registered for redaction — structurally the logger's `registerSecret`
 * (src/cli/log.ts; providers may not import the CLI layer, so the shape is restated here).
 */
export interface IdentifierSink {
  registerSecret(kind: string, value: string): void;
}

/** Construction options. */
export interface ManualLeagueProviderOptions {
  /** Absolute path of league.yaml (Config.leagueFile). */
  readonly file: string;
  /** The one source of "now" (stamps, current week, locks). */
  readonly clock: Clock;
  /** Where the league/team/manager names are registered as identifiers before any log line. */
  readonly logger?: IdentifierSink;
  /** The attached nflverse schedule: enables byes, locks, the league calendar and current week. */
  readonly schedule?: ScheduleReader;
  /** The attached nflverse weekly rosters: the kicker universe for `listPlayers`. */
  readonly rosters?: RosterWeeklyReader;
  /**
   * Enforce 0600 + owner on the file and 0700 + secure ancestors on its directory (default true).
   * Only fixture mode (the in-repo placeholder league, plan 03 FF_FIXTURE_DIR) passes false.
   */
  readonly requirePrivate?: boolean;
}

interface Loaded {
  readonly data: ManualLeagueData;
  readonly as_of: string;
}

/** Converts a manual player into the platform record the tools read. */
function toPlatformPlayer(
  p: ManualPlayer,
  slots: RosterSlots,
  ownership: PlayerOwnership,
  bye: Week | null,
  nameSource: "platform" | "dataset" = "platform",
): PlatformPlayer {
  return Object.freeze({
    ref: Object.freeze({ platform: "manual" as const, id: p.key }),
    name: p.name,
    team_abbr: p.nfl_team,
    position: p.position,
    eligible_positions: Object.freeze(
      eligibleSlotNames(slots, { positions: p.positions, status: p.status }),
    ),
    uniform_number: p.jersey,
    status: p.status,
    status_full: null,
    injury_note: null,
    bye_week: bye,
    percent_owned: null,
    percent_owned_delta: null,
    ownership,
    gsis_hint: p.gsis_id,
    name_source: nameSource,
  });
}

const UNKNOWN_OWNERSHIP: PlayerOwnership = Object.freeze({
  type: "unknown",
  owner_team_key: null,
  owner_name: null,
  waiver_date: null,
});

/** The FantasyPlatform over a hand-written league.yaml (read-only; plan 01 §8 X1). */
/** A letter or digit: a query without one cannot name anybody. */
const NAME_CHAR_RE = /[\p{L}\p{N}]/u;

/**
 * The C1 name search (plan 07 C1 "a name to a player_key"; QA-1-084): a player matches when the
 * query is a substring of his name under NFKC + case folding, OR under the crosswalk's name key
 * (plan 05 §2: apostrophes of every kind, periods, hyphens, spacing and diacritics folded away), so
 * `Ja’Marr`, `JaMarr`, `St Brown` and `Amon Ra` find the players spelled `Ja'Marr Chase` and
 * `Amon-Ra St. Brown`. The literal path keeps suffix queries (`Walker III`) that the key strips. A
 * query with no letter or digit matches nobody.
 */
export function nameMatcher(query: string): (name: string) => boolean {
  if (!NAME_CHAR_RE.test(query)) return () => false;
  const literal = query.normalize("NFKC").toLowerCase();
  const key = nameKey(query);
  return (name) => {
    if (name.normalize("NFKC").toLowerCase().includes(literal)) return true;
    if (key === null) return false;
    return nameKey(name)?.includes(key) ?? false;
  };
}

export class ManualLeagueProvider implements FantasyPlatform {
  readonly id = "manual" as const;
  private readonly opts: ManualLeagueProviderOptions;
  private cache: { text: string; data: ManualLeagueData } | null = null;

  constructor(opts: ManualLeagueProviderOptions) {
    if (!path.isAbsolute(opts.file))
      throw new RangeError("manual league: file path must be absolute");
    this.opts = opts;
  }

  // --- loading ------------------------------------------------------------------------------------

  /** Reads, parses and validates league.yaml; throws LeagueFileError (missing | invalid). */
  load(): Loaded {
    const file = this.opts.file;
    const requirePrivate = this.opts.requirePrivate ?? true;
    const dir = path.dirname(file);
    try {
      lstatSync(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new LeagueFileError("missing");
      throw new LeagueFileError("invalid", [
        { path: "<config dir>", reason: "the directory could not be read" },
      ]);
    }
    let text: string | null;
    try {
      if (requirePrivate) ensureSecureDir(dir, { create: false, what: "config directory" });
      text = readSecureFile(file, {
        requirePrivate,
        maxBytes: MAX_LEAGUE_FILE_BYTES,
        what: "league.yaml",
      });
    } catch (e) {
      const reason = e instanceof PathSecurityError ? e.detail : "the file could not be read";
      const where =
        e instanceof PathSecurityError && e.path === dir ? "<config dir>" : "league.yaml";
      throw new LeagueFileError("invalid", [{ path: where, reason }]);
    }
    if (text === null) throw new LeagueFileError("missing");
    let mtimeMs: number;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      mtimeMs = this.opts.clock.nowMs();
    }
    const as_of = new Date(Math.floor(mtimeMs)).toISOString();
    if (this.cache?.text === text) return { data: this.cache.data, as_of };
    const raw = parseLeagueYaml(text);
    const parsed = leagueFileSchema.safeParse(raw);
    if (!parsed.success) throw new LeagueFileError("invalid", issuesOf(parsed.error, raw));
    const norm = normalizeLeague(parsed.data);
    if (!norm.ok) throw new LeagueFileError("invalid", norm.issues.slice(0, 50));
    for (const id of norm.data.identifiers) this.opts.logger?.registerSecret("identifier", id);
    this.cache = { text, data: norm.data };
    return { data: norm.data, as_of };
  }

  private stamp<T>(value: T, as_of: string): Stamped<T> {
    return Object.freeze({
      value,
      stamp: Object.freeze({
        source: "manual" as const,
        as_of,
        fetched_at: this.opts.clock.nowIso(),
        freshness: "manual_league" as const,
        provisional: false,
      }),
    });
  }

  private league(ref: LeagueRef): Loaded {
    const l = this.load();
    if (ref.platform !== "manual" || ref.league_key !== l.data.ref.league_key)
      throw new ManualNotFoundError("league");
    return l;
  }

  private team(data: ManualLeagueData, ref: TeamRef): ManualTeam {
    const t =
      ref.platform === "manual" && ref.league_key === data.ref.league_key
        ? data.teams.find((x) => x.ref.team_key === ref.team_key)
        : undefined;
    if (t === undefined) throw new ManualNotFoundError("team");
    return t;
  }

  /** The season's games, or [] without an attached schedule. */
  private games(season: number): readonly NflGame[] {
    return this.opts.schedule?.games(season, ALL_WEEKS).rows ?? [];
  }

  private features(data: ManualLeagueData): ReadFeatures {
    return {
      player_stats: false,
      transactions: data.transactions.length > 0,
      free_agent_pool: false,
      other_rosters: data.teams.some((t) => !t.is_mine && t.players !== null),
      matchups: data.opponents.size > 0,
      standings: false,
    };
  }

  // --- FantasyPlatform ------------------------------------------------------------------------------

  /** Read features from the file; all false (never a throw) when the file is missing or invalid. */
  capabilities(): Promise<PlatformCapabilities> {
    let features: ReadFeatures;
    try {
      features = this.features(this.load().data);
    } catch (e) {
      if (!(e instanceof LeagueFileError)) throw e;
      features = {
        player_stats: false,
        transactions: false,
        free_agent_pool: false,
        other_rosters: false,
        matchups: false,
        standings: false,
      };
    }
    return Promise.resolve(readOnlyCapabilities(features, this.opts.clock.nowIso()));
  }

  listMyLeagues(): Promise<Stamped<readonly LeagueRef[]>> {
    return this.run(() => {
      const l = this.load();
      return this.stamp(Object.freeze([l.data.ref]), l.as_of);
    });
  }

  getLeague(ref: LeagueRef): Promise<Stamped<League>> {
    return this.run(() => {
      const l = this.league(ref);
      const d = l.data;
      const games = this.games(d.season);
      const now = this.opts.clock.nowMs();
      const range = { start_week: d.start_week, end_week: d.end_week };
      const pos = weekPosition(games, d.season, range, now);
      const current = d.current_week_override ?? pos?.current ?? d.start_week;
      const finished = d.current_week_override === null && pos?.is_finished === true;
      const weeks = leagueWeeks(games, d.season, range, now).map((w) =>
        d.current_week_override === null
          ? w
          : Object.freeze({ ...w, is_current: w.week === current }),
      );
      const league: League = Object.freeze({
        ref: d.ref,
        name: d.name,
        season: d.season,
        num_teams: d.num_teams,
        scoring_type: d.scoring_type,
        current_week: current,
        start_week: d.start_week,
        end_week: d.end_week,
        edit_key: finished ? null : current,
        weekly_deadline: d.lock_mode === "weekly" ? "weekly" : null,
        league_update_timestamp: l.as_of,
        draft_status: "postdraft",
        is_finished: finished,
        my_team: d.my_team.ref,
        my_team_name: d.my_team.name,
        weeks: Object.freeze(weeks),
        rules: d.rules,
      });
      return this.stamp(league, l.as_of);
    });
  }

  getScoringSettings(ref: LeagueRef): Promise<Stamped<ScoringSettings>> {
    return this.run(() => {
      const l = this.league(ref);
      return this.stamp(l.data.scoring, l.as_of);
    });
  }

  getRosterSlots(ref: LeagueRef): Promise<Stamped<RosterSlots>> {
    return this.run(() => {
      const l = this.league(ref);
      return this.stamp(l.data.slots, l.as_of);
    });
  }

  /**
   * A team's roster. The file holds each team's CURRENT roster, so every week returns it (the
   * weekly re-edit is X1's price, A-12); a team the file names without players returns no entries.
   * With a schedule attached, `bye_week` and per-entry `is_editable` (unlocked) are filled.
   */
  getRoster(team: TeamRef, week: Week): Promise<Stamped<Roster>> {
    return this.run(() => {
      const l = this.load();
      const d = l.data;
      const t = this.team(d, team);
      const games = this.games(d.season);
      const weekGames = gamesOfWeek(games, d.season, week);
      const byes = byeWeeks(games, d.season, NFL_TEAMS);
      const now = this.opts.clock.nowMs();
      const ownership: PlayerOwnership = Object.freeze({
        type: "team",
        owner_team_key: t.ref.team_key,
        owner_name: t.name,
        waiver_date: null,
      });
      const entries: RosterEntry[] = (t.players ?? []).map((p) => {
        const slot = slotByName(d.slots, p.slot);
        const lockAt =
          weekGames.length === 0 ? null : lockAtFor(p.nfl_team, weekGames, d.lock_mode);
        return Object.freeze({
          player: toPlatformPlayer(p, d.slots, ownership, byeWeekOf(p.nfl_team, byes)),
          slot: p.slot,
          slot_class: slot?.class ?? "other",
          is_flex: slot?.class === "flex",
          is_editable: !isLocked(lockAt, now),
          week_points: null,
        });
      });
      const ends = weekEndsAt(weekGames);
      const roster: Roster = Object.freeze({
        team: t.ref,
        week,
        is_editable: ends === null ? true : now < ends,
        entries: Object.freeze(entries),
        roster_adds_week: null,
      });
      return this.stamp(roster, l.as_of);
    });
  }

  /**
   * The player pool (plan 01 §8 X1): every player the file names (rosters with their team as
   * owner, `free_agents`, `waivers`), then the team-defence universe and — with rosters attached —
   * the nflverse kicker universe, both with ownership `unknown` (plan 07 E5 availability unknown).
   * `FA` = listed free agents + unknown availability; `W` = listed waivers; `T` = rostered;
   * `K` (keepers) = none. Sorting is by name for `NAME`, else file order (no platform rank exists).
   */
  listPlayers(
    ref: LeagueRef,
    q: PlayerQuery,
    page: Page,
  ): Promise<Stamped<PageOf<PlatformPlayer>>> {
    return this.run(() => {
      const l = this.league(ref);
      const d = l.data;
      const games = this.games(d.season);
      const byes = byeWeeks(games, d.season, NFL_TEAMS);
      const bye = (t: NflTeam): Week | null => byeWeekOf(t, byes);
      const seen = new Set<string>();
      const all: { p: PlatformPlayer; kind: "T" | "FA" | "W" | "U" }[] = [];
      const push = (p: PlatformPlayer, kind: "T" | "FA" | "W" | "U"): void => {
        if (seen.has(p.ref.id)) return;
        seen.add(p.ref.id);
        all.push({ p, kind });
      };
      for (const t of d.teams) {
        const own: PlayerOwnership = Object.freeze({
          type: "team",
          owner_team_key: t.ref.team_key,
          owner_name: t.name,
          waiver_date: null,
        });
        for (const p of t.players ?? [])
          push(toPlatformPlayer(p, d.slots, own, bye(p.nfl_team)), "T");
      }
      const fa: PlayerOwnership = Object.freeze({ ...UNKNOWN_OWNERSHIP, type: "freeagents" });
      const wv: PlayerOwnership = Object.freeze({ ...UNKNOWN_OWNERSHIP, type: "waivers" });
      for (const p of d.free_agents) push(toPlatformPlayer(p, d.slots, fa, bye(p.nfl_team)), "FA");
      for (const p of d.waivers) push(toPlatformPlayer(p, d.slots, wv, bye(p.nfl_team)), "W");
      for (const team of NFL_TEAMS) {
        const def: ManualPlayer = {
          key: manualPlayerKeyFor({ kind: "defense", nfl_team: team }),
          name: team,
          nfl_team: team,
          position: "DEF",
          positions: ["DEF"],
          gsis_id: null,
          is_defense: true,
          status: null,
          jersey: null,
          slot: "BN",
        };
        push(toPlatformPlayer(def, d.slots, UNKNOWN_OWNERSHIP, bye(team)), "U");
      }
      for (const k of this.kickers(d.season))
        push(toPlatformPlayer(k, d.slots, UNKNOWN_OWNERSHIP, bye(k.nfl_team), "dataset"), "U");

      const wanted: ReadonlySet<string> =
        q.status === "A"
          ? new Set(["T", "FA", "W", "U"])
          : q.status === "FA"
            ? new Set(["FA", "U"])
            : q.status === "W"
              ? new Set(["W"])
              : q.status === "T"
                ? new Set(["T"])
                : new Set<string>();
      const matches = q.search === null ? null : nameMatcher(q.search);
      let items = all
        .filter((x) => wanted.has(x.kind))
        .map((x) => x.p)
        .filter(
          (p) =>
            q.position === null ||
            p.position === q.position ||
            p.eligible_positions.includes(q.position),
        )
        .filter((p) => matches === null || matches(p.name));
      if (q.sort === "NAME")
        items = [...items].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const total = items.length;
      const slice = items.slice(page.offset, page.offset + page.limit);
      const has_more = page.offset + slice.length < total;
      const out: PageOf<PlatformPlayer> = Object.freeze({
        items: Object.freeze(slice),
        limit: page.limit,
        offset: page.offset,
        count: slice.length,
        has_more,
        next_offset: has_more ? page.offset + slice.length : null,
        total,
      });
      return this.stamp(out, l.as_of);
    });
  }

  /** Kickers from the attached weekly rosters (none without them, or before the first load). */
  private kickers(season: number): ManualPlayer[] {
    const rows = this.opts.rosters?.latest(season).rows ?? [];
    const out: ManualPlayer[] = [];
    for (const r of rows) {
      if (r.position !== "K") continue;
      let key: string;
      try {
        key = manualPlayerKeyFor({ kind: "player", gsis_id: r.gsis_id });
      } catch {
        continue;
      }
      out.push({
        key,
        name: r.full_name,
        nfl_team: r.team,
        position: "K",
        positions: ["K"],
        gsis_id: r.gsis_id,
        is_defense: false,
        status: null,
        jersey: r.jersey_number,
        slot: "BN",
      });
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** Always empty: the manual league has no platform stat lines (`match` is null — plan 01 §8 X1). */
  getPlayerStats(
    ref: LeagueRef,
    _players: readonly PlayerRef[],
    _q: StatsQuery,
  ): Promise<Stamped<readonly PlatformStatLine[]>> {
    return this.run(() => {
      const l = this.league(ref);
      return this.stamp(Object.freeze([]), l.as_of);
    });
  }

  /** My matchup for the week when the file names the opponent; else empty. */
  getMatchups(ref: LeagueRef, week: Week): Promise<Stamped<readonly Matchup[]>> {
    return this.run(() => {
      const l = this.league(ref);
      const d = l.data;
      const oppKey = d.opponents.get(week);
      const opp = oppKey === undefined ? undefined : d.teams.find((t) => t.ref.team_key === oppKey);
      if (opp === undefined) return this.stamp(Object.freeze([]), l.as_of);
      const weekGames = gamesOfWeek(this.games(d.season), d.season, week);
      const now = this.opts.clock.nowMs();
      const first = kickoffMs(firstKickoff(weekGames));
      const ends = weekEndsAt(weekGames);
      const status =
        first === null || ends === null
          ? "unknown"
          : now < first
            ? "preevent"
            : now < ends
              ? "midevent"
              : "postevent";
      const side = (t: ManualTeam): MatchupTeam =>
        Object.freeze({
          team: t.ref,
          name: t.name,
          points: null,
          projected_points_platform: null,
          win_probability_platform: null,
        });
      const po = d.rules.playoffs;
      const m: Matchup = Object.freeze({
        week,
        status,
        is_playoffs: po.start_week === null ? null : week >= po.start_week,
        is_consolation: false,
        is_tied: false,
        winner_team_key: null,
        teams: Object.freeze<readonly [MatchupTeam, MatchupTeam]>([side(d.my_team), side(opp)]),
      });
      const list: readonly Matchup[] = Object.freeze([m]);
      return this.stamp(list, l.as_of);
    });
  }

  /** Always empty: league.yaml holds no standings (MANUAL_FEATURE_WARNINGS.standings). */
  getStandings(ref: LeagueRef): Promise<Stamped<readonly Standing[]>> {
    return this.run(() => {
      const l = this.league(ref);
      return this.stamp(Object.freeze([]), l.as_of);
    });
  }

  /** The file's transactions, newest first, filtered; empty when it lists none. */
  listTransactions(ref: LeagueRef, q: TxnQuery): Promise<Stamped<readonly Transaction[]>> {
    return this.run(() => {
      const l = this.league(ref);
      const since = q.since === null ? null : Date.parse(q.since);
      const count = Math.max(0, Math.min(200, Math.floor(q.count)));
      const out = l.data.transactions
        .filter((t) => q.types === null || q.types.includes(t.type as never))
        .filter(
          (t) =>
            q.team_key === null ||
            t.trader_team_key === q.team_key ||
            t.tradee_team_key === q.team_key ||
            t.players.some(
              (p) => p.source_team_key === q.team_key || p.destination_team_key === q.team_key,
            ),
        )
        .filter(
          (t) => since === null || !Number.isFinite(since) || Date.parse(t.timestamp) >= since,
        )
        .slice(0, count);
      return this.stamp(Object.freeze(out), l.as_of);
    });
  }

  /** Runs a synchronous read as a Promise (a throw becomes a rejection, never a sync throw). */
  private run<T>(fn: () => T): Promise<T> {
    try {
      return Promise.resolve(fn());
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error("manual league: read failed"));
    }
  }
}
