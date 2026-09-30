// slots.ts — the roster-slot model (plan 01 §8 slots `{name, class, count, eligible}`; plan 07 A2
// `roster`, B1 `eligible[]`; research 05 §14.1 IR rules): slot definition and classification (named
// positions, Yahoo-style letter flexes such as `W/R/T`, any flex a league file defines by listing
// `eligible`), BN/IR, and per-player eligibility (IR gated by IR_ELIGIBLE_STATUSES). Pure.
import {
  IR_ELIGIBLE_STATUSES,
  SLOT_NAME_RE,
  type PositionSet,
  type RosterSlot,
  type RosterSlots,
  type SlotClass,
} from "./types.js";

/** The player positions the Phase-1 league model knows (offence, kicker, team defence). */
export const KNOWN_POSITIONS: readonly string[] = Object.freeze([
  "QB",
  "RB",
  "WR",
  "TE",
  "K",
  "DEF",
]);

/** The bench slot's literal name. */
export const BENCH_SLOT = "BN";
/** The injured-reserve slot's literal name. */
export const IR_SLOT = "IR";

/** Yahoo's one-letter flex codes (`W/R/T`, `Q/W/R/T`, `W/R`, `W/T`). */
export const FLEX_LETTERS: Readonly<Record<string, string>> = Object.freeze({
  Q: "QB",
  R: "RB",
  W: "WR",
  T: "TE",
});

/** Largest count one slot type may have (a hand-written file cannot declare 10⁶ bench seats). */
export const MAX_SLOT_COUNT = 20;
/** Largest total roster size across all slot types. */
export const MAX_ROSTER_SIZE = 60;

/** Whether `p` is a position this model knows. */
export function isKnownPosition(p: string): boolean {
  return KNOWN_POSITIONS.includes(p);
}

/**
 * The positions a flex slot name spells, or null when the name is not a flex spelling. Parts are
 * one-letter codes (FLEX_LETTERS) or full known positions (`WR/TE`); at least two distinct parts.
 */
export function parseFlexName(name: string): PositionSet | null {
  if (!name.includes("/")) return null;
  const parts = name.split("/");
  const out: string[] = [];
  for (const part of parts) {
    const pos = Object.hasOwn(FLEX_LETTERS, part)
      ? FLEX_LETTERS[part]
      : isKnownPosition(part)
        ? part
        : undefined;
    if (pos === undefined || out.includes(pos)) return null;
    out.push(pos);
  }
  return out.length >= 2 ? Object.freeze(out) : null;
}

/** One slot definition as a league file or platform states it. */
export interface SlotDefinition {
  readonly name: string;
  readonly count: number;
  /** Explicit eligible positions (defines a custom flex); omitted → derived from the name. */
  readonly eligible?: readonly string[] | undefined;
}

/** Why a slot definition was rejected (fixed vocabulary; never the value). */
export type SlotDefinitionProblem =
  "invalid_name" | "invalid_count" | "unknown_slot" | "unknown_position" | "eligible_not_allowed";

/**
 * Classifies one slot definition: `BN` → bench, `IR` → ir (both accept every known position, IR
 * gated by status at assignment time), a known position → starter, a flex spelling or an explicit
 * multi-position `eligible` → flex, a single explicit position → starter. Anything else is a
 * problem, never a guess.
 */
export function defineSlot(def: SlotDefinition): RosterSlot | SlotDefinitionProblem {
  if (!SLOT_NAME_RE.test(def.name)) return "invalid_name";
  if (!Number.isInteger(def.count) || def.count < 0 || def.count > MAX_SLOT_COUNT)
    return "invalid_count";
  const all = Object.freeze([...KNOWN_POSITIONS]);
  if (def.name === BENCH_SLOT || def.name === IR_SLOT) {
    if (def.eligible !== undefined) return "eligible_not_allowed";
    const cls: SlotClass = def.name === BENCH_SLOT ? "bench" : "ir";
    return Object.freeze({ name: def.name, class: cls, count: def.count, eligible: all });
  }
  let eligible: readonly string[] | null;
  if (def.eligible !== undefined) {
    const uniq = [...new Set(def.eligible)];
    if (uniq.length === 0) return "unknown_position";
    if (uniq.some((p) => !isKnownPosition(p))) return "unknown_position";
    eligible = uniq;
  } else if (isKnownPosition(def.name)) {
    eligible = [def.name];
  } else {
    eligible = parseFlexName(def.name);
  }
  if (eligible === null) return "unknown_slot";
  const cls: SlotClass = eligible.length > 1 ? "flex" : "starter";
  return Object.freeze({
    name: def.name,
    class: cls,
    count: def.count,
    eligible: Object.freeze([...eligible]),
  });
}

/** Builds the RosterSlots summary (starter + flex = starters). Duplicate names merge counts. */
export function buildRosterSlots(slots: readonly RosterSlot[]): RosterSlots {
  const merged: RosterSlot[] = [];
  for (const s of slots) {
    const i = merged.findIndex((m) => m.name === s.name);
    const prev = i >= 0 ? merged[i] : undefined;
    if (prev !== undefined) merged[i] = Object.freeze({ ...prev, count: prev.count + s.count });
    else merged.push(s);
  }
  const sum = (pred: (s: RosterSlot) => boolean): number =>
    merged.filter(pred).reduce((n, s) => n + s.count, 0);
  const starters = sum((s) => s.class === "starter" || s.class === "flex");
  const bench = sum((s) => s.class === "bench");
  const ir = sum((s) => s.class === "ir");
  return Object.freeze({
    slots: Object.freeze(merged),
    starters,
    bench,
    ir,
    total: sum(() => true),
  });
}

/** The slot of a given name, or null. */
export function slotByName(slots: RosterSlots, name: string): RosterSlot | null {
  return slots.slots.find((s) => s.name === name) ?? null;
}

/** Whether a status code makes a player IR-eligible (research 03 §C.1; critic C-19). */
export function isIrEligibleStatus(status: string | null): boolean {
  return status !== null && IR_ELIGIBLE_STATUSES.includes(status);
}

/** A player as the eligibility rules see them. */
export interface EligibilitySubject {
  /** The player's positions (a multi-position player lists several). */
  readonly positions: readonly string[];
  /** Short status code or null. */
  readonly status: string | null;
}

/** Why a player may not sit in a slot (fixed vocabulary). */
export type IneligibleReason = "position" | "ir_status" | "other_slot";

/** Null when `player` may occupy `slot`, else the reason it may not. */
export function slotRefusal(slot: RosterSlot, player: EligibilitySubject): IneligibleReason | null {
  switch (slot.class) {
    case "bench":
      return null;
    case "ir":
      return isIrEligibleStatus(player.status) ? null : "ir_status";
    case "starter":
    case "flex":
      return player.positions.some((p) => slot.eligible.includes(p)) ? null : "position";
    default:
      return "other_slot";
  }
}

/** Whether `player` may occupy `slot`. */
export function canOccupy(slot: RosterSlot, player: EligibilitySubject): boolean {
  return slotRefusal(slot, player) === null;
}

/**
 * The player's `eligible_positions` in this league (plan 07 B1 `eligible[]`, Yahoo style): their own
 * positions, then every starter/flex slot name that accepts them, then `IR` when the status allows
 * it. Bench is implicit (every player may sit there) and is not listed.
 */
export function eligibleSlotNames(slots: RosterSlots, player: EligibilitySubject): string[] {
  const out: string[] = [];
  const add = (n: string): void => {
    if (!out.includes(n)) out.push(n);
  };
  for (const p of player.positions) add(p);
  for (const s of slots.slots) {
    if ((s.class === "starter" || s.class === "flex" || s.class === "ir") && canOccupy(s, player))
      add(s.name);
  }
  return out;
}
