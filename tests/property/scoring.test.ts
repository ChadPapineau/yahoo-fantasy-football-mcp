// scoring.test.ts — plan 08 §7 property invariants P1–P14 (fast-check; plan 05 T2) over
// src/domain/scoring, plus research 05 §15's mutation tests (perturb a modifier; remove a bracket row).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { seededRng } from "../../src/domain/clock.js";
import { bracketize, deriveBrackets } from "../../src/domain/scoring/brackets.js";
import { applyPolicy, score, scoreSamples } from "../../src/domain/scoring/engine.js";
import { coerceScalar } from "../../src/domain/scoring/numeric.js";
import { makeStatLine } from "../../src/domain/scoring/nflverse.js";
import {
  normalizeSettings,
  type RuleDraft,
  type SettingsDraft,
} from "../../src/domain/scoring/settings.js";
import type { PositionType, StatLine } from "../../src/domain/scoring/types.js";
import { draftOf, lineOf, sampleSettings } from "../domain/scoring/fixtures.js";

const S = sampleSettings();
const O_STATS = [
  "pass_yd",
  "pass_td",
  "pass_int",
  "rush_att",
  "rush_yd",
  "rush_td",
  "targets",
  "rec",
  "rec_yd",
  "rec_td",
  "ret_td_off",
  "two_pt",
  "fum_lost",
  "off_fum_ret_td",
];
const K_STATS = ["fg_0_19", "fg_20_29", "fg_30_39", "fg_40_49", "fg_50p", "pat_made"];
const DT_STATS = [
  "dst_sack",
  "dst_int",
  "dst_fum_rec",
  "dst_td",
  "dst_safety",
  "dst_blk",
  "dst_ret_td",
  "dst_xpr",
];

/** Modifiers in [−10, 10] with 0–3 decimals (plan 08 P1 generator). */
const modifierArb = fc
  .integer({ min: -10_000, max: 10_000 })
  .chain((m) => fc.constantFrom(1, 10, 100, 1000).map((d) => Math.round((m / 1000) * d) / d));
const countArb = fc.integer({ min: 0, max: 600 });
/** A partial line over the given stats (a random present set). */
const valuesArb = (stats: readonly string[], v: fc.Arbitrary<number> = countArb) =>
  fc.dictionary(fc.constantFrom(...stats), v, { maxKeys: stats.length });

const close = (a: number, b: number, scale = 1): boolean =>
  Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(scale));

/** Linear-only settings over c_0..c_{n-1} (no brackets, no bonuses). */
const linearSettingsArb = fc.array(modifierArb, { minLength: 1, maxLength: 12 }).map((mods) =>
  normalizeSettings({
    platform: "manual",
    uses_fractional_points: true,
    uses_negative_points: true,
    rules: mods.map((m, i) => ({
      canonical: `c_${String(i)}`,
      platform_id: String(i),
      name: `Stat ${String(i)}`,
      position_types: ["O"],
      modifier: m,
    })),
  }),
);
const linearNames = Array.from({ length: 12 }, (_, i) => `c_${String(i)}`);

describe("plan 08 §7 properties", () => {
  it("P1 linearity in stats outside brackets/bonuses", () => {
    fc.assert(
      fc.property(
        linearSettingsArb,
        valuesArb(linearNames),
        valuesArb(linearNames),
        fc.integer({ min: -3, max: 3 }),
        fc.integer({ min: -3, max: 3 }),
        (s, x, y, a, b) => {
          const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
          const comb: Record<string, number> = {};
          for (const k of keys) comb[k] = a * (x[k] ?? 0) + b * (y[k] ?? 0);
          const xs: Record<string, number> = {};
          const ys: Record<string, number> = {};
          for (const k of keys) {
            xs[k] = x[k] ?? 0;
            ys[k] = y[k] ?? 0;
          }
          const lhs = score(lineOf("O", comb), s).points;
          const rhs = a * score(lineOf("O", xs), s).points + b * score(lineOf("O", ys), s).points;
          return close(lhs, rhs, 1e5);
        },
      ),
    );
  });

  it("P2 perturbing one modifier by δ moves the total by exactly δ × value (research 05 §15 mutation)", () => {
    const ids = S.rules
      .filter(
        (r) => r.modifier !== null && r.canonical !== null && !r.canonical.startsWith("dst_pa_"),
      )
      .map((r) => r.platform_id);
    fc.assert(
      fc.property(
        fc.constantFrom(...ids),
        fc.integer({ min: -5000, max: 5000 }).map((d) => d / 1000),
        valuesArb([...O_STATS, ...K_STATS, ...DT_STATS]),
        fc.constantFrom<PositionType>("O", "K", "DT"),
        (id, delta, values, pt) => {
          const rule = S.rules.find((r) => r.platform_id === id)!;
          const moved = sampleSettings({ modifiers: { [id]: rule.modifier! + delta } });
          const line = lineOf(pt, values);
          const applies =
            rule.position_types.includes(pt) && Object.hasOwn(values, rule.canonical!);
          const want = applies ? delta * values[rule.canonical!]! : 0;
          return close(score(line, moved).points - score(line, S).points, want, 1e4);
        },
      ),
    );
  });

  it("P3 bracketize sets exactly one member for any scalar; removing a row changes only its games", () => {
    const familyArb = fc
      .array(fc.integer({ min: 1, max: 20 }), { minLength: 1, maxLength: 8 })
      .map((widths) => {
        let lo = 0;
        const rules: RuleDraft[] = widths.map((w, i) => {
          const last = i === widths.length - 1;
          const r: RuleDraft = {
            canonical: last
              ? `dst_pa_${String(lo)}p`
              : `dst_pa_${String(lo)}_${String(lo + w - 1)}`,
            platform_id: `m${String(i)}`,
            name: `m${String(i)}`,
            position_types: ["DT"],
            modifier: i + 1,
          };
          lo += w;
          return r;
        });
        return rules;
      });
    fc.assert(
      fc.property(familyArb, fc.integer({ min: -50, max: 400 }), fc.nat(), (rules, x, pick) => {
        const draft: SettingsDraft = {
          platform: "manual",
          uses_fractional_points: true,
          uses_negative_points: true,
          rules,
        };
        const s = normalizeSettings(draft);
        const fam = s.brackets[0]!;
        const idx = bracketize(fam, x);
        const inside = fam.members.filter(
          (m) => m.lower <= x && (m.upper === null || x <= m.upper),
        );
        expect(inside.length <= 1).toBe(true);
        if (inside.length === 1) expect(fam.members[idx]).toBe(inside[0]);
        // "remove" a row from stat_modifiers → the member becomes display-only
        const removed = rules[pick % rules.length]!;
        const s2 = normalizeSettings({
          ...draft,
          rules: rules.map((r) => (r === removed ? { ...r, modifier: null } : r)),
        });
        const d =
          score(lineOf("DT", { dst_pa: x }), s).points -
          score(lineOf("DT", { dst_pa: x }), s2).points;
        const inRemoved = fam.members[idx]!.canonical === removed.canonical;
        return inRemoved ? d === removed.modifier : d === 0;
      }),
    );
  });

  it("P4 bonus monotonicity; E[bonus] from samples = P(stat ≥ target) × points", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            target: fc.integer({ min: 0, max: 300 }),
            points: fc.integer({ min: 1, max: 10 }),
          }),
          { minLength: 1, maxLength: 4 },
        ),
        fc.array(fc.integer({ min: 0, max: 400 }), { minLength: 1, maxLength: 60 }),
        (bonuses, yards) => {
          const s = sampleSettings({ bonuses: { "9": bonuses } });
          const sorted = [...yards].sort((a, b) => a - b);
          const pts = sorted.map((y) => score(lineOf("O", { rush_yd: y }), s).points);
          for (let i = 1; i < pts.length; i++) if (pts[i]! < pts[i - 1]!) return false;
          const r = scoreSamples(
            yards.map((y) => lineOf("O", { rush_yd: y })),
            s,
            "player_sim",
          );
          const linear = yards.reduce((a, y) => a + 0.1 * y, 0) / yards.length;
          const eBonus = bonuses.reduce(
            (a, b) => a + (yards.filter((y) => y >= b.target).length / yards.length) * b.points,
            0,
          );
          return close(r.mean_of_exact, linear + eBonus, 1e3);
        },
      ),
    );
  });

  it("P5 position-type gating: O stats never count under DT and vice versa", () => {
    fc.assert(
      fc.property(
        valuesArb(O_STATS, fc.integer({ min: 0, max: 50 })),
        valuesArb(DT_STATS, fc.integer({ min: 0, max: 5 })),
        (o, dt) => {
          const both = { ...o, ...dt };
          return (
            score(lineOf("O", both), S).points === score(lineOf("O", o), S).points &&
            score(lineOf("DT", both), S).points === score(lineOf("DT", dt), S).points &&
            score(lineOf("D", both), S).points === 0
          );
        },
      ),
    );
  });

  it("P6 unknown ids change no score: unmapped once in settings, ignored in the line", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z]{3,8}$/),
        fc.integer({ min: 0, max: 9 }),
        valuesArb(O_STATS),
        (junk, v, values) => {
          const extra = sampleSettings({
            add_rules: [
              { platform_id: `x${junk}`, name: `Zz ${junk}`, position_types: ["O"], modifier: 7 },
            ],
          });
          const base = score(lineOf("O", values), S);
          const withRule = score(lineOf("O", values), extra);
          const withStat = score(lineOf("O", { ...values, [`zz_${junk}`]: v }), S);
          return (
            withRule.points === base.points &&
            withRule.unmapped.filter((u) => u === `x${junk}`).length === 1 &&
            withStat.points === base.points &&
            withStat.ignored.includes(`zz_${junk}`)
          );
        },
      ),
    );
  });

  it("P7 normaliser idempotence; permutations keep the hash; any modifier change moves it", () => {
    const base = draftOf("sample-league");
    fc.assert(
      fc.property(
        fc.shuffledSubarray([...base.rules], {
          minLength: base.rules.length,
          maxLength: base.rules.length,
        }),
        fc.integer({ min: 0, max: base.rules.length - 1 }),
        (perm, i) => {
          const a = normalizeSettings(base);
          const b = normalizeSettings({ ...base, rules: perm });
          const target = base.rules[i]!;
          const changed = normalizeSettings({
            ...base,
            rules: base.rules.map((r) =>
              r === target ? { ...r, modifier: (r.modifier ?? 0) + 0.5 } : r,
            ),
          });
          return (
            b.settings_hash === a.settings_hash &&
            JSON.stringify(normalizeSettings(b)) === JSON.stringify(a) &&
            changed.settings_hash !== a.settings_hash
          );
        },
      ),
    );
  });

  it("P8 rounding is bounded, integral once verified, exact otherwise; policy is idempotent", () => {
    const exact = S;
    const half = sampleSettings({
      set: { rounding: { mode: "round_half_up_total", verified: true } },
    });
    const floor = sampleSettings({ set: { rounding: { mode: "floor_total", verified: true } } });
    const unverified = sampleSettings({
      set: { rounding: { mode: "floor_total", verified: false } },
    });
    fc.assert(
      fc.property(valuesArb(O_STATS, fc.integer({ min: 0, max: 999 })), (values) => {
        const line = lineOf("O", values);
        const e = score(line, exact);
        const h = score(line, half);
        const f = score(line, floor);
        return (
          e.points === e.points_exact &&
          score(line, unverified).points === e.points_exact &&
          Number.isInteger(h.points) &&
          Math.abs(h.points - h.points_exact) <= 0.5 &&
          Number.isInteger(f.points) &&
          f.points_exact - f.points >= 0 &&
          f.points_exact - f.points < 1 &&
          applyPolicy(h.points, half) === h.points &&
          applyPolicy(f.points, floor) === f.points
        );
      }),
    );
  });

  it("P9 negative floor: max(0, exact) when negatives are off, exact when on", () => {
    const off = sampleSettings({ set: { uses_negative_points: false } });
    fc.assert(
      fc.property(
        valuesArb(
          ["pass_int", "fum_lost", "pass_yd", "rush_yd"],
          fc.integer({ min: -50, max: 60 }),
        ),
        (values) => {
          const r = score(lineOf("O", values), off);
          const on = score(lineOf("O", values), S);
          return (
            r.points >= 0 &&
            r.points === Math.max(0, r.points_exact) &&
            on.points === on.points_exact &&
            applyPolicy(r.points, off) === r.points
          );
        },
      ),
    );
  });

  it("P10 complete = false ⇔ provisional ∧ a scoring rule's stat is absent; never false on a final week", () => {
    const oracle = (
      pt: PositionType,
      values: Record<string, number>,
      provisional: boolean,
    ): boolean => {
      if (!provisional) return true;
      const scoring = S.rules.filter(
        (r) =>
          r.canonical !== null &&
          r.position_types.includes(pt) &&
          (r.modifier !== null || r.bonuses.length > 0),
      );
      return scoring.every((r) => Object.hasOwn(values, r.canonical!));
    };
    fc.assert(
      fc.property(
        fc.constantFrom<PositionType>("O", "K"),
        fc.boolean(),
        fc.subarray([...O_STATS, ...K_STATS]),
        (pt, prov, present) => {
          const values = Object.fromEntries(present.map((c) => [c, 0]));
          return score(lineOf(pt, values, prov), S).complete === oracle(pt, values, prov);
        },
      ),
    );
  });

  it("P11 no NaN/Infinity ever leaves score for any coercible scalar", () => {
    const scalar = fc.oneof(
      fc.constantFrom("", "0", "112.82", " 3 ", "1e2", "-0", "NaN", "Infinity", "0x1f", "1,5", "٣"),
      fc.string(),
      fc.double().map(String),
      fc.integer().map(String),
    );
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.constantFrom(...O_STATS), scalar), { maxLength: 14 }),
        (pairs) => {
          const values: Record<string, number | null> = {};
          for (const [k, raw] of pairs) values[k] = coerceScalar(raw);
          const r = score(makeStatLine(values, "O"), S);
          return (
            Number.isFinite(r.points) &&
            Number.isFinite(r.points_exact) &&
            r.contributions.every((c) => Number.isFinite(c.points))
          );
        },
      ),
    );
  });

  it("P12 determinism: byte-identical results; seeded sample batches reproduce", () => {
    const batch = (seed: number): StatLine[] => {
      const rng = seededRng(seed).fork("scoring-p12");
      return Array.from({ length: 200 }, () =>
        lineOf("O", { pass_yd: Math.floor(rng.next() * 400), pass_td: Math.floor(rng.next() * 4) }),
      );
    };
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 31 - 1 }), (seed) => {
        const a = JSON.stringify(scoreSamples(batch(seed), S, "player_sim"));
        const b = JSON.stringify(scoreSamples(batch(seed), normalizeSettings(S), "player_sim"));
        return a === b;
      }),
      { numRuns: 25 },
    );
  });

  it("P13 sample-mean consistency: dist.mean ≈ mean_of_exact within 3σ/√n (n_sims = 4000: |Δ| < 0.5)", () => {
    const s = sampleSettings({
      bonuses: { "4": [{ target: 300, points: 3 }], "9": [{ target: 100, points: 2 }] },
    });
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 31 - 1 }), (seed) => {
        const rng = seededRng(seed);
        const n = 4000;
        const lines = Array.from({ length: n }, () =>
          lineOf("O", {
            pass_yd: Math.floor(rng.next() * 450),
            pass_td: Math.floor(rng.next() * 4),
            rush_yd: Math.floor(rng.next() * 140),
            pass_int: Math.floor(rng.next() * 3),
          }),
        );
        const r = scoreSamples(lines, s, "player_sim");
        const pts = lines.map((l) => score(l, s).points);
        const mu = pts.reduce((a, b) => a + b, 0) / n;
        const sd = Math.sqrt(pts.reduce((a, b) => a + (b - mu) ** 2, 0) / (n - 1));
        const d = Math.abs(r.dist.mean - r.mean_of_exact);
        return d <= Math.max(1e-9, (3 * sd) / Math.sqrt(n)) && d < 0.5;
      }),
      { numRuns: 10 },
    );
  });

  it("P14 platform round trip: Yahoo-shaped and ESPN-shaped settings from one canonical table score identically", () => {
    const table = S.rules.filter((r) => r.canonical !== null);
    const yahoo = S;
    const espn = normalizeSettings({
      platform: "espn",
      uses_fractional_points: true,
      uses_negative_points: true,
      rules: table.map((r, i) => ({
        canonical: r.canonical,
        platform_id: `espn-${String(i)}`,
        name: `ESPN stat ${String(i)}`,
        position_types: r.position_types,
        modifier: r.modifier,
      })),
    });
    expect(espn.brackets.map((b) => [b.family, b.kind, b.members.map((m) => m.canonical)])).toEqual(
      yahoo.brackets.map((b) => [b.family, b.kind, b.members.map((m) => m.canonical)]),
    );
    fc.assert(
      fc.property(
        fc.constantFrom<PositionType>("O", "K", "DT"),
        valuesArb([...O_STATS, ...K_STATS, ...DT_STATS, "dst_pa"], fc.integer({ min: 0, max: 60 })),
        (pt, values) => {
          const line = lineOf(pt, values);
          return score(line, yahoo).points === score(line, espn).points;
        },
      ),
    );
  });
});

describe("derived-family properties", () => {
  it("any contiguous named family derives sorted, contiguous members; any permutation derives the same", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 30 }), { minLength: 1, maxLength: 8 }),
        fc.boolean(),
        (widths, openEnd) => {
          let lo = 0;
          const rules = widths.map((w, i) => {
            const last = i === widths.length - 1 && openEnd;
            const canonical = last
              ? `dst_ya_${String(lo)}p`
              : `dst_ya_${String(lo)}_${String(lo + w - 1)}`;
            lo += w;
            return {
              canonical,
              platform_id: String(i),
              name: canonical,
              position_types: ["DT"] as PositionType[],
              modifier: 1,
              bonuses: [],
            };
          });
          const a = deriveBrackets(rules);
          const b = deriveBrackets([...rules].reverse());
          const m = a[0]!.members;
          for (let i = 1; i < m.length; i++) if (m[i]!.lower !== m[i - 1]!.upper! + 1) return false;
          return JSON.stringify(a) === JSON.stringify(b);
        },
      ),
    );
  });
});
