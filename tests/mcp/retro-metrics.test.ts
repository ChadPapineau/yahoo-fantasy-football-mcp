// retro-metrics.test.ts — ff_analyze_retrospective's scores at the MCP surface, over the fixture league:
// QA-2-041 — a lineup call's regret compares like with like: an alternative logged as a whole lineup,
// as a swap (start + sit) or as one player into a slot the lineup holds once scores the same regret,
// realised(alternative lineup) − realised(recommended lineup), never one player against a lineup.
// QA-2-042 — metrics.per_player counts every stored pre-lock projection of the week's rosters (mine
// and the opponent's), so the default min_n of 30 is reached in one week once both are projected.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seededRng } from "../../src/domain/clock.js";
import { TEAM_A, TEAM_B, body, connect, makeWorld, type World } from "./helpers/env.js";

let world: World;
let c: Awaited<ReturnType<typeof connect>>;

interface Env {
  data: Record<string, unknown>;
  meta: { request_id: string };
  warnings: string[];
}
interface Subject {
  player_key: string | null;
  gsis_id: string | null;
  nfl_team: string | null;
  role: string;
  slot: string | null;
}
interface Call {
  log_id: string;
  regret: number | null;
  realised: number | null;
  best_alternative: string | null;
}
const ok = async (name: string, args: Record<string, unknown>): Promise<Env> => {
  const r = await c.client.callTool({ name, arguments: args });
  const b = body(r);
  if (r.isError === true) throw new Error(`${name}: ${JSON.stringify(b)}`);
  return b as unknown as Env;
};
/** The fixture releases are dated after this scenario's pre-week-3 clock: re-date the rec to it. */
const redate = (rec: unknown): Record<string, unknown> => {
  const now = world.clock.nowIso();
  const r = rec as { confidence: { inputs: object[] } } & Record<string, unknown>;
  return {
    ...r,
    as_of: now,
    confidence: { ...r.confidence, inputs: r.confidence.inputs.map((i) => ({ ...i, as_of: now })) },
  };
};

// --- QA-2-041 fixtures: for each slot the lineup holds once, a bench player who could have started
/** Candidates per single-count slot (gsis ids of my roster, fixtures/manual/league.yaml). */
const CANDIDATES: Readonly<Record<string, readonly string[]>> = {
  QB: ["00-0034857", "00-0036264"], // Allen, Love
  TE: ["00-0037744", "00-0033090"], // McBride, Hunter Henry
  "W/R/T": ["00-0038543", "00-0030279", "00-0038134"], // Smith-Njigba, Keenan Allen, Walker
};
const player = (gsis: string, role: string, slot: string): Subject => ({
  player_key: `manual.p.${gsis}`,
  gsis_id: gsis,
  nfl_team: null,
  role,
  slot,
});
const logIds = new Map<string, string>();
let alternativeDist: unknown;

// --- QA-2-042 fixtures: the opponent's players with a gsis id (fixtures/manual/league.yaml, Team B)
const OPPONENT_GSIS = [
  "00-0034796",
  "00-0036358",
  "00-0036322",
  "00-0038542",
  "00-0034844",
  "00-0033288",
  "00-0037238",
  "00-0037692",
  "00-0036389",
  "00-0037248",
  "00-0037740",
  "00-0039075",
  "00-0039338",
];
let mine = 0;
let opponentFirst = 0;
/** n_player_weeks once both rosters were projected before lock. */
let bothBeforeLock = 0;

const PRE_LOCK = "2026-09-23T12:00:00.000Z";
const FINAL = "2026-10-02T15:00:00.000Z";

beforeAll(async () => {
  world = await makeWorld({ clock: PRE_LOCK });
  c = await connect(world);
  // QA-2-042: my roster and a seeded subset of the opponent's are projected before week 3 locks
  const a = await ok("ff_project_players", {
    players: { team_key: TEAM_A },
    horizon: "week",
    week: 3,
    seed: 11,
  });
  mine = (a.data.projections as unknown[]).length;
  const rng = seededRng(2042);
  const k = 2 + Math.floor(rng.next() * 9);
  const subset = OPPONENT_GSIS.filter((_, i) => i < k);
  const b = await ok("ff_project_players", {
    players: { gsis_ids: subset },
    horizon: "week",
    week: 3,
    seed: 12,
  });
  opponentFirst = (b.data.projections as unknown[]).length;
  expect(opponentFirst).toBe(subset.length);

  // QA-2-041: the week-3 lineup call, and the same alternative logged in three shapes per slot
  const lineup = await ok("ff_analyze_lineup", { week: 3 });
  const rec = redate(lineup.data.rec);
  alternativeDist = rec.distribution;
  const subjects = rec.subjects as Subject[];
  const starts = subjects.filter((s) => s.role === "start");
  const record = async (name: string, r: Record<string, unknown>, alternatives: Subject[][]) => {
    const out = await ok("ff_record_recommendation", {
      kind: "lineup",
      week: 3,
      rec: r,
      alternatives: alternatives.map((s, i) => ({
        action: `${name} alternative ${String(i)}`,
        subjects: s,
        point_estimate: 10,
        distribution: alternativeDist,
        decision_metric_value: 10,
      })),
      source_calls: [{ tool: "ff_analyze_lineup", request_id: lineup.meta.request_id }],
      client_ref: `qa2041-${name.replaceAll("/", "")}`,
    });
    logIds.set(name, out.data.log_id as string);
  };
  await record("base", rec, []);
  for (const [slot, candidates] of Object.entries(CANDIDATES)) {
    const x = starts.find((s) => s.slot === slot);
    const y = candidates.find((g) => !starts.some((s) => s.gsis_id === g));
    if (x?.gsis_id == null || y === undefined) throw new Error(`no ${slot} pair in the lineup`);
    const whole = starts.map((s) => (s === x ? player(y, "start", slot) : s));
    // the alternative lineup as a recommendation of its own: its realised total is the reference
    await record(`${slot}-reference`, { ...rec, action: `${slot} reference`, subjects: whole }, []);
    await record(`${slot}-whole`, rec, [whole]);
    await record(`${slot}-swap`, rec, [[player(y, "start", slot), player(x.gsis_id, "sit", slot)]]);
    await record(`${slot}-start`, rec, [[player(y, "start", slot)]]);
  }
  world.clock.set(FINAL);
}, 180_000);
afterAll(async () => {
  await c.close();
  world.cleanup();
});

describe("QA-2-041: a lineup call's regret compares like with like", () => {
  it("whole lineup, swap and one-player alternatives score the same, lineup-for-lineup regret", async () => {
    const e = await ok("ff_analyze_retrospective", { week: 3, allow_stale: true });
    const byId = new Map((e.data.calls as Call[]).map((x) => [x.log_id, x]));
    const call = (name: string): Call => {
      const got = byId.get(logIds.get(name) ?? "");
      if (got === undefined) throw new Error(`no scored call ${name}`);
      return got;
    };
    const base = call("base").realised;
    expect(typeof base).toBe("number");
    for (const slot of Object.keys(CANDIDATES)) {
      const reference = call(`${slot}-reference`).realised;
      expect(typeof reference).toBe("number");
      const want = reference! - base!;
      for (const shape of ["whole", "swap", "start"]) {
        const got = call(`${slot}-${shape}`);
        expect(got.regret, `${slot} ${shape}`).not.toBeNull();
        expect(got.regret!, `${slot} ${shape}`).toBeCloseTo(want, 6);
        expect(got.best_alternative).toBe(`${slot}-${shape} alternative 0`);
      }
    }
    expect(e.warnings.some((w) => w.includes("not like-for-like"))).toBe(false);
  });
});

describe("QA-2-042: per-player metrics count every roster of the week's matchup", () => {
  it("the opponent's stored pre-lock projections are counted beside mine", async () => {
    const e = await ok("ff_analyze_retrospective", { week: 3, min_n: 1, allow_stale: true });
    const pp = (e.data.metrics as { per_player: { n_player_weeks: number } }).per_player;
    expect(pp.n_player_weeks).toBe(mine + opponentFirst);
  });

  it("with both rosters projected before lock, the default min_n of 30 is reached in one week", async () => {
    world.clock.set(PRE_LOCK);
    const b = await ok("ff_project_players", {
      players: { team_key: TEAM_B },
      horizon: "week",
      week: 3,
      seed: 13,
    });
    const opponent = (b.data.projections as unknown[]).length;
    world.clock.set(FINAL);
    const e = await ok("ff_analyze_retrospective", { week: 3, allow_stale: true });
    const m = e.data.metrics as {
      per_player: { crps: number | null; coverage_80: number | null; n_player_weeks: number };
    };
    expect(m.per_player.n_player_weeks).toBe(mine + opponent);
    expect(m.per_player.n_player_weeks).toBeGreaterThanOrEqual(30);
    bothBeforeLock = m.per_player.n_player_weeks;
    expect(typeof m.per_player.crps).toBe("number");
    expect(typeof m.per_player.coverage_80).toBe("number");
    const n = e.data.n_by_metric as {
      metric: string;
      n: number;
      min_n: number;
      reached: boolean;
    }[];
    expect(n.find((x) => x.metric === "per_player")).toEqual({
      metric: "per_player",
      n: mine + opponent,
      min_n: 30,
      reached: true,
    });
  });

  it("an opponent projection made after the week locked is never scored", async () => {
    // after kickoff: a fresh run for the opponent with a new seed adds nothing to the count
    await ok("ff_project_players", {
      players: { team_key: TEAM_B },
      horizon: "week",
      week: 3,
      seed: 14,
      allow_stale: true,
    });
    const e = await ok("ff_analyze_retrospective", { week: 3, min_n: 1, allow_stale: true });
    const pp = (e.data.metrics as { per_player: { n_player_weeks: number } }).per_player;
    expect(bothBeforeLock).toBeGreaterThan(0);
    expect(pp.n_player_weeks).toBe(bothBeforeLock);
  });
});
