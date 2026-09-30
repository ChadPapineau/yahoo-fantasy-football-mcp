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
  type DatasetSourceId,
} from "../../config/freshness.js";
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
import type { McpServerOptions, McpServices } from "../services.js";
import { bare, leagueContext, leagueUniverse, textSource, type LeagueContext } from "./common.js";
import { advertisedInputSchema, advertisedOutputSchema, FAMILY_ANNOTATIONS } from "../define.js";
import { bareName, iso, playerKey, week } from "./schemas.js";

/** The tool contract version the Skills stamp and check (plan 09 §4 K5; skills/_shared/manifest.json). */
export const TOOL_CONTRACT = 1;
/** The MCP SDK version this build pins (package.json; a test pins the equality). */
export const SDK_VERSION = "2.2.0";
/** The protocol eras `serveStdio` answers (plan 01 §3.1: dual era). */
export const PROTOCOL_ERAS = ["2026-07-28", "legacy"] as const;

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
  freshness: z.enum(["fresh", "stale", "expired", "never_loaded"]),
  rows: z.number().int().min(0).nullable(),
  last_error: z
    .string()
    .regex(/^[a-z_]{1,40}$/)
    .nullable(),
  consecutive_failures: z.number().int().min(0),
});
export type SourceRow = z.infer<typeof sourceRow>;

/** One row per Phase-1a dataset source (plan 01 §7; plan 07 G1 `sources[]`). */
export function sourceRows(ctx: {
  services: McpServices;
  options: McpServerOptions;
  nowMs: number;
}): SourceRow[] {
  const current = new Map(ctx.services.refreshLog.current().map((r) => [r.source, r]));
  return statusSources(ctx.options).map((id) => {
    const ok = current.get(id);
    const latest = ctx.services.refreshLog.latest(id);
    const failures = ctx.services.refreshLog.consecutiveFailures(id);
    const info = SOURCE_REGISTRY[id];
    const lastError =
      latest !== null && !latest.ok && latest.error !== null && /^[a-z_]{1,40}$/.test(latest.error)
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
        freshness: "never_loaded" as const,
        rows: null,
        last_error: lastError,
        consecutive_failures: failures,
      };
    const st = stampState(
      freshnessClass(info.freshness),
      {
        as_of: ok.release_updated_at ?? ok.finished_at,
        fetched_at: ok.finished_at,
        checked_at: ok.checked_at,
      },
      ctx.nowMs,
    );
    return {
      id,
      license: info.attribution.license,
      last_success_at: new Date(Date.parse(ok.finished_at)).toISOString(),
      age_s: st.age_s,
      freshness: st.state,
      rows: ok.rows,
      last_error: lastError,
      consecutive_failures: failures,
    };
  });
}

const unmatchedRow = z.strictObject({
  player_key: playerKey,
  name: bareName,
  reason: z.enum(["no_candidate", "name_only", "unknown_team", "ambiguous"]),
  candidates: z.number().int().min(0),
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
  sources: z.array(sourceRow).max(20),
  crosswalk: z
    .strictObject({
      matched: z.number().int().min(0),
      unmatched_rostered: z.array(unmatchedRow).max(60),
      unmatched_top_owned: z.array(unmatchedRow).max(60),
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

function unmatched(list: readonly UnmatchedPlayer[]): z.infer<typeof unmatchedRow>[] {
  return list.slice(0, 60).map((u) => ({
    player_key: u.player.ref.id,
    name: bareUntrusted(u.player.name, "player_name"),
    reason: u.reason,
    candidates: u.candidates.length,
  }));
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
    };
  }
  if (ctx.options.writeRequested)
    warnings.push("FF_WRITE_ENABLED=1 is ignored: this build has no write-capable provider");
  const stats = s.storeStats();
  const journal = s.writeJournal.countByStatus();
  const pending = s.writeJournal.oldestPendingAgeSeconds(new Date(ctx.nowMs).toISOString());
  const sources = sourceRows(ctx);
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
    jobs: [],
    checks: includeChecks
      ? [
          { id: "league_file", ok: leagueCheck === "ok", detail: leagueCheck },
          {
            id: "datasets_loaded",
            ok: sources.every((x) => x.freshness !== "never_loaded"),
            detail: sources.every((x) => x.freshness !== "never_loaded") ? "ok" : "never_loaded",
          },
          {
            id: "datasets_fresh",
            ok: sources.every((x) => x.freshness === "fresh"),
            detail: sources.every((x) => x.freshness === "fresh") ? "ok" : "stale_or_missing",
          },
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
        ]
      : null,
  };
  return { data, inputs, warnings, nameSource };
}

export const getStatus = defineTool({
  name: "ff_get_status",
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
            ],
    };
  },
});

// --- the freshness report (ff://status/freshness) -------------------------------------------------------

/** The plan 01 §5.4 class table rows of the Phase-1a classes, with each source's current state. */
export function freshnessReport(ctx: {
  services: McpServices;
  options: McpServerOptions;
  nowMs: number;
}) {
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
