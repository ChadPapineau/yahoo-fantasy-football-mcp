// end-week.test.ts — src/providers/manual/normalize.ts (season-fresh spec §2.6): a league file that
// names no end_week ends one week before the league season's last regular week when the schedule is
// loaded (17, 18 or 19 for an 18-, 19- or 20-week season), and falls back to the named week 17 with
// a warning when it is not; an explicit end_week always wins.
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
import { FIXTURE_TEXT } from "./helpers.js";

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
