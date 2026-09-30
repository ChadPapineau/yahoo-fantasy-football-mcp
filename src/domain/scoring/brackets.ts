// brackets.ts — bracket families derived from stat names: plan 08 §4.1 (derivation, contiguity and
// overlap assertions naming the offenders, `bracketize(family, scalar)` for derived lines, FG
// distance as the same mechanism) with critic C-09's `kind` (FG bins are COUNTS, linear per bin)
// and C-12's rule that every derived family name is a BRACKET_FAMILY_RE slug.
import { ScoringError } from "./errors.js";
import { at } from "./numeric.js";
import { normalizeStatName } from "./registry.js";
import type {
  BracketFamily,
  BracketKind,
  BracketMember,
  Canonical,
  PositionType,
  ScoringRule,
} from "./types.js";
import { BRACKET_FAMILY_KIND, POSITION_TYPES } from "./types.js";

/** Families whose members are derived from the canonical grammar (the registry's bin names). */
const NAMED_BY_PREFIX: readonly { readonly prefix: string; readonly family: string }[] = [
  { prefix: "fg_miss", family: "fg_miss_distance" },
  { prefix: "fg", family: "fg_distance" },
  { prefix: "dst_pa", family: "dst_points_allowed" },
  { prefix: "dst_ya", family: "dst_yards_allowed" },
];

/** A bin canonical's bounds: `_a_b` → [a, b], `_n` → [n, n] (points/yards allowed only), `_np` → [n, ∞). */
const BIN_RE = /^(?<prefix>fg_miss|fg|dst_pa|dst_ya)_(?<a>\d{1,4})(?:_(?<b>\d{1,4})|(?<plus>p))?$/;

/**
 * The scalar a derived (nflverse/projection) line carries for an indicator family, which
 * `bracketize` turns into the member indicator (plan 08 §4.1 "Scoring a derived line").
 */
export const FAMILY_SCALAR: Readonly<Record<string, Canonical>> = Object.freeze({
  dst_points_allowed: "dst_pa",
  dst_yards_allowed: "dst_ya",
});

/** A family's kind: the named ones per BRACKET_FAMILY_KIND; every other family counts (linear). */
export function familyKind(family: string): BracketKind {
  return (BRACKET_FAMILY_KIND as Readonly<Record<string, BracketKind>>)[family] ?? "count";
}

/** The longest slug kept, leaving room for a `_<position type>` disambiguating suffix. */
const MAX_SLUG = 36;

/**
 * Slugs a raw family stem to BRACKET_FAMILY_RE (critic C-12): NFKC, lower case, every run of
 * non-[a-z0-9] → "_", trimmed, prefixed `f_` when it would start with a digit, cut to 36 chars.
 * Returns null when nothing sluggable remains.
 */
export function slugFamily(raw: string): string | null {
  let s = raw
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (s === "") return null;
  if (/^[0-9]/.test(s)) s = `f_${s}`;
  return s.slice(0, MAX_SLUG).replace(/_+$/, "");
}

/** Bounds + family parsed from a bin canonical, or null when the canonical is not a bin. */
export function parseBinCanonical(
  canonical: Canonical,
): { family: string; lower: number; upper: number | null } | null {
  const m = BIN_RE.exec(canonical);
  if (m === null) return null;
  // `prefix` and `a` are mandatory groups, so a match always carries them
  const g = m.groups as { prefix: string; a: string; b?: string; plus?: string };
  const named = NAMED_BY_PREFIX.find((n) => n.prefix === g.prefix) as { family: string };
  const lower = Number(g.a);
  if (g.b !== undefined) return { family: named.family, lower, upper: Number(g.b) };
  if (g.plus !== undefined) return { family: named.family, lower, upper: null };
  // a single-number bin is legal for points/yards allowed only (`dst_pa_0`), never for FGs
  if (g.prefix.startsWith("fg")) return null;
  return { family: named.family, lower, upper: lower };
}

/** A generic bounded display name (`Tackles 5-9`, `Return Yards 100+`): stem slug + bounds. */
const GENERIC_RE = /^(?<stem>.*?)\s*(?<a>\d{1,4})(?:-(?<b>\d{1,4})|(?<plus>\+))(?<rest>.*)$/;

function parseGenericName(
  name: string,
): { family: string; lower: number; upper: number | null } | null {
  const m = GENERIC_RE.exec(normalizeStatName(name));
  if (m === null) return null;
  const g = m.groups as { stem: string; a: string; b?: string; rest: string };
  const family = slugFamily(`${g.stem} ${g.rest}`);
  if (family === null) return null;
  const lower = Number(g.a);
  return { family, lower, upper: g.b === undefined ? null : Number(g.b) };
}

interface Candidate {
  readonly member: BracketMember;
  readonly named: boolean;
}

/**
 * The first problem with a member list sorted by `lower`, or null: an inverted range, an
 * open-ended member that is not last, an overlap, or a gap (bounds are inclusive integers).
 */
function contiguityProblem(members: readonly BracketMember[]): string | null {
  for (const [i, m] of members.entries()) {
    if (m.upper !== null && m.upper < m.lower) return `inverted range ${m.canonical}`;
    if (i === members.length - 1) continue;
    const next = at(members, i + 1);
    if (m.upper === null || next.lower <= m.upper) {
      return `overlap ${m.canonical} / ${next.canonical}`;
    }
    if (next.lower !== m.upper + 1) return `gap ${m.canonical} / ${next.canonical}`;
  }
  return null;
}

/**
 * Derives the bracket families from mapped rules (plan 08 §4.1): rules are grouped by
 * (position type, family). Named families come from the canonical bin grammar (`fg_40_49`,
 * `dst_pa_7_13`, `dst_ya_100_199`, `fg_miss_50p`) — a gap/overlap there is a `bracket_bounds`
 * error naming the members. Any other family comes from a bounded DISPLAY name, needs ≥ 2 members,
 * is slugged, counts linearly, and is simply not formed when its bins are not contiguous (it then
 * scores as plain rules — identical points). A family name repeated under a second position type
 * gets a `_<type>` suffix so `bracket_probability` keys stay unique.
 */
export function deriveBrackets(rules: readonly ScoringRule[]): readonly BracketFamily[] {
  const groups = new Map<string, { pt: PositionType; family: string; items: Candidate[] }>();
  for (const rule of rules) {
    if (rule.canonical === null) continue;
    const bin = parseBinCanonical(rule.canonical);
    const parsed = bin ?? parseGenericName(rule.name);
    if (parsed === null) continue;
    for (const pt of rule.position_types) {
      const key = `${pt}\u0000${parsed.family}`;
      let g = groups.get(key);
      if (g === undefined) {
        g = { pt, family: parsed.family, items: [] };
        groups.set(key, g);
      }
      g.items.push({
        named: bin !== null,
        member: {
          canonical: rule.canonical,
          platform_id: rule.platform_id,
          lower: parsed.lower,
          upper: parsed.upper,
        },
      });
    }
  }

  const out: BracketFamily[] = [];
  const used = new Set<string>();
  const ordered = [...groups.values()].sort(
    (x, y) =>
      POSITION_TYPES.indexOf(x.pt) - POSITION_TYPES.indexOf(y.pt) || (x.family < y.family ? -1 : 1),
  );
  for (const g of ordered) {
    const named = g.items.some((c) => c.named);
    // a group mixes named and generic members only if a display name mimics a bin canonical's
    // family slug — keep the named ones; the generic ones score as plain rules
    const items = named ? g.items.filter((c) => c.named) : g.items;
    const members = items
      .map((c) => c.member)
      .sort((a, b) => a.lower - b.lower || (a.canonical < b.canonical ? -1 : 1));
    const problem = contiguityProblem(members);
    if (named && problem !== null) {
      throw new ScoringError("bracket_bounds", `bracket family ${g.family} (${g.pt}) is invalid`, [
        problem,
      ]);
    }
    if (!named && (problem !== null || members.length < 2)) continue;
    let family = g.family;
    if (used.has(family)) family = `${family}_${g.pt.toLowerCase()}`;
    used.add(family);
    out.push(
      Object.freeze({
        family,
        position_type: g.pt,
        members: Object.freeze(members.map((m) => Object.freeze(m))),
        kind: familyKind(g.family),
      }),
    );
  }
  return Object.freeze(out);
}

/**
 * The index of the member a scalar falls in (plan 08 §4.1, P3: exactly one member for ANY finite
 * scalar). Bounds are inclusive integers, so a member spans [lower_i, lower_{i+1}); a scalar below
 * the first bin scores in the first bin and one above a closed last bin in the last — negative
 * yards allowed is real, and an out-of-range scalar must still land somewhere [U-4].
 */
export function bracketize(family: BracketFamily, scalar: number): number {
  let idx = 0;
  family.members.forEach((m, i) => {
    if (m.lower <= scalar) idx = i;
  });
  return idx;
}

/**
 * Per-member counts for a COUNT family from raw scalars (e.g. the league's own FG-distance bins from
 * nflverse `fg_made_list` kick distances, plan 08 §4.1): every member gets a key (0 when none).
 * Throws `invalid_line` for a non-finite scalar.
 */
export function binCounts(
  family: BracketFamily,
  scalars: readonly number[],
): Readonly<Record<Canonical, number>> {
  const hits = scalars.map((x) => {
    if (!Number.isFinite(x)) {
      throw new ScoringError("invalid_line", "bin scalar is not finite", [family.family]);
    }
    return bracketize(family, x);
  });
  const out: Record<Canonical, number> = {};
  family.members.forEach((m, i) => {
    out[m.canonical] = hits.filter((h) => h === i).length;
  });
  return Object.freeze(out);
}
