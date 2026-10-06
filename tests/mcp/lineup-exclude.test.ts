// lineup-exclude.test.ts — QA-2-038: `exclude` is the start-sit Skill's way of saying "the app shows
// X as inactive" (skills/start-sit/SKILL.md §4 step 2). An excluded player scores 0 this week, so the
// swaps, their intervals, coin_flip, no_move and rec are measured against the lineup the user has,
// with him at 0 — the same answer as `status: O` in league.yaml. His seat scores a known 0, so a
// swap that frees it is priced by the entrant's own quantiles (a Questionable replacement's skewed
// Dist never reads as a loss) and is made whenever the entrant can score. A replacement who scores 0
// too (on bye) gains nothing: no move, never a coin flip, and the seat is left out of rec.lineup with
// an assumption that names it — rec.lineup never starts a player who will not play.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE_LEAGUE, body, connect, makeWorld, type World } from "./helpers/env.js";

const GIBBS = "manual.p.00-0039139"; // RB starter, DET
const ALLEN = "manual.p.00-0034857"; // QB starter, BUF
const LOVE = "manual.p.00-0036264"; // QB bench, GB
const WALKER = "manual.p.00-0038134"; // RB bench, KC (bye in week 5)
const HENRY = "manual.p.00-0032764"; // RB starter, BAL
const BOSWELL = "manual.p.00-0031136"; // K starter, PIT; no K on the bench

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
      assumptions: { text: string; revisit_trigger: string }[];
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
    // the round-2 verification: what is logged never starts him, and the hold is never a coin flip
    expect(starts(d.rec.lineup)).not.toContain(GIBBS);
    expect(d.rec.subjects.map((s) => s.player_key)).not.toContain(GIBBS);
    const texts = d.rec.assumptions.map((a) => a.text);
    expect(texts.some((t) => t.includes("coin flip"))).toBe(false);
    expect(texts.some((t) => t.startsWith("the best lineup change gains nothing"))).toBe(true);
    expect(
      texts.some((t) => t.startsWith("1 starting seat (RB) scores 0") && t.includes(GIBBS)),
    ).toBe(true);
  });
});

describe("QA-2-038 — a Questionable bench replacement (skewed Dist, p10 0)", () => {
  // the round-2 verification's repro: Jeanty written `status: Q` (P(zero) ≥ 0.1, so p10 = 0); the
  // symmetric approximation priced Gibbs → Jeanty at [-1.7, 20.9], held it as a coin flip and kept
  // the excluded Gibbs in rec.lineup
  const dir = mkdtempSync(path.join(tmpdir(), "ff-exq-"));
  chmodSync(dir, 0o700);
  let world: World;
  beforeAll(async () => {
    const from = "{ name: Ashton Jeanty, team: LV, position: RB, slot: BN }";
    const src = readFileSync(FIXTURE_LEAGUE, "utf8");
    if (!src.includes(from)) throw new Error("fixture line moved: Jeanty");
    const file = path.join(dir, "league.yaml");
    writeFileSync(file, src.replace(from, from.replace(" }", ", status: Q }")), { mode: 0o600 });
    world = await makeWorld({ clock: "2026-10-06T08:00:00.000Z", env: { FF_LEAGUE_FILE: file } });
  }, 60_000);
  afterAll(() => {
    world.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  for (const [label, key] of [
    ["Gibbs", GIBBS],
    ["Henry", HENRY],
  ] as const)
    it(`exclude ${label}: the replacement is priced by his own quantiles and started`, async () => {
      const d = (await lineup(world, { exclude: [key] })).data;
      const sw = d.swaps.find((s) => s.out === key);
      expect(sw, JSON.stringify(d.swaps)).toBeDefined();
      if (sw === undefined) return;
      expect(sw.interval[0]).toBeGreaterThanOrEqual(0);
      expect(sw.delta_e).toBeGreaterThan(0);
      expect(sw.coin_flip).toBe(false);
      expect([d.no_move, d.rec.no_move, d.rec.action]).toEqual([
        false,
        false,
        "make 1 lineup change",
      ]);
      expect(starts(d.rec.lineup)).toContain(sw.in);
      expect(starts(d.rec.lineup)).not.toContain(key);
      expect(starts(d.rec.lineup)).toEqual(starts(d.recommended_lineup));
      expect(d.rec.delta_vs_next.p10).toBeGreaterThanOrEqual(0);
    });
});

describe("QA-2-038 — an excluded kicker with no kicker on the bench (week 6)", () => {
  let world: World;
  beforeAll(async () => {
    world = await makeWorld({ clock: "2026-10-06T08:00:00.000Z" });
  }, 60_000);
  afterAll(() => {
    world.cleanup();
  });

  it("the other changes are made; the K seat is named as scoring 0, never called a coin flip", async () => {
    const d = (await lineup(world, { week: 6, exclude: [BOSWELL] })).data;
    expect(d.rec.action).toMatch(/^make \d+ lineup changes?$/);
    expect(d.rec.lineup.some((x) => x.slot === "K")).toBe(false);
    expect(starts(d.rec.lineup)).not.toContain(BOSWELL);
    const texts = d.rec.assumptions.map((a) => a.text);
    expect(texts.some((t) => /coin flip|includes 0/.test(t))).toBe(false);
    const seat = d.rec.assumptions.find((a) => /^\d starting seats? \([^)]*\bK\b/.test(a.text));
    expect(seat?.text, JSON.stringify(texts)).toContain(BOSWELL);
    expect(seat?.revisit_trigger).toMatch(/ff_analyze_waivers/);
  });
});
