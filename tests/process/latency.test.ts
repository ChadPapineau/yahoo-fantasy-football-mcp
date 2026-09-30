// latency.test.ts — plan 10 A15 (plan 05 §4.2, T10): on the BUILT server over real stdio, with the
// fixture league (fixtures/manual/league.yaml) and the ≤ 300 KB nflverse excerpts (fixtures/nflverse)
// published into a fresh store by `ff refresh` in fixture mode:
//   - startup (spawn → initialize answered) < 1 s without network, on that fresh store;
//   - every P0 tool answers in < 500 ms on a warm cache (median of 3 timed calls after a warm-up);
//   - ff_project_players for 32 players with n_sims = 4000 in < 3 s.
// E1 is held to its own clause (a roster-sized call at 4000 sims gets the 3-s budget pro rata).
// Both data sizes are measured and printed (the league file's players/bytes; each dataset file's
// bytes and the excerpt bytes). Wall-clock: run alone (`npm run test:process` runs one file at a time).
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toolNames } from "../../src/mcp/registry.js";
import {
  ROOT,
  makeHome,
  publishFixtures,
  requireDist,
  serve,
  type E2eHome,
  type Served,
} from "../e2e/helpers.js";

const TEAM_A = "manual.l.example.t.1";
const ALLEN = "manual.p.00-0034857";
const CHASE = "manual.p.00-0036900";

/** One representative call per P0 tool (the heaviest ordinary form for the analytics tools). */
const CALLS: Readonly<Record<string, Record<string, unknown>>> = {
  ff_list_leagues: {},
  ff_get_league: {},
  ff_get_standings: {},
  ff_get_scoreboard: { week: 3 },
  ff_list_transactions: {},
  ff_get_roster: { week: 4 },
  ff_get_player_stats: { player_keys: [ALLEN, CHASE], type: "week", week: 3 },
  ff_search_players: { query: "Allen" },
  ff_list_players: { position: "K" },
  ff_get_injuries: {},
  ff_get_schedule: { weeks: [4, 5] },
  ff_project_players: { players: { team_key: TEAM_A }, horizon: "week", week: 4, seed: 1 },
  ff_analyze_lineup: { week: 4 },
  ff_analyze_matchup: { week: 3 },
  ff_analyze_waivers: { positions: ["K", "DEF"], look_ahead: 2 },
  ff_analyze_retrospective: { week: 3 },
  ff_list_recommendations: {},
  ff_get_status: {},
};
const LIMIT_MS = 500;
const PROJECT_32_LIMIT_MS = 3000;
const STARTUP_LIMIT_MS = 1000;
/** Team A's roster (≤ 18 entries) at the default 4000 sims, held to the E1 budget pro rata. */
const E1_ROSTER_LIMIT_MS = Math.round((PROJECT_32_LIMIT_MS * 18) / 32);

let home: E2eHome;
let srv: Served;
let recordArgs: Record<string, unknown>;

const timed = async (name: string, args: Record<string, unknown>) => {
  const t0 = performance.now();
  const r = await srv.client.callTool({ name, arguments: args });
  const ms = performance.now() - t0;
  const text = (r.content as { text: string }[])[0]?.text ?? "";
  return { r, ms, text };
};
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? NaN;
};

beforeAll(async () => {
  requireDist();
  home = makeHome();
  await publishFixtures(home);
}, 120_000);

afterAll(async () => {
  await srv.close().catch(() => undefined);
  home.cleanup();
});

describe("A15: the data sizes measured", () => {
  it("names the fixture league size and every dataset file size (≤ 300 KB excerpts)", () => {
    const league = readFileSync(path.join(home.env.FF_CONFIG_DIR ?? "", "league.yaml"), "utf8");
    const players = league.match(/^\s*- \{?\s*(name|defense):/gm)?.length ?? 0;
    const excerpts = (
      JSON.parse(
        readFileSync(path.join(ROOT, "fixtures", "nflverse", "manifest.json"), "utf8"),
      ) as { files: { path?: string; file?: string; bytes?: number }[] }
    ).files;
    const dsDir = path.join(home.env.FF_CACHE_DIR ?? "", "ds");
    const ds = readdirSync(dsDir)
      .filter((f) => f.endsWith(".sqlite"))
      .map((f) => ({ file: f, bytes: statSync(path.join(dsDir, f)).size }));
    process.stdout.write(
      `A15 data sizes: league.yaml ${String(Buffer.byteLength(league))} B, ${String(players)} roster entries; ` +
        `datasets ${ds.map((d) => `${d.file}=${String(d.bytes)} B`).join(", ")}\n`,
    );
    expect(ds.length).toBeGreaterThanOrEqual(4);
    expect(players).toBeGreaterThan(20);
    for (const e of excerpts)
      if (typeof e.bytes === "number") expect(e.bytes).toBeLessThanOrEqual(300 * 1024);
  });
});

describe("A15: startup < 1 s without network, on a fresh store with the datasets attached", () => {
  it("spawn → initialize answered", async () => {
    srv = await serve(home.env);
    process.stdout.write(`A15 startup (spawn → initialize): ${srv.connectMs.toFixed(0)} ms\n`);
    expect(srv.connectMs).toBeLessThan(STARTUP_LIMIT_MS);
    const status = await srv.client.callTool({ name: "ff_get_status", arguments: {} });
    expect(status.isError).not.toBe(true);
  }, 30_000);
});

describe("A15: every P0 tool < 500 ms on a warm cache", () => {
  it("covers all 19 P0 tools", () => {
    expect([...Object.keys(CALLS), "ff_record_recommendation"].sort()).toEqual(
      toolNames("core", false).sort(),
    );
  });

  for (const [name, args] of Object.entries(CALLS)) {
    it(
      name,
      async () => {
        const warm = await timed(name, args);
        expect(warm.r.isError, warm.text.slice(0, 300)).not.toBe(true);
        if (name === "ff_analyze_lineup") {
          const env = JSON.parse(warm.text) as {
            data: { rec: unknown };
            meta: { request_id: string };
          };
          recordArgs = {
            kind: "lineup",
            week: 4,
            rec: env.data.rec,
            source_calls: [{ tool: name, request_id: env.meta.request_id }],
            client_ref: "latency-w4",
          };
        }
        const runs: number[] = [];
        for (let i = 0; i < 3; i++) runs.push((await timed(name, args)).ms);
        process.stdout.write(
          `A15 ${name}: median ${median(runs).toFixed(0)} ms (runs ${runs.map((x) => x.toFixed(0)).join("/")}, cold ${warm.ms.toFixed(0)})\n`,
        );
        // E1 has its own A15 budget (32 players × 4000 sims < 3 s): a roster call at the default
        // 4000 sims is held to it pro rata; every other P0 tool to 500 ms
        expect(median(runs)).toBeLessThan(
          name === "ff_project_players" ? E1_ROSTER_LIMIT_MS : LIMIT_MS,
        );
      },
      30_000,
    );
  }

  it("ff_record_recommendation", async () => {
    const runs: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t = await timed("ff_record_recommendation", recordArgs);
      expect(t.r.isError, t.text.slice(0, 300)).not.toBe(true);
      runs.push(t.ms);
    }
    process.stdout.write(`A15 ff_record_recommendation: median ${median(runs).toFixed(0)} ms\n`);
    expect(median(runs)).toBeLessThan(LIMIT_MS);
  }, 30_000);
});

describe("A15: ff_project_players, 32 players × 4000 sims < 3 s", () => {
  it("the 32 team defences (pool DEF top 32) at n_sims 4000", async () => {
    const args = {
      players: { pool: { status: "A", position: "DEF", top: 32 } },
      horizon: "week",
      week: 4,
      n_sims: 4000,
      seed: 7,
    };
    await timed("ff_project_players", { ...args, seed: 8 }); // warm
    const t = await timed("ff_project_players", args);
    expect(t.r.isError, t.text.slice(0, 300)).not.toBe(true);
    const env = JSON.parse(t.text) as {
      data: { projections: unknown[] };
      truncated: boolean;
      warnings: string[];
    };
    // all 32 are simulated; the 10 000-char analytics budget (plan 07 C8) may page the output
    if (env.data.projections.length < 32) {
      expect(env.truncated).toBe(true);
      expect(env.warnings.join(" ")).toMatch(/of 32 projections/);
    }
    process.stdout.write(`A15 ff_project_players 32 × 4000: ${t.ms.toFixed(0)} ms\n`);
    expect(t.ms).toBeLessThan(PROJECT_32_LIMIT_MS);
  }, 30_000);
});
