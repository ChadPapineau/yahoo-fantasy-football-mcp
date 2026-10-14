// ops.ts — the ops tools (plan 07 §3.G): G1 ff_get_status (the plan 01 §7 snapshot: server,
// auth, capabilities, league, sources and their freshness, crosswalk counts — plan 10 A5a — store,
// journal, and the offline doctor rows) and G3 ff_debug_echo (fixture mode only: a nonce ONLY in
// structuredContent — the plan 10 A17 spike). Also the freshness report behind ff://status/freshness.
import { randomBytes } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import {
  FRESHNESS_TABLE,
  SOURCE_REGISTRY,
  freshnessClass,
  stampState,
  isDatasetSourceId,
  type DatasetSourceId,
} from "../../config/freshness.js";
import { SCHEDULE_CHANGE_KINDS } from "../../domain/analytics/types.js";
import type { CrosswalkDiagnostic } from "../../domain/crosswalk/matcher.js";
import type { ScheduleView } from "../../domain/league/calendar.js";
import { datasetCoverage } from "../../domain/league/coverage.js";
import {
  scheduleBlock,
  seasonBlock,
  type ScheduleBlock,
  type SeasonBlock,
} from "../../domain/league/status-blocks.js";
import type { UnmatchedPlayer } from "../../domain/crosswalk/types.js";
import {
  LEAGUE_FILE_INVALID_HINT,
  LeagueFileError,
  MANUAL_AUTH_STATUS,
  MANUAL_LEAGUE_MISSING_HINT,
  type PlatformCapabilities,
} from "../../providers/platform.js";
import { defineTool, type ToolContext } from "../define.js";
import { UNTRUSTED_POINTER, bareUntrusted, buildEnvelope, type InputStamp } from "../envelope.js";
import { FfError, describeForLog, wrapHandler } from "../errors.js";
import { basisOf, nextTickAt, providerOf, tickDecisionOf } from "../refresh.js";
import type { McpServerOptions, McpServices } from "../services.js";
import { bare, leagueContext, leagueUniverse, textSource, type LeagueContext } from "./common.js";
import { advertisedInputSchema, advertisedOutputSchema, FAMILY_ANNOTATIONS } from "../define.js";
import { bareName, gsisId, iso, playerKey, week } from "./schemas.js";

/** The tool contract version the Skills stamp and check (plan 09 §4 K5; skills/_shared/manifest.json). */
export const TOOL_CONTRACT = 1;
/** The MCP SDK version this build pins (package.json; a test pins the equality). */
export const SDK_VERSION = "2.3.1";
/** The protocol eras `serveStdio` answers (plan 01 §3.1: dual era). */
export const PROTOCOL_ERAS = ["2026-07-28", "legacy"] as const;

/** refresh_log `error` codes (the store's fixed-vocabulary grammar); anything else reads `internal`. */
export const REFRESH_ERROR_CODE = /^[a-z][a-z0-9_:.-]{0,63}$/;

/** The Phase-1a dataset sources G1 reports (the weather source per FF_WEATHER_SOURCE). */
export function statusSources(options: McpServerOptions): DatasetSourceId[] {
  const base: DatasetSourceId[] = [
    "nflverse:schedules",
    "nflverse:injuries",
    "nflverse:roster_weekly",
    "nflverse:stats_player_week",
  ];
  if (options.weatherSource === "open-meteo") base.push("weather:open_meteo");
  if (options.weatherSource === "nws") base.push("weather:nws");
  return base;
}

const sourceRow = z.strictObject({
  id: z.string().regex(/^[a-z_]+:[a-z_]+$/),
  license: z.string().max(32).nullable(),
  last_success_at: iso.nullable(),
  age_s: z.number().int().min(0).nullable(),
  /**
   * `unreadable`: the refresh log lists a current file the server cannot serve — missing, damaged,
   * or another source's/version's/layout's (QA-1-038; the tools answer STALE_ONLY "missing or
   * unreadable" for it, and `ff refresh <source>` repairs it). `not_published`: the season in
   * progress is not published upstream yet (a recent season check; season-fresh §3.3) — upstream's
   * state, not an outage.
   */
  freshness: z.enum(["fresh", "stale", "expired", "never_loaded", "unreadable", "not_published"]),
  rows: z.number().int().min(0).nullable(),
  last_error: z
    .string()
    .regex(/^[a-z_]{1,40}$/)
    .nullable(),
  consecutive_failures: z.number().int().min(0),
  /** When the scheduled tick next checks this source (a UTC quarter-hour), null when it will not. */
  next_check_at: iso.nullable(),
  /** The provider's 429 / Retry-After pause, while one is active. */
  backoff_until: iso.nullable(),
});
export type SourceRow = z.infer<typeof sourceRow>;

/**
 * One row per Phase-1a dataset source (plan 01 §7; plan 07 G1 `sources[]`). A source whose current
 * file is not what the server has attached — the refresh log's version — reads `unreadable`, never
 * its age's state (QA-1-038): every call re-attaches the current files first (`beforeCall`), and
 * the attach refuses a missing, damaged or foreign file, so "not attached at that version" is
 * "cannot be served". This holds while every current source fits the attach slots (MAX_ATTACHED −
 * RESERVED_ATTACH_SLOTS = 9; Phase 1a has at most six sources).
 */
export function sourceRows(ctx: StatusCtx): SourceRow[] {
  const current = new Map(ctx.services.refreshLog.current().map((r) => [r.source, r]));
  const attached = new Map(
    ctx.services.storeStats().attached.map((a) => [a.source, a.file_version]),
  );
  return statusSources(ctx.options).map((id) => {
    const ok = current.get(id);
    const latest = ctx.services.refreshLog.latest(id);
    const failures = ctx.services.refreshLog.consecutiveFailures(id);
    const info = SOURCE_REGISTRY[id];
    const decision = tickDecisionOf(
      ctx.services,
      id,
      ctx.view,
      ctx.nowMs,
      ctx.options.weatherHorizonHours ?? DEFAULT_WEATHER_HORIZON_HOURS,
    );
    const at = decision === null ? null : decision.due ? ctx.nowMs : decision.next_at_ms;
    const backoff = ctx.services.providerBackoff.get(providerOf(id));
    const backoffMs = backoff === null ? Number.NaN : Date.parse(backoff.until_at);
    const timing = {
      next_check_at: at === null ? null : new Date(nextTickAt(at)).toISOString(),
      backoff_until:
        Number.isFinite(backoffMs) && backoffMs > ctx.nowMs
          ? new Date(backoffMs).toISOString()
          : null,
    };
    // the season in progress not published upstream yet reads as such, never as an outage (§3.3)
    const unpublished =
      !id.startsWith("weather:") &&
      datasetCoverage({
        stamp:
          ok?.file_version == null
            ? null
            : {
                source: id,
                as_of: ok.release_updated_at ?? ok.finished_at,
                fetched_at: ok.finished_at,
                checked_at: ok.checked_at,
                freshness_class: info.freshness,
                file_version: ok.file_version,
                seasons: ok.seasons,
              },
        season: ctx.view.phase.season,
        phase: ctx.view.phase,
        check: ctx.services.seasonChecks.latest(id, ctx.view.phase.season),
        hardLimitSeconds: freshnessClass(info.freshness).hardLimitSeconds,
        nowMs: ctx.nowMs,
      }).state === "not_published";
    const lastError =
      latest !== null &&
      !latest.ok &&
      latest.error !== null &&
      REFRESH_ERROR_CODE.test(latest.error)
        ? latest.error
        : latest !== null && !latest.ok
          ? "internal"
          : null;
    if (ok === undefined)
      return {
        id,
        license: info.attribution.license,
        last_success_at: null,
        age_s: null,
        freshness: unpublished ? ("not_published" as const) : ("never_loaded" as const),
        rows: null,
        last_error: lastError,
        consecutive_failures: failures,
        ...timing,
      };
    const st = stampState(
      freshnessClass(info.freshness),
      basisOf(ok),
      ctx.nowMs,
      ctx.view.calendar,
    );
    const servable = ok.file_version !== null && attached.get(id) === ok.file_version;
    return {
      id,
      license: info.attribution.license,
      last_success_at: new Date(Date.parse(ok.finished_at)).toISOString(),
      age_s: st.age_s,
      freshness: !servable
        ? ("unreadable" as const)
        : unpublished
          ? ("not_published" as const)
          : st.state,
      rows: ok.rows,
      last_error: lastError,
      consecutive_failures: failures,
      ...timing,
    };
  });
}

/** What the status surfaces read: the services, the options, the instant and its schedule view. */
export interface StatusCtx {
  readonly services: McpServices;
  readonly options: McpServerOptions;
  readonly nowMs: number;
  readonly view: ScheduleView;
}

/** The forecast horizon assumed when the options do not carry the provider's (Open-Meteo's 7 days). */
export const DEFAULT_WEATHER_HORIZON_HOURS = 7 * 24;

/** How far back G1 (and `ff status`) list kickoff changes: the notification horizon (§5.1). */
export const STATUS_CHANGES_WINDOW_MS = 14 * 86_400_000;
/** The most change rows the status surfaces read. */
export const STATUS_CHANGES_MAX_ROWS = 200;

/**
 * The `season` and `schedule` blocks G1 and `ff status` print (season-fresh §4.5, §5.2): built by
 * the B1 builders over the same ports, so the two surfaces agree by construction (src/cli may call
 * this; tests/mcp/status-blocks-parity.test.ts holds it).
 */
export function statusBlocks(i: {
  readonly view: ScheduleView;
  readonly leagueSeason: number | null;
  readonly seasonChecks: Pick<McpServices["seasonChecks"], "all">;
  readonly scheduleChanges: Pick<McpServices["scheduleChanges"], "recent">;
  readonly nowMs: number;
}): { readonly season: SeasonBlock; readonly schedule: ScheduleBlock } {
  const since = new Date(i.nowMs - STATUS_CHANGES_WINDOW_MS).toISOString();
  return {
    season: seasonBlock(i.view, i.leagueSeason, i.seasonChecks.all(), i.nowMs),
    schedule: scheduleBlock(
      i.view,
      i.scheduleChanges.recent(since, STATUS_CHANGES_MAX_ROWS),
      i.nowMs,
    ),
  };
}

/** The NFL players an unmatched entry might be (QA-1-048): enough to pick the right gsis_id. */
const candidateRow = z.strictObject({
  gsis_id: gsisId,
  nfl_team: z
    .string()
    .regex(/^[A-Z]{2,3}$/)
    .nullable(),
  position: z
    .string()
    .regex(/^[A-Z]{1,4}$/)
    .nullable(),
  name: bareName,
});
/** The number of candidate summaries each unmatched row carries. */
export const UNMATCHED_CANDIDATES_SHOWN = 3;

const unmatchedRow = z.strictObject({
  player_key: playerKey,
  name: bareName,
  reason: z.enum(["no_candidate", "name_only", "unknown_team", "ambiguous"]),
  candidates: z.number().int().min(0),
  candidate_players: z.array(candidateRow).max(UNMATCHED_CANDIDATES_SHOWN),
});

/** The crosswalk diagnostics a human must act on (QA-1-042): codes and ids only, no third-party text. */
export const SURFACED_DIAGNOSTICS = [
  "hint_conflict",
  "hint_name_mismatch",
  "hint_not_in_roster",
  "duplicate_gsis",
] as const;
const diagnosticRow = z.strictObject({
  code: z.enum(SURFACED_DIAGNOSTICS),
  platform_player_id: playerKey.nullable(),
  gsis_ids: z.array(gsisId).max(10),
});

/** A schedule-change value: an ISO kickoff, an Eastern date, a venue id or a week number (§5.1). */
const changeValue = z
  .string()
  .regex(/^[A-Za-z0-9:._+-]{1,40}$/)
  .nullable();
const seasonPhaseName = z.enum(["preseason", "regular", "postseason", "offseason"]);
const tentativeWeekRow = z.strictObject({
  season: z.number().int(),
  week,
  reason: z.enum(["placeholder_week", "flex_window", "tbd_time"]),
  until: iso.nullable(),
});

/** G1 `season` (status-blocks.ts SeasonBlock). */
const seasonBlockSchema = z.strictObject({
  nfl_season: z.number().int(),
  phase: seasonPhaseName,
  basis: z.enum(["schedule", "bootstrap"]),
  week: week.nullable(),
  next_kickoff: iso.nullable(),
  league_season: z.number().int().nullable(),
  league_matches: z.boolean().nullable(),
  not_published: z
    .array(
      z.strictObject({
        source: z.string().regex(/^[a-z_]+:[a-z_]+$/),
        season: z.number().int(),
        checked_at: iso,
      }),
    )
    .max(10),
  reference_past_vintage: z
    .array(
      z.strictObject({
        id: z.enum(["venues", "flex_rules", "analytics_base_rates"]),
        verified_through_season: z.number().int(),
      }),
    )
    .max(10),
  week_bound_exceeded: z.boolean(),
});

/** G1 `schedule` (status-blocks.ts ScheduleBlock + the tick's next schedules check). */
const scheduleBlockSchema = z.strictObject({
  calendar: z.enum(["schedule", "fallback"]),
  fallback_reason: z.enum(["never_loaded", "unreadable", "expired", "no_kickoffs"]).nullable(),
  in_window: z.boolean(),
  next_kickoff: iso.nullable(),
  recent_changes: z
    .array(
      z.strictObject({
        game: z.string().regex(/^[A-Z]{2,3}@[A-Z]{2,3}$/),
        season: z.number().int(),
        week,
        kind: z.enum(SCHEDULE_CHANGE_KINDS),
        old: changeValue,
        new: changeValue,
        detected_at: iso,
      }),
    )
    .max(10),
  recent_changes_more: z.number().int().min(0),
  tentative_weeks: z.array(tentativeWeekRow).max(3),
  next_check_at: iso.nullable(),
});

const g1Data = z.strictObject({
  server: z.strictObject({
    name: z.literal("fantasy-football-mcp-server"),
    version: z.string().max(32),
    sdk_version: z.string().max(32),
    protocol_eras: z.array(z.string().max(16)).max(4),
    node: z.string().max(32),
    tool_contract: z.number().int(),
    toolset: z.enum(["core", "full"]),
    fixture_mode: z.boolean(),
  }),
  auth: z.strictObject({
    state: z.enum(["NoTokens", "Valid", "Expired", "NotProvisioned"]),
    provisioning: z.enum(["unknown", "provisioned_read", "provisioned_write", "not_provisioned"]),
    access_expires_at: iso.nullable(),
    last_refresh_at: iso.nullable(),
  }),
  capabilities: z.strictObject({
    platform: z.enum(["yahoo", "manual", "sleeper", "espn"]),
    read: z.literal(true),
    write: z.strictObject({
      lineup: z.boolean(),
      add_drop: z.boolean(),
      waiver: z.boolean(),
      trade: z.boolean(),
    }),
    read_features: z.strictObject({
      player_stats: z.boolean(),
      transactions: z.boolean(),
      free_agent_pool: z.boolean(),
      other_rosters: z.boolean(),
      matchups: z.boolean(),
      standings: z.boolean(),
    }),
  }),
  league: z
    .strictObject({ league_key: z.string().max(64), current_week: week, edit_key: week.nullable() })
    .nullable(),
  limiter: z.strictObject({ bucket_level: z.null(), last_999_at: z.null() }),
  /** Where the NFL season is and whether the league file keeps up (season-fresh §4.5). */
  season: seasonBlockSchema,
  /** The game calendar, recent kickoff changes and tentative weeks (season-fresh §5.2). */
  schedule: scheduleBlockSchema,
  sources: z.array(sourceRow).max(20),
  crosswalk: z
    .strictObject({
      matched: z.number().int().min(0),
      unmatched_rostered: z.array(unmatchedRow).max(60),
      unmatched_top_owned: z.array(unmatchedRow).max(60),
      diagnostics: z.array(diagnosticRow).max(60),
    })
    .nullable(),
  store: z.strictObject({
    path: z.literal("<cache>/store.sqlite"),
    size_bytes: z.number().int().min(0),
    schema_version: z.number().int().min(0),
    attached: z.number().int().min(0),
    cache_misses_busy: z.number().int().min(0),
  }),
  journal: z.strictObject({
    prepared: z.number().int().min(0),
    sent_unknown: z.number().int().min(0),
    oldest_pending_age_s: z.number().int().min(0).nullable(),
  }),
  jobs: z
    .array(
      z.strictObject({
        label: z.string().max(64),
        last_run_at: iso.nullable(),
        exit: z.number().int().nullable(),
      }),
    )
    .max(20),
  checks: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[a-z_]{1,40}$/),
        ok: z.boolean(),
        detail: z.string().regex(/^[a-z_]{1,40}$/),
      }),
    )
    .max(20)
    .nullable(),
});
export type StatusData = z.infer<typeof g1Data>;
type StatusCheck = NonNullable<StatusData["checks"]>[number];

function unmatched(list: readonly UnmatchedPlayer[]): z.infer<typeof unmatchedRow>[] {
  const code = (v: string, re: RegExp): string | null => (re.test(v) ? v : null);
  return list.slice(0, 60).map((u) => ({
    player_key: u.player.ref.id,
    name: bareUntrusted(u.player.name, "player_name"),
    reason: u.reason,
    candidates: u.candidates.length,
    candidate_players: u.candidates
      .filter((c) => gsisId.safeParse(c.gsis_id).success)
      .slice(0, UNMATCHED_CANDIDATES_SHOWN)
      .map((c) => ({
        gsis_id: c.gsis_id,
        nfl_team: code(c.team, /^[A-Z]{2,3}$/),
        position: code(c.position, /^[A-Z]{1,4}$/),
        name: bareUntrusted(c.full_name, "player_name"),
      })),
  }));
}

/** The run's diagnostics a human must act on, value-free (QA-1-042). */
function surfacedDiagnostics(
  list: readonly CrosswalkDiagnostic[],
): z.infer<typeof diagnosticRow>[] {
  const wanted: ReadonlySet<string> = new Set(SURFACED_DIAGNOSTICS);
  return list
    .filter((d) => wanted.has(d.code))
    .slice(0, 60)
    .map((d) => ({
      code: d.code as (typeof SURFACED_DIAGNOSTICS)[number],
      platform_player_id:
        d.platform_player_id !== null && playerKey.safeParse(d.platform_player_id).success
          ? d.platform_player_id
          : null,
      gsis_ids: d.gsis_ids.filter((g) => gsisId.safeParse(g).success).slice(0, 10),
    }));
}

/** A source id as a check `detail` (`nflverse:schedules` → `nflverse_schedules`). */
function checkDetail(id: string): string {
  return id.replace(/[^a-z_]/g, "_").slice(0, 40);
}

/** Whether a source's class is required (STALE_ONLY past its hard limit) rather than an omittable driver. */
function isRequiredSource(id: string): boolean {
  return (
    !isDatasetSourceId(id) || freshnessClass(SOURCE_REGISTRY[id].freshness).beyondHard !== "omit"
  );
}

/**
 * The dataset rows of G1 checks[] (QA-1-015): `datasets_loaded` / `datasets_fresh` judge only the
 * REQUIRED sources (STALE_ONLY classes — what the tools refuse without), `optional_drivers` the
 * omittable ones (weather: plan 01 §5.4 "omitted driver, not an error"); each failing check names
 * its first failing source in `detail`.
 */
function datasetChecks(sources: readonly SourceRow[]): StatusCheck[] {
  const required = sources.filter((x) => isRequiredSource(x.id));
  const optional = sources.filter((x) => !isRequiredSource(x.id));
  const row = (id: string, rows: readonly SourceRow[], good: (x: SourceRow) => boolean) => {
    const bad = rows.find((x) => !good(x));
    return { id, ok: bad === undefined, detail: bad === undefined ? "ok" : checkDetail(bad.id) };
  };
  return [
    // a file the server cannot serve is not loaded (QA-1-038)
    row(
      "datasets_loaded",
      required,
      (x) => x.freshness !== "never_loaded" && x.freshness !== "unreadable",
    ),
    // a season upstream has not published yet is nothing to refresh (season-fresh §3.3, §4.5)
    row(
      "datasets_fresh",
      required,
      (x) => x.freshness === "fresh" || x.freshness === "not_published",
    ),
    row(
      "optional_drivers",
      optional,
      (x) => x.freshness === "fresh" || x.freshness === "not_published",
    ),
  ];
}

/** The tick's job name (src/cli/launchd.ts JOBS) whose heartbeat G1 checks. */
export const REFRESH_TICK_JOB = "refresh-due";
/** A tick heartbeat older than this is missing (doctor row 11's rule). */
export const TICK_HEARTBEAT_MAX_AGE_MS = 3_600_000;

/** G1's season and schedule checks (season-fresh §4.5, §5.2, §6). */
function seasonStatusChecks(
  ctx: StatusCtx,
  season: SeasonBlock,
  schedule: ScheduleBlock,
  jobs: StatusData["jobs"],
): StatusCheck[] {
  const tick = jobs.find((j) => j.label === REFRESH_TICK_JOB);
  const tickAt = tick?.last_run_at == null ? Number.NaN : Date.parse(tick.last_run_at);
  const tickDetail =
    tick === undefined || !Number.isFinite(tickAt)
      ? "no_heartbeat"
      : ctx.nowMs - tickAt > TICK_HEARTBEAT_MAX_AGE_MS
        ? "stale_heartbeat"
        : tick.exit !== 0
          ? "last_run_failed"
          : "ok";
  const vintage = season.reference_past_vintage[0];
  return [
    {
      id: "schedule_calendar",
      ok: schedule.calendar === "schedule",
      detail: schedule.fallback_reason ?? "schedule",
    },
    {
      id: "kickoff_changes",
      ok: schedule.recent_changes.length === 0,
      detail: schedule.recent_changes.length === 0 ? "none" : "recent_changes",
    },
    {
      id: "season_match",
      ok: season.league_matches !== false,
      detail:
        season.league_matches === null
          ? "no_league"
          : season.league_matches
            ? "ok"
            : "league_season_differs",
    },
    {
      id: "reference_vintage",
      ok: vintage === undefined,
      detail: vintage === undefined ? "ok" : vintage.id,
    },
    {
      id: "schedule_week_bound",
      ok: !season.week_bound_exceeded,
      detail: season.week_bound_exceeded ? "week_bound_exceeded" : "ok",
    },
    { id: "refresh_tick", ok: tickDetail === "ok", detail: tickDetail },
    { id: "on_demand", ok: true, detail: ctx.options.onDemand },
  ];
}

/** The G1 snapshot (also `ff://status`). A missing/invalid league file is a warning, not an error. */
export async function statusSnapshot(
  ctx: ToolContext,
  includeChecks: boolean,
): Promise<{
  data: StatusData;
  inputs: InputStamp[];
  warnings: string[];
  nameSource: string | null;
}> {
  const warnings: string[] = [];
  const inputs: InputStamp[] = [];
  const s = ctx.services;
  let caps: PlatformCapabilities = await s.platform.capabilities();
  let lc: LeagueContext | null = null;
  let leagueCheck: "ok" | "missing" | "invalid" = "ok";
  try {
    lc = await leagueContext(ctx, {});
    inputs.push(lc.input);
  } catch (e) {
    if (e instanceof LeagueFileError) {
      leagueCheck = e.kind;
      warnings.push(e.kind === "missing" ? MANUAL_LEAGUE_MISSING_HINT : LEAGUE_FILE_INVALID_HINT);
    } else if (e instanceof FfError && e.code === "NOT_FOUND") {
      leagueCheck = "missing";
    } else {
      throw e;
    }
  }
  if (lc !== null) caps = await s.platform.capabilities();
  let crosswalk: StatusData["crosswalk"] = null;
  let nameSource: string | null = null;
  if (lc !== null) {
    const u = await leagueUniverse(ctx, lc, inputs);
    nameSource = textSource(lc.ref.platform, "player.name");
    crosswalk = {
      matched: u.run.report.matched,
      unmatched_rostered: unmatched(u.run.report.unmatched_rostered),
      unmatched_top_owned: unmatched(u.run.report.unmatched_top_owned),
      diagnostics: surfacedDiagnostics(u.run.diagnostics),
    };
  }
  if (ctx.options.writeRequested)
    warnings.push("FF_WRITE_ENABLED=1 is ignored: this build has no write-capable provider");
  const stats = s.storeStats();
  const journal = s.writeJournal.countByStatus();
  const pending = s.writeJournal.oldestPendingAgeSeconds(new Date(ctx.nowMs).toISOString());
  const sources = sourceRows(ctx);
  const blocks = statusBlocks({
    view: ctx.view,
    leagueSeason: lc === null ? null : lc.league.season,
    seasonChecks: s.seasonChecks,
    scheduleChanges: s.scheduleChanges,
    nowMs: ctx.nowMs,
  });
  const scheduleRow = sources.find((x) => x.id === "nflverse:schedules");
  const schedule = { ...blocks.schedule, next_check_at: scheduleRow?.next_check_at ?? null };
  const jobs: StatusData["jobs"] = s.jobRuns
    .list()
    .slice(0, 20)
    .map((j) => ({
      label: j.job,
      last_run_at: Number.isFinite(Date.parse(j.last_run_at))
        ? new Date(Date.parse(j.last_run_at)).toISOString()
        : null,
      exit: j.exit,
    }));
  const rf = caps.read_features;
  const data: StatusData = {
    server: {
      name: "fantasy-football-mcp-server",
      version: ctx.options.version,
      sdk_version: SDK_VERSION,
      protocol_eras: [...PROTOCOL_ERAS],
      node: process.versions.node,
      tool_contract: TOOL_CONTRACT,
      toolset: ctx.options.toolset,
      fixture_mode: ctx.options.fixtureMode,
    },
    auth: { ...MANUAL_AUTH_STATUS },
    capabilities: {
      platform: s.platform.id,
      read: true,
      write: { ...caps.write },
      read_features: {
        player_stats: rf.player_stats,
        transactions: rf.transactions,
        free_agent_pool: rf.free_agent_pool,
        other_rosters: rf.other_rosters,
        matchups: rf.matchups,
        standings: rf.standings ?? rf.matchups,
      },
    },
    league:
      lc === null
        ? null
        : {
            league_key: lc.ref.league_key,
            current_week: lc.league.current_week,
            edit_key: lc.league.edit_key,
          },
    limiter: { bucket_level: null, last_999_at: null },
    season: {
      ...blocks.season,
      not_published: blocks.season.not_published.map((x) => ({ ...x })),
      reference_past_vintage: blocks.season.reference_past_vintage.map((x) => ({ ...x })),
    },
    schedule: {
      ...schedule,
      recent_changes: schedule.recent_changes.map((x) => ({ ...x })),
      tentative_weeks: schedule.tentative_weeks.map((x) => ({ ...x })),
    },
    sources,
    crosswalk,
    store: {
      path: "<cache>/store.sqlite",
      size_bytes: Math.max(0, Math.floor(stats.size_bytes)),
      schema_version: stats.schema_version,
      attached: stats.attached.length,
      cache_misses_busy: stats.cache_misses_busy,
    },
    journal: {
      prepared: journal.prepared ?? 0,
      sent_unknown: journal.sent_unknown ?? 0,
      oldest_pending_age_s: pending === null ? null : Math.max(0, Math.floor(pending)),
    },
    jobs,
    checks: includeChecks
      ? [
          { id: "league_file", ok: leagueCheck === "ok", detail: leagueCheck },
          ...datasetChecks(sources),
          {
            id: "writes",
            ok: true,
            detail: ctx.options.writeRequested ? "requested_ignored" : "off",
          },
          {
            id: "crosswalk",
            ok: crosswalk === null || crosswalk.unmatched_rostered.length === 0,
            detail:
              crosswalk === null
                ? "no_league"
                : crosswalk.unmatched_rostered.length === 0
                  ? "ok"
                  : "unmatched_rostered",
          },
          ...seasonStatusChecks(ctx, blocks.season, schedule, jobs),
        ]
      : null,
  };
  return { data, inputs, warnings, nameSource };
}

export const getStatus = defineTool({
  name: "ff_get_status",
  // diagnostics and the local write never refresh (plan 03 L5; season-fresh §6.2)
  datasets: [],
  family: "ops",
  description:
    "Status: version, tool_contract, capabilities (writes off), league and current week, source freshness, crosswalk, store.",
  input: z.strictObject({ include_checks: z.boolean().default(false) }),
  data: g1Data,
  budget: "list",
  run: async (args, ctx) => {
    const r = await statusSnapshot(ctx, args.include_checks);
    return {
      data: r.data,
      inputs: r.inputs,
      warnings: r.warnings,
      bareFields:
        r.nameSource === null
          ? []
          : [
              bare("data.crosswalk.unmatched_rostered[].name", r.nameSource),
              bare("data.crosswalk.unmatched_top_owned[].name", r.nameSource),
              bare(
                "data.crosswalk.unmatched_rostered[].candidate_players[].name",
                "nflverse.roster_weekly.name",
              ),
              bare(
                "data.crosswalk.unmatched_top_owned[].candidate_players[].name",
                "nflverse.roster_weekly.name",
              ),
            ],
    };
  },
});

// --- the freshness report (ff://status/freshness) -------------------------------------------------------

/** The plan 01 §5.4 class table rows of the Phase-1a classes, with each source's current state. */
export function freshnessReport(ctx: StatusCtx) {
  const sources = sourceRows(ctx);
  const classes = [
    "manual_league",
    "nflverse_schedules",
    "nflverse_injuries",
    "nflverse_roster_weekly",
    "nflverse_stats_player_week",
    "weather",
  ] as const;
  return {
    sources,
    classes: classes.map((id) => {
      const c = FRESHNESS_TABLE[id];
      return {
        id,
        basis: c.basis,
        ttl_s: c.ttlSeconds,
        hard_limit_s: c.hardLimitSeconds,
        beyond_hard: c.beyondHard,
      };
    }),
  };
}

// --- G3 ff_debug_echo (fixture mode only) -----------------------------------------------------------------

/** The G3 text block: the nonce is deliberately absent from it (plan 10 A17). */
export const DEBUG_ECHO_TEXT = "nonce omitted from text";

const g3Data = z.strictObject({ nonce: z.string().regex(/^[0-9a-f]{12}$/) });

/**
 * Registers `ff_debug_echo` (fixture mode only — never in expected-tools.json's production lists):
 * a fresh 12-char nonce ONLY in `structuredContent`; the text block says it was omitted (A17).
 */
export function registerDebugEcho(server: McpServer, services: McpServices): void {
  const input = z.strictObject({});
  server.registerTool(
    "ff_debug_echo",
    {
      description: `Fixture-mode spike: returns a nonce only in structuredContent. ${UNTRUSTED_POINTER}`,
      inputSchema: advertisedInputSchema(input),
      outputSchema: advertisedOutputSchema(g3Data),
      annotations: FAMILY_ANNOTATIONS.ops,
    },
    wrapHandler(
      input,
      (_args, base) => {
        const env = buildEnvelope({
          data: { nonce: randomBytes(6).toString("hex") },
          requestId: base.requestId,
          nowMs: services.clock.nowMs(),
          inputs: [],
        });
        return {
          content: [{ type: "text", text: DEBUG_ECHO_TEXT }],
          structuredContent: JSON.parse(JSON.stringify(env)) as Record<string, unknown>,
        };
      },
      {
        onError: (e, requestId) => {
          services.logger.warn("tool.error", {
            request_id: requestId,
            tool: "ff_debug_echo",
            error: describeForLog(e),
          });
        },
      },
    ),
  );
}
