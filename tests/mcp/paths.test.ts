// paths.test.ts — the remaining decision paths of the tools: selector resolution (keys outside the
// league, unknown ids, nfl_team ordering), A2 `include` subsets, A1 filters, G1's refresh-failure and
// write-request rows, a record without a note read back, and C2's argument refinements.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LEAGUE_KEY, body, connect, makeWorld, type World } from "./helpers/env.js";
import { envelopeViolations } from "./helpers/walk.js";

interface Env {
  data: Record<string, unknown>;
  meta: { untrusted_fields: { path: string; source: string }[] };
  warnings: string[];
}
let world: World;
let c: Awaited<ReturnType<typeof connect>>;
const ok = async (name: string, args: Record<string, unknown> = {}): Promise<Env> => {
  const r = await c.client.callTool({ name, arguments: args });
  const b = body(r) as unknown as Env;
  if (r.isError === true) throw new Error(`${name}: ${JSON.stringify(b)}`);
  expect(envelopeViolations(b as never)).toEqual([]);
  return b;
};
const code = async (name: string, args: Record<string, unknown>): Promise<string> => {
  const r = await c.client.callTool({ name, arguments: args });
  expect(r.isError).toBe(true);
  return (body(r) as { error: { code: string } }).error.code;
};

beforeAll(async () => {
  world = await makeWorld();
  c = await connect(world);
}, 60_000);
afterAll(async () => {
  await c.close();
  world.cleanup();
});

describe("selectors (plan 07 legend PlayerSelector)", () => {
  it("player_keys: a league player, a defence, a player outside the league, an unknown id", async () => {
    const e = await ok("ff_get_injuries", {
      players: {
        player_keys: [
          "manual.p.00-0034857", // in league.yaml
          "manual.p.def-min", // a defence (the universe)
          "manual.p.00-0035719", // on the nflverse roster, not in league.yaml
          "manual.p.00-0000001", // nowhere
          "manual.p.n-0123456789abcdef", // a name key the league does not hold
        ],
      },
    });
    const rows = e.data.players as { player_key: string; gsis_id: string | null }[];
    expect(rows.map((r) => r.player_key)).toEqual([
      "manual.p.00-0034857",
      "manual.p.def-min",
      "manual.p.00-0035719",
    ]);
    expect(e.warnings).toContain("2 selected players could not be resolved and are omitted");
    expect(e.meta.untrusted_fields.map((f) => f.source)).toEqual(
      expect.arrayContaining(["manual.player.name", "nflverse.roster_weekly.name"]),
    );
  });
  it("gsis_ids: a league player gets the key the league holds (even a name key); unknown ids drop", async () => {
    const e = await ok("ff_get_injuries", {
      players: { gsis_ids: ["00-0034857", "00-0035719", "00-0000002"] },
    });
    const keys = (e.data.players as { player_key: string; gsis_id: string }[]).map((r) => [
      r.player_key,
      r.gsis_id,
    ]);
    expect(keys[0]).toEqual(["manual.p.00-0034857", "00-0034857"]);
    // Deebo Samuel is listed by name in league.yaml: the crosswalk joins him to his gsis id
    expect(keys[1]?.[0]).toMatch(/^manual\.p\.n-[0-9a-f]{16}$/);
    expect(keys[1]?.[1]).toBe("00-0035719");
    expect(e.warnings.some((w) => w.startsWith("1 selected players"))).toBe(true);
  });
  it("nfl_team: fantasy positions ordered by position then name, the defence last", async () => {
    const e = await ok("ff_get_injuries", { players: { nfl_team: "DET" } });
    const rows = e.data.players as { position: string; name: string }[];
    expect(rows.at(-1)?.position).toBe("DEF");
    const body_ = rows.slice(0, -1);
    const sorted = [...body_].sort((a, b) =>
      a.position === b.position ? (a.name < b.name ? -1 : 1) : a.position < b.position ? -1 : 1,
    );
    expect(body_).toEqual(sorted);
  });
  it("a selection that resolves to nobody is NOT_FOUND", async () => {
    expect(
      await code("ff_get_injuries", { players: { player_keys: ["manual.p.00-0000009"] } }),
    ).toBe("NOT_FOUND");
    expect(await code("ff_get_injuries", { players: { gsis_ids: ["00-0000009"] } })).toBe(
      "NOT_FOUND",
    );
    expect(
      await code("ff_project_players", {
        players: { pool: { status: "FA", position: "QB", top: 5 } },
        horizon: "week",
      }),
    ).toBe("NOT_FOUND");
  });
  it("a team with no players listed is NOT_FOUND for analytics", async () => {
    expect(
      await code("ff_project_players", {
        players: { team_key: `${LEAGUE_KEY}.t.5` },
        horizon: "week",
      }),
    ).toBe("NOT_FOUND");
  });
});

describe("A1 / A2 argument paths", () => {
  it("A1 filters by season", async () => {
    expect((await ok("ff_list_leagues", { season: 2025 })).data.leagues).toEqual([]);
  });
  it("A2 include subsets return only the requested sections", async () => {
    expect(Object.keys((await ok("ff_get_league", { include: ["league"] })).data)).toEqual([
      "league",
    ]);
    const m = await ok("ff_get_league", { include: ["stat_map"] });
    expect(Object.keys(m.data)).toEqual(["stat_map"]);
    expect((m.data.stat_map as unknown[]).length).toBeGreaterThan(10);
    const r = await ok("ff_get_league", { include: ["rules", "weeks", "roster"] });
    expect(Object.keys(r.data).sort()).toEqual(["roster", "rules", "weeks"]);
    expect((r.data.rules as { trade_review_mode: string }).trade_review_mode).toBe("commissioner");
    expect(await code("ff_get_league", { include: ["league", "league"] })).toBe("VALIDATION");
  });
  it("C2 refinements: sort_week needs sort_type week; a stat-id sort is accepted", async () => {
    expect(await code("ff_list_players", { sort_week: 3 })).toBe("VALIDATION");
    const e = await ok("ff_list_players", { sort: "4", sort_type: "week", sort_week: 3, limit: 2 });
    expect((e.data.players as unknown[]).length).toBe(2);
  });
});

describe("G1 rows", () => {
  it("a failed refresh surfaces as last_error with the consecutive-failure count", async () => {
    const at = world.clock.nowIso();
    const base = {
      file: null,
      file_version: null,
      release_updated_at: null,
      seasons: [2026],
      rows: null,
      columns_hash: null,
      started_at: at,
      finished_at: at,
      ok: false,
      checked_at: at,
    };
    await world.store.repos.refreshLog.record({
      ...base,
      source: "nflverse:injuries",
      error: "network",
    });
    await world.store.repos.refreshLog.record({
      ...base,
      source: "nflverse:roster_weekly",
      error: "schema",
    });
    const e = await ok("ff_get_status", { include_checks: true });
    const s = e.data.sources as {
      id: string;
      last_error: string | null;
      consecutive_failures: number;
    }[];
    expect(s.find((x) => x.id === "nflverse:injuries")).toMatchObject({
      last_error: "network",
      consecutive_failures: 1,
    });
    expect(s.find((x) => x.id === "nflverse:roster_weekly")?.last_error).toBe("schema");
    const checks = e.data.checks as { id: string; detail: string }[];
    expect(checks.find((x) => x.id === "writes")?.detail).toBe("off");
  });
  it("FF_WRITE_ENABLED=1 is reported (warning + check), never honoured", async () => {
    const w = await makeWorld({ publish: false, env: { FF_WRITE_ENABLED: "1" } });
    const cc = await connect(w);
    const e = body(
      await cc.client.callTool({ name: "ff_get_status", arguments: { include_checks: true } }),
    ) as unknown as Env;
    expect(e.warnings.some((x) => x.startsWith("FF_WRITE_ENABLED=1 is ignored"))).toBe(true);
    const checks = e.data.checks as { id: string; ok: boolean; detail: string }[];
    expect(checks.find((x) => x.id === "writes")?.detail).toBe("requested_ignored");
    expect(checks.find((x) => x.id === "datasets_loaded")?.ok).toBe(false);
    await cc.close();
    w.cleanup();
  });
});

describe("a record without a note, read back", () => {
  it("ff://rec/{log_id} shows note null and the record's fixed fields", async () => {
    const lineup = await ok("ff_analyze_lineup", { week: 3 });
    const r = await ok("ff_record_recommendation", {
      kind: "lineup",
      week: 3,
      rec: lineup.data.rec,
    });
    const res = await c.client.readResource({ uri: `ff://rec/${String(r.data.log_id)}` });
    const env = JSON.parse((res.contents[0] as { text: string }).text) as {
      data: { note: unknown; client_ref: unknown; kind: string };
    };
    expect(env.data).toMatchObject({ note: null, client_ref: null, kind: "lineup" });
  });
});
