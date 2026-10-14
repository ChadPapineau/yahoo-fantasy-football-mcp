// season-rollover.e2e.test.ts — a year in the life of an install, 2027–2030 (season-fresh spec §2,
// §3.3, §4, §12 B3): synthetic schedules, published upstream from mid-May of their season, and the
// per-season injuries, weekly rosters and player stats — each published upstream as nflverse does
// (rosters from March, injuries a few days before the opener, stats once week 1 is played; before
// that the file is a 404) — flow through the REAL runner, sources and publisher whenever the tick's own
// decision (`tickDecisionOf`, `refreshSeasons` of the schedule's phase) says so; at every clock —
// 15 Mar, 20 May, 20 Aug, every day from 1 Sep to two weeks after the opener, Wednesday of week 4,
// 30 min before a Monday night game, Saturday of week 16, Christmas, Super Bowl Sunday and an April
// off-season day — the served tools answer for the league file of the season in progress: D3, D2 and
// the analytics tools (E1, E2, E3, E5) never answer STALE_ONLY on this healthy install, a league file
// for the new season gets its week-1 opponents and kickoffs from the May release and non-zero week-1
// projections from May on, and a league file left on the previous season is flagged (G1
// `league_matches: false`, the rollover warning in the analytics tools) once the new season's
// preseason starts.
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { datasetDir, storePath } from "../../src/config/paths.js";
import { easternClockOf } from "../../src/config/game-calendar.js";
import type { NflGame } from "../../src/domain/analytics/types.js";
import { seededRng } from "../../src/domain/clock.js";
import { scheduleView } from "../../src/domain/league/calendar.js";
import { refreshSeasons } from "../../src/domain/league/season.js";
import { tickDecisionOf } from "../../src/mcp/refresh.js";
import type { McpServices } from "../../src/mcp/services.js";
import { ManualLeagueProvider } from "../../src/providers/manual/index.js";
import { publishStats } from "../../src/sources/nflverse/base.js";
import { NFLVERSE_SOURCES } from "../../src/sources/nflverse/index.js";
import { TableLoader } from "../../src/sources/nflverse/rows.js";
import { gameRow } from "../../src/sources/nflverse/schedules.js";
import type { DataSource, TempFile } from "../../src/sources/source.js";
import { fsTempArea, runRefresh } from "../../src/sources/runner.js";
import { venueRows } from "../../src/sources/venues.js";
import { DS_GAMES, DS_VENUES } from "../../src/store/datasets/tables.js";
import { storeFactory } from "../../src/store/index.js";
import type { HttpGet } from "../../src/sources/source.js";
import { syntheticSeasons } from "../helpers/season/synthetic.js";
import { body, connect, makeWorld, ROOT, type World } from "../mcp/helpers/env.js";
import { REL } from "../sources/nflverse/helpers/harness.js";
import { rewrite } from "../sources/nflverse/helpers/rewrite.js";

const D = 86_400_000;

/** A synthetic game as an nflverse `games` row (what the real schedules source publishes from). */
function rawOf(g: NflGame): Record<string, unknown> {
  const k = g.kickoff === null ? null : easternClockOf(Date.parse(g.kickoff));
  const hhmm =
    k === null ? null : `${String(k.hour).padStart(2, "0")}:${String(k.minute).padStart(2, "0")}`;
  return {
    game_id: g.game_id,
    season: g.season,
    game_type: g.game_type ?? "REG",
    week: g.week,
    gameday: g.gameday ?? k?.date ?? null,
    weekday: k?.weekday ?? null,
    gametime: hhmm,
    away_team: g.away,
    home_team: g.home,
    location: "Home",
    away_rest: 7,
    home_rest: 7,
    div_game: 0,
    roof: g.roof,
    surface: "grass",
    stadium_id: g.stadium_id,
    stadium: null,
  };
}

/** Upstream: every synthetic season, each published from 15 May of its year. */
interface Upstream {
  readonly games: readonly NflGame[];
  now: number;
}

/** The per-season nflverse sources: their release tag, file, fixture stand-in and first day upstream. */
const SEASON_SOURCES = [
  {
    id: "nflverse:roster_weekly" as const,
    tag: "weekly_rosters",
    file: (s: number) => `roster_weekly_${String(s)}.parquet`,
    fixture: "weekly_rosters/roster_weekly_2026.excerpt.parquet",
    // rosters from 1 March of their season
    from: (_u: Upstream, s: number) => Date.parse(`${String(s)}-03-01T12:00:00Z`),
  },
  {
    id: "nflverse:injuries" as const,
    tag: "injuries",
    file: (s: number) => `injuries_${String(s)}.parquet`,
    fixture: "injuries/injuries_2026.parquet",
    // the first practice reports, four days before the opener
    from: (u: Upstream, s: number) => firstKickoffOf(u, s) - 4 * D,
  },
  {
    id: "nflverse:stats_player_week" as const,
    tag: "stats_player",
    file: (s: number) => `stats_player_week_${String(s)}.parquet`,
    fixture: "stats_player/stats_player_week_2026.parquet",
    // once week 1 has been played
    from: (u: Upstream, s: number) => lastWeekOneKickoffOf(u, s) + D,
  },
];

const kickoffsOf = (u: Upstream, s: number, week?: number): number[] =>
  u.games
    .filter(
      (g) =>
        g.season === s &&
        g.game_type === "REG" &&
        g.kickoff !== null &&
        (week === undefined || g.week === week),
    )
    .map((g) => Date.parse(g.kickoff ?? ""));
const firstKickoffOf = (u: Upstream, s: number): number => Math.min(...kickoffsOf(u, s));
const lastWeekOneKickoffOf = (u: Upstream, s: number): number => Math.max(...kickoffsOf(u, s, 1));

/** The fixture file of a source relabelled as season `s` (cached: rewriting is the slow part). */
const relabelled = new Map<string, Promise<Uint8Array>>();
function bytesOf(fixture: string, s: number): Promise<Uint8Array> {
  const key = `${fixture}|${String(s)}`;
  let p = relabelled.get(key);
  if (p === undefined) {
    p = rewrite(fixture, { rows: (rs) => rs.map((r) => ({ ...r, season: s })) });
    relabelled.set(key, p);
  }
  return p;
}

/**
 * Upstream's release assets for the per-season sources at `u.now`: a season's file is served from
 * its first day upstream (404 before), and each tag's timestamp.txt moves with every new season.
 */
function upstreamHttp(u: Upstream): HttpGet {
  const seasons = [...new Set(u.games.map((g) => g.season))];
  return async (url, opts) => {
    const reply = (status: number, body: Uint8Array) => ({
      status,
      body,
      headers: {},
      final_url: "https://release-assets.githubusercontent.com/x",
    });
    if (opts.signal.aborted) throw new Error("aborted");
    for (const src of SEASON_SOURCES) {
      if (url === `${REL}/${src.tag}/timestamp.txt`) {
        const live = seasons.map((s) => src.from(u, s)).filter((t) => t <= u.now);
        const at = live.length === 0 ? Date.parse("2020-01-01T00:00:00Z") : Math.max(...live);
        return reply(200, new TextEncoder().encode(new Date(at).toISOString().replace(".000", "")));
      }
      for (const s of seasons)
        if (url === `${REL}/${src.tag}/${src.file(s)}`)
          return src.from(u, s) <= u.now
            ? reply(200, await bytesOf(src.fixture, s))
            : reply(404, new Uint8Array(0));
    }
    return reply(404, new Uint8Array(0));
  };
}
const publishedFrom = (season: number): number => Date.parse(`${String(season)}-05-15T12:00:00Z`);
const releasedSeasons = (u: Upstream): number[] =>
  [...new Set(u.games.map((g) => g.season))].filter((s) => publishedFrom(s) <= u.now);

/** A schedules source over `u`: the real tables and row mapping, synthetic bytes (JSON). */
function syntheticSource(u: Upstream): DataSource {
  const real = NFLVERSE_SOURCES["nflverse:schedules"];
  return {
    ...real,
    version: () =>
      Promise.resolve({ version: `syn-${releasedSeasons(u).join("-")}`, released_at: null }),
    fetch: (_version, ctx) => {
      const out: TempFile[] = [];
      for (const s of ctx.seasons) {
        if (!releasedSeasons(u).includes(s)) {
          ctx.notPublished?.(s);
          continue;
        }
        const file = path.join(ctx.tempDir ?? "", `games-${String(s)}.json`);
        writeFileSync(file, JSON.stringify(u.games.filter((g) => g.season === s).map(rawOf)));
        out.push({ path: file, bytes: statSync(file).size, season: s });
      }
      return Promise.resolve(out);
    },
    assertSchema: (files) =>
      Promise.resolve({
        ok: true,
        missing_columns: [],
        extra_columns: [],
        bad_codecs: [],
        rows: files.length,
        warnings: [],
      }),
    publish: (files, into) => {
      const games = new TableLoader(into, DS_GAMES);
      const venues = new TableLoader(into, DS_VENUES);
      for (const f of files)
        for (const raw of JSON.parse(readFileSync(f.path, "utf8")) as Record<string, unknown>[])
          games.add(gameRow(raw));
      for (const v of venueRows()) venues.add(v);
      return Promise.resolve(publishStats([games, venues], []));
    },
    versionForSeasons: (v, seasons) => ({ ...v, version: `${v.version}+${seasons.join(",")}` }),
  };
}

/** The scheduled tick at the world's clock: each source refreshed when (and as) it is due. */
async function tick(w: World, u: Upstream): Promise<void> {
  const ports = {
    refreshLog: w.store.repos.refreshLog,
    providerBackoff: w.store.repos.providerBackoff,
    seasonChecks: w.store.repos.seasonChecks,
    storeStats: () => w.store.stats(),
  };
  for (const id of [
    "nflverse:schedules",
    "nflverse:injuries",
    "nflverse:roster_weekly",
    "nflverse:stats_player_week",
  ] as const) {
    const now = w.clock.nowMs();
    u.now = now;
    w.store.reattachIfChanged();
    const view = scheduleView(w.store.datasets.schedules, now);
    const d = tickDecisionOf(ports, id, view, now, 0);
    if (d?.due !== true) continue;
    const cache = w.config.cacheDir;
    const publisher = storeFactory.openPublisher({
      storePath: storePath(cache),
      datasetDir: datasetDir(cache),
      clock: w.clock,
    });
    try {
      const r = await runRefresh(
        {
          source: id === "nflverse:schedules" ? syntheticSource(u) : NFLVERSE_SOURCES[id],
          seasons: refreshSeasons(id, view.phase),
          week: null,
        },
        {
          http: upstreamHttp(u),
          clock: w.clock,
          rng: seededRng(1),
          publisher,
          refreshLog: w.store.repos.refreshLog,
          schedules: w.store.datasets.schedules,
          temp: fsTempArea(path.join(cache, "tmp")),
          seasonChecks: w.store.repos.seasonChecks,
          providerBackoff: w.store.repos.providerBackoff,
          sleep: () => Promise.resolve(),
        },
      );
      expect(
        ["published", "unchanged", "skipped"],
        `${id} ${new Date(now).toISOString()} ${JSON.stringify(r).slice(0, 300)}`,
      ).toContain(r.status);
    } finally {
      publisher.close();
    }
    w.store.reattachIfChanged();
  }
}

/** The analytics and injury tools a user's turn calls, for the league file in force. */
async function analyticsCalls(
  c: Awaited<ReturnType<typeof connect>>,
  at: string,
  preseason: boolean,
): Promise<void> {
  const week = preseason ? { week: 1 } : {};
  const calls: [string, Record<string, unknown>][] = [
    ["ff_get_injuries", { ...week }],
    [
      "ff_project_players",
      {
        players: { player_keys: ["manual.p.00-0034857", "manual.p.00-0036900"] },
        horizon: "week",
        ...week,
        n_sims: 1000,
        seed: 1,
      },
    ],
    ["ff_analyze_lineup", { ...week }],
    ["ff_analyze_matchup", { ...week }],
    ["ff_analyze_waivers", { positions: ["K"] }],
  ];
  for (const [name, args] of calls) {
    const r = await c.client.callTool({ name, arguments: args });
    const b = body(r) as {
      error?: { code: string; message?: string };
      data?: { projections?: { weeks: { points: { mean: number } }[] }[] };
    };
    // never STALE_ONLY on a healthy install, on any day (NOT_FOUND for a week without an opponent,
    // a finished league's VALIDATION and the like are the tools' honest answers)
    expect(b.error?.code, `${at} ${name}: ${JSON.stringify(b.error ?? {}).slice(0, 300)}`).not.toBe(
      "STALE_ONLY",
    );
    // the new season's league file gets real week-1 projections from the May release on
    if (name === "ff_project_players" && preseason) {
      expect(r.isError, `${at}: ${JSON.stringify(b).slice(0, 300)}`).not.toBe(true);
      const means = (b.data?.projections ?? []).flatMap((p) => p.weeks.map((x) => x.points.mean));
      expect(means.length, at).toBeGreaterThan(0);
      for (const m of means) expect(m, at).toBeGreaterThan(0);
    }
  }
}

/** A league file for `season` (the fixture league's teams and rules), mode 0600 in the world. */
function leagueFile(dir: string, season: number): string {
  const src = readFileSync(path.join(ROOT, "fixtures", "manual", "league.yaml"), "utf8");
  const file = path.join(dir, `league-${String(season)}.yaml`);
  writeFileSync(file, src.replace(/^(\s*)season: \d{4}$/m, `$1season: ${String(season)}`), {
    mode: 0o600,
  });
  return file;
}

/** The world's services with the league read from `file` (the provider the composition root builds). */
function withLeague(w: World, file: string): McpServices {
  return {
    ...w.services,
    platform: new ManualLeagueProvider({
      file,
      clock: w.clock,
      logger: w.logger,
      schedule: w.store.datasets.schedules,
      rosters: w.store.rosterWeekly,
      requirePrivate: true,
    }),
  };
}

/** The clocks of one season year (ISO), in order. */
function clocksOf(y: number, games: readonly NflGame[]): string[] {
  const reg = games.filter((g) => g.season === y && g.game_type === "REG" && g.kickoff !== null);
  const first = Math.min(...reg.map((g) => Date.parse(g.kickoff ?? "")));
  const out = [
    `${String(y)}-03-15T16:00:00.000Z`,
    `${String(y)}-05-20T16:00:00.000Z`,
    `${String(y)}-08-20T16:00:00.000Z`,
  ];
  for (let t = Date.parse(`${String(y)}-09-01T16:00:00.000Z`); t <= first + 14 * D; t += D)
    out.push(new Date(t).toISOString());
  const wk = (w: number) => reg.filter((g) => g.week === w).map((g) => Date.parse(g.kickoff ?? ""));
  const w4 = Math.min(...wk(4));
  out.push(new Date(w4 - (easternClockOf(w4).weekday === "Thu" ? 1 : 2) * D).toISOString());
  const mnf = reg.find((g) => easternClockOf(Date.parse(g.kickoff ?? "")).weekday === "Mon");
  if (mnf !== undefined)
    out.push(new Date(Date.parse(mnf.kickoff ?? "") - 30 * 60_000).toISOString());
  const sat16 = reg.find(
    (g) => g.week === 16 && easternClockOf(Date.parse(g.kickoff ?? "")).weekday === "Sat",
  );
  if (sat16 !== undefined)
    out.push(new Date(Date.parse(sat16.kickoff ?? "") - 3_600_000).toISOString());
  out.push(`${String(y)}-12-25T15:00:00.000Z`);
  const sb = games.find((g) => g.season === y && g.game_type === "SB");
  if (sb?.kickoff != null) out.push(new Date(Date.parse(sb.kickoff) - 2 * 3_600_000).toISOString());
  out.push(`${String(y + 1)}-04-12T16:00:00.000Z`);
  return [...new Set(out)].sort();
}

const worlds: World[] = [];
afterAll(() => {
  for (const w of worlds.splice(0)) w.cleanup();
});

for (const y of [2027, 2028, 2029, 2030]) {
  describe(`season ${String(y)}`, () => {
    it("the tick keeps every source current; D3, D2, G1 and E1–E3, E5 answer (never STALE_ONLY) at every clock; the rollover is flagged", async () => {
      const games = syntheticSeasons([y - 2, y - 1, y, y + 1]);
      const u: Upstream = { games, now: 0 };
      // an install made in the previous season, its league file then the new season's from May
      const w = await makeWorld({ publish: false, clock: `${String(y - 1)}-10-01T16:00:00.000Z` });
      worlds.push(w);
      const dir = w.config.configDir;
      const files = { prev: leagueFile(dir, y - 1), cur: leagueFile(dir, y) };
      await tick(w, u);
      for (const at of clocksOf(y, games)) {
        w.clock.set(at);
        await tick(w, u);
        const t = w.clock.nowMs();
        const view = scheduleView(w.store.datasets.schedules, t);
        const leagueSeason = t >= Date.parse(`${String(y)}-05-20T00:00:00Z`) ? y : y - 1;
        const svc = withLeague(w, leagueSeason === y ? files.cur : files.prev);
        const c = await connect({ services: svc, options: w.options });
        try {
          const sched = await c.client.callTool({
            name: "ff_get_schedule",
            arguments: { weeks: [1] },
          });
          const sb = body(sched) as {
            error?: { code: string };
            data?: { games: { game_id: string }[] };
          };
          expect(sched.isError, `${at}: ${JSON.stringify(sb).slice(0, 300)}`).not.toBe(true);
          // the league season's week 1 comes from that season's release
          expect(
            sb.data?.games.every((g) => g.game_id.startsWith(`${String(leagueSeason)}_01_`)),
          ).toBe(true);
          expect(sb.data?.games.length).toBeGreaterThan(0);
          const g1 = await c.client.callTool({
            name: "ff_get_status",
            arguments: { include_checks: true },
          });
          const gb = body(g1) as {
            data: { season: { nfl_season: number; phase: string; league_matches: boolean | null } };
          };
          expect(g1.isError).not.toBe(true);
          expect(gb.data.season.nfl_season).toBe(view.phase.season);
          expect(gb.data.season.league_matches, `${at} ${view.phase.phase}`).not.toBe(false);
          await analyticsCalls(
            c,
            at,
            leagueSeason === y && view.phase.season === y && view.phase.phase === "preseason",
          );
        } finally {
          await c.close();
        }
        // the same clock with last season's league file once this season's preseason has started
        if (view.phase.season === y && view.phase.phase !== "offseason") {
          const c2 = await connect({ services: withLeague(w, files.prev), options: w.options });
          try {
            const g1 = await c2.client.callTool({
              name: "ff_get_status",
              arguments: { include_checks: true },
            });
            const gb = body(g1) as { data: { season: { league_matches: boolean | null } } };
            expect(gb.data.season.league_matches, at).toBe(false);
            const e1 = await c2.client.callTool({
              name: "ff_project_players",
              arguments: {
                players: { player_keys: ["manual.p.00-0034857"] },
                horizon: "week",
                week: 1,
                seed: 1,
              },
            });
            const eb = body(e1) as { warnings?: string[]; error?: { code: string } };
            if (e1.isError !== true)
              expect(
                eb.warnings?.some((x) =>
                  x.startsWith(
                    `league season ${String(y - 1)} is not the NFL season in progress (${String(y)},`,
                  ),
                ),
              ).toBe(true);
            else expect(eb.error?.code).not.toBe("STALE_ONLY");
          } finally {
            await c2.close();
          }
        }
      }
    }, 600_000);
  });
}
