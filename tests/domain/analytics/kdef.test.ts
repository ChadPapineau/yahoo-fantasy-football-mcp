// kdef.test.ts — E5 for positions ⊆ {K, DEF} (plan 07 E5 P0 + the manual-league block, OBJ-29):
// the nflverse universe ranked with availability "unknown" said plainly, FA-pool filtering when a
// platform pool exists, hold-vs-stream against my starter, the look-ahead, and the refusals.
import { beforeAll, describe, expect, it } from "vitest";
import {
  analyzeKdef,
  type KdefCandidateInput,
  type KdefRequest,
} from "../../../src/domain/analytics/kdef.js";
import { LIMITS } from "../../../src/domain/analytics/constants.js";
import { fixedClock, seededRng } from "../../../src/domain/clock.js";
import type { ScoringSettings } from "../../../src/domain/scoring/types.js";
import {
  type FixtureData,
  fixtureReaders,
  loadFixtureData,
} from "../../backtest/helpers/fixture.js";
import { beforeWeek, fixtureLeague, kdefUniverse } from "../../backtest/helpers/league.js";

let data: FixtureData;
let settings: ScoringSettings;
let universe: KdefCandidateInput[];

beforeAll(async () => {
  data = await loadFixtureData();
  settings = (await fixtureLeague()).settings;
  universe = kdefUniverse(data);
});

const req = (over: Partial<KdefRequest> = {}): KdefRequest => ({
  positions: ["K", "DEF"],
  season: 2026,
  week: 3,
  universe,
  current: [],
  availability_known: false,
  settings,
  readers: fixtureReaders(data),
  clock: fixedClock(beforeWeek(data, 3)),
  rng: seededRng(5),
  ...over,
});

describe("analyzeKdef", () => {
  it("manual league: ranks the universe, availability unknown and said so", () => {
    const out = analyzeKdef(req());
    const c = out.analysis.candidates;
    expect(out.availability_known).toBe(false);
    expect(c.filter((x) => x.position === "K")).toHaveLength(10);
    expect(c.filter((x) => x.position === "DEF")).toHaveLength(10);
    for (const x of c) {
      expect(x.availability).toBe("unknown");
      expect(x.competition).toBeNull();
      expect(x.bid).toBeNull();
      expect(x.drop).toBeNull();
      expect(x.kdef?.implied_total).not.toBeNull();
      expect(x.kdef?.next_week?.e).not.toBeNull();
      expect(x.marginal_value.basis).toBe("position_cv");
      expect(x.weeks_of_value).toBeNull();
      expect(x.signals.map((s) => s.kind)).toContain("stream");
    }
    const k = c.filter((x) => x.position === "K").map((x) => x.marginal_value.mean);
    expect([...k].sort((a, b) => b - a)).toEqual(k);
    const def = c.find((x) => x.position === "DEF");
    expect(def?.kdef?.sacks_e).not.toBeNull();
    expect(def?.kdef?.takeaways_e).not.toBeNull();
    expect(def?.kdef?.rare_c).toBeGreaterThan(0);
    expect(def?.nfl_team).not.toBeNull();
    expect(
      out.analysis.rec.assumptions.some((a) => a.text.startsWith("availability unknown")),
    ).toBe(true);
    expect(out.analysis.hold_vs_stream).toBeNull();
    expect(out.analysis.rec.no_move).toBe(false);
    expect(out.analysis.rec.action.startsWith("stream ")).toBe(true);
    expect(out.analysis.rec.subjects[0]?.role).toBe("stream");
  });

  it("with a platform pool: taken candidates drop out, FA/W keep their label", () => {
    const labels: KdefCandidateInput["availability"][] = ["T", "FA", "W"];
    const labelled = universe.map((u, i): KdefCandidateInput => ({
      ...u,
      availability: labels[i % 3] ?? "FA",
    }));
    const out = analyzeKdef(req({ universe: labelled, availability_known: true }));
    expect(out.availability_known).toBe(true);
    expect(out.analysis.candidates.some((c) => c.availability === "T")).toBe(false);
    expect(out.analysis.candidates.some((c) => c.availability === "FA")).toBe(true);
    expect(
      out.analysis.rec.assumptions.some((a) => a.text.startsWith("availability unknown")),
    ).toBe(false);
  });

  it("hold vs stream against my current starter", () => {
    const first = analyzeKdef(req({ positions: ["DEF"] }));
    const top = first.analysis.candidates[0];
    const mine = universe.find((u) => u.player_key === top?.player_key);
    if (mine === undefined) throw new Error("no top DEF");
    const held = analyzeKdef(req({ positions: ["DEF"], current: [mine] }));
    expect(held.analysis.candidates.some((c) => c.player_key === mine.player_key)).toBe(false);
    expect(held.analysis.hold_vs_stream).not.toBeNull();
    expect(held.analysis.rec.no_move).toBe(true);
    expect(held.analysis.rec.action).toBe("hold the current DEF");
    expect(held.analysis.rec.subjects[0]).toMatchObject({
      player_key: mine.player_key,
      role: "start",
    });
    expect(held.analysis.candidates.every((c) => c.weeks_of_value !== null)).toBe(true);
    // a weak starter gets streamed over, with a drop subject and a positive marginal value
    const worst = first.analysis.candidates.at(-1);
    const weak = universe.find((u) => u.player_key === worst?.player_key);
    if (weak === undefined) throw new Error("no weak DEF");
    const streamed = analyzeKdef(req({ positions: ["DEF"], current: [weak] }));
    expect(streamed.analysis.hold_vs_stream?.current_starter_delta).toBeGreaterThan(0);
    expect(streamed.analysis.hold_vs_stream?.streamability).toBeGreaterThan(1);
    expect(streamed.analysis.candidates[0]?.marginal_value.mean).toBeGreaterThan(0);
    expect(streamed.analysis.rec.subjects.map((s) => s.role)).toEqual(["stream", "drop"]);
    expect(streamed.analysis.rec.latest_execution_time).not.toBeNull();
  });

  it("look_ahead 0 drops next_week; deterministic for a seed", () => {
    const a = analyzeKdef(req({ look_ahead: 0, positions: ["K"] }));
    expect(a.analysis.candidates.every((c) => c.kdef?.next_week === null)).toBe(true);
    expect(analyzeKdef(req({ look_ahead: 0, positions: ["K"] }))).toEqual(a);
  });

  it("refuses positions outside {K, DEF}, bad look_ahead, n_sims and oversized universes", () => {
    for (const over of [
      { positions: ["WR"] },
      { positions: [] },
      { positions: ["K", "__proto__"] },
      { look_ahead: 3 },
      { look_ahead: -1 },
      { look_ahead: 1.5 },
      { n_sims: 50 },
      { universe: [...universe, ...universe] },
    ] as Partial<KdefRequest>[]) {
      expect(() => analyzeKdef(req(over))).toThrow(
        expect.objectContaining({ code: "invalid_request" }),
      );
    }
  });

  it("the whole universe plus my own K and DEF is ranked, not refused (E1's 64-target bound)", () => {
    // 32 defences + 32 kickers is exactly E1's LIMITS.maxTargets; my roster's K/DEF (keys the
    // universe does not hold — the manual league keys them per team) pushed the ranking pass past
    // it and every served ff_analyze_waivers call on the real roster_weekly was VALIDATION
    expect(universe.length).toBe(LIMITS.maxTargets);
    const k = universe.find((u) => u.position === "K");
    const d = universe.find((u) => u.position === "DEF");
    if (k === undefined || d === undefined) throw new Error("fixture universe");
    const current: KdefCandidateInput[] = [
      { ...k, player_key: "mine.k", availability: "T" },
      { ...d, player_key: "mine.def", availability: "T" },
    ];
    expect(universe.length + current.length).toBeGreaterThan(LIMITS.maxTargets);
    expect(universe.length + current.length).toBeLessThanOrEqual(LIMITS.maxKdefCandidates);
    const out = analyzeKdef(req({ current }));
    expect(out.analysis.candidates.filter((c) => c.position === "K")).toHaveLength(10);
    expect(out.analysis.candidates.filter((c) => c.position === "DEF")).toHaveLength(10);
    expect(out.analysis.hold_vs_stream).not.toBeNull();
  });

  it("an empty universe yields no candidates and an honest no-move rec", () => {
    const out = analyzeKdef(req({ universe: [] }));
    expect(out.analysis.candidates).toEqual([]);
    expect(out.analysis.rec.no_move).toBe(true);
    expect(out.analysis.rec.subjects).toEqual([]);
    expect(out.analysis.rec.distribution.p_zero).toBe(1);
  });
});
