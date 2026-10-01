// trailing-window.test.ts — QA-1-012: the v1 trailing window ends at the latest played week, not at
// the target week. With weeks 1–3 played, a projection for week 12 reads the same three games (and
// the same prior-season fill) as one for week 4 — games already played are never discarded, so a
// star is not flattened to the positional prior because the target is far away. A week with no game
// scheduled at all (the postseason before its pairings exist) is "no game scheduled", never a bye.
import { beforeAll, describe, expect, it } from "vitest";
import {
  projectPlayers,
  type ProjectionRequest,
  type ProjectionTarget,
} from "../../../src/domain/analytics/projection.js";
import { fixedClock, seededRng } from "../../../src/domain/clock.js";
import type { ScoringSettings } from "../../../src/domain/scoring/types.js";
import {
  type FixtureData,
  fixtureReaders,
  loadFixtureData,
} from "../../backtest/helpers/fixture.js";
import { beforeWeek, fixtureLeague, TEAM_A, targetsFor } from "../../backtest/helpers/league.js";

let data: FixtureData;
let settings: ScoringSettings;
let targets: ProjectionTarget[];

beforeAll(async () => {
  data = await loadFixtureData();
  const lg = await fixtureLeague();
  settings = lg.settings;
  const entries = (await lg.provider.getRoster(TEAM_A, 3)).value.entries;
  targets = targetsFor(entries).filter((t) => t.subject.kind === "player");
});

const req = (weeks: number[], over: Partial<ProjectionRequest> = {}): ProjectionRequest => ({
  targets,
  season: 2026,
  weeks,
  settings,
  readers: fixtureReaders(data),
  clock: fixedClock(beforeWeek(data, 4)), // weeks 1–3 final
  rng: seededRng(7),
  n_sims: 1000,
  ...over,
});

const trailing = (p: { drivers: readonly { name: string; contribution: number }[] }) =>
  p.drivers.find((d) => d.name === "trailing_mean")?.contribution ?? null;

describe("QA-1-012 — the trailing window is anchored on the latest played week", () => {
  it("weeks 5–17 read the same trailing games as week 4 (role games, trailing base, no prior fallback)", () => {
    const w4 = projectPlayers(req([4])).result.projections;
    for (const week of [5, 8, 11, 12, 17]) {
      const far = projectPlayers(req([week])).result.projections;
      far.forEach((p, i) => {
        const near = w4[i];
        expect(p.player_key).toBe(near?.player_key);
        expect(p.role_confidence_games).toBe(near?.role_confidence_games);
        if (p.weeks[0]?.p_active !== 0 && trailing(p) !== null) {
          expect(trailing(p)).toBe(near === undefined ? null : trailing(near));
        }
        if ((near?.role_confidence_games ?? 0) > 0) {
          expect(p.assumptions.some((a) => a.text.startsWith("no trailing games"))).toBe(false);
        }
      });
    }
  });

  it("a played-week line is never read for a target at or before it (backtests unchanged)", () => {
    // projecting week 2 after the whole fixture has been played still reads week 1 only
    const late = fixedClock(Date.parse("2026-12-01T12:00:00Z"));
    const a = projectPlayers(req([2], { clock: late })).result.projections;
    const b = projectPlayers(req([2], { clock: fixedClock(beforeWeek(data, 2)) })).result
      .projections;
    expect(a.map((p) => [p.role_confidence_games, trailing(p)])).toEqual(
      b.map((p) => [p.role_confidence_games, trailing(p)]),
    );
  });

  it("week 19 (no game scheduled yet) says so — it is not a bye", () => {
    const out = projectPlayers(req([19])).result.projections;
    for (const p of out) {
      expect(p.weeks[0]?.points.mean).toBe(0);
      expect(p.assumptions.some((a) => a.text.startsWith("bye in week"))).toBe(false);
      expect(p.assumptions.some((a) => a.text.startsWith("no game scheduled in week 19"))).toBe(
        true,
      );
    }
  });

  it("a real bye in the regular season is still a bye", () => {
    const byeTeams = new Set(
      ["2026:5", "2026:6", "2026:7"].flatMap((k) => {
        const [s, w] = k.split(":").map(Number);
        const playing = new Set(
          data.games.filter((g) => g.season === s && g.week === w).flatMap((g) => [g.home, g.away]),
        );
        return targets
          .filter((t) => t.nfl_team !== null && !playing.has(t.nfl_team))
          .map((t) => `${String(w)}:${t.player_key ?? ""}`);
      }),
    );
    expect(byeTeams.size).toBeGreaterThan(0);
    for (const k of byeTeams) {
      const [w, key] = k.split(":", 2) as [string, string];
      const p = projectPlayers(
        req([Number(w)], { targets: targets.filter((t) => t.player_key === key.slice(0)) }),
      ).result.projections[0];
      expect(p?.assumptions.some((a) => a.text === `bye in week ${w}: zero points`)).toBe(true);
    }
  });
});
