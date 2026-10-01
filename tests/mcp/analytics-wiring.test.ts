// analytics-wiring.test.ts — the tool layer hands the engines everything they need (round-1 QA
// hand-offs to src/mcp/tools/analytics.ts and datasets.ts):
// - QA-1-003/QA-1-023: E2/E3/E5 take no seed argument, so their seed comes from the call's canonical
//   inputs — two identical calls give identical quantiles and p_win even when the server's fresh-seed
//   source would draw a new seed every call;
// - QA-1-030: the nflverse weekly roster reaches the engines (a reserve-list player is out) and D2
//   marks a RES player IR-eligible;
// - QA-1-020/QA-1-040: a fill of an empty starting seat is listed in swaps as { out: null };
// - QA-1-022: E5 honours a weekly-lock league;
// - QA-1-004: lines past their 24 h hard limit are named in E2/E3 warnings and withheld by D3.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LINES_OMITTED_WARNING } from "../../src/mcp/tools/analytics.js";
import { LINES_EXPIRED_WARNING } from "../../src/mcp/tools/datasets.js";
import { FIXTURE_LEAGUE, T0, connect, makeWorld, type World } from "./helpers/env.js";

type Json = Record<string, unknown>;

async function call(w: Pick<World, "services" | "options">, name: string, args: Json) {
  const { client, close } = await connect(w);
  const r = await client.callTool({ name, arguments: args });
  await close();
  const text = (r.content as { text: string }[])[0]?.text ?? "";
  return { isError: r.isError === true, body: JSON.parse(text) as Json, text };
}
const ok = async (w: Pick<World, "services" | "options">, name: string, args: Json) => {
  const r = await call(w, name, args);
  expect(r.isError, r.text.slice(0, 300)).toBe(false);
  return r.body as { data: Json; warnings: string[] };
};

/** A world built over an edited copy of the fixture league (a private 0600 file). */
async function editedWorld(
  edits: readonly (readonly [string, string])[],
  clock?: string,
): Promise<{ world: World; done: () => void }> {
  const dir = mkdtempSync(path.join(tmpdir(), "ff-wire-"));
  chmodSync(dir, 0o700);
  const file = path.join(dir, "league.yaml");
  let yaml = readFileSync(FIXTURE_LEAGUE, "utf8");
  for (const [a, b] of edits) {
    if (!yaml.includes(a)) throw new Error(`fixture league has no ${a}`);
    yaml = yaml.replace(a, b);
  }
  writeFileSync(file, yaml, { mode: 0o600 });
  const world = await makeWorld({ env: { FF_LEAGUE_FILE: file }, ...(clock ? { clock } : {}) });
  return {
    world,
    done: () => {
      world.cleanup();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

let world: World;
beforeAll(async () => {
  world = await makeWorld();
}, 60_000);
afterAll(() => {
  world.cleanup();
});

/** The world with a fresh-seed source that never repeats (the production behaviour). */
const freshSeeds = (): World => {
  let n = 100;
  return { ...world, services: { ...world.services, newSeed: () => (n += 7919) } };
};

describe("E2/E3/E5 are reproducible: the seed comes from the call's inputs [QA-1-003, QA-1-023]", () => {
  for (const [tool, args] of [
    ["ff_analyze_lineup", { week: 3, objective: "pwin" }],
    ["ff_analyze_matchup", { week: 3 }],
    ["ff_analyze_waivers", {}],
  ] as const)
    it(`${tool}: two identical calls return identical data`, async () => {
      const w = freshSeeds();
      const a = await ok(w, tool, args);
      const b = await ok(w, tool, args);
      expect(b.data).toEqual(a.data);
    });
});

describe("the weekly roster reaches the engines [QA-1-030]", () => {
  // week 4 (the clock's week): a roster status applies from its own week on, never to earlier weeks
  const CHASE = "00-0036900";
  const ALLEN = "00-0034857";
  const resWorld = (gsis = CHASE): World => {
    const base = world.services.rosterWeekly;
    return {
      ...world,
      services: {
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
      },
    };
  };

  it("E1: a reserve-list player is out (p_active 0)", async () => {
    const plain = await ok(world, "ff_project_players", {
      players: { player_keys: [`manual.p.${CHASE}`] },
      horizon: "week",
      week: 4,
    });
    const res = await ok(resWorld(), "ff_project_players", {
      players: { player_keys: [`manual.p.${CHASE}`] },
      horizon: "week",
      week: 4,
    });
    const pa = (d: Json) =>
      (d.projections as { weeks: { p_active: number | null }[] }[])[0]?.weeks[0]?.p_active;
    expect(pa(plain.data)).toBeGreaterThan(0.5); // control: active in the fixture
    expect(pa(res.data)).toBe(0);
  });

  it("E2: a reserve-list starter is benched", async () => {
    const slotOf = async (w: World) =>
      (
        (await ok(w, "ff_analyze_lineup", { week: 4 })).data as {
          recommended_lineup: { player_key: string; slot: string }[];
        }
      ).recommended_lineup.find((r) => r.player_key === `manual.p.${ALLEN}`)?.slot;
    expect(await slotOf(world)).toBe("QB"); // control: he starts in the fixture
    expect(await slotOf(resWorld(ALLEN))).toBe("BN");
  });

  it("D2: a RES player is IR-eligible", async () => {
    const d = (await ok(resWorld(), "ff_get_injuries", {})).data as {
      players: { gsis_id: string | null; ir_eligible: boolean; p_active: number | null }[];
    };
    const p = d.players.find((x) => x.gsis_id === CHASE);
    expect(p?.p_active).toBe(0);
    expect(p?.ir_eligible).toBe(true);
    const plain = (await ok(world, "ff_get_injuries", {})).data as typeof d;
    expect(plain.players.find((x) => x.gsis_id === CHASE)?.ir_eligible).toBe(false); // control
  });
});

describe("a fill of an empty starting seat is a listed swap [QA-1-020, QA-1-040]", () => {
  it("swaps carries { out: null, in, slot } for the empty W/R/T seat", async () => {
    const { world: w, done } = await editedWorld([
      [
        `    - { name: Jaxon Smith-Njigba, team: SEA, position: WR, gsis_id: "00-0038543", slot: W/R/T }\n`,
        "",
      ],
    ]);
    try {
      // week 4: the clock (T0) is before its games, so the seat can still be filled
      const d = (await ok(w, "ff_analyze_lineup", { week: 4 })).data as {
        swaps: { out: string | null; in: string; slot: string }[];
        no_move: boolean;
      };
      const fill = d.swaps.find((s) => s.out === null);
      expect(fill, JSON.stringify(d.swaps)).toBeDefined();
      expect(fill?.slot).toBe("W/R/T");
      expect(d.no_move).toBe(false);
    } finally {
      done();
    }
  }, 60_000);
});

describe("E5 honours a weekly-lock league [QA-1-022]", () => {
  /** Friday of week 4: the Thursday game has kicked off, the Sunday games have not. */
  const FRIDAY_W4 = "2026-10-02T18:00:00.000Z";
  const cands = async (lock: string) => {
    const { world: w, done } = await editedWorld(
      [["  lineup_lock: per_game", `  lineup_lock: ${lock}`]],
      FRIDAY_W4,
    );
    try {
      const d = (await ok(w, "ff_analyze_waivers", {})).data as { candidates: unknown[] };
      return d.candidates.length;
    } finally {
      done();
    }
  };
  it("per-game lock: Sunday K/DEF are still streamable; weekly lock: none is", async () => {
    expect(await cands("per_game")).toBeGreaterThan(0); // control
    expect(await cands("weekly")).toBe(0);
  }, 90_000);
});

describe("betting lines past their 24 h hard limit [QA-1-004]", () => {
  it("E2 and E3 warn that lines were omitted; D3 withholds them with a warning", async () => {
    const w = await makeWorld();
    try {
      // a day and an hour after the publish: lines expired, everything else merely stale
      w.clock.set(Date.parse(T0) + 25 * 3_600_000);
      for (const [tool, args] of [
        ["ff_analyze_lineup", { week: 3, allow_stale: true }],
        ["ff_analyze_matchup", { week: 3, allow_stale: true }],
      ] as const) {
        const b = await ok(w, tool, args);
        expect(b.warnings, tool).toContain(LINES_OMITTED_WARNING);
      }
      const d3 = await ok(w, "ff_get_schedule", { weeks: [3], allow_stale: true });
      expect((d3.data.games as { lines: unknown }[]).every((g) => g.lines === null)).toBe(true);
      expect(d3.warnings).toContain(LINES_EXPIRED_WARNING);
      // control: fresh lines are served without the warning
      w.clock.set(T0);
      const fresh = await ok(w, "ff_get_schedule", { weeks: [3] });
      expect((fresh.data.games as { lines: unknown }[]).some((g) => g.lines !== null)).toBe(true);
      expect(fresh.warnings).not.toContain(LINES_EXPIRED_WARNING);
    } finally {
      w.cleanup();
    }
  }, 60_000);
});

describe("E5 never offers my own starter as a streamer [QA-1-041 follow-up]", () => {
  it("a rostered kicker entered by name only is not a candidate under his gsis key", async () => {
    const BOSWELL = "00-0031136";
    const { world: w, done } = await editedWorld([
      [
        `{ name: Chris Boswell, team: PIT, position: K, gsis_id: "${BOSWELL}", slot: K }`,
        "{ name: Chris Boswell, team: PIT, position: K, slot: K }",
      ],
    ]);
    try {
      const r = await call(w, "ff_analyze_waivers", {
        positions: ["K"],
        candidates: [`manual.p.${BOSWELL}`],
      });
      const cands = r.isError
        ? []
        : (r.body as { data: { candidates: { gsis_id: string | null }[] } }).data.candidates;
      expect(cands.map((c) => c.gsis_id)).not.toContain(BOSWELL);
      // control: E5 does list kicker candidates
      const other = await ok(world, "ff_analyze_waivers", { positions: ["K"] });
      expect((other.data.candidates as unknown[]).length).toBeGreaterThan(0);
    } finally {
      done();
    }
  }, 60_000);
});
