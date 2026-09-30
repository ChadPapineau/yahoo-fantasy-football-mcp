// bounds.ts — every numeric/string bound of plan 02 §5 and the plan 07 inputs (legend
// `PlayerSelector`, §2 common inputs), as constants plus zod v4 schemas; the platform key grammar
// (plan 02 §5, re-exported from src/config/schema.ts, the leaf layer that also needs it) and the
// manual-league id validators (plan 01 §8 X1). All bounds are plan 02 A-7 assumptions.
// Contract revision: key `.max()` derived from the grammar (C-11); nflverse ids re-exported from the
// leaf config layer (C-19b); E1 `pool` selector (C-06); common-input shapes split per tool family
// (C-17); E5/E1/C2 bounds (C-18); log-id / request-id schemas (C-21, C-03); and the E12
// `ff_record_recommendation` input schema, composed from the envelope's Rec/Dist schemas (C-08).
import { z } from "zod/v4";
import {
  GSIS_ID_RE,
  KEY_MAX_CHARS,
  MANUAL_KEY_RE,
  NFL_TEAMS,
  YAHOO_KEY_RE,
  isLeagueKey,
  isNflTeam,
  type NflTeam,
} from "../config/schema.js";
import {
  DECISION_METRIC_RE,
  LOG_ID_RE,
  RECOMMENDATION_KINDS,
  TOOL_NAME_RE,
} from "../domain/reclog/types.js";
import {
  INVALID_KEY_MESSAGE,
  PRINTABLE_RE,
  REQUEST_ID_RE,
  alternativeSchema,
  boundedTextSchema,
  recSchema,
} from "./envelope.js";

export {
  DECISION_METRIC_RE,
  GSIS_ID_RE,
  INVALID_KEY_MESSAGE,
  PRINTABLE_RE,
  boundedTextSchema,
  KEY_MAX_CHARS,
  LOG_ID_RE,
  MANUAL_KEY_RE,
  NFL_TEAMS,
  REQUEST_ID_RE,
  TOOL_NAME_RE,
  YAHOO_KEY_RE,
  isLeagueKey,
  isNflTeam,
};
export type { NflTeam };

// --- constants ---------------------------------------------------------------------------------

/** Every bound in one frozen table (plan 02 §5; plan 07 per-tool inputs). */
export const BOUNDS = Object.freeze({
  week: { min: 1, max: 22 },
  season: { min: 2001, max: 2100 },
  limit: { min: 1, max: 100, default: 25 },
  offset: { min: 0, max: 10_000, default: 0 },
  searchChars: { min: 1, max: 64 },
  searchLimit: { min: 1, max: 25, default: 10 },
  playerList: { min: 1, max: 25 },
  tradeNoteChars: 200,
  txnCount: { min: 1, max: 200, default: 25 },
  faabBid: { min: 0, max: 1000 },
  faabBudget: { min: 0, max: 10_000 },
  addsRemaining: { min: 0, max: 100 },
  seed: { min: 0, max: 2 ** 31 - 1 },
  nSims: { min: 1000, max: 20_000, default: 4000 },
  usageWindow: { min: 1, max: 17, default: 4 },
  lookAhead: { min: 0, max: 2, default: 1 },
  /** E5's default when `positions ⊆ {K, DEF}` — the whole P0 slice (plan 07 E5). */
  lookAheadKdefDefault: 2,
  horizonWeeks: { min: 1, max: 17 },
  weeksList: { min: 1, max: 6 },
  poolTop: { min: 1, max: 50 },
  compareSwaps: { max: 5 },
  blendWeight: { min: 0, max: 1 },
  clientRefChars: 64,
  recNoteChars: 200,
  recordInputChars: 20_000,
  minN: { min: 1, max: 10_000, default: 30 },
  sinceDays: { min: 1, max: 30, default: 7 },
  sinceHours: { min: 1, max: 168, default: 72 },
  newsLimit: { min: 1, max: 50, default: 20 },
  trendingLimit: { min: 1, max: 50, default: 25 },
  tradeSide: { min: 1, max: 6 },
  maxPartners: { min: 1, max: 4, default: 3 },
  defenseWindowWeeks: { min: 4, max: 17, default: 10 },
  claimTextChars: 400,
  claimSourceChars: 64,
});

// --- key validators --------------------------------------------------------------------------

/** Kinds of platform key the grammar knows. */
export type KeyKind = "league" | "team" | "player";

/** Which grammar a key belongs to, or null when it matches none. */
export function keyPlatform(kind: KeyKind, s: string): "yahoo" | "manual" | null {
  if (YAHOO_KEY_RE[kind].test(s)) return "yahoo";
  if (MANUAL_KEY_RE[kind].test(s)) return "manual";
  return null;
}

/** Whether `s` is a valid manual-league id of the given kind (plan 01 §8 X1). */
export function isManualKey(kind: KeyKind, s: string): boolean {
  return MANUAL_KEY_RE[kind].test(s);
}

/** Whether `s` is a valid Yahoo key of the given kind (plan 02 §5 table). */
export function isYahooKey(kind: keyof typeof YAHOO_KEY_RE, s: string): boolean {
  return YAHOO_KEY_RE[kind].test(s);
}

/** Whether `s` is a team key of any grammar. */
export function isTeamKey(s: string): boolean {
  return keyPlatform("team", s) !== null;
}

/** Whether `s` is a player key of any grammar. */
export function isPlayerKey(s: string): boolean {
  return keyPlatform("player", s) !== null;
}

/**
 * The league key a team key belongs to (`461.l.1000.t.3` → `461.l.1000`); null for a non-team key.
 * Used to check that a team argument belongs to the league argument.
 */
export function leagueOfTeam(teamKey: string): string | null {
  if (!isTeamKey(teamKey)) return null;
  return teamKey.slice(0, teamKey.lastIndexOf(".t."));
}

// --- zod schemas ---------------------------------------------------------------------------------

const int = (min: number, max: number) => z.number().int().min(min).max(max);

/** A week number 1..22 (omitted = the league's current week, handled by the tool). */
export const weekSchema = int(BOUNDS.week.min, BOUNDS.week.max);
/** A season year 2001..2100. */
export const seasonSchema = int(BOUNDS.season.min, BOUNDS.season.max);
/** Page size 1..100, default 25. */
export const limitSchema = int(BOUNDS.limit.min, BOUNDS.limit.max).default(BOUNDS.limit.default);
/** Page offset 0..10 000, default 0. */
export const offsetSchema = int(BOUNDS.offset.min, BOUNDS.offset.max).default(
  BOUNDS.offset.default,
);
/** `detail` field selection (plan 07 C2), default `compact`. */
export const detailSchema = z.enum(["compact", "full"]).default("compact");

/**
 * A league key (Yahoo or manual grammar). Every length/grammar failure — including over-long — is
 * INVALID_KEY (the `.max` carries the same message), and the max is the grammar's own maximum.
 */
export const leagueKeySchema = z
  .string()
  .max(KEY_MAX_CHARS.league, { message: INVALID_KEY_MESSAGE })
  .refine(isLeagueKey, { message: INVALID_KEY_MESSAGE });
/** A team key (Yahoo or manual grammar). */
export const teamKeySchema = z
  .string()
  .max(KEY_MAX_CHARS.team, { message: INVALID_KEY_MESSAGE })
  .refine(isTeamKey, { message: INVALID_KEY_MESSAGE });
/** A player key (Yahoo or manual grammar). */
export const playerKeySchema = z
  .string()
  .max(KEY_MAX_CHARS.player, { message: INVALID_KEY_MESSAGE })
  .refine(isPlayerKey, { message: INVALID_KEY_MESSAGE });
/** 1..25 distinct player keys (plan 02 §5 — the bound on key lists; larger sets use a selector). */
export const playerKeysSchema = z
  .array(playerKeySchema)
  .min(BOUNDS.playerList.min)
  .max(BOUNDS.playerList.max)
  .refine((a) => new Set(a).size === a.length, { message: "duplicate_keys" });
/** A gsis id. */
export const gsisIdSchema = z.string().regex(GSIS_ID_RE, { message: INVALID_KEY_MESSAGE });
/** An nflverse team abbreviation. */
export const nflTeamSchema = z.enum(NFL_TEAMS);

/**
 * `PlayerSelector` (plan 07 legend): exactly one of `player_keys` (≤ 25), `gsis_ids` (≤ 25),
 * `team_key`, `nfl_team` — never a longer key list (plan 02 §5, T6).
 */
export const playerSelectorSchema = z.union([
  z.strictObject({ player_keys: playerKeysSchema }),
  z.strictObject({
    gsis_ids: z
      .array(gsisIdSchema)
      .min(BOUNDS.playerList.min)
      .max(BOUNDS.playerList.max)
      .refine((a) => new Set(a).size === a.length, { message: "duplicate_keys" }),
  }),
  z.strictObject({ team_key: teamKeySchema }),
  z.strictObject({ nfl_team: nflTeamSchema }),
]);
/** A validated player selector. */
export type PlayerSelector = z.infer<typeof playerSelectorSchema>;

/** Positions a pool may name (plan 07 E1): a display position or slot code, uppercase. */
const POOL_POSITION_RE = /^[A-Z][A-Z/+]{0,7}$/;

/**
 * E1's `{ pool: { status, position, top } }` — the sanctioned selector past 25 players (plan 02 §5;
 * plan 07 E1). Under the manual league it resolves through `listPlayers` (K/DEF nflverse universe;
 * other positions: only players listed in league.yaml, with MANUAL_POOL_WARNING — decision recorded).
 */
export const poolSelectorSchema = z.strictObject({
  pool: z.strictObject({
    status: z.enum(["A", "FA"]),
    position: z.string().regex(POOL_POSITION_RE),
    top: int(BOUNDS.poolTop.min, BOUNDS.poolTop.max),
  }),
});
/** E1 `players`: a PlayerSelector or a pool. */
export const projectionSelectorSchema = z.union([
  ...playerSelectorSchema.options,
  poolSelectorSchema,
]);
/** A validated E1 selector. */
export type ProjectionSelector = z.infer<typeof projectionSelectorSchema>;

/** A free-text search query: 1..64 printable characters, trimmed (plan 02 §5). */
export const searchQuerySchema = z
  .string()
  .trim()
  .min(BOUNDS.searchChars.min)
  .max(BOUNDS.searchChars.max)
  .regex(PRINTABLE_RE, { message: "unprintable_characters" });

/** `client_ref` for record deduplication (plan 07 E12): ≤ 64 of `[A-Za-z0-9._:-]`. */
export const clientRefSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/);

/** A FAAB bid 0..1000 (the `≤ faab_balance` check needs league state and happens in the tool). */
export const faabBidSchema = int(BOUNDS.faabBid.min, BOUNDS.faabBid.max);
/** E5 `faab_budget`: 0..10 000 or null. */
export const faabBudgetSchema = int(BOUNDS.faabBudget.min, BOUNDS.faabBudget.max).nullable();
/** E5 `adds_remaining`: 0..100 or null. */
export const addsRemainingSchema = int(
  BOUNDS.addsRemaining.min,
  BOUNDS.addsRemaining.max,
).nullable();
/** E1 `seed`: 0..2^31−1 (feeds `seededRng`, src/domain/clock.ts). */
export const seedSchema = int(BOUNDS.seed.min, BOUNDS.seed.max);
/** E5 `look_ahead` 0..2; the tool applies BOUNDS.lookAheadKdefDefault (2) for a K/DEF-only call. */
export const lookAheadSchema = int(BOUNDS.lookAhead.min, BOUNDS.lookAhead.max);
/** A platform stat id (C2 `sort`, B2 `stats[].stat_id`): 1–4 digits. */
export const STAT_ID_RE = /^[0-9]{1,4}$/;
/** A stat id argument. */
export const statIdSchema = z.string().regex(STAT_ID_RE);
/** A recommendation `log_id` (`rec-` + ULID) — resource template arguments and E13/E14 references. */
export const logIdSchema = z
  .string()
  .max(30, { message: INVALID_KEY_MESSAGE })
  .regex(LOG_ID_RE, { message: INVALID_KEY_MESSAGE });
/** A request id as carried in `meta.request_id` (`r-` + 12 hex). */
export const requestIdSchema = z.string().regex(REQUEST_ID_RE, { message: INVALID_KEY_MESSAGE });
/** Transactions `count` 1..200, default 25. */
export const txnCountSchema = int(BOUNDS.txnCount.min, BOUNDS.txnCount.max).default(
  BOUNDS.txnCount.default,
);
/** `n_sims` 1000..20000, default 4000. */
export const nSimsSchema = int(BOUNDS.nSims.min, BOUNDS.nSims.max).default(BOUNDS.nSims.default);
/** An ISO-8601 UTC instant (`Z` or offset), ≤ 40 chars. */
export const isoInstantSchema = z.iso.datetime({ offset: true }).max(40);

/**
 * The plan 07 §2 common inputs, split so each tool spreads only what it takes (critic C-17):
 * - `leagueShape` — every tool except A1 `ff_list_leagues` and G1 `ff_get_status`;
 * - `platformFreshnessShape` — platform-fact tools (A1–A5, B1–B2, C1–C2): `force_refresh`, `allow_stale`;
 * - `analyticsFreshnessShape` — analytics and dataset tools (D*, E*): `allow_stale` only;
 * - `detailShape` — list/card/analytics tools with a compact/full form (not E12, E13, G1).
 */
export const leagueShape = { league_key: leagueKeySchema.optional() } as const;
/** `force_refresh?` + `allow_stale?` (platform-fact tools). */
export const platformFreshnessShape = {
  force_refresh: z.boolean().optional(),
  allow_stale: z.boolean().optional(),
} as const;
/** `allow_stale?` (analytics/dataset tools — they never force a platform refresh). */
export const analyticsFreshnessShape = { allow_stale: z.boolean().optional() } as const;
/** `detail` (default `compact`). */
export const detailShape = { detail: detailSchema } as const;

/** All four together — a platform-fact list/card tool's common inputs (e.g. B1, C1, C2). */
export const commonInputShape = {
  ...leagueShape,
  ...platformFreshnessShape,
  ...detailShape,
} as const;

/** The paging inputs `limit` (default 25) + `offset` (default 0) to spread into a list tool's input. */
export const pageInputShape = {
  limit: limitSchema,
  offset: offsetSchema,
} as const;

// --- E12 `ff_record_recommendation` input (plan 07 E12; critics C-08, C-09, C-01b, C-03) -------------

/** `source_calls[]` item: a registered tool name and the `meta.request_id` its result carried. */
export const sourceCallSchema = z.strictObject({
  tool: z.string().regex(TOOL_NAME_RE),
  request_id: requestIdSchema,
});

/** The most alternatives / source calls one record may carry. */
export const RECORD_LIMITS = Object.freeze({ alternatives: 10, sourceCalls: 25 });

/**
 * The E12 input schema (plan 07 E12). `season` is NOT an input — the tool fills it from
 * `League.season`; `rec.log_id` must be null; every key in `rec.subjects`/`rec.lineup`/
 * `alternatives[].subjects` is grammar-checked; the serialised input is capped at
 * BOUNDS.recordInputChars (20 000).
 */
export const recordRecommendationInputSchema = z
  .strictObject({
    ...leagueShape,
    kind: z.enum(RECOMMENDATION_KINDS),
    week: weekSchema,
    rec: recSchema,
    alternatives: z.array(alternativeSchema).max(RECORD_LIMITS.alternatives).default([]),
    source_calls: z.array(sourceCallSchema).max(RECORD_LIMITS.sourceCalls).default([]),
    followed_hint: z.enum(["unknown", "user_said_yes", "user_said_no"]).default("unknown"),
    client_ref: clientRefSchema.optional(),
    note: boundedTextSchema(BOUNDS.recNoteChars).optional(),
  })
  .refine((v) => JSON.stringify(v).length <= BOUNDS.recordInputChars, {
    message: "input_too_large",
  });
/** A validated E12 input (before the tool adds `season`). */
export type RecordRecommendationArgs = z.infer<typeof recordRecommendationInputSchema>;
