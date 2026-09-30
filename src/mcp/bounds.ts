// bounds.ts — every numeric/string bound of plan 02 §5 and the plan 07 inputs (legend
// `PlayerSelector`, §2 common inputs), as constants plus zod v4 schemas; the platform key grammar
// (plan 02 §5, re-exported from src/config/schema.ts, the leaf layer that also needs it) and the
// manual-league id validators (plan 01 §8 X1). All bounds are plan 02 A-7 assumptions.
import { z } from "zod/v4";
import { MANUAL_KEY_RE, YAHOO_KEY_RE, isLeagueKey } from "../config/schema.js";

export { MANUAL_KEY_RE, YAHOO_KEY_RE, isLeagueKey };

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
  nSims: { min: 1000, max: 20_000, default: 4000 },
  usageWindow: { min: 1, max: 17, default: 4 },
  lookAhead: { min: 0, max: 2, default: 1 },
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

/** nflverse team abbreviations (research 04 §D: nflverse uses `LA` for the Rams, `LV`, `JAX`). */
export const NFL_TEAMS = [
  "ARI",
  "ATL",
  "BAL",
  "BUF",
  "CAR",
  "CHI",
  "CIN",
  "CLE",
  "DAL",
  "DEN",
  "DET",
  "GB",
  "HOU",
  "IND",
  "JAX",
  "KC",
  "LA",
  "LAC",
  "LV",
  "MIA",
  "MIN",
  "NE",
  "NO",
  "NYG",
  "NYJ",
  "PHI",
  "PIT",
  "SEA",
  "SF",
  "TB",
  "TEN",
  "WAS",
] as const;
/** An nflverse team abbreviation. */
export type NflTeam = (typeof NFL_TEAMS)[number];

/** nflverse gsis id grammar (`00-0012345`). */
export const GSIS_ID_RE = /^00-[0-9]{7}$/;

/** Printable text: no C0/C1 controls and no format characters (zero-width, bidi, tags). */
const PRINTABLE_RE = /^[^\p{Cc}\p{Cf}\p{Cs}\p{Co}]*$/u;

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

/** The zod issue message the error mapper turns into `INVALID_KEY` (plan 01 §4.3). */
export const INVALID_KEY_MESSAGE = "invalid_key";

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

/** A league key (Yahoo or manual grammar). */
export const leagueKeySchema = z
  .string()
  .max(40)
  .refine(isLeagueKey, { message: INVALID_KEY_MESSAGE });
/** A team key (Yahoo or manual grammar). */
export const teamKeySchema = z.string().max(48).refine(isTeamKey, { message: INVALID_KEY_MESSAGE });
/** A player key (Yahoo or manual grammar). */
export const playerKeySchema = z
  .string()
  .max(48)
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

/** A free-text search query: 1..64 printable characters, trimmed (plan 02 §5). */
export const searchQuerySchema = z
  .string()
  .trim()
  .min(BOUNDS.searchChars.min)
  .max(BOUNDS.searchChars.max)
  .regex(PRINTABLE_RE, { message: "unprintable_characters" });

/** Model-supplied free text with a cap (trade notes, record notes, claims): printable, capped. */
export function boundedTextSchema(maxChars: number) {
  return z.string().max(maxChars).regex(PRINTABLE_RE, { message: "unprintable_characters" });
}

/** `client_ref` for record deduplication (plan 07 E12): ≤ 64 of `[A-Za-z0-9._:-]`. */
export const clientRefSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/);

/** A FAAB bid 0..1000 (the `≤ faab_balance` check needs league state and happens in the tool). */
export const faabBidSchema = int(BOUNDS.faabBid.min, BOUNDS.faabBid.max);
/** Transactions `count` 1..200, default 25. */
export const txnCountSchema = int(BOUNDS.txnCount.min, BOUNDS.txnCount.max).default(
  BOUNDS.txnCount.default,
);
/** `n_sims` 1000..20000, default 4000. */
export const nSimsSchema = int(BOUNDS.nSims.min, BOUNDS.nSims.max).default(BOUNDS.nSims.default);
/** An ISO-8601 UTC instant (`Z` or offset), ≤ 40 chars. */
export const isoInstantSchema = z.iso.datetime({ offset: true }).max(40);

/**
 * The common inputs of plan 07 §2 as a shape to spread into a tool's `z.strictObject({...})`:
 * `league_key?`, `force_refresh?`, `allow_stale?`, `detail` (default `compact`).
 */
export const commonInputShape = {
  league_key: leagueKeySchema.optional(),
  force_refresh: z.boolean().optional(),
  allow_stale: z.boolean().optional(),
  detail: detailSchema,
} as const;

/** The paging inputs `limit` (default 25) + `offset` (default 0) to spread into a list tool's input. */
export const pageInputShape = {
  limit: limitSchema,
  offset: offsetSchema,
} as const;
