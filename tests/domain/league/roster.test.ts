// roster.test.ts — roster validation (plan 07 B1 empty_starting_slots / ir_ineligible_in_ir /
// over_limit; research 05 §14.1): over-limit, ineligible slots, IR misuse, overflow, duplicates,
// starters on bye, and adversarial seat content.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { NflTeam } from "../../../src/config/schema.js";
import { validateRoster, type RosterSeat } from "../../../src/domain/league/roster.js";
import { VALIDATION_SLOTS } from "./fixtures.js";

let n = 0;
const seat = (
  slot: string,
  position: string,
  status: string | null = null,
  team: NflTeam | null = null,
): RosterSeat => {
  n += 1;
  return {
    player_key: `manual.p.00-00000${String(n).padStart(2, "0")}`,
    slot,
    positions: [position],
    status,
    nfl_team: team,
  };
};

/** A full, legal 16-player roster (IR has one empty seat). */
function legal(): RosterSeat[] {
  return [
    seat("QB", "QB", null, "BUF"),
    seat("WR", "WR", null, "CIN"),
    seat("WR", "WR", null, "DET"),
    seat("RB", "RB", null, "DET"),
    seat("RB", "RB", null, "BAL"),
    seat("TE", "TE", null, "ARI"),
    seat("W/R/T", "WR", null, "SEA"),
    seat("K", "K", null, "PIT"),
    seat("DEF", "DEF", null, "DET"),
    seat("BN", "QB"),
    seat("BN", "RB"),
    seat("BN", "WR"),
    seat("BN", "TE"),
    seat("BN", "RB"),
    seat("BN", "WR"),
    seat("IR", "WR", "O"),
  ];
}

describe("validateRoster", () => {
  it("accepts a full legal roster", () => {
    const v = validateRoster(legal(), VALIDATION_SLOTS);
    expect(v).toMatchObject({
      legal: true,
      over_limit: false,
      active_count: 15,
      active_capacity: 15,
      empty_starting_slots: [],
      ineligible: [],
      ir_ineligible_in_ir: [],
      overflow: [],
      duplicates: [],
    });
  });

  it("lists every empty starting seat once per seat, in slot order; empties are not violations", () => {
    const v = validateRoster(
      legal().filter((s) => !["WR", "W/R/T"].includes(s.slot)),
      VALIDATION_SLOTS,
    );
    expect(v.empty_starting_slots).toEqual(["WR", "WR", "W/R/T"]);
    expect(v.legal).toBe(true);
    expect(validateRoster([], VALIDATION_SLOTS).empty_starting_slots).toHaveLength(9);
  });

  it("flags over-limit when active players exceed starter + bench seats", () => {
    const v = validateRoster([...legal(), seat("BN", "RB")], VALIDATION_SLOTS);
    expect(v.over_limit).toBe(true);
    expect(v.active_count).toBe(16);
    expect(v.overflow).toEqual([{ slot: "BN", occupied: 7, capacity: 6 }]);
    expect(v.legal).toBe(false);
  });

  it("flags over-limit when IR holds more than its seats", () => {
    const v = validateRoster(
      [...legal(), seat("IR", "RB", "IR"), seat("IR", "TE", "PUP")],
      VALIDATION_SLOTS,
    );
    expect(v.over_limit).toBe(true);
    expect(v.overflow).toEqual([{ slot: "IR", occupied: 3, capacity: 2 }]);
  });

  it("IR players do not count against the active limit", () => {
    const v = validateRoster([...legal(), seat("IR", "RB", "NFI-R")], VALIDATION_SLOTS);
    expect(v.over_limit).toBe(false);
    expect(v.legal).toBe(true);
  });

  it("reports IR misuse: a Questionable or healthy player in IR", () => {
    const q = seat("IR", "RB", "Q");
    const h = seat("IR", "WR", null);
    const v = validateRoster([...legal().filter((s) => s.slot !== "IR"), q, h], VALIDATION_SLOTS);
    expect(v.ir_ineligible_in_ir).toEqual([q.player_key, h.player_key]);
    expect(v.legal).toBe(false);
  });

  it("reports ineligible slots by reason: position, unknown slot", () => {
    const qbAtWr = seat("WR", "QB");
    const kAtFlex = seat("W/R/T", "K");
    const ghost = seat("TAXI", "RB");
    const v = validateRoster([qbAtWr, kAtFlex, ghost], VALIDATION_SLOTS);
    expect(v.ineligible).toEqual([
      { player_key: qbAtWr.player_key, slot: "WR", reason: "position" },
      { player_key: kAtFlex.player_key, slot: "W/R/T", reason: "position" },
      { player_key: ghost.player_key, slot: "TAXI", reason: "unknown_slot" },
    ]);
    expect(v.active_count).toBe(3);
  });

  it("reports a player seated twice", () => {
    const a = seat("BN", "RB");
    const v = validateRoster([a, { ...a, slot: "RB" }], VALIDATION_SLOTS);
    expect(v.duplicates).toEqual([a.player_key]);
    expect(v.legal).toBe(false);
  });

  it("bye handling: starters (not bench) whose team is on bye that week", () => {
    const roster = legal();
    const byes = new Map<NflTeam, number[]>([
      ["DET", [6]],
      ["BUF", [7]],
      ["CIN", [6]],
    ]);
    const v6 = validateRoster(roster, VALIDATION_SLOTS, { bye: { week: 6, byes } });
    const detCin = roster.filter(
      (s) => (s.nfl_team === "DET" || s.nfl_team === "CIN") && s.slot !== "BN",
    );
    expect(v6.starters_on_bye).toEqual(detCin.map((s) => s.player_key));
    expect(v6.legal).toBe(true); // a bye is not an illegal roster, only a bad lineup
    const v1 = validateRoster(roster, VALIDATION_SLOTS, { bye: { week: 1, byes } });
    expect(v1.starters_on_bye).toEqual([]);
    const benchOnBye = [seat("BN", "RB", null, "DET")];
    expect(
      validateRoster(benchOnBye, VALIDATION_SLOTS, { bye: { week: 6, byes } }).starters_on_bye,
    ).toEqual([]);
    // a team absent from the bye map, or a free agent (no team), is never on bye
    expect(
      validateRoster([seat("QB", "QB", null, "KC"), seat("RB", "RB")], VALIDATION_SLOTS, {
        bye: { week: 6, byes },
      }).starters_on_bye,
    ).toEqual([]);
  });

  it("never throws and keeps its counts consistent for arbitrary seats (property)", () => {
    const arbSeat = fc.record({
      player_key: fc.string({ maxLength: 12 }),
      slot: fc.constantFrom(
        "QB",
        "WR",
        "RB",
        "TE",
        "W/R/T",
        "K",
        "DEF",
        "BN",
        "IR",
        "XX",
        "",
        "ＷＲ",
      ),
      positions: fc.array(fc.constantFrom("QB", "WR", "RB", "TE", "K", "DEF", "LB", ""), {
        maxLength: 3,
      }),
      status: fc.option(fc.constantFrom("O", "Q", "IR", "PUP", "SUSP", "💥"), { nil: null }),
    });
    fc.assert(
      fc.property(fc.array(arbSeat, { maxLength: 40 }), (seats) => {
        const v = validateRoster(seats, VALIDATION_SLOTS);
        const irSeats = seats.filter((s) => s.slot === "IR").length;
        expect(v.active_count + irSeats).toBe(seats.length);
        expect(v.over_limit).toBe(v.active_count > 15 || irSeats > 2);
        expect(v.legal).toBe(
          !v.over_limit &&
            v.ineligible.length === 0 &&
            v.ir_ineligible_in_ir.length === 0 &&
            v.overflow.length === 0 &&
            v.duplicates.length === 0,
        );
        // more players can only ever leave fewer empty starting seats
        expect(v.empty_starting_slots.length).toBeLessThanOrEqual(9);
      }),
    );
  });

  it("handles a huge roster without blowing up", () => {
    const seats = Array.from({ length: 20_000 }, (_, i) => ({
      player_key: `k${String(i)}`,
      slot: "BN",
      positions: ["RB"],
      status: null,
    }));
    const v = validateRoster(seats, VALIDATION_SLOTS);
    expect(v.over_limit).toBe(true);
    expect(v.overflow).toEqual([{ slot: "BN", occupied: 20_000, capacity: 6 }]);
  });
});
