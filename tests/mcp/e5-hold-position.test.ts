// e5-hold-position.test.ts — QA-2-004: ff_analyze_waivers returns ONE hold_vs_stream, the requested
// position whose best option gains most over its starter, so in the default call (positions
// ["K", "DEF"]) it can describe another position than rec. Its `position` names the position its
// numbers describe: the served result passes the strict output schema with it, and the numbers are
// that position's own single-position call's.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, makeWorld, type World } from "./helpers/env.js";

type Json = Record<string, unknown>;
interface Hold {
  position: string;
  streamability: number;
  current_starter_delta: number;
}

let world: World;
beforeAll(async () => {
  world = await makeWorld();
}, 60_000);
afterAll(() => {
  world.cleanup();
});

/** A successful ff_analyze_waivers call's `data` (the server validates it against its schema). */
async function waivers(args: Json): Promise<{ hold_vs_stream: Hold | null; rec: Json }> {
  const { client, close } = await connect(world);
  try {
    const r = await client.callTool({ name: "ff_analyze_waivers", arguments: args });
    const text = (r.content as { text: string }[])[0]?.text ?? "";
    expect(r.isError === true, text.slice(0, 300)).toBe(false);
    return (JSON.parse(text) as { data: { hold_vs_stream: Hold | null; rec: Json } }).data;
  } finally {
    await close();
  }
}

describe("QA-2-004: hold_vs_stream names the position it describes", () => {
  it("the default two-position call labels it, with that position's own numbers", async () => {
    const both = await waivers({ look_ahead: 2 });
    const hold = both.hold_vs_stream;
    if (hold === null)
      throw new Error("the fixture team has a K and a DEF: hold_vs_stream expected");
    expect(["K", "DEF"]).toContain(hold.position);
    const alone = await waivers({ positions: [hold.position], look_ahead: 2 });
    expect(alone.hold_vs_stream).toEqual(hold);
  }, 60_000);

  it("each one-position call labels it with the position asked for", async () => {
    for (const pos of ["K", "DEF"]) {
      const one = await waivers({ positions: [pos], look_ahead: 2 });
      expect(one.hold_vs_stream?.position).toBe(pos);
    }
  }, 60_000);
});
