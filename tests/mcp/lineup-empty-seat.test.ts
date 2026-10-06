// lineup-empty-seat.test.ts — QA-1-020 / QA-1-040 (reopened in round 2) through the tool: a starter
// moved to IR leaves his seat empty, and the fixture lineup also carries a coin-flip W/R/T swap. The
// no-move rule (QA-1-060) applies change by change, so the fill — which cannot lose points — is made
// and only the coin flip is held: never "keep the current lineup" with an empty starting seat. The
// other way round (the round-2 verification): a decisive change never carries a coin flip with it.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE_LEAGUE, body, connect, makeWorld, type World } from "./helpers/env.js";

interface Swap {
  out: string | null;
  in: string;
  slot: string;
  interval: [number, number];
  delta_e: number;
  coin_flip: boolean;
}
interface E2 {
  data: {
    swaps: Swap[];
    no_move: boolean;
    rec: {
      action: string;
      no_move: boolean;
      latest_execution_time: string | null;
      lineup: { slot: string; player_key: string }[];
    };
  };
}

/** The fixture league with one starter's line moved to IR (status O). */
function toIr(source: string, gsis: string): string {
  const re = new RegExp(`(gsis_id: "${gsis}", )slot: [A-Z/]+ \\}`);
  const out = source.replace(re, "$1slot: IR, status: O }");
  if (out === source) throw new Error(`no starter line for ${gsis}`);
  return out;
}

const STARTING_SEATS = 9; // QB, WR×2, RB×2, TE, W/R/T, K, DEF

describe("a starter moved to IR next to a coin-flip swap (QA-1-020/040 reopened)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ff-ir-"));
  chmodSync(dir, 0o700);
  const worlds = new Map<string, World>();
  const CASES = [
    ["Jahmyr Gibbs (RB)", "00-0039139", "RB"],
    ["Derrick Henry (RB)", "00-0032764", "RB"],
    ["Trey McBride (TE)", "00-0037744", "TE"],
  ] as const;
  beforeAll(async () => {
    const src = readFileSync(FIXTURE_LEAGUE, "utf8");
    for (const [, gsis] of CASES) {
      const file = path.join(dir, `league-${gsis}.yaml`);
      writeFileSync(file, toIr(src, gsis), { mode: 0o600 });
      worlds.set(gsis, await makeWorld({ env: { FF_LEAGUE_FILE: file } }));
    }
  }, 120_000);
  afterAll(() => {
    for (const w of worlds.values()) w.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  for (const [label, gsis, seat] of CASES)
    it(`${label} on IR: the ${seat} seat is filled, every seat is in rec.lineup`, async () => {
      const world = worlds.get(gsis);
      if (world === undefined) throw new Error("no world");
      const { client, close } = await connect(world);
      const r = await client.callTool({ name: "ff_analyze_lineup", arguments: { week: 4 } });
      await close();
      expect(r.isError).not.toBe(true);
      const d = (body(r) as unknown as E2).data;
      const fill = d.swaps.find((s) => s.out === null);
      expect(fill, JSON.stringify(d.swaps)).toMatchObject({ slot: seat, coin_flip: false });
      expect(d.no_move).toBe(false);
      expect(d.rec.no_move).toBe(false);
      expect(d.rec.action).not.toBe("keep the current lineup");
      expect(d.rec.latest_execution_time).not.toBeNull();
      // the logged lineup has no empty seat, and it starts the fill's entrant
      expect(d.rec.lineup).toHaveLength(STARTING_SEATS);
      expect(d.rec.lineup.map((x) => x.player_key)).toContain(fill?.in);
      // every listed swap whose own interval lies above 0 is made; the rest are held, and counted
      // (coin flips and changes that gain nothing apart)
      const made = /make (\d+) lineup change/.exec(d.rec.action);
      const held = /hold (\d+) coin flip/.exec(d.rec.action);
      const skip = /skip (\d+) changes? that gains? nothing/.exec(d.rec.action);
      expect(Number(made?.[1] ?? 0) + Number(held?.[1] ?? 0) + Number(skip?.[1] ?? 0)).toBe(
        d.swaps.length,
      );
      for (const s of d.swaps)
        if (s.interval[0] >= 0 && s.delta_e > 0)
          expect(d.rec.lineup.map((x) => x.player_key)).toContain(s.in);
    });
});

describe("a decisive change never carries a coin flip (the round-2 verification, fixture week 7)", () => {
  const ALLEN = "manual.p.00-0034857"; // QB, BUF: bye in week 7
  const LOVE = "manual.p.00-0036264";
  const CHASE = "manual.p.00-0036900";
  const WALKER = "manual.p.00-0038134";
  let world: World;
  beforeAll(async () => {
    world = await makeWorld({ clock: "2026-10-06T08:00:00.000Z" });
  }, 60_000);
  afterAll(() => {
    world.cleanup();
  });

  const call = async (week: number): Promise<E2["data"]> => {
    const { client, close } = await connect(world);
    const r = await client.callTool({ name: "ff_analyze_lineup", arguments: { week } });
    await close();
    expect(r.isError).not.toBe(true);
    return (body(r) as unknown as E2).data;
  };

  it("week 7: Allen (bye) → Love is made, the Chase → Walker coin flip is held", async () => {
    const d = await call(7);
    const qb = d.swaps.find((s) => s.out === ALLEN);
    const flip = d.swaps.find((s) => s.out === CHASE);
    expect(qb, JSON.stringify(d.swaps)).toMatchObject({ in: LOVE, coin_flip: false });
    expect(flip, JSON.stringify(d.swaps)).toMatchObject({ in: WALKER, coin_flip: true });
    expect(d.rec.action).toBe("make 1 lineup change and hold 1 coin flip");
    const kept = d.rec.lineup.map((x) => x.player_key);
    expect(kept).toContain(LOVE);
    expect(kept).not.toContain(ALLEN);
    expect(kept).toContain(CHASE);
    expect(kept).not.toContain(WALKER);
    expect(d.rec.lineup).toHaveLength(STARTING_SEATS);
  });

  it("week 8: the same coin flip alone is held the same way", async () => {
    const d = await call(8);
    expect(d.swaps.find((s) => s.out === CHASE)).toMatchObject({ in: WALKER, coin_flip: true });
    expect(d.rec.action).toBe("keep the current lineup");
    expect(d.rec.lineup.map((x) => x.player_key)).toContain(CHASE);
  });
});
