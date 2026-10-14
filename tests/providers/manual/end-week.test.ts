// end-week.test.ts — src/providers/manual/normalize.ts (season-fresh spec §2.6): a league file that
// names no end_week ends one week before the league season's last regular week when the schedule is
// loaded (17, 18 or 19 for an 18-, 19- or 20-week season), and falls back to the named week 17 with
// a warning when it is not; an explicit end_week always wins. The provider passes the league season's
// schedule (seasons 2026–2030) and re-normalises when it arrives; the warning reaches the tools.
import { describe, expect, it } from "vitest";
import { TOOL_INPUT_WEEK_MAX } from "../../../src/config/weeks.js";
import { seasonSchedule, lastRegularWeek } from "../../../src/domain/league/season.js";
import {
  DEFAULT_END_WEEK,
  END_WEEK_FALLBACK_WARNING,
  defaultEndWeek,
  normalizeLeague,
} from "../../../src/providers/manual/normalize.js";
import { parseLeagueYaml } from "../../../src/providers/manual/parse.js";
import { leagueFileSchema } from "../../../src/providers/manual/schema.js";
import { syntheticSeason } from "../../helpers/season/synthetic.js";
import { body, connect, makeWorld } from "../../mcp/helpers/env.js";
import {
  EXAMPLE_LEAGUE,
  FIXTURE_TEXT,
  clock,
  provider,
  scheduleOf,
  tempLeague,
} from "./helpers.js";

/** The fixture league with its end_week line removed (and, optionally, a current week). */
function fileWithoutEndWeek(currentWeek?: number) {
  const text = FIXTURE_TEXT.replace(/^ {2}end_week: \d+\n/m, "");
  expect(text).not.toMatch(/^ {2}end_week:/m);
  const raw = parseLeagueYaml(text) as { league: Record<string, unknown> };
  const league =
    currentWeek === undefined ? raw.league : { ...raw.league, current_week: currentWeek };
  return leagueFileSchema.parse({ ...raw, league });
}

describe("the league's default end week", () => {
  it("comes from the schedule: last regular week − 1 for 18-, 19- and 20-week seasons", () => {
    for (const regWeeks of [18, 19, 20] as const) {
      const sched = seasonSchedule(syntheticSeason({ season: 2028, regWeeks }), 2028);
      const n = normalizeLeague(fileWithoutEndWeek(), { lastRegularWeek: lastRegularWeek(sched) });
      expect(n.ok).toBe(true);
      if (!n.ok) return;
      expect(n.data.end_week).toBe(regWeeks - 1);
      expect(n.data.end_week_basis).toBe("schedule");
      expect(n.data.warnings).toEqual([]);
    }
  });

  it("falls back to the named week 17 with a warning when no schedule is loaded", () => {
    for (const opts of [{}, { lastRegularWeek: null }]) {
      const n = normalizeLeague(fileWithoutEndWeek(), opts);
      expect(n.ok).toBe(true);
      if (!n.ok) return;
      expect(n.data.end_week).toBe(DEFAULT_END_WEEK);
      expect(n.data.end_week_basis).toBe("fallback");
      expect(n.data.warnings).toEqual([END_WEEK_FALLBACK_WARNING]);
    }
  });

  it("an explicit end_week wins over the schedule", () => {
    const raw = leagueFileSchema.parse(parseLeagueYaml(FIXTURE_TEXT));
    const n = normalizeLeague(raw, { lastRegularWeek: 20 });
    expect(n.ok && n.data.end_week).toBe(raw.league.end_week);
    expect(n.ok && n.data.end_week_basis).toBe("file");
    expect(n.ok && n.data.warnings).toEqual([]);
  });

  it("checks the current week against the derived end week", () => {
    expect(normalizeLeague(fileWithoutEndWeek(19), { lastRegularWeek: 20 }).ok).toBe(true);
    const fallback = normalizeLeague(fileWithoutEndWeek(19));
    expect(fallback.ok).toBe(false);
    if (!fallback.ok) expect(fallback.issues.map((i) => i.path)).toContain("league.current_week");
  });

  it("stays within the start week and the tool-input bound", () => {
    expect(defaultEndWeek(undefined, 1, 30)).toEqual({
      end_week: TOOL_INPUT_WEEK_MAX,
      basis: "schedule",
    });
    expect(defaultEndWeek(undefined, 5, 3)).toEqual({ end_week: 5, basis: "schedule" });
    expect(defaultEndWeek(12, 1, 20)).toEqual({ end_week: 12, basis: "file" });
    expect(defaultEndWeek(undefined, 1, null)).toEqual({
      end_week: DEFAULT_END_WEEK,
      basis: "fallback",
    });
  });
});

describe("the provider passes the league season's schedule to the default (and re-reads it)", () => {
  // normalizeLeague took the schedule's last regular week, but the provider never passed it: a
  // league file without end_week always ended at week 17 — in a 19- or 20-week season the league
  // was reported finished a week or two early — and the fallback's warning never reached a tool.
  for (const S of [2026, 2027, 2028, 2029, 2030])
    for (const regWeeks of [18, 19, 20] as const)
      it(`${String(S)}, ${String(regWeeks)} regular weeks: end_week ${String(regWeeks - 1)}, not finished in week ${String(regWeeks - 1)}`, async () => {
        const games = syntheticSeason({ season: S, regWeeks, seed: S + regWeeks });
        const text = FIXTURE_TEXT.replace(/^ {2}end_week: \d+\n/m, "").replace(
          /^ {2}season: \d{4}$/m,
          `  season: ${String(S)}`,
        );
        const t = tempLeague(text);
        try {
          const last = regWeeks - 1;
          const k = Math.min(
            ...games
              .filter((g) => g.week === last && g.kickoff !== null)
              .map((g) => Date.parse(g.kickoff ?? "")),
          );
          const at = clock(new Date(k - 3_600_000).toISOString());
          const p = provider(t.file, { clock: at, schedule: scheduleOf(games) });
          const league = (await p.getLeague(EXAMPLE_LEAGUE)).value;
          expect(league.end_week).toBe(last);
          expect(league.is_finished).toBe(false);
          expect(league.current_week).toBe(last);
          expect(league.notes ?? []).toEqual([]);
          // no schedule for the league season: the named fallback, and its warning reaches the tools
          const none = provider(t.file, { clock: at, schedule: scheduleOf([]) });
          const fb = (await none.getLeague(EXAMPLE_LEAGUE)).value;
          expect(fb.end_week).toBe(DEFAULT_END_WEEK);
          expect(fb.notes).toEqual([END_WEEK_FALLBACK_WARNING]);
        } finally {
          t.cleanup();
        }
      });

  it("the same file is re-normalised when the league season's schedule arrives (the cache keys on it)", async () => {
    const games = syntheticSeason({ season: 2029, regWeeks: 20, seed: 3 });
    const text = FIXTURE_TEXT.replace(/^ {2}end_week: \d+\n/m, "").replace(
      /^ {2}season: \d{4}$/m,
      "  season: 2029",
    );
    const t = tempLeague(text);
    try {
      let loaded: readonly (typeof games)[number][] = [];
      const reader = {
        games: (season: number, weeks: readonly number[]) => ({
          rows: loaded.filter((g) => g.season === season && weeks.includes(g.week)),
          stamp: null,
        }),
        firstKickoff: () => null,
      };
      const p = provider(t.file, { clock: clock("2029-08-01T12:00:00.000Z"), schedule: reader });
      expect((await p.getLeague(EXAMPLE_LEAGUE)).value.end_week).toBe(DEFAULT_END_WEEK);
      loaded = games;
      expect((await p.getLeague(EXAMPLE_LEAGUE)).value.end_week).toBe(19);
    } finally {
      t.cleanup();
    }
  });
});

describe("the fallback's warning reaches the tools that read the league", () => {
  it("ff_get_league and ff_get_roster carry it when the league season has no loaded schedule", async () => {
    // the fixture schedule holds 2025–2026: a league file for 2027 without end_week has no schedule
    const text = FIXTURE_TEXT.replace(/^ {2}end_week: \d+\n/m, "").replace(
      /^ {2}season: \d{4}$/m,
      "  season: 2027",
    );
    const t = tempLeague(text);
    const w = await makeWorld({ env: { FF_LEAGUE_FILE: t.file } });
    try {
      const { client, close } = await connect(w);
      for (const name of ["ff_get_league", "ff_get_roster"]) {
        const r = await client.callTool({ name, arguments: {} });
        const env = body(r) as { warnings?: string[] };
        expect(r.isError, name).not.toBe(true);
        expect(env.warnings, name).toContain(END_WEEK_FALLBACK_WARNING);
      }
      await close();
    } finally {
      w.cleanup();
      t.cleanup();
    }
  }, 60_000);
});
