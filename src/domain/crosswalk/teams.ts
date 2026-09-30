// teams.ts — the ONE team-abbreviation table the crosswalk maps every spelling through (research 04 §D
// step 2: Yahoo `Jax`/`LV`/`LAR` vs nflverse `JAX`/`LV`/`LA` vs DynastyProcess `JAC`/`LVR`/`LA`; plan 05
// §2 domain/crosswalk "an unknown abbreviation fails loudly").
import { NFL_TEAMS, isNflTeam, type NflTeam } from "../../config/schema.js";

/**
 * Non-nflverse spellings → nflverse abbreviation. Case-insensitive (Yahoo writes `Jax`, `Was`).
 * Covers DynastyProcess/MFL (`JAC`, `LVR`, `NOS`, `GBP`, `KCC`, `NEP`, `SFO`, `TBB`), PFR-style
 * (`GNB`, `KAN`, `NOR`, `NWE`, `SDG`, `TAM`), PFF (`ARZ`, `BLT`, `CLV`, `HST`), ESPN/Yahoo (`WSH`,
 * `LAR`), and relocated franchises (`OAK`, `SD`, `STL`, `WFT`).
 */
export const TEAM_ALIASES: Readonly<Record<string, NflTeam>> = Object.freeze({
  ARZ: "ARI",
  BLT: "BAL",
  CLV: "CLE",
  GBP: "GB",
  GNB: "GB",
  HST: "HOU",
  JAC: "JAX",
  KAN: "KC",
  KCC: "KC",
  LAR: "LA",
  LVR: "LV",
  NEP: "NE",
  NOR: "NO",
  NOS: "NO",
  NWE: "NE",
  OAK: "LV",
  SD: "LAC",
  SDG: "LAC",
  SFO: "SF",
  STL: "LA",
  TAM: "TB",
  TBB: "TB",
  WFT: "WAS",
  WSH: "WAS",
});

const TEAM_TABLE: ReadonlyMap<string, NflTeam> = new Map<string, NflTeam>([
  ...NFL_TEAMS.map((t): [string, NflTeam] => [t, t]),
  ...Object.entries(TEAM_ALIASES),
]);

const ABBR_RE = /^[A-Za-z]{2,4}$/;

/** Maps any known spelling to the nflverse abbreviation; null for unknown or malformed input. */
export function normalizeTeam(abbr: unknown): NflTeam | null {
  if (typeof abbr !== "string") return null;
  const a = abbr.trim();
  if (!ABBR_RE.test(a)) return null;
  const team = TEAM_TABLE.get(a.toUpperCase()) ?? null;
  return team !== null && isNflTeam(team) ? team : null;
}

/** Like `normalizeTeam` but throws RangeError on an unknown abbreviation (the loud failure). */
export function requireNflTeam(abbr: unknown): NflTeam {
  const team = normalizeTeam(abbr);
  if (team === null) {
    const shown = typeof abbr === "string" && ABBR_RE.test(abbr.trim()) ? ` '${abbr.trim()}'` : "";
    throw new RangeError(`crosswalk: unknown team abbreviation${shown}`);
  }
  return team;
}

/** Every spelling the table accepts (upper case), for tests and diagnostics. */
export function knownTeamSpellings(): readonly string[] {
  return [...TEAM_TABLE.keys()].sort();
}
