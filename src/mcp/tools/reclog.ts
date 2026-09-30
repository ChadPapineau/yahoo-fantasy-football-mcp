// reclog.ts — the recommendation log tools (plan 07 E12–E14): E12 ff_record_recommendation (the
// local write; STORE_BUSY on a busy required write — plan 01 §4.3), E13 ff_analyze_retrospective
// (score a week's logged calls; the metrics that reach n first — C12/OBJ-05), E14
// ff_list_recommendations (a C10 list tool). Every read-back of model-authored text is bare and
// path-listed with source `store.recommendation_log` (OBJ-15; RECLOG_TEXT_PATHS).
import { z } from "zod/v4";
import type { NflTeam } from "../../config/schema.js";
import type { InputFreshness, RecSubject } from "../../domain/analytics/types.js";
import { lockAtFor } from "../../domain/league/schedule.js";
import { manualPlayerKeyFor, type Week } from "../../domain/league/types.js";
import { validateRecordInput } from "../../domain/reclog/record.js";
import {
  buildRetrospective,
  type PlayerForecast,
  type RosterPresence,
  type SubjectPoints,
} from "../../domain/reclog/retrospective.js";
import {
  DEFAULT_MIN_N,
  RECLOG_TEXT_PATHS,
  RECLOG_UNTRUSTED_SOURCE,
  RECOMMENDATION_KINDS,
  type RecommendationRecord,
} from "../../domain/reclog/types.js";
import { score, scoringEngine } from "../../domain/scoring/engine.js";
import type { ProjectionSubject, ScoringSettings } from "../../domain/scoring/types.js";
import {
  BOUNDS,
  analyticsFreshnessShape,
  detailShape,
  leagueShape,
  pageInputShape,
  recordRecommendationInputSchema,
  weekSchema,
} from "../bounds.js";
import { defineTool, type ToolContext } from "../define.js";
import {
  bareUntrusted,
  recSchema,
  toDataInputs,
  type InputStamp,
  type UntrustedField,
} from "../envelope.js";
import { FfError } from "../errors.js";
import {
  bare,
  leagueContext,
  lockModeOf,
  requiredDataset,
  scoringOf,
  teamOf,
  weekFinal,
  weekGames,
  type LeagueContext,
} from "./common.js";
import { rosterTargets, type Target } from "./select.js";
import { bareRecText, inputs as inputsSchema, iso, logIdOut, week } from "./schemas.js";

/** The one provenance tag of read-back log text (OBJ-15). */
export const REC_SOURCE = RECLOG_UNTRUSTED_SOURCE;

/** `meta.untrusted_fields` for a record rendered at `prefix` (every RECLOG_TEXT_PATHS entry). */
export function recordTextFields(prefix: string): UntrustedField[] {
  return RECLOG_TEXT_PATHS.map((p) => bare(`${prefix}.${p}`, REC_SOURCE));
}

const recText = (s: string): string => bareUntrusted(s, "rec_log_text");

/** A stored record as output: every model-authored text re-sanitised (it is path-listed). */
export function recordView(r: RecommendationRecord) {
  return {
    log_id: r.log_id,
    league_key: r.league_key,
    season: r.season,
    kind: r.kind,
    week: r.week,
    recorded_at: r.recorded_at,
    settings_hash: r.settings_hash,
    followed_hint: r.followed_hint,
    client_ref: r.client_ref,
    rec: {
      ...r.rec,
      action: recText(r.rec.action),
      drivers: r.rec.drivers.map((d) => ({ ...d, name: recText(d.name) })),
      assumptions: r.rec.assumptions.map((a) => ({
        text: recText(a.text),
        revisit_trigger: recText(a.revisit_trigger),
      })),
      log_id: null,
    },
    alternatives: r.alternatives.map((a) => ({ ...a, action: recText(a.action) })),
    source_calls: r.source_calls.map((c) => ({ ...c })),
    note: r.note === null ? null : recText(r.note),
  };
}

// --- E12 ff_record_recommendation --------------------------------------------------------------------------

const e12Data = z.strictObject({
  log_id: logIdOut,
  recorded_at: iso,
  week,
  kind: z.enum(RECOMMENDATION_KINDS),
  deduplicated: z.boolean(),
});

const SAFE_PATH = /^[A-Za-z0-9_.[\]]{1,120}$/;
const SAFE_CODE = /^[a-z_]{1,40}$/;

export const recordRecommendation = defineTool({
  name: "ff_record_recommendation",
  family: "local_write",
  description:
    "Log a recommendation (an analytics result's rec, alternatives, source request ids) before presenting it. Local write, idempotent on client_ref.",
  input: recordRecommendationInputSchema,
  opaqueInput: {
    rec: "data.rec of the analytics result being logged, unchanged (Rec: ff://docs/tool-outputs)",
    alternatives: "[{action, subjects, point_estimate, distribution, decision_metric_value}]",
  },
  data: e12Data,
  budget: "list",
  run: async (args, ctx) => {
    const lc = await leagueContext(ctx, args);
    const inputs: InputStamp[] = [lc.input];
    const settings = await scoringOf(ctx, lc, inputs);
    const input = {
      league_key: lc.ref.league_key,
      season: lc.league.season,
      kind: args.kind,
      week: args.week,
      rec: args.rec,
      alternatives: args.alternatives,
      source_calls: args.source_calls,
      followed_hint: args.followed_hint,
      client_ref: args.client_ref ?? null,
      note: args.note ?? null,
    };
    const issues = validateRecordInput(input, ctx.nowMs);
    const first = issues[0];
    if (first !== undefined)
      throw new FfError("VALIDATION", {
        field: SAFE_PATH.test(first.path) ? first.path : "(root)",
        reason: SAFE_CODE.test(first.code) ? first.code : "invalid",
      });
    const r = await ctx.services.recommendationLog.record(
      input,
      new Date(ctx.nowMs).toISOString(),
      settings.settings_hash,
    );
    return {
      data: {
        log_id: r.log_id,
        recorded_at: new Date(Date.parse(r.recorded_at)).toISOString(),
        week: r.week,
        kind: r.kind,
        deduplicated: r.deduplicated,
      },
      inputs,
    };
  },
});

// --- E13 ff_analyze_retrospective ---------------------------------------------------------------------------

const brier = z.union([
  z.strictObject({
    value: z.number(),
    n: z.number().int().min(0),
    decomposition: z
      .strictObject({
        reliability: z.number(),
        resolution: z.number(),
        uncertainty: z.number(),
      })
      .nullable(),
  }),
  z.string().regex(/^n too small \(\d+ of \d+\)$/),
]);

const e13Data = z.strictObject({
  week,
  final: z.boolean(),
  calls: z
    .array(
      z.strictObject({
        log_id: logIdOut,
        kind: z.enum(RECOMMENDATION_KINDS),
        followed: z.boolean().nullable(),
        regret: z.number().nullable(),
        decisive: z.boolean().nullable(),
        recommended: bareRecText,
        best_alternative: bareRecText.nullable(),
        realised: z.number().nullable(),
      }),
    )
    .max(200),
  metrics: z.strictObject({
    per_player: z.strictObject({
      crps: z.number().nullable(),
      pinball: z.strictObject({
        p10: z.number().nullable(),
        p50: z.number().nullable(),
        p90: z.number().nullable(),
      }),
      coverage_80: z.number().nullable(),
      spearman_by_position: z.record(z.string().regex(/^[A-Z]{1,4}$/), z.number().nullable()),
      n_player_weeks: z.number().int().min(0),
    }),
    swap_regret: z.strictObject({
      total: z.number(),
      per_call_mean: z.number().nullable(),
      n_swaps: z.number().int().min(0),
    }),
    brier: z.strictObject({
      p_active: brier,
      p_win: brier,
      p_win_given_bid: brier,
      p_role_holds: brier,
    }),
    accuracy_gap: z.number().nullable(),
  }),
  n_by_metric: z
    .array(
      z.strictObject({
        metric: z.enum([
          "per_player",
          "swap_regret",
          "brier.p_active",
          "brier.p_win",
          "brier.p_win_given_bid",
          "brier.p_role_holds",
        ]),
        n: z.number().int().min(0),
        min_n: z.number().int().min(1),
        reached: z.boolean(),
      }),
    )
    .max(10),
  attribution: z.null(),
  sample_size_caveats: z.array(z.string().max(200)).max(40),
  rec: recSchema,
  inputs: inputsSchema,
});

/** How many simulation samples of a stored projection the retrospective scores (latency, A15). */
export const RETRO_SAMPLE_CAP = 500;

/** The default week of E13: the latest final week at or before the current week, else current − 1. */
function defaultRetroWeek(ctx: ToolContext, lc: LeagueContext): Week {
  for (let w = Math.min(lc.league.current_week, 22); w >= 1; w--)
    if (weekFinal(ctx, lc.league.season, w)) return w;
  return Math.max(1, lc.league.current_week - 1);
}

interface SubjectKeys {
  readonly gsis: Set<string>;
  readonly teams: Set<NflTeam>;
}

function addSubject(k: SubjectKeys, s: { gsis_id: string | null; nfl_team: NflTeam | null }): void {
  if (s.gsis_id !== null) k.gsis.add(s.gsis_id);
  if (s.nfl_team !== null) k.teams.add(s.nfl_team);
}

/** Started-slot total of a roster's realised points, or null when any starter is unknown. */
function startedTotal(
  roster: readonly RosterPresence[],
  pts: (r: RosterPresence) => number | null,
): number | null {
  let sum = 0;
  for (const r of roster) {
    if (!r.started) continue;
    const p = pts(r);
    if (p === null) return null;
    sum += p;
  }
  return sum;
}

function presenceOf(t: Target): RosterPresence {
  return {
    player_key: t.player_key,
    gsis_id: t.subject.kind === "player" ? t.subject.gsis_id : null,
    nfl_team: t.subject.kind === "defense" ? t.subject.nfl_team : null,
    started: t.entry?.slot_class === "starter" || t.entry?.slot_class === "flex",
  };
}

export const analyzeRetrospective = defineTool({
  name: "ff_analyze_retrospective",
  family: "analytics",
  description:
    "Score a week's logged calls (default: last final week): followed, regret, projection CRPS and coverage, swap regret, Brier.",
  input: z.strictObject({
    ...leagueShape,
    week: weekSchema.optional(),
    kinds: z
      .array(z.enum(RECOMMENDATION_KINDS))
      .min(1)
      .max(RECOMMENDATION_KINDS.length)
      .refine((a) => new Set(a).size === a.length, { message: "duplicate_values" })
      .optional(),
    min_n: z.number().int().min(BOUNDS.minN.min).max(BOUNDS.minN.max).default(DEFAULT_MIN_N),
    ...analyticsFreshnessShape,
  }),
  data: e13Data,
  budget: "analytics",
  run: async (args, ctx) => {
    const lc = await leagueContext(ctx, args);
    const warnings: string[] = [];
    const inputs: InputStamp[] = [lc.input];
    const season = lc.league.season;
    const w = args.week ?? defaultRetroWeek(ctx, lc);
    const settings: ScoringSettings = await scoringOf(ctx, lc, inputs);
    const records = ctx.services.recommendationLog.forWeek(lc.ref.league_key, season, w);
    const final = weekFinal(ctx, season, w);
    const mine = await rosterTargets(ctx, lc, undefined, w, inputs, warnings);
    const myKey = teamOf(lc, undefined).team_key;
    let opp: Target[] | null = null;
    try {
      const m = await ctx.services.platform.getMatchups(lc.ref, w);
      for (const x of m.value) {
        const [a, b] = x.teams;
        const other =
          a.team.team_key === myKey
            ? b.team.team_key
            : b.team.team_key === myKey
              ? a.team.team_key
              : null;
        if (other !== null) opp = await rosterTargets(ctx, lc, other, w, inputs, warnings);
      }
    } catch (e) {
      if (!(e instanceof FfError && e.code === "NOT_FOUND")) throw e;
    }
    // the subjects whose realised points are needed
    const keys: SubjectKeys = { gsis: new Set(), teams: new Set() };
    const recSubjects: RecSubject[] = records.flatMap((r) => [
      ...r.rec.subjects,
      ...r.alternatives.flatMap((a) => a.subjects),
    ]);
    for (const s of recSubjects) addSubject(keys, s);
    const roster = mine.map(presenceOf);
    const oppRoster = opp?.map(presenceOf) ?? null;
    for (const r of [...roster, ...(oppRoster ?? [])]) addSubject(keys, r);
    const lines = ctx.services.datasets.playerWeeks.lines([...keys.gsis], season, [w]);
    const lIn = requiredDataset(lines, ctx.nowMs, lc.allowStale);
    if (lIn !== null) inputs.push(lIn);
    const dLines =
      keys.teams.size === 0
        ? { rows: [], stamp: null }
        : ctx.services.datasets.playerWeeks.defenseLines([...keys.teams], season, [w]);
    const byGsis = new Map(lines.rows.map((l) => [l.gsis_id, score(l.line, settings).points]));
    const byTeam = new Map(dLines.rows.map((l) => [l.nfl_team, score(l.line, settings).points]));
    const pointsOf = (s: { gsis_id: string | null; nfl_team: NflTeam | null }): number | null => {
      if (s.gsis_id !== null) return byGsis.get(s.gsis_id) ?? (final ? 0 : null);
      if (s.nfl_team !== null) return byTeam.get(s.nfl_team) ?? (final ? 0 : null);
      return null;
    };
    const realised: SubjectPoints[] = [
      ...[...keys.gsis].map((g) => ({
        player_key:
          lc.ref.platform === "manual" ? manualPlayerKeyFor({ kind: "player", gsis_id: g }) : null,
        gsis_id: g,
        nfl_team: null,
        points: pointsOf({ gsis_id: g, nfl_team: null }),
      })),
      ...[...keys.teams].map((t) => ({
        player_key:
          lc.ref.platform === "manual"
            ? manualPlayerKeyFor({ kind: "defense", nfl_team: t })
            : null,
        gsis_id: null,
        nfl_team: t,
        points: pointsOf({ gsis_id: null, nfl_team: t }),
      })),
      // roster rows keyed by their platform key too (a `manual.p.n-…` subject joins on it)
      ...[...roster, ...(oppRoster ?? [])].map((r) => ({
        player_key: r.player_key,
        gsis_id: r.gsis_id,
        nfl_team: r.nfl_team,
        points: pointsOf(r),
      })),
    ];
    const myPts = startedTotal(roster, pointsOf);
    const oppPts = oppRoster === null ? null : startedTotal(oppRoster, pointsOf);
    // pre-lock stored projections of my started players (never a post-kickoff run)
    const games = weekGames(ctx, season, w).rows;
    const mode = lockModeOf(lc.league);
    const forecasts: PlayerForecast[] = [];
    for (const t of mine) {
      const outcome = pointsOf(presenceOf(t));
      const lockAt = games.length === 0 ? null : lockAtFor(t.nfl_team, games, mode);
      if (outcome === null || lockAt === null) continue;
      const subject: ProjectionSubject = t.subject;
      const stored = ctx.services.projections.getAsOf(subject, season, w, "v1-trailing", lockAt);
      if (stored === null || stored.samples.length === 0) continue;
      const samples = stored.samples.slice(0, RETRO_SAMPLE_CAP);
      const scored = scoringEngine.scoreSamples(samples, settings, "position_cv");
      forecasts.push({
        position: t.position,
        dist: scored.dist,
        samples: samples.map((l) => score(l, settings).points),
        outcome,
      });
    }
    const dataInputs: InputFreshness[] = toDataInputs(inputs, ctx.nowMs).slice(0, 25);
    const result = buildRetrospective(
      {
        week: w,
        final,
        records,
        kinds: args.kinds ?? null,
        realised,
        roster,
        team_result:
          myPts === null || oppPts === null ? null : { my_points: myPts, opponent_points: oppPts },
        player_forecasts: forecasts,
        probabilities: { p_active: [], p_win: [], p_win_given_bid: [], p_role_holds: [] },
        min_n: args.min_n,
        inputs: dataInputs,
      },
      ctx.services.clock,
    );
    let busy = false;
    for (const o of result.outcomes) {
      try {
        await ctx.services.recommendationLog.recordOutcome(o);
      } catch (e) {
        if ((e as { ffCode?: unknown }).ffCode !== "STORE_BUSY") throw e;
        busy = true;
      }
    }
    if (busy) warnings.push("some scored outcomes were not saved (store busy); run again later");
    const r = result.retrospective;
    const data = {
      ...r,
      calls: r.calls.map((c) => ({
        ...c,
        recommended: recText(c.recommended),
        best_alternative: c.best_alternative === null ? null : recText(c.best_alternative),
      })),
      attribution: null,
      rec: { ...r.rec, log_id: null },
    };
    return {
      data: JSON.parse(JSON.stringify(data)) as z.infer<typeof e13Data>,
      inputs,
      warnings: [...warnings, ...result.warnings],
      bareFields: [
        bare("data.calls[].recommended", REC_SOURCE),
        bare("data.calls[].best_alternative", REC_SOURCE),
      ],
      extraSources: ["engine", REC_SOURCE],
      estimate: true,
      provisional: !final,
      listKey: "calls",
    };
  },
});

// --- E14 ff_list_recommendations (C10: no outputSchema) ------------------------------------------------------

export const listRecommendations = defineTool({
  name: "ff_list_recommendations",
  family: "analytics",
  description:
    "Browse the recommendation log, newest first; action_summary is untrusted. Shape: ff://docs/tool-outputs.",
  input: z.strictObject({
    ...leagueShape,
    week: weekSchema.optional(),
    kind: z.enum(RECOMMENDATION_KINDS).optional(),
    ...pageInputShape,
    ...detailShape,
  }),
  data: null,
  budget: "list",
  pageable: true,
  run: async (args, ctx) => {
    const lc = await leagueContext(ctx, args);
    const page = ctx.services.recommendationLog.list({
      league_key: lc.ref.league_key,
      season: lc.league.season,
      week: args.week ?? null,
      kind: args.kind ?? null,
      limit: args.limit,
      offset: args.offset,
    });
    const items = page.items.map((i) => ({ ...i, action_summary: recText(i.action_summary) }));
    return {
      data: { items },
      inputs: [lc.input],
      bareFields: [bare("data.items[].action_summary", REC_SOURCE)],
      extraSources: [REC_SOURCE],
      page: {
        limit: args.limit,
        offset: args.offset,
        count: items.length,
        has_more: page.has_more,
        next_offset: page.next_offset,
      },
      listKey: "items",
    };
  },
});
