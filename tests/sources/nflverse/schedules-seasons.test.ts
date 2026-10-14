// schedules-seasons.test.ts — the one-file schedules source and a season its file does not hold
// (season-fresh §3.3, QA-1-033): games.parquet holds every season since 1999, so the next season
// (S+1, before its schedule's release in May) was copied as an empty season and never reported —
// no season_check, coverage `missing`, and a hint to run `ff refresh --seasons S+1`, whose publish
// then dropped every other season. Now a requested season the file does not hold, and that may not
// be published yet, is reported `not_published` and left out; a run with nothing else publishes
// nothing; and a games table that would be empty is never published. Over seasons 2026–2030 (the
// fixture's two seasons shifted), with the clock in each S+1 off-season.
import { afterEach, describe, expect, it } from "vitest";
import { fixedClock } from "../../../src/domain/clock.js";
import { NflverseSourceError } from "../../../src/sources/nflverse/release.js";
import { schedulesSource } from "../../../src/sources/nflverse/schedules.js";
import { fixtureRoutes, makeCtx, REL, SqliteWriter, type Ctx } from "./helpers/harness.js";
import { rewrite } from "./helpers/rewrite.js";

const GAMES = `${REL}/schedules/games.parquet`;
/** The fixture's seasons: 2025 and 2026. */
const FIXTURE_LAST = 2026;

const open: Ctx[] = [];
const writers: SqliteWriter[] = [];
afterEach(() => {
  for (const w of writers.splice(0)) w.close();
  for (const c of open.splice(0)) c.cleanup();
});

/** games.parquet with every season (and game id) shifted so its last season is `last`. */
async function gamesUpTo(last: number): Promise<Uint8Array> {
  const k = last - FIXTURE_LAST;
  return rewrite("schedules/games.excerpt.parquet", {
    rows: (rs) =>
      rs.map((r) => {
        const season = Number(r.season) + k;
        return {
          ...r,
          season,
          game_id: String(r.game_id).replace(/^\d{4}/, String(season)),
        };
      }),
  });
}

/** One fetch of `seasons` at `now`: the files, the seasons reported not published. */
async function fetchAt(
  seasons: readonly number[],
  last: number,
  now: string,
): Promise<{ c: Ctx; files: { season: number | null }[]; unpublished: number[] }> {
  const routes = fixtureRoutes();
  routes.set(GAMES, await gamesUpTo(last));
  const unpublished: number[] = [];
  const c = makeCtx(seasons, routes, {
    clock: fixedClock(now),
    notPublished: (s: number) => {
      unpublished.push(s);
    },
  });
  open.push(c);
  const v = await schedulesSource.version(c.ctx);
  if (v === null) throw new Error("no version");
  const files = await schedulesSource.fetch(v, c.ctx);
  return { c, files: [...files], unpublished };
}

describe("a season games.parquet does not hold", () => {
  for (const S of [2026, 2027, 2028, 2029, 2030])
    it(`${String(S)}: S+1 before its schedule's release is not_published and left out; S−1 and S publish`, async () => {
      const now = `${String(S + 1)}-03-15T16:00:00.000Z`; // the off-season: draft prep for S+1
      const { c, files, unpublished } = await fetchAt([S - 1, S, S + 1], S, now);
      expect(unpublished).toEqual([S + 1]);
      expect(files.map((f) => f.season)).toEqual([S - 1, S]);
      // one download whatever the seasons
      expect(c.calls.filter((u) => u.endsWith("games.parquet"))).toHaveLength(1);
      const w = new SqliteWriter(c.tempDir);
      writers.push(w);
      const stats = await schedulesSource.publish(files as never, w);
      expect(stats.seasons).toEqual([S - 1, S]);

      // only S+1 asked (a manual `--seasons S+1`): nothing to publish, never an empty file
      const only = await fetchAt([S + 1], S, now);
      expect(only.unpublished).toEqual([S + 1]);
      expect(only.files).toEqual([]);
    });

  it("a past season it does not hold is not 'not published': a games table left empty is never published", async () => {
    const now = "2027-03-15T16:00:00.000Z";
    const { c, files, unpublished } = await fetchAt([2019], 2026, now);
    expect(unpublished).toEqual([]);
    const w = new SqliteWriter(c.tempDir);
    writers.push(w);
    await expect(schedulesSource.publish(files as never, w)).rejects.toBeInstanceOf(
      NflverseSourceError,
    );
  });
});
