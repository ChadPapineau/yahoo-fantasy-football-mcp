// matcher.test.ts — src/domain/crosswalk/matcher.ts: plan 10 A5a (every fixture player resolves or is
// listed unmatched; an id-less rookie resolves by name + team + position; name-only is rejected; a
// persisted pair survives a team change), research 04 §D precedence and traps, plan 05 §2 row.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MATCH_CONFIDENCE,
  MAX_REPORTED_CANDIDATES,
  TOP_OWNED_PERCENT,
  buildRosterIndex,
  crosswalkStatus,
  isTeamUnit,
  resolveCrosswalk,
  subjectOf,
  type CrosswalkResolution,
  type CrosswalkRun,
  type CrosswalkRunInput,
} from "../../../src/domain/crosswalk/matcher.js";
import type {
  CrosswalkOverride,
  CrosswalkPair,
  NflRosterPlayer,
} from "../../../src/domain/crosswalk/types.js";
import type { PlatformPlayer } from "../../../src/domain/league/types.js";
import {
  FIXTURE,
  LATER,
  MemPairs,
  NOW,
  fixtureRosterRows,
  fx,
  pp,
  row,
  rosterRow,
  yahooPlayer,
} from "./helpers.js";

function run(
  players: readonly PlatformPlayer[],
  rows: readonly NflRosterPlayer[] = fixtureRosterRows(),
  extra: Partial<CrosswalkRunInput> = {},
): CrosswalkRun {
  return resolveCrosswalk({
    platform: players[0]?.ref.platform ?? "yahoo",
    players,
    roster: buildRosterIndex(rows),
    overrides: [],
    persisted: new MemPairs(),
    now: NOW,
    ...extra,
  });
}

function only(r: CrosswalkRun): CrosswalkResolution {
  expect(r.resolved).toHaveLength(1);
  return r.resolved[0]!.resolution;
}

function gsisOf(res: CrosswalkResolution): string | null {
  return res.status === "matched" ? res.pair.gsis_id : null;
}

function pair(
  edit: Partial<CrosswalkPair> & { platform_player_id: string; gsis_id: string },
): CrosswalkPair {
  return {
    platform: "yahoo",
    method: "match",
    source: "nflverse:roster_weekly",
    confidence: MATCH_CONFIDENCE.jerseyAgrees,
    first_seen: "2026-09-01T00:00:00.000Z",
    last_seen: "2026-09-01T00:00:00.000Z",
    ...edit,
  };
}

function override(platform_player_id: string, gsis_id: string): CrosswalkOverride {
  return { platform: "yahoo", platform_player_id, gsis_id, note: null };
}

// --- A5a -------------------------------------------------------------------------------------------

describe("A5a — the fixture roster", () => {
  it("reports method and confidence and the subject for a matched player", () => {
    const allen = fx("Josh Allen");
    const res = only(run([yahooPlayer(allen)]));
    expect(crosswalkStatus(res)).toEqual({ method: "id", confidence: 1 });
    expect(subjectOf(res)).toEqual({ kind: "player", gsis_id: allen.gsis_id });
  });

  it("every fixture player resolves on Yahoo (id when nflverse has one, else name+team+position)", () => {
    const players = FIXTURE.players.map((p) => yahooPlayer(p));
    const r = run(players);
    expect(r.report.unmatched_rostered).toEqual([]);
    expect(r.report.matched).toBe(FIXTURE.players.length);
    FIXTURE.players.forEach((p, i) => {
      const res = r.resolved[i]!.resolution;
      expect(gsisOf(res)).toBe(p.gsis_id);
      if (res.status !== "matched") throw new Error("unreachable");
      if (p.yahoo_id !== null) {
        expect(res.pair).toMatchObject({
          method: "id",
          source: "nflverse:roster_weekly",
          confidence: 1,
        });
      } else {
        expect(res.pair).toMatchObject({ method: "match", source: "nflverse:roster_weekly" });
        expect(res.evidence).toEqual(["name", "team", "position", "jersey"]);
        expect(res.pair.confidence).toBe(MATCH_CONFIDENCE.jerseyAgrees);
      }
      expect(res.pair.first_seen).toBe(NOW);
      expect(res.changed).toBe(true);
    });
    expect(r.changed).toHaveLength(FIXTURE.players.length);
    expect(r.unchanged_ids).toEqual([]);
    expect(r.diagnostics).toEqual([]);
  });

  it("every fixture player resolves on the manual platform by the gsis id in the YAML", () => {
    const players = FIXTURE.players.map((p) =>
      pp("manual", `manual.p.${p.gsis_id}`, {
        name: p.name,
        team_abbr: p.team,
        position: p.position,
        gsis_hint: p.gsis_id,
      }),
    );
    const r = run(players);
    expect(r.report.matched).toBe(FIXTURE.players.length);
    for (const [i, p] of FIXTURE.players.entries()) {
      const res = r.resolved[i]!.resolution;
      expect(res).toMatchObject({
        status: "matched",
        pair: {
          platform: "manual",
          gsis_id: p.gsis_id,
          method: "id",
          source: "platform",
          confidence: 1,
        },
      });
    }
  });

  it("a manual key alone (no gsis_hint) is exact too", () => {
    const p = fx("Denzel Boston");
    const res = only(run([pp("manual", `manual.p.${p.gsis_id}`, { name: p.name })]));
    expect(res).toMatchObject({ status: "matched", pair: { gsis_id: p.gsis_id, method: "id" } });
  });

  it("every fixture defence resolves by team, never as a pair, never unmatched", () => {
    const players = FIXTURE.defenses.map((d, i) =>
      pp("yahoo", `461.p.${String(100_001 + i)}`, {
        name: d.name,
        team_abbr: d.team,
        position: "DEF",
      }),
    );
    const r = run(players);
    expect(r.pairs).toEqual([]);
    expect(r.report).toEqual({ matched: 0, unmatched_rostered: [], unmatched_top_owned: [] });
    expect(r.team_units.map((t) => t.nfl_team)).toEqual(FIXTURE.defenses.map((d) => d.team));
    for (const { resolution } of r.resolved) {
      expect(crosswalkStatus(resolution)).toEqual({ method: "id", confidence: 1 });
      expect(subjectOf(resolution)).toMatchObject({ kind: "defense" });
    }
  });

  it("a rookie with no platform id resolves by name + team + position", () => {
    const love = fx("Jeremiyah Love");
    expect(love.yahoo_id).toBeNull();
    const res = only(run([yahooPlayer(love, { uniform_number: null })]));
    expect(res).toMatchObject({
      status: "matched",
      pair: {
        gsis_id: love.gsis_id,
        method: "match",
        confidence: MATCH_CONFIDENCE.nameTeamPosition,
      },
      evidence: ["name", "team", "position"],
    });
  });

  it("a name-only candidate is rejected and listed in unmatched_rostered", () => {
    const love = fx("Jeremiyah Love");
    const r = run([
      yahooPlayer(love, { team_abbr: "NYJ", position: "QB", eligible_positions: ["QB"] }),
    ]);
    expect(only(r)).toMatchObject({ status: "unmatched", reason: "name_only" });
    expect(r.report.unmatched_rostered).toHaveLength(1);
    const entry = r.report.unmatched_rostered[0]!;
    expect(entry.reason).toBe("name_only");
    expect(entry.candidates).toEqual([
      expect.objectContaining({ gsis_id: love.gsis_id, evidence: ["name", "jersey"] }),
    ]);
    expect(r.pairs).toEqual([]);
  });

  it.each([
    ["name + team, wrong position", { position: "TE", eligible_positions: ["TE"] }],
    ["name + position, wrong team", { team_abbr: "BUF" }],
    [
      "name only, no team (free agent)",
      { team_abbr: null, position: "QB", eligible_positions: [] },
    ],
    ["name + jersey only", { team_abbr: "BUF", position: "QB", eligible_positions: [] }],
  ])("never accepts %s", (_label, edit: Partial<PlatformPlayer>) => {
    const res = only(run([yahooPlayer(fx("Denzel Boston"), edit)]));
    expect(res).toMatchObject({ status: "unmatched", reason: "name_only" });
    expect(crosswalkStatus(res)).toEqual({ method: "none", confidence: 0 });
    expect(subjectOf(res)).toBeNull();
  });

  it("a persisted pair survives a team change (the pair is not re-matched)", () => {
    const boston = fx("Denzel Boston");
    const store = new MemPairs();
    const first = run([yahooPlayer(boston)], fixtureRosterRows(), { persisted: store });
    expect(first.changed).toHaveLength(1);
    store.putAll(first.changed);

    // Traded: nflverse and the platform both show a new team; a same-name decoy now sits on CLE.
    const traded = fixtureRosterRows().map((r) =>
      r.gsis_id === boston.gsis_id ? { ...r, team: "KC" as const, week: 5 } : r,
    );
    traded.push(
      row({
        gsis_id: "00-0099001",
        full_name: "Denzel Boston",
        team: "CLE",
        position: "WR",
        jersey_number: 12,
      }),
    );
    const second = run([yahooPlayer(boston, { team_abbr: "KC" })], traded, {
      persisted: store,
      now: LATER,
    });
    const res = only(second);
    expect(res).toMatchObject({ status: "matched", changed: false, pair: first.changed[0] });
    expect(second.changed).toEqual([]);
    expect(second.unchanged_ids).toEqual([yahooPlayer(boston).ref.id]);

    // Platform still on the old team while nflverse moved: still the persisted pair.
    const lagging = run([yahooPlayer(boston)], traded, { persisted: store, now: LATER });
    expect(gsisOf(only(lagging))).toBe(boston.gsis_id);
  });

  it("without the persisted pair the same team change would NOT resolve (the persistence matters)", () => {
    const boston = fx("Denzel Boston");
    const traded = fixtureRosterRows().map((r) =>
      r.gsis_id === boston.gsis_id ? { ...r, team: "KC" as const } : r,
    );
    expect(only(run([yahooPlayer(boston)], traded))).toMatchObject({
      status: "unmatched",
      reason: "name_only",
    });
  });

  it("a player with a Yahoo id resolves across a team change without any persistence", () => {
    const walker = fx("Kenneth Walker III");
    expect(walker.tags).toContain("team_change_2026");
    const res = only(run([yahooPlayer(walker, { team_abbr: walker.team_2025 })]));
    expect(res).toMatchObject({
      status: "matched",
      pair: { gsis_id: walker.gsis_id, method: "id" },
    });
  });
});

// --- precedence -------------------------------------------------------------------------------------

describe("precedence: override → id → persisted → match", () => {
  const allen = fx("Josh Allen");
  const keenan = fx("Keenan Allen");

  it("an override wins over a conflicting id match, and the conflict is reported", () => {
    const player = yahooPlayer(allen);
    const r = run([player], fixtureRosterRows(), {
      overrides: [override(player.ref.id, keenan.gsis_id)],
    });
    expect(only(r)).toMatchObject({
      status: "matched",
      pair: { gsis_id: keenan.gsis_id, method: "override", source: "overrides", confidence: 1 },
    });
    expect(r.diagnostics).toEqual([
      {
        code: "override_vs_id",
        platform_player_id: player.ref.id,
        gsis_ids: [keenan.gsis_id, allen.gsis_id],
      },
    ]);
  });

  it("an override that agrees with the id match is silent", () => {
    const player = yahooPlayer(allen);
    const r = run([player], fixtureRosterRows(), {
      overrides: [override(player.ref.id, allen.gsis_id)],
    });
    expect(only(r)).toMatchObject({ pair: { method: "override" } });
    expect(r.diagnostics).toEqual([]);
  });

  it("an override written with the nfl.p prefix applies to the season key", () => {
    const player = yahooPlayer(allen);
    const r = run([player], fixtureRosterRows(), {
      overrides: [override(`nfl.p.${allen.yahoo_id!}`, keenan.gsis_id)],
    });
    expect(gsisOf(only(r))).toBe(keenan.gsis_id);
  });

  it("an override resolves a player with no candidate at all", () => {
    const player = pp("yahoo", "461.p.77777", {
      name: "Unknown Practice Squad",
      team_abbr: "KC",
      position: "WR",
    });
    const r = run([player], fixtureRosterRows(), {
      overrides: [override(player.ref.id, "00-0077777")],
    });
    expect(only(r)).toMatchObject({
      status: "matched",
      pair: { gsis_id: "00-0077777", method: "override" },
    });
  });

  it("an override replaces a persisted pair (conflict reported, first_seen reset)", () => {
    const player = yahooPlayer(allen);
    const prev = pair({ platform_player_id: player.ref.id, gsis_id: allen.gsis_id, method: "id" });
    const r = run([player], fixtureRosterRows(), {
      overrides: [override(player.ref.id, keenan.gsis_id)],
      persisted: new MemPairs([prev]),
    });
    const res = only(r);
    expect(res).toMatchObject({
      status: "matched",
      changed: true,
      pair: { first_seen: NOW, gsis_id: keenan.gsis_id },
    });
    expect(r.diagnostics.map((d) => d.code)).toEqual(["override_vs_id", "override_vs_persisted"]);
  });

  it("overrides for another platform, invalid rows and duplicates are ignored with diagnostics", () => {
    const player = yahooPlayer(allen);
    const r = run([player], fixtureRosterRows(), {
      overrides: [
        { platform: "sleeper", platform_player_id: "4984", gsis_id: keenan.gsis_id, note: null },
        override("not-a-key", keenan.gsis_id),
        override(player.ref.id, "bad-gsis"),
        override(player.ref.id, allen.gsis_id),
        override(`nfl.p.${allen.yahoo_id!}`, keenan.gsis_id),
      ],
    });
    expect(only(r)).toMatchObject({ pair: { gsis_id: allen.gsis_id, method: "override" } });
    expect(r.diagnostics.map((d) => d.code)).toEqual([
      "invalid_override",
      "invalid_override",
      "duplicate_override",
    ]);
  });

  it("an id match beats a persisted name match that disagrees", () => {
    const player = yahooPlayer(allen);
    const prev = pair({ platform_player_id: player.ref.id, gsis_id: keenan.gsis_id });
    const r = run([player], fixtureRosterRows(), { persisted: new MemPairs([prev]) });
    expect(only(r)).toMatchObject({
      status: "matched",
      changed: true,
      pair: { gsis_id: allen.gsis_id, method: "id" },
    });
    expect(r.diagnostics).toEqual([
      {
        code: "id_vs_persisted",
        platform_player_id: player.ref.id,
        gsis_ids: [allen.gsis_id, keenan.gsis_id],
      },
    ]);
  });

  it("an id match upgrades a persisted name match to the same player, keeping first_seen", () => {
    const player = yahooPlayer(allen);
    const prev = pair({ platform_player_id: player.ref.id, gsis_id: allen.gsis_id });
    const r = run([player], fixtureRosterRows(), { persisted: new MemPairs([prev]) });
    expect(only(r)).toMatchObject({
      changed: true,
      pair: { method: "id", confidence: 1, first_seen: prev.first_seen, last_seen: prev.last_seen },
    });
  });

  it("an unchanged id pair is reported unchanged (touch, not upsert)", () => {
    const player = yahooPlayer(allen);
    const prev = pair({
      platform_player_id: player.ref.id,
      gsis_id: allen.gsis_id,
      method: "id",
      confidence: 1,
    });
    const r = run([player], fixtureRosterRows(), { persisted: new MemPairs([prev]) });
    expect(only(r)).toMatchObject({ changed: false, pair: prev });
    expect(r.changed).toEqual([]);
    expect(r.unchanged_ids).toEqual([player.ref.id]);
  });

  it("a persisted id pair outlives its id disappearing from nflverse", () => {
    const player = yahooPlayer(allen);
    const prev = pair({
      platform_player_id: player.ref.id,
      gsis_id: allen.gsis_id,
      method: "id",
      confidence: 1,
    });
    const rows = fixtureRosterRows().map((r) =>
      r.gsis_id === allen.gsis_id ? { ...r, yahoo_id: "" } : r,
    );
    const res = only(run([player], rows, { persisted: new MemPairs([prev]) }));
    expect(res).toMatchObject({ status: "matched", changed: false, evidence: ["id"] });
  });

  it("a persisted override whose override was removed is re-matched", () => {
    const boston = fx("Denzel Boston");
    const player = yahooPlayer(boston);
    const prev = pair({
      platform_player_id: player.ref.id,
      gsis_id: "00-0077777",
      method: "override",
      source: "overrides",
      confidence: 1,
    });
    const r = run([player], fixtureRosterRows(), { persisted: new MemPairs([prev]) });
    expect(only(r)).toMatchObject({
      status: "matched",
      changed: true,
      pair: { gsis_id: boston.gsis_id, method: "match", first_seen: NOW },
    });
    expect(r.diagnostics.map((d) => d.code)).toEqual(["stale_override_pair"]);
  });

  it.each([
    ["wrong platform", { platform: "sleeper" as const }],
    ["wrong id", { platform_player_id: "461.p.1" }],
    ["bad gsis", { gsis_id: "00-1" }],
    ["bad method", { method: "guess" as never }],
    ["bad source", { source: "rumour" as never }],
    ["confidence > 1", { confidence: 2 }],
    ["confidence NaN", { confidence: Number.NaN }],
    ["confidence < 0", { confidence: -0.1 }],
    ["missing first_seen", { first_seen: undefined as never }],
    ["missing last_seen", { last_seen: 5 as never }],
  ])("a malformed persisted pair (%s) is ignored and reported", (_label, edit) => {
    const boston = fx("Denzel Boston");
    const player = yahooPlayer(boston);
    const bad = pair({ platform_player_id: player.ref.id, gsis_id: "00-0077777", ...edit });
    const store = { get: () => bad };
    const r = run([player], fixtureRosterRows(), { persisted: store });
    expect(gsisOf(only(r))).toBe(boston.gsis_id);
    expect(r.diagnostics.map((d) => d.code)).toContain("invalid_persisted_pair");
  });
});

// --- gsis hints (manual YAML, Sleeper) --------------------------------------------------------------

describe("platform-supplied gsis ids", () => {
  const allen = fx("Josh Allen");

  it("a hint with Sleeper's leading space is trimmed and exact", () => {
    const r = run([pp("sleeper", "4984", { name: allen.name, gsis_hint: ` ${allen.gsis_id}` })]);
    expect(only(r)).toMatchObject({
      pair: { gsis_id: allen.gsis_id, method: "id", source: "platform" },
    });
  });

  it("a hint whose roster name differs (team and position agree) is still exact but reported", () => {
    // A nickname: the hand-typed id is what settles it. Without team + position agreement the same
    // name mismatch is a conflict (QA-1-042, below).
    const r = run([
      pp("manual", `manual.p.${allen.gsis_id}`, {
        name: "Joshua Allen",
        team_abbr: allen.team,
        position: allen.position,
        gsis_hint: allen.gsis_id,
      }),
    ]);
    expect(gsisOf(only(r))).toBe(allen.gsis_id);
    expect(r.diagnostics).toEqual([
      {
        code: "hint_name_mismatch",
        platform_player_id: `manual.p.${allen.gsis_id}`,
        gsis_ids: [allen.gsis_id],
      },
    ]);
  });

  it("a hint absent from a loaded roster is not trusted; the matcher decides", () => {
    const boston = fx("Denzel Boston");
    const player = pp("manual", "manual.p.00-0012345", {
      name: boston.name,
      team_abbr: boston.team,
      position: boston.position,
      gsis_hint: "00-0012345",
    });
    const r = run([player]);
    expect(only(r)).toMatchObject({ pair: { gsis_id: boston.gsis_id, method: "match" } });
    expect(r.diagnostics.map((d) => d.code)).toEqual(["hint_not_in_roster"]);
  });

  it("a hint is trusted when the roster was never loaded", () => {
    const r = run(
      [pp("manual", "manual.p.00-0012345", { name: "Anyone", gsis_hint: "00-0012345" })],
      [],
    );
    expect(only(r)).toMatchObject({
      pair: { gsis_id: "00-0012345", method: "id", source: "platform" },
    });
  });

  it.each(["NA", "", "  ", "00-12345", "x".repeat(1000)])(
    "an unusable hint %j is ignored",
    (hint) => {
      const res = only(run([pp("yahoo", "461.p.99999", { name: "Nobody Here", gsis_hint: hint })]));
      expect(res).toMatchObject({ status: "unmatched", reason: "no_candidate" });
    },
  );
});

// --- ids ---------------------------------------------------------------------------------------------

describe("exact platform ids", () => {
  it("resolves Sleeper and ESPN ids through roster_weekly", () => {
    const chase = fx("Ja'Marr Chase");
    expect(gsisOf(only(run([pp("sleeper", chase.sleeper_id!, { name: "x x" })])))).toBe(
      chase.gsis_id,
    );
    expect(gsisOf(only(run([pp("espn", chase.espn_id!, { name: "x x" })])))).toBe(chase.gsis_id);
  });

  it("an id carried by two roster rows is never used (reported), the matcher decides", () => {
    const chase = fx("Ja'Marr Chase");
    const rows = [
      ...fixtureRosterRows(),
      row({ gsis_id: "00-0099002", full_name: "Some One", yahoo_id: chase.yahoo_id }),
    ];
    const r = run([yahooPlayer(chase)], rows);
    expect(only(r)).toMatchObject({ pair: { gsis_id: chase.gsis_id, method: "match" } });
    expect(r.diagnostics).toEqual([
      {
        code: "ambiguous_platform_id",
        platform_player_id: yahooPlayer(chase).ref.id,
        gsis_ids: [chase.gsis_id, "00-0099002"].sort(),
      },
    ]);
  });

  it("an empty or NA platform id in nflverse never matches", () => {
    const rows = [
      row({ gsis_id: "00-0099003", full_name: "Empty Id", yahoo_id: "" }),
      row({ gsis_id: "00-0099004", full_name: "Na Id", yahoo_id: "NA" }),
    ];
    const index = buildRosterIndex(rows);
    expect(index.byPlatformId("yahoo", "")).toEqual([]);
    expect(index.byPlatformId("yahoo", "NA")).toEqual([]);
  });

  it("a malformed platform key is unmatched and reported", () => {
    const r = run([
      pp("yahoo", "not a key", { name: "Josh Allen", team_abbr: "BUF", position: "QB" }),
    ]);
    expect(only(r)).toMatchObject({ status: "unmatched", reason: "no_candidate" });
    expect(r.diagnostics.map((d) => d.code)).toEqual(["invalid_player_id"]);
  });
});

// --- adversarial names ---------------------------------------------------------------------------------

describe("adversarial names (deterministic match, no ids)", () => {
  function noId(name: string, edit: Partial<PlatformPlayer> = {}): PlatformPlayer {
    return pp("yahoo", "461.p.95000", { name, ...edit });
  }

  it.each([
    ["Kaʻimi Fairbairn", "Ka'imi Fairbairn"],
    ["Kaimi Fairbairn", "Ka'imi Fairbairn"],
    ["KA’IMI FAIRBAIRN", "Ka'imi Fairbairn"],
    ["Jaxon Smith Njigba", "Jaxon Smith-Njigba"],
    ["Jaxon Smithnjigba", "Jaxon Smith-Njigba"],
    ["Amon-Ra St Brown", "Amon-Ra St. Brown"],
    ["AmonRa St. Brown", "Amon-Ra St. Brown"],
    ["JaMarr Chase", "Ja'Marr Chase"],
    ["Harold Fannin", "Harold Fannin Jr."],
    ["Harold Fannin Jr", "Harold Fannin Jr."],
    ["Harold Fannin Jr.", "Harold Fannin Jr."],
    ["Deebo Samuel", "Deebo Samuel Sr."],
    ["Kenneth Walker", "Kenneth Walker III"],
    ["Nîck Fölk", "Nick Folk"],
  ])("%j matches %j", (platformName, fixtureName) => {
    const p = fx(fixtureName);
    const res = only(run([noId(platformName, { team_abbr: p.team, position: p.position })]));
    expect(gsisOf(res)).toBe(p.gsis_id);
  });

  it("matches a diacritic name in nflverse from its ASCII spelling and vice versa", () => {
    const rows = [
      row({ gsis_id: "00-0099005", full_name: "Tomás Ñúñez", team: "MIA", position: "RB" }),
    ];
    expect(
      gsisOf(only(run([noId("Tomas Nunez", { team_abbr: "Mia", position: "RB" })], rows))),
    ).toBe("00-0099005");
    const rows2 = [
      row({ gsis_id: "00-0099006", full_name: "Tomas Nunez", team: "MIA", position: "RB" }),
    ];
    expect(
      gsisOf(only(run([noId("Tomás Ñúñez", { team_abbr: "MIA", position: "RB" })], rows2))),
    ).toBe("00-0099006");
  });

  it("O'Neil and ONeil are the same name", () => {
    const rows = [
      row({ gsis_id: "00-0099007", full_name: "Mike O'Neil", team: "NYG", position: "TE" }),
    ];
    expect(
      gsisOf(only(run([noId("Mike ONeil", { team_abbr: "NYG", position: "TE" })], rows))),
    ).toBe("00-0099007");
    expect(
      gsisOf(only(run([noId("Mike O’Neil", { team_abbr: "NYG", position: "TE" })], rows))),
    ).toBe("00-0099007");
  });

  it.each([
    ["Cyrillic А", "Josh Аllen"],
    ["Greek ο", "Jοsh Allen"],
    ["zero-width space", "Josh​ Allen"],
    ["invisible RTL", "Josh Allen‮"],
  ])("a homoglyph name (%s) is rejected, not merged", (_label, name) => {
    const allen = fx("Josh Allen");
    const res = only(run([noId(name, { team_abbr: "BUF", position: "QB", uniform_number: 17 })]));
    expect(res).toMatchObject({ status: "unmatched", reason: "no_candidate", candidates: [] });
    expect(gsisOf(res)).not.toBe(allen.gsis_id);
  });

  it("same name, different teams: the team decides", () => {
    const rows = [
      ...fixtureRosterRows(),
      row({
        gsis_id: "00-0099008",
        full_name: "Josh Allen",
        team: "JAX",
        position: "LB",
        jersey_number: 41,
      }),
      row({
        gsis_id: "00-0099009",
        full_name: "Josh Allen",
        team: "LA",
        position: "QB",
        jersey_number: 17,
      }),
    ];
    expect(
      gsisOf(only(run([noId("Josh Allen", { team_abbr: "Buf", position: "QB" })], rows))),
    ).toBe(fx("Josh Allen").gsis_id);
    expect(
      gsisOf(only(run([noId("Josh Allen", { team_abbr: "LAR", position: "QB" })], rows))),
    ).toBe("00-0099009");
    expect(
      gsisOf(only(run([noId("Josh Allen", { team_abbr: "Jax", position: "LB" })], rows))),
    ).toBe("00-0099008");
    expect(
      gsisOf(only(run([noId("Josh Allen", { team_abbr: "JAC", position: "LB" })], rows))),
    ).toBe("00-0099008");
  });

  it("same name, same team, different positions: the position decides", () => {
    const rows = [
      row({
        gsis_id: "00-0099010",
        full_name: "Chris Jones",
        team: "KC",
        position: "DL",
        jersey_number: 95,
      }),
      row({
        gsis_id: "00-0099011",
        full_name: "Chris Jones",
        team: "KC",
        position: "RB",
        jersey_number: 30,
      }),
    ];
    expect(
      gsisOf(only(run([noId("Chris Jones", { team_abbr: "KC", position: "RB" })], rows))),
    ).toBe("00-0099011");
    expect(
      gsisOf(only(run([noId("Chris Jones", { team_abbr: "KC", position: "DT" })], rows))),
    ).toBe("00-0099010");
    expect(
      only(run([noId("Chris Jones", { team_abbr: "KC", position: "WR" })], rows)),
    ).toMatchObject({
      status: "unmatched",
      reason: "name_only",
    });
  });

  it("an eligible position counts (a TE also eligible at QB)", () => {
    const rows = [
      row({ gsis_id: "00-0099012", full_name: "Taysom Hill", team: "NO", position: "QB" }),
    ];
    const res = only(
      run(
        [
          noId("Taysom Hill", {
            team_abbr: "NO",
            position: "TE",
            eligible_positions: ["TE", "QB", "W/R/T", "BN"],
          }),
        ],
        rows,
      ),
    );
    expect(gsisOf(res)).toBe("00-0099012");
  });

  it("a fullback listed as RB by the platform matches (FB→RB family)", () => {
    const rows = [
      row({ gsis_id: "00-0099013", full_name: "Kyle Juszczyk", team: "SF", position: "FB" }),
    ];
    expect(
      gsisOf(only(run([noId("Kyle Juszczyk", { team_abbr: "SF", position: "RB" })], rows))),
    ).toBe("00-0099013");
  });

  it("same name, same team, same position: jersey breaks the tie, else ambiguous", () => {
    const rows = [
      row({
        gsis_id: "00-0099014",
        full_name: "Mike Williams",
        team: "NYJ",
        position: "WR",
        jersey_number: 18,
      }),
      row({
        gsis_id: "00-0099015",
        full_name: "Mike Williams",
        team: "NYJ",
        position: "WR",
        jersey_number: 81,
      }),
    ];
    const tie = only(
      run([noId("Mike Williams", { team_abbr: "NYJ", position: "WR", uniform_number: 81 })], rows),
    );
    expect(tie).toMatchObject({
      pair: { gsis_id: "00-0099015", confidence: MATCH_CONFIDENCE.jerseyTieBreak },
    });
    const r = run(
      [noId("Mike Williams", { team_abbr: "NYJ", position: "WR", uniform_number: null })],
      rows,
    );
    expect(only(r)).toMatchObject({ status: "ambiguous" });
    expect(r.report.unmatched_rostered[0]).toMatchObject({ reason: "ambiguous" });
    expect(r.report.unmatched_rostered[0]!.candidates.map((c) => c.gsis_id).sort()).toEqual([
      "00-0099014",
      "00-0099015",
    ]);
    const none = only(
      run([noId("Mike Williams", { team_abbr: "NYJ", position: "WR", uniform_number: 5 })], rows),
    );
    expect(none).toMatchObject({ status: "ambiguous" });
  });

  it("a single candidate's jersey never blocks the match, only lowers confidence", () => {
    const boston = fx("Denzel Boston");
    const res = only(run([yahooPlayer(boston, { uniform_number: 99 })]));
    expect(res).toMatchObject({
      pair: { gsis_id: boston.gsis_id, confidence: MATCH_CONFIDENCE.jerseyDisagrees },
    });
    const frac = only(run([yahooPlayer(boston, { uniform_number: 12.5 })]));
    expect(frac).toMatchObject({ pair: { confidence: MATCH_CONFIDENCE.nameTeamPosition } });
  });

  it("an unknown team abbreviation fails loudly (unknown_team), a malformed one too", () => {
    for (const team of ["XYZ", "L.V.", "ＫＣ", ""]) {
      const r = run([noId("Denzel Boston", { team_abbr: team, position: "WR" })]);
      expect(only(r)).toMatchObject({ status: "unmatched", reason: "unknown_team" });
      expect(r.report.unmatched_rostered[0]!.reason).toBe("unknown_team");
    }
  });

  it("an unnormalisable or absent name has no candidate", () => {
    for (const name of ["", "\u{1F3C8}", "x".repeat(10_000)]) {
      expect(only(run([noId(name, { team_abbr: "CLE" })]))).toMatchObject({
        status: "unmatched",
        reason: "no_candidate",
      });
    }
  });

  it("caps reported candidates", () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      row({
        gsis_id: `00-00990${String(20 + i)}`,
        full_name: "John Smith",
        team: "KC",
        position: "WR",
      }),
    );
    const r = run([noId("John Smith", { team_abbr: "BUF", position: "WR" })], rows);
    expect(r.report.unmatched_rostered[0]!.candidates).toHaveLength(MAX_REPORTED_CANDIDATES);
    const r2 = run([noId("John Smith", { team_abbr: "KC", position: "WR" })], rows);
    expect(only(r2)).toMatchObject({ status: "ambiguous" });
  });
});

// --- one NFL player, two platform keys ----------------------------------------------------------------

describe("uniqueness within a run", () => {
  const boston = fx("Denzel Boston");

  it("two platform keys matching the same player by name are both demoted to ambiguous", () => {
    const a = pp("yahoo", "461.p.95001", { name: boston.name, team_abbr: "CLE", position: "WR" });
    const b = pp("yahoo", "461.p.95002", {
      name: "Denzel Boston",
      team_abbr: "Cle",
      position: "WR",
    });
    const r = run([a, b]);
    expect(r.resolved.map((x) => x.resolution.status)).toEqual(["ambiguous", "ambiguous"]);
    expect(r.pairs).toEqual([]);
    expect(r.report.unmatched_rostered).toHaveLength(2);
  });

  it("a name match loses to an override on the same gsis", () => {
    const a = pp("yahoo", "461.p.95001", { name: boston.name, team_abbr: "CLE", position: "WR" });
    const b = pp("yahoo", "461.p.95002", {
      name: "Somebody Else",
      team_abbr: "CLE",
      position: "WR",
    });
    const r = run([a, b], fixtureRosterRows(), { overrides: [override(b.ref.id, boston.gsis_id)] });
    expect(r.resolved[0]!.resolution.status).toBe("ambiguous");
    expect(gsisOf(r.resolved[1]!.resolution)).toBe(boston.gsis_id);
    expect(r.diagnostics).toEqual([]);
  });

  it("two strong claims on one gsis are kept and reported", () => {
    const r = run(
      [pp("yahoo", "461.p.95001", { name: "A B" }), pp("yahoo", "461.p.95002", { name: "C D" })],
      fixtureRosterRows(),
      {
        overrides: [
          override("461.p.95001", boston.gsis_id),
          override("461.p.95002", boston.gsis_id),
        ],
      },
    );
    expect(r.pairs).toHaveLength(2);
    expect(r.diagnostics.map((d) => [d.code, d.platform_player_id])).toEqual([
      ["duplicate_gsis", "461.p.95001"],
      ["duplicate_gsis", "461.p.95002"],
    ]);
  });
});

// --- team units -------------------------------------------------------------------------------------------

describe("team units", () => {
  it.each(["DEF", "DST", "D/ST", "def"])("%s maps by team", (position) => {
    const res = only(
      run([pp("yahoo", "461.p.100011", { name: "Detroit", team_abbr: "Det", position })]),
    );
    expect(res).toEqual({ status: "team_unit", subject: { kind: "defense", nfl_team: "DET" } });
  });

  it("a manual defence key resolves without a team abbreviation", () => {
    const res = only(
      run([pp("manual", "manual.p.def-kc", { name: "Kansas City", position: "DEF" })]),
    );
    expect(subjectOf(res)).toEqual({ kind: "defense", nfl_team: "KC" });
  });

  it("recognises team units by position or manual key only", () => {
    expect(isTeamUnit(pp("manual", "manual.p.def-kc", { position: "WR" }))).toBe(true);
    expect(isTeamUnit(pp("yahoo", "461.p.1", { position: "WR" }))).toBe(false);
    expect(isTeamUnit(pp("yahoo", "461.p.1", { position: 5 as never }))).toBe(false);
  });

  it("an unresolvable defence is reported apart, never in unmatched_rostered", () => {
    const player = pp("yahoo", "461.p.100012", {
      name: "Nowhere",
      team_abbr: "XYZ",
      position: "DEF",
    });
    const r = run([player]);
    expect(only(r)).toMatchObject({ status: "unmatched", reason: "unknown_team" });
    expect(r.unresolved_team_units).toEqual([player]);
    expect(r.report.unmatched_rostered).toEqual([]);
  });

  it("a defence is never matched to a player named like the team", () => {
    const rows = [
      row({ gsis_id: "00-0099030", full_name: "Detroit Lions", team: "DET", position: "LB" }),
    ];
    expect(
      only(
        run(
          [
            pp("yahoo", "461.p.100011", {
              name: "Detroit Lions",
              team_abbr: "DET",
              position: "DEF",
            }),
          ],
          rows,
        ),
      ).status,
    ).toBe("team_unit");
  });
});

// --- the report -------------------------------------------------------------------------------------------

describe("unmatched report", () => {
  const nobody = (id: string, edit: Partial<PlatformPlayer> = {}): PlatformPlayer =>
    pp("yahoo", id, { name: "Nobody Known", team_abbr: "KC", ...edit });

  it("splits rostered from top-owned free agents, ignores the long tail, sorts by key", () => {
    const fa = {
      type: "freeagents" as const,
      owner_team_key: null,
      owner_name: null,
      waiver_date: null,
    };
    const r = run([
      nobody("461.p.3"),
      nobody("461.p.1"),
      nobody("461.p.2", { ownership: fa, percent_owned: TOP_OWNED_PERCENT }),
      nobody("461.p.4", { ownership: fa, percent_owned: TOP_OWNED_PERCENT - 0.1 }),
      nobody("461.p.5", { ownership: null, percent_owned: null }),
    ]);
    expect(r.report.unmatched_rostered.map((u) => u.player.ref.id)).toEqual(["461.p.1", "461.p.3"]);
    expect(r.report.unmatched_top_owned.map((u) => u.player.ref.id)).toEqual(["461.p.2"]);
    expect(r.report.matched).toBe(0);
  });

  it("honours an explicit rostered set and threshold", () => {
    const r = run(
      [nobody("461.p.1"), nobody("461.p.2", { ownership: null, percent_owned: 10 })],
      fixtureRosterRows(),
      {
        rostered: new Set(["461.p.2"]),
        topOwnedPercent: 5,
      },
    );
    expect(r.report.unmatched_rostered.map((u) => u.player.ref.id)).toEqual(["461.p.2"]);
    expect(r.report.unmatched_top_owned).toEqual([]);
  });

  it("skips players of another platform and duplicate keys (reported)", () => {
    const allen = fx("Josh Allen");
    const r = run([
      yahooPlayer(allen),
      yahooPlayer(allen),
      pp("sleeper", "4984", { name: allen.name }),
    ]);
    expect(r.resolved).toHaveLength(1);
    expect(r.diagnostics.map((d) => d.code)).toEqual(["duplicate_player", "platform_mismatch"]);
  });

  it("rejects a missing clock instant", () => {
    expect(() => run([], [], { now: "" })).toThrow(TypeError);
    expect(() => run([], [], { now: 5 as never })).toThrow(TypeError);
  });
});

// --- the roster index ----------------------------------------------------------------------------------

describe("buildRosterIndex", () => {
  it("keeps the latest row per gsis id and drops invalid ids", () => {
    const allen = fx("Josh Allen");
    const index = buildRosterIndex([
      rosterRow(allen, { week: 3, team: "KC" }),
      rosterRow(allen, { week: 4 }),
      rosterRow(allen, { week: 4, team: "NYJ" }),
      rosterRow(allen, { season: 2025, week: 18, team: "MIA" }),
      row({ gsis_id: "", full_name: "No Id" }),
      row({ gsis_id: "NA", full_name: "Na Id" }),
      row({ gsis_id: " 00-0099040", full_name: "Space Id" }),
    ]);
    expect(index.size).toBe(2);
    expect(index.byGsis(allen.gsis_id)?.team).toBe("BUF");
    expect(index.byGsis("00-0099040")?.gsis_id).toBe("00-0099040");
    expect(index.byNameKey("noid")).toEqual([]);
    expect(index.byGsis("00-0000000")).toBeNull();
  });

  it("is safe against prototype-named keys", () => {
    const index = buildRosterIndex([
      row({ gsis_id: "00-0099041", full_name: "Proto Type", yahoo_id: "__proto__" }),
    ]);
    expect(index.byPlatformId("yahoo", "constructor")).toEqual([]);
    expect(index.byNameKey("__proto__")).toEqual([]);
    expect(index.byPlatformId("yahoo", "__proto__")).toHaveLength(1);
  });
});

// --- scale and determinism --------------------------------------------------------------------------

describe("scale", () => {
  it("resolves 5 000 players against 20 000 roster rows deterministically and quickly", () => {
    const teams = ["KC", "BUF", "SF", "DAL", "NYJ", "LA", "LV", "JAX"] as const;
    const rows: NflRosterPlayer[] = Array.from({ length: 20_000 }, (_, i) =>
      row({
        gsis_id: `00-${String(1_000_000 + i).padStart(7, "0")}`,
        full_name: `Player${String(i)} Surname${String(i % 997)}`,
        team: teams[i % teams.length]!,
        position: ["QB", "RB", "WR", "TE"][i % 4]!,
        jersey_number: i % 99,
        yahoo_id: i % 3 === 0 ? String(500_000 + i) : null,
      }),
    );
    const players = Array.from({ length: 5_000 }, (_, i) => {
      const r = rows[i * 4]!;
      return pp("yahoo", `461.p.${String(600_000 + i)}`, {
        name: r.full_name,
        team_abbr: r.team,
        position: r.position,
        uniform_number: r.jersey_number,
      });
    });
    const t0 = performance.now();
    const a = run(players, rows);
    const elapsed = performance.now() - t0;
    const b = run(players, rows);
    expect(a.report.matched).toBe(5_000);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(elapsed).toBeLessThan(5_000);
  });
});

// --- properties ------------------------------------------------------------------------------------

describe("properties", () => {
  const nameArb = fc.constantFrom(
    "Josh Allen",
    "Jordan Love",
    "Mike Williams",
    "Chris Jones",
    "José Núñez",
    "Ja'Marr Chase",
  );
  const teamArb = fc.constantFrom("KC", "BUF", "JAX", "Jac", "LV", "LVR", "LA", "LAR", "XYZ", null);
  const posArb = fc.constantFrom("QB", "RB", "FB", "WR", "TE", "K", "LB");
  const jerseyArb = fc.option(fc.integer({ min: 0, max: 99 }), { nil: null });

  it("a deterministic match always has name, team and position agreement (never name-only)", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            name: nameArb,
            team: fc.constantFrom("KC", "BUF", "JAX", "LV", "LA"),
            pos: posArb,
            jersey: jerseyArb,
          }),
          { maxLength: 12 },
        ),
        fc.array(fc.record({ name: nameArb, team: teamArb, pos: posArb, jersey: jerseyArb }), {
          minLength: 1,
          maxLength: 12,
        }),
        (rosterSpec, playerSpec) => {
          const rows = rosterSpec.map((s, i) =>
            row({
              gsis_id: `00-00${String(88_000 + i).padStart(5, "0")}`,
              full_name: s.name,
              team: s.team,
              position: s.pos,
              jersey_number: s.jersey,
            }),
          );
          const players = playerSpec.map((s, i) =>
            pp("yahoo", `461.p.${String(70_000 + i)}`, {
              name: s.name,
              team_abbr: s.team,
              position: s.pos,
              uniform_number: s.jersey,
            }),
          );
          const r = run(players, rows);
          const claimed = new Set<string>();
          for (const { resolution } of r.resolved) {
            if (resolution.status !== "matched") continue;
            expect(resolution.pair.method).toBe("match");
            expect(resolution.evidence).toEqual(
              expect.arrayContaining(["name", "team", "position"]),
            );
            expect(claimed.has(resolution.pair.gsis_id)).toBe(false);
            claimed.add(resolution.pair.gsis_id);
          }
          expect(r.report.matched + r.report.unmatched_rostered.length).toBe(r.resolved.length);
        },
      ),
      { numRuns: 300 },
    );
  });
});

// --- QA-1-041: the manual kicker universe never demotes a rostered player's own match ----------------

describe("manual pool aliases (QA-1-041)", () => {
  const boswell = fx("Chris Boswell");
  /** The rostered kicker as the onboarding guide writes him: name/team/position, no gsis_id. */
  const rostered = pp("manual", "manual.p.n-5f74985457138a1d", {
    name: boswell.name,
    team_abbr: boswell.team,
    position: "K",
    eligible_positions: ["K", "BN"],
  });
  /** The provider's kicker-universe row for the same NFL player (ManualLeagueProvider.kickers()). */
  const universe = pp("manual", `manual.p.${boswell.gsis_id}`, {
    name: boswell.name,
    team_abbr: boswell.team,
    position: "K",
    eligible_positions: ["K", "BN"],
    uniform_number: boswell.jersey,
    ownership: { type: "unknown", owner_team_key: null, owner_name: null, waiver_date: null },
    gsis_hint: boswell.gsis_id,
  });

  it("a name-entered rostered kicker still resolves when the pool lists him under his gsis key", () => {
    for (const players of [
      [rostered, universe],
      [universe, rostered],
    ]) {
      const r = run(players);
      const byId = new Map(r.resolved.map((x) => [x.player.ref.id, x.resolution]));
      expect(gsisOf(byId.get(rostered.ref.id)!)).toBe(boswell.gsis_id);
      expect(gsisOf(byId.get(universe.ref.id)!)).toBe(boswell.gsis_id);
      expect(r.report.unmatched_rostered).toEqual([]);
      expect(r.diagnostics).toEqual([]);
    }
  });

  it("the universe resolution agrees with a roster-only run over the same key", () => {
    const alone = gsisOf(only(run([rostered])));
    const r = run([universe, rostered]);
    expect(gsisOf(r.resolved[1]!.resolution)).toBe(alone);
  });

  it("two rostered name matches on one player are still both demoted, alias or not", () => {
    const other = pp("manual", "manual.p.n-0000000000000002", {
      name: boswell.name,
      team_abbr: boswell.team,
      position: "K",
      ownership: {
        type: "team",
        owner_team_key: "manual.l.x.t.2",
        owner_name: "Team B",
        waiver_date: null,
      },
    });
    const r = run([rostered, universe, other]);
    const statuses = new Map(r.resolved.map((x) => [x.player.ref.id, x.resolution.status]));
    expect(statuses.get(rostered.ref.id)).toBe("ambiguous");
    expect(statuses.get(other.ref.id)).toBe("ambiguous");
    expect(statuses.get(universe.ref.id)).toBe("matched");
  });

  it("a gsis key that is itself rostered is a real competing claim (the name match is demoted)", () => {
    const rosteredByKey = { ...universe, ownership: rostered.ownership };
    const r = run([rostered, rosteredByKey]);
    expect(r.resolved[0]!.resolution.status).toBe("ambiguous");
    expect(gsisOf(r.resolved[1]!.resolution)).toBe(boswell.gsis_id);
  });

  it("the alias rule is manual-only: on Yahoo two keys on one player still demote the name match", () => {
    const a = yahooPlayer(boswell, { ref: { platform: "yahoo", id: "461.p.95001" } });
    const b = pp("yahoo", "461.p.95002", {
      name: boswell.name,
      team_abbr: "PIT",
      position: "K",
      ownership: universe.ownership,
      gsis_hint: boswell.gsis_id,
    });
    const r = run([a, b]);
    expect(r.resolved[0]!.resolution.status).toBe("ambiguous");
  });
});

// --- QA-1-042: a hand-typed gsis id that names another real player is never silently trusted ---------

describe("a gsis hint that contradicts the entry (QA-1-042)", () => {
  const allen = fx("Josh Allen");
  const henry = fx("Hunter Henry");
  /** Josh Allen's league.yaml line with one digit wrong: Hunter Henry's id. */
  const typo = pp("manual", `manual.p.${henry.gsis_id}`, {
    name: allen.name,
    team_abbr: allen.team,
    position: allen.position,
    eligible_positions: ["QB", "BN"],
    gsis_hint: henry.gsis_id,
  });
  /** The real Hunter Henry, entered by name (as the guide writes him). */
  const henryByName = pp("manual", "manual.p.n-00000000000000a1", {
    name: henry.name,
    team_abbr: henry.team,
    position: henry.position,
    eligible_positions: ["TE", "BN"],
  });

  it("is not an id match: the entry is listed (ambiguous) with both identities as candidates", () => {
    const r = run([typo]);
    const res = only(r);
    expect(res.status).toBe("ambiguous");
    expect(gsisOf(res)).toBeNull();
    const ids = res.status === "ambiguous" ? res.candidates.map((c) => c.gsis_id) : [];
    expect(ids).toContain(henry.gsis_id);
    expect(ids).toContain(allen.gsis_id);
    expect(r.report.unmatched_rostered.map((u) => [u.player.ref.id, u.reason])).toEqual([
      [typo.ref.id, "ambiguous"],
    ]);
    expect(r.diagnostics).toContainEqual({
      code: "hint_conflict",
      platform_player_id: typo.ref.id,
      gsis_ids: [henry.gsis_id],
    });
  });

  it("the player the mistyped id belongs to keeps his own match", () => {
    const r = run([typo, henryByName]);
    expect(r.resolved[0]!.resolution.status).toBe("ambiguous");
    expect(gsisOf(r.resolved[1]!.resolution)).toBe(henry.gsis_id);
    expect(r.pairs.map((p) => p.gsis_id)).toEqual([henry.gsis_id]);
  });

  it("a stale persisted pair learned from the same wrong hint is not used either", () => {
    const stale = pair({
      platform: "manual",
      platform_player_id: typo.ref.id,
      gsis_id: henry.gsis_id,
      method: "id",
      source: "platform",
      confidence: 1,
    });
    const res = only(run([typo], fixtureRosterRows(), { persisted: new MemPairs([stale]) }));
    expect(res.status).toBe("ambiguous");
  });

  it("an override still settles the entry (the owner's explicit decision wins)", () => {
    const r = run([typo], fixtureRosterRows(), {
      overrides: [
        { platform: "manual", platform_player_id: typo.ref.id, gsis_id: allen.gsis_id, note: null },
      ],
    });
    expect(gsisOf(only(r))).toBe(allen.gsis_id);
  });

  it.each([
    ["name differs, team and position agree (a nickname)", { name: "Joshua Allen" }, true],
    ["name agrees, team differs (a trade not yet in the file)", { team_abbr: "KC" }, true],
    ["name agrees, position differs", { position: "TE", eligible_positions: ["TE"] }, true],
    ["name and team differ", { name: "Somebody Else", team_abbr: "KC" }, false],
    [
      "name and position differ",
      { name: "Somebody Else", position: "WR", eligible_positions: ["WR"] },
      false,
    ],
    ["name differs, no team given", { name: "Somebody Else", team_abbr: null }, false],
  ] as const)("%s → trusted: %s", (_label, edit, trusted) => {
    const entry = pp("manual", `manual.p.${allen.gsis_id}`, {
      name: allen.name,
      team_abbr: allen.team,
      position: allen.position,
      eligible_positions: ["QB"],
      gsis_hint: allen.gsis_id,
      ...edit,
    });
    const res = only(run([entry]));
    if (trusted) {
      expect(res).toMatchObject({
        status: "matched",
        pair: { gsis_id: allen.gsis_id, method: "id" },
      });
    } else {
      expect(res.status).not.toBe("matched");
    }
  });

  it("a Sleeper-supplied hint is held to the same check", () => {
    const res = only(
      run([
        pp("sleeper", "4984", {
          name: allen.name,
          team_abbr: "BUF",
          position: "QB",
          gsis_hint: henry.gsis_id,
        }),
      ]),
    );
    expect(gsisOf(res)).not.toBe(henry.gsis_id);
  });
});
