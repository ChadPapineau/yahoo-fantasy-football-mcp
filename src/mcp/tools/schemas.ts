// schemas.ts — output building blocks every tool's `data` schema composes (plan 01 §4.2
// "zod-typed"; plan 02 §6.2: a UT position admits only the `untrusted_text` wrapper, a bare
// third-party string only where the tool path-lists it; code fields are grammar-checked so they
// cannot carry prose — critic C-15).
import { z } from "zod/v4";
import { GSIS_ID_RE, MANUAL_KEY_RE, NFL_TEAMS, YAHOO_KEY_RE } from "../../config/schema.js";
import { LOG_ID_RE } from "../../domain/reclog/types.js";
import {
  PLATFORM_CODE_RE,
  POSITION_RE,
  SLOT_NAME_RE,
  STATUS_CODE_RE,
  TEAM_ABBR_RE,
} from "../../domain/league/types.js";
import {
  TEXT_CAPS,
  distSchema,
  inputFreshnessSchema,
  untrustedTextSchema,
  type UntrustedText,
} from "../envelope.js";

/** An ISO-8601 instant (≤ 40 chars). */
export const iso = z.iso.datetime({ offset: true }).max(40);
/** A calendar date `YYYY-MM-DD`. */
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** A wrapped UT value (never a bare string). */
export const ut = untrustedTextSchema as unknown as z.ZodType<UntrustedText>;
/** A nullable UT value. */
export const utOrNull = ut.nullable();
/** A bare, path-listed player name (plan 01 §4.2 item 2). */
export const bareName = z.string().max(TEXT_CAPS.player_name);
/** A bare, path-listed recommendation-log text (OBJ-15). */
export const bareRecText = z.string().max(TEXT_CAPS.rec_log_text);

const anyKey = (kind: "league" | "team" | "player") =>
  z.string().refine((k) => YAHOO_KEY_RE[kind].test(k) || MANUAL_KEY_RE[kind].test(k));
/** A league key (either grammar). */
export const leagueKey = anyKey("league");
/** A team key (either grammar). */
export const teamKey = anyKey("team");
/** A player key (either grammar). */
export const playerKey = anyKey("player");
export const gsisId = z.string().regex(GSIS_ID_RE);
/** A recommendation `log_id`. */
export const logIdOut = z.string().regex(LOG_ID_RE);
export const nflTeam = z.enum(NFL_TEAMS);
export const statusCode = z.string().regex(STATUS_CODE_RE);
export const position = z.string().regex(POSITION_RE);
export const slotName = z.string().regex(SLOT_NAME_RE);
export const teamAbbr = z.string().regex(TEAM_ABBR_RE);
export const platformCode = z.string().regex(PLATFORM_CODE_RE);
/** A lowercase code a tool derived itself (`outdoors`, `grass`, `limited`). */
export const code = z.string().regex(/^[a-z][a-z0-9_]{0,23}$/);
/** A canonical stat name. */
export const canonical = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
export const week = z.number().int().min(1).max(22);
export const season = z.number().int().min(1990).max(2100);
export const points = z.number().min(-10_000).max(10_000);
export const prob = z.number().min(0).max(1);
export const dist = distSchema;
export const inputs = z.array(inputFreshnessSchema).max(25);
/** An engine-authored fixed string (drivers, assumptions, verdicts): printable, bounded. */
export const serverText = z.string().max(400);

/** The ownership block (plan 07 C1). */
export const ownership = z.strictObject({
  type: z.enum(["team", "waivers", "freeagents", "unknown"]),
  owner_team_key: teamKey.nullable(),
  owner_name: utOrNull,
  waiver_date: z.string().max(40).nullable(),
});
