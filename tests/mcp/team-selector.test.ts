// team-selector.test.ts — the `nfl_team` player selector means the team's CURRENT players
// (QA-1-035): a player whose newest roster row is CUT or practice squad (DEV) is not presented as
// the team's player; a reserve-list (RES) player is shown unavailable (p_active 0), as E5's kicker
// universe and the projection's roster-status rule already treat them (plan 07 E5; QA-1-030).
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, makeWorld, type World } from "./helpers/env.js";

interface D2 {
  data: { players: { gsis_id: string | null; p_active: number | null }[] };
}

let world: World;
/** gsis_id → newest 2026 roster row (status, team). */
let newest: Map<string, { status: string | null; team: string }>;
beforeAll(async () => {
  world = await makeWorld();
  const db = new DatabaseSync(path.join(world.cache, "ds", "nflverse__roster_weekly.sqlite"), {
    readOnly: true,
  });
  const rows = db
    .prepare(
      "select gsis_id, team, status, week from ds_roster_weekly where season = 2026 order by week",
    )
    .all() as { gsis_id: string; team: string; status: string | null }[];
  db.close();
  newest = new Map(rows.map((r) => [r.gsis_id, { status: r.status, team: r.team }]));
}, 60_000);
afterAll(() => {
  world.cleanup();
});

async function injuries(team: string, w: World = world): Promise<D2["data"]["players"]> {
  const { client, close } = await connect(w);
  const r = await client.callTool({
    name: "ff_get_injuries",
    arguments: { players: { nfl_team: team } },
  });
  await close();
  expect(r.isError, (r.content as { text: string }[])[0]?.text.slice(0, 200)).not.toBe(true);
  const d = JSON.parse((r.content as { text: string }[])[0]?.text ?? "{}") as D2;
  return d.data.players.filter((p) => p.gsis_id !== null);
}

describe("nfl_team selector (QA-1-035)", () => {
  it("CUT and practice-squad (DEV) players are not the team's players", async () => {
    const teams = new Set(
      [...newest.values()]
        .filter((r) => r.status === "CUT" || r.status === "DEV")
        .map((r) => r.team),
    );
    expect(teams.size).toBeGreaterThan(0); // control: the fixture has such rows
    for (const team of teams) {
      const players = await injuries(team);
      for (const p of players) {
        const row = newest.get(p.gsis_id ?? "");
        expect(row?.team, p.gsis_id ?? "").toBe(team);
        expect(["CUT", "DEV"], `${team} ${p.gsis_id ?? ""}`).not.toContain(row?.status);
      }
      // the team's active players are all still there
      const act = [...newest.entries()].filter(([, r]) => r.team === team && r.status === "ACT");
      const shown = new Set(players.map((p) => p.gsis_id));
      for (const [g] of act.slice(0, 5)) expect(shown.has(g) || act.length > 39, g).toBe(true);
    }
  });

  it("a reserve-list (RES) player is shown unavailable: p_active 0", async () => {
    const [gsis, row] = [...newest.entries()].find(([, r]) => r.status === "ACT") ?? [];
    expect(gsis).toBeDefined();
    if (gsis === undefined || row === undefined) return;
    const base = world.services.rosterWeekly;
    const services = {
      ...world.services,
      rosterWeekly: {
        ...base,
        latest: (season: number) => {
          const r = base.latest(season);
          return {
            ...r,
            rows: r.rows.map((x) => (x.gsis_id === gsis ? { ...x, status: "RES" } : x)),
          };
        },
      },
    };
    const players = await injuries(row.team, { ...world, services });
    const p = players.find((x) => x.gsis_id === gsis);
    expect(p, "a RES player is still listed with his team").toBeDefined();
    expect(p?.p_active).toBe(0);
  });
});
