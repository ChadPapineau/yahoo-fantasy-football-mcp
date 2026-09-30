// ids.ts — platform player-id grammars and the platform-native id the crosswalk looks up in nflverse
// `roster_weekly` (research 04 §D step 1: Yahoo `nfl.p.7200` / `461.p.7200` ↔ `yahoo_id` 7200); the
// manual key rule `manual.p.<gsis_id>` (plan 01 §8 X1; league/types.ts manualPlayerKeyFor).
import { MANUAL_KEY_RE, isNflTeam, type NflTeam } from "../../config/schema.js";
import type { PlatformId } from "../league/types.js";

/**
 * The player-id grammar per platform, as the overrides file and the matcher accept it. Yahoo keys
 * may carry any game prefix (`nfl`, `461`): the player number is what identifies the player across
 * seasons. Sleeper and ESPN player ids are numeric strings.
 */
export const PLATFORM_PLAYER_ID_RE: Readonly<Record<PlatformId, RegExp>> = Object.freeze({
  yahoo: /^(?:nfl|[0-9]{1,4})\.p\.([0-9]{1,8})$/,
  manual: MANUAL_KEY_RE.player,
  sleeper: /^([0-9]{1,12})$/,
  espn: /^([0-9]{1,12})$/,
});

/** Whether `id` is a well-formed player id for `platform`. */
export function isPlatformPlayerId(platform: PlatformId, id: unknown): id is string {
  return typeof id === "string" && id.length <= 64 && PLATFORM_PLAYER_ID_RE[platform].test(id);
}

/**
 * The id the platform's column in `roster_weekly` holds for this player key: Yahoo's player number,
 * Sleeper's/ESPN's id itself; null for the manual platform (its key carries a gsis id instead) and
 * for malformed keys.
 */
export function nativePlayerId(platform: PlatformId, id: string): string | null {
  if (platform === "manual" || id.length > 64) return null;
  const m = PLATFORM_PLAYER_ID_RE[platform].exec(id);
  return m?.[1] ?? null;
}

/**
 * The identity two ids of one platform are compared by: Yahoo's player number (so an override
 * written as `nfl.p.30977` applies to `461.p.30977`), otherwise the id itself. Null when malformed.
 */
export function canonicalPlayerId(platform: PlatformId, id: string): string | null {
  if (!isPlatformPlayerId(platform, id)) return null;
  return platform === "yahoo" ? nativePlayerId(platform, id) : id;
}

const MANUAL_GSIS_RE = /^manual\.p\.(00-[0-9]{7})$/;
const MANUAL_DEF_RE = /^manual\.p\.def-([a-z]{2,3})$/;

/** The gsis id a manual player key carries (`manual.p.00-0034857`), else null. */
export function gsisFromManualKey(id: string): string | null {
  return MANUAL_GSIS_RE.exec(id)?.[1] ?? null;
}

/** The team a manual defence key names (`manual.p.def-kc` → `KC`), else null. */
export function teamFromManualDefKey(id: string): NflTeam | null {
  const t = MANUAL_DEF_RE.exec(id)?.[1]?.toUpperCase();
  return t !== undefined && isNflTeam(t) ? t : null;
}
