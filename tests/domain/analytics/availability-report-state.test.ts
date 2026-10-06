// availability-report-state.test.ts — QA-2-034 and QA-1-021 (reopened): a report that does not
// exist yet is not a designation of no injury.
// - QA-2-034: a team's rows appear with its first PRACTICE report; designations only with its
//   game-status report, about two days later. A practice-only row (no designation yet) is not
//   "cleared to play": until the game-status report is out, the newest designation is carried (a
//   Questionable refined by the newest practice level).
// - QA-1-021 reopened: a look-ahead week (no report of its own) carries the newest designation too —
//   not only the week right after it — for INJURY_REPORT.carryWeeks weeks; past that, availability
//   is unknown (p null, named), never "cleared".
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { pActive, reportStates } from "../../../src/domain/analytics/availability.js";
import { INJURY_REPORT, P_ACTIVE } from "../../../src/domain/analytics/constants.js";
import {
  projectPlayers,
  type ProjectionReaders,
  type ProjectionTarget,
} from "../../../src/domain/analytics/projection.js";
import type { InjuryReport } from "../../../src/domain/analytics/types.js";
import { fixedClock, seededRng } from "../../../src/domain/clock.js";
import type { NflTeam } from "../../../src/config/schema.js";
import { easternDate } from "../../../src/domain/league/schedule.js";
import type { ScoringSettings } from "../../../src/domain/scoring/types.js";
import {
  type FixtureData,
  fixtureReaders,
  loadFixtureData,
} from "../../backtest/helpers/fixture.js";
import { beforeWeek, fixtureLeague } from "../../backtest/helpers/league.js";

let data: FixtureData;
let settings: ScoringSettings;
beforeAll(async () => {
  data = await loadFixtureData();
  settings = (await fixtureLeague()).settings;
});

const DNP = "Did Not Participate In Practice";
const LP = "Limited Participation in Practice";
const FP = "Full Participation in Practice";
const LEVEL = { [DNP]: "dnp", [LP]: "limited", [FP]: "full" } as const;
const KO = Date.parse("2026-10-11T17:00:00Z");

const row = (week: number, status: string | null, practice: string | null): InjuryReport => ({
  gsis_id: "00-0012345",
  season: 2026,
  week,
  nfl_team: "HOU",
  report_status: status,
  practice: practice === null ? [] : [{ day: "week", status: practice }],
  primary_injury: "Hamstring",
  secondary_injury: null,
  as_of: "2026-10-08T13:00:00Z",
});
const base = {
  injuriesLoaded: true,
  platformStatus: null,
  kickoffMs: KO,
  nowMs: KO - 3 * 86_400_000,
};

/** What the carried designation is worth (a Questionable refined by the newest practice level). */
function carried(status: string, priorPractice: string | null, newest: string | null): number {
  if (status === "Out") return P_ACTIVE.out;
  if (status === "Doubtful") return P_ACTIVE.doubtful;
  const lvl = newest ?? priorPractice;
  return lvl === null
    ? P_ACTIVE.questionable
    : P_ACTIVE.questionableByPractice[LEVEL[lvl as keyof typeof LEVEL]];
}

describe("QA-2-034 — pActive: a practice-only row is not a clean bill of health", () => {
  const designations = fc.constantFrom("Out", "Doubtful", "Questionable");
  const practice = fc.constantFrom(DNP, LP, FP, null);

  it("property: before the game-status report, the newest designation is carried (never p 1)", () => {
    fc.assert(
      fc.property(
        designations,
        practice,
        practice,
        fc.constantFrom(null, ""),
        fc.integer({ min: 1, max: 6 }),
        (status, priorPractice, nowPractice, empty, age) => {
          const week = 3 + age;
          const prior = row(3, status, priorPractice);
          const thisWeek = row(week, empty, nowPractice);
          const a = pActive({
            ...base,
            report: thisWeek,
            reportPublished: true,
            reportFinal: false,
            priorPublished: true,
            priorReport: prior,
            week,
          });
          if (age > INJURY_REPORT.carryWeeks) {
            expect(a).toEqual({ p: null, basis: "none", expired_from: 3 });
          } else {
            expect(a.carried_from).toBe(3);
            expect(a.p).toBe(carried(status, priorPractice, nowPractice));
          }
          expect(a.p).not.toBe(1);
          // the game-status report is out and does not designate him: cleared
          expect(pActive({ ...base, report: thisWeek, reportFinal: true, week })).toEqual({
            p: 1,
            basis: "designation_base_rate",
          });
        },
      ),
      { numRuns: 300, seed: 34 },
    );
  });

  it("not designated on the last game-status report: active, and a pending designation is flagged", () => {
    for (const prior of [null, row(3, null, FP), row(3, "", LP)]) {
      const common = {
        ...base,
        reportFinal: false,
        priorPublished: true,
        priorReport: prior,
        week: 4,
      };
      expect(pActive({ ...common, report: row(4, null, DNP) })).toEqual({
        p: 1,
        basis: "designation_base_rate",
        designation_pending: true,
      });
      expect(pActive({ ...common, report: null })).toEqual({
        p: 1,
        basis: "designation_base_rate",
      });
    }
  });

  it("a designation on this week's row always wins, final or not", () => {
    for (const reportFinal of [true, false]) {
      expect(
        pActive({
          ...base,
          report: row(4, "Out", DNP),
          reportFinal,
          priorPublished: true,
          priorReport: row(3, null, FP),
        }),
      ).toEqual({ p: 0, basis: "designation_base_rate" });
    }
  });

  it("without reportFinal the old contract holds (a listed row or a published report clears)", () => {
    expect(
      pActive({
        ...base,
        report: row(4, null, DNP),
        reportPublished: true,
        priorPublished: true,
        priorReport: row(3, "Out", DNP),
      }),
    ).toEqual({ p: 1, basis: "designation_base_rate" });
  });
});

describe("QA-2-034 — reportStates: practice report vs game-status report", () => {
  const reports = (week: number): InjuryReport[] =>
    data.injuries.filter((r) => r.season === 2026 && r.week === week);
  const games = (week: number) => data.games.filter((g) => g.season === 2026 && g.week === week);
  const STAMP = Date.parse("2026-09-30T13:36:25.000Z"); // the fixture's injuries release
  const teamsPlaying = (week: number): NflTeam[] =>
    [...new Set(games(week).flatMap((g) => [g.home, g.away]))].sort();
  const kickoffOf = (week: number, t: NflTeam): number =>
    Date.parse(games(week).find((g) => g.home === t || g.away === t)?.kickoff ?? "");

  it("weeks 1–3 (final reports): every team is final, the teams that designated nobody included", () => {
    for (const w of [1, 2, 3]) {
      const s = reportStates(reports(w), games(w), 2026, w, STAMP);
      for (const t of teamsPlaying(w)) expect(s.get(t), `week ${String(w)} ${t}`).toBe("final");
    }
  });

  it("week 4 at the fixture's release: PIT and CLE have a practice report only; the rest none", () => {
    const s = reportStates(reports(4), games(4), 2026, 4, STAMP);
    for (const t of teamsPlaying(4)) {
      expect(s.get(t), t).toBe(t === "PIT" || t === "CLE" ? "practice" : "none");
    }
  });

  it("property: one designation finalises every team playing on its Eastern date or earlier, no later one", () => {
    const teams = teamsPlaying(4);
    fc.assert(
      fc.property(fc.constantFrom(...teams), (t) => {
        const extra: InjuryReport = {
          ...row(4, "Questionable", LP),
          gsis_id: "00-0099999",
          nfl_team: t,
        };
        const s = reportStates([...reports(4), extra], games(4), 2026, 4, STAMP);
        const day = easternDate(kickoffOf(4, t));
        for (const u of teams) {
          const expected = easternDate(kickoffOf(4, u)) <= day;
          expect(s.get(u) === "final", `${t} designated → ${u}`).toBe(expected);
        }
      }),
      { numRuns: teams.length, seed: 4 },
    );
  });

  it("property: a release built at most 24 h before a team's kickoff carries its game-status report", () => {
    const teams = teamsPlaying(4);
    fc.assert(
      fc.property(
        fc.constantFrom(...teams),
        fc.integer({ min: -3_600_000, max: 3_600_000 }),
        (t, d) => {
          const asOf = kickoffOf(4, t) - INJURY_REPORT.gameStatusLeadMs + d;
          const s = reportStates(reports(4), games(4), 2026, 4, asOf);
          const was = t === "PIT" || t === "CLE" ? "practice" : "none";
          expect(s.get(t)).toBe(d >= 0 ? "final" : was);
        },
      ),
      { numRuns: 60, seed: 24 },
    );
  });
});

// --- E1 on the fixture ------------------------------------------------------------------------------

/** Fixture readers with extra week rows and/or the injuries release stamped at `asOf`. */
function readers(extra: readonly InjuryReport[] = [], asOf?: string): ProjectionReaders {
  const r = fixtureReaders(data);
  return {
    ...r,
    injuries: {
      reports: (season, week, ids) => {
        const got = r.injuries.reports(season, week, ids);
        if (got.stamp === null) return got;
        const more = extra.filter(
          (x) =>
            x.season === season && x.week === week && (ids === null || ids.includes(x.gsis_id)),
        );
        return {
          rows: [...got.rows, ...more],
          stamp: asOf === undefined ? got.stamp : { ...got.stamp, as_of: asOf },
        };
      },
    },
  };
}

const target = (gsis: string, team: NflTeam, position: string): ProjectionTarget => ({
  player_key: `manual.p.${gsis}`,
  subject: { kind: "player", gsis_id: gsis },
  name: gsis,
  position,
  nfl_team: team,
  platform_status: null, // the manual user typed no status
});

/** Week 3 designated, week 4 on PIT/CLE's practice report only (Thursday game): the expected carry. */
const ON_PRACTICE_REPORT = [
  { t: target("00-0036139", "PIT", "RB"), p: P_ACTIVE.out }, // Rico Dowdle: Out (toe), DNP
  { t: target("00-0036953", "CLE", "WR"), p: P_ACTIVE.out }, // Out, then limited
  { t: target("00-0036282", "CLE", "WR"), p: P_ACTIVE.questionableByPractice.limited },
  { t: target("00-0039167", "PIT", "WR"), p: P_ACTIVE.questionableByPractice.full },
];
const T0 = Date.parse("2026-09-30T18:00:00.000Z"); // Wed 14:00 ET; PIT@CLE kicks off Thu 20:15 ET

const project = (targets: ProjectionTarget[], weeks: number[], now: number, r = readers()) =>
  projectPlayers({
    targets,
    season: 2026,
    weeks,
    settings,
    readers: r,
    clock: fixedClock(now),
    rng: seededRng(1),
    n_sims: 1000,
  });

describe("QA-2-034 — E1: a practice-only row keeps the carried designation until game status", () => {
  it("Wednesday: every designated player on the practice report keeps his designation, said so", () => {
    for (const { t, p } of ON_PRACTICE_REPORT) {
      const out = project([t], [4], T0);
      const w = out.players[0]?.weeks[0];
      expect(w?.p_active, t.name).toBe(p);
      expect(w?.p_active).toBeLessThan(1);
      expect(
        out.result.projections[0]?.assumptions.some((a) =>
          a.text.startsWith(`week 4 game-status report not out yet for ${t.nfl_team ?? ""}`),
        ),
      ).toBe(true);
    }
  });

  it("once the game-status report is out (a designation seen, or a late enough release) with no designation for him: cleared", () => {
    const sunday: InjuryReport = {
      ...row(4, "Questionable", LP),
      gsis_id: "00-0099999",
      nfl_team: "BUF", // a Sunday team: Friday's reports are out, so Thursday's are too
    };
    const lateRelease = new Date(
      Date.parse("2026-10-02T00:15:00Z") - INJURY_REPORT.gameStatusLeadMs,
    ).toISOString();
    for (const r of [readers([sunday]), readers([], lateRelease)]) {
      for (const { t } of ON_PRACTICE_REPORT) {
        const out = project([t], [4], T0, r);
        expect(out.players[0]?.weeks[0]?.p_active, t.name).toBe(1);
        expect(out.result.projections[0]?.assumptions.some((a) => a.text.includes("carried"))).toBe(
          false,
        );
      }
    }
  });
});

describe("QA-1-021 (reopened) — look-ahead weeks carry the newest designation, then turn unknown", () => {
  const OUT_IN_WEEK_3 = [
    target("00-0036554", "HOU", "WR"), // Nico Collins: HOU has no week-4 report yet
    target("00-0036139", "PIT", "RB"), // Rico Dowdle: PIT has a practice report only
    target("00-0036953", "CLE", "WR"),
  ];
  const NOW = (): number => beforeWeek(data, 4) + 12 * 3600 * 1000;

  it("weeks 4–8 at once: carried (p 0) within the horizon, unknown (p null) after, never cleared", () => {
    for (const t of OUT_IN_WEEK_3) {
      const out = project([t], [4, 5, 6, 7, 8], NOW());
      const texts = out.result.projections[0]?.assumptions.map((a) => a.text) ?? [];
      const weeks = out.players[0]?.weeks ?? [];
      expect(weeks.filter((w) => w.game !== null).length).toBeGreaterThanOrEqual(4);
      for (const w of weeks) {
        const label = `${t.name} week ${String(w.week)}`;
        if (w.game === null) continue; // a bye: zero points whatever his availability
        if (w.week - 3 <= INJURY_REPORT.carryWeeks) {
          expect(w.p_active, label).toBe(0);
          expect(w.dist.mean, label).toBe(0);
          expect(
            texts.some(
              (x) =>
                x.startsWith(`week ${String(w.week)} `) &&
                x.includes("week 3 designation is carried"),
            ),
          ).toBe(true);
        } else {
          expect(w.p_active, label).toBeNull();
          expect(w.p_active_basis, label).toBe("none");
          expect(
            texts.some((x) => x.startsWith(`week ${String(w.week)} availability unknown`)),
          ).toBe(true);
        }
        expect(w.p_active === 1 && w.p_active_basis === "designation_base_rate", label).toBe(false);
      }
    }
  });

  it("a later week alone gives the same answer as inside a horizon (week 5 alone: carried)", () => {
    for (const t of OUT_IN_WEEK_3) {
      const w5 = project([t], [5], NOW()).players[0]?.weeks[0];
      expect(w5?.p_active, t.name).toBe(0);
      const w6 = project([t], [6], NOW()).players[0]?.weeks[0];
      expect(w6?.p_active, t.name).toBeNull();
    }
  });
});
