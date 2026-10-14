// season-rollover.e2e.test.ts — a year in the life of an install, 2027–2030 (season-fresh spec §2,
// §3.3, §4, §12 B3): synthetic schedules, published upstream from mid-May of their season, flow
// through the REAL runner and publisher (a fake schedules source in front of them) whenever the tick's
// own decision (`tickDecisionOf`, `refreshSeasons` of the schedule's phase) says so; at every clock —
// 15 Mar, 20 May, 20 Aug, every day from 1 Sep to two weeks after the opener, Wednesday of week 4,
// 30 min before a Monday night game, Saturday of week 16, Christmas, Super Bowl Sunday and an April
// off-season day — the served tools answer for the league file of the season in progress: D3 never
// answers STALE_ONLY on this healthy install, a league file for the new season gets its week-1
// opponents and kickoffs from the May release, and a league file left on the previous season is
// flagged (G1 `league_matches: false`, the rollover warning in the analytics tools) once the new
// season's preseason starts. Only the schedule is published (synthetic); the analytics tools are held
// to "never STALE_ONLY" here, their data paths to tests/mcp/season-coverage.test.ts.
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
import { syntheticSeasons } from "../helpers/season/synthetic.js";
import { body, connect, makeWorld, ROOT, type World } from "../mcp/helpers/env.js";

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

/** The scheduled tick for schedules at the world's clock: refresh when (and as) it is due. */
async function tick(w: World, u: Upstream): Promise<void> {
  const now = w.clock.nowMs();
  u.now = now;
  w.store.reattachIfChanged();
  const view = scheduleView(w.store.datasets.schedules, now);
  const d = tickDecisionOf(
    {
      refreshLog: w.store.repos.refreshLog,
      providerBackoff: w.store.repos.providerBackoff,
      seasonChecks: w.store.repos.seasonChecks,
      storeStats: () => w.store.stats(),
    },
    "nflverse:schedules",
    view,
    now,
    0,
  );
  if (d?.due !== true) return;
  const cache = w.config.cacheDir;
  const publisher = storeFactory.openPublisher({
    storePath: storePath(cache),
    datasetDir: datasetDir(cache),
    clock: w.clock,
  });
  try {
    const r = await runRefresh(
      {
        source: syntheticSource(u),
        seasons: refreshSeasons("nflverse:schedules", view.phase),
        week: null,
      },
      {
        http: () => Promise.reject(new Error("no network in the e2e")),
        clock: w.clock,
        rng: seededRng(1),
        publisher,
        refreshLog: w.store.repos.refreshLog,
        schedules: w.store.datasets.schedules,
        temp: fsTempArea(path.join(cache, "tmp")),
        seasonChecks: w.store.repos.seasonChecks,
        sleep: () => Promise.resolve(),
      },
    );
    expect(["published", "unchanged", "skipped"], JSON.stringify(r).slice(0, 300)).toContain(
      r.status,
    );
  } finally {
    publisher.close();
  }
  w.store.reattachIfChanged();
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
    it("the tick keeps the schedule current; D3 and G1 answer at every clock; the rollover is flagged", async () => {
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
