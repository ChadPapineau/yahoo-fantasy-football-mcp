// dst-ya.test.ts — QA-2-032: a team defence's yards allowed (dst_ya) is the opponent's NET yards —
// gross passing yards minus the yards lost on sacks, plus rushing yards (plan 08 §3.2; tables.ts
// DS_TEAM_DEFENSE_WEEK "gross, before sacks"). nflverse stores `sack_yards_lost` as a NEGATIVE number
// (two sacks = −15), so subtracting it as-is added the sack yardage instead. Re-derived independently
// from the raw fixture parquet for every team-game, through the same publish + reader path the tools
// use (ds_team_defense_week → PlayerWeekReader.defenseLines).
import { readFileSync } from "node:fs";
import path from "node:path";
import { parquetReadObjects } from "hyparquet";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isNflTeam } from "../../../src/config/schema.js";
import { makeWorld, ROOT, type World } from "../../mcp/helpers/env.js";

type Raw = Record<string, unknown>;

let world: World;
let raw: Raw[];
beforeAll(async () => {
  world = await makeWorld();
  const buf = readFileSync(
    path.join(ROOT, "fixtures/nflverse/stats_player/stats_player_week_2026.parquet"),
  );
  raw = (await parquetReadObjects({
    file: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  })) as Raw[];
}, 120_000);
afterAll(() => {
  world.cleanup();
});

const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

/** The opponent offence of every team-week, summed over its PLAYER rows (as the aggregator does). */
function offence(): Map<string, { pass: number; sack: number; rush: number; opp: string }> {
  const out = new Map<string, { pass: number; sack: number; rush: number; opp: string }>();
  for (const r of raw) {
    if (typeof r.player_id !== "string" || typeof r.team !== "string") continue;
    const key = `${r.team}|${String(r.week)}`;
    const acc = out.get(key) ?? { pass: 0, sack: 0, rush: 0, opp: String(r.opponent_team) };
    acc.pass += n(r.passing_yards);
    acc.sack += n(r.sack_yards_lost);
    acc.rush += n(r.rushing_yards);
    out.set(key, acc);
  }
  return out;
}

describe("dst_ya = the opponent's net yards (QA-2-032)", () => {
  it("the fixture carries upstream's sign: sack_yards_lost is never positive and often negative (non-vacuity)", () => {
    const vals = raw.map((r) => n(r.sack_yards_lost));
    expect(vals.filter((v) => v < 0).length).toBeGreaterThan(50);
    expect(vals.filter((v) => v > 0)).toEqual([]);
  });

  it("every team-game: dst_ya = opponent gross passing − |sack yards lost| + rushing", () => {
    const off = offence();
    const teams = [...new Set([...off.keys()].map((k) => k.split("|")[0] ?? ""))]
      .filter(isNflTeam)
      .sort();
    expect(teams).toHaveLength(32);
    const res = world.store.datasets.playerWeeks.defenseLines(teams, 2026, [1, 2, 3]);
    expect(res.rows.length).toBe(96);
    let withSacks = 0;
    for (const d of res.rows) {
      const opp = off.get(`${d.opponent ?? "?"}|${String(d.week)}`);
      expect(opp, `${d.nfl_team} w${String(d.week)}`).toBeDefined();
      if (opp === undefined) continue;
      if (opp.sack !== 0) withSacks++;
      expect(d.line.values.dst_ya, `${d.nfl_team} w${String(d.week)} vs ${d.opponent ?? "?"}`).toBe(
        opp.pass - Math.abs(opp.sack) + opp.rush,
      );
      // net yards never exceed the gross total
      expect(d.line.values.dst_ya).toBeLessThanOrEqual(opp.pass + opp.rush);
    }
    expect(withSacks).toBeGreaterThan(50);
  });

  it("PIT 2026 week 1 vs ATL: 143 gross passing, 4 sacks for 25 yards, 120 rushing → 238", () => {
    const d = world.store.datasets.playerWeeks.defenseLines(["PIT"], 2026, [1]).rows[0];
    expect(d?.opponent).toBe("ATL");
    expect(d?.line.values.dst_ya).toBe(238);
  });
});
