// fixture-roster.test.ts — fixtures/players/fixture-roster.json, the shared fixture roster every
// Phase-1a fixture is built from (plan 05 §3.2; plan 10 §3.1a fixtures, A5a crosswalk cases): its
// shape, the position counts, and that the edge cases it promises are really in it.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isNflTeam } from "../../../src/config/schema.js";

interface FixturePlayer {
  kind: "player";
  gsis_id: string;
  name: string;
  first_name: string;
  last_name: string;
  position: string;
  team: string;
  jersey: number | null;
  yahoo_id: string | null;
  sleeper_id: string | null;
  espn_id: string | null;
  pfr_id: string | null;
  rookie_year: number;
  team_2025: string | null;
  tags: string[];
}
interface FixtureDefense {
  kind: "defense";
  team: string;
  name: string;
  position: "DEF";
}
interface FixtureRoster {
  season: number;
  stat_weeks: number[];
  players: FixturePlayer[];
  defenses: FixtureDefense[];
}

const roster = JSON.parse(
  readFileSync(new URL("../../../fixtures/players/fixture-roster.json", import.meta.url), "utf8"),
) as FixtureRoster;
const { players, defenses } = roster;
const tagged = (t: string): FixturePlayer[] => players.filter((p) => p.tags.includes(t));

describe("fixture roster shape", () => {
  it("is the 2026 season with stat lines in weeks 1–3", () => {
    expect(roster.season).toBe(2026);
    expect(roster.stat_weeks).toEqual([1, 2, 3]);
  });

  it("has 2 QB, 5 RB, 6 WR, 3 TE, 3 K and 4 team defences", () => {
    const count = (pos: string): number => players.filter((p) => p.position === pos).length;
    expect([count("QB"), count("RB"), count("WR"), count("TE"), count("K")]).toEqual([
      2, 5, 6, 3, 3,
    ]);
    expect(players).toHaveLength(19);
    expect(defenses).toHaveLength(4);
  });

  it.each(players.map((p) => [p.name, p] as const))("%s: well-formed", (_n, p) => {
    expect(p.kind).toBe("player");
    expect(p.gsis_id).toMatch(/^00-\d{7}$/);
    expect(p.name.trim()).toBe(p.name);
    expect(p.name.length).toBeGreaterThan(3);
    expect(p.last_name.length).toBeGreaterThan(0);
    expect(isNflTeam(p.team)).toBe(true);
    if (p.team_2025 !== null) expect(isNflTeam(p.team_2025)).toBe(true);
    expect(Number.isInteger(p.jersey)).toBe(true);
    expect(p.jersey).toBeGreaterThanOrEqual(0);
    expect(p.jersey).toBeLessThanOrEqual(99);
    for (const id of [p.yahoo_id, p.sleeper_id, p.espn_id]) {
      if (id !== null) expect(id).toMatch(/^\d+$/);
    }
    expect(p.rookie_year).toBeGreaterThanOrEqual(2000);
    expect(p.rookie_year).toBeLessThanOrEqual(2026);
  });

  it("has unique gsis ids and unique defence teams, all valid", () => {
    expect(new Set(players.map((p) => p.gsis_id)).size).toBe(players.length);
    expect(new Set(defenses.map((d) => d.team)).size).toBe(defenses.length);
    for (const d of defenses) {
      expect(d).toMatchObject({ kind: "defense", position: "DEF" });
      expect(isNflTeam(d.team)).toBe(true);
      expect(Object.keys(d)).not.toContain("gsis_id");
    }
  });

  it("holds no fantasy-league identifiers (public NFL data only)", () => {
    const text = JSON.stringify(roster);
    expect(text).not.toMatch(/\.l\.\d|league_key|team_key|manager/i);
  });
});

describe("the edge cases the roster promises (plan 10 A5a)", () => {
  it("has 2025 and 2026 rookies with no yahoo_id", () => {
    const noYahoo = tagged("no_yahoo_id");
    expect(noYahoo.length).toBeGreaterThanOrEqual(2);
    for (const p of noYahoo) {
      expect(p.yahoo_id).toBeNull();
      expect(p.rookie_year).toBeGreaterThanOrEqual(2025);
    }
    expect(tagged("rookie_2025").every((p) => p.rookie_year === 2025)).toBe(true);
    expect(tagged("rookie_2026").every((p) => p.rookie_year === 2026)).toBe(true);
    expect(tagged("rookie_2026").length).toBeGreaterThan(0);
  });

  it("has same-surname players on different teams", () => {
    const bySurname = new Map<string, FixturePlayer[]>();
    for (const p of tagged("same_surname")) {
      bySurname.set(p.last_name, [...(bySurname.get(p.last_name) ?? []), p]);
    }
    const pairs = [...bySurname.values()].filter(
      (g) => g.length >= 2 && new Set(g.map((p) => p.team)).size >= 2,
    );
    expect(pairs.length).toBeGreaterThanOrEqual(1);
    for (const g of bySurname.values()) expect(g.length).toBeGreaterThanOrEqual(2);
  });

  it("has players who changed teams since 2025", () => {
    const moved = tagged("team_change_2026");
    expect(moved.length).toBeGreaterThanOrEqual(1);
    for (const p of moved) {
      expect(p.team_2025).not.toBeNull();
      expect(p.team_2025).not.toBe(p.team);
    }
  });

  it("has a kicker with a team change and names needing normalisation", () => {
    expect(tagged("team_change_2026").some((p) => p.position === "K")).toBe(true);
    expect(tagged("apostrophe_name").every((p) => p.name.includes("'"))).toBe(true);
    expect(tagged("hyphenated_name").every((p) => p.name.includes("-"))).toBe(true);
    expect(tagged("name_suffix").every((p) => /\b(Jr\.|Sr\.|II|III|IV)$/.test(p.name))).toBe(true);
  });
});
