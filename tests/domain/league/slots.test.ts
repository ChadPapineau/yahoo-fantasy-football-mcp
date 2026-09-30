// slots.test.ts — the slot model (plan 01 §8 slots; plan 07 B1 eligible[]; research 05 §14.1 IR):
// classification, the full eligibility matrix, flex spellings, custom flexes, IR status gating.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  buildRosterSlots,
  canOccupy,
  defineSlot,
  eligibleSlotNames,
  isIrEligibleStatus,
  isKnownPosition,
  KNOWN_POSITIONS,
  MAX_SLOT_COUNT,
  parseFlexName,
  slotByName,
  slotRefusal,
} from "../../../src/domain/league/slots.js";
import { IR_ELIGIBLE_STATUSES, type RosterSlot } from "../../../src/domain/league/types.js";
import { slot, VALIDATION_SLOTS } from "./fixtures.js";

describe("defineSlot", () => {
  it("classifies named positions as starters accepting exactly that position", () => {
    for (const p of KNOWN_POSITIONS) {
      const s = slot(p);
      expect(s.class).toBe("starter");
      expect(s.eligible).toEqual([p]);
    }
  });

  it("classifies BN and IR, which list every known position", () => {
    expect(slot("BN").class).toBe("bench");
    expect(slot("IR").class).toBe("ir");
    expect(slot("BN").eligible).toEqual(KNOWN_POSITIONS);
  });

  it("parses Yahoo letter flexes and full-position flexes", () => {
    expect(slot("W/R/T")).toMatchObject({ class: "flex", eligible: ["WR", "RB", "TE"] });
    expect(slot("Q/W/R/T")).toMatchObject({ class: "flex", eligible: ["QB", "WR", "RB", "TE"] });
    expect(slot("W/R").eligible).toEqual(["WR", "RB"]);
    expect(slot("W/T").eligible).toEqual(["WR", "TE"]);
    expect(slot("WR/TE").eligible).toEqual(["WR", "TE"]);
  });

  it("accepts any flex a league file defines through `eligible`", () => {
    expect(slot("SUPER", 1, ["QB", "RB", "WR", "TE"])).toMatchObject({ class: "flex" });
    expect(slot("OP", 1, ["QB"])).toMatchObject({ class: "starter", eligible: ["QB"] });
    // duplicates collapse
    expect(slot("FLX", 1, ["WR", "WR", "RB"]).eligible).toEqual(["WR", "RB"]);
  });

  it("rejects unknown slots, unknown positions and bad counts with a fixed code (never a guess)", () => {
    expect(defineSlot({ name: "D", count: 1 })).toBe("unknown_slot");
    expect(defineSlot({ name: "DL", count: 1 })).toBe("unknown_slot");
    expect(defineSlot({ name: "W/X", count: 1 })).toBe("unknown_slot");
    expect(defineSlot({ name: "W/W", count: 1 })).toBe("unknown_slot");
    expect(defineSlot({ name: "W", count: 1 })).toBe("unknown_slot");
    expect(defineSlot({ name: "FLX", count: 1, eligible: ["XX"] })).toBe("unknown_position");
    expect(defineSlot({ name: "FLX", count: 1, eligible: [] })).toBe("unknown_position");
    expect(defineSlot({ name: "BN", count: 1, eligible: ["QB"] })).toBe("eligible_not_allowed");
    expect(defineSlot({ name: "wr", count: 1 })).toBe("invalid_name");
    expect(defineSlot({ name: "WR<script>", count: 1 })).toBe("invalid_name");
    expect(defineSlot({ name: "", count: 1 })).toBe("invalid_name");
    expect(defineSlot({ name: "WR", count: -1 })).toBe("invalid_count");
    expect(defineSlot({ name: "WR", count: 1.5 })).toBe("invalid_count");
    expect(defineSlot({ name: "WR", count: MAX_SLOT_COUNT + 1 })).toBe("invalid_count");
    expect(defineSlot({ name: "WR", count: Number.NaN })).toBe("invalid_count");
  });

  it("never throws for arbitrary names/counts", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 20 }), fc.double(), (name, count) => {
        const r = defineSlot({ name, count });
        expect(typeof r === "string" || typeof r === "object").toBe(true);
      }),
    );
  });
});

describe("parseFlexName / isKnownPosition", () => {
  it("returns null for non-flex spellings", () => {
    expect(parseFlexName("WR")).toBeNull();
    expect(parseFlexName("/")).toBeNull();
    expect(parseFlexName("W/")).toBeNull();
    expect(isKnownPosition("DEF")).toBe(true);
    expect(isKnownPosition("DST")).toBe(false);
    // prototype names never resolve as flex letters
    expect(parseFlexName("W/constructor")).toBeNull();
    expect(parseFlexName("__proto__/W")).toBeNull();
    expect(parseFlexName("toString/valueOf")).toBeNull();
  });
});

describe("buildRosterSlots", () => {
  it("totals the validation league: 9 starters, 6 bench, 2 IR, 17 spots", () => {
    expect(VALIDATION_SLOTS).toMatchObject({ starters: 9, bench: 6, ir: 2, total: 17 });
  });

  it("merges duplicate slot names by summing counts", () => {
    const s = buildRosterSlots([slot("WR", 1), slot("WR", 2)]);
    expect(s.slots).toHaveLength(1);
    expect(slotByName(s, "WR")?.count).toBe(3);
    expect(slotByName(s, "TE")).toBeNull();
  });

  it("an empty roster has zero of everything", () => {
    expect(buildRosterSlots([])).toMatchObject({ starters: 0, bench: 0, ir: 0, total: 0 });
  });
});

describe("eligibility matrix", () => {
  const statuses: (string | null)[] = [
    null,
    "Q",
    "D",
    "O",
    "IR",
    "PUP",
    "NFI-R",
    "NFI-A",
    "SUSP",
    "NA",
    "P",
    "CEL",
  ];

  it("starter slots accept exactly their position; flex accepts its members; bench accepts all", () => {
    for (const s of VALIDATION_SLOTS.slots) {
      for (const pos of KNOWN_POSITIONS) {
        for (const status of statuses) {
          const ok = canOccupy(s, { positions: [pos], status });
          let expected: boolean;
          if (s.class === "bench") expected = true;
          else if (s.class === "ir")
            expected = status !== null && IR_ELIGIBLE_STATUSES.includes(status);
          else expected = s.eligible.includes(pos);
          expect(ok, `${s.name} ← ${pos}/${String(status)}`).toBe(expected);
        }
      }
    }
  });

  it("W/R/T takes RB, WR and TE but never QB, K or DEF", () => {
    const flex = slotByName(VALIDATION_SLOTS, "W/R/T");
    expect(flex).not.toBeNull();
    if (flex === null) return;
    expect(["RB", "WR", "TE"].every((p) => canOccupy(flex, { positions: [p], status: null }))).toBe(
      true,
    );
    expect(["QB", "K", "DEF"].some((p) => canOccupy(flex, { positions: [p], status: null }))).toBe(
      false,
    );
  });

  it("a multi-position player fits any slot one of their positions fits", () => {
    const te = slotByName(VALIDATION_SLOTS, "TE");
    expect(te && canOccupy(te, { positions: ["WR", "TE"], status: null })).toBe(true);
  });

  it("IR: only IR, NFI-R, NFI-A, O and PUP are eligible — Q, D, SUSP, NA and healthy are not", () => {
    for (const s of IR_ELIGIBLE_STATUSES) expect(isIrEligibleStatus(s)).toBe(true);
    for (const s of [null, "Q", "D", "SUSP", "NA", "P", "CEL", "ir", "O "])
      expect(isIrEligibleStatus(s)).toBe(false);
    const ir = slotByName(VALIDATION_SLOTS, "IR");
    expect(ir && slotRefusal(ir, { positions: ["WR"], status: "Q" })).toBe("ir_status");
  });

  it("refuses an `other`-class slot and reports why a position does not fit", () => {
    const other: RosterSlot = { name: "TAXI", class: "other", count: 1, eligible: ["QB"] };
    expect(slotRefusal(other, { positions: ["QB"], status: null })).toBe("other_slot");
    const qb = slotByName(VALIDATION_SLOTS, "QB");
    expect(qb && slotRefusal(qb, { positions: ["RB"], status: null })).toBe("position");
    expect(qb && slotRefusal(qb, { positions: [], status: null })).toBe("position");
  });

  it("eligibleSlotNames lists own positions, accepting flexes and IR when the status allows", () => {
    expect(eligibleSlotNames(VALIDATION_SLOTS, { positions: ["RB"], status: null })).toEqual([
      "RB",
      "W/R/T",
    ]);
    expect(eligibleSlotNames(VALIDATION_SLOTS, { positions: ["QB"], status: null })).toEqual([
      "QB",
    ]);
    expect(eligibleSlotNames(VALIDATION_SLOTS, { positions: ["WR"], status: "O" })).toEqual([
      "WR",
      "W/R/T",
      "IR",
    ]);
    expect(eligibleSlotNames(VALIDATION_SLOTS, { positions: ["DEF"], status: "IR" })).toEqual([
      "DEF",
      "IR",
    ]);
  });
});
