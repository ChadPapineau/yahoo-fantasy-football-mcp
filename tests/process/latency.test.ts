// latency.test.ts — plan 10 A15 (plan 05 §4.2, T10): on the BUILT server over real stdio, with the
// fixture league (fixtures/manual/league.yaml) and the ≤ 300 KB nflverse excerpts (fixtures/nflverse)
// published into a fresh store by `ff refresh` in fixture mode:
//   - startup (spawn → initialize answered) < 1 s without network, on that fresh store;
//   - every P0 tool answers in < 500 ms on a warm cache (median of 3 timed calls after a warm-up) —
//     read literally: ff_project_players included, for a whole roster at the default 4000 sims;
//   - ff_project_players for 32 players with n_sims = 4000 in < 3 s.
// Both data sizes are measured and printed (the league file's players/bytes; each dataset file's
// bytes and the excerpt bytes). Wall-clock: run alone (`npm run test:process` runs one file at a time).
// Answer-time refresh (season-fresh §6, §13): the server runs with FF_ON_DEMAND_REFRESH=wait, so A15
// is "warm and fresh" — every source was just checked, no child starts, nothing waits; one fast
// source checked 2 h ago is revalidated within 6.5 s; and ff_record_recommendation never answers
// STORE_BUSY while five on-demand refreshes publish beside it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toolNames } from "../../src/mcp/registry.js";
import {
  ROOT,
  logRecords,
  makeHome,
  publishFixtures,
  requireDist,
  runCli,
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
  // Team A's whole roster at the plan-default 4000 sims (named, so a lowered default cannot pass it)
  ff_project_players: {
    players: { team_key: TEAM_A },
    horizon: "week",
    week: 4,
    n_sims: 4000,
    seed: 1,
  },
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
    // weather off: the fixture tree has no forecast for the real clock's week, and a never-loaded
    // weather source would be fetched at answer time (on a healthy install the tick keeps it in the
    // current hour bucket); every other source was just published, so nothing is due
    srv = await serve({ ...home.env, FF_ON_DEMAND_REFRESH: "wait", FF_WEATHER_SOURCE: "off" });
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
        // every P0 tool, E1's whole-roster call at the default 4000 sims included (A15 literal)
        expect(median(runs)).toBeLessThan(LIMIT_MS);
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

describe("A15 is warm and fresh: no answer waited on a refresh", () => {
  it("no on-demand child started during the timed calls (every source was just checked)", () => {
    expect(logRecords(srv.stderr).some((l) => l.event === "refresh.child_started")).toBe(false);
  });
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

describe("answer-time refresh latency (season-fresh §6.1)", () => {
  it("one fast source checked 2 h ago is revalidated within 6.5 s", async () => {
    const db = new DatabaseSync(path.join(home.env.FF_CACHE_DIR ?? "", "store.sqlite"));
    try {
      const back = new Date(Date.now() - 2 * 3_600_000).toISOString();
      db.prepare(
        "UPDATE refresh_log SET started_at = ?, finished_at = ?, checked_at = ? WHERE source = 'nflverse:injuries'",
      ).run(back, back, back);
      // the run's season checks are attempts too (the 14-minute floor counts them)
      db.prepare("UPDATE season_check SET checked_at = ? WHERE source = 'nflverse:injuries'").run(
        back,
      );
    } finally {
      db.close();
    }
    const t = await timed("ff_get_injuries", {});
    expect(t.r.isError, t.text.slice(0, 300)).not.toBe(true);
    const env = JSON.parse(t.text) as {
      meta: { refresh?: { sources: { source: string; outcome: string }[] } };
    };
    process.stdout.write(`on-demand ff_get_injuries (2 h stale): ${t.ms.toFixed(0)} ms\n`);
    expect(env.meta.refresh?.sources.find((x) => x.source === "nflverse:injuries")?.outcome).toBe(
      "revalidated",
    );
    expect(t.ms).toBeLessThan(6_500);
  }, 30_000);

  it("ff_record_recommendation ×50 during 5 concurrent on-demand publishes never answers STORE_BUSY", async () => {
    // five forced republishes (what an on-demand child does when a release changed), so the
    // store's write lock is really contended while the records are written
    const child = (target: string) => runCli(home.env, ["refresh", "--json", "--force", target]);
    const publishes = Promise.all(
      [
        "nflverse:schedules",
        "nflverse:injuries",
        "nflverse:roster_weekly",
        "nflverse:stats_player_week",
        "nflverse:schedules",
      ].map(child),
    );
    const codes: string[] = [];
    for (let i = 0; i < 50; i++) {
      const t = await timed("ff_record_recommendation", {
        ...recordArgs,
        client_ref: `busy-${String(i)}`,
      });
      if (t.r.isError === true)
        codes.push((JSON.parse(t.text) as { error: { code: string } }).error.code);
    }
    const runs = await publishes;
    expect(codes.filter((c) => c === "STORE_BUSY")).toEqual([]);
    expect(codes).toEqual([]);
    // the five runs all finished (published, or skipped: two of one source meet at the run lock)
    for (const r of runs) expect(r.code, r.stderr.slice(0, 300)).toBe(0);
  }, 120_000);
});
