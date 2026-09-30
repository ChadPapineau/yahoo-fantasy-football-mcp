// tables.test.ts — src/domain/crosswalk/{teams,positions,ids}.ts: the one team-abbreviation table
// (research 04 §D: JAX/JAC, LV/LVR, LA/LAR, WAS/WSH; plan 05 §2 "unknown abbreviation fails
// loudly"), position families, platform id grammars and the manual key rules.
import { describe, expect, it } from "vitest";
import { NFL_TEAMS, isNflTeam } from "../../../src/config/schema.js";
import {
  PLATFORM_PLAYER_ID_RE,
  canonicalPlayerId,
  gsisFromManualKey,
  isPlatformPlayerId,
  nativePlayerId,
  teamFromManualDefKey,
} from "../../../src/domain/crosswalk/ids.js";
import {
  POSITION_FAMILIES,
  positionFamily,
  samePositionFamily,
} from "../../../src/domain/crosswalk/positions.js";
import {
  TEAM_ALIASES,
  knownTeamSpellings,
  normalizeTeam,
  requireNflTeam,
} from "../../../src/domain/crosswalk/teams.js";
import { manualPlayerKeyFor } from "../../../src/domain/league/types.js";
import { FIXTURE, YAHOO_SPELLING } from "./helpers.js";

describe("normalizeTeam", () => {
  it("maps every nflverse abbreviation to itself, in any case", () => {
    for (const t of NFL_TEAMS) {
      expect(normalizeTeam(t)).toBe(t);
      expect(normalizeTeam(t.toLowerCase())).toBe(t);
    }
  });

  it.each([
    ["JAC", "JAX"],
    ["Jax", "JAX"],
    ["jac", "JAX"],
    ["LVR", "LV"],
    ["LV", "LV"],
    ["OAK", "LV"],
    ["LAR", "LA"],
    ["LA", "LA"],
    ["STL", "LA"],
    ["LAC", "LAC"],
    ["SD", "LAC"],
    ["SDG", "LAC"],
    ["WSH", "WAS"],
    ["Was", "WAS"],
    ["WFT", "WAS"],
    ["NOS", "NO"],
    ["NOR", "NO"],
    ["GBP", "GB"],
    ["GNB", "GB"],
    ["KCC", "KC"],
    ["KAN", "KC"],
    ["NEP", "NE"],
    ["NWE", "NE"],
    ["SFO", "SF"],
    ["TBB", "TB"],
    ["TAM", "TB"],
    ["ARZ", "ARI"],
    ["BLT", "BAL"],
    ["CLV", "CLE"],
    ["HST", "HOU"],
    [" Det ", "DET"],
  ])("%j → %s", (abbr, want) => {
    expect(normalizeTeam(abbr)).toBe(want);
  });

  it("covers every team spelling the fixtures use", () => {
    for (const p of FIXTURE.players) {
      expect(normalizeTeam(p.team)).toBe(p.team);
      if (p.team_2025 !== null) expect(normalizeTeam(p.team_2025)).toBe(p.team_2025);
    }
    for (const d of FIXTURE.defenses) expect(normalizeTeam(d.team)).toBe(d.team);
    for (const [team, spelling] of Object.entries(YAHOO_SPELLING)) {
      expect(normalizeTeam(spelling)).toBe(team);
    }
  });

  it.each([
    "XYZ",
    "FA",
    "",
    "J",
    "JAXX1",
    "L.V.",
    "N0",
    "ＪＡＸ",
    "JAX​",
    "__proto__",
    "constructor",
    "toString",
  ])("returns null for unknown or malformed %j", (abbr) => {
    expect(normalizeTeam(abbr)).toBeNull();
  });

  it("returns null for non-strings", () => {
    expect(normalizeTeam(null)).toBeNull();
    expect(normalizeTeam(undefined)).toBeNull();
    expect(normalizeTeam(7)).toBeNull();
  });

  it("every alias targets a real nflverse team, and no alias shadows one", () => {
    for (const [alias, team] of Object.entries(TEAM_ALIASES)) {
      expect(isNflTeam(team)).toBe(true);
      expect(isNflTeam(alias)).toBe(false);
    }
    expect(knownTeamSpellings()).toHaveLength(NFL_TEAMS.length + Object.keys(TEAM_ALIASES).length);
  });
});

describe("requireNflTeam (the loud failure)", () => {
  it("returns the team for a known spelling", () => {
    expect(requireNflTeam("Jax")).toBe("JAX");
  });

  it("throws RangeError naming a well-formed unknown code", () => {
    expect(() => requireNflTeam("XYZ")).toThrow(
      new RangeError("crosswalk: unknown team abbreviation 'XYZ'"),
    );
  });

  it("throws without echoing malformed input", () => {
    expect(() => requireNflTeam("<script>")).toThrow(
      new RangeError("crosswalk: unknown team abbreviation"),
    );
    expect(() => requireNflTeam(null)).toThrow(RangeError);
  });
});

describe("position families", () => {
  it.each([
    ["FB", "RB"],
    ["HB", "RB"],
    ["rb", "RB"],
    ["PK", "K"],
    ["K", "K"],
    ["CB", "DB"],
    ["SAF", "DB"],
    ["S", "DB"],
    ["OLB", "LB"],
    ["DE", "DL"],
    ["QB", "QB"],
    ["TE", "TE"],
  ])("%s is in family %s", (pos, fam) => {
    expect(positionFamily(pos)).toBe(fam);
  });

  it("keeps skill positions apart", () => {
    expect(samePositionFamily("WR", "TE")).toBe(false);
    expect(samePositionFamily("QB", "RB")).toBe(false);
    expect(samePositionFamily("RB", "FB")).toBe(true);
    expect(samePositionFamily("K", "P")).toBe(false);
  });

  it("unknown or malformed positions never match anything, not even themselves", () => {
    expect(positionFamily("DEF")).toBeNull();
    expect(positionFamily("W/R/T")).toBeNull();
    expect(positionFamily("BN")).toBeNull();
    expect(positionFamily("__proto__")).toBeNull();
    expect(positionFamily("WRWRWRWRWR")).toBeNull();
    expect(positionFamily(null)).toBeNull();
    expect(samePositionFamily("XX", "XX")).toBe(false);
  });

  it("every family is itself a position of that family", () => {
    for (const fam of new Set(Object.values(POSITION_FAMILIES)))
      expect(positionFamily(fam)).toBe(fam);
  });

  it("covers every fixture position", () => {
    for (const p of FIXTURE.players) expect(positionFamily(p.position)).toBe(p.position);
  });
});

describe("platform player ids", () => {
  it("accepts each platform's grammar", () => {
    expect(isPlatformPlayerId("yahoo", "461.p.30977")).toBe(true);
    expect(isPlatformPlayerId("yahoo", "nfl.p.30977")).toBe(true);
    expect(isPlatformPlayerId("manual", "manual.p.00-0034857")).toBe(true);
    expect(isPlatformPlayerId("sleeper", "4984")).toBe(true);
    expect(isPlatformPlayerId("espn", "3918298")).toBe(true);
  });

  it.each([
    ["yahoo", "461.p."],
    ["yahoo", "461.l.1000"],
    ["yahoo", "12345.p.1"],
    ["yahoo", "461.p.123456789"],
    ["yahoo", " 461.p.1"],
    ["manual", "manual.p."],
    ["manual", "461.p.1"],
    ["sleeper", "KC"],
    ["sleeper", "4984 "],
    ["espn", "-16001"],
    ["espn", "1".repeat(13)],
  ] as const)("%s rejects %j", (platform, id) => {
    expect(isPlatformPlayerId(platform, id)).toBe(false);
    expect(canonicalPlayerId(platform, id)).toBeNull();
  });

  it("rejects non-strings and huge strings", () => {
    expect(isPlatformPlayerId("sleeper", 4984)).toBe(false);
    expect(isPlatformPlayerId("sleeper", "1".repeat(100_000))).toBe(false);
    expect(nativePlayerId("sleeper", "1".repeat(100_000))).toBeNull();
  });

  it("extracts the native id per platform", () => {
    expect(nativePlayerId("yahoo", "461.p.30977")).toBe("30977");
    expect(nativePlayerId("yahoo", "nfl.p.30977")).toBe("30977");
    expect(nativePlayerId("yahoo", "461.l.1000")).toBeNull();
    expect(nativePlayerId("sleeper", "4984")).toBe("4984");
    expect(nativePlayerId("espn", "3918298")).toBe("3918298");
    expect(nativePlayerId("manual", "manual.p.00-0034857")).toBeNull();
  });

  it("compares Yahoo keys across game prefixes, other platforms verbatim", () => {
    expect(canonicalPlayerId("yahoo", "461.p.30977")).toBe(
      canonicalPlayerId("yahoo", "nfl.p.30977"),
    );
    expect(canonicalPlayerId("yahoo", "449.p.30977")).toBe("30977");
    expect(canonicalPlayerId("manual", "manual.p.00-0034857")).toBe("manual.p.00-0034857");
    expect(canonicalPlayerId("sleeper", "4984")).toBe("4984");
  });

  it("every grammar is anchored", () => {
    for (const re of Object.values(PLATFORM_PLAYER_ID_RE)) {
      expect(re.source.startsWith("^")).toBe(true);
      expect(re.source.endsWith("$")).toBe(true);
    }
  });
});

describe("manual keys", () => {
  it("round-trips manualPlayerKeyFor for players and every team defence", () => {
    for (const p of FIXTURE.players) {
      expect(gsisFromManualKey(manualPlayerKeyFor({ kind: "player", gsis_id: p.gsis_id }))).toBe(
        p.gsis_id,
      );
    }
    for (const t of NFL_TEAMS) {
      expect(teamFromManualDefKey(manualPlayerKeyFor({ kind: "defense", nfl_team: t }))).toBe(t);
    }
  });

  it("rejects look-alikes", () => {
    expect(gsisFromManualKey("manual.p.00-003485")).toBeNull();
    expect(gsisFromManualKey("manual.p.josh-allen")).toBeNull();
    expect(gsisFromManualKey("461.p.00-0034857")).toBeNull();
    expect(teamFromManualDefKey("manual.p.def-xyz")).toBeNull();
    expect(teamFromManualDefKey("manual.p.def-KC")).toBeNull();
    expect(teamFromManualDefKey("manual.p.def-kc-2")).toBeNull();
    expect(teamFromManualDefKey("manual.p.00-0034857")).toBeNull();
  });
});
