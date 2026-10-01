// league.ts — the league & discovery tools (plan 07 §3.A): A1 ff_list_leagues, A2 ff_get_league
// (the settings digest), A3 ff_get_standings, A4 ff_get_scoreboard, A5 ff_list_transactions (a C10
// list tool: no outputSchema). Platform facts: served from what the FantasyPlatform returns; the
// manual league's missing features carry the fixed MANUAL_FEATURE_WARNINGS (critic C-14).
import { z } from "zod/v4";
import { appliedRounding, floorApplies } from "../../domain/scoring/engine.js";
import { unmappedIds } from "../../domain/scoring/settings.js";
import type { PositionType } from "../../domain/scoring/types.js";
import { PLATFORM_CODE_RE, codeOrNull } from "../../domain/league/types.js";
import {
  MANUAL_FEATURE_WARNINGS,
  type League,
  type PlatformCapabilities,
  type Transaction,
} from "../../providers/platform.js";
import {
  isoInstantSchema,
  leagueShape,
  platformFreshnessShape,
  seasonSchema,
  teamKeySchema,
  txnCountSchema,
  weekSchema,
} from "../bounds.js";
import { defineTool, type ToolContext } from "../define.js";
import {
  TRUNCATION_HINTS,
  bareUntrusted,
  wrapUntrusted,
  wrapUntrustedOrNull,
  type InputStamp,
  type UntrustedField,
} from "../envelope.js";
import {
  bare,
  leagueContext,
  readOpts,
  take,
  textSource,
  weekOf,
  weekProvisional,
} from "./common.js";
import {
  canonical,
  isoDate,
  leagueKey,
  platformCode,
  season,
  slotName,
  teamKey,
  ut,
  utOrNull,
  week,
} from "./schemas.js";

const codeOf = (v: string | null | undefined): string | null => codeOrNull(v, PLATFORM_CODE_RE);
const dateOrNull = (v: string | null): string | null =>
  v !== null && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
const isoOrNull = (v: string | null): string | null => {
  if (v === null) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};
const countOrNull = (v: number | null): number | null =>
  v !== null && Number.isFinite(v) ? v : null;

/** The platform's capabilities (memoised per call). */
export async function capabilitiesOf(ctx: ToolContext): Promise<PlatformCapabilities> {
  const c = ctx.memo.get("caps") as PlatformCapabilities | undefined;
  if (c !== undefined) return c;
  const got = await ctx.services.platform.capabilities();
  ctx.memo.set("caps", got);
  return got;
}

// --- A1 ff_list_leagues ------------------------------------------------------------------------------

const a1Data = z.strictObject({
  leagues: z
    .array(
      z.strictObject({
        league_key: leagueKey,
        name: ut,
        season,
        num_teams: z.number().int().min(0).max(64),
        scoring_type: platformCode.nullable(),
        current_week: week,
        draft_status: platformCode.nullable(),
        is_finished: z.boolean(),
        my_team: z.strictObject({ team_key: teamKey, name: utOrNull }).nullable(),
        in_allow_list: z.boolean(),
      }),
    )
    .max(50),
});

export const listLeagues = defineTool({
  name: "ff_list_leagues",
  family: "platform",
  description:
    "The operator's leagues and my team in each (league_key, team_key, season, current week).",
  input: z.strictObject({
    season: seasonSchema.optional(),
    include_finished: z.boolean().default(false),
    ...platformFreshnessShape,
  }),
  data: a1Data,
  budget: "list",
  run: async (args, ctx) => {
    const opts = readOpts(args);
    const allowStale = args.allow_stale === true;
    const inputs: InputStamp[] = [];
    const refs = take(ctx, await ctx.services.platform.listMyLeagues(opts), inputs, allowStale);
    const src = (f: string): string => textSource(ctx.services.platform.id, f);
    const allowList = ctx.options.leagueKeys;
    const leagues: z.infer<typeof a1Data>["leagues"][number][] = [];
    for (const ref of refs.slice(0, 50)) {
      const l: League = take(
        ctx,
        await ctx.services.platform.getLeague(ref, opts),
        inputs,
        allowStale,
      );
      if (args.season !== undefined && l.season !== args.season) continue;
      if (l.is_finished && !args.include_finished) continue;
      leagues.push({
        league_key: ref.league_key,
        name: wrapUntrusted(l.name, "league_name", src("league.name")),
        season: l.season,
        num_teams: l.num_teams,
        scoring_type: codeOf(l.scoring_type),
        current_week: l.current_week,
        draft_status: codeOf(l.draft_status),
        is_finished: l.is_finished,
        my_team:
          l.my_team === null
            ? null
            : {
                team_key: l.my_team.team_key,
                name: wrapUntrustedOrNull(l.my_team_name, "team_name", src("team.name")),
              },
        in_allow_list: allowList.length === 0 || allowList.includes(ref.league_key),
      });
    }
    return { data: { leagues }, inputs, listKey: "leagues" };
  },
});

// --- A2 ff_get_league ----------------------------------------------------------------------------------

const PT = z.enum(["O", "K", "DT", "D"]);
const INCLUDE = ["league", "scoring", "roster", "rules", "weeks", "stat_map"] as const;
const statId = z.string().max(64);

const a2Data = z.strictObject({
  league: z
    .strictObject({
      league_key: leagueKey,
      name: ut,
      season,
      num_teams: z.number().int().min(0).max(64),
      scoring_type: platformCode.nullable(),
      current_week: week,
      start_week: week,
      end_week: week,
      edit_key: week.nullable(),
      weekly_deadline: platformCode.nullable(),
      league_update_timestamp: z.string().max(40).nullable(),
      is_finished: z.boolean(),
    })
    .optional(),
  scoring: z
    .strictObject({
      uses_fractional_points: z.boolean(),
      uses_negative_points: z.boolean(),
      uses_median_score: z.boolean().nullable(),
      rules: z
        .array(
          z.strictObject({
            stat_id: statId,
            name: ut,
            canonical: canonical.nullable(),
            position_types: z.array(PT).max(4),
            modifier: z.number().nullable(),
            display_only: z.boolean(),
            bonuses: z.array(z.strictObject({ target: z.number(), points: z.number() })).max(20),
          }),
        )
        .max(1000),
      bracket_families: z
        .array(
          z.strictObject({
            family: canonical,
            kind: z.enum(["indicator", "count"]),
            position_type: PT,
            members: z
              .array(
                z.strictObject({
                  stat_id: statId,
                  canonical,
                  lower: z.number(),
                  upper: z.number().nullable(),
                }),
              )
              .max(40),
          }),
        )
        .max(40),
      unmapped_stat_ids: z.array(statId).max(1000),
      settings_hash: z.string().max(128),
      rounding: z.strictObject({
        mode: z.string().max(32),
        verified: z.boolean(),
        applied: z.enum(["exact", "round_half_up_total", "floor_total"]),
      }),
      negative_floor: z.strictObject({
        scope: z.string().max(32),
        verified: z.boolean(),
        applies: z.boolean(),
      }),
    })
    .optional(),
  roster: z
    .strictObject({
      slots: z
        .array(
          z.strictObject({
            name: slotName,
            class: z.enum(["starter", "flex", "bench", "ir", "other"]),
            count: z.number().int().min(0).max(60),
            eligible: z.array(slotName).max(20),
          }),
        )
        .max(40),
      starters: z.number().int().min(0),
      bench: z.number().int().min(0),
      ir: z.number().int().min(0),
      total: z.number().int().min(0),
    })
    .optional(),
  rules: z
    .strictObject({
      waiver_type: platformCode.nullable(),
      waiver_rule: platformCode.nullable(),
      waiver_time_days: z.number().nullable(),
      uses_faab: z.boolean(),
      faab_budget: z.number().nullable(),
      trade_end_date: isoDate.nullable(),
      trade_ratify_type: platformCode.nullable(),
      trade_reject_time_days: z.number().nullable(),
      can_trade_draft_picks: z.boolean().nullable(),
      max_adds: z.number().nullable(),
      max_weekly_adds: z.number().nullable(),
      playoffs: z.strictObject({
        uses_playoff: z.boolean(),
        start_week: week.nullable(),
        num_teams: z.number().int().nullable(),
        reseeding: z.boolean().nullable(),
        multiweek_championship: z.boolean().nullable(),
        consolation_teams: z.number().int().nullable(),
      }),
      player_pool: platformCode.nullable(),
      cant_cut_list: platformCode.nullable(),
      allow_add_to_dl_extra_pos: z.boolean().nullable(),
      unverified_fields: z.array(z.string().regex(/^[a-z_]{1,40}$/)).max(40),
      trade_review_mode: z.enum(["none", "commissioner", "league_vote", "unknown"]),
    })
    .optional(),
  weeks: z
    .array(
      z.strictObject({
        week,
        start: isoDate,
        end: isoDate,
        is_current: z.boolean(),
        provisional: z.boolean(),
      }),
    )
    .max(22)
    .optional(),
  stat_map: z
    .array(z.strictObject({ stat_id: statId, canonical }))
    .max(1000)
    .optional(),
});
export type LeagueDigest = z.infer<typeof a2Data>;

/**
 * The A2 digest (also served as `ff://league/settings`): normalised settings, slots, rules, weeks.
 * Rule and family names come from the platform and are wrapped (`<platform>.stat.name`).
 */
export async function leagueDigest(
  ctx: ToolContext,
  args: {
    readonly league_key?: string | undefined;
    readonly include?: readonly (typeof INCLUDE)[number][] | undefined;
    readonly force_refresh?: boolean | undefined;
    readonly allow_stale?: boolean | undefined;
  },
): Promise<{ data: LeagueDigest; inputs: InputStamp[] }> {
  const lc = await leagueContext(ctx, args);
  const inputs: InputStamp[] = [lc.input];
  const include = new Set(args.include ?? INCLUDE);
  const l = lc.league;
  const src = (f: string): string => textSource(lc.ref.platform, f);
  const data: {
    -readonly [K in keyof LeagueDigest]: LeagueDigest[K];
  } = {};
  if (include.has("league")) {
    data.league = {
      league_key: lc.ref.league_key,
      name: wrapUntrusted(l.name, "league_name", src("league.name")),
      season: l.season,
      num_teams: l.num_teams,
      scoring_type: codeOf(l.scoring_type),
      current_week: l.current_week,
      start_week: l.start_week,
      end_week: l.end_week,
      edit_key: l.edit_key,
      weekly_deadline: codeOf(l.weekly_deadline),
      league_update_timestamp: isoOrNull(l.league_update_timestamp),
      is_finished: l.is_finished,
    };
  }
  if (include.has("scoring") || include.has("stat_map")) {
    const opts = readOpts(args);
    const s = take(
      ctx,
      await ctx.services.platform.getScoringSettings(lc.ref, opts),
      inputs,
      lc.allowStale,
    );
    if (include.has("scoring")) {
      data.scoring = {
        uses_fractional_points: s.uses_fractional_points,
        uses_negative_points: s.uses_negative_points,
        uses_median_score: l.rules.uses_median_score,
        rules: s.rules.map((r) => ({
          stat_id: r.platform_id,
          name: wrapUntrusted(r.name, "stat_name", src("stat.name")),
          canonical: r.canonical,
          position_types: [...r.position_types] as PositionType[],
          modifier: r.modifier,
          display_only: r.modifier === null,
          bonuses: r.bonuses.map((b) => ({ target: b.target, points: b.points })),
        })),
        bracket_families: s.brackets.map((f) => ({
          family: f.family,
          kind: f.kind,
          position_type: f.position_type,
          members: f.members.map((m) => ({
            stat_id: m.platform_id,
            canonical: m.canonical,
            lower: m.lower,
            upper: m.upper,
          })),
        })),
        unmapped_stat_ids: [...unmappedIds(s)],
        settings_hash: s.settings_hash,
        rounding: {
          mode: s.rounding.mode,
          verified: s.rounding.verified,
          applied: appliedRounding(s),
        },
        negative_floor: {
          scope: s.negative_floor.scope,
          verified: s.negative_floor.verified,
          applies: floorApplies(s),
        },
      };
    }
    if (include.has("stat_map")) {
      data.stat_map = s.rules.flatMap((r) =>
        r.canonical === null ? [] : [{ stat_id: r.platform_id, canonical: r.canonical }],
      );
    }
  }
  if (include.has("roster")) {
    const opts = readOpts(args);
    const r = take(
      ctx,
      await ctx.services.platform.getRosterSlots(lc.ref, opts),
      inputs,
      lc.allowStale,
    );
    data.roster = {
      slots: r.slots.map((s) => ({
        name: s.name,
        class: s.class,
        count: s.count,
        eligible: [...s.eligible],
      })),
      starters: r.starters,
      bench: r.bench,
      ir: r.ir,
      total: r.total,
    };
  }
  if (include.has("rules")) {
    const r = l.rules;
    data.rules = {
      waiver_type: codeOf(r.waiver_type),
      waiver_rule: codeOf(r.waiver_rule),
      waiver_time_days: countOrNull(r.waiver_time_days),
      uses_faab: r.uses_faab,
      faab_budget: countOrNull(r.faab_budget),
      trade_end_date: dateOrNull(r.trade_end_date),
      trade_ratify_type: codeOf(r.trade_ratify_type),
      trade_reject_time_days: countOrNull(r.trade_reject_time_days),
      can_trade_draft_picks: r.can_trade_draft_picks,
      max_adds: countOrNull(r.max_adds),
      max_weekly_adds: countOrNull(r.max_weekly_adds),
      playoffs: { ...r.playoffs },
      player_pool: codeOf(r.player_pool),
      cant_cut_list: codeOf(r.cant_cut_list),
      allow_add_to_dl_extra_pos: r.allow_add_to_dl_extra_pos,
      unverified_fields: r.unverified_fields.filter((f) => /^[a-z_]{1,40}$/.test(f)),
      trade_review_mode: r.capabilities.tradeReviewMode,
    };
  }
  if (include.has("weeks")) {
    data.weeks = l.weeks.map((w) => ({
      week: w.week,
      start: w.start,
      end: w.end,
      is_current: w.is_current,
      provisional: w.provisional,
    }));
  }
  return { data, inputs };
}

export const getLeague = defineTool({
  name: "ff_get_league",
  family: "platform",
  description:
    "League settings digest: scoring rules and brackets (settings_hash), roster slots, waiver/trade rules, weeks.",
  input: z.strictObject({
    ...leagueShape,
    include: z
      .array(z.enum(INCLUDE))
      .min(1)
      .max(INCLUDE.length)
      .refine((a) => new Set(a).size === a.length, { message: "duplicate_values" })
      .optional(),
    ...platformFreshnessShape,
  }),
  data: a2Data,
  budget: "list",
  run: async (args, ctx) => {
    const { data, inputs } = await leagueDigest(ctx, args);
    return { data, inputs };
  },
});

// --- A3 ff_get_standings ---------------------------------------------------------------------------------

const a3Data = z.strictObject({
  teams: z
    .array(
      z.strictObject({
        team_key: teamKey,
        name: ut,
        manager: utOrNull,
        rank: z.number().int().nullable(),
        playoff_seed: z.number().int().nullable(),
        wins: z.number().int().min(0),
        losses: z.number().int().min(0),
        ties: z.number().int().min(0),
        pct: z.number().nullable(),
        streak: z
          .strictObject({
            type: z.enum(["win", "loss", "tie"]).nullable(),
            value: z.number().int(),
          })
          .nullable(),
        points_for: z.number().nullable(),
        points_against: z.number().nullable(),
        waiver_priority: z.number().int().nullable(),
        faab_balance: z.number().nullable(),
        number_of_moves: z.number().int().nullable(),
        number_of_trades: z.number().int().nullable(),
        roster_adds_week: z.number().int().nullable(),
        clinched_playoffs: z.boolean().nullable(),
        is_mine: z.boolean(),
      }),
    )
    .max(64),
  playoff_line: z.strictObject({
    num_playoff_teams: z.number().int().nullable(),
    start_week: week.nullable(),
  }),
});

export const getStandings = defineTool({
  name: "ff_get_standings",
  family: "platform",
  description:
    "Standings with each team's waiver priority, FAAB balance and moves (empty with a warning without standings).",
  input: z.strictObject({ ...leagueShape, ...platformFreshnessShape }),
  data: a3Data,
  budget: "list",
  run: async (args, ctx) => {
    const lc = await leagueContext(ctx, args);
    const inputs: InputStamp[] = [lc.input];
    const warnings: string[] = [];
    const caps = await capabilitiesOf(ctx);
    if (!(caps.read_features.standings ?? caps.read_features.matchups))
      warnings.push(MANUAL_FEATURE_WARNINGS.standings);
    const rows = take(
      ctx,
      await ctx.services.platform.getStandings(lc.ref, readOpts(args)),
      inputs,
      lc.allowStale,
    );
    const src = (f: string): string => textSource(lc.ref.platform, f);
    const mine = lc.league.my_team?.team_key ?? null;
    const teams = rows.map((s) => ({
      team_key: s.team.team_key,
      name: wrapUntrusted(s.name, "team_name", src("team.name")),
      manager: wrapUntrustedOrNull(s.manager, "manager_nickname", src("manager.nickname")),
      rank: s.rank,
      playoff_seed: s.playoff_seed,
      wins: s.wins,
      losses: s.losses,
      ties: s.ties,
      pct: s.pct,
      streak: s.streak === null ? null : { type: s.streak.type, value: s.streak.value },
      points_for: s.points_for,
      points_against: s.points_against,
      waiver_priority: s.waiver_priority,
      faab_balance: s.faab_balance,
      number_of_moves: s.number_of_moves,
      number_of_trades: s.number_of_trades,
      roster_adds_week: s.roster_adds_week,
      clinched_playoffs: s.clinched_playoffs,
      is_mine: s.team.team_key === mine,
    }));
    const po = lc.league.rules.playoffs;
    return {
      data: {
        teams,
        playoff_line: {
          num_playoff_teams: po.uses_playoff ? po.num_teams : null,
          start_week: po.uses_playoff ? po.start_week : null,
        },
      },
      inputs,
      warnings,
      listKey: "teams",
    };
  },
});

// --- A4 ff_get_scoreboard ----------------------------------------------------------------------------------

const a4Data = z.strictObject({
  week,
  matchups: z
    .array(
      z.strictObject({
        status: platformCode.nullable(),
        is_playoffs: z.boolean(),
        is_consolation: z.boolean(),
        is_tied: z.boolean(),
        winner_team_key: teamKey.nullable(),
        teams: z
          .array(
            z.strictObject({
              team_key: teamKey,
              name: ut,
              points: z.number().nullable(),
              projected_points_yahoo: z.number().nullable(),
              win_probability_yahoo: z.number().min(0).max(1).nullable(),
              is_mine: z.boolean(),
            }),
          )
          .length(2),
      }),
    )
    .max(40),
});

/** The fixed warning for a manual-league week with no matchup (a driver is named, never omitted). */
export function manualNoMatchupWarning(week: number): string {
  return `no matchup for week ${String(week)} in league.yaml: add an opponents: entry for this week`;
}

export const getScoreboard = defineTool({
  name: "ff_get_scoreboard",
  family: "platform",
  description:
    "A week's matchups; *_yahoo fields are the platform's own cross-checks. meta.provisional: scoring not final.",
  input: z.strictObject({
    ...leagueShape,
    week: weekSchema.optional(),
    team_key: teamKeySchema.optional(),
    ...platformFreshnessShape,
  }),
  data: a4Data,
  budget: "list",
  run: async (args, ctx) => {
    const lc = await leagueContext(ctx, args);
    const inputs: InputStamp[] = [lc.input];
    const warnings: string[] = [];
    const w = weekOf(lc, args.week);
    const caps = await capabilitiesOf(ctx);
    if (!caps.read_features.matchups) warnings.push(MANUAL_FEATURE_WARNINGS.matchups);
    const all = take(
      ctx,
      await ctx.services.platform.getMatchups(lc.ref, w, readOpts(args)),
      inputs,
      lc.allowStale,
    );
    // QA-1-008: under the manual league an empty week is a missing `opponents:` entry — name it
    if (all.length === 0 && caps.read_features.matchups && lc.ref.platform === "manual")
      warnings.push(manualNoMatchupWarning(w));
    const src = textSource(lc.ref.platform, "team.name");
    const mine = lc.league.my_team?.team_key ?? null;
    const matchups = all
      .filter(
        (m) =>
          args.team_key === undefined || m.teams.some((t) => t.team.team_key === args.team_key),
      )
      .map((m) => ({
        status: codeOf(m.status),
        is_playoffs: m.is_playoffs,
        is_consolation: m.is_consolation,
        is_tied: m.is_tied,
        winner_team_key: m.winner_team_key,
        teams: m.teams.map((t) => ({
          team_key: t.team.team_key,
          name: wrapUntrusted(t.name, "team_name", src),
          points: t.points,
          projected_points_yahoo: t.projected_points_platform,
          win_probability_yahoo: t.win_probability_platform,
          is_mine: t.team.team_key === mine,
        })),
      }));
    return {
      data: { week: w, matchups },
      inputs,
      warnings,
      provisional: weekProvisional(ctx, lc.league.season, w),
      listKey: "matchups",
    };
  },
});

// --- A5 ff_list_transactions (C10: no outputSchema) -----------------------------------------------------------

const TXN_TYPES = [
  "add",
  "drop",
  "add/drop",
  "trade",
  "commish",
  "waiver",
  "pending_trade",
] as const;

export const listTransactions = defineTool({
  name: "ff_list_transactions",
  family: "platform",
  description:
    "League transactions, newest first (count, since; never pages). Shape: ff://docs/tool-outputs.",
  input: z
    .strictObject({
      ...leagueShape,
      types: z
        .array(z.enum(TXN_TYPES))
        .min(1)
        .max(TXN_TYPES.length)
        .refine((a) => new Set(a).size === a.length, { message: "duplicate_values" })
        .optional(),
      team_key: teamKeySchema.optional(),
      count: txnCountSchema,
      since: isoInstantSchema.optional(),
      ...platformFreshnessShape,
    })
    .refine(
      (v) =>
        v.team_key !== undefined ||
        !(v.types ?? []).some((t) => t === "waiver" || t === "pending_trade"),
      { message: "team_key_required", path: ["team_key"] },
    ),
  data: null,
  budget: "list",
  pageable: false,
  hint: TRUNCATION_HINTS.transactions,
  run: async (args, ctx) => {
    const lc = await leagueContext(ctx, args);
    const inputs: InputStamp[] = [lc.input];
    const warnings: string[] = [];
    const caps = await capabilitiesOf(ctx);
    if (!caps.read_features.transactions) warnings.push(MANUAL_FEATURE_WARNINGS.transactions);
    const since = args.since === undefined ? null : new Date(Date.parse(args.since)).toISOString();
    const platformTxns = take(
      ctx,
      await ctx.services.platform.listTransactions(
        lc.ref,
        {
          types: args.types ?? null,
          team_key: args.team_key ?? null,
          count: args.count,
          since,
        },
        readOpts(args),
      ),
      inputs,
      lc.allowStale,
    );
    const seen = ctx.services.transactionsSeen.list(lc.ref.league_key, since, args.count);
    const byKey = new Map<string, Transaction>();
    for (const t of [...platformTxns, ...seen])
      if (!byKey.has(t.transaction_key)) byKey.set(t.transaction_key, t);
    const types = args.types === undefined ? null : new Set<string>(args.types);
    const sinceMs = since === null ? null : Date.parse(since);
    const merged = [...byKey.values()]
      .filter((t) => types === null || types.has(t.type))
      .filter((t) => sinceMs === null || Date.parse(t.timestamp) >= sinceMs)
      .filter(
        (t) =>
          args.team_key === undefined ||
          t.trader_team_key === args.team_key ||
          t.tradee_team_key === args.team_key ||
          t.players.some(
            (p) => p.source_team_key === args.team_key || p.destination_team_key === args.team_key,
          ),
      )
      .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
      .slice(0, args.count);
    const noteSrc = textSource(lc.ref.platform, "transaction.note");
    const nameSrc = textSource(lc.ref.platform, "player.name");
    const transactions = merged.map((t) => ({
      transaction_key: t.transaction_key,
      type: codeOf(t.type),
      status: codeOf(t.status),
      timestamp: isoOrNull(t.timestamp),
      faab_bid: t.faab_bid,
      waiver_priority: t.waiver_priority,
      players: t.players.map((p) => ({
        player_key: p.player.id,
        name: bareUntrusted(p.name, "player_name"),
        position: p.position !== null && /^[A-Z]{1,4}$/.test(p.position) ? p.position : null,
        team_abbr: p.team_abbr !== null && /^[A-Za-z]{2,4}$/.test(p.team_abbr) ? p.team_abbr : null,
        action: p.action,
        source_type: codeOf(p.source_type),
        source_team_key: p.source_team_key,
        destination_type: codeOf(p.destination_type),
        destination_team_key: p.destination_team_key,
      })),
      trader_team_key: t.trader_team_key,
      tradee_team_key: t.tradee_team_key,
      note: wrapUntrustedOrNull(t.note, "trade_note", noteSrc),
    }));
    const oldest = ctx.services.transactionsSeen.oldestSeen(lc.ref.league_key);
    const bareFields: UntrustedField[] = [bare("data.transactions[].players[].name", nameSrc)];
    return {
      data: {
        transactions,
        history_coverage: {
          oldest_seen: oldest,
          gap_suspected: platformTxns.length >= args.count && oldest === null,
        },
      },
      inputs,
      warnings,
      bareFields,
      page: {
        limit: args.count,
        offset: 0,
        count: transactions.length,
        has_more: false,
        next_offset: null,
      },
      listKey: "transactions",
    };
  },
});

/** Output shapes (tests). */
export const LEAGUE_DATA_SCHEMAS = { a1Data, a2Data, a3Data, a4Data } as const;
