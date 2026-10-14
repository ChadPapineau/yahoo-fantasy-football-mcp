// window-regular-weeks.test.ts — season-fresh §2.5–§2.7 (B4): the analytics read a season's length
// from its schedule, never from a fixed week count. Over synthetic 18-, 19- and 20-regular-week
// seasons 2026–2030: a week-1 trailing window reads the previous season's last 8 regular weeks and
// never a postseason week; a postseason week is never a bye, and the no-game wording follows
// `game_type` (a bye, out of a postseason round, past the final, or not scheduled yet); the K/DEF
// look-ahead reaches the season's own last week (week 23 of a 20-week season) and never past it; the
// base rates carry the reference registry's vintage.
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { REFERENCE_VINTAGES } from "../../../src/config/reference-vintage.js";
import type { NflTeam } from "../../../src/config/schema.js";
import { BASE_RATES } from "../../../src/domain/analytics/constants.js";
import { analyzeKdef } from "../../../src/domain/analytics/kdef.js";
import {
  projectPlayers,
  type ProjectionReaders,
  type ProjectionTarget,
} from "../../../src/domain/analytics/projection.js";
import type { DatasetStamp, NflGame } from "../../../src/domain/analytics/types.js";
import { fixedClock, seededRng } from "../../../src/domain/clock.js";
import type { ScoringSettings } from "../../../src/domain/scoring/types.js";
import { scheduleReaderOf } from "../../helpers/season/reader.js";
import {
  arbSeasonOptions,
  SYNTHETIC_SEASONS,
  syntheticSeasons,
} from "../../helpers/season/synthetic.js";
import { fixtureLeague } from "../../backtest/helpers/league.js";

let settings: ScoringSettings;
beforeAll(async () => {
  settings = (await fixtureLeague()).settings;
});

const DAY = 86_400_000;

const stamp = (
  source: DatasetStamp["source"],
  cls: DatasetStamp["freshness_class"],
): DatasetStamp => ({
  source,
  as_of: "2026-08-01T00:00:00.000Z",
  fetched_at: "2026-08-01T00:00:00.000Z",
  checked_at: "2026-08-01T00:00:00.000Z",
  freshness_class: cls,
  file_version: "v1",
});

/** Readers over `games` that record which stat weeks and injury weeks the engine asks for. */
function spyReaders(games: readonly NflGame[]) {
  const lineReads: { season: number; weeks: number[] }[] = [];
  const injuryWeeks: number[] = [];
  const stats = stamp("nflverse:stats_player_week", "nflverse_stats_player_week");
  const readers: ProjectionReaders = {
    schedules: scheduleReaderOf(games),
    injuries: {
      reports(_season, week) {
        injuryWeeks.push(week);
        return { rows: [], stamp: stamp("nflverse:injuries", "nflverse_injuries") };
      },
    },
    playerWeeks: {
      lines(_ids, season, weeks) {
        lineReads.push({ season, weeks: [...weeks] });
        return { rows: [], stamp: stats };
      },
      defenseLines: () => ({ rows: [], stamp: stats }),
    },
  };
  return { readers, lineReads, injuryWeeks };
}

const target = (team: NflTeam, position = "WR"): ProjectionTarget => ({
  player_key: `manual.p.00-00${position === "K" ? "88888" : "99999"}`,
  subject: { kind: "player", gsis_id: position === "K" ? "00-0088888" : "00-0099999" },
  name: "Player X",
  position,
  nfl_team: team,
});

const regWeeksOf = (games: readonly NflGame[], season: number): number[] =>
  [
    ...new Set(
      games.filter((g) => g.season === season && g.game_type === "REG").map((g) => g.week),
    ),
  ].sort((a, b) => a - b);

const firstKickoff = (games: readonly NflGame[], season: number): number =>
  Math.min(
    ...games
      .filter((g) => g.season === season && g.kickoff !== null)
      .map((g) => Date.parse(g.kickoff ?? "")),
  );

/** One season's games with its own number of regular weeks. */
const seasonOf = (season: number, regWeeks: 18 | 19 | 20, seed: number): NflGame[] =>
  syntheticSeasons([season], { regWeeks, seed });

describe("the trailing window's previous season comes from its own schedule (§2.6)", () => {
  it("property: week 1 reads the last 8 regular weeks of S−1 — never a postseason week — for 18, 19 and 20-week seasons 2026–2030", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SYNTHETIC_SEASONS),
        fc.constantFrom(18 as const, 19 as const, 20 as const),
        fc.constantFrom(18 as const, 19 as const, 20 as const),
        arbSeasonOptions,
        fc.constantFrom(1, 3),
        (season, priorWeeks, weeks, o, targetWeek) => {
          const games = [
            ...seasonOf(season - 1, priorWeeks, o.seed),
            ...seasonOf(season, weeks, o.seed),
          ];
          const team = games.find((g) => g.season === season)?.home ?? "BUF";
          const { readers, lineReads } = spyReaders(games);
          // before the target week's first kickoff: weeks before it are played
          const weekStart = Math.min(
            ...games
              .filter((g) => g.season === season && g.week === targetWeek)
              .map((g) => Date.parse(g.kickoff ?? "")),
          );
          projectPlayers({
            targets: [target(team)],
            season,
            weeks: [targetWeek],
            settings,
            readers,
            clock: fixedClock(weekStart - DAY),
            rng: seededRng(1),
            n_sims: 1000,
          });
          const priorReg = regWeeksOf(games, season - 1);
          expect(priorReg.at(-1)).toBe(priorWeeks);
          const cur = lineReads.find((r) => r.season === season)?.weeks ?? [];
          const prev = lineReads.find((r) => r.season === season - 1)?.weeks ?? [];
          expect(cur).toEqual(targetWeek === 1 ? [] : [1, 2]);
          // the rest of the 8-game window: the previous season's last regular weeks, in order
          expect(prev).toEqual(priorReg.slice(-(8 - cur.length)));
          expect(prev.every((w) => w <= priorWeeks)).toBe(true);
        },
      ),
      { numRuns: 60 },
    );
  });

  it("the previous season's schedule not loaded: this season's games only, said so", () => {
    for (const season of SYNTHETIC_SEASONS) {
      const games = seasonOf(season, 18, 3);
      const { readers, lineReads } = spyReaders(games);
      const out = projectPlayers({
        targets: [target(games[0]?.home ?? "BUF")],
        season,
        weeks: [1],
        settings,
        readers,
        clock: fixedClock(firstKickoff(games, season) - DAY),
        rng: seededRng(1),
        n_sims: 1000,
      });
      expect(lineReads.some((r) => r.season === season - 1)).toBe(false);
      expect(
        out.result.projections[0]?.assumptions.some(
          (a) =>
            a.text ===
            `the ${String(season - 1)} schedule is not loaded: the trailing window holds ${String(season)} games only`,
        ),
      ).toBe(true);
    }
  });
});

describe("no game in a week: worded from game_type (§2.5)", () => {
  /** The no-game assumption a team's player gets for `week`. */
  const noGame = (games: readonly NflGame[], season: number, week: number, team: NflTeam) => {
    const { readers } = spyReaders(games);
    const out = projectPlayers({
      targets: [target(team)],
      season,
      weeks: [week],
      settings,
      readers,
      clock: fixedClock(firstKickoff(games, season) - DAY),
      rng: seededRng(1),
      n_sims: 1000,
    });
    const p = out.result.projections[0];
    expect(p?.weeks[0]?.points.mean).toBe(0);
    return (p?.assumptions ?? []).map((a) => a.text);
  };

  it("a regular-season bye is a bye; a postseason week is never one, in 18, 19 and 20-week seasons", () => {
    for (const season of SYNTHETIC_SEASONS) {
      for (const weeks of [18, 19, 20] as const) {
        const games = seasonOf(season, weeks, season);
        const inWeek = (w: number) =>
          new Set(games.filter((g) => g.week === w).flatMap((g) => [g.home, g.away]));
        // a bye in the regular season
        const byeWeek = [5, 6, 7, 8].find((w) => inWeek(w).size < 32) ?? 5;
        const byeTeam = games.map((g) => g.home).find((t) => !inWeek(byeWeek).has(t)) ?? "BUF";
        expect(noGame(games, season, byeWeek, byeTeam)).toContain(
          `bye in week ${String(byeWeek)}: zero points`,
        );
        // the wild-card round: a team not in it is out of that round, never on a bye
        const wc = weeks + 1;
        expect(games.some((g) => g.week === wc && g.game_type === "WC")).toBe(true);
        const out = games.map((g) => g.home).find((t) => !inWeek(wc).has(t)) ?? "BUF";
        const texts = noGame(games, season, wc, out);
        expect(texts).toContain(
          `no wild-card game for the team in week ${String(wc)}: zero points`,
        );
        expect(texts.some((t) => t.startsWith("bye in week"))).toBe(false);
        // past the Super Bowl: the season is over
        const last = Math.max(...games.map((g) => g.week));
        expect(noGame(games, season, last + 1, out)).toContain(
          `no game in week ${String(last + 1)}: the ${String(season)} season ended in week ${String(last)}`,
        );
        // the postseason not scheduled yet: "no game scheduled", waiting on the pairings
        const regOnly = games.filter((g) => g.game_type === "REG");
        const pending = noGame(regOnly, season, wc, out);
        expect(pending).toContain(`no game scheduled in week ${String(wc)}: zero points`);
      }
    }
  });
});

describe("the K/DEF look-ahead ends at the season's own last week (§2.6)", () => {
  /** The last week the engine projected (the injury report is read up to it). */
  const lastProjected = (games: readonly NflGame[], season: number, week: number): number => {
    const { readers, injuryWeeks } = spyReaders(games);
    const team = games.find((g) => g.season === season && g.week === week)?.home ?? "BUF";
    const weekStart = Math.min(
      ...games
        .filter((g) => g.season === season && g.week === week)
        .map((g) => Date.parse(g.kickoff ?? "")),
    );
    const k = target(team, "K");
    analyzeKdef({
      positions: ["K"],
      season,
      week,
      look_ahead: 2,
      universe: [
        {
          player_key: k.player_key ?? "",
          subject: k.subject,
          name: k.name,
          position: "K",
          nfl_team: team,
          availability: "unknown",
        },
      ],
      current: [],
      availability_known: false,
      settings,
      readers,
      clock: fixedClock(weekStart - DAY),
      rng: seededRng(2),
    });
    return Math.max(...injuryWeeks);
  };

  it("a 20-week regular season: the wild-card week looks ahead to week 23; the last week looks at itself only", () => {
    for (const season of SYNTHETIC_SEASONS) {
      const games = seasonOf(season, 20, 11);
      const last = Math.max(...games.map((g) => g.week));
      expect(last).toBeGreaterThanOrEqual(23);
      expect(lastProjected(games, season, 21)).toBe(23);
      expect(lastProjected(games, season, last)).toBe(last);
    }
  });

  it("an 18-week season: the look-ahead never runs past the schedule's last week", () => {
    const games = seasonOf(2027, 18, 5);
    const last = Math.max(...games.map((g) => g.week));
    expect(lastProjected(games, 2027, last - 1)).toBe(last);
  });
});

describe("the base rates carry the reference registry's vintage (§2.7)", () => {
  it("the base rates' basis seasons come from the registry; the newest is its verified_through_season", () => {
    const v = REFERENCE_VINTAGES.analytics_base_rates;
    expect(BASE_RATES.vintage).toBe(v);
    expect(BASE_RATES.seasons).toBe(v.basis_seasons);
    const spans = Object.values(BASE_RATES.seasons);
    expect(Object.keys(BASE_RATES.seasons).sort()).toEqual([
      "correlation",
      "p_active",
      "position_cv",
    ]);
    for (const [from, to] of spans) expect(from).toBeLessThanOrEqual(to);
    expect(Math.max(...spans.map(([, to]) => to))).toBe(v.verified_through_season);
  });

  it("E1 names the vintage once the season in progress is past it and its grace — never before", () => {
    const v = REFERENCE_VINTAGES.analytics_base_rates;
    for (const season of SYNTHETIC_SEASONS) {
      const games = [...seasonOf(season - 1, 18, 1), ...seasonOf(season, 18, 1)];
      const { readers } = spyReaders(games);
      const out = projectPlayers({
        targets: [target(games.find((g) => g.season === season)?.home ?? "BUF")],
        season,
        weeks: [1],
        settings,
        readers,
        clock: fixedClock(firstKickoff(games, season) - DAY),
        rng: seededRng(1),
        n_sims: 1000,
      });
      const named = (out.result.projections[0]?.assumptions ?? []).some((a) =>
        a.text.includes(`base rates verified through ${String(v.verified_through_season)}`),
      );
      expect(named).toBe(season > v.verified_through_season + v.grace_seasons);
    }
  });
});
