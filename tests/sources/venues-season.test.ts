// venues-season.test.ts — the venue table is a snapshot verified through one season
// (REFERENCE_VINTAGES.venues): for a later season a known game roof wins over the table's (the
// reader and the weather sources agree, so a renovated stadium gets no forecast), and the schedules
// publish says so; a neutral-site game resolved to its home team's own stadium warns too (the
// property tests/sources/nflverse/sources.test.ts held over the fixtures, now in the product).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REFERENCE_VINTAGES } from "../../src/config/reference-vintage.js";
import { fixedClock } from "../../src/domain/clock.js";
import type { NflGame } from "../../src/domain/analytics/types.js";
import { schedulesSource, type NflversePublishStats } from "../../src/sources/nflverse/index.js";
import { venueWarnings, type VenueCheckRow } from "../../src/sources/nflverse/schedules.js";
import type { SourceContext } from "../../src/sources/source.js";
import { venueById } from "../../src/sources/venues.js";
import { selectGames } from "../../src/sources/weather/common.js";
import { gameRoof } from "../../src/store/readers.js";
import { SqliteWriter } from "./nflverse/helpers/harness.js";
import { rewrite, tempFile } from "./nflverse/helpers/rewrite.js";

const V = REFERENCE_VINTAGES.venues.verified_through_season;

let dirs: string[] = [];
const writers: SqliteWriter[] = [];
afterEach(() => {
  for (const w of writers.splice(0)) w.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const row = (over: Readonly<Record<string, unknown>>): VenueCheckRow => ({
  season: V,
  home_team: "TEN",
  location: "Home",
  venue_id: "NAS00",
  roof: "outdoors",
  game_type: "REG",
  ...over,
});

describe("venueWarnings: a game roof against the venue table, past its vintage", () => {
  for (const season of [V + 1, V + 2, V + 4]) {
    it(`${String(season)}: an open-air stadium reported as a dome (and a dome reported open-air) warns, once per season`, () => {
      expect(
        venueWarnings([
          row({ season, roof: "dome" }),
          row({ season, roof: "closed", venue_id: "BUF00", home_team: "BUF" }),
          row({ season, roof: "outdoors", venue_id: "DET00", home_team: "DET" }),
          row({ season, roof: "outdoors" }), // agrees
          row({ season, roof: null }), // unknown: the table stands
          row({ season, roof: "open", venue_id: "HOU00", home_team: "HOU" }), // retractable
          row({ season, roof: "dome", venue_id: "NOPE00" }), // unknown venue
        ]),
      ).toEqual([
        `ds_games: 3 game(s) whose roof disagrees with the venue table (season ${String(season)})`,
      ]);
    });
  }

  for (const season of [V - 2, V]) {
    it(`${String(season)} (verified): the table's physical roof stands — no warning`, () => {
      expect(venueWarnings([row({ season, roof: "dome" })])).toEqual([]);
    });
  }
});

describe("venueWarnings: a neutral-site game at the home team's own stadium", () => {
  for (const season of [V - 1, V, V + 3]) {
    it(String(season), () => {
      const home = Array.from({ length: 7 }, () => row({ season }));
      expect(
        venueWarnings([
          ...home,
          row({ season, location: "Neutral" }), // filed under the home stadium: warns
          row({ season, location: "Neutral", venue_id: "LON00" }), // resolved abroad: fine
          row({ season, location: "Neutral", game_type: "SB" }), // a Super Bowl may be there
        ]).filter((w) => w.includes("neutral-site")),
      ).toEqual([
        `ds_games: 1 neutral-site game(s) resolved to the home team's own stadium (season ${String(season)})`,
      ]);
    });
  }
});

describe("a season past the vintage end to end: Nissan Stadium reported as a dome", () => {
  it("the publish warns, the reader serves the game roof, and the weather source skips the game", async () => {
    const season = V + 1;
    const dir = mkdtempSync(join(tmpdir(), "ff-venue-season-"));
    dirs.push(dir);
    // a real 2026 Titans home game re-dated into the next season, its roof reported as a dome
    const bytes = await rewrite("schedules/games.excerpt.parquet", {
      rows: (rs) =>
        rs.map((r) =>
          r.game_id === "2026_15_IND_TEN"
            ? {
                ...r,
                season,
                game_id: `${String(season)}_15_IND_TEN`,
                roof: "dome",
                gameday: `${String(season)}-12-20`,
              }
            : r,
        ),
    });
    const files = [tempFile(dir, "a.parquet", bytes, V), tempFile(dir, "b.parquet", bytes, season)];
    const w = new SqliteWriter(dir);
    writers.push(w);
    const stats = (await schedulesSource.publish(files, w)) as NflversePublishStats;
    expect(stats.warnings).toContain(
      `ds_games: 1 game(s) whose roof disagrees with the venue table (season ${String(season)})`,
    );
    const g = w.all(
      "SELECT g.roof, v.roof_default FROM ds_games AS g JOIN ds_venues AS v ON v.stadium_id = g.venue_id WHERE g.game_id = ?",
      `${String(season)}_15_IND_TEN`,
    )[0];
    expect(g).toEqual({ roof: "dome", roof_default: "outdoors" });
    expect(gameRoof("dome", venueById("NAS00"), season)).toBe("dome");

    // the weather source, reading the game as the reader maps it, forecasts nothing for it
    const kickoff = Date.parse(`${String(season)}-12-20T18:00:00.000Z`);
    const game: NflGame = {
      game_id: `${String(season)}_15_IND_TEN`,
      season,
      week: 15,
      kickoff: new Date(kickoff).toISOString(),
      away: "IND",
      home: "TEN",
      stadium_id: "NAS00",
      stadium: "Nissan Stadium",
      venue_tz: "America/Chicago",
      roof: gameRoof("dome", venueById("NAS00"), season),
      surface: null,
      divisional: true,
      rest_days: { away: null, home: null },
      lines: null,
      is_final: false,
      score: null,
    };
    const ctx = {
      clock: fixedClock(kickoff - 24 * 3_600_000),
      seasons: [season],
      week: null,
    } as unknown as SourceContext;
    const picked = selectGames(ctx, { usOnly: false, horizonHours: 168 }, { games: () => [game] });
    expect(picked.games).toEqual([]);
    // the same game in a verified season would be forecast (the table's open-air roof stands)
    const verified = { ...game, season: V, roof: gameRoof("dome", venueById("NAS00"), V) };
    const picked2 = selectGames(
      ctx,
      { usOnly: false, horizonHours: 168 },
      { games: () => [verified] },
    );
    expect(picked2.games.map((x) => x.game_id)).toEqual([game.game_id]);
  });
});
