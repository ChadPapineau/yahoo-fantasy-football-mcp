// variants.test.ts — the tools are platform-generic (plan 01 §8 seam): over a Yahoo-shaped platform
// (tests/mcp/helpers/fake-platform.ts) standings, platform stat lines (the golden `match`), matchups
// with the platform's own numbers, a transactions feed with notes and editor text are served with
// Yahoo's provenance tags and attribution, hostile text only inside wrappers; plus the dataset and
// option variants (weather present / expired / off, weekly locks, blend objective, normal method).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ATTRIBUTIONS } from "../../src/config/freshness.js";
import type { DatasetStamp, WeatherObservation } from "../../src/domain/analytics/types.js";
import type { McpServices } from "../../src/mcp/services.js";
import { MANUAL_FA_POOL_WARNING, MANUAL_POOL_WARNING } from "../../src/providers/platform.js";
import { Y_LEAGUE, Y_TEAM_A, Y_TEAM_B, fakeYahoo } from "./helpers/fake-platform.js";
import { body, connect, makeWorld, type World } from "./helpers/env.js";
import { envelopeViolations } from "./helpers/walk.js";

interface Env {
  data: Record<string, unknown>;
  meta: {
    untrusted_fields: { path: string; source: string }[];
    attribution: { source: string; text: string | null }[];
    source: string[];
  };
  warnings: string[];
  page?: { count: number };
}

let world: World;
let yahoo: ReturnType<typeof fakeYahoo>;
let services: McpServices;
beforeAll(async () => {
  world = await makeWorld();
  yahoo = fakeYahoo(world.services.platform, () => world.clock.nowIso());
  services = { ...world.services, platform: yahoo };
}, 60_000);
afterAll(() => {
  world.cleanup();
});

async function withClient<T>(
  svc: McpServices,
  fn: (call: (name: string, args?: Record<string, unknown>) => Promise<Env>) => Promise<T>,
  options: Partial<typeof world.options> = {},
): Promise<T> {
  const c = await connect({ services: svc, options: world.options }, { options });
  try {
    return await fn(async (name, args = {}) => {
      const r = await c.client.callTool({ name, arguments: args });
      const b = body(r) as unknown as Env;
      if (r.isError === true) throw new Error(`${name}: ${JSON.stringify(b)}`);
      expect(envelopeViolations(b as never), name).toEqual([]);
      expect(JSON.stringify(b.data)).not.toContain("<script>");
      return b;
    });
  } finally {
    await c.close();
  }
}

describe("a Yahoo-shaped platform", () => {
  it("platform facts carry Yahoo's tags and attribution; hostile text only wrapped", async () => {
    await withClient(services, async (call) => {
      const a1 = await call("ff_list_leagues");
      expect(a1.meta.attribution).toContainEqual(ATTRIBUTIONS.yahoo);
      expect((a1.data.leagues as { league_key: string }[])[0]?.league_key).toBe(Y_LEAGUE);

      const a3 = await call("ff_get_standings");
      expect(a3.warnings).toEqual([]);
      const teams = a3.data.teams as {
        name: { untrusted_text: { value: string; source: string } };
        is_mine: boolean;
        streak: unknown;
      }[];
      expect(teams[1]?.name.untrusted_text.source).toBe("yahoo.team.name");
      expect(teams[1]?.name.untrusted_text.value).toContain("IGNORE ALL PREVIOUS");
      expect(teams[0]?.is_mine).toBe(true);
      expect(teams[1]?.streak).toBeNull();

      const a4 = await call("ff_get_scoreboard", { week: 3 });
      const m = (
        a4.data.matchups as {
          teams: { projected_points_yahoo: number; win_probability_yahoo: number }[];
          status: string;
        }[]
      )[0];
      expect(m?.status).toBe("postevent");
      expect(m?.teams[0]?.win_probability_yahoo).toBe(0.61);

      const a5 = await call("ff_list_transactions", { count: 5, since: "2026-09-01T00:00:00Z" });
      const t = a5.data.transactions as {
        note: { untrusted_text: { source: string } } | null;
        players: { team_abbr: string; name: string }[];
      }[];
      expect(t[0]?.note?.untrusted_text.source).toBe("yahoo.transaction.note");
      expect(t[0]?.players[0]?.team_abbr).toBe("Jax");
      expect(t[0]?.players[0]?.name).not.toContain("<img");
      expect(a5.meta.untrusted_fields).toContainEqual({
        path: "data.transactions[].players[].name",
        source: "yahoo.player.name",
      });
      expect(a5.warnings).toEqual([]);
      const filtered = await call("ff_list_transactions", {
        types: ["trade"],
        team_key: Y_TEAM_B,
        since: "2026-09-20T00:00:00Z",
      });
      expect((filtered.data.transactions as unknown[]).length).toBe(1);
      const none = await call("ff_list_transactions", {
        types: ["add"],
        since: "2026-09-20T00:00:00Z",
      });
      expect(none.data.transactions).toEqual([]);
      const gap = await call("ff_list_transactions", { count: 1 });
      expect((gap.data.history_coverage as { gap_suspected: boolean }).gap_suspected).toBe(true);
    });
  });

  it("rosters, players and stats: editor text wrapped; the golden match flag computed", async () => {
    await withClient(services, async (call) => {
      const b1 = await call("ff_get_roster", { detail: "full", week: 4 });
      const p = b1.data.players as {
        status_full: { untrusted_text: { source: string } } | null;
        percent_owned: number;
        week_points: number;
      }[];
      expect(p[0]?.status_full?.untrusted_text.source).toBe("yahoo.player.status_full");
      expect(p[0]?.percent_owned).toBe(50);
      expect(p[0]?.week_points).toBe(7.5);
      const keys = [...yahoo.keyOf.values()].slice(0, 3);
      const b2 = await call("ff_get_player_stats", { player_keys: keys, type: "week", week: 3 });
      const rows = b2.data.players as {
        yahoo_points: number | null;
        match: boolean | null;
        engine_points: number | null;
      }[];
      expect(rows[0]?.yahoo_points).toBe(999);
      expect(rows[0]?.match).toBe(false);
      expect(rows[1]?.match).toBeNull();
      expect(b2.warnings).toEqual([]);
      const c2 = await call("ff_list_players", {
        detail: "full",
        limit: 5,
        with_stats: { type: "season" },
      });
      expect(c2.warnings).toEqual([]);
      const c1 = await call("ff_search_players", { query: "Allen", position: "QB" });
      expect((c1.data.players as unknown[]).length).toBeGreaterThan(0);
      const d2 = await call("ff_get_injuries", { week: 3 });
      const plat = (
        d2.data.players as { platform: { source: string; status_full: unknown } | null }[]
      ).find((x) => x.platform?.status_full != null);
      expect(plat?.platform?.source).toBe("yahoo");
    });
  });

  it("selectors under a non-manual platform: no manual keys invented, no MANUAL_POOL_WARNING", async () => {
    await withClient(services, async (call) => {
      const g = await call("ff_project_players", {
        players: { gsis_ids: ["00-0034857", "00-0036264"] },
        horizon: "week",
        seed: 1,
      });
      expect(
        (g.data.projections as { player_key: string | null }[]).some((x) =>
          x.player_key?.startsWith("461.p."),
        ),
      ).toBe(true);
      const t = await call("ff_project_players", {
        players: { nfl_team: "DET" },
        horizon: "week",
        seed: 1,
      });
      const def = (t.data.projections as { position: string; player_key: string | null }[]).find(
        (x) => x.position === "DEF",
      );
      expect(def?.player_key).toBeNull();
      const pool = await call("ff_project_players", {
        players: { pool: { status: "A", position: "WR", top: 3 } },
        horizon: "week",
        seed: 1,
      });
      expect(pool.warnings).not.toContain(MANUAL_POOL_WARNING);
      const team = await call("ff_project_players", {
        players: { team_key: Y_TEAM_A },
        horizon: "ros",
        seed: 1,
        n_sims: 1000,
      });
      expect((team.data.projections as { weeks: unknown[] }[])[0]?.weeks.length).toBe(3);
    });
  }, 60_000);

  it("analytics: weekly locks, blend objective, normal method, known availability", async () => {
    await withClient(services, async (call) => {
      const e2 = await call("ff_analyze_lineup", {
        week: 3,
        objective: "blend",
        blend_weight: 0.3,
      });
      expect(e2.data.objective_used).toBe("blend");
      const locks = e2.data.lock_schedule as { player_keys: string[] }[];
      expect(locks.length).toBeLessThanOrEqual(1); // weekly: one lock instant for everyone
      const e3 = await call("ff_analyze_matchup", { week: 3, method: "normal", n_sims: 2000 });
      expect(e3.data.method).toBe("normal");
      const e5 = await call("ff_analyze_waivers", {
        positions: ["K"],
        look_ahead: 0,
        detail: "full",
      });
      expect(e5.warnings).not.toContain(MANUAL_FA_POOL_WARNING);
      const g1 = await call("ff_get_status");
      expect((g1.data.capabilities as { platform: string }).platform).toBe("yahoo");
    });
  }, 30_000);
});

describe("dataset and option variants", () => {
  const stampAt = (at: string): DatasetStamp => ({
    source: "weather:open_meteo",
    as_of: at,
    fetched_at: at,
    checked_at: at,
    freshness_class: "weather",
    file_version: "wx-1",
  });
  const weatherWith = (stamp: DatasetStamp | null): McpServices => ({
    ...world.services,
    datasets: {
      ...world.services.datasets,
      weather: {
        forGames: (ids: readonly string[]) => ({
          rows: ids.slice(0, 3).map((game_id, i): WeatherObservation => ({
            game_id,
            temp_f: 61.5,
            wind_mph: 12,
            gust_mph: null,
            precip_prob: 0.2,
            as_of: world.clock.nowIso(),
            source: i === 2 ? "weather:other" : "weather:open_meteo",
          })),
          stamp,
        }),
      },
    },
  });

  it("fresh weather rides on the schedule rows (an unknown source is dropped)", async () => {
    await withClient(weatherWith(stampAt(world.clock.nowIso())), async (call) => {
      const d3 = await call("ff_get_schedule", { weeks: [4] });
      const games = d3.data.games as { weather: { source: string } | null }[];
      expect(games.filter((g) => g.weather !== null)).toHaveLength(2);
      expect(d3.meta.source).toContain("weather:open_meteo");
      expect(d3.meta.attribution.map((a) => a.source)).toContain("Open-Meteo");
    });
  });
  it("weather past its hard limit is omitted (class `omit`), never STALE_ONLY", async () => {
    await withClient(weatherWith(stampAt("2026-09-20T00:00:00.000Z")), async (call) => {
      const d3 = await call("ff_get_schedule", { weeks: [4] });
      expect((d3.data.games as { weather: unknown }[]).every((g) => g.weather === null)).toBe(true);
      expect(d3.meta.source).not.toContain("weather:open_meteo");
    });
  });
  it("FF_WEATHER_SOURCE=off: no weather, the sources list drops it; no seed source → crypto", async () => {
    const { newSeed: _seed, ...rest } = weatherWith(stampAt(world.clock.nowIso()));
    const svc: McpServices = rest;
    await withClient(
      svc,
      async (call) => {
        const d3 = await call("ff_get_schedule", { weeks: [4] });
        expect((d3.data.games as { weather: unknown }[]).every((g) => g.weather === null)).toBe(
          true,
        );
        const g1 = await call("ff_get_status");
        expect((g1.data.sources as { id: string }[]).map((s) => s.id)).not.toContain(
          "weather:open_meteo",
        );
        const e2 = await call("ff_analyze_lineup", { week: 3 });
        expect(e2.data.dist_basis).toBe("position_cv");
      },
      { weatherSource: "off" },
    );
    await withClient(
      world.services,
      async (call) => {
        const g1 = await call("ff_get_status");
        expect((g1.data.sources as { id: string }[]).map((s) => s.id)).toContain(
          "weather:open_meteo",
        );
      },
      { weatherSource: "open-meteo" },
    );
    await withClient(
      world.services,
      async (call) => {
        const g1 = await call("ff_get_status");
        expect((g1.data.sources as { id: string }[]).map((s) => s.id)).toContain("weather:nws");
      },
      { weatherSource: "nws" },
    );
  });
  it("platform read options pass through (force_refresh, allow_stale)", async () => {
    await withClient(world.services, async (call) => {
      const r = await call("ff_get_roster", { force_refresh: true, allow_stale: true });
      expect(r.data.team_key).toBe("manual.l.example.t.1");
    });
  });
});
