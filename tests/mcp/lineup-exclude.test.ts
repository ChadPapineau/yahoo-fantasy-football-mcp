// lineup-exclude.test.ts — QA-2-038: `exclude` is the start-sit Skill's way of saying "the app shows
// X as inactive" (skills/start-sit/SKILL.md §4 step 2). An excluded player scores 0 this week, so the
// swaps, their intervals, coin_flip, no_move and rec are measured against the lineup the user has,
// with him at 0 — the same answer as `status: O` in league.yaml. A replacement who scores 0 too (on
// bye) gains nothing: no move, never a "change" priced at the excluded player's full projection.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { body, connect, makeWorld, type World } from "./helpers/env.js";

const GIBBS = "manual.p.00-0039139"; // RB starter, DET
const ALLEN = "manual.p.00-0034857"; // QB starter, BUF
const LOVE = "manual.p.00-0036264"; // QB bench, GB
const WALKER = "manual.p.00-0038134"; // RB bench, KC (bye in week 5)

interface Swap {
  out: string | null;
  in: string;
  slot: string;
  delta_e: number;
  interval: [number, number];
  coin_flip: boolean;
}
interface E2 {
  data: {
    swaps: Swap[];
    no_move: boolean;
    recommended_lineup: { slot: string; player_key: string }[];
    rec: {
      action: string;
      no_move: boolean;
      lineup: { slot: string; player_key: string }[];
      delta_vs_next: { value: number; p10: number; p90: number };
      subjects: { player_key: string | null; role: string }[];
    };
  };
}

const starts = (rows: readonly { slot: string; player_key: string }[]): string[] =>
  rows.filter((r) => r.slot !== "BN" && r.slot !== "IR").map((r) => r.player_key);

async function lineup(world: World, args: Record<string, unknown>): Promise<E2> {
  const { client, close } = await connect(world);
  try {
    const r = await client.callTool({ name: "ff_analyze_lineup", arguments: args });
    const b = body(r);
    expect(r.isError, JSON.stringify(b).slice(0, 400)).not.toBe(true);
    return b as unknown as E2;
  } finally {
    await close();
  }
}

describe("QA-2-038 — an excluded starter scores 0 (pre-game, week 5)", () => {
  let world: World;
  beforeAll(async () => {
    world = await makeWorld({ clock: "2026-10-06T08:00:00.000Z" });
  }, 60_000);
  afterAll(() => {
    world.cleanup();
  });

  for (const [label, key] of [
    ["Gibbs (RB)", GIBBS],
    ["Allen (QB)", ALLEN],
  ] as const)
    it(`exclude ${label}: his replacement is a decisive move and rec benches him`, async () => {
      const b = await lineup(world, { exclude: [key] });
      const d = b.data;
      const sw = d.swaps.find((s) => s.out === key);
      expect(sw, JSON.stringify(d.swaps)).toBeDefined();
      if (sw === undefined) return;
      // measured against 0: the gain is the replacement's own projection, never negative
      expect(sw.delta_e).toBeGreaterThan(0);
      expect(sw.interval[0]).toBeGreaterThanOrEqual(0);
      expect(d.no_move).toBe(false);
      expect(d.rec.no_move).toBe(false);
      expect(d.rec.action).not.toBe("keep the current lineup");
      // what is logged and scored never starts the excluded player; it agrees with the recommendation
      expect(starts(d.rec.lineup)).not.toContain(key);
      expect(starts(d.rec.lineup)).toContain(sw.in);
      expect(starts(d.recommended_lineup)).not.toContain(key);
      expect(d.rec.delta_vs_next.p10).toBeGreaterThanOrEqual(0);
      expect(d.rec.subjects).toContainEqual(
        expect.objectContaining({ player_key: key, role: "sit" }),
      );
    });

  it("exclude Allen with force_start Love: the forced start is made", async () => {
    const d = (await lineup(world, { exclude: [ALLEN], force_start: [LOVE] })).data;
    expect(starts(d.rec.lineup)).toContain(LOVE);
    expect(starts(d.rec.lineup)).not.toContain(ALLEN);
    expect(d.rec.no_move).toBe(false);
  });
});

describe("QA-2-038 — game day: the only unlocked replacement is on bye", () => {
  let world: World;
  beforeAll(async () => {
    // Sunday of week 5, 18:30Z: the 1 pm games have started; Gibbs (DET) plays later
    world = await makeWorld({ clock: "2026-10-11T18:30:00.000Z" });
  }, 60_000);
  afterAll(() => {
    world.cleanup();
  });

  it("swapping an inactive starter for a bye player gains nothing: no move, no negative Δ", async () => {
    const d = (await lineup(world, { only_unlocked: true, exclude: [GIBBS] })).data;
    for (const s of d.swaps) {
      if (s.out !== GIBBS) continue;
      // both score 0: never priced at Gibbs's full projection
      expect(s.delta_e).toBeGreaterThanOrEqual(0);
      expect(s.interval[0]).toBeGreaterThanOrEqual(0);
    }
    expect(d.rec.delta_vs_next.value).toBeGreaterThanOrEqual(0);
    // the only unlocked bench RB is on bye: the swap is listed, worth 0, a coin flip — and held
    const w = d.swaps.find((s) => s.out === GIBBS);
    expect(w, JSON.stringify(d.swaps)).toMatchObject({
      in: WALKER,
      delta_e: 0,
      interval: [0, 0],
      coin_flip: true,
    });
    expect(d.no_move).toBe(true);
    expect(d.rec.no_move).toBe(true);
    expect(d.rec.action).toBe("keep the current lineup");
    expect(d.rec.delta_vs_next).toEqual({ value: 0, p10: 0, p90: 0 });
  });
});
