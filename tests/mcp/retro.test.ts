// retro.test.ts — plan 10 A9 at the MCP surface: projections made BEFORE week 3's locks are stored
// by ff_project_players, week-3 calls are logged with ff_record_recommendation, and once week 3 is
// final ff_analyze_retrospective scores them (followed, regret, per-player CRPS/pinball/coverage
// from the pre-lock projections only, swap regret; p_win etc. "n too small"); the scored outcomes
// are persisted, so ff_list_recommendations reports `followed`.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEAM_A, body, connect, makeWorld, type World } from "./helpers/env.js";

let world: World;
let c: Awaited<ReturnType<typeof connect>>;
const logged: string[] = [];

interface Env {
  data: Record<string, unknown>;
  meta: { provisional: boolean; freshness: string };
  warnings: string[];
}
/**
 * The fixture releases are dated 2026-09-30, after this scenario's pre-week-3 clock, so a rec's
 * `as_of` (the newest input) would be "in the future" for E12 — an artefact of replaying a past week
 * on today's files. The scenario re-dates it to the clock, as a live pre-week-3 run would have.
 */
const redate = (rec: unknown): unknown => {
  const now = world.clock.nowIso();
  const r = rec as { as_of: string; confidence: { inputs: { as_of: string }[] } };
  return {
    ...r,
    as_of: now,
    confidence: { ...r.confidence, inputs: r.confidence.inputs.map((i) => ({ ...i, as_of: now })) },
  };
};
const ok = async (name: string, args: Record<string, unknown>): Promise<Env> => {
  const r = await c.client.callTool({ name, arguments: args });
  const b = body(r);
  if (r.isError === true) throw new Error(`${name}: ${JSON.stringify(b)}`);
  return b as unknown as Env;
};

beforeAll(async () => {
  // Wednesday before week 3 (its first kickoff is Thursday 2026-09-24)
  world = await makeWorld({ clock: "2026-09-23T12:00:00.000Z" });
  c = await connect(world);
  const proj = await ok("ff_project_players", {
    players: { team_key: TEAM_A },
    horizon: "week",
    week: 3,
    seed: 11,
  });
  expect(proj.warnings.some((w) => w.includes("not stored"))).toBe(false);
  const lineup = await ok("ff_analyze_lineup", { week: 3 });
  const r1 = await ok("ff_record_recommendation", {
    kind: "lineup",
    week: 3,
    rec: redate(lineup.data.rec),
    followed_hint: "user_said_yes",
    client_ref: "retro-lineup-w3",
  });
  logged.push(r1.data.log_id as string);
  const stream = await ok("ff_analyze_waivers", { positions: ["DEF"], look_ahead: 0 });
  const r2 = await ok("ff_record_recommendation", {
    kind: "stream",
    week: 3,
    rec: redate(stream.data.rec),
    alternatives: [],
    client_ref: "retro-stream-w3",
    note: "stream <b>it</b>",
  });
  logged.push(r2.data.log_id as string);
  // Friday after week 4's Thursday kickoff: week 3 is final
  world.clock.set("2026-10-02T15:00:00.000Z");
}, 90_000);
afterAll(async () => {
  await c.close();
  world.cleanup();
});

describe("the week-3 retrospective (A9)", () => {
  it("scores both calls on final stats with the pre-lock projections", async () => {
    const e = await ok("ff_analyze_retrospective", { week: 3, min_n: 1, allow_stale: true });
    expect(e.data.final).toBe(true);
    expect(e.meta.provisional).toBe(false);
    const calls = e.data.calls as {
      log_id: string;
      kind: string;
      followed: boolean | null;
      realised: number | null;
      regret: number | null;
    }[];
    expect(calls.map((x) => x.log_id).sort()).toEqual([...logged].sort());
    // `followed` is settled either way: from the week's roster while the fixture league file is
    // unchanged since week 3 locked, else (its checkout time is later) from the logged hint
    // "user_said_yes" — tests/mcp/retro-followed.test.ts holds both paths (QA-2-040)
    const lineup = calls.find((x) => x.kind === "lineup");
    expect(typeof lineup?.followed).toBe("boolean");
    expect(typeof lineup?.realised).toBe("number");
    const m = e.data.metrics as {
      per_player: { crps: number | null; n_player_weeks: number; coverage_80: number | null };
      swap_regret: { n_swaps: number };
      brier: { p_active: unknown; p_win: unknown };
    };
    expect(m.per_player.n_player_weeks).toBeGreaterThan(5);
    expect(typeof m.per_player.crps).toBe("number");
    expect(m.per_player.coverage_80).not.toBeNull();
    expect(m.brier.p_win).toBe("n too small (0 of 1)");
    const n = e.data.n_by_metric as { metric: string; reached: boolean }[];
    expect(n.find((x) => x.metric === "per_player")?.reached).toBe(true);
    expect(e.data).not.toHaveProperty("parameter_changes_proposed");
  });

  it("the default min_n of 30 reports every short metric as a caveat", async () => {
    const e = await ok("ff_analyze_retrospective", { week: 3, allow_stale: true });
    const caveats = e.data.sample_size_caveats as string[];
    expect(caveats.some((x) => x.startsWith("brier.p_win: n too small"))).toBe(true);
  });

  it("the default week is the last final week", async () => {
    const e = await ok("ff_analyze_retrospective", { allow_stale: true });
    expect(e.data.week).toBe(3);
  });

  it("the persisted outcomes make E14 report followed; kinds filters the calls", async () => {
    const list = await ok("ff_list_recommendations", { week: 3 });
    const items = list.data.items as { log_id: string; followed: boolean | null; kind: string }[];
    expect(typeof items.find((i) => i.kind === "lineup")?.followed).toBe("boolean");
    const only = await ok("ff_analyze_retrospective", {
      week: 3,
      kinds: ["stream"],
      allow_stale: true,
    });
    expect((only.data.calls as { kind: string }[]).map((x) => x.kind)).toEqual(["stream"]);
  });

  it("without allow_stale the week-old datasets are STALE_ONLY", async () => {
    const r = await c.client.callTool({ name: "ff_analyze_retrospective", arguments: { week: 3 } });
    expect(r.isError).toBe(true);
    expect((body(r) as { error: { code: string } }).error.code).toBe("STALE_ONLY");
  });
});
