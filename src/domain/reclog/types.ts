// types.ts — the recommendation log and retrospective contract (plan 07 E12 record input/output,
// E13 retrospective incl. `n_by_metric` and the "n too small (k of 30)" strings, E14 list items;
// plan 01 §8.2 `recommendation_log`, never pruned; plan 10 §2.1 n-per-metric; OBJ-05: NO
// `parameter_changes_proposed` in v1; OBJ-15: every free-text field here is model-authored and
// untrusted on read — tools path-list it with source `store.recommendation_log`, using the ONE list
// RECLOG_TEXT_PATHS). Contract revision: every record carries `season` (a manual league key spans
// seasons; critic C-04), alternatives carry structured subjects (critic C-01b), a scored outcome is
// persisted beside the immutable log row (critic C-02b), required writes are async (C-04b), and
// log ids / tool names / decision metrics have grammars (critics C-09, C-21).
import type { InputFreshness, Rec, RecSubject } from "../analytics/types.js";
import type { IsoInstant, PageOf, Week } from "../league/types.js";
import type { Dist } from "../scoring/types.js";

/** `log_id` grammar: `rec-` + a 26-char Crockford-base32 ULID. */
export const LOG_ID_RE = /^rec-[0-9A-HJKMNP-TV-Z]{26}$/;
/** `source_calls[].tool` grammar: an `ff_` tool name (≤ 40 chars). */
export const TOOL_NAME_RE = /^ff_[a-z_]{1,37}$/;
/** `decision_metric` grammar: a snake-case metric name, never prose. */
export const DECISION_METRIC_RE = /^[a-z_]{1,32}$/;

/**
 * Every model-authored free-text path in a stored record, relative to the record (plan 01 §4.2 item
 * 3, plan 02 §6.1, plan 07 E12 OBJ-15). EVERY reader (E13, E14, `ff://rec/{log_id}`,
 * `ff://rec/week/{week}`) path-lists these (prefixed with its own `data…` path) with source
 * RECLOG_UNTRUSTED_SOURCE. Non-prose strings (`decision_metric`, `confidence.inputs[].source`,
 * `source_calls[].tool`, keys, slots) are grammar-checked on input instead, so they cannot carry text.
 */
export const RECLOG_TEXT_PATHS: readonly string[] = Object.freeze([
  "rec.action",
  "rec.assumptions[].text",
  "rec.assumptions[].revisit_trigger",
  "rec.drivers[].name",
  "alternatives[].action",
  "note",
]);

/** The provenance tag every read-back free-text field carries in `meta.untrusted_fields[]`. */
export const RECLOG_UNTRUSTED_SOURCE = "store.recommendation_log";

/** Recommendation kinds (plan 07 E12 `kind`). */
export const RECOMMENDATION_KINDS = [
  "lineup",
  "waiver",
  "stream",
  "trade",
  "cascade",
  "schedule",
  "roster",
  "evidence",
  "matchup",
  "onboarding",
  "retro",
  "executed",
  "weekly",
] as const;
/** A recommendation kind. */
export type RecommendationKind = (typeof RECOMMENDATION_KINDS)[number];

/** What the user said about following the call, when the model knows (plan 07 E12). */
export type FollowedHint = "unknown" | "user_said_yes" | "user_said_no";

/** An alternative the model offered alongside the recommendation. */
export interface Alternative {
  /** Model-authored text (untrusted on read). */
  readonly action: string;
  /** Structured subjects of the alternative (what regret is computed from; never `action`). */
  readonly subjects: readonly RecSubject[];
  readonly point_estimate: number;
  readonly distribution: Dist;
  readonly decision_metric_value: number;
}

/**
 * A tool call the recommendation was derived from: `tool` matches TOOL_NAME_RE and `request_id` is
 * the `meta.request_id` the envelope of that call carried (`r-` + 12 hex; critic C-03).
 */
export interface SourceCall {
  readonly tool: string;
  readonly request_id: string;
}

/** The validated `ff_record_recommendation` input (plan 07 E12). */
export interface RecordRecommendationInput {
  readonly league_key: string;
  /** Filled by the tool from `League.season` — never supplied by the model. */
  readonly season: number;
  readonly kind: RecommendationKind;
  readonly week: Week;
  readonly rec: Rec;
  readonly alternatives: readonly Alternative[];
  readonly source_calls: readonly SourceCall[];
  readonly followed_hint: FollowedHint;
  /** Deduplication key (≤ 64 chars): a second record with the same key returns the first. */
  readonly client_ref: string | null;
  /** Model-authored note, ≤ 200 chars (untrusted on read). */
  readonly note: string | null;
}

/** One stored log row (plan 01 §8.2; never pruned). */
export interface RecommendationRecord extends RecordRecommendationInput {
  /** Server-minted id, e.g. `rec-<ulid>`. */
  readonly log_id: string;
  readonly recorded_at: IsoInstant;
  /** The settings the call was made under (links the never-pruned `league_settings` row). */
  readonly settings_hash: string | null;
}

/** `ff_record_recommendation` output (plan 07 E12). */
export interface RecordResult {
  readonly log_id: string;
  readonly recorded_at: IsoInstant;
  readonly week: Week;
  readonly kind: RecommendationKind;
  /** True when `client_ref` matched an existing row (idempotent). */
  readonly deduplicated: boolean;
}

/** One `ff_list_recommendations` item (plan 07 E14). */
export interface RecommendationListItem {
  readonly log_id: string;
  readonly kind: RecommendationKind;
  readonly season: number;
  readonly week: Week;
  readonly recorded_at: IsoInstant;
  /** Model-authored summary (untrusted on read). */
  readonly action_summary: string;
  /** From the persisted outcome (null until the retrospective has scored the call). */
  readonly followed: boolean | null;
}

/**
 * A scored outcome, persisted beside the immutable log row (table `recommendation_outcome`, a
 * required write, never pruned; critic C-02b). Written by the retrospective, re-written while
 * `week_final` is false; E14 `followed` reads it instead of re-running the retrospective.
 */
export interface RecommendationOutcome {
  readonly log_id: string;
  readonly followed: boolean | null;
  readonly realised: number | null;
  readonly regret: number | null;
  readonly decisive: boolean | null;
  readonly scored_at: IsoInstant;
  /** The week was final when scored (an outcome scored on provisional stats is re-scored later). */
  readonly week_final: boolean;
}

// --- retrospective metrics (plan 07 E13; research 05 §12) --------------------------------------------

/** The sample size below which a metric is reported as "n too small" (research 05 §12.6). */
export const DEFAULT_MIN_N = 30;

/** The literal a metric under its minimum n reports instead of a value: `n too small (k of 30)`. */
export type NTooSmall = `n too small (${number} of ${number})`;

/** Builds the "n too small (k of min)" string (plan 07 E13, plan 10 A9). */
export function nTooSmall(k: number, minN: number = DEFAULT_MIN_N): NTooSmall {
  const kk = Number.isFinite(k) && k > 0 ? Math.floor(k) : 0;
  const mm = Number.isFinite(minN) && minN > 0 ? Math.floor(minN) : DEFAULT_MIN_N;
  return `n too small (${String(kk)} of ${String(mm)})` as NTooSmall;
}

/** Brier score components (Murphy decomposition: reliability − resolution + uncertainty). */
export interface BrierDecomposition {
  readonly reliability: number;
  readonly resolution: number;
  readonly uncertainty: number;
}

/** A Brier score with its n (and decomposition when computed). */
export interface BrierValue {
  readonly value: number;
  readonly n: number;
  readonly decomposition: BrierDecomposition | null;
}

/** A Brier metric: the value when n reached, else the "n too small" string. */
export type BrierMetric = BrierValue | NTooSmall;

/** Per-player projection error metrics — the ones that reach n within weeks (plan 10 §2.1). */
export interface PerPlayerMetrics {
  readonly crps: number | null;
  readonly pinball: {
    readonly p10: number | null;
    readonly p50: number | null;
    readonly p90: number | null;
  };
  /** Share of outcomes inside the 80 % interval. */
  readonly coverage_80: number | null;
  /**
   * Within-position Spearman correlation of projection vs outcome, keyed by POSITION_RE codes only
   * (never a raw provider string — the envelope's key walker rejects anything else; critic C-12).
   */
  readonly spearman_by_position: Readonly<Record<string, number | null>>;
  /** Player-weeks scored: only projections that were PERSISTED before lock count (best-effort writes). */
  readonly n_player_weeks: number;
}

/** Swap regret over logged lineup calls. */
export interface SwapRegret {
  readonly total: number;
  readonly per_call_mean: number | null;
  readonly n_swaps: number;
}

/** The v1 metrics block (plan 07 E13 `metrics`). */
export interface RetrospectiveMetrics {
  readonly per_player: PerPlayerMetrics;
  readonly swap_regret: SwapRegret;
  readonly brier: {
    readonly p_active: BrierMetric;
    readonly p_win: BrierMetric;
    readonly p_win_given_bid: BrierMetric;
    readonly p_role_holds: BrierMetric;
  };
  readonly accuracy_gap: number | null;
}

/** Names of the metrics `n_by_metric[]` reports. */
export type MetricName =
  | "per_player"
  | "swap_regret"
  | "brier.p_active"
  | "brier.p_win"
  | "brier.p_win_given_bid"
  | "brier.p_role_holds";

/** One `n_by_metric[]` row: whether a metric has reached its minimum n (plan 10 §2.1 shape). */
export interface NByMetric {
  readonly metric: MetricName;
  readonly n: number;
  readonly min_n: number;
  readonly reached: boolean;
}

/** One scored call (plan 07 E13 `calls[]`). */
export interface RetrospectiveCall {
  readonly log_id: string;
  readonly kind: RecommendationKind;
  readonly followed: boolean | null;
  readonly regret: number | null;
  readonly decisive: boolean | null;
  /** Model-authored (path-listed, source `store.recommendation_log`). */
  readonly recommended: string;
  /** Model-authored (path-listed, source `store.recommendation_log`). */
  readonly best_alternative: string | null;
  readonly realised: number | null;
}

/** Outcome attribution (populated in Phase 3 — plan 10 C8; null in v1). */
export interface OutcomeAttribution {
  readonly opportunity: number;
  readonly efficiency: number;
  readonly td: number;
  readonly matchup_weather: number;
  readonly availability: number;
}

/**
 * `ff_analyze_retrospective` data (plan 07 E13). Deliberately has NO `parameter_changes_proposed`
 * (round 1 OBJ-05: it enters in Phase 3 with held-out seasons; a type test pins its absence).
 */
export interface Retrospective {
  readonly week: Week;
  readonly final: boolean;
  readonly calls: readonly RetrospectiveCall[];
  readonly metrics: RetrospectiveMetrics;
  readonly n_by_metric: readonly NByMetric[];
  readonly attribution: OutcomeAttribution | null;
  /** One line per metric under `min_n`, naming it. */
  readonly sample_size_caveats: readonly string[];
  readonly rec: Rec;
  /** Every contributing input with its age and freshness (plan 07 §2). */
  readonly inputs: readonly InputFreshness[];
}

// --- the repository port (implemented by src/store; required writes may throw StoreBusyError) --------

/** A list query over the log. `week` filters within `season` (`ff://rec/week/{week}` = current season). */
export interface RecommendationQuery {
  readonly league_key: string;
  readonly season: number | null;
  readonly week: Week | null;
  readonly kind: RecommendationKind | null;
  readonly limit: number;
  readonly offset: number;
}

/**
 * The recommendation-log repository (a REQUIRED-write family: the store yields between 100 ms lock
 * attempts for ≤ 1 s, then rejects with StoreBusyError — plan 01 §5.3, plan 03 §1.2).
 */
export interface RecommendationLogRepository {
  /** Inserts (or resolves to the existing row for the same league + `client_ref`). */
  record(
    input: RecordRecommendationInput,
    recordedAt: IsoInstant,
    settingsHash: string | null,
  ): Promise<RecordResult>;
  get(logId: string): RecommendationRecord | null;
  /** Newest first; `followed` joined from the outcome table. */
  list(q: RecommendationQuery): PageOf<RecommendationListItem>;
  forWeek(leagueKey: string, season: number, week: Week): readonly RecommendationRecord[];
  /** Upserts the scored outcome of one call (required write; the log row itself never changes). */
  recordOutcome(outcome: RecommendationOutcome): Promise<void>;
  outcome(logId: string): RecommendationOutcome | null;
}
