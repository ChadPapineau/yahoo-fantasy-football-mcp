// analytics.ts — the P0 decision engines as tools (plan 07 §3.E): E1 ff_project_players
// (v1-trailing, position_cv), E2 ff_analyze_lineup (start/sit as assignment; objective mean by
// default — C11), E3 ff_analyze_matchup (`pre` only in P0) and E5 ff_analyze_waivers (K/DEF only in
// P0; availability unknown under the manual league — plan 07 E5). Every result carries data.inputs
// and data.rec, meta.estimate: true, and the 10 000-char analytics budget (plan 07 C8).
import { randomInt } from "node:crypto";
import { z } from "zod/v4";
import { NFL_TEAMS } from "../../config/schema.js";
import {
  analyzeKdef,
  analyzeLineup,
  analyzeMatchupPre,
  projectPlayers,
  type KdefCandidateInput,
  type LineupPlayer,
  type ProjectionOutcome,
  type ProjectionReaders,
} from "../../domain/analytics/index.js";
import type { Projection, ProjectionRepository, Rec } from "../../domain/analytics/types.js";
import { seedFrom, seededRng, type Rng } from "../../domain/clock.js";
import { isLocked, lockAtFor } from "../../domain/league/schedule.js";
import { MAX_ROSTER_SIZE, canOccupy, slotByName } from "../../domain/league/slots.js";
import { manualPlayerKeyFor, type RosterSlots, type Week } from "../../domain/league/types.js";
import type { ScoringSettings, StoredProjection } from "../../domain/scoring/types.js";
import { MANUAL_FA_POOL_WARNING } from "../../providers/platform.js";
import {
  BOUNDS,
  analyticsFreshnessShape,
  detailShape,
  leagueShape,
  lookAheadSchema,
  nSimsSchema,
  playerKeySchema,
  playerKeysSchema,
  projectionSelectorSchema,
  seedSchema,
  teamKeySchema,
  weekSchema,
  addsRemainingSchema,
  faabBudgetSchema,
} from "../bounds.js";
import { defineTool, type ToolContext } from "../define.js";
import {
  ANALYTICS_BUDGET_CHARS,
  bareUntrusted,
  recSchema,
  type BudgetTrim,
  type InputStamp,
  type UntrustedField,
} from "../envelope.js";
import { FfError } from "../errors.js";
import {
  bare,
  inputOf,
  leagueContext,
  lockModeOf,
  optionalDataset,
  platformInput,
  requiredSource,
  rosterRows,
  scoringOf,
  slotsOf,
  teamOf,
  weekGames,
  weekOf,
  type LeagueContext,
} from "./common.js";
import {
  ACTIVE_ROSTER_STATUS,
  projectable,
  rosterTargets,
  selectTargets,
  type Target,
} from "./select.js";
import {
  bareName,
  canonical,
  dist,
  gsisId,
  inputs as inputsSchema,
  iso,
  nflTeam,
  playerKey,
  position,
  prob,
  serverText,
  slotName,
  week,
} from "./schemas.js";

/** The internal simulation size for E2/E3/E5 projections (E1's public floor — A15 latency). */
export const INTERNAL_SIMS = 1000;

/** A seeded Rng for this call: the argument's seed, else a fresh one. */
function rngFor(ctx: ToolContext, seed: number | undefined): Rng {
  return seededRng(seed ?? ctx.services.newSeed?.() ?? randomInt(0, BOUNDS.seed.max));
}

/**
 * The seed of an E2/E3/E5 call, which takes no `seed` argument (QA-1-003, QA-1-023): derived from
 * the call's canonical inputs — the tool, the league, the team, the week and every input's source and
 * as_of — so an identical call over identical data gives identical quantiles and p_win (means and
 * decisions are seed-independent already), and any data change draws a new one.
 */
export function callSeed(
  tool: string,
  key: { readonly league: string; readonly team: string; readonly week: Week },
  inputs: readonly InputStamp[],
): number {
  return seedFrom(
    JSON.stringify({
      tool,
      league: key.league,
      team: key.team,
      week: key.week,
      inputs: inputs.map((i) => [i.source, i.as_of]),
    }),
  );
}

/**
 * The dataset readers the engines use (weather only when a weather source is configured), with the
 * nflverse weekly rosters so a reserve/cut/inactive player is out (QA-1-030).
 */
function readers(ctx: ToolContext): ProjectionReaders {
  const d = ctx.services.datasets;
  return {
    schedules: d.schedules,
    injuries: d.injuries,
    playerWeeks: d.playerWeeks,
    rosters: { latest: (season) => rosterRows(ctx, season) },
    ...(ctx.options.weatherSource === "off" ? {} : { weather: d.weather }),
  };
}

/** The warning E2/E3 add when the projections ran without betting lines (QA-1-004). */
export const LINES_OMITTED_WARNING = "betting lines omitted: older than 24 h";

/**
 * The dataset gate every analytics tool passes first: schedules and stats must have been loaded
 * (STALE_ONLY + the refresh hint otherwise) and none may be past its hard limit unless allow_stale;
 * injuries and weather are optional. Returns the envelope inputs.
 */
function datasetGate(ctx: ToolContext, lc: LeagueContext, weeks: readonly Week[]): InputStamp[] {
  const d = ctx.services.datasets;
  const season = lc.league.season;
  const out: (InputStamp | null)[] = [
    requiredSource(ctx, "nflverse:schedules", d.schedules.games(season, weeks), lc.allowStale),
  ];
  const stats = d.playerWeeks.lines([], season, weeks);
  if (stats.stamp !== null) out.push(inputOf(stats.stamp, ctx.nowMs, lc.allowStale));
  const first = weeks[0];
  if (first !== undefined)
    out.push(optionalDataset(d.injuries.reports(season, first, []), ctx.nowMs, lc.allowStale));
  return out.filter((x): x is InputStamp => x !== null);
}

/** Names of path-listed rows, one declaration per distinct provenance tag. */
function nameFields(path: string, targets: readonly Target[]): UntrustedField[] {
  return [...new Set(targets.map((t) => t.name_source))].map((s) => bare(path, s));
}

function projectionTargets(targets: readonly Target[]) {
  return targets.map((t) => ({
    player_key: t.player_key,
    subject: t.subject,
    name: t.name,
    position: t.position,
    nfl_team: t.nfl_team,
    platform_status: t.platform?.status ?? null,
  }));
}

// --- E1 ff_project_players ------------------------------------------------------------------------------

const projWeek = z.strictObject({
  week,
  points: dist,
  p_active: prob.nullable(),
  opponent: z
    .string()
    .regex(/^[A-Z]{2,3}$/)
    .nullable(),
  implied_total: z.number().nullable(),
  p_active_basis: z
    .enum(["designation_base_rate", "trend_model", "yahoo_gameday_status", "none"])
    .optional(),
});
const driver = z.strictObject({ name: serverText, contribution: z.number() });
const assumption = z.strictObject({ text: serverText, revisit_trigger: serverText });

const e1Projection = z.strictObject({
  player_key: playerKey.nullable(),
  gsis_id: gsisId.nullable(),
  name: bareName,
  position,
  model_version: z.enum(["v1-trailing", "v2-opportunity"]).optional(),
  weeks: z.array(projWeek).max(18),
  ros_total: dist.nullable().optional(),
  stat_line_expectation: z.record(canonical, z.number()).nullable().optional(),
  opportunity: z.null().optional(),
  shrinkage: z
    .array(z.strictObject({ rate: canonical, n: z.number(), k: z.number() }))
    .max(80)
    .optional(),
  multipliers: z
    .strictObject({ matchup: z.number().nullable(), weather: z.number().nullable() })
    .optional(),
  drivers: z.array(driver).max(20),
  role_confidence_games: z.number().int().min(0),
  assumptions: z.array(assumption).max(20).optional(),
});

const e1Data = z.strictObject({
  model_version: z.enum(["v1-trailing", "v2-opportunity"]),
  projections: z.array(e1Projection).max(64),
  assumptions: z.array(assumption).max(40),
  inputs: inputsSchema,
});

/** The ROS/season horizon cap (weeks projected in one call; plan 07 §5.2 compact keeps 3). */
export const HORIZON_MAX_WEEKS = 6;

function horizonWeeks(lc: LeagueContext, horizon: "week" | "ros" | "season", w: Week): Week[] {
  if (horizon === "week") return [w];
  const end = Math.min(lc.league.end_week, w + HORIZON_MAX_WEEKS - 1, 22);
  const out: Week[] = [];
  for (let x = w; x <= end; x++) out.push(x);
  return out.length === 0 ? [w] : out;
}

/**
 * One projection row for output: names bare. `compact` (plan 07 §5.2) keeps every identifier, every
 * Dist, p_active, opponent, implied total, drivers and role games; it drops per-week arrays beyond
 * three weeks, the per-row model version (it is at the top), multipliers, p_active_basis, null
 * placeholders, stat-line expectations, shrinkage and the per-row assumptions (hoisted, deduplicated).
 */
function projectionRow(p: Projection, full: boolean) {
  const weeks = (full ? p.weeks : p.weeks.slice(0, 3)).map((w) => ({
    week: w.week,
    points: w.points,
    p_active: w.p_active,
    opponent: w.opponent,
    implied_total: w.implied_total,
    ...(full && w.p_active_basis !== undefined ? { p_active_basis: w.p_active_basis } : {}),
  }));
  return {
    player_key: p.player_key,
    gsis_id: p.gsis_id,
    name: bareUntrusted(p.name, "player_name"),
    position: p.position,
    ...(full ? { model_version: p.model_version } : {}),
    weeks,
    ...(full || p.ros_total !== null ? { ros_total: p.ros_total } : {}),
    ...(full ? { stat_line_expectation: p.stat_line_expectation } : {}),
    ...(full ? { opportunity: null } : {}),
    ...(full ? { shrinkage: p.shrinkage.map((s) => ({ ...s })) } : {}),
    ...(full
      ? { multipliers: { matchup: p.multipliers.matchup, weather: p.multipliers.weather } }
      : {}),
    drivers: p.drivers.map((d) => ({ name: d.name, contribution: d.contribution })),
    role_confidence_games: p.role_confidence_games,
    ...(full ? { assumptions: p.assumptions.map((a) => ({ ...a })) } : {}),
  };
}

export const projectPlayersTool = defineTool({
  name: "ff_project_players",
  family: "analytics",
  description:
    "Per player-week point distributions (Dist with basis) scored for this league, with p_active, implied total, drivers. Seedable.",
  input: z.strictObject({
    ...leagueShape,
    players: projectionSelectorSchema,
    horizon: z.enum(["week", "ros", "season"]),
    week: weekSchema.optional(),
    n_sims: nSimsSchema,
    seed: seedSchema.optional(),
    include_stat_line: z.boolean().default(false),
    ...detailShape,
    ...analyticsFreshnessShape,
  }),
  data: e1Data,
  budget: "analytics",
  run: async (args, ctx) => {
    const lc = await leagueContext(ctx, args);
    const warnings: string[] = [];
    const inputs: InputStamp[] = [lc.input];
    const w = weekOf(lc, args.week);
    const weeks = horizonWeeks(lc, args.horizon, w);
    if (args.horizon !== "week")
      warnings.push(`horizon capped at ${String(HORIZON_MAX_WEEKS)} weeks from week ${String(w)}`);
    inputs.push(...datasetGate(ctx, lc, weeks));
    const all = await selectTargets(ctx, lc, args.players, w, inputs, warnings);
    const targets = all.filter(projectable);
    if (targets.length === 0) throw new FfError("NOT_FOUND");
    if (targets.length < all.length)
      warnings.push(
        `${String(all.length - targets.length)} players at non-projectable positions omitted`,
      );
    const settings = await scoringOf(ctx, lc, inputs);
    // persisted only for the projections the caller actually receives (QA-1-031): the engine's puts
    // are held here and committed by onEmit, after the result is cut to its budget
    const held: StoredProjection[] = [];
    const store = ctx.services.projections;
    const holding: ProjectionRepository = {
      put: (p) => {
        held.push(p);
        return { written: true };
      },
      latest: (...a) => store.latest(...a),
      getAsOf: (...a) => store.getAsOf(...a),
    };
    const out = projectPlayers({
      targets: projectionTargets(targets),
      season: lc.league.season,
      weeks,
      settings,
      readers: readers(ctx),
      clock: ctx.services.clock,
      rng: rngFor(ctx, args.seed),
      n_sims: args.n_sims,
      include_stat_line: args.include_stat_line || args.detail === "full",
      repository: holding,
      status_as_of: lc.input.as_of,
    });
    const subjectOfKey = new Map(
      targets.map((t) => [t.player_key ?? manualPlayerKeyFor(t.subject), subjectId(t.subject)]),
    );
    const full = args.detail === "full";
    const hoisted = new Map<string, { text: string; revisit_trigger: string }>();
    if (!full)
      for (const p of out.result.projections)
        for (const a of p.assumptions) hoisted.set(`${a.text}\u0000${a.revisit_trigger}`, { ...a });
    return {
      data: {
        model_version: out.result.model_version,
        projections: out.result.projections.map((p) => projectionRow(p, full)),
        assumptions: [...hoisted.values()].slice(0, 40),
        inputs: out.result.inputs.slice(0, 25).map((i) => ({ ...i })),
      },
      inputs,
      warnings,
      bareFields: nameFields("data.projections[].name", targets),
      extraSources: ["engine"],
      estimate: true,
      listKey: "projections",
      week: w,
      onEmit: (emitted: {
        projections: readonly { player_key: string | null; gsis_id: string | null }[];
      }) => {
        const shown = new Set(
          emitted.projections.map(
            (p) => p.gsis_id ?? (p.player_key === null ? null : subjectOfKey.get(p.player_key)),
          ),
        );
        let busy = 0;
        for (const p of held)
          if (shown.has(subjectId(p.subject)) && !store.put(p).written) busy += 1;
        return busy > 0 ? [`${String(busy)} projections were not stored (store busy)`] : [];
      },
    };
  },
});

// --- shared: a team's lineup players ----------------------------------------------------------------------

/**
 * A team's projected lineup players for a week (unmatched / non-projectable players omitted), and
 * the starting seats those omitted players hold (`unscoredSeats`, one slot name per seat — QA-2-039).
 */
async function lineupPlayers(
  ctx: ToolContext,
  lc: LeagueContext,
  teamKey: string | undefined,
  w: Week,
  settings: ScoringSettings,
  rng: Rng,
  inputs: InputStamp[],
  warnings: string[],
): Promise<{
  players: LineupPlayer[];
  targets: Target[];
  out: ProjectionOutcome;
  rosterKeys: ReadonlySet<string>;
  unscoredSeats: string[];
}> {
  const rosterKeys = new Set<string>();
  const targets = (await rosterTargets(ctx, lc, teamKey, w, inputs, warnings, rosterKeys)).filter(
    projectable,
  );
  if (targets.length === 0) throw new FfError("NOT_FOUND");
  const out = projectPlayers({
    targets: projectionTargets(targets),
    season: lc.league.season,
    weeks: [w],
    settings,
    readers: readers(ctx),
    clock: ctx.services.clock,
    rng,
    n_sims: INTERNAL_SIMS,
  });
  const games = weekGames(ctx, lc.league.season, w).rows;
  const mode = lockModeOf(lc.league);
  const players = targets.map((t, i): LineupPlayer => {
    const p = out.players[i];
    const pw = p?.weeks.find((x) => x.week === w);
    if (p === undefined || pw === undefined) throw new FfError("INTERNAL");
    return {
      player_key: t.player_key ?? manualPlayerKeyFor(t.subject),
      name: t.name,
      positions: [t.position],
      status: t.platform?.status ?? null,
      nfl_team: t.nfl_team,
      gsis_id: t.subject.kind === "player" ? t.subject.gsis_id : null,
      slot: t.entry?.slot ?? "BN",
      lock_at: games.length === 0 ? null : lockAtFor(t.nfl_team, games, mode),
      points: pw.dist,
      p_active: pw.p_active,
      role_games: p.role_games,
    };
  });
  // a starter the projections omit still holds his seat: it is not empty (QA-2-039)
  const projected = new Set(players.map((p) => p.player_key));
  const roster = await ctx.services.platform.getRoster(teamOf(lc, teamKey), w);
  const unscoredSeats = roster.value.entries
    .filter(
      (e) =>
        (e.slot_class === "starter" || e.slot_class === "flex") && !projected.has(e.player.ref.id),
    )
    .map((e) => e.slot);
  return { players, targets, out, rosterKeys, unscoredSeats };
}

/** The opponent's team key for `w`, or null when the platform lists no matchup for my team. */
async function opponentKey(
  ctx: ToolContext,
  lc: LeagueContext,
  mine: string,
  w: Week,
  inputs: InputStamp[],
): Promise<string | null> {
  const got = await ctx.services.platform.getMatchups(lc.ref, w);
  inputs.push(platformInput(got.stamp, ctx.nowMs, lc.allowStale));
  for (const m of got.value) {
    const [a, b] = m.teams;
    if (a.team.team_key === mine) return b.team.team_key;
    if (b.team.team_key === mine) return a.team.team_key;
  }
  return null;
}

/**
 * The opponent's lineup players: `key` null when the platform lists no matchup for the week (no
 * `opponents:` entry under the manual league), `side` null when there is none or the opponent's team
 * has no projectable players listed — the two causes a "no opponent" answer must tell apart.
 */
async function opponentPlayers(
  ctx: ToolContext,
  lc: LeagueContext,
  mine: string,
  w: Week,
  settings: ScoringSettings,
  rng: Rng,
  inputs: InputStamp[],
  warnings: string[],
): Promise<{
  key: string | null;
  side: { players: LineupPlayer[]; targets: Target[] } | null;
}> {
  const key = await opponentKey(ctx, lc, mine, w, inputs);
  if (key === null) return { key, side: null };
  try {
    const r = await lineupPlayers(ctx, lc, key, w, settings, rng, inputs, warnings);
    return { key, side: { players: r.players, targets: r.targets } };
  } catch (e) {
    if (e instanceof FfError && e.code === "NOT_FOUND") return { key, side: null };
    throw e;
  }
}

// --- E2 ff_analyze_lineup ----------------------------------------------------------------------------------

const assignment = z.strictObject({
  slot: slotName,
  player_key: playerKey,
  name: bareName,
  points: dist,
  lock_at: iso.nullable(),
});
const interval = z.tuple([z.number(), z.number()]);
const coarse = z.strictObject({
  sign: z.enum(["+", "-", "0"]),
  band: z.enum(["small", "medium", "large"]),
});

/** current_lineup: the seats (full adds name + lock_at; the Dists are in recommended_lineup / E1). */
const currentSeat = z.strictObject({
  slot: slotName,
  player_key: playerKey,
  name: bareName.optional(),
  lock_at: iso.nullable().optional(),
});

const swapRow = z.strictObject({
  /** Null for a fill of an empty starting seat (QA-1-020, QA-1-040). */
  out: playerKey.nullable(),
  in: playerKey,
  slot: slotName,
  delta_e: z.number(),
  delta_pwin: z.union([z.number(), coarse]),
  interval,
  coin_flip: z.boolean(),
  option_value: z
    .strictObject({
      kind: z.enum(["thursday", "monday", "late_game"]),
      value: z.number(),
      verdict: serverText,
    })
    .nullable(),
});

const e2Data = z.strictObject({
  objective_used: z.enum(["mean", "pwin", "blend"]),
  dist_basis: z.enum(["position_cv", "player_sim"]),
  current_lineup: z.array(currentSeat).max(MAX_ROSTER_SIZE),
  recommended_lineup: z.array(assignment).max(MAX_ROSTER_SIZE),
  mode: z.enum(["protect", "chase", "neutral"]),
  mode_basis: z.strictObject({
    mu_m: z.number(),
    mu_o: z.number(),
    sigma_m: z.number(),
    sigma_o: z.number(),
    rho_lineup: z.number(),
  }),
  p_win_before: prob.nullable(),
  p_win_after: prob.nullable(),
  p_win_interval: interval.nullable(),
  swaps: z.array(swapRow).max(30),
  /** The caller's `compare` pairs that are not recommended swaps (QA-1-010), apart from `swaps`. */
  comparisons: z.array(swapRow).max(BOUNDS.compareSwaps.max).optional(),
  conditionals: z
    .array(
      z.strictObject({
        if: z.strictObject({
          player_key: playerKey,
          event: z.literal("inactive"),
          decided_by: iso,
        }),
        then: z.strictObject({ slot: slotName, in: playerKey }),
      }),
    )
    .max(30),
  stack_flags: z
    .array(
      z.strictObject({
        players: z.array(playerKey).max(10),
        effect: z.enum(["ceiling+", "floor-"]),
      }),
    )
    .max(30),
  lock_schedule: z
    .array(z.strictObject({ lock_at: iso, player_keys: z.array(playerKey).max(60) }))
    .max(60),
  latest_execution_time: iso.nullable(),
  no_move: z.boolean(),
  rec: recSchema,
  inputs: inputsSchema,
});

const assignmentRow = (a: {
  slot: string;
  player_key: string;
  name: string;
  points: z.infer<typeof dist>;
  lock_at: string | null;
}) => ({ ...a, name: bareUntrusted(a.name, "player_name") });

const recRow = (r: Rec): z.infer<typeof recSchema> =>
  JSON.parse(JSON.stringify({ ...r, log_id: null })) as z.infer<typeof recSchema>;

type E2Data = z.infer<typeof e2Data>;

/**
 * Splits the engine's swaps into the advice and the caller's comparisons (QA-1-010). The engine
 * lists the recommended pairs first — `rec.drivers` has one per recommended pair — then each
 * `compare` pair that is not already one of them. A trailing row that matches no `compare` pair
 * stays in `swaps`: a recommended swap is never hidden among the comparisons.
 */
export function splitComparisons<S extends { readonly out: string | null; readonly in: string }>(
  rows: readonly S[],
  recommended: number,
  compare: readonly { readonly out: string; readonly in: string }[] | undefined,
): { swaps: S[]; comparisons?: S[] } {
  if (compare === undefined) return { swaps: [...rows] };
  const asked = (r: S): boolean => compare.some((c) => c.out === r.out && c.in === r.in);
  const head = rows.slice(0, recommended);
  const tail = rows.slice(recommended);
  return {
    swaps: [...head, ...tail.filter((r) => !asked(r))],
    comparisons: tail.filter(asked),
  };
}

/** The hint every refused E2 constraint carries (QA-1-010). */
export const LINEUP_CONSTRAINT_HINT =
  "Use player keys from ff_get_roster for the team analysed; never force_start and exclude the same player; force_start only players who can start together (not on IR, game not started); compare a current starter (out) with a player eligible for his slot (in).";

/**
 * Refuses, visibly, any E2 constraint the engine could not honour (QA-1-010; plan 02 §5): a key not
 * on the target roster (or on it but not projectable), a player both forced and excluded, a forced
 * start the lineup cannot seat (on IR, a reserve whose game has started, or forced players and the
 * locked starters too many for their seats — QA-1-010 reopened), and a `compare` whose `out` is not a
 * current starter or whose `in` cannot play that slot.
 */
function checkConstraints(
  args: {
    readonly force_start?: readonly string[] | undefined;
    readonly exclude?: readonly string[] | undefined;
    readonly compare?: readonly { readonly out: string; readonly in: string }[] | undefined;
  },
  pool: readonly LineupPlayer[],
  rosterKeys: ReadonlySet<string>,
  slots: RosterSlots,
  nowMs: number,
): void {
  const byKey = new Map(pool.map((p) => [p.player_key, p]));
  const refuse = (field: string, reason: string): never => {
    throw new FfError("VALIDATION", { field, reason, hint: LINEUP_CONSTRAINT_HINT });
  };
  const known = (field: string, key: string): LineupPlayer => {
    const p = byKey.get(key);
    if (p !== undefined) return p;
    return refuse(field, rosterKeys.has(key) ? "not_projectable" : "not_on_target_roster");
  };
  (args.force_start ?? []).forEach((k, i) => known(`force_start[${String(i)}]`, k));
  (args.exclude ?? []).forEach((k, i) => known(`exclude[${String(i)}]`, k));
  const excluded = new Set(args.exclude ?? []);
  (args.force_start ?? []).forEach((k, i) => {
    if (excluded.has(k)) refuse(`force_start[${String(i)}]`, "also_excluded");
  });
  // a forced start must be one the lineup can make: the engine keeps IR and never moves a locked
  // player, and the forced players share the seats the locked starters leave (QA-1-010 reopened)
  const lockedStarter = (p: LineupPlayer): boolean =>
    isLocked(p.lock_at, nowMs) && isStartingSlot(slots, p.slot);
  const forced = [...new Set(args.force_start ?? [])].map((k) => byKey.get(k));
  (args.force_start ?? []).forEach((k, i) => {
    const p = byKey.get(k);
    if (p === undefined) return;
    if (slotByName(slots, p.slot)?.class === "ir") refuse(`force_start[${String(i)}]`, "on_ir");
    if (isLocked(p.lock_at, nowMs) && !lockedStarter(p))
      refuse(`force_start[${String(i)}]`, "locked");
  });
  const toSeat = forced.filter((p): p is LineupPlayer => p !== undefined && !lockedStarter(p));
  if (!seatsAll(slots, toSeat, pool.filter(lockedStarter)))
    refuse("force_start", "cannot_seat_together");
  (args.compare ?? []).forEach((c, i) => {
    const at = `compare[${String(i)}]`;
    const o = known(`${at}.out`, c.out);
    const n = known(`${at}.in`, c.in);
    if (c.out === c.in) refuse(`${at}.in`, "same_player");
    if (!isStartingSlot(slots, o.slot)) refuse(`${at}.out`, "not_a_starter");
    if (isStartingSlot(slots, n.slot)) refuse(`${at}.in`, "already_starting");
    // the engine evaluates "start `in` instead of `out`" as a lineup: it must be a legal one
    const after = [...pool.filter((p) => isStartingSlot(slots, p.slot) && p !== o), n];
    if (!seatsAll(slots, after)) refuse(`${at}.in`, "ineligible_for_slot");
  });
}

/**
 * Whether every player in `players` can hold a distinct starting seat of `slots` (bipartite
 * matching by augmenting paths — a roster is ≤ 60 players, a lineup ≤ 20 × 20 seats), with the
 * seats of `reserved` (locked starters, who keep theirs) taken first.
 */
function seatsAll(
  slots: RosterSlots,
  players: readonly LineupPlayer[],
  reserved: readonly LineupPlayer[] = [],
): boolean {
  const seats = slots.slots
    .filter((x) => x.class === "starter" || x.class === "flex")
    .flatMap((x) => Array.from({ length: x.count }, () => x));
  for (const r of reserved) {
    const i = seats.findIndex((x) => x.name === r.slot);
    if (i >= 0) seats.splice(i, 1);
  }
  if (players.length > seats.length) return false;
  const holder = new Array<number>(seats.length).fill(-1);
  const fits = (pi: number, si: number): boolean => {
    const p = players[pi];
    const seat = seats[si];
    return (
      p !== undefined &&
      seat !== undefined &&
      canOccupy(seat, { positions: p.positions, status: p.status })
    );
  };
  const place = (pi: number, seen: boolean[]): boolean => {
    for (let si = 0; si < seats.length; si++) {
      if (seen[si] === true || !fits(pi, si)) continue;
      seen[si] = true;
      const h = holder[si] ?? -1;
      if (h < 0 || place(h, seen)) {
        holder[si] = pi;
        return true;
      }
    }
    return false;
  };
  return players.every((_, pi) => place(pi, new Array<boolean>(seats.length).fill(false)));
}

/** Whether `slot` is a starting (starter or flex) slot of this league. */
function isStartingSlot(slots: RosterSlots, slot: string): boolean {
  const c = slotByName(slots, slot)?.class;
  return c === "starter" || c === "flex";
}

/**
 * The reserves the advice needs shown: every swap's incoming player and every conditional's
 * players (a swapped-OUT player's projection is summarised by the swap's delta_e and interval).
 */
function involvedKeys(d: E2Data, withOut: boolean): Set<string> {
  const out = new Set<string>();
  for (const s of d.swaps) {
    out.add(s.in);
    if (withOut && s.out !== null) out.add(s.out);
  }
  for (const c of d.conditionals) out.add(c.if.player_key).add(c.then.in);
  for (const c of d.comparisons ?? []) out.add(c.in);
  return out;
}

/** Removes the last row of `rows` that `keep` does not protect, or null when none is left. */
function dropLastReserve<T extends { slot: string; player_key: string }>(
  rows: readonly T[],
  keep: (r: T) => boolean,
): T[] | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r !== undefined && !keep(r)) return [...rows.slice(0, i), ...rows.slice(i + 1)];
  }
  return null;
}

/**
 * E2's budget steps (plan 07 C8; QA-1-001/073/080), cheapest information first, so that a
 * schema-legal roster (≤ 60 players) always fits 10 000 chars WITHOUT cutting `swaps` — the advice
 * `rec.action` counts. (1) full-detail seat names/locks (both are in recommended_lineup); (2)
 * reserve rows of recommended_lineup, from the end; (3) reserve seats of current_lineup; (4)
 * lock_schedule keys of players no longer shown. Starters and every player a swap or conditional
 * names are never cut. Each warning states the cumulative cut.
 */
function lineupTrims(slots: RosterSlots, original: E2Data): BudgetTrim[] {
  const cut = `cut to fit the ${String(ANALYTICS_BUDGET_CHARS)}-character budget`;
  const keep = (d: E2Data, withOut: boolean) => {
    const inv = involvedKeys(d, withOut);
    return (r: { slot: string; player_key: string }): boolean =>
      isStartingSlot(slots, r.slot) || inv.has(r.player_key);
  };
  const recCut = (d: E2Data, withOut: boolean) => {
    const rows = dropLastReserve(d.recommended_lineup, keep(d, withOut));
    if (rows === null) return null;
    return {
      data: { ...d, recommended_lineup: rows },
      warning: `recommended_lineup ${cut}: ${String(rows.length)} of ${String(original.recommended_lineup.length)} rows (starters, swap-ins, conditionals); other projections: ff_project_players`,
      key: "recommended_lineup",
    };
  };
  return [
    (raw) => {
      const d = raw as E2Data;
      if (d.current_lineup.every((r) => r.name === undefined && r.lock_at === undefined))
        return null;
      return {
        data: {
          ...d,
          current_lineup: d.current_lineup.map((r) => ({ slot: r.slot, player_key: r.player_key })),
        },
        warning: `current_lineup names and lock times ${cut} (both are in recommended_lineup)`,
        key: "current_lineup",
        dropPaths: ["data.current_lineup[].name"],
      };
    },
    (raw) => recCut(raw as E2Data, true),
    (raw) => {
      const d = raw as E2Data;
      const rows = dropLastReserve(d.current_lineup, (r) => isStartingSlot(slots, r.slot));
      if (rows === null) return null;
      return {
        data: { ...d, current_lineup: rows },
        warning: `current_lineup ${cut}: its ${String(rows.length)} starting seats of ${String(original.current_lineup.length)}`,
        key: "current_lineup",
      };
    },
    // a swapped-out starter's row: the swap already carries his delta and interval
    (raw) => recCut(raw as E2Data, false),
    (raw) => {
      const d = raw as E2Data;
      if (d.lock_schedule.length === 0) return null;
      const shown = new Set(d.recommended_lineup.map((r) => r.player_key));
      const locks = d.lock_schedule
        .map((l) => ({ ...l, player_keys: l.player_keys.filter((k) => shown.has(k)) }))
        .filter((l) => l.player_keys.length > 0);
      const limited = locks.reduce((n, l) => n + l.player_keys.length, 0);
      const before = d.lock_schedule.reduce((n, l) => n + l.player_keys.length, 0);
      return limited < before
        ? {
            data: { ...d, lock_schedule: locks },
            warning: `lock_schedule ${cut}: the players shown in recommended_lineup only`,
          }
        : {
            data: { ...d, lock_schedule: [] },
            warning: `lock_schedule ${cut}: each shown player's lock_at is in recommended_lineup`,
          };
    },
    (raw) => {
      const d = raw as E2Data;
      if (d.current_lineup.length === 0) return null;
      return {
        data: { ...d, current_lineup: [] },
        warning: `current_lineup ${cut}: the current starters are recommended_lineup's with every swap reversed`,
        key: "current_lineup",
        dropPaths: ["data.current_lineup[].name"],
      };
    },
  ];
}

export const analyzeLineupTool = defineTool({
  name: "ff_analyze_lineup",
  family: "analytics",
  description:
    "Start/sit as an assignment (objective mean by default): recommended lineup, swaps, coin flips, conditionals, locks, rec.",
  input: z.strictObject({
    ...leagueShape,
    team_key: teamKeySchema.optional(),
    week: weekSchema.optional(),
    objective: z.enum(["mean", "pwin", "blend"]).default("mean"),
    blend_weight: z.number().min(BOUNDS.blendWeight.min).max(BOUNDS.blendWeight.max).optional(),
    only_unlocked: z.boolean().default(false),
    exclude: playerKeysSchema.optional(),
    force_start: playerKeysSchema.optional(),
    compare: z
      .array(z.strictObject({ out: playerKeySchema, in: playerKeySchema }))
      .max(BOUNDS.compareSwaps.max)
      .optional(),
    ...detailShape,
    ...analyticsFreshnessShape,
  }),
  data: e2Data,
  budget: "analytics",
  run: async (args, ctx) => {
    const lc = await leagueContext(ctx, args);
    const warnings: string[] = [];
    const inputs: InputStamp[] = [lc.input];
    const w = weekOf(lc, args.week);
    inputs.push(...datasetGate(ctx, lc, [w]));
    const settings = await scoringOf(ctx, lc, inputs);
    const slots = await slotsOf(ctx, lc, inputs);
    const myKey = teamOf(lc, args.team_key).team_key;
    const rng = rngFor(
      ctx,
      callSeed("ff_analyze_lineup", { league: lc.ref.league_key, team: myKey, week: w }, inputs),
    );
    const mine = await lineupPlayers(ctx, lc, args.team_key, w, settings, rng, inputs, warnings);
    checkConstraints(args, mine.players, mine.rosterKeys, slots, ctx.nowMs);
    // a points-only league has no opponent to read (QA-2-043): the engine forces objective mean
    const h2h = isHeadToHead(lc.league.scoring_type);
    const opp = h2h
      ? (await opponentPlayers(ctx, lc, myKey, w, settings, rng, inputs, warnings)).side
      : null;
    if (mine.out.lines_omitted) warnings.push(LINES_OMITTED_WARNING);
    const rec = analyzeLineup({
      slots,
      players: mine.players,
      opponent: opp?.players ?? null,
      head_to_head: h2h,
      unscored_seats: mine.unscoredSeats,
      objective: args.objective,
      ...(args.blend_weight === undefined ? {} : { blend_weight: args.blend_weight }),
      only_unlocked: args.only_unlocked,
      ...(args.exclude === undefined ? {} : { exclude: args.exclude }),
      ...(args.force_start === undefined ? {} : { force_start: args.force_start }),
      ...(args.compare === undefined ? {} : { compare: args.compare }),
      clock: ctx.services.clock,
      inputs: mine.out.result.inputs,
      // a fill of an empty starting seat is listed as { out: null, in, slot } (QA-1-020, QA-1-040)
      fills_in_swaps: true,
    });
    const swapRows = rec.swaps.map((s) => ({
      ...s,
      interval: [s.interval[0], s.interval[1]] as [number, number],
    }));
    const data = {
      ...rec,
      // the seats only: every starter's Dist is in recommended_lineup (and E1), so repeating
      // them here would push a 16-man roster past the 10 000-char budget (plan 07 C8)
      current_lineup:
        args.detail === "full"
          ? rec.current_lineup.map((a) => ({
              slot: a.slot,
              player_key: a.player_key,
              name: bareUntrusted(a.name, "player_name"),
              lock_at: a.lock_at,
            }))
          : rec.current_lineup.map((a) => ({ slot: a.slot, player_key: a.player_key })),
      recommended_lineup: rec.recommended_lineup.map(assignmentRow),
      ...splitComparisons(swapRows, rec.rec.drivers.length, args.compare),
      p_win_interval:
        rec.p_win_interval === null
          ? null
          : ([rec.p_win_interval[0], rec.p_win_interval[1]] as [number, number]),
      rec: recRow(rec.rec),
      inputs: rec.inputs.slice(0, 25).map((i) => ({ ...i })),
    };
    const out = JSON.parse(JSON.stringify(data)) as E2Data;
    return {
      data: out,
      inputs,
      warnings,
      bareFields: [
        ...(args.detail === "full" ? nameFields("data.current_lineup[].name", mine.targets) : []),
        ...nameFields("data.recommended_lineup[].name", mine.targets),
      ],
      extraSources: ["engine"],
      estimate: true,
      trims: lineupTrims(slots, out),
      listKey: "swaps",
      week: w,
    };
  },
});

// --- E3 ff_analyze_matchup -----------------------------------------------------------------------------------

const e3Data = z.strictObject({
  p_win: prob,
  interval,
  mu_m: z.number(),
  sigma_m: z.number(),
  mu_o: z.number(),
  sigma_o: z.number(),
  cov: z.number(),
  method: z.enum(["normal", "mc"]),
  live: z.null(),
  yahoo_cross_check: z
    .strictObject({
      win_probability: prob.nullable(),
      team_projected_points: z.strictObject({
        me: z.number().nullable(),
        opp: z.number().nullable(),
      }),
    })
    .nullable(),
  actionable_slots: z.array(z.strictObject({ slot: slotName, lock_at: iso.nullable() })).max(30),
  season: z.null(),
  rec: recSchema,
  inputs: inputsSchema,
});

/**
 * E3's NOT_FOUND hint for a week without an `opponents:` entry (QA-1-008, QA-1-028): the shared
 * manual hint says "use objective mean", an argument only E2 has; this one names what E3's caller
 * can do. It never claims the opponent's roster is missing — it is usually in the file already, and
 * the one missing line is the week's entry (QA-1-069).
 */
export const MATCHUP_NO_OPPONENT_HINT =
  "No opponent for this week in league.yaml: add - { week: <week>, team: <id> } under opponents (that team's players go under other_teams if they are not listed yet), pass a week that has one, or use ff_analyze_lineup (objective mean) for start/sit.";

/** E3's NOT_FOUND hint in a league without head-to-head matchups (QA-2-043). */
export const MATCHUP_NOT_HEAD_TO_HEAD_HINT =
  "This league has no head-to-head matchups (its scoring_type is not head-to-head), so there is no win probability; use ff_analyze_lineup for start/sit.";

/**
 * Whether a league's `scoring_type` plays head-to-head matchups (`head`, `headpoint`, `headone`);
 * points-only (`point`) and `roto` leagues have no opponent to beat (plan 07 E2; QA-2-043).
 */
export function isHeadToHead(scoringType: string): boolean {
  return scoringType.startsWith("head");
}

/** E3's NOT_FOUND hint when the week's `opponents:` entry names a team with no players (QA-1-069). */
export const MATCHUP_OPPONENT_NO_PLAYERS_HINT =
  "This week's opponent in league.yaml has no players listed: add that team's players under other_teams, pass a week whose opponent has them, or use ff_analyze_lineup (objective mean) for start/sit.";

export const analyzeMatchupTool = defineTool({
  name: "ff_analyze_matchup",
  family: "analytics",
  description:
    "Pre-game head-to-head win probability with interval, both teams' means and spreads, unlocked actionable slots, rec.",
  input: z.strictObject({
    ...leagueShape,
    team_key: teamKeySchema.optional(),
    week: weekSchema.optional(),
    mode: z.enum(["pre", "live", "season"]).default("pre"),
    method: z.enum(["normal", "mc"]).default("mc"),
    n_sims: z.number().int().min(BOUNDS.nSims.min).max(BOUNDS.nSims.max).optional(),
    ...analyticsFreshnessShape,
  }),
  data: e3Data,
  budget: "analytics",
  run: async (args, ctx) => {
    if (args.mode !== "pre")
      throw new FfError("VALIDATION", { field: "mode", reason: "not_available" });
    const lc = await leagueContext(ctx, args);
    // P(win) means nothing without head-to-head matchups, whatever opponent the file lists (QA-2-043)
    if (!isHeadToHead(lc.league.scoring_type))
      throw new FfError("NOT_FOUND", { hint: MATCHUP_NOT_HEAD_TO_HEAD_HINT });
    const warnings: string[] = [];
    const inputs: InputStamp[] = [lc.input];
    const w = weekOf(lc, args.week);
    inputs.push(...datasetGate(ctx, lc, [w]));
    const settings = await scoringOf(ctx, lc, inputs);
    const slots = await slotsOf(ctx, lc, inputs);
    const myKey = teamOf(lc, args.team_key).team_key;
    const rng = rngFor(
      ctx,
      callSeed("ff_analyze_matchup", { league: lc.ref.league_key, team: myKey, week: w }, inputs),
    );
    const mine = await lineupPlayers(ctx, lc, args.team_key, w, settings, rng, inputs, warnings);
    const found = await opponentPlayers(ctx, lc, myKey, w, settings, rng, inputs, warnings);
    const opp = found.side;
    if (opp === null || opp.players.length === 0)
      throw new FfError("NOT_FOUND", {
        hint: found.key === null ? MATCHUP_NO_OPPONENT_HINT : MATCHUP_OPPONENT_NO_PLAYERS_HINT,
      });
    if (mine.out.lines_omitted) warnings.push(LINES_OMITTED_WARNING);
    const r = analyzeMatchupPre({
      slots,
      players: mine.players,
      opponent: opp.players,
      method: args.method,
      ...(args.n_sims === undefined ? {} : { n_sims: args.n_sims }),
      clock: ctx.services.clock,
      rng: rng.fork("matchup"),
      inputs: mine.out.result.inputs,
      yahoo_cross_check: null,
    });
    const data = {
      ...r,
      interval: [r.interval[0], r.interval[1]] as [number, number],
      live: null,
      season: null,
      actionable_slots: r.actionable_slots.map((a) => ({ ...a })),
      rec: recRow(r.rec),
      inputs: r.inputs.slice(0, 25).map((i) => ({ ...i })),
    };
    return {
      data: JSON.parse(JSON.stringify(data)) as z.infer<typeof e3Data>,
      inputs,
      warnings,
      extraSources: ["engine"],
      estimate: true,
      provisional: false,
      week: w,
    };
  },
});

// --- E5 ff_analyze_waivers (K/DEF in P0) ----------------------------------------------------------------------

const subjectOut = z.union([
  z.strictObject({ kind: z.literal("player"), gsis_id: gsisId }),
  z.strictObject({ kind: z.literal("defense"), nfl_team: nflTeam }),
]);

const e5Candidate = z.strictObject({
  player_key: playerKey,
  subject: subjectOut.optional(),
  gsis_id: gsisId.nullable(),
  nfl_team: nflTeam.nullable(),
  name: bareName,
  position,
  availability: z.enum(["FA", "W", "T", "unknown"]),
  signals: z
    .array(
      z.strictObject({
        kind: z.enum([
          "injury_cascade",
          "snap_jump",
          "target_share_jump",
          "xfp_gap",
          "rz_shift",
          "depth_chart",
          "implied_total",
          "stream",
        ]),
        value: z.number(),
        evidence: z.number().nullable().optional(),
      }),
    )
    .max(20),
  weeks_of_value: z.number().nullable(),
  p_role_holds: z
    .array(z.strictObject({ week, p: prob }))
    .max(18)
    .optional(),
  marginal_value: dist,
  xfp_gap: z.number().nullable().optional(),
  competition: z.null().optional(),
  bid: z.null().optional(),
  claim_or_wait: z
    .strictObject({ verdict: z.enum(["claim", "wait"]), option_value: z.number() })
    .nullable()
    .optional(),
  drop: z.null().optional(),
  invalidators: z
    .array(z.string().regex(/^[a-z_]{1,48}$/))
    .max(20)
    .optional(),
  kdef: z
    .strictObject({
      implied_total: z.number().nullable(),
      opp_implied_total: z.number().nullable(),
      brackets_e: z.number().nullable(),
      sacks_e: z.number().nullable(),
      takeaways_e: z.number().nullable(),
      rare_c: z.number().nullable(),
      next_week: z
        .strictObject({
          opponent: z
            .string()
            .regex(/^[A-Z]{2,3}$/)
            .nullable(),
          implied_total: z.number().nullable(),
          e: z.number().nullable(),
        })
        .nullable(),
    })
    .nullable(),
});

const e5Data = z.strictObject({
  candidates: z.array(e5Candidate).max(96),
  /** compact: the candidates' shared invalidators, once (fixed vocabulary). */
  invalidators: z.array(z.string().regex(/^[a-z_]{1,48}$/)).max(40),
  /** `position`: the position these numbers describe, which may not be rec's (QA-2-004). */
  hold_vs_stream: z
    .strictObject({ position, streamability: z.number(), current_starter_delta: z.number() })
    .nullable(),
  waiver_clearing_time: iso.nullable(),
  rec: recSchema,
  inputs: inputsSchema,
});

/** The K/DEF universe: all 32 defences + every kicker on the season's weekly rosters. */
/**
 * How many E5 candidates a result carries, over all requested positions (plan 07 E5 "10 candidates
 * compact"; full: ~1.25 k chars each, so 6 stay inside C8's 10 000 by construction, not by halving).
 */
export const E5_CANDIDATES_OUT = Object.freeze({ compact: 10, full: 6 });

/**
 * The engine's per-position ranking cut to an even share of E5_CANDIDATES_OUT and interleaved by
 * rank (K1, DEF1, K2, DEF2, …), so the result fits the budget and any prefix C8's halving keeps
 * still holds every position: with the full K universe, K then DEF blocks of 10 were halved to ten
 * kickers and no defence at all (A8: ≥ 3 per position).
 */
export function balancedCandidates<C extends { readonly position: string }>(
  ranked: readonly C[],
  full: boolean,
): C[] {
  const byPos = new Map<string, C[]>();
  for (const c of ranked) byPos.set(c.position, [...(byPos.get(c.position) ?? []), c]);
  const share = Math.max(
    1,
    Math.floor(
      (full ? E5_CANDIDATES_OUT.full : E5_CANDIDATES_OUT.compact) / Math.max(1, byPos.size),
    ),
  );
  const lists = [...byPos.values()].map((l) => l.slice(0, share));
  const out: C[] = [];
  for (let i = 0; i < share; i += 1)
    for (const l of lists) {
      const c = l[i];
      if (c !== undefined) out.push(c);
    }
  return out;
}

/** A projection subject's identity (a gsis id, or `def:<team>`). */
function subjectId(s: KdefCandidateInput["subject"]): string {
  return s.kind === "player" ? s.gsis_id : `def:${s.nfl_team}`;
}

function kdefUniverse(
  ctx: ToolContext,
  lc: LeagueContext,
  inputs: InputStamp[],
): KdefCandidateInput[] {
  const rr = rosterRows(ctx, lc.league.season);
  const rIn = requiredSource(ctx, "nflverse:roster_weekly", rr, lc.allowStale);
  if (rIn !== null) inputs.push(rIn);
  const defs: KdefCandidateInput[] = NFL_TEAMS.map((t) => ({
    player_key: manualPlayerKeyFor({ kind: "defense", nfl_team: t }),
    subject: { kind: "defense" as const, nfl_team: t },
    name: t,
    position: "DEF" as const,
    nfl_team: t,
    availability: "unknown" as const,
  }));
  // "every team's kicker" (plan 07 E5): a kicker whose newest row is on an active roster (ACT);
  // a cut (CUT) or practice-squad (DEV) kicker does not kick for that team this week
  const kickers: KdefCandidateInput[] = rr.rows
    .filter((r) => r.position === "K" && r.status === ACTIVE_ROSTER_STATUS)
    .map((r) => ({
      player_key: manualPlayerKeyFor({ kind: "player", gsis_id: r.gsis_id }),
      subject: { kind: "player" as const, gsis_id: r.gsis_id },
      name: r.full_name,
      position: "K" as const,
      nfl_team: r.team,
      availability: "unknown" as const,
    }));
  return [...defs, ...kickers];
}

export const analyzeWaiversTool = defineTool({
  name: "ff_analyze_waivers",
  family: "analytics",
  description:
    "K/DEF streaming ranking (positions K and DEF only): implied totals, bracket expectations, look-ahead, hold vs stream, rec.",
  input: z.strictObject({
    ...leagueShape,
    team_key: teamKeySchema.optional(),
    positions: z
      .array(z.string().regex(/^[A-Z]{1,4}$/))
      .min(1)
      .max(8)
      .default(["K", "DEF"]),
    candidates: playerKeysSchema.optional(),
    horizon_weeks: z
      .number()
      .int()
      .min(BOUNDS.horizonWeeks.min)
      .max(BOUNDS.horizonWeeks.max)
      .optional(),
    look_ahead: lookAheadSchema.optional(),
    adds_remaining: addsRemainingSchema.optional(),
    faab_budget: faabBudgetSchema.optional(),
    reserve: z.enum(["none", "playoff_reserve"]).default("none"),
    include_drop: z.boolean().default(true),
    ...detailShape,
    ...analyticsFreshnessShape,
  }),
  data: e5Data,
  budget: "analytics",
  run: async (args, ctx) => {
    if (args.positions.some((p) => p !== "K" && p !== "DEF"))
      throw new FfError("VALIDATION", { field: "positions", reason: "not_available" });
    const lc = await leagueContext(ctx, args);
    const warnings: string[] = [];
    const inputs: InputStamp[] = [lc.input];
    const w = lc.league.current_week;
    const lookAhead = args.look_ahead ?? BOUNDS.lookAheadKdefDefault;
    const weeks = Array.from({ length: lookAhead + 1 }, (_, i) => w + i).filter((x) => x <= 22);
    inputs.push(...datasetGate(ctx, lc, weeks));
    const settings = await scoringOf(ctx, lc, inputs);
    let universe = kdefUniverse(ctx, lc, inputs);
    if (args.candidates !== undefined) {
      const want = new Set(args.candidates);
      universe = universe.filter((c) => want.has(c.player_key));
      if (universe.length === 0) throw new FfError("NOT_FOUND");
    }
    const mineTargets = await rosterTargets(ctx, lc, args.team_key, w, inputs, warnings);
    const current: KdefCandidateInput[] = mineTargets.flatMap((t) =>
      (t.position === "K" || t.position === "DEF") && t.nfl_team !== null
        ? [
            {
              player_key: t.player_key ?? manualPlayerKeyFor(t.subject),
              subject: t.subject,
              name: t.name,
              position: t.position === "K" ? ("K" as const) : ("DEF" as const),
              nfl_team: t.nfl_team,
              availability: "T" as const,
            },
          ]
        : [],
    );
    // a rostered K/DEF entered by name only has a name-hash key, yet resolves to the same subject as
    // its universe row: never list my own starter as a streaming candidate (QA-1-041 follow-up)
    const mineSubjects = new Set(current.map((c) => subjectId(c.subject)));
    universe = universe.filter((c) => !mineSubjects.has(subjectId(c.subject)));
    const caps = await ctx.services.platform.capabilities();
    const myKey = teamOf(lc, args.team_key).team_key;
    const out = analyzeKdef({
      positions: args.positions,
      season: lc.league.season,
      week: w,
      look_ahead: weeks.length - 1,
      // a weekly-lock league locks every K/DEF at the week's first kickoff (QA-1-022)
      lock_mode: lockModeOf(lc.league),
      universe,
      current,
      availability_known: caps.read_features.free_agent_pool,
      settings,
      readers: readers(ctx),
      clock: ctx.services.clock,
      rng: rngFor(
        ctx,
        callSeed("ff_analyze_waivers", { league: lc.ref.league_key, team: myKey, week: w }, inputs),
      ),
    });
    if (!out.availability_known) warnings.push(MANUAL_FA_POOL_WARNING);
    const a = out.analysis;
    const full = args.detail === "full";
    const candidates = balancedCandidates(a.candidates, full).map((c) => ({
      player_key: c.player_key,
      ...(full ? { subject: c.subject } : {}),
      gsis_id: c.gsis_id,
      nfl_team: c.nfl_team,
      name: bareUntrusted(c.name, "player_name"),
      position: c.position,
      availability: c.availability,
      signals: c.signals.map((s) => ({
        kind: s.kind,
        value: s.value,
        ...(full ? { evidence: typeof s.evidence === "number" ? s.evidence : null } : {}),
      })),
      weeks_of_value: c.weeks_of_value,
      ...(full || c.p_role_holds.length > 0
        ? { p_role_holds: c.p_role_holds.map((p) => ({ ...p })) }
        : {}),
      marginal_value: c.marginal_value,
      ...(full || c.xfp_gap !== null ? { xfp_gap: c.xfp_gap } : {}),
      ...(full ? { competition: null, bid: null, drop: null } : {}),
      ...(full || c.claim_or_wait !== null ? { claim_or_wait: c.claim_or_wait } : {}),
      ...(full ? { invalidators: [...c.invalidators] } : {}),
      kdef: c.kdef,
    }));
    const data = {
      candidates,
      invalidators: [...new Set(a.candidates.flatMap((c) => c.invalidators))].slice(0, 40),
      hold_vs_stream: a.hold_vs_stream,
      waiver_clearing_time: a.waiver_clearing_time,
      rec: recRow(a.rec),
      inputs: a.inputs.slice(0, 25).map((i) => ({ ...i })),
    };
    return {
      data: JSON.parse(JSON.stringify(data)) as z.infer<typeof e5Data>,
      inputs,
      warnings,
      bareFields: [bare("data.candidates[].name", "nflverse.roster_weekly.name")],
      extraSources: ["engine"],
      estimate: true,
      listKey: "candidates",
      week: w,
    };
  },
});
