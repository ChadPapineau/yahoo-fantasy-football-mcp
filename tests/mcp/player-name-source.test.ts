// player-name-source.test.ts — C1/C2 label a name with the source it came from (QA-1-075; plan 02
// §6.2 "every path-listed bare string carries its real provenance tag, so the Skill can weight it";
// plan 01 §4.2 meta.source lists every contributing source): under the manual league the status-A
// universe adds the nflverse kicker universe, whose names are roster_weekly text — tagged
// nflverse.roster_weekly.name, with nflverse:roster_weekly in meta.source and its CC-BY attribution
// — while league.yaml players stay manual.player.name.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, makeWorld, type World } from "./helpers/env.js";

interface Env {
  data: { players: { name: string; ownership: { type: string } }[] };
  meta: {
    source: string[];
    attribution: { source: string; license: string | null }[];
    untrusted_fields: { path: string; source: string }[];
  };
}

let world: World;
beforeAll(async () => {
  world = await makeWorld();
}, 60_000);
afterAll(() => {
  world.cleanup();
});

async function call(name: string, args: Record<string, unknown>): Promise<Env> {
  const { client, close } = await connect(world);
  const r = await client.callTool({ name, arguments: args });
  await close();
  const text = (r.content as { text: string }[])[0]?.text ?? "";
  expect(r.isError, text.slice(0, 200)).not.toBe(true);
  return JSON.parse(text) as Env;
}

const NAME = "data.players[].name";
const tags = (e: Env) =>
  e.meta.untrusted_fields.filter((f) => f.path === NAME).map((f) => f.source);

describe("player name provenance under the manual league (QA-1-075)", () => {
  for (const [tool, args] of [
    ["ff_list_players", { status: "A", position: "K", limit: 50 }],
    ["ff_list_players", { status: "FA", position: "K", limit: 50 }],
  ] as const)
    it(`${tool} ${JSON.stringify(args)}: dataset names are tagged nflverse, with its source and attribution`, async () => {
      const e = await call(tool, args);
      expect(e.data.players.some((p) => p.ownership.type === "unknown")).toBe(true); // control
      expect(tags(e)).toContain("nflverse.roster_weekly.name");
      expect(e.meta.source).toContain("nflverse:roster_weekly");
      expect(e.meta.attribution.map((a) => a.source)).toContain("nflverse");
    });

  it("ff_search_players for a dataset-only kicker: tagged nflverse, not manual", async () => {
    const list = await call("ff_list_players", { status: "A", position: "K", limit: 50 });
    const dataset = list.data.players.find((p) => p.ownership.type === "unknown");
    expect(dataset).toBeDefined();
    const q = (dataset?.name ?? "").split(" ").at(-1) ?? "";
    const e = await call("ff_search_players", { query: q, position: "K" });
    expect(e.data.players.length).toBeGreaterThan(0);
    expect(e.data.players.every((p) => p.ownership.type === "unknown")).toBe(true);
    expect(tags(e)).toEqual(["nflverse.roster_weekly.name"]);
    expect(e.meta.source).toContain("nflverse:roster_weekly");
  });

  it("a league.yaml player stays manual.player.name and adds no dataset source", async () => {
    const e = await call("ff_search_players", { query: "Josh Allen" });
    expect(e.data.players.length).toBeGreaterThan(0);
    expect(tags(e)).toEqual(["manual.player.name"]);
    expect(e.meta.source).not.toContain("nflverse:roster_weekly");
  });
});
