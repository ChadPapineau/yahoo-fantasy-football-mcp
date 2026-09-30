// roster.ts — roster validation (plan 07 B1 `empty_starting_slots[]`, `ir_ineligible_in_ir[]`,
// `over_limit`; research 05 §14.1 "a roster over the limit blocks lineup edits", IR misuse; plan 07
// §2 VALIDATION rules: ineligible slot, IR-ineligible status, over-limit) and bye handling for a
// lineup (research 05 §7). Pure; every list comes back in a deterministic order.
import type { NflTeam } from "../../config/schema.js";
import type { PlayerKey, RosterSlots, Week } from "./types.js";
import {
  slotByName,
  slotRefusal,
  type EligibilitySubject,
  type IneligibleReason,
} from "./slots.js";

/** One occupied seat as validation sees it. */
export interface RosterSeat extends EligibilitySubject {
  readonly player_key: PlayerKey;
  /** The slot's literal name. */
  readonly slot: string;
  /** The player's NFL team (for byes); null when unknown (a free agent, a retired player). */
  readonly nfl_team?: NflTeam | null;
}

/** A seat that breaks a rule. */
export interface SeatProblem {
  readonly player_key: PlayerKey;
  readonly slot: string;
  readonly reason: IneligibleReason | "unknown_slot";
}

/** A slot holding more players than it has seats. */
export interface SlotOverflow {
  readonly slot: string;
  readonly occupied: number;
  readonly capacity: number;
}

/** Everything wrong (or merely notable) about a roster, in fixed vocabulary. */
export interface RosterValidation {
  /** Non-IR players exceed starter + bench seats, or IR holds more than its seats (blocks edits). */
  readonly over_limit: boolean;
  /** Players outside IR slots. */
  readonly active_count: number;
  /** Starter + flex + bench seats. */
  readonly active_capacity: number;
  /** One entry per unfilled starter/flex seat, in slot order (`["WR", "W/R/T"]`). */
  readonly empty_starting_slots: readonly string[];
  /** Players in a slot their position cannot fill, or in a slot the league does not have. */
  readonly ineligible: readonly SeatProblem[];
  /** Players in an IR slot whose status is not IR-eligible (plan 07 B1). */
  readonly ir_ineligible_in_ir: readonly PlayerKey[];
  /** Slots holding more players than their count. */
  readonly overflow: readonly SlotOverflow[];
  /** Starters (starter/flex class) whose team is on bye in the validated week. */
  readonly starters_on_bye: readonly PlayerKey[];
  /** The same player key seated more than once. */
  readonly duplicates: readonly PlayerKey[];
  /** True when nothing above is a violation (empty seats and byes are not violations). */
  readonly legal: boolean;
}

/** Options for `validateRoster`. */
export interface ValidateOptions {
  /** The week being validated and each team's bye weeks — enables `starters_on_bye`. */
  readonly bye?: { readonly week: Week; readonly byes: ReadonlyMap<NflTeam, readonly Week[]> };
}

/** Validates a roster against the league's slots. Never throws for any seat content. */
export function validateRoster(
  seats: readonly RosterSeat[],
  slots: RosterSlots,
  opts: ValidateOptions = {},
): RosterValidation {
  const ineligible: SeatProblem[] = [];
  const irBad: PlayerKey[] = [];
  const onBye: PlayerKey[] = [];
  const occupied = new Map<string, number>();
  const seen = new Set<PlayerKey>();
  const dup = new Set<PlayerKey>();
  let irCount = 0;
  let active = 0;
  for (const seat of seats) {
    if (seen.has(seat.player_key)) dup.add(seat.player_key);
    seen.add(seat.player_key);
    occupied.set(seat.slot, (occupied.get(seat.slot) ?? 0) + 1);
    const slot = slotByName(slots, seat.slot);
    if (slot === null) {
      active += 1;
      ineligible.push({ player_key: seat.player_key, slot: seat.slot, reason: "unknown_slot" });
      continue;
    }
    if (slot.class === "ir") irCount += 1;
    else active += 1;
    const refusal = slotRefusal(slot, seat);
    if (refusal === "ir_status") irBad.push(seat.player_key);
    else if (refusal !== null)
      ineligible.push({ player_key: seat.player_key, slot: seat.slot, reason: refusal });
    const team = seat.nfl_team ?? null;
    if (
      opts.bye !== undefined &&
      team !== null &&
      (slot.class === "starter" || slot.class === "flex") &&
      (opts.bye.byes.get(team) ?? []).includes(opts.bye.week)
    )
      onBye.push(seat.player_key);
  }
  const overflow: SlotOverflow[] = [];
  const empty: string[] = [];
  for (const s of slots.slots) {
    const n = occupied.get(s.name) ?? 0;
    if (n > s.count) overflow.push({ slot: s.name, occupied: n, capacity: s.count });
    if (s.class === "starter" || s.class === "flex")
      for (let i = n; i < s.count; i++) empty.push(s.name);
  }
  const activeCapacity = slots.starters + slots.bench;
  const overLimit = active > activeCapacity || irCount > slots.ir;
  const duplicates = [...dup].sort();
  return Object.freeze({
    over_limit: overLimit,
    active_count: active,
    active_capacity: activeCapacity,
    empty_starting_slots: Object.freeze(empty),
    ineligible: Object.freeze(ineligible),
    ir_ineligible_in_ir: Object.freeze(irBad),
    overflow: Object.freeze(overflow),
    starters_on_bye: Object.freeze(onBye),
    duplicates: Object.freeze(duplicates),
    legal:
      !overLimit &&
      ineligible.length === 0 &&
      irBad.length === 0 &&
      overflow.length === 0 &&
      duplicates.length === 0,
  });
}
