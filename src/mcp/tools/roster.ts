// roster.ts — the roster & lineup tools (plan 07 §3.B): B1 ff_get_roster (slots, eligibility,
// statuses, byes and the lock schedule computed once — plan 05 §14.1/§14.2) and B2
// ff_get_player_stats (stat lines with the engine's recomputation and the golden `match` flag, C6;
// under the manual league the lines are nflverse's and `match` is null — plan 10 §3.1a).
import { z } from "zod/v4";
import { NFL_TEAMS, type NflTeam } from "../../config/schema.js";
import type { PlayerWeekLine, TeamDefenseWeekLine } from "../../domain/analytics/types.js";
import { validateRoster } from "../../domain/league/roster.js";
import {
  byeWeekOf,
  byeWeeks,
  latestExecutionTime,
  lockAtFor,
  lockSchedule,
  opponentOf,
  teamGame,
} from "../../domain/league/schedule.js";
import {
  POSITION_RE,
  SLOT_NAME_RE,
  STATUS_CODE_RE,
  TEAM_ABBR_RE,
  codeOrNull,
  type PlayerRef,
} from "../../domain/league/types.js";
import { score } from "../../domain/scoring/engine.js";
import { pointsMatch } from "../../domain/scoring/policy.js";
import { unmappedIds } from "../../domain/scoring/settings.js";
import type { ScoringSettings, StatLine } from "../../domain/scoring/types.js";
import { MANUAL_FEATURE_WARNINGS } from "../../providers/platform.js";
import {
  detailShape,
  leagueShape,
  platformFreshnessShape,
  playerKeysSchema,
  teamKeySchema,
  weekSchema,
} from "../bounds.js";
import { defineTool } from "../define.js";
import {
  bareUntrusted,
  wrapUntrustedOrNull,
  type InputStamp,
  type UntrustedField,
} from "../envelope.js";
import { FfError } from "../errors.js";
import {
  ALL_WEEKS,
  bare,
  crosswalkRun,
  leagueContext,
  leagueUniverse,
  leagueTypedLine,
  lockModeOf,
  nflTeamOf,
  optionalDataset,
  present,
  readOpts,
  requiredDataset,
  rosterRows,
  scoringOf,
  seasonGames,
  slotsOf,
  subjectFromKey,
  take,
  teamOf,
  textSource,
  weekGames,
  weekOf,
  weekProvisional,
} from "./common.js";
import { capabilitiesOf } from "./league.js";
import {
  bareName,
  canonical,
  gsisId,
  iso,
  nflTeam,
  playerKey,
  position,
  slotName,
  statusCode,
  teamAbbr,
  teamKey,
  utOrNull,
  week,
} from "./schemas.js";

const codeOr = (v: string | null, re: RegExp): string | null => codeOrNull(v, re);

// --- B1 ff_get_roster -------------------------------------------------------------------------------------

const b1Player = z.strictObject({
  player_key: playerKey,
  gsis_id: gsisId.nullable(),
  name: bareName,
  position: position.nullable(),
  eligible: z.array(slotName).max(20),
  team_abbr: teamAbbr.nullable(),
  slot: slotName,
  slot_class: z.enum(["starter", "flex", "bench", "ir", "other"]),
  is_flex: z.boolean(),
  is_editable: z.boolean(),
  status: statusCode.nullable(),
  status_full: utOrNull.optional(),
  injury_note: utOrNull.optional(),
  bye_week: week.nullable(),
  opponent: nflTeam.nullable(),
  kickoff: iso.nullable(),
  lock_at: iso.nullable(),
  percent_owned: z.number().nullable().optional(),
  percent_owned_delta: z.number().nullable().optional(),
  week_points: z.number().nullable(),
});

const b1Data = z.strictObject({
  team_key: teamKey,
  week,
  is_editable: z.boolean(),
  roster_adds_week: z.number().int().nullable(),
  players: z.array(b1Player).max(60),
  lock_schedule: z
    .array(z.strictObject({ lock_at: iso, player_keys: z.array(playerKey).max(60) }))
    .max(60),
  empty_starting_slots: z.array(slotName).max(40),
  ir_ineligible_in_ir: z.array(playerKey).max(60),
  over_limit: z.boolean(),
  latest_execution_time: iso.nullable(),
});

export const getRoster = defineTool({
  name: "ff_get_roster",
  family: "platform",
  description:
    "A roster for a week (default: mine, current): slots, eligibility, status, byes, kickoffs, lock_schedule, latest_execution_time.",
  input: z.strictObject({
    ...leagueShape,
    team_key: teamKeySchema.optional(),
    week: weekSchema.optional(),
    ...detailShape,
    ...platformFreshnessShape,
  }),
  data: b1Data,
  budget: "list",
  run: async (args, ctx) => {
    const lc = await leagueContext(ctx, args);
    const inputs: InputStamp[] = [lc.input];
    const w = weekOf(lc, args.week);
    const team = teamOf(lc, args.team_key);
    const season = lc.league.season;
    const roster = take(
      ctx,
      await ctx.services.platform.getRoster(team, w, readOpts(args)),
      inputs,
      lc.allowStale,
    );
    const slots = await slotsOf(ctx, lc, inputs);
    const games = weekGames(ctx, season, w);
    const all = seasonGames(ctx, season);
    const schedIn = optionalDataset(games, ctx.nowMs, lc.allowStale);
    if (schedIn !== null) inputs.push(schedIn);
    const byes = byeWeeks(all.rows, season, NFL_TEAMS);
    const { byKey } = crosswalkRun(
      ctx,
      season,
      roster.entries.map((e) => e.player),
    );
    const rosterIn = optionalDataset(rosterRows(ctx, season), ctx.nowMs, lc.allowStale);
    if (rosterIn !== null) inputs.push(rosterIn);
    const mode = lockModeOf(lc.league);
    const full = args.detail === "full";
    const src = (f: string): string => textSource(lc.ref.platform, f);
    const players = roster.entries.map((e) => {
      const p = e.player;
      const t = nflTeamOf(p);
      const g = t === null ? null : teamGame(t, games.rows);
      const lockAt = games.rows.length === 0 ? null : lockAtFor(t, games.rows, mode);
      const row: z.infer<typeof b1Player> = {
        player_key: p.ref.id,
        gsis_id: byKey.get(p.ref.id)?.gsis_id ?? null,
        name: bareUntrusted(p.name, "player_name"),
        position: codeOr(p.position, POSITION_RE),
        eligible: p.eligible_positions.filter((x) => SLOT_NAME_RE.test(x)),
        team_abbr: codeOr(p.team_abbr, TEAM_ABBR_RE),
        slot: e.slot,
        slot_class: e.slot_class,
        is_flex: e.is_flex,
        is_editable: e.is_editable,
        status: codeOr(p.status, STATUS_CODE_RE),
        bye_week: p.bye_week ?? (t === null ? null : byeWeekOf(t, byes)),
        opponent: g === null || t === null ? null : opponentOf(t, g),
        kickoff: g?.kickoff ?? null,
        lock_at: lockAt,
        week_points: e.week_points,
      };
      if (full) {
        row.status_full = wrapUntrustedOrNull(
          p.status_full,
          "status_full",
          src("player.status_full"),
        );
        row.injury_note = wrapUntrustedOrNull(
          p.injury_note,
          "injury_note",
          src("player.injury_note"),
        );
        row.percent_owned = p.percent_owned;
        row.percent_owned_delta = p.percent_owned_delta;
      }
      return row;
    });
    const subjects = roster.entries.map((e) => ({
      player_key: e.player.ref.id,
      nfl_team: nflTeamOf(e.player),
    }));
    const schedule = games.rows.length === 0 ? [] : lockSchedule(subjects, games.rows, mode);
    const validation = validateRoster(
      roster.entries.map((e) => ({
        player_key: e.player.ref.id,
        slot: e.slot,
        positions: [e.player.position],
        status: e.player.status,
        nfl_team: nflTeamOf(e.player),
      })),
      slots,
      { bye: { week: w, byes } },
    );
    return {
      data: {
        team_key: roster.team.team_key,
        week: roster.week,
        is_editable: roster.is_editable,
        roster_adds_week: roster.roster_adds_week,
        players,
        lock_schedule: schedule.map((s) => ({
          lock_at: s.lock_at,
          player_keys: [...s.player_keys],
        })),
        empty_starting_slots: [...validation.empty_starting_slots],
        ir_ineligible_in_ir: [...validation.ir_ineligible_in_ir],
        over_limit: validation.over_limit,
        latest_execution_time: latestExecutionTime(schedule, ctx.nowMs),
      },
      inputs,
      bareFields: [bare("data.players[].name", src("player.name"))],
      provisional: weekProvisional(ctx, season, w),
      listKey: "players",
    };
  },
});

// --- B2 ff_get_player_stats -----------------------------------------------------------------------------

const b2Data = z.strictObject({
  players: z
    .array(
      z.strictObject({
        player_key: playerKey,
        name: bareName,
        position: position.nullable(),
        stats: z
          .array(
            z.strictObject({
              stat_id: z.string().max(64).nullable(),
              canonical,
              value: z.number(),
            }),
          )
          .max(80),
        yahoo_points: z.number().nullable(),
        engine_points: z.number().nullable(),
        engine_complete: z.boolean(),
        match: z.boolean().nullable(),
        unmapped_stat_ids: z.array(z.string().max(64)).max(1000),
      }),
    )
    .max(25),
  settings_hash: z.string().max(128),
});

/** Sums stat lines (season totals); scoring is per week and summed separately. */
function sumValues(lines: readonly StatLine[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of lines) {
    for (const [k, v] of Object.entries(l.values)) out[k] = (out[k] ?? 0) + v;
  }
  return out;
}

export const getPlayerStats = defineTool({
  name: "ff_get_player_stats",
  family: "platform",
  description:
    "Stat lines (week or season) for up to 25 player keys, with this league's engine points and the golden match flag.",
  input: z
    .strictObject({
      ...leagueShape,
      player_keys: playerKeysSchema,
      type: z.enum(["week", "season"]),
      week: weekSchema.optional(),
      ...platformFreshnessShape,
    })
    .refine((v) => v.type === "season" || v.week !== undefined, {
      message: "week_required",
      path: ["week"],
    }),
  data: b2Data,
  budget: "list",
  run: async (args, ctx) => {
    const lc = await leagueContext(ctx, args);
    const inputs: InputStamp[] = [lc.input];
    const warnings: string[] = [];
    const season = lc.league.season;
    const settings: ScoringSettings = await scoringOf(ctx, lc, inputs);
    const caps = await capabilitiesOf(ctx);
    if (!caps.read_features.player_stats) warnings.push(MANUAL_FEATURE_WARNINGS.player_stats);
    const universe = await leagueUniverse(ctx, lc, inputs);
    const rosterRowsRes = rosterRows(ctx, season);
    const byGsis = new Map(rosterRowsRes.rows.map((r) => [r.gsis_id, r]));
    const sources = new Set<string>();
    const resolved = present(
      args.player_keys.map((key) => {
        const u = universe.byKey.get(key);
        if (u !== undefined) {
          sources.add(textSource(lc.ref.platform, "player.name"));
          return { key, name: u.player.name, position: u.player.position, subject: u.subject };
        }
        const subject = subjectFromKey(key);
        if (subject === null) return null;
        if (subject.kind === "defense") {
          sources.add(textSource(lc.ref.platform, "player.name"));
          return { key, name: subject.nfl_team, position: "DEF", subject };
        }
        const r = byGsis.get(subject.gsis_id);
        if (r === undefined) return null;
        sources.add("nflverse.roster_weekly.name");
        return { key, name: r.full_name, position: r.position, subject };
      }),
    );
    if (resolved.length === 0) throw new FfError("NOT_FOUND");
    if (resolved.length < args.player_keys.length)
      warnings.push(
        `${String(args.player_keys.length - resolved.length)} player keys were not found and are omitted`,
      );
    const weeks = args.type === "week" && args.week !== undefined ? [args.week] : ALL_WEEKS;
    const gsis = present(
      resolved.map((r) => (r.subject?.kind === "player" ? r.subject.gsis_id : null)),
    );
    const teams = present<NflTeam>(
      resolved.map((r) => (r.subject?.kind === "defense" ? r.subject.nfl_team : null)),
    );
    const lines = ctx.services.datasets.playerWeeks.lines(gsis, season, weeks);
    const dIn = requiredDataset(lines, ctx.nowMs, lc.allowStale);
    if (dIn !== null) inputs.push(dIn);
    const dLines =
      teams.length === 0
        ? { rows: [] as TeamDefenseWeekLine[], stamp: null }
        : ctx.services.datasets.playerWeeks.defenseLines(teams, season, weeks);
    const refs: PlayerRef[] = resolved.map((r) => ({ platform: lc.ref.platform, id: r.key }));
    const platformLines = take(
      ctx,
      await ctx.services.platform.getPlayerStats(
        lc.ref,
        refs,
        args.type === "week" && args.week !== undefined
          ? { coverage: "week", week: args.week }
          : { coverage: "season" },
        readOpts(args),
      ),
      inputs,
      lc.allowStale,
    );
    const platformByKey = new Map(platformLines.map((l) => [l.player.id, l]));
    const statIdOf = new Map<string, string>();
    for (const r of settings.rules)
      if (r.canonical !== null) statIdOf.set(r.canonical, r.platform_id);
    const unmapped = [...unmappedIds(settings)];
    const players = resolved.map((r) => {
      const own: (PlayerWeekLine | TeamDefenseWeekLine)[] =
        r.subject?.kind === "player"
          ? lines.rows.filter((l) => l.gsis_id === (r.subject as { gsis_id: string }).gsis_id)
          : r.subject?.kind === "defense"
            ? dLines.rows.filter((l) => l.nfl_team === (r.subject as { nfl_team: string }).nfl_team)
            : [];
      // a player line is scored as the league's position (QA-1-018); a D/ST line is DT already
      const scored = own.map((l) =>
        score("gsis_id" in l ? leagueTypedLine(l.line, r.position) : l.line, settings),
      );
      const engine = scored.length === 0 ? null : scored.reduce((a, s) => a + s.points, 0);
      const values = sumValues(own.map((l) => l.line));
      const plat = platformByKey.get(r.key);
      const yahoo = plat?.platform_points ?? null;
      return {
        player_key: r.key,
        name: bareUntrusted(r.name, "player_name"),
        position: codeOr(r.position, POSITION_RE),
        stats: Object.keys(values)
          .sort()
          .slice(0, 80)
          .map((c) => ({ stat_id: statIdOf.get(c) ?? null, canonical: c, value: values[c] ?? 0 })),
        yahoo_points: yahoo,
        engine_points: engine === null ? null : Math.round(engine * 100) / 100,
        engine_complete: scored.length > 0 && scored.every((s) => s.complete),
        match: yahoo === null || engine === null ? null : pointsMatch(engine, yahoo),
        unmapped_stat_ids: unmapped,
      };
    });
    const bareFields: UntrustedField[] = [...sources].map((s) => bare("data.players[].name", s));
    return {
      data: { players, settings_hash: settings.settings_hash },
      inputs,
      warnings,
      bareFields,
      extraSources: ["engine"],
      estimate: true,
      provisional:
        args.type === "week" && args.week !== undefined
          ? weekProvisional(ctx, season, args.week)
          : false,
      listKey: "players",
    };
  },
});
