// kdef-missing-lines.test.ts — QA-2-044: K/DEF are dominated by the implied totals (research 05
// §8), so a decision-week game without a betting line (not published yet, taken off the board, or
// omitted as stale) is a missing driver. Plan 07 §2: it is named in rec.assumptions, never silently
// omitted, and the ranking — trailing points only — is never presented as a decisive stream over a
// starter who plays. A starter who cannot score this week (a bye, ruled out) is an empty slot: it
// is filled either way, with the missing lines named.
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import {
  analyzeKdef,
  type KdefCandidateInput,
  type KdefPosition,
} from "../../../src/domain/analytics/kdef.js";
import type { ProjectionReaders } from "../../../src/domain/analytics/projection.js";
import type { InjuryReport, NflGame, WaiverAnalysis } from "../../../src/domain/analytics/types.js";
import { fixedClock, seededRng } from "../../../src/domain/clock.js";
import type { ScoringSettings } from "../../../src/domain/scoring/types.js";
import {
  type FixtureData,
  fixtureReaders,
  loadFixtureData,
} from "../../backtest/helpers/fixture.js";
import { fixtureLeague, kdefUniverse } from "../../backtest/helpers/league.js";
import { recTextsFit } from "./helpers.js";

let data: FixtureData;
let settings: ScoringSettings;
let universe: KdefCandidateInput[];

beforeAll(async () => {
  data = await loadFixtureData();
  settings = (await fixtureLeague()).settings;
  universe = kdefUniverse(data);
});

interface Case {
  readonly label: string;
  readonly position: KdefPosition;
  readonly week: number;
  readonly now: string;
  /** My starter: he plays, yet streaming over him is decisive while the lines are there. */
  readonly starter: () => KdefCandidateInput;
}

const CASES: readonly Case[] = [
  {
    // Boswell (PIT) is Doubtful on the week-4 report: a few tenths of a point
    label: "K, week 4",
    position: "K",
    week: 4,
    now: "2026-09-30T12:00:00.000Z",
    starter: () => mine("K", "PIT"),
  },
  {
    // MIA's defence hosts CIN with CIN's implied total set to 48
    label: "DEF, week 5",
    position: "DEF",
    week: 5,
    now: "2026-10-06T12:00:00.000Z",
    starter: () => mine("DEF", "MIA"),
  },
];

function mine(position: KdefPosition, team: string): KdefCandidateInput {
  const u = universe.find((x) => x.position === position && x.nfl_team === team);
  if (u === undefined) throw new Error("fixture: starter not found");
  return { ...u, availability: "T", slot_class: "starter" };
}

/**
 * Fresh fixture readers (the schedules release checked an hour before `now`) whose games in
 * `dropLines` have no betting line; Boswell is Doubtful in week 4 and CIN's week-5 implied total
 * at MIA is 48.
 */
function readers(now: string, dropLines: ReadonlySet<string>): ProjectionReaders {
  const r = fixtureReaders(data);
  const at = new Date(Date.parse(now) - 3600 * 1000).toISOString();
  const edit = (g: NflGame): NflGame => {
    if (dropLines.has(g.game_id)) return { ...g, lines: null };
    if (g.week === 5 && g.home === "MIA" && g.lines !== null) {
      return { ...g, lines: { ...g.lines, implied: { away: 48, home: 10 } } };
    }
    return g;
  };
  return {
    ...r,
    schedules: {
      ...r.schedules,
      games: (season, weeks) => {
        const g = r.schedules.games(season, weeks);
        return g.stamp === null
          ? g
          : { rows: g.rows.map(edit), stamp: { ...g.stamp, fetched_at: at, checked_at: at } };
      },
    },
    injuries: {
      reports: (season, week, ids) => {
        const g = r.injuries.reports(season, week, ids);
        if (g.stamp === null || season !== 2026 || week !== 4) return g;
        const doubtful: InjuryReport = {
          gsis_id: "00-0031136",
          season: 2026,
          week: 4,
          nfl_team: "PIT",
          report_status: "Doubtful",
          practice: [],
          primary_injury: "Hip",
          secondary_injury: null,
          as_of: g.stamp.as_of,
        };
        const want = ids === null || ids.includes(doubtful.gsis_id);
        return { rows: want ? [...g.rows, doubtful] : g.rows, stamp: g.stamp };
      },
    },
  };
}

const run = (
  c: Case,
  dropLines: ReadonlySet<string>,
  current: KdefCandidateInput[] = [c.starter()],
): WaiverAnalysis =>
  analyzeKdef({
    positions: [c.position],
    season: 2026,
    week: c.week,
    look_ahead: 0,
    universe,
    current,
    availability_known: false,
    settings,
    readers: readers(c.now, dropLines),
    clock: fixedClock(c.now),
    rng: seededRng(1),
  }).analysis;

const weekGames = (week: number): NflGame[] =>
  data.games.filter((g) => g.season === 2026 && g.week === week);
const gameOf = (week: number, team: string | null): NflGame | undefined =>
  weekGames(week).find((g) => g.home === team || g.away === team);
const texts = (a: WaiverAnalysis): string[] => a.rec.assumptions.map((x) => x.text);
const DOMINATED = "K/DEF are dominated by this week's implied totals";
const market = (a: WaiverAnalysis, key: string, pos: KdefPosition): number | null | undefined => {
  const k = a.candidates.find((x) => x.player_key === key)?.kdef;
  return pos === "DEF" ? k?.opp_implied_total : k?.implied_total;
};
const streamed = (a: WaiverAnalysis): string | null =>
  a.rec.subjects.find((s) => s.role === "stream")?.player_key ?? null;

describe("QA-2-044 — no betting lines for the decision week", () => {
  it("control: with the lines, streaming over the starter is decisive", () => {
    for (const c of CASES) {
      const a = run(c, new Set());
      expect(a.rec.no_move, c.label).toBe(false);
      expect(texts(a).some((t) => t.startsWith(DOMINATED))).toBe(true);
      expect(texts(a).some((t) => t.includes("no betting line"))).toBe(false);
    }
  });

  it("every decision-week line missing: named, and no stream is called over the starter", () => {
    for (const c of CASES) {
      const all = new Set(weekGames(c.week).map((g) => g.game_id));
      const a = run(c, all);
      expect(a.rec.no_move, c.label).toBe(true);
      expect(a.rec.subjects.every((s) => s.role === "start")).toBe(true);
      expect(a.rec.point_estimate, `${c.label}: the starter plays`).toBeGreaterThan(0);
      expect(
        texts(a).some((t) => t.startsWith(`no betting lines for week ${String(c.week)}`)),
      ).toBe(true);
      // the assumption that the call rests on this week's implied totals is not made
      expect(texts(a).some((t) => t.startsWith(DOMINATED))).toBe(false);
      for (const cand of a.candidates) expect(market(a, cand.player_key, c.position)).toBeNull();
      expect(recTextsFit(a.rec)).toBe(true);
    }
  });

  it("a starter who cannot score is an empty slot: filled without lines (absent or stale), named", () => {
    const def5 = CASES.find((c) => c.position === "DEF");
    if (def5 === undefined) throw new Error("no DEF case");
    const bye: Case = { ...def5, starter: () => mine("DEF", "KC") }; // KC: week-5 bye
    const all = new Set(weekGames(5).map((g) => g.game_id));
    const a = run(bye, all);
    expect(a.rec.no_move).toBe(false);
    expect(a.rec.subjects.map((s) => s.role)).toEqual(["stream", "drop"]);
    expect(texts(a).some((t) => t.startsWith("no betting lines for week 5"))).toBe(true);
    // the same with lines omitted as stale (the release last checked a week earlier, QA-1-004)
    const stale = analyzeKdef({
      positions: ["DEF"],
      season: 2026,
      week: 5,
      look_ahead: 0,
      universe,
      current: [mine("DEF", "KC")],
      availability_known: false,
      settings,
      readers: fixtureReaders(data),
      clock: fixedClock(bye.now),
      rng: seededRng(1),
    }).analysis;
    expect(stale.rec.no_move).toBe(false);
    expect(stale.rec.assumptions.some((x) => x.text.startsWith("betting lines omitted"))).toBe(
      true,
    );
    expect(texts(stale).some((t) => t.startsWith("no betting lines for week 5"))).toBe(true);
  });

  it("an empty slot is still filled, with the missing lines named", () => {
    for (const c of CASES) {
      const all = new Set(weekGames(c.week).map((g) => g.game_id));
      const a = run(c, all, []);
      expect(a.rec.no_move, c.label).toBe(false);
      expect(streamed(a)).not.toBeNull();
      expect(
        texts(a).some((t) => t.startsWith(`no betting lines for week ${String(c.week)}`)),
      ).toBe(true);
    }
  });

  it("the control's stream loses its line: it is not called, and its game is named", () => {
    for (const c of CASES) {
      const pick = streamed(run(c, new Set()));
      const team = universe.find((u) => u.player_key === pick)?.nfl_team ?? null;
      const g = gameOf(c.week, team);
      if (pick === null || g === undefined) throw new Error("control picked nothing");
      const a = run(c, new Set([g.game_id]));
      expect(streamed(a), c.label).not.toBe(pick);
      const named = texts(a).find((t) => t.startsWith("no betting line for 1 of week"));
      expect(named).toContain(g.home);
      expect(named).toContain(g.away);
      expect(recTextsFit(a.rec)).toBe(true);
    }
  });

  it("property: whichever games lose their lines, a stream over a starter has its line, and every unpriced game is named", () => {
    for (const c of CASES) {
      const ids = weekGames(c.week).map((g) => g.game_id);
      fc.assert(
        fc.property(fc.subarray(ids, { minLength: 1 }), (drop) => {
          const gone = new Set(drop);
          const a = run(c, gone);
          const s = streamed(a);
          if (s !== null) {
            expect(market(a, s, c.position)).not.toBeNull();
            const team = universe.find((u) => u.player_key === s)?.nfl_team ?? null;
            expect(gone.has(gameOf(c.week, team)?.game_id ?? "")).toBe(false);
          }
          const t = texts(a);
          if (gone.size === ids.length) {
            expect(t.some((x) => x.startsWith(`no betting lines for week ${String(c.week)}`))).toBe(
              true,
            );
          } else {
            const named = t.find((x) =>
              x.startsWith(`no betting line for ${String(gone.size)} of week ${String(c.week)}'s`),
            );
            expect(named).toBeDefined();
            expect(t.some((x) => x.startsWith(DOMINATED))).toBe(true);
          }
          expect(recTextsFit(a.rec)).toBe(true);
        }),
        { numRuns: 6, seed: 44 },
      );
    }
  });
});
