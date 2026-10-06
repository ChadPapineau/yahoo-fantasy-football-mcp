// schema.ts — the zod schema of <config>/league.yaml (plan 01 §8 X1 ManualLeagueProvider; plan 10
// §3.1a platform seam + D5 FAAB budget/acquisition limits; plan 02 §5 "zod .strict(), every string
// has max, every number has int().min().max()"; plan 02 §6.2 length caps: league/team name 64,
// manager 32, player name 64). Code fields obey the league-model grammars (critic C-15). Every
// issue message here is fixed server text — `issuesOf` never echoes a value from the file — and,
// so `ff doctor` can say what to write instead (QA-1-047), names the schema's own vocabulary: the
// nflverse code for a known alias, the allowed values of an enum, `required field is missing` for
// an absent key, and the `{ defense: TEAM }` form for a defence written as a player.
import { z } from "zod/v4";
import { GSIS_ID_RE, isNflTeam, NFL_TEAMS } from "../../config/schema.js";
import { normalizeTeam } from "../../domain/crosswalk/teams.js";
import { KNOWN_CANONICAL } from "../../domain/scoring/types.js";
import { defineSlot } from "../../domain/league/slots.js";
import { SLOT_NAME_RE, STATUS_CODE_RE } from "../../domain/league/types.js";
import type { LeagueFileIssue } from "../platform.js";

/** The file format version this build reads. */
export const LEAGUE_FILE_VERSION = 1;

/** Player positions a league.yaml player entry may state (team defences use `defense:`). */
export const PLAYER_POSITIONS = ["QB", "RB", "WR", "TE", "K"] as const;
/** Positions a slot's `eligible` list may name. */
export const SLOT_POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"] as const;

/** Largest magnitude of any per-unit scoring value (a TD worth 1e9 points is a typo or an attack). */
export const MAX_SCORING_MAGNITUDE = 50;

/** Characters a name may not contain: C0/C1 controls, zero-width and bidi-override code points. */
const FORBIDDEN_TEXT_RE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/u;

/**
 * Default-ignorable code points (soft hyphen, variation selectors, Hangul fillers, tag characters …)
 * render as nothing, so a name could hide text in them; refused at the door like the MCP sanitiser
 * strips them on output (QA-1-074).
 */
const DEFAULT_IGNORABLE_RE = /\p{Default_Ignorable_Code_Point}/u;

/** A human-authored name: 1..max chars after trimming, no control/zero-width/bidi characters. */
const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => s.trim().length > 0, { message: "must not be empty" })
    .refine((s) => !FORBIDDEN_TEXT_RE.test(s) && !DEFAULT_IGNORABLE_RE.test(s), {
      message: "contains control, zero-width or bidi characters",
    });

/** Why a team code is refused: the nflverse code for a known alias or case, else the 32 codes. */
export function teamCodeReason(s: string): string {
  const canonical = normalizeTeam(s);
  return canonical !== null
    ? `not an nflverse team abbreviation (use ${canonical})`
    : `not an nflverse team abbreviation (one of: ${NFL_TEAMS.join(", ")})`;
}

const nflTeam = z
  .string()
  .max(3)
  .refine((s) => isNflTeam(s), {
    error: (iss) => teamCodeReason(typeof iss.input === "string" ? iss.input : ""),
  });
/** Fixed hint for a slot name the model cannot classify (ESPN/Sleeper `FLEX`, `D/ST`; QA-1-047). */
export const UNKNOWN_SLOT_HINT =
  "a flex is named by its positions (W/R/T, W/R, W/T, Q/W/R/T) or given an eligible list; " +
  "the team defence slot is DEF, the bench BN, injured reserve IR";

/**
 * Why a slot name is refused, for a name SLOT_NAME_RE rejects. A name that is only in the wrong case
 * gets the same help as its upper-case spelling (QA-1-047): the slot it means when that is in the
 * vocabulary (`wr` → use WR, `w/r/t` → use W/R/T), else the vocabulary hint (`Flex`, `d/st`). Only
 * vocabulary is ever named, never the value itself.
 */
export function slotNameReason(s: string): string {
  const up = s.toUpperCase();
  if (SLOT_NAME_RE.test(up)) {
    const known = typeof defineSlot({ name: up, count: 0 }) === "object";
    return known
      ? `not a slot name: slot names are upper case (use ${up})`
      : `not a slot name: slot names are upper case; ${UNKNOWN_SLOT_HINT}`;
  }
  return `not a slot name (upper-case letters, / or +, at most 10); ${UNKNOWN_SLOT_HINT}`;
}

const gsisId = z.string().max(10).regex(GSIS_ID_RE, { message: "not a gsis id (00-0012345)" });
const slotName = z
  .string()
  .max(10)
  .refine((s) => SLOT_NAME_RE.test(s), {
    error: (iss) => slotNameReason(typeof iss.input === "string" ? iss.input : ""),
  });
const statusCode = z.string().max(8).regex(STATUS_CODE_RE, { message: "not a status code" });
const week = z.int().min(1).max(22);
const teamId = z.int().min(1).max(32);
const slug = z
  .string()
  .max(32)
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/, {
    message: "must be lowercase letters, digits and inner hyphens",
  });
const isoInstant = z.iso.datetime({ offset: true });
const isoDate = z.iso.date();

/** A player on a roster or in a list: an nflverse player by name/team/position (+ gsis id). */
export const playerEntrySchema = z
  .object({
    name: text(64),
    team: nflTeam,
    position: z.enum(PLAYER_POSITIONS),
    gsis_id: gsisId.optional(),
    /** Extra positions for a multi-position player. */
    eligible: z.array(z.enum(PLAYER_POSITIONS)).max(5).optional(),
    slot: slotName.optional(),
    status: statusCode.optional(),
    jersey: z.int().min(0).max(99).optional(),
  })
  .strict();

/** A team defence on a roster or in a list. */
export const defenseEntrySchema = z
  .object({
    defense: nflTeam,
    slot: slotName.optional(),
  })
  .strict();

/** Either kind of roster entry. */
export const rosterEntrySchema = z.union([playerEntrySchema, defenseEntrySchema]);

const players = z.array(rosterEntrySchema).max(60);

const scoringValue = z.number().min(-MAX_SCORING_MAGNITUDE).max(MAX_SCORING_MAGNITUDE);
const canonicalEnum = z.enum(KNOWN_CANONICAL);

/**
 * Missed-FG bins (plan 08 §3.1 `fg_miss_*`, the `fg_miss_distance` count family): the five bins
 * nflverse reports per kicker (`fg_missed_0_19` … `fg_missed_50_59` + `fg_missed_60_`), the same
 * edges as the made-FG bins (QA-2-045).
 */
export const FG_MISS_BINS = [
  "fg_miss_0_19",
  "fg_miss_20_29",
  "fg_miss_30_39",
  "fg_miss_40_49",
  "fg_miss_50p",
] as const;

/**
 * Yards-allowed bins (plan 08 §3.1 `dst_ya_*`, the `dst_yards_allowed` indicator family, scored
 * from the defence's yards allowed): Yahoo's 100-yard bins and ESPN's and Sleeper's finer ones.
 * A file lists one contiguous set from 0 to an open-ended bin (QA-2-045).
 */
export const DST_YA_BINS = [
  "dst_ya_0_99",
  "dst_ya_100_199",
  "dst_ya_200_299",
  "dst_ya_300_399",
  "dst_ya_300_349",
  "dst_ya_350_399",
  "dst_ya_400_499",
  "dst_ya_400_449",
  "dst_ya_450_499",
  "dst_ya_500p",
  "dst_ya_500_549",
  "dst_ya_550p",
] as const;

/** What `scoring.overrides` accepts and what it cannot state, for an unknown key (QA-2-045). */
export const OVERRIDES_HINT =
  "overrides take the canonical stat names (pass_yd, rec, fg_40_49, dst_pa_7_13 …), missed-FG " +
  "bins fg_miss_0_19 … fg_miss_50p and yards-allowed bins dst_ya_0_99 … dst_ya_500p (or ESPN's " +
  "dst_ya_300_349 … dst_ya_550p); a per-position value such as a TE premium cannot be stated yet, " +
  "so leave it out and expect that league's TE points to read low";

/** Per-canonical-stat overrides of the preset (`pass_td: 4`). */
const overridesSchema = z
  .object(
    Object.fromEntries(
      [...KNOWN_CANONICAL, ...FG_MISS_BINS, ...DST_YA_BINS].map((c) => [
        c,
        scoringValue.optional(),
      ]),
    ),
  )
  .strict();

export const scoringSchema = z
  .object({
    preset: z.enum(["standard", "half_ppr", "ppr"]),
    overrides: overridesSchema.optional(),
    bonuses: z
      .array(
        z
          .object({
            stat: canonicalEnum,
            target: z.number().gt(0).max(10_000),
            points: scoringValue,
          })
          .strict(),
      )
      .max(32)
      .optional(),
    fractional_points: z.boolean().optional(),
    negative_points: z.boolean().optional(),
  })
  .strict();

export const leagueSchema = z
  .object({
    /** The `manual.l.<key>` slug; default `league`. */
    key: slug.optional(),
    name: text(64),
    season: z.int().min(2000).max(2100),
    num_teams: z.int().min(2).max(32),
    scoring_type: z.enum(["head", "headpoint", "point", "roto"]).optional(),
    start_week: week.optional(),
    end_week: week.optional(),
    /** Overrides the schedule-derived current week (a league without a loaded schedule). */
    current_week: week.optional(),
    lineup_lock: z.enum(["per_game", "weekly"]).optional(),
    uses_median_score: z.boolean().optional(),
    playoffs: z
      .object({
        start_week: week,
        num_teams: z.int().min(2).max(16),
        consolation_teams: z.int().min(0).max(16).optional(),
        reseeding: z.boolean().optional(),
        multiweek_championship: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const rulesSchema = z
  .object({
    waiver_type: z.enum(["faab", "rolling", "reverse_standings", "continual", "none"]).optional(),
    waiver_time_days: z.int().min(0).max(14).optional(),
    faab_budget: z.int().min(0).max(10_000).optional(),
    trade_review: z.enum(["none", "commissioner", "league_vote"]).optional(),
    trade_end_date: isoDate.optional(),
    trade_reject_time_days: z.int().min(0).max(14).optional(),
    can_trade_draft_picks: z.boolean().optional(),
    max_adds: z.int().min(0).max(1000).optional(),
    max_weekly_adds: z.int().min(0).max(100).optional(),
  })
  .strict();

const teamBase = {
  id: teamId,
  name: text(64),
  manager: text(32).optional(),
};

export const transactionSchema = z
  .object({
    type: z.enum(["add", "drop", "add/drop", "trade", "waiver", "commish"]),
    timestamp: isoInstant,
    team: teamId,
    tradee_team: teamId.optional(),
    faab_bid: z.int().min(0).max(10_000).optional(),
    players: z
      .array(
        z
          .object({
            player: rosterEntrySchema,
            action: z.enum(["add", "drop", "trade"]),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();

/** The whole league.yaml. */
export const leagueFileSchema = z
  .object({
    version: z.literal(LEAGUE_FILE_VERSION),
    league: leagueSchema,
    scoring: scoringSchema,
    roster_slots: z
      .array(
        z
          .object({
            name: slotName,
            count: z.int().min(0).max(20),
            eligible: z.array(z.enum(SLOT_POSITIONS)).min(1).max(6).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    rules: rulesSchema.optional(),
    my_team: z.object({ ...teamBase, id: teamId.optional(), players }).strict(),
    other_teams: z
      .array(z.object({ ...teamBase, players: players.optional() }).strict())
      .max(31)
      .optional(),
    opponents: z
      .array(z.object({ week, team: teamId }).strict())
      .max(22)
      .optional(),
    free_agents: z.array(rosterEntrySchema).max(500).optional(),
    waivers: z.array(rosterEntrySchema).max(500).optional(),
    transactions: z.array(transactionSchema).max(500).optional(),
  })
  .strict();

/** A parsed, schema-valid league file. */
export type LeagueFile = z.infer<typeof leagueFileSchema>;
/** One roster entry. */
export type RosterEntryInput = z.infer<typeof rosterEntrySchema>;
/** A player (non-defence) roster entry. */
export type PlayerEntryInput = z.infer<typeof playerEntrySchema>;

/** Formats a zod path as `a.b[2].c` (keys are schema-defined; record keys never occur). */
export function formatPath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const seg of path) {
    if (typeof seg === "number") out += `[${String(seg)}]`;
    else out += out === "" ? String(seg) : `.${String(seg)}`;
  }
  return out === "" ? "$" : out;
}

/** Enum vocabularies longer than this are not spelled out in a reason (the guide lists them). */
const MAX_LISTED_VALUES = 12;

/** The hint for a player entry whose position is not an offensive position or K. */
export const DEFENSE_FORM_HINT = "a team defence is written { defense: TEAM }";

/** Whether the key at `path` is absent from its (present) parent object in the raw document. */
function isAbsent(raw: unknown, path: readonly PropertyKey[]): boolean {
  if (path.length === 0) return false;
  let cur: unknown = raw;
  for (const seg of path.slice(0, -1)) {
    if (typeof seg === "number" && Array.isArray(cur)) cur = cur[seg];
    else if (typeof seg === "string" && isRecord(cur) && Object.hasOwn(cur, seg)) cur = cur[seg];
    else return false;
  }
  const last = path[path.length - 1];
  return typeof last === "string" && isRecord(cur) && !Object.hasOwn(cur, last);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Fixed, value-free reason text for one zod issue. `absent` is true when the issue's key is not in
 * the file at all (a missing or misspelled key), which zod reports as a wrong type or value.
 */
function reasonOf(issue: z.core.$ZodIssue, absent: boolean, path: readonly PropertyKey[]): string {
  if (absent && (issue.code === "invalid_type" || issue.code === "invalid_value"))
    return "required field is missing";
  switch (issue.code) {
    case "invalid_type":
      return `wrong type (expected ${issue.expected})`;
    case "too_big":
      return `too large (maximum ${String(issue.maximum)})`;
    case "too_small":
      return `too small (minimum ${String(issue.minimum)})`;
    case "invalid_format":
      // Every regex in this schema carries a fixed message authored above; other formats are
      // zod's own checks (iso date/datetime) and get a fixed text naming the format.
      return issue.format === "regex" ? issue.message : `invalid format (${issue.format})`;
    case "invalid_value": {
      // The values are the schema's own enum/literal vocabulary, never file content.
      const listed =
        issue.values.length <= MAX_LISTED_VALUES
          ? ` (one of: ${issue.values.map((v) => String(v)).join(", ")})`
          : "";
      const defense = path[path.length - 1] === "position" ? `; ${DEFENSE_FORM_HINT}` : "";
      return `not an allowed value${listed}${defense}`;
    }
    case "unrecognized_keys": {
      const n = `unknown key(s) (${String(issue.keys.length)})`;
      return formatPath(path) === "scoring.overrides" ? `${n}: ${OVERRIDES_HINT}` : n;
    }
    case "invalid_union":
      return "does not match any allowed shape (player: name/team/position, or defense: team)";
    case "not_multiple_of":
      return "not an allowed multiple";
    case "custom":
      // Our refinements' messages are fixed strings authored above; nothing else produces `custom`.
      return issue.message;
    default:
      return "invalid value";
  }
}

/**
 * Value-free issues for a failed parse (plan 01 §8; critic C-13b): a schema path and a fixed reason.
 * Never the input value, never an unknown key's name (a key is file content too). `raw` (the parsed
 * YAML the schema saw) lets an absent key read as missing rather than as a wrong value; it is only
 * probed for key presence, never quoted.
 */
export function issuesOf(error: z.ZodError, raw?: unknown): LeagueFileIssue[] {
  const out: LeagueFileIssue[] = [];
  const walk = (issues: readonly z.core.$ZodIssue[], prefix: readonly PropertyKey[]): void => {
    for (const i of issues) {
      if (out.length >= 50) return;
      const at = [...prefix, ...i.path];
      // A roster entry is a player OR a defence: report the branch the entry came closest to
      // (fewest issues), so `position: LB` reads as a bad position rather than "matches no shape".
      if (i.code === "invalid_union" && i.errors.length > 0) {
        const best = i.errors.reduce((a, b) => (b.length < a.length ? b : a));
        walk(best, at);
        continue;
      }
      const absent = raw !== undefined && isAbsent(raw, at);
      out.push({ path: formatPath(at), reason: reasonOf(i, absent, at) });
    }
  };
  walk(error.issues, []);
  return out;
}
