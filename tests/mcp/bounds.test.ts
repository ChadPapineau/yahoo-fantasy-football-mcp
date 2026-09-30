// bounds.test.ts — src/mcp/bounds.ts (plan 02 §5 bounds and key grammar; plan 05 §2
// `providers/yahoo/path`-style mutations applied to the grammar itself; plan 07 legend
// `PlayerSelector`). Boundaries ±1, NaN, ±Infinity, -0, fractions, numeric strings, unicode and
// full-width digits, hostile separators, and generated keys (fast-check).
import fc from "fast-check";
import { z } from "zod/v4";
import { describe, expect, it } from "vitest";
import {
  BOUNDS,
  GSIS_ID_RE,
  INVALID_KEY_MESSAGE,
  MANUAL_KEY_RE,
  NFL_TEAMS,
  YAHOO_KEY_RE,
  boundedTextSchema,
  clientRefSchema,
  commonInputShape,
  detailSchema,
  faabBidSchema,
  gsisIdSchema,
  isLeagueKey,
  isManualKey,
  isPlayerKey,
  isTeamKey,
  isYahooKey,
  isoInstantSchema,
  keyPlatform,
  leagueKeySchema,
  leagueOfTeam,
  limitSchema,
  nSimsSchema,
  nflTeamSchema,
  offsetSchema,
  pageInputShape,
  playerKeySchema,
  playerKeysSchema,
  playerSelectorSchema,
  searchQuerySchema,
  seasonSchema,
  teamKeySchema,
  txnCountSchema,
  weekSchema,
} from "../../src/mcp/bounds.js";

const ok = (s: z.ZodType, v: unknown) => s.safeParse(v).success;

describe("numeric bounds (plan 02 §5)", () => {
  const cases: [string, z.ZodType, number, number][] = [
    ["week", weekSchema, 1, 22],
    ["season", seasonSchema, 2001, 2100],
    ["limit", limitSchema, 1, 100],
    ["offset", offsetSchema, 0, 10_000],
    ["txn count", txnCountSchema, 1, 200],
    ["faab bid", faabBidSchema, 0, 1000],
    ["n_sims", nSimsSchema, 1000, 20_000],
  ];
  it.each(cases)("%s accepts [min, max] and rejects min-1 / max+1", (_n, s, min, max) => {
    expect(ok(s, min)).toBe(true);
    expect(ok(s, max)).toBe(true);
    expect(ok(s, Math.floor((min + max) / 2))).toBe(true);
    expect(ok(s, min - 1)).toBe(false);
    expect(ok(s, max + 1)).toBe(false);
  });
  it.each(cases)(
    "%s rejects NaN, ±Infinity, fractions, numeric strings, bigint, null, huge",
    (_n, s, min) => {
      for (const bad of [
        NaN,
        Infinity,
        -Infinity,
        min + 0.5,
        String(min),
        BigInt(min),
        null,
        true,
        1e308,
        -1e308,
        [min],
      ]) {
        expect(ok(s, bad)).toBe(false);
      }
    },
  );
  it("defaults: limit 25, offset 0, count 25, n_sims 4000, detail compact", () => {
    expect(limitSchema.parse(undefined)).toBe(25);
    expect(offsetSchema.parse(undefined)).toBe(0);
    expect(txnCountSchema.parse(undefined)).toBe(25);
    expect(nSimsSchema.parse(undefined)).toBe(4000);
    expect(detailSchema.parse(undefined)).toBe("compact");
    expect(ok(detailSchema, "verbose")).toBe(false);
  });
  it("-0 is below week's minimum", () => {
    expect(ok(weekSchema, -0)).toBe(false);
  });
  it("the BOUNDS table is frozen and its defaults sit inside their ranges", () => {
    expect(Object.isFrozen(BOUNDS)).toBe(true);
    for (const v of Object.values(BOUNDS)) {
      if (typeof v === "object" && "default" in v && "min" in v && "max" in v) {
        expect(v.default).toBeGreaterThanOrEqual(v.min);
        expect(v.default).toBeLessThanOrEqual(v.max);
      }
    }
  });
});

// --- key grammar -----------------------------------------------------------------------------------

const VALID = {
  league: ["461.l.1000", "1.l.1", "9999.l.10001"],
  team: ["461.l.1000.t.1", "461.l.1000.t.123"],
  player: ["461.p.7200", "1.p.1", "9999.p.12345678"],
} as const;

/** The 12 mutations of plan 05 §2 (`L` for `l`, `1` for `l`, `..`, `;`, `/`, `?`, `#`, whitespace,
 *  unicode digits, empty, 40-digit ids, `nfl.p.x`) plus a few more. */
function mutations(key: string): string[] {
  return [
    key.replace(".l.", ".L.").replace(".p.", ".P."),
    key.replace(".l.", ".1.").replace(".p.", ".1."),
    key.replace(".", ".."),
    `${key};out=stats`,
    `${key}/stats`,
    `${key}?format=json`,
    `${key}#frag`,
    ` ${key}`,
    `${key} `,
    `${key}\n`,
    `${key}\t`,
    key.replace(/[0-9]/, "٤"),
    key.replace(/[0-9]/, "４"),
    "",
    key.replace(/[0-9]+$/, "1".repeat(40)),
    "nfl.p.x",
    key.replace(/^[0-9]+/, "nfl"),
    `${key}​`,
    `‮${key}`,
    key.toUpperCase(),
    `${key}.`,
    `.${key}`,
    key.replace(/[0-9]+$/, "-1"),
    key.replace(/[0-9]+$/, "0x1f"),
  ].filter((m) => m !== key);
}

describe("Yahoo key grammar (plan 02 §5 table)", () => {
  it.each(Object.entries(VALID))("%s: canonical examples pass", (kind, keys) => {
    for (const k of keys) expect(isYahooKey(kind as keyof typeof YAHOO_KEY_RE, k)).toBe(true);
  });
  it.each([...VALID.league, ...VALID.team, ...VALID.player])(
    "every mutation of %s is rejected by its grammar",
    (key) => {
      const kind = key.includes(".t.") ? "team" : key.includes(".p.") ? "player" : "league";
      for (const m of mutations(key))
        expect(YAHOO_KEY_RE[kind].test(m), JSON.stringify(m)).toBe(false);
    },
  );
  it("game, transaction and waiver-claim grammars", () => {
    expect(isYahooKey("game", "nfl")).toBe(true);
    expect(isYahooKey("game", "461")).toBe(true);
    expect(isYahooKey("game", "NFL")).toBe(false);
    expect(isYahooKey("game", "12345")).toBe(false);
    expect(isYahooKey("transaction", "461.l.1000.tr.123")).toBe(true);
    expect(isYahooKey("transaction", "461.l.1000.pt.1")).toBe(true);
    expect(isYahooKey("transaction", "461.l.1000.xx.1")).toBe(false);
    expect(isYahooKey("waiver_claim", "461.l.1000.w.c.2_6461")).toBe(true);
    expect(isYahooKey("waiver_claim", "461.l.1000.w.c.2-6461")).toBe(false);
  });
  it("property: generated valid keys pass; one injected hostile char always fails", () => {
    const num = (w: number) => fc.integer({ min: 0, max: 10 ** w - 1 }).map(String);
    const league = fc.tuple(num(4), num(8)).map(([g, l]) => `${g}.l.${l}`);
    const team = fc.tuple(league, num(3)).map(([l, t]) => `${l}.t.${t}`);
    const player = fc.tuple(num(4), num(8)).map(([g, p]) => `${g}.p.${p}`);
    const hostile = fc.constantFrom(";", "/", "?", "#", " ", "..", "\u0000", "٤", "L", "%2F", "​");
    fc.assert(
      fc.property(fc.oneof(league, team, player), hostile, fc.nat(), (key, bad, at) => {
        const kind = key.includes(".t.") ? "team" : key.includes(".p.") ? "player" : "league";
        if (!YAHOO_KEY_RE[kind].test(key)) return false;
        const i = at % (key.length + 1);
        const mutated = key.slice(0, i) + bad + key.slice(i);
        return !YAHOO_KEY_RE[kind].test(mutated);
      }),
    );
  });
});

describe("manual-league id grammar (plan 01 §8 X1)", () => {
  it("accepts slugs, team suffixes and player ids", () => {
    for (const k of ["manual.l.example", "manual.l.a", "manual.l.example-league-2026"])
      expect(isManualKey("league", k)).toBe(true);
    expect(isManualKey("team", "manual.l.example.t.1")).toBe(true);
    for (const k of ["manual.p.00-0033873", "manual.p.kicker_1", "manual.p.A"])
      expect(isManualKey("player", k)).toBe(true);
  });
  it.each([
    "manual.l.",
    "manual.l.-x",
    "manual.l.x-",
    "manual.l.Example",
    "manual.l.ex ample",
    "manual.l.ex_ample",
    `manual.l.${"a".repeat(33)}`,
    "manual.l.x;drop",
    "manual.l.x/../y",
    "manual.l.é",
    "Manual.l.x",
    "manual.L.x",
  ])("rejects league %j", (k) => {
    expect(isManualKey("league", k)).toBe(false);
    expect(isLeagueKey(k)).toBe(false);
  });
  it.each([
    "manual.p.",
    "manual.p.-x",
    "manual.p.x.y",
    `manual.p.${"a".repeat(33)}`,
    "manual.p.x y",
    "manual.p.٤",
  ])("rejects player %j", (k) => {
    expect(isManualKey("player", k)).toBe(false);
  });
  it("MANUAL_KEY_RE is anchored", () => {
    expect(MANUAL_KEY_RE.league.test("xmanual.l.example")).toBe(false);
    expect(MANUAL_KEY_RE.league.test("manual.l.example\n")).toBe(false);
  });
});

describe("key helpers", () => {
  it("keyPlatform identifies the grammar", () => {
    expect(keyPlatform("league", "461.l.1000")).toBe("yahoo");
    expect(keyPlatform("league", "manual.l.example")).toBe("manual");
    expect(keyPlatform("league", "espn.l.1")).toBeNull();
    expect(isTeamKey("manual.l.example.t.2")).toBe(true);
    expect(isPlayerKey("461.p.1")).toBe(true);
    expect(isPlayerKey("461.l.1000")).toBe(false);
  });
  it("leagueOfTeam returns the owning league, or null", () => {
    expect(leagueOfTeam("461.l.1000.t.12")).toBe("461.l.1000");
    expect(leagueOfTeam("manual.l.example.t.3")).toBe("manual.l.example");
    expect(leagueOfTeam("461.l.1000")).toBeNull();
    expect(leagueOfTeam("461.l.1000.t.1;x")).toBeNull();
  });
});

describe("key schemas raise the INVALID_KEY marker", () => {
  it.each([
    [leagueKeySchema, "461.l.1000", "461.l.1000.t.1"],
    [teamKeySchema, "461.l.1000.t.1", "461.l.1000"],
    [playerKeySchema, "461.p.1", "nfl.p.x"],
    [gsisIdSchema, "00-0033873", "00-003387"],
  ] as const)("%#", (schema, good, bad) => {
    expect(ok(schema, good)).toBe(true);
    const r = schema.safeParse(bad);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe(INVALID_KEY_MESSAGE);
  });
  it("key schemas cap length before the regex runs", () => {
    expect(ok(leagueKeySchema, `461.l.${"1".repeat(100)}`)).toBe(false);
    expect(ok(leagueKeySchema, 461)).toBe(false);
  });
  it("gsis ids are exactly 00-NNNNNNN", () => {
    for (const bad of ["00-00338733", "0-0033873", "00_0033873", " 00-0033873", "00-003387٣"]) {
      expect(GSIS_ID_RE.test(bad)).toBe(false);
    }
  });
});

describe("player key lists and selectors (plan 02 §5 ≤ 25; plan 07 PlayerSelector)", () => {
  const keys = (n: number) => Array.from({ length: n }, (_, i) => `461.p.${String(i + 1)}`);
  it("player_keys: 1..25 distinct", () => {
    expect(ok(playerKeysSchema, keys(1))).toBe(true);
    expect(ok(playerKeysSchema, keys(25))).toBe(true);
    expect(ok(playerKeysSchema, keys(26))).toBe(false);
    expect(ok(playerKeysSchema, [])).toBe(false);
    expect(ok(playerKeysSchema, ["461.p.1", "461.p.1"])).toBe(false);
    expect(ok(playerKeysSchema, ["461.p.1", "461.P.2"])).toBe(false);
  });
  it("a selector is exactly one of its four forms", () => {
    expect(ok(playerSelectorSchema, { player_keys: keys(3) })).toBe(true);
    expect(ok(playerSelectorSchema, { gsis_ids: ["00-0033873"] })).toBe(true);
    expect(ok(playerSelectorSchema, { team_key: "461.l.1000.t.1" })).toBe(true);
    expect(ok(playerSelectorSchema, { nfl_team: "KC" })).toBe(true);
    expect(ok(playerSelectorSchema, { player_keys: keys(1), team_key: "461.l.1000.t.1" })).toBe(
      false,
    );
    expect(ok(playerSelectorSchema, {})).toBe(false);
    expect(ok(playerSelectorSchema, { nfl_team: "kc" })).toBe(false);
    expect(ok(playerSelectorSchema, { nfl_team: "KC", extra: 1 })).toBe(false);
    expect(
      ok(playerSelectorSchema, {
        gsis_ids: Array.from({ length: 26 }, (_, i) => `00-${String(i).padStart(7, "0")}`),
      }),
    ).toBe(false);
    expect(ok(playerSelectorSchema, { gsis_ids: ["00-0033873", "00-0033873"] })).toBe(false);
  });
  it("the NFL team list is the 32 nflverse abbreviations", () => {
    expect(NFL_TEAMS).toHaveLength(32);
    expect(new Set(NFL_TEAMS).size).toBe(32);
    expect(ok(nflTeamSchema, "LA")).toBe(true);
    expect(ok(nflTeamSchema, "LAR")).toBe(false);
    expect(ok(nflTeamSchema, "OAK")).toBe(false);
  });
});

describe("text inputs", () => {
  it("search: trimmed, 1..64, printable only", () => {
    expect(searchQuerySchema.parse("  Justin Tucker  ")).toBe("Justin Tucker");
    expect(ok(searchQuerySchema, "D'Andre Swift-Jaé")).toBe(true);
    expect(ok(searchQuerySchema, "a".repeat(64))).toBe(true);
    expect(ok(searchQuerySchema, "a".repeat(65))).toBe(false);
    expect(ok(searchQuerySchema, "   ")).toBe(false);
    expect(ok(searchQuerySchema, "")).toBe(false);
    for (const bad of [
      "a\u0000b",
      "a\nb",
      "a‮b",
      "a​b",
      "a⁦b",
      "a­b",
      "a\u{e0041}b",
      "a\ud800b",
      "ab",
    ]) {
      expect(ok(searchQuerySchema, bad), JSON.stringify(bad)).toBe(false);
    }
  });
  it("boundedTextSchema caps and rejects controls/bidi", () => {
    const s = boundedTextSchema(BOUNDS.recNoteChars);
    expect(ok(s, "x".repeat(200))).toBe(true);
    expect(ok(s, "x".repeat(201))).toBe(false);
    expect(ok(s, "ok ‮ evil")).toBe(false);
    expect(ok(s, "emoji \u{1F600} fine")).toBe(true);
  });
  it("client_ref: ≤ 64 of a narrow charset", () => {
    expect(ok(clientRefSchema, "wk4:lineup-1")).toBe(true);
    expect(ok(clientRefSchema, "a".repeat(65))).toBe(false);
    expect(ok(clientRefSchema, "a b")).toBe(false);
    expect(ok(clientRefSchema, "")).toBe(false);
  });
  it("ISO instants", () => {
    expect(ok(isoInstantSchema, "2026-09-30T15:46:00Z")).toBe(true);
    expect(ok(isoInstantSchema, "2026-09-30T15:46:00-04:00")).toBe(true);
    expect(ok(isoInstantSchema, "2026-09-30")).toBe(false);
    expect(ok(isoInstantSchema, "yesterday")).toBe(false);
  });
});

describe("shared input shapes (plan 07 §2)", () => {
  const schema = z.strictObject({ ...commonInputShape, ...pageInputShape });
  it("applies defaults and stays strict", () => {
    expect(schema.parse({})).toEqual({ limit: 25, offset: 0, detail: "compact" });
    expect(
      schema.parse({
        league_key: "manual.l.example",
        force_refresh: true,
        allow_stale: false,
        detail: "full",
      }),
    ).toEqual({
      league_key: "manual.l.example",
      force_refresh: true,
      allow_stale: false,
      detail: "full",
      limit: 25,
      offset: 0,
    });
    expect(ok(schema, { unknown: 1 })).toBe(false);
    expect(ok(schema, { league_key: "461.l.1000;" })).toBe(false);
    expect(ok(schema, { force_refresh: "true" })).toBe(false);
  });
});
