// settings.ts — the platform-neutral half of settings normalisation that every provider shares:
// plan 08 §2 (ScoringSettings, settings_hash = sha256 of canonical JSON without the `verified`
// flags), §3.1 (resolve by name, duplicate canonical = loud error, unmapped logged once per hash),
// §4.1 (brackets derived here — plan 01 §8.1 "the bracket-table derivation is the engine's"), §4.2
// (bonus-as-extra-id folded onto the base stat), §4.4 (rounding/floor defaults, `verified: false`),
// §9 / E7 (the hash is the memo key), §7 P7 (idempotent, order-independent).
import { createHash } from "node:crypto";
import { deriveBrackets } from "./brackets.js";
import { ScoringError } from "./errors.js";
import { MAX_ABS_MODIFIER, MAX_ABS_STAT } from "./numeric.js";
import { bonusRuleTarget, resolveCanonical } from "./registry.js";
import type {
  Canonical,
  NegativeFloorScope,
  PlatformId,
  PositionType,
  RoundingMode,
  ScoringBonus,
  ScoringRule,
  ScoringSettings,
} from "./types.js";
import { CANONICAL_NAME_RE, POSITION_TYPES } from "./types.js";

/** One rule as a provider hands it over (plan 08 §3.1): `canonical` omitted = resolve by name. */
export interface RuleDraft {
  /** Omitted → resolved from `name` + `position_types`; `null` → explicitly unmapped. */
  readonly canonical?: Canonical | null;
  readonly platform_id: string;
  readonly name: string;
  readonly position_types: readonly PositionType[];
  readonly modifier: number | null;
  readonly bonuses?: readonly ScoringBonus[];
}

/** What a provider's wire-aware normaliser produces; `normalizeSettings` finishes it. */
export interface SettingsDraft {
  readonly platform: PlatformId;
  readonly rules: readonly RuleDraft[];
  readonly uses_fractional_points: boolean;
  readonly uses_negative_points: boolean;
  /** Default `{ mode: "exact", verified: false }` (E4: never guess a rounding mode). */
  readonly rounding?: { readonly mode: RoundingMode; readonly verified: boolean };
  /** Default: scope `player_week_total` when negatives are off, else `none`; `verified: false`. */
  readonly negative_floor?: { readonly scope: NegativeFloorScope; readonly verified: boolean };
}

/** The platforms a settings object may come from (plan 01 §8). */
const PLATFORMS: readonly PlatformId[] = ["yahoo", "manual", "sleeper", "espn"];
/** Most rules one league can carry (Yahoo's whole NFL universe is ~100 ids). */
export const MAX_RULES = 1000;
/** Most bonus entries on one rule. */
export const MAX_BONUSES = 20;
const MAX_PLATFORM_ID = 64;
const MAX_NAME = 200;
/** Mode / scope strings: a lowercase identifier (unknown ones are kept, never applied). */
const FLAG_RE = /^[a-z][a-z0-9_]{0,39}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

function bad(message: string, detail: readonly string[] = []): ScoringError {
  return new ScoringError("invalid_settings", message, detail);
}

function isFiniteWithin(x: unknown, max: number): x is number {
  return typeof x === "number" && Number.isFinite(x) && Math.abs(x) <= max;
}

/** Position types deduplicated into POSITION_TYPES order; an unknown type is refused. */
function checkPositionTypes(pts: unknown, id: string): readonly PositionType[] {
  if (!Array.isArray(pts)) throw bad("position_types must be an array", [id]);
  for (const pt of pts) {
    if (!POSITION_TYPES.includes(pt as PositionType)) throw bad("unknown position type", [id]);
  }
  return POSITION_TYPES.filter((pt) => (pts as unknown[]).includes(pt));
}

function checkBonuses(bonuses: unknown, id: string): readonly ScoringBonus[] {
  if (bonuses === undefined) return [];
  if (!Array.isArray(bonuses) || bonuses.length > MAX_BONUSES) {
    throw bad("bonuses must be an array of at most 20 entries", [id]);
  }
  const out = (bonuses as unknown[]).map((b) => {
    const { target, points } = (b ?? {}) as { target?: unknown; points?: unknown };
    if (!isFiniteWithin(target, MAX_ABS_STAT) || !isFiniteWithin(points, MAX_ABS_MODIFIER)) {
      throw bad("bonus target/points must be finite and in range", [id]);
    }
    return { target: target === 0 ? 0 : target, points: points === 0 ? 0 : points };
  });
  return out.sort((a, b) => a.target - b.target || a.points - b.points);
}

/** Validates and canonicalises one rule draft (canonical still possibly unresolved). */
function checkRule(r: RuleDraft): {
  readonly canonical: Canonical | null | undefined;
  readonly rule: Omit<ScoringRule, "canonical">;
} {
  const id: unknown = (r as { platform_id?: unknown }).platform_id;
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    id.length > MAX_PLATFORM_ID ||
    CONTROL_RE.test(id)
  ) {
    throw bad("platform_id must be 1–64 printable characters");
  }
  const name: unknown = (r as { name?: unknown }).name;
  if (typeof name !== "string" || name.length > MAX_NAME) {
    throw bad("rule name must be a string of at most 200 characters", [id]);
  }
  const rawModifier: unknown = (r as { modifier?: unknown }).modifier;
  if (rawModifier !== null && !isFiniteWithin(rawModifier, MAX_ABS_MODIFIER)) {
    throw bad("modifier must be null or finite and in range", [id]);
  }
  const modifier = rawModifier;
  const canonical: unknown = (r as { canonical?: unknown }).canonical;
  if (canonical !== undefined && canonical !== null) {
    if (typeof canonical !== "string" || !CANONICAL_NAME_RE.test(canonical)) {
      throw new ScoringError("invalid_canonical", "canonical name is malformed", [id]);
    }
  }
  return {
    canonical,
    rule: {
      platform_id: id,
      name,
      position_types: checkPositionTypes(r.position_types, id),
      modifier: modifier === 0 ? 0 : modifier,
      bonuses: checkBonuses(r.bonuses, id),
    },
  };
}

function checkFlag(value: unknown, what: string): string {
  if (typeof value !== "string" || !FLAG_RE.test(value)) throw bad(`${what} must be an identifier`);
  return value;
}

const intersects = (a: readonly PositionType[], b: readonly PositionType[]): boolean =>
  a.some((x) => b.includes(x));

/**
 * Folds bonus-as-stat-id rules onto their base stat (plan 08 §4.2): an UNMAPPED rule named like
 * "300+ Passing Yards Bonus" with a modifier becomes `{ target: 300, points: modifier }` on every
 * base rule (`pass_yd`) sharing a position type; with no base rule a display-only base rule is
 * synthesised from the bonus rule (its id and name) so the points are never lost.
 */
function foldBonusRules(rules: ScoringRule[]): ScoringRule[] {
  const out: ScoringRule[] = [];
  const bonusRules: { rule: ScoringRule; base: Canonical; entry: ScoringBonus }[] = [];
  for (const r of rules) {
    const hit = r.canonical === null ? bonusRuleTarget(r.name) : null;
    if (hit === null || r.modifier === null) out.push(r);
    else
      bonusRules.push({
        rule: r,
        base: hit.base,
        entry: { target: hit.target, points: r.modifier },
      });
  }
  for (const { rule, base, entry } of bonusRules) {
    const bases = out.filter(
      (r) => r.canonical === base && intersects(r.position_types, rule.position_types),
    );
    if (bases.length === 0) {
      out.push({ ...rule, canonical: base, modifier: null, bonuses: [entry] });
      continue;
    }
    for (const b of bases) {
      const i = out.indexOf(b);
      out[i] = { ...b, bonuses: [...b.bonuses, entry] };
    }
  }
  return out.map((r) => ({
    ...r,
    bonuses: [...r.bonuses].sort((a, b) => a.target - b.target || a.points - b.points),
  }));
}

/** Two rules → one canonical in one position type is a normaliser error naming both ids (§3.1). */
function assertNoDuplicates(rules: readonly ScoringRule[]): void {
  const seen = new Map<string, string>();
  for (const r of rules) {
    if (r.canonical === null) continue;
    for (const pt of r.position_types) {
      const key = `${pt}:${r.canonical}`;
      const prior = seen.get(key);
      if (prior !== undefined) {
        throw new ScoringError(
          "duplicate_canonical",
          `two rules map to ${r.canonical} under ${pt}`,
          [prior, r.platform_id],
        );
      }
      seen.set(key, r.platform_id);
    }
  }
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function compareRules(a: ScoringRule, b: ScoringRule): number {
  return (
    cmp(a.platform_id, b.platform_id) ||
    cmp(a.canonical ?? "", b.canonical ?? "") ||
    cmp(a.position_types.join(","), b.position_types.join(",")) ||
    cmp(a.name, b.name)
  );
}

/** JSON with object keys sorted at every depth (the hash input; order-independent, P7). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * sha256 (hex) of the canonical JSON of everything in the settings except the two `verified` flags
 * and the hash itself (plan 08 §2). The memo key of E7 and the hash the recommendation log keeps.
 */
export function computeSettingsHash(s: Omit<ScoringSettings, "settings_hash">): string {
  const body = {
    platform: s.platform,
    rules: s.rules,
    brackets: s.brackets,
    uses_fractional_points: s.uses_fractional_points,
    uses_negative_points: s.uses_negative_points,
    rounding: { mode: s.rounding.mode },
    negative_floor: { scope: s.negative_floor.scope },
  };
  return createHash("sha256").update(canonicalJson(body), "utf8").digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/**
 * Finishes a provider's settings draft into the engine's `ScoringSettings` (plan 08 §2–§4):
 * validates every field (bounded ids/names, finite in-range modifiers and bonuses, known position
 * types), resolves omitted canonicals by display name, folds bonus-as-extra-id rules, refuses two
 * rules on one canonical per position type, derives the bracket families (a draft's own `brackets`
 * are ignored — they are always re-derived), defaults the rounding/floor flags to `verified:
 * false`, sorts everything and computes `settings_hash`. The result is deeply frozen. Idempotent:
 * `normalizeSettings(normalizeSettings(d))` deep-equals `normalizeSettings(d)` (P7).
 */
export function normalizeSettings(draft: SettingsDraft): ScoringSettings {
  const d = draft as Partial<Record<keyof SettingsDraft, unknown>>;
  if (!PLATFORMS.includes(d.platform as PlatformId)) throw bad("unknown platform");
  if (
    typeof d.uses_fractional_points !== "boolean" ||
    typeof d.uses_negative_points !== "boolean"
  ) {
    throw bad("uses_fractional_points / uses_negative_points must be booleans");
  }
  if (!Array.isArray(d.rules) || d.rules.length > MAX_RULES) {
    throw bad("rules must be an array of at most 1000 entries");
  }
  const checked = (d.rules as unknown[]).map((r) => {
    if (r === null || typeof r !== "object") throw bad("a rule must be an object");
    const { canonical, rule } = checkRule(r as RuleDraft);
    return {
      ...rule,
      canonical:
        canonical === undefined ? resolveCanonical(rule.name, rule.position_types) : canonical,
    };
  });
  const rules = foldBonusRules(checked).sort(compareRules);
  assertNoDuplicates(rules);

  const negatives = d.uses_negative_points;
  const rounding = (d.rounding ?? { mode: "exact", verified: false }) as {
    mode?: unknown;
    verified?: unknown;
  };
  const floor = (d.negative_floor ?? {
    scope: negatives ? "none" : "player_week_total",
    verified: false,
  }) as { scope?: unknown; verified?: unknown };
  if (typeof rounding.verified !== "boolean" || typeof floor.verified !== "boolean") {
    throw bad("rounding.verified / negative_floor.verified must be booleans");
  }

  const body: Omit<ScoringSettings, "settings_hash"> = {
    platform: d.platform as PlatformId,
    rules,
    brackets: deriveBrackets(rules),
    uses_fractional_points: d.uses_fractional_points,
    uses_negative_points: negatives,
    rounding: { mode: checkFlag(rounding.mode, "rounding.mode"), verified: rounding.verified },
    negative_floor: {
      scope: checkFlag(floor.scope, "negative_floor.scope"),
      verified: floor.verified,
    },
  };
  return deepFreeze({ ...body, settings_hash: computeSettingsHash(body) });
}

/** Platform ids of the unmapped rules (`canonical: null`), sorted and unique (plan 08 §3.1). */
export function unmappedIds(settings: ScoringSettings): readonly string[] {
  const ids = new Set<string>();
  for (const r of settings.rules) if (r.canonical === null) ids.add(r.platform_id);
  return Object.freeze([...ids].sort(cmp));
}

/** "Logged once per settings_hash" (plan 08 §3.1) without the engine doing I/O. */
export interface UnmappedLog {
  /**
   * The unmapped ids the FIRST time a settings hash is seen with any, else null — the caller logs
   * a non-null result. Bounded: the oldest hash is forgotten past `capacity`.
   */
  firstReport(settings: ScoringSettings): readonly string[] | null;
}

/** A bounded once-per-hash reporter for unmapped ids (the caller owns the logging). */
export function createUnmappedLog(capacity = 256): UnmappedLog {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new RangeError("unmapped log capacity must be a positive integer");
  }
  const seen = new Set<string>();
  return {
    firstReport(settings) {
      if (seen.has(settings.settings_hash)) return null;
      if (seen.size >= capacity) {
        for (const oldest of seen) {
          seen.delete(oldest);
          break;
        }
      }
      seen.add(settings.settings_hash);
      const ids = unmappedIds(settings);
      return ids.length > 0 ? ids : null;
    },
  };
}
