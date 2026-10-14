// season-coverage.test.ts — season-aware dataset gating at the tool layer (season-fresh spec §3.3,
// §2.3): a season upstream has not published yet is a named note for an optional source and a
// `season_not_published` STALE_ONLY (naming the season, never "run ff refresh") for a required one;
// a finished season's data does not expire; a file without the season asked for names it; and the
// season a league-less D3 call shows is the schedule's phase — off-season, preseason, regular and
// postseason over synthetic 2026–2030 seasons (it replaces the old March rule's unit cases).
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fallbackCalendar } from "../../src/config/game-calendar.js";
import type { DatasetSourceId } from "../../src/config/freshness.js";
import type {
  DatasetReaders,
  DatasetStamp,
  SeasonCheckRow,
} from "../../src/domain/analytics/types.js";
import { scheduleView } from "../../src/domain/league/calendar.js";
import type { SeasonPhase } from "../../src/domain/league/season.js";
import type { ToolContext } from "../../src/mcp/define.js";
import { STALE_ONLY_VARIANTS, toToolError } from "../../src/mcp/errors.js";
import type { McpServices } from "../../src/mcp/services.js";
import { leagueSeasonNote, optionalSource, requiredSource } from "../../src/mcp/tools/common.js";
import { scheduleReaderOf } from "../helpers/season/reader.js";
import { syntheticSeasons } from "../helpers/season/synthetic.js";
import { body, connect, makeWorld, type World } from "./helpers/env.js";

const H = 3_600_000;
const D = 24 * H;
const iso = (ms: number): string => new Date(ms).toISOString();

/** A minimal call context: a phase, a season-check table, nothing else. */
function ctxAt(
  nowMs: number,
  phase: Pick<SeasonPhase, "season" | "phase">,
  checks: readonly SeasonCheckRow[] = [],
): ToolContext {
  return {
    nowMs,
    requestId: "r-0123456789ab",
    view: {
      calendar: fallbackCalendar("never_loaded"),
      phase: {
        week: null,
        next_kickoff: null,
        next_season_published: true,
        basis: "schedule",
        ...phase,
      },
    },
    refresh: null,
    notes: [],
    memo: new Map(),
    services: {
      seasonChecks: {
        latest: (source: DatasetSourceId, season: number) =>
          checks.find((c) => c.source === source && c.season === season) ?? null,
        all: () => checks,
      },
      refreshLog: { current: () => [] },
    },
  } as unknown as ToolContext;
}

const stamp = (source: DatasetSourceId, seasons: number[], checkedMs: number): DatasetStamp => ({
  source,
  as_of: iso(checkedMs - D),
  fetched_at: iso(checkedMs),
  checked_at: iso(checkedMs),
  freshness_class:
    source === "nflverse:schedules"
      ? "nflverse_schedules"
      : source === "nflverse:injuries"
        ? "nflverse_injuries"
        : "nflverse_stats_player_week",
  file_version: "v",
  seasons,
});

const errOf = (f: () => unknown): { message: string; hint: string; retryable: boolean } | null => {
  try {
    f();
    return null;
  } catch (e) {
    return (
      JSON.parse(toToolError(e, "r-0123456789ab").content[0].text) as {
        error: { message: string; hint: string; retryable: boolean };
      }
    ).error;
  }
};

describe("coverage at the tool layer, any season 2026–2040 and any phase", () => {
  const arb = fc.record({
    season: fc.integer({ min: 2026, max: 2040 }),
    phase: fc.constantFrom<SeasonPhase["phase"]>("preseason", "regular", "postseason"),
    now: fc.integer({ min: 0, max: 364 }).map((d) => Date.parse("2026-01-01T00:00:00Z") + d * D),
    checkedAgoH: fc.integer({ min: 0, max: 30 }),
  });

  it("not published upstream: required → season_not_published naming the season; optional → the note", () => {
    fc.assert(
      fc.property(arb, ({ season, phase, now, checkedAgoH }) => {
        const check: SeasonCheckRow = {
          source: "nflverse:schedules",
          season,
          checked_at: iso(now - checkedAgoH * H),
          status: "not_published",
        };
        const ctx = ctxAt(now, { season, phase }, [
          check,
          { ...check, source: "nflverse:injuries" },
        ]);
        const sched = { rows: [], stamp: stamp("nflverse:schedules", [season - 1], now - H) };
        const e = errOf(() => requiredSource(ctx, "nflverse:schedules", sched, false, season));
        expect(e?.message).toBe(STALE_ONLY_VARIANTS.season_not_published.message);
        expect(e?.hint).toContain(String(season));
        expect(e?.hint).not.toMatch(/ff refresh/);
        expect(e?.retryable).toBe(false);
        const inj = { rows: [], stamp: stamp("nflverse:injuries", [season - 1], now - H) };
        expect(optionalSource(ctx, "nflverse:injuries", inj, false, season)).toBeNull();
        expect(ctx.notes).toEqual([
          `no ${String(season)} nflverse:injuries published upstream yet (checked ${checkedAgoH === 0 ? "0s" : `${String(checkedAgoH)}h`} ago)`,
        ]);
        // the same read with "note" answers without it (D2's September case)
        expect(
          requiredSource(ctx, "nflverse:injuries", inj, false, season, { unpublished: "note" }),
        ).not.toBeNull();
      }),
      { numRuns: 200 },
    );
  });

  it("a check older than the hard limit is no evidence: the season is missing, and the hint names it", () => {
    // `--seasons` only for a season upstream is known to have (one before the season in progress);
    // for the season in progress or a later one, a plain refresh — it checks upstream and records a
    // season not published yet (the next answer then says so) — never `--seasons` (that run once
    // published a schedules file with no game)
    fc.assert(
      fc.property(arb, ({ season, phase, now }) => {
        const ctx = ctxAt(now, { season, phase }, [
          {
            source: "nflverse:schedules",
            season,
            checked_at: iso(now - 8 * D),
            status: "not_published",
          },
        ]);
        const sched = { rows: [], stamp: stamp("nflverse:schedules", [season - 1], now - H) };
        const e = errOf(() => requiredSource(ctx, "nflverse:schedules", sched, false, season));
        expect(e?.message).toBe("Only data older than its hard limit is available.");
        expect(e?.hint).toContain(String(season));
        expect(e?.hint).toContain("`ff refresh nflverse:schedules`");
        expect(e?.hint).not.toMatch(/--seasons/);
        for (const later of [season + 1, season + 2]) {
          const next = errOf(() => requiredSource(ctx, "nflverse:schedules", sched, false, later));
          expect(next?.hint).not.toMatch(/--seasons/);
        }
        const past = errOf(() =>
          requiredSource(
            ctx,
            "nflverse:schedules",
            { rows: [], stamp: stamp("nflverse:schedules", [season], now - H) },
            false,
            season - 2,
          ),
        );
        expect(past?.hint).toContain(`--seasons ${String(season - 2)}`);
      }),
      { numRuns: 100 },
    );
  });

  it("draft prep: next season's league file in the off-season, before its schedule's release (2026–2030)", () => {
    for (const S of [2026, 2027, 2028, 2029, 2030]) {
      const now = Date.parse(`${String(S + 1)}-03-15T16:00:00.000Z`);
      const sched = { rows: [], stamp: stamp("nflverse:schedules", [S - 1, S], now - H) };
      // before any refresh has asked upstream for S+1: a plain refresh, never `--seasons`
      const before = errOf(() =>
        requiredSource(
          ctxAt(now, { season: S, phase: "offseason" }),
          "nflverse:schedules",
          sched,
          false,
          S + 1,
        ),
      );
      expect(before?.hint, String(S)).toContain("`ff refresh nflverse:schedules`");
      expect(before?.hint).not.toMatch(/--seasons/);
      // once a refresh found S+1 unpublished: season_not_published, not retryable, no refresh asked
      const after = errOf(() =>
        requiredSource(
          ctxAt(now, { season: S, phase: "offseason" }, [
            {
              source: "nflverse:schedules",
              season: S + 1,
              checked_at: iso(now - H),
              status: "not_published",
            },
          ]),
          "nflverse:schedules",
          sched,
          false,
          S + 1,
        ),
      );
      expect(after?.message).toBe(STALE_ONLY_VARIANTS.season_not_published.message);
      expect(after?.retryable).toBe(false);
      expect(after?.hint).not.toMatch(/ff refresh/);
    }
  });

  it("a finished season's data never expires (complete); the season in progress does", () => {
    fc.assert(
      fc.property(arb, ({ season, phase, now }) => {
        const ctx = ctxAt(now, { season, phase });
        const old = {
          rows: [],
          stamp: stamp("nflverse:stats_player_week", [season - 1], now - 10 * D),
        };
        const i = requiredSource(ctx, "nflverse:stats_player_week", old, false, season - 1);
        expect(i?.state).toBe("stale");
        const cur = {
          rows: [],
          stamp: stamp("nflverse:stats_player_week", [season], now - 10 * D),
        };
        expect(
          errOf(() => requiredSource(ctx, "nflverse:stats_player_week", cur, false, season))
            ?.message,
        ).toBe("Only data older than its hard limit is available.");
      }),
      { numRuns: 100 },
    );
  });
});

describe("the league-season note of the analytics tools (rollover)", () => {
  it("silent while the league file is the season in progress (or next season's, off-season); otherwise names both", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2026, max: 2040 }),
        fc.integer({ min: -2, max: 2 }),
        fc.constantFrom<SeasonPhase["phase"]>("preseason", "regular", "postseason", "offseason"),
        (season, delta, phase) => {
          const league = season + delta;
          const note = leagueSeasonNote(ctxAt(0, { season, phase }), league);
          if (phase === "offseason") {
            if (league > season) expect(note).toBeNull();
            else
              expect(note).toBe(
                `league season ${String(league)} is finished; recommendations describe a completed season`,
              );
          } else if (league === season) expect(note).toBeNull();
          else
            expect(note).toBe(
              `league season ${String(league)} is not the NFL season in progress (${String(season)}, ${phase}): run the onboard Skill's new-season step`,
            );
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("the fixture world: September cases answer, an unpublished schedule refuses", () => {
  let world: World;
  beforeAll(async () => {
    world = await makeWorld();
  }, 60_000);
  afterAll(() => {
    world.cleanup();
  });

  /** Services whose `source` file holds only 2025 and whose 2026 check says not published. */
  function unpublished(source: "nflverse:injuries" | "nflverse:schedules"): McpServices {
    const d = world.services.datasets;
    const now = world.clock.nowMs();
    const only2025 = <T>(r: { rows: readonly T[]; stamp: DatasetStamp | null }) => ({
      rows: [] as T[],
      stamp: r.stamp === null ? null : { ...r.stamp, seasons: [2025] },
    });
    const datasets: DatasetReaders =
      source === "nflverse:injuries"
        ? {
            ...d,
            injuries: {
              reports: (s, w, ids) =>
                s === 2026
                  ? only2025(d.injuries.reports(s, w, ids))
                  : d.injuries.reports(s, w, ids),
            },
          }
        : {
            ...d,
            schedules: {
              games: (s, w) =>
                s === 2026 ? only2025(d.schedules.games(s, w)) : d.schedules.games(s, w),
              firstKickoff: () => null,
            },
          };
    const check: SeasonCheckRow = {
      source,
      season: 2026,
      checked_at: iso(now - 3 * H),
      status: "not_published",
    };
    return {
      ...world.services,
      datasets,
      seasonChecks: {
        latest: (src, season) =>
          src === source && season === 2026
            ? check
            : world.services.seasonChecks.latest(src, season),
        all: () => [check],
      },
    };
  }

  it("injuries not published: D2, E1 and E2 answer with the note, never STALE_ONLY", async () => {
    const c = await connect({ services: unpublished("nflverse:injuries"), options: world.options });
    try {
      for (const [name, args] of [
        ["ff_get_injuries", {}],
        [
          "ff_project_players",
          { players: { player_keys: ["manual.p.00-0034857"] }, horizon: "week", week: 4, seed: 1 },
        ],
        ["ff_analyze_lineup", { week: 4 }],
      ] as const) {
        const r = await c.client.callTool({ name, arguments: args });
        const b = body(r) as { warnings: string[] };
        expect(r.isError, `${name} ${JSON.stringify(b)}`).not.toBe(true);
        expect(b.warnings, name).toContain(
          "no 2026 nflverse:injuries published upstream yet (checked 3h ago)",
        );
      }
    } finally {
      await c.close();
    }
  });

  it("the league season's schedule not published: E2 refuses with season_not_published naming it", async () => {
    const c = await connect({
      services: unpublished("nflverse:schedules"),
      options: world.options,
    });
    try {
      const r = await c.client.callTool({ name: "ff_analyze_lineup", arguments: { week: 4 } });
      const e = (body(r) as { error: { code: string; message: string; hint: string } }).error;
      expect(r.isError).toBe(true);
      expect(e.code).toBe("STALE_ONLY");
      expect(e.message).toBe(STALE_ONLY_VARIANTS.season_not_published.message);
      expect(e.hint).toContain("2026");
      expect(e.hint).not.toMatch(/ff refresh/);
    } finally {
      await c.close();
    }
  });
});

describe("D3 without a league shows the schedule's season (the phase), 2026–2030", () => {
  let world: World;
  beforeAll(async () => {
    world = await makeWorld({ noLeague: true, publish: false });
  }, 60_000);
  afterAll(() => {
    world.cleanup();
  });

  /** A league-less server over a synthetic schedules file of `seasons`, at `atIso`. */
  async function d3At(
    seasons: number[],
    atIso: string,
  ): Promise<{ warnings: string[]; seasons: number[] }> {
    world.clock.set(atIso);
    const now = world.clock.nowMs();
    const reader = scheduleReaderOf(syntheticSeasons(seasons), {
      checkedAt: iso(now - 10 * 60_000),
      fileVersion: `v-${seasons.join("-")}-${atIso}`,
    });
    const svc: McpServices = {
      ...world.services,
      datasets: { ...world.services.datasets, schedules: reader },
      scheduleView: (ms) => scheduleView(reader, ms),
    };
    const c = await connect({ services: svc, options: world.options });
    try {
      const r = await c.client.callTool({
        name: "ff_get_schedule",
        arguments: { include_weather: false },
      });
      const b = body(r) as { warnings: string[]; data: { games: { game_id: string }[] } };
      expect(r.isError, JSON.stringify(b)).not.toBe(true);
      return {
        warnings: b.warnings,
        seasons: [...new Set(b.data.games.map((g) => Number(g.game_id.slice(0, 4))))],
      };
    } finally {
      await c.close();
    }
  }

  for (const y of [2026, 2027, 2028, 2029, 2030]) {
    it(`season ${String(y)}: off-season, preseason once published, regular, postseason`, async () => {
      const shown = (w: string[]): number | null => {
        const m = / of the (\d{4}) NFL season is shown$/.exec(
          w.find((x) => x.startsWith("no league configured")) ?? "",
        );
        return m === null ? null : Number(m[1]);
      };
      // 15 April: the season before is finished and the next one not published → offseason(y − 1)
      const off = await d3At([y - 1], `${String(y)}-04-15T16:00:00.000Z`);
      expect(shown(off.warnings)).toBe(y - 1);
      // the May schedule release loads season y → preseason(y): y's week 1 is shown
      const pre = await d3At([y - 1, y], `${String(y)}-05-20T16:00:00.000Z`);
      expect(shown(pre.warnings)).toBe(y);
      expect(pre.seasons).toEqual([y]);
      // mid-October → regular(y); late January → postseason(y)
      expect(shown((await d3At([y - 1, y], `${String(y)}-10-14T16:00:00.000Z`)).warnings)).toBe(y);
      expect(shown((await d3At([y - 1, y], `${String(y + 1)}-01-20T16:00:00.000Z`)).warnings)).toBe(
        y,
      );
    });
  }
});
