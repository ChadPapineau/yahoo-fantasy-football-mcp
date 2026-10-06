// engine.ts — the pure scorer: plan 08 E1 (`score`, `scoreSamples`, `explain`; no I/O), §3.3
// (position-type gating inside score), §4.1 (indicator families: Σ ≤ 1 asserted, Σ = 0 → family not
// present, scalar → bracketize; count families linear per bin, critic C-09), §4.2 (threshold
// bonuses, several entries sum, on any rule — a bracket member's on its bin count or indicator,
// QA-2-036), §4.4 / E4 (negative floor + verified-only rounding), §4.5 (missing
// vs unknown; `complete`), §5 / E5 / E8 (distribution over SCORED SAMPLES, never the scaled mean;
// `basis` stamped on the Dist).
import { bracketize, familyScalar } from "./brackets.js";
import { ScoringError } from "./errors.js";
import { at, denoise, MAX_ABS_MODIFIER, MAX_ABS_STAT, stableSum } from "./numeric.js";
import { unmappedIds } from "./settings.js";
import type {
  BracketFamily,
  Canonical,
  Dist,
  DistBasis,
  PositionType,
  ScoreContribution,
  ScoreResult,
  ScoreSamplesResult,
  ScoringBonus,
  ScoringEngine,
  ScoringRule,
  ScoringSettings,
  StatLine,
} from "./types.js";
import { CANONICAL_NAME_RE, POSITION_TYPES } from "./types.js";

// --- compilation (memoised per settings object) --------------------------------------------------

interface LinearRule {
  readonly canonical: Canonical;
  readonly modifier: number | null;
  readonly bonuses: readonly ScoringBonus[];
  /** Whether an absent stat can change the total (modifier set or bonuses present) → P10. */
  readonly scores: boolean;
}

interface CompiledFamily {
  readonly family: BracketFamily;
  /** Per member: the rule's modifier for this position type, or null (display-only / no rule). */
  readonly modifiers: readonly (number | null)[];
  /**
   * Per member: the rule's threshold bonuses (plan 08 §4.2), judged on the member's value — the
   * bin's count, or the indicator's 0/1 (QA-2-036: they were dropped for bracket members).
   */
  readonly bonuses: readonly (readonly ScoringBonus[])[];
  /** Per member: its index in CompiledType.bonusSlots, or -1 when it has no bonuses. */
  readonly bonusSlot: readonly number[];
  /** The scalar canonical `bracketize` reads for an indicator family, or null. */
  readonly scalar: Canonical | null;
  /** Whether any member carries points or bonuses (an absent family then leaves a provisional week open). */
  readonly scores: boolean;
}

interface CompiledType {
  readonly linear: readonly LinearRule[];
  readonly families: readonly CompiledFamily[];
  /**
   * The stats whose bonuses `bonusFired` tracks: slot i < linear.length is linear rule i; the
   * slots after them are the bracket members that carry bonuses.
   */
  readonly bonusSlots: readonly { readonly canonical: Canonical; readonly hasBonuses: boolean }[];
  /** Every canonical a line of this type can use (rules, family members, family scalars). */
  readonly consumed: ReadonlySet<Canonical>;
  /** `bonusFired` of a line on which no bonus fired (shared: most samples fire none). */
  readonly noneFired: readonly boolean[];
}

interface Compiled {
  readonly byType: Readonly<Record<PositionType, CompiledType>>;
  readonly unmapped: readonly string[];
}

const COMPILED = new WeakMap<ScoringSettings, Compiled>();

function badSettings(message: string, detail: readonly string[]): ScoringError {
  return new ScoringError("invalid_settings", message, detail);
}

const finiteWithin = (x: number, max: number): boolean => Number.isFinite(x) && Math.abs(x) <= max;

/**
 * Indexes settings per position type once (memoised on the object — `normalizeSettings` output is
 * frozen). Re-validates what a hand-built settings object could get wrong so no non-finite number
 * can ever reach a total.
 */
function compile(settings: ScoringSettings): Compiled {
  const hit = COMPILED.get(settings);
  if (hit !== undefined) return hit;
  for (const r of settings.rules) {
    if (r.modifier !== null && !finiteWithin(r.modifier, MAX_ABS_MODIFIER)) {
      throw badSettings("modifier out of range", [r.platform_id]);
    }
    for (const b of r.bonuses) {
      if (!finiteWithin(b.target, MAX_ABS_STAT) || !finiteWithin(b.points, MAX_ABS_MODIFIER)) {
        throw badSettings("bonus out of range", [r.platform_id]);
      }
    }
  }
  const byType = {} as Record<PositionType, CompiledType>;
  for (const pt of POSITION_TYPES) {
    const rules: { readonly canonical: Canonical; readonly rule: ScoringRule }[] = [];
    for (const r of settings.rules) {
      if (r.canonical !== null && r.position_types.includes(pt)) {
        rules.push({ canonical: r.canonical, rule: r });
      }
    }
    const ruleOf = new Map<Canonical, ScoringRule>();
    for (const { canonical, rule } of rules) ruleOf.set(canonical, rule);
    const families: CompiledFamily[] = [];
    const members = new Set<Canonical>();
    const consumed = new Set<Canonical>();
    const memberSlots: Canonical[] = [];
    for (const family of settings.brackets) {
      if (family.position_type !== pt) continue;
      if (family.members.length === 0)
        throw badSettings("bracket family has no members", [family.family]);
      const modifiers = family.members.map((m) => ruleOf.get(m.canonical)?.modifier ?? null);
      const bonuses = family.members.map((m) => ruleOf.get(m.canonical)?.bonuses ?? []);
      // slots are numbered after the linear rules once those are known (offset below)
      const bonusSlot = bonuses.map((b, i) =>
        b.length === 0 ? -1 : memberSlots.push(at(family.members, i).canonical) - 1,
      );
      const scalar = family.kind === "indicator" ? familyScalar(family.family) : null;
      for (const m of family.members) {
        members.add(m.canonical);
        consumed.add(m.canonical);
      }
      if (scalar !== null) consumed.add(scalar);
      families.push({
        family,
        modifiers,
        bonuses,
        bonusSlot,
        scalar,
        scores: modifiers.some((m) => m !== null) || bonuses.some((b) => b.length > 0),
      });
    }
    const linear: LinearRule[] = [];
    for (const { canonical, rule: r } of rules) {
      consumed.add(canonical);
      if (members.has(canonical)) continue;
      linear.push({
        canonical,
        modifier: r.modifier,
        bonuses: r.bonuses,
        scores: r.modifier !== null || r.bonuses.length > 0,
      });
    }
    const offset = linear.length;
    const bonusSlots = [
      ...linear.map((r) => ({ canonical: r.canonical, hasBonuses: r.bonuses.length > 0 })),
      ...memberSlots.map((canonical) => ({ canonical, hasBonuses: true })),
    ];
    byType[pt] = {
      linear,
      families: families.map((f) => ({
        ...f,
        bonusSlot: f.bonusSlot.map((k) => (k < 0 ? -1 : offset + k)),
      })),
      bonusSlots,
      consumed,
      noneFired: Object.freeze(bonusSlots.map(() => false)),
    };
  }
  const compiled: Compiled = { byType, unmapped: unmappedIds(settings) };
  COMPILED.set(settings, compiled);
  return compiled;
}

// --- one line ----------------------------------------------------------------------------------

/** What `scoreSamples` needs beyond the result: which bonuses fired, which bins were hit. */
interface Evaluation {
  readonly result: ScoreResult;
  /** Per bonus slot (CompiledType.bonusSlots): whether at least one of its bonuses fired. */
  readonly bonusFired: readonly boolean[];
  /** Per compiled family index: member values (indicator 0/1, or counts); null = family absent. */
  readonly familyValues: readonly (readonly number[] | null)[];
  /** Sum of the linear / bonus / bracket parts (the decomposition behind `mean_of_exact`). */
  readonly parts: { readonly linear: number; readonly bonus: number; readonly bracket: number };
}

function invalidLine(message: string, detail: readonly string[] = []): ScoringError {
  return new ScoringError("invalid_line", message, detail);
}

/** Applies the negative floor (§4.4, A-2) and a VERIFIED rounding mode (E4) to an exact total. */
export function applyPolicy(exact: number, settings: ScoringSettings): number {
  let y = exact;
  if (floorApplies(settings) && y < 0) y = 0;
  if (settings.rounding.verified) {
    if (settings.rounding.mode === "round_half_up_total") y = Math.floor(y + 0.5);
    else if (settings.rounding.mode === "floor_total") y = Math.floor(y);
  }
  return y === 0 ? 0 : y;
}

/**
 * Whether the player-week floor applies: negatives disallowed AND scope `player_week_total` (plan
 * 08 §4.4 / P9). Applied while `verified: false` — the flag travels in the settings (A-2).
 */
export function floorApplies(settings: ScoringSettings): boolean {
  return !settings.uses_negative_points && settings.negative_floor.scope === "player_week_total";
}

/** The rounding mode actually applied: a known mode once verified, else `exact` (E4). */
export function appliedRounding(
  settings: ScoringSettings,
): "exact" | "round_half_up_total" | "floor_total" {
  const { mode, verified } = settings.rounding;
  if (verified && mode === "round_half_up_total") return "round_half_up_total";
  if (verified && mode === "floor_total") return "floor_total";
  return "exact";
}

/**
 * `detail: false` (the scoreSamples path) skips building `contributions` and `ignored` — thousands
 * of samples per player-week never read them (A15 latency); every number is computed identically.
 */
function evaluate(line: StatLine, settings: ScoringSettings, detail: boolean): Evaluation {
  const compiled = compile(settings);
  const raw: unknown = line;
  if (raw === null || typeof raw !== "object") throw invalidLine("stat line must be an object");
  const pt = line.position_type;
  if (!POSITION_TYPES.includes(pt)) throw invalidLine("unknown position type");
  const rawValues: unknown = line.values;
  if (rawValues === null || typeof rawValues !== "object") {
    throw invalidLine("values must be an object");
  }
  const values = rawValues as Readonly<Record<string, unknown>>;
  const keys = Object.keys(values);
  for (const k of keys) {
    const v = values[k];
    if (typeof v !== "number" || !finiteWithin(v, MAX_ABS_STAT)) {
      throw invalidLine("stat value is not a finite in-range number", [k]);
    }
  }
  const has = (c: Canonical): boolean => Object.hasOwn(values, c);
  // every own value was checked above to be a finite number
  const val = (c: Canonical): number => values[c] as number;
  const provisional = (raw as { provisional?: unknown }).provisional === true;
  const t = compiled.byType[pt];

  const contributions: ScoreContribution[] | null = detail ? [] : null;
  const linearPts: number[] = [];
  const bonusPts: number[] = [];
  const bracketPts: number[] = [];
  // allocated on the first bonus that fires (a holder: payBonuses below writes it)
  const fired: { slots: boolean[] | null } = { slots: null };
  let incomplete = false;

  /** Pays every bonus of `canonical` whose target `v` reaches (§4.2), marking its slot fired. */
  const payBonuses = (
    canonical: Canonical,
    v: number,
    bonuses: readonly ScoringBonus[],
    slot: number,
  ): void => {
    for (const b of bonuses) {
      if (v < b.target) continue;
      fired.slots ??= t.bonusSlots.map(() => false);
      fired.slots[slot] = true;
      bonusPts.push(b.points);
      contributions?.push({
        canonical,
        value: v,
        modifier: b.points,
        points: b.points,
        kind: "bonus",
      });
    }
  };

  let li = -1;
  for (const r of t.linear) {
    li += 1;
    if (!has(r.canonical)) {
      if (r.scores) incomplete = true;
      continue;
    }
    const v = val(r.canonical);
    if (r.modifier !== null) {
      const points = denoise(r.modifier * v);
      linearPts.push(points);
      contributions?.push({
        canonical: r.canonical,
        value: v,
        modifier: r.modifier,
        points,
        kind: "linear",
      });
    }
    payBonuses(r.canonical, v, r.bonuses, li);
  }

  const familyValues: (readonly number[] | null)[] = [];
  for (const f of t.families) {
    const members = f.family.members;
    let vector: number[] | null = null;
    if (f.family.kind === "count") {
      vector = members.map((m) => (has(m.canonical) ? val(m.canonical) : 0));
      members.forEach((m, i) => {
        const bonuses = at(f.bonuses, i);
        if (!has(m.canonical)) {
          if (f.modifiers[i] !== null || bonuses.length > 0) incomplete = true;
          return;
        }
        const v = val(m.canonical);
        const mod = at(f.modifiers, i);
        if (mod !== null) {
          const points = denoise(mod * v);
          bracketPts.push(points);
          contributions?.push({
            canonical: m.canonical,
            value: v,
            modifier: mod,
            points,
            kind: "bracket",
          });
        }
        payBonuses(m.canonical, v, bonuses, at(f.bonusSlot, i));
      });
    } else {
      let idx = -1;
      if (members.some((m) => has(m.canonical))) {
        let sum = 0;
        members.forEach((m, i) => {
          const v = has(m.canonical) ? val(m.canonical) : 0;
          if (v !== 0 && v !== 1) {
            throw new ScoringError("bracket_exclusivity", "indicator member is not 0 or 1", [
              f.family.family,
              m.canonical,
            ]);
          }
          if (v === 1) {
            sum += 1;
            idx = i;
          }
        });
        if (sum > 1) {
          throw new ScoringError("bracket_exclusivity", "two bracket indicators set in one game", [
            f.family.family,
          ]);
        }
      } else if (f.scalar !== null && has(f.scalar)) {
        idx = bracketize(f.family, val(f.scalar));
      }
      if (idx >= 0) {
        const hit = members.map((_, i) => (i === idx ? 1 : 0));
        vector = hit;
        const mod = at(f.modifiers, idx);
        if (mod !== null) {
          const member = at(members, idx).canonical;
          bracketPts.push(mod);
          contributions?.push({
            canonical: member,
            value: 1,
            modifier: mod,
            points: mod,
            kind: "bracket",
          });
        }
        // a member's bonuses are judged on its indicator, 1 for the bin hit and 0 for the others
        members.forEach((m, i) => {
          payBonuses(m.canonical, at(hit, i), at(f.bonuses, i), at(f.bonusSlot, i));
        });
      } else if (f.scores) {
        incomplete = true;
      }
    }
    familyValues.push(vector);
  }

  const linear = stableSum(linearPts);
  const bonus = stableSum(bonusPts);
  const bracket = stableSum(bracketPts);
  // the same summation sequence as the concatenation: with no bonus/bracket terms it IS `linear`
  const exact = denoise(
    bonusPts.length === 0 && bracketPts.length === 0
      ? linear
      : stableSum([...linearPts, ...bonusPts, ...bracketPts]),
  );
  const ignored = detail
    ? keys.filter((k) => CANONICAL_NAME_RE.test(k) && !t.consumed.has(k)).sort()
    : [];
  const result: ScoreResult = {
    points: applyPolicy(exact, settings),
    points_exact: exact,
    complete: !(provisional && incomplete),
    unmapped: compiled.unmapped,
    ignored,
    contributions: contributions ?? [],
  };
  return {
    result,
    bonusFired: fired.slots ?? t.noneFired,
    familyValues,
    parts: { linear, bonus, bracket },
  };
}

/**
 * Scores one canonical stat line under normalised settings (plan 08 §2): gated by position type,
 * brackets and bonuses applied, floor always and rounding only once verified. Throws ScoringError
 * `invalid_line` (non-finite / absurd value, unknown position type), `bracket_exclusivity` (two
 * indicators, or a non-0/1 indicator) or `invalid_settings` (a hand-built settings object out of
 * range). The line's `values` keys ARE its present set; `present` is not consulted.
 */
export function score(line: StatLine, settings: ScoringSettings): ScoreResult {
  return evaluate(line, settings, true).result;
}

/** `score`, named for the tools that render `contributions` (plan 08 §2). */
export const explain: (line: StatLine, settings: ScoringSettings) => ScoreResult = score;

// --- distributions ------------------------------------------------------------------------------

const BASES: readonly DistBasis[] = ["position_cv", "player_sim"];

/** Linear-interpolation quantile (Hyndman–Fan type 7) of an ascending array. */
function quantile(sorted: readonly number[], p: number): number {
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const a = at(sorted, lo);
  const b = at(sorted, Math.min(lo + 1, sorted.length - 1));
  return denoise(a + (h - lo) * (b - a));
}

/**
 * Scores sampled stat lines into a distribution (plan 08 §2, §5, E5): quantiles and `p_zero` over
 * the league's FINAL points (floor/rounding applied); `mean_of_exact` = E[linear] + E[bonus] +
 * E[bracket] over the exact totals — so a bonus contributes P(stat ≥ target) × points, never
 * [E[stat] ≥ target] × points; `bonus_probability` = P(any bonus on that stat fires);
 * `bracket_probability` per family key = P(member) for an indicator family, E[count] for a count
 * family. `basis` is validated and copied onto the Dist (E8). Throws `invalid_line` on an empty batch.
 */
export function scoreSamples(
  lines: readonly StatLine[],
  settings: ScoringSettings,
  basis: DistBasis,
): ScoreSamplesResult {
  if (!BASES.includes(basis)) throw invalidLine("basis must be position_cv or player_sim");
  const batch: readonly StatLine[] = lines;
  const shape: unknown = lines;
  if (!Array.isArray(shape) || batch.length === 0) {
    throw invalidLine("no samples to score");
  }
  const compiled = compile(settings);
  const n = batch.length;
  const points: number[] = [];
  const linear: number[] = [];
  const bonus: number[] = [];
  const bracket: number[] = [];
  const acc = new Map<PositionType, { bonus: number[]; fam: number[][] }>();

  for (const line of batch) {
    const e = evaluate(line, settings, false);
    const t = compiled.byType[line.position_type];
    let a = acc.get(line.position_type);
    if (a === undefined) {
      a = {
        bonus: t.bonusSlots.map(() => 0),
        fam: t.families.map((f) => f.family.members.map(() => 0)),
      };
      acc.set(line.position_type, a);
    }
    const bonusCounts = a.bonus;
    if (e.bonusFired !== t.noneFired)
      e.bonusFired.forEach((fired, i) => {
        if (fired) bonusCounts[i] = at(bonusCounts, i) + 1;
      });
    const famTotals = a.fam;
    e.familyValues.forEach((vec, i) => {
      if (vec === null) return;
      const totals = at(famTotals, i);
      vec.forEach((v, j) => {
        totals[j] = at(totals, j) + v;
      });
    });
    points.push(e.result.points);
    linear.push(e.parts.linear);
    bonus.push(e.parts.bonus);
    bracket.push(e.parts.bracket);
  }

  const bonusHits = new Map<Canonical, number>();
  const familyTotals = new Map<string, readonly number[]>();
  for (const [pt, a] of acc) {
    const t = compiled.byType[pt];
    t.bonusSlots.forEach((slot, i) => {
      if (!slot.hasBonuses) return;
      bonusHits.set(slot.canonical, (bonusHits.get(slot.canonical) ?? 0) + at(a.bonus, i));
    });
    t.families.forEach((f, i) => familyTotals.set(f.family.family, at(a.fam, i)));
  }

  const sorted = [...points].sort((a, b) => a - b);
  const dist: Dist = {
    mean: denoise(stableSum(points) / n),
    p10: quantile(sorted, 0.1),
    p25: quantile(sorted, 0.25),
    p50: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    p90: quantile(sorted, 0.9),
    p_zero: denoise(points.filter((p) => p === 0).length / n),
    basis,
  };
  const bonus_probability: Record<Canonical, number> = {};
  for (const [c, hits] of [...bonusHits].sort(([a], [b]) => (a < b ? -1 : 1))) {
    bonus_probability[c] = denoise(hits / n);
  }
  const bracket_probability: Record<string, readonly number[]> = {};
  for (const [name, totals] of [...familyTotals].sort(([a], [b]) => (a < b ? -1 : 1))) {
    bracket_probability[name] = totals.map((x) => denoise(x / n));
  }
  const mean_of_exact = denoise(
    stableSum([stableSum(linear) / n, stableSum(bonus) / n, stableSum(bracket) / n]),
  );
  return { dist, mean_of_exact, bonus_probability, bracket_probability };
}

/** The engine as one object (plan 08 E1). */
export const scoringEngine: ScoringEngine = Object.freeze({ score, scoreSamples, explain });
