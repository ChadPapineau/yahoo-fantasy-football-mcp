// players.ts — the players & market tools (plan 07 §3.C): C1 ff_search_players (a name → a
// player_key with crosswalk status — the only name→id path, plan 02 §6.4) and C2 ff_list_players (a
// pool page; a C10 list tool: no outputSchema). Under the manual league the pool is what league.yaml
// lists plus the nflverse K/DEF universe with availability unknown (plan 01 §8 X1).
import { z } from "zod/v4";
import { crosswalkStatus } from "../../domain/crosswalk/matcher.js";
import { opponentOf, teamGame } from "../../domain/league/schedule.js";
import {
  POSITION_RE,
  SLOT_NAME_RE,
  STATUS_CODE_RE,
  TEAM_ABBR_RE,
  codeOrNull,
  type PlatformPlayer,
} from "../../domain/league/types.js";
import { MANUAL_FEATURE_WARNINGS } from "../../providers/platform.js";
import {
  BOUNDS,
  detailShape,
  leagueShape,
  pageInputShape,
  platformFreshnessShape,
  searchQuerySchema,
  statIdSchema,
  weekSchema,
} from "../bounds.js";
import { defineTool, type ToolContext } from "../define.js";
import {
  TRUNCATION_HINTS,
  bareUntrusted,
  wrapUntrustedOrNull,
  type InputStamp,
} from "../envelope.js";
import { FfError } from "../errors.js";
import {
  bare,
  crosswalkRun,
  leagueContext,
  leaguePositions,
  nflTeamOf,
  optionalDataset,
  readOpts,
  rosterRows,
  slotsOf,
  take,
  textSource,
  weekGames,
  type LeagueContext,
  type ResolvedEntry,
} from "./common.js";
import { capabilitiesOf } from "./league.js";
import {
  bareName,
  gsisId,
  ownership,
  playerKey,
  position,
  slotName,
  statusCode,
  teamAbbr,
  week,
} from "./schemas.js";

const positionArg = z.string().regex(SLOT_NAME_RE);

function ownershipOf(p: PlatformPlayer, ownerSource: string) {
  const o = p.ownership;
  return o === null
    ? { type: "unknown" as const, owner_team_key: null, owner_name: null, waiver_date: null }
    : {
        type: o.type,
        owner_team_key: o.owner_team_key,
        owner_name: wrapUntrustedOrNull(o.owner_name, "team_name", ownerSource),
        waiver_date: o.waiver_date !== null && o.waiver_date.length <= 40 ? o.waiver_date : null,
      };
}

/** The fields C1 and C2 share. */
function baseRow(p: PlatformPlayer, r: ResolvedEntry | undefined, ownerSource: string) {
  return {
    player_key: p.ref.id,
    gsis_id: r?.gsis_id ?? null,
    name: bareUntrusted(p.name, "player_name"),
    position: codeOrNull(p.position, POSITION_RE),
    eligible: p.eligible_positions.filter((x) => SLOT_NAME_RE.test(x)),
    team_abbr: codeOrNull(p.team_abbr, TEAM_ABBR_RE),
    status: codeOrNull(p.status, STATUS_CODE_RE),
    ownership: ownershipOf(p, ownerSource),
    percent_owned: p.percent_owned,
    percent_owned_delta: p.percent_owned_delta,
    bye_week: p.bye_week,
  };
}

/** The provenance tag of a dataset-universe player's name (roster_weekly `full_name`). */
const DATASET_NAME_SOURCE = "nflverse.roster_weekly.name";

/**
 * Where a served player's name came from (QA-1-075). Under the manual league the status-A/FA
 * universe adds the nflverse kicker universe, whose names are roster_weekly text, not the
 * operator's file: the provider marks those `name_source: "dataset"`. Every other name (the file's
 * players, the 32 defences) is the platform's own.
 */
function nameSourceOf(p: PlatformPlayer, platform: LeagueContext["ref"]["platform"]): string {
  // the provider says where each name came from (QA-1-075); never inferred from ownership
  return p.name_source === "dataset" ? DATASET_NAME_SOURCE : textSource(platform, "player.name");
}

/**
 * The name path-listings of a page (one per distinct source) and, when a dataset name is served,
 * the roster_weekly input so meta.source and attribution name nflverse (plan 01 §4.2).
 */
function nameProvenance(
  ctx: ToolContext,
  lc: LeagueContext,
  items: readonly PlatformPlayer[],
  inputs: InputStamp[],
): ReturnType<typeof bare>[] {
  const sources = [...new Set(items.map((p) => nameSourceOf(p, lc.ref.platform)))];
  if (sources.includes(DATASET_NAME_SOURCE)) {
    const rIn = optionalDataset(rosterRows(ctx, lc.league.season), ctx.nowMs, lc.allowStale);
    if (rIn !== null) inputs.push(rIn);
  }
  return (sources.length === 0 ? [textSource(lc.ref.platform, "player.name")] : sources).map((s) =>
    bare("data.players[].name", s),
  );
}

async function checkPosition(
  ctx: ToolContext,
  lc: LeagueContext,
  pos: string | undefined,
  inputs: InputStamp[],
): Promise<void> {
  if (pos === undefined) return;
  const slots = await slotsOf(ctx, lc, inputs);
  if (!leaguePositions(slots).has(pos))
    throw new FfError("VALIDATION", { field: "position", reason: "not_in_league" });
}

// --- C1 ff_search_players -----------------------------------------------------------------------------

const c1Data = z.strictObject({
  players: z
    .array(
      z.strictObject({
        player_key: playerKey,
        gsis_id: gsisId.nullable(),
        name: bareName,
        position: position.nullable(),
        eligible: z.array(slotName).max(20),
        team_abbr: teamAbbr.nullable(),
        uniform_number: z.number().int().nullable(),
        status: statusCode.nullable(),
        ownership,
        percent_owned: z.number().nullable(),
        percent_owned_delta: z.number().nullable(),
        bye_week: week.nullable(),
        crosswalk: z.strictObject({
          method: z.enum(["id", "match", "override", "none"]),
          confidence: z.number().min(0).max(1),
        }),
        has_recent_notes: z.boolean(),
        notes_last_ts: z.string().max(40).nullable(),
      }),
    )
    .max(BOUNDS.searchLimit.max),
});

export const searchPlayers = defineTool({
  name: "ff_search_players",
  family: "platform",
  description:
    "Resolve a player name to a player_key (never guess keys), with ownership and crosswalk method/confidence.",
  input: z.strictObject({
    ...leagueShape,
    query: searchQuerySchema,
    position: positionArg.optional(),
    limit: z
      .number()
      .int()
      .min(BOUNDS.searchLimit.min)
      .max(BOUNDS.searchLimit.max)
      .default(BOUNDS.searchLimit.default),
    ...platformFreshnessShape,
  }),
  data: c1Data,
  budget: "list",
  hint: TRUNCATION_HINTS.limit,
  run: async (args, ctx) => {
    const lc = await leagueContext(ctx, args);
    const inputs: InputStamp[] = [lc.input];
    await checkPosition(ctx, lc, args.position, inputs);
    const got = take(
      ctx,
      await ctx.services.platform.listPlayers(
        lc.ref,
        {
          status: "A",
          position: args.position ?? null,
          search: args.query,
          sort: null,
          sort_type: null,
          sort_week: null,
        },
        { limit: args.limit, offset: 0 },
        readOpts(args),
      ),
      inputs,
      lc.allowStale,
    );
    const { byKey } = crosswalkRun(ctx, lc.league.season, got.items);
    const ownerSrc = textSource(lc.ref.platform, "team.name");
    const players = got.items.map((p) => {
      const r = byKey.get(p.ref.id);
      return {
        ...baseRow(p, r, ownerSrc),
        uniform_number: p.uniform_number,
        crosswalk:
          r === undefined
            ? { method: "none" as const, confidence: 0 }
            : crosswalkStatus(r.resolution),
        has_recent_notes: false,
        notes_last_ts: null,
      };
    });
    return {
      data: { players },
      inputs,
      bareFields: nameProvenance(ctx, lc, got.items, inputs),
      listKey: "players",
    };
  },
});

// --- C2 ff_list_players (C10: no outputSchema) ---------------------------------------------------------------

export const listPlayers = defineTool({
  name: "ff_list_players",
  family: "platform",
  description:
    "Browse a player pool page (status, position, sort) with ownership and next opponent. Shape: ff://docs/tool-outputs.",
  input: z
    .strictObject({
      ...leagueShape,
      status: z.enum(["A", "FA", "W", "T", "K"]).default("A"),
      position: positionArg.optional(),
      sort: z.union([z.enum(["OR", "AR", "PTS", "NAME"]), statIdSchema]).default("OR"),
      sort_type: z.enum(["season", "week"]).optional(),
      sort_week: weekSchema.optional(),
      with_stats: z
        .strictObject({ type: z.enum(["week", "season"]), week: weekSchema.optional() })
        .optional(),
      ...pageInputShape,
      ...detailShape,
      ...platformFreshnessShape,
    })
    .refine((v) => v.sort_week === undefined || v.sort_type === "week", {
      message: "sort_week_needs_week_type",
      path: ["sort_week"],
    }),
  data: null,
  budget: "list",
  pageable: true,
  run: async (args, ctx) => {
    const lc = await leagueContext(ctx, args);
    const inputs: InputStamp[] = [lc.input];
    const warnings: string[] = [];
    await checkPosition(ctx, lc, args.position, inputs);
    if (args.with_stats !== undefined) {
      const caps = await capabilitiesOf(ctx);
      if (!caps.read_features.player_stats) warnings.push(MANUAL_FEATURE_WARNINGS.player_stats);
    }
    const got = take(
      ctx,
      await ctx.services.platform.listPlayers(
        lc.ref,
        {
          status: args.status,
          position: args.position ?? null,
          search: null,
          sort: args.sort,
          sort_type: args.sort_type ?? null,
          sort_week: args.sort_week ?? null,
        },
        { limit: args.limit, offset: args.offset },
        readOpts(args),
      ),
      inputs,
      lc.allowStale,
    );
    const season = lc.league.season;
    const games = weekGames(ctx, season, lc.league.current_week);
    const gIn = optionalDataset(games, ctx.nowMs, lc.allowStale);
    if (gIn !== null) inputs.push(gIn);
    const { byKey } = crosswalkRun(ctx, season, got.items);
    const ownerSrc = textSource(lc.ref.platform, "team.name");
    const full = args.detail === "full";
    const players = got.items.map((p) => {
      const t = nflTeamOf(p);
      const g = t === null ? null : teamGame(t, games.rows);
      return {
        ...baseRow(p, byKey.get(p.ref.id), ownerSrc),
        ...(full
          ? {
              status_full: wrapUntrustedOrNull(
                p.status_full,
                "status_full",
                textSource(lc.ref.platform, "player.status_full"),
              ),
              injury_note: wrapUntrustedOrNull(
                p.injury_note,
                "injury_note",
                textSource(lc.ref.platform, "player.injury_note"),
              ),
            }
          : {}),
        competition_signal: true,
        waiver_date: p.ownership?.waiver_date ?? null,
        season_points: null,
        week_points: null,
        next_opponent: g === null || t === null ? null : opponentOf(t, g),
        next_kickoff: g?.kickoff ?? null,
      };
    });
    const page = got;
    return {
      data: { players },
      inputs,
      warnings,
      bareFields: nameProvenance(ctx, lc, got.items, inputs),
      page: {
        limit: args.limit,
        offset: args.offset,
        count: page.count,
        has_more: page.has_more,
        next_offset: page.next_offset,
      },
      listKey: "players",
    };
  },
});
