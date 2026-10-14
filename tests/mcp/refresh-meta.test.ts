// refresh-meta.test.ts — what a result says about its answer-time refresh (season-fresh spec §6.2,
// §6.4) over the fixture world: `meta.refresh` absent when nothing was attempted; with a report it is
// schema-valid (≤ 8 rows, fixed vocabulary) and its warnings are the fixed lines; analytics results
// still fit their 10 000-char budget and tools/list stays ≤ 20 000 chars; the second beforeCall
// attaches what the refresh published before the tool reads; and the datasets drift guard — a
// recording DatasetReaders proves each tool's declared `datasets` covers every source it reads.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ON_DEMAND_TIER, type DueSource } from "../../src/config/cadence.js";
import type { DatasetSourceId } from "../../src/config/freshness.js";
import type { DatasetReaders, InjuryReport } from "../../src/domain/analytics/types.js";
import type { RosterWeeklyReader } from "../../src/domain/crosswalk/types.js";
import { outputSchemaOf } from "../../src/mcp/define.js";
import { ANALYTICS_BUDGET_CHARS, envelopeSchema } from "../../src/mcp/envelope.js";
import { REGISTRY, toolsFor } from "../../src/mcp/registry.js";
import type { McpServices, RefreshReport, RefreshSourceReport } from "../../src/mcp/services.js";
import { z } from "zod/v4";
import { ONE_CALL, everyCall } from "./helpers/calls.js";
import { body, connect, makeWorld, type World } from "./helpers/env.js";

let world: World;
beforeAll(async () => {
  world = await makeWorld();
}, 60_000);
afterAll(() => {
  world.cleanup();
});

const DEF = new Map(REGISTRY.map((e) => [e.tool.name, e.tool]));
const schemaOf = (name: string): z.ZodType => {
  const def = DEF.get(name);
  if (def === undefined) throw new Error(name);
  return outputSchemaOf(def) ?? envelopeSchema(z.record(z.string(), z.unknown()));
};

const idOf = (d: DueSource): DatasetSourceId => (d === "weather" ? "weather:open_meteo" : d);

/** A report for every source asked, each with `outcome` (fixed fields). */
function reportFor(
  sources: readonly DueSource[],
  over: Partial<RefreshSourceReport> = {},
): RefreshReport {
  return {
    mode: "wait",
    sources: sources.map((d) => ({
      source: idOf(d),
      outcome: "in_progress",
      code: null,
      started_at: world.clock.nowIso(),
      at: world.clock.nowIso(),
      next_retry_at: null,
      ...over,
    })),
  };
}

async function withServices<T>(
  services: McpServices,
  fn: (client: Awaited<ReturnType<typeof connect>>["client"]) => Promise<T>,
): Promise<T> {
  const c = await connect({ services, options: world.options });
  try {
    return await fn(c.client);
  } finally {
    await c.close();
  }
}

interface Env {
  meta: { refresh?: RefreshReport };
  warnings: string[];
}

describe("meta.refresh is absent when nothing was attempted", () => {
  it("off (the fixture-mode default) and an ensureFresh that answers null leave every envelope without it", async () => {
    expect("ensureFresh" in world.services).toBe(false);
    const nulls: McpServices = { ...world.services, ensureFresh: () => Promise.resolve(null) };
    for (const svc of [world.services, nulls])
      await withServices(svc, async (client) => {
        for (const [name, args] of await everyCall(client)) {
          const r = await client.callTool({ name, arguments: args });
          const b = body(r) as unknown as Env;
          expect(r.isError, `${name} ${JSON.stringify(b)}`).not.toBe(true);
          expect(b.meta.refresh, name).toBeUndefined();
          expect(
            b.warnings.filter((w) => w.includes("refresh")),
            name,
          ).toEqual([]);
        }
      });
  }, 120_000);
});

describe("with a report", () => {
  const FIXED = [
    /^refreshing [a-z_]+:[a-z_]+ in the background \(started \d+[smhd] ago\); (this answer uses the release checked \d+[smhd] ago|no release of it is loaded yet) — ask again in a minute for newer data$/,
    /^could not refresh [a-z_]+:[a-z_]+ \([a-z_]+\); (this answer uses the release checked \d+[smhd] ago|no release of it is loaded yet)$/,
  ];

  it("every tool: schema-valid, ≤ 8 rows, only for tools that read datasets; warnings are the fixed lines", async () => {
    const asked: string[] = [];
    const svc: McpServices = {
      ...world.services,
      ensureFresh: (sources) => {
        asked.push(...sources);
        return Promise.resolve(reportFor(sources));
      },
    };
    await withServices(svc, async (client) => {
      for (const [name, args] of await everyCall(client)) {
        const before = asked.length;
        const r = await client.callTool({ name, arguments: args });
        const b = body(r);
        expect(r.isError, `${name} ${JSON.stringify(b)}`).not.toBe(true);
        const parsed = schemaOf(name).safeParse(b);
        expect(parsed.success, `${name} ${JSON.stringify(parsed.error?.issues.slice(0, 3))}`).toBe(
          true,
        );
        const env = b as unknown as Env;
        const declared = DEF.get(name)?.datasets ?? [];
        if (declared.length === 0) {
          expect(env.meta.refresh, name).toBeUndefined();
          expect(asked.length, name).toBe(before);
          continue;
        }
        expect(env.meta.refresh?.sources.length, name).toBe(declared.length);
        expect(env.meta.refresh?.sources.length).toBeLessThanOrEqual(8);
        const lines = env.warnings.filter((w) => w.startsWith("refreshing "));
        // fast sources warn; a slow source revalidated behind a loaded release is silent
        const loaded = new Set(world.services.refreshLog.current().map((c) => c.source));
        const warned = declared.filter((d) => ON_DEMAND_TIER[d] === "fast" || !loaded.has(idOf(d)));
        expect(lines.length, name).toBe(warned.length);
        for (const l of lines)
          expect(
            FIXED.some((re) => re.test(l)),
            l,
          ).toBe(true);
      }
    });
  }, 120_000);

  it("analytics results carrying a full report still fit 10 000 chars", async () => {
    const svc: McpServices = {
      ...world.services,
      ensureFresh: (sources) =>
        Promise.resolve(
          reportFor(sources, {
            outcome: "failed",
            code: "network",
          }),
        ),
    };
    await withServices(svc, async (client) => {
      for (const name of [
        "ff_project_players",
        "ff_analyze_lineup",
        "ff_analyze_matchup",
        "ff_analyze_waivers",
        "ff_analyze_retrospective",
      ]) {
        const r = await client.callTool({ name, arguments: ONE_CALL[name] ?? {} });
        const text = (r.content as { text: string }[])[0]?.text ?? "";
        expect(r.isError, name).not.toBe(true);
        expect(text.length, name).toBeLessThanOrEqual(ANALYTICS_BUDGET_CHARS);
        const env = JSON.parse(text) as Env;
        expect(env.meta.refresh?.sources.every((s) => s.outcome === "failed")).toBe(true);
        expect(env.warnings.some((w) => w.startsWith("could not refresh "))).toBe(true);
      }
    });
  }, 120_000);

  it("tools/list for the core toolset stays ≤ 20 000 chars (the datasets list is not advertised)", async () => {
    const c = await connect(world, { options: { toolset: "core", fixtureMode: false } });
    try {
      const list = await c.client.listTools();
      expect(list.tools.map((t) => t.name)).toEqual(toolsFor("core").map((t) => t.name));
      expect(JSON.stringify(list.tools)).not.toContain('"datasets"');
      expect(JSON.stringify(list.tools).length).toBeLessThanOrEqual(20_000);
    } finally {
      await c.close();
    }
  });
});

describe("the second beforeCall attaches what the refresh published (§6.2)", () => {
  it("the answer reads the release published during the wait, not the one attached before it", async () => {
    let published = false;
    let attached = false;
    const real = world.services.datasets.injuries;
    // the republished release was last checked 20 h ago: only it makes the stale warning appear
    const CHECKED = new Date(world.clock.nowMs() - 20 * 3_600_000).toISOString();
    const injuries: DatasetReaders["injuries"] = {
      reports: (season, week, ids) => {
        const r = real.reports(season, week, ids);
        if (!attached || r.stamp === null) return r;
        return {
          rows: r.rows.map((x): InjuryReport => ({ ...x })),
          stamp: {
            ...r.stamp,
            as_of: CHECKED,
            fetched_at: CHECKED,
            checked_at: CHECKED,
            file_version: "republished",
          },
        };
      },
    };
    const svc: McpServices = {
      ...world.services,
      datasets: { ...world.services.datasets, injuries },
      beforeCall: () => {
        world.services.beforeCall?.();
        attached = published;
      },
      ensureFresh: (sources) => {
        published = true; // the child published a new injuries release during the wait
        return Promise.resolve(reportFor(sources, { outcome: "updated" }));
      },
    };
    await withServices(svc, async (client) => {
      const r = await client.callTool({ name: "ff_get_injuries", arguments: {} });
      const env = body(r) as unknown as { meta: { refresh?: RefreshReport }; warnings: string[] };
      expect(r.isError).not.toBe(true);
      expect(env.meta.refresh?.sources.some((s) => s.outcome === "updated")).toBe(true);
      expect(env.warnings).toContain("source nflverse:injuries is 20h old (stale)");
    });
  });
});

describe("datasets drift guard: each tool's declared list covers what it reads", () => {
  it("a recording DatasetReaders sees only declared sources, for every tool", async () => {
    let seen = new Set<DueSource>();
    const rec =
      <A extends unknown[], R>(src: DueSource, f: (...a: A) => R) =>
      (...a: A): R => {
        seen.add(src);
        return f(...a);
      };
    const d = world.services.datasets;
    const datasets: DatasetReaders = {
      schedules: {
        games: rec("nflverse:schedules", d.schedules.games.bind(d.schedules)),
        firstKickoff: rec("nflverse:schedules", d.schedules.firstKickoff.bind(d.schedules)),
      },
      injuries: { reports: rec("nflverse:injuries", d.injuries.reports.bind(d.injuries)) },
      playerWeeks: {
        lines: rec("nflverse:stats_player_week", d.playerWeeks.lines.bind(d.playerWeeks)),
        defenseLines: rec(
          "nflverse:stats_player_week",
          d.playerWeeks.defenseLines.bind(d.playerWeeks),
        ),
      },
      weather: { forGames: rec("weather", d.weather.forGames.bind(d.weather)) },
    };
    const rw = world.services.rosterWeekly;
    const rosterWeekly: RosterWeeklyReader = {
      ...rw,
      latest: rec("nflverse:roster_weekly", rw.latest.bind(rw)),
    };
    const svc: McpServices = { ...world.services, datasets, rosterWeekly };
    const read = new Map<string, Set<DueSource>>();
    await withServices(svc, async (client) => {
      for (const [name, args] of await everyCall(client)) {
        seen = new Set();
        const r = await client.callTool({ name, arguments: args });
        expect(r.isError, `${name} ${JSON.stringify(body(r))}`).not.toBe(true);
        read.set(name, seen);
      }
    });
    for (const [name, sources] of read) {
      const declared = new Set(DEF.get(name)?.datasets ?? []);
      // the diagnostics and the local write read without refreshing, by design (plan 03 L5)
      if (declared.size === 0) continue;
      expect(
        [...sources].filter((s) => !declared.has(s)),
        name,
      ).toEqual([]);
    }
    expect([...(read.get("ff_list_recommendations") ?? [])]).toEqual([]);
    // the analytics tools read every source they declare on this world
    expect([...(read.get("ff_project_players") ?? [])].sort()).toEqual(
      [...(DEF.get("ff_project_players")?.datasets ?? [])].sort(),
    );
  }, 120_000);
});
